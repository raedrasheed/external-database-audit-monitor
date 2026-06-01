// Append-only evidence writer (Sprint-2 / EDAM-T106; F-H1/F-H2 closed).
//
// Domain B's WORM capability: validate-before-write, then write immutably.
//   - Every object is validated against ITS OWN contract before any WORM write;
//     an invalid object NEVER reaches WORM — it is routed to the DLQ + alarmed
//     (no event disappears silently, INV-2 / no-fabrication).
//   - A CCE must additionally carry its integrity evidence (event_hash + row_hash)
//     and that evidence must VERIFY (verifyCce); a hash-less or non-verifying CCE
//     is rejected to the DLQ (F-H1). validateCceFull alone does not require
//     `evidence`, so this is enforced explicitly here.
//   - All compute that can throw on canonical-hostile content (validation's
//     hash recomputation, verifyCce, and the final serialization) is inside a
//     protected block; a serialization failure is routed to the DLQ as
//     SERIALIZATION_FAILURE — append never throws on the write path (F-H2). The
//     only way append rejects is if DLQ persistence ITSELF fails (F-L1): the
//     failure then surfaces to the caller rather than being silently dropped.
//   - A CCE gets its evidence.{worm_object_key,segment_id} back-refs populated
//     (existing CCE schema fields, inside `evidence` which is EXCLUDED from the
//     hashed core — so event_hash/row_hash and the golden vectors are unchanged).
//   - The writer holds ONLY a WormWriter (append-only). It never obtains the
//     retention-admin role or any delete/overwrite path (INV-EV-1).
// Tracked, not yet fixed (no contract change available without a WORM reader):
//   F-M1 idempotent-replay handling, F-M2 same-key/different-content conflict
//   classification (currently both surface as UNEXPECTED_EXCEPTION on overwrite).
// Segment lifecycle / global ordering / caps are the accumulator's job (T107);
// here the caller supplies the placement.

import { serializeCanonical, isHashToken } from '@edam/canonical';
import { validateCceFull, validateSnapshotEpochManifest } from '@edam/contracts';
import { verifyCce, type Cce } from '@edam/cce-model';
import type { DlqService, FailureCategory } from '@edam/dlq';
import type { PutOptions, WormWriter } from '@edam/worm';
import type { AppendableObject, AppendOutcome, EvidenceObjectType, EvidencePlacement } from './types.js';

export interface EvidenceWriterDeps {
  /** Append-only WORM writer handle (Domain B). */
  worm: WormWriter;
  /** Failure sink; record() persists-then-alarms (no loss). */
  dlq: DlqService;
  /**
   * Compliance retain-until for written objects (RFC3339). Optional here;
   * mandatory/default retention is tracked as hardening EDAM-T104-H4.
   */
  retainUntil?: string;
  /** Apply a legal hold at write time. */
  legalHold?: boolean;
  /** Clock for DLQ capture timestamps (DI for determinism). */
  now?: () => string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

interface ObjectDescriptor {
  type: EvidenceObjectType;
  objectId: string;
  dbId: string;
  engine: string;
}

/** Identify the evidence object by its `kind` discriminant; null if unrecognized. */
function describe(object: unknown): ObjectDescriptor | null {
  if (isRecord(object) && object.kind === 'transaction' && isRecord(object.source)) {
    return {
      type: 'cce',
      objectId: typeof object.envelope_id === 'string' ? object.envelope_id : '',
      dbId: typeof object.source.db_id === 'string' ? object.source.db_id : '',
      engine: typeof object.source.engine === 'string' ? object.source.engine : 'unknown',
    };
  }
  if (isRecord(object) && object.kind === 'snapshot_epoch_manifest') {
    return {
      type: 'snapshot_epoch_manifest',
      objectId: typeof object.epoch_id === 'string' ? object.epoch_id : '',
      dbId: typeof object.db_id === 'string' ? object.db_id : '',
      engine: 'unknown',
    };
  }
  return null;
}

/** Deterministic, lexicographically-sortable WORM key for an evidence object. */
export function evidenceObjectKey(dbId: string, segmentId: string, seq: number, type: EvidenceObjectType): string {
  return `${dbId}/${segmentId}/${String(seq).padStart(6, '0')}.${type}.json`;
}

/** Return a copy of a CCE with the WORM back-refs set in `evidence` (outside the hashed core). */
function withBackRefs(cce: Cce, worm_object_key: string, segment_id: string): Cce {
  return { ...cce, evidence: { ...cce.evidence, worm_object_key, segment_id } } as Cce;
}

/** F-H1: a CCE must carry well-formed integrity evidence (event_hash + row_hash). */
function cceEvidencePresent(object: unknown): { ok: boolean; reason: string } {
  const ev = isRecord(object) ? object.evidence : undefined;
  if (!isRecord(ev)) return { ok: false, reason: 'CCE missing evidence object (event_hash/row_hash required)' };
  if (typeof ev.event_hash !== 'string' || !isHashToken(ev.event_hash)) {
    return { ok: false, reason: 'CCE missing/invalid evidence.event_hash' };
  }
  if (typeof ev.row_hash !== 'string' || !isHashToken(ev.row_hash)) {
    return { ok: false, reason: 'CCE missing/invalid evidence.row_hash' };
  }
  return { ok: true, reason: '' };
}

type Prepared =
  | { ok: true; worm_object_key: string; bytes: Uint8Array; toWrite: AppendableObject; objectId: string; objectType: EvidenceObjectType; engine: string }
  | { ok: false; category: FailureCategory; reason: string; engine: string; offset: string | null; error?: unknown };

export class EvidenceWriter {
  private readonly worm: WormWriter;
  private readonly dlq: DlqService;
  private readonly retainUntil?: string;
  private readonly legalHold: boolean;
  private readonly now: () => string;

  constructor(deps: EvidenceWriterDeps) {
    this.worm = deps.worm;
    this.dlq = deps.dlq;
    this.retainUntil = deps.retainUntil;
    this.legalHold = deps.legalHold ?? false;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private putOptions(): PutOptions {
    return {
      retentionMode: 'compliance',
      ...(this.retainUntil ? { retainUntil: this.retainUntil } : {}),
      ...(this.legalHold ? { legalHold: true } : {}),
    };
  }

  /** Record a failure to the DLQ (persist-then-alarm). Rejects only if DLQ persistence fails (F-L1). */
  private async toDlq(
    object: unknown,
    p: { category: FailureCategory; reason: string; engine: string; offset: string | null; error?: unknown },
  ): Promise<AppendOutcome> {
    const item = await this.dlq.record({
      payload: object,
      category: p.category,
      reason: p.reason,
      error: p.error,
      engine: p.engine,
      offset: p.offset,
      capturedAt: this.now(),
    });
    return { status: 'DLQ', item, reason: p.reason };
  }

  /**
   * Pure (no DLQ I/O) compute: validate, enforce CCE integrity, build + serialize.
   * Any throw (canonical serialization in validation/verifyCce/serialize) becomes
   * a SERIALIZATION_FAILURE — never an uncaught throw from append (F-H2).
   */
  private prepare(object: AppendableObject, placement: EvidencePlacement): Prepared {
    let desc: ObjectDescriptor | null = null;
    try {
      desc = describe(object);
      if (!desc) {
        return { ok: false, category: 'SCHEMA_VALIDATION_FAILURE', reason: 'unrecognized evidence object kind (not a CCE or snapshot_epoch_manifest)', engine: 'unknown', offset: null };
      }

      const result = desc.type === 'cce' ? validateCceFull(object) : validateSnapshotEpochManifest(object);
      if (!result.valid) {
        const reason = `evidence object failed ${desc.type} validation: ${result.errors.map((e) => `${e.rule}@${e.instancePath}`).join(', ')}`;
        return { ok: false, category: 'SCHEMA_VALIDATION_FAILURE', reason, engine: desc.engine, offset: desc.objectId || null };
      }

      // F-H1: CCE must carry integrity evidence AND it must verify.
      if (desc.type === 'cce') {
        const presence = cceEvidencePresent(object);
        if (!presence.ok) {
          return { ok: false, category: 'SCHEMA_VALIDATION_FAILURE', reason: presence.reason, engine: desc.engine, offset: desc.objectId || null };
        }
        const v = verifyCce(object as Cce);
        if (!v.event_hash_ok || !v.row_hash_ok) {
          return { ok: false, category: 'SCHEMA_VALIDATION_FAILURE', reason: `CCE evidence does not verify (event_hash_ok=${v.event_hash_ok}, row_hash_ok=${v.row_hash_ok})`, engine: desc.engine, offset: desc.objectId || null };
        }
      }

      const worm_object_key = evidenceObjectKey(desc.dbId, placement.segment_id, placement.seq, desc.type);
      const toWrite: AppendableObject = desc.type === 'cce' ? withBackRefs(object as Cce, worm_object_key, placement.segment_id) : object;
      const bytes = new TextEncoder().encode(serializeCanonical(toWrite));
      return { ok: true, worm_object_key, bytes, toWrite, objectId: desc.objectId, objectType: desc.type, engine: desc.engine };
    } catch (err) {
      // Canonical serialization (validation V12 / verifyCce / serializeCanonical) failed.
      return { ok: false, category: 'SERIALIZATION_FAILURE', reason: `serialization failed: ${(err as Error).message}`, engine: desc?.engine ?? 'unknown', offset: desc?.objectId ?? null, error: err };
    }
  }

  /**
   * Validate then append one evidence object at `placement`. Invalid, non-verifying,
   * unserializable, or unwritable objects go to the DLQ (alarmed); they never reach
   * WORM. append rejects ONLY if the DLQ itself cannot persist the failure (F-L1).
   */
  async append(object: AppendableObject, placement: EvidencePlacement): Promise<AppendOutcome> {
    const prepared = this.prepare(object, placement);
    if (!prepared.ok) {
      return this.toDlq(object, prepared);
    }

    try {
      await this.worm.putImmutable(prepared.worm_object_key, prepared.bytes, this.putOptions());
    } catch (err) {
      // WORM rejected the write (e.g. overwrite of an existing key). Tracked: F-M1
      // (benign replay) / F-M2 (same-key different-content conflict) are both
      // surfaced here as UNEXPECTED_EXCEPTION until a content-aware path exists.
      return this.toDlq(object, {
        category: 'UNEXPECTED_EXCEPTION',
        reason: `WORM write failed for "${prepared.worm_object_key}": ${(err as Error).message}`,
        error: err,
        engine: prepared.engine,
        offset: prepared.objectId || null,
      });
    }

    return {
      status: 'WRITTEN',
      result: { worm_object_key: prepared.worm_object_key, segment_id: placement.segment_id, object_id: prepared.objectId, object_type: prepared.objectType },
      object: prepared.toWrite,
    };
  }
}
