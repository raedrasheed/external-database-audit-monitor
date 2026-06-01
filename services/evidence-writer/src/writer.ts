// Append-only evidence writer (Sprint-2 / EDAM-T106).
//
// Domain B's WORM capability: validate-before-write, then write immutably.
//   - Every object is validated against ITS OWN contract before any WORM write;
//     an invalid object NEVER reaches WORM — it is routed to the DLQ + alarmed
//     (no event disappears silently, INV-2 / no-fabrication).
//   - A CCE gets its evidence.{worm_object_key,segment_id} back-refs populated
//     (existing CCE schema fields, inside `evidence` which is EXCLUDED from the
//     hashed core — so event_hash/row_hash and the golden vectors are unchanged).
//   - The writer holds ONLY a WormWriter (append-only). It never obtains the
//     retention-admin role or any delete/overwrite path (INV-EV-1).
// Segment lifecycle / global ordering / caps are the accumulator's job (T107);
// here the caller supplies the placement.

import { serializeCanonical } from '@edam/canonical';
import { validateCceFull, validateSnapshotEpochManifest } from '@edam/contracts';
import type { Cce } from '@edam/cce-model';
import type { DlqService } from '@edam/dlq';
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

  /**
   * Validate then append one evidence object at `placement`. Invalid or
   * unwritable objects go to the DLQ (alarmed); they never reach WORM.
   */
  async append(object: AppendableObject, placement: EvidencePlacement): Promise<AppendOutcome> {
    const desc = describe(object);
    if (!desc) {
      const reason = 'unrecognized evidence object kind (not a CCE or snapshot_epoch_manifest)';
      const item = await this.dlq.record({
        payload: object,
        category: 'SCHEMA_VALIDATION_FAILURE',
        reason,
        engine: 'unknown',
        offset: null,
        capturedAt: this.now(),
      });
      return { status: 'DLQ', item, reason };
    }

    const result = desc.type === 'cce' ? validateCceFull(object) : validateSnapshotEpochManifest(object);
    if (!result.valid) {
      const reason = `evidence object failed ${desc.type} validation: ${result.errors
        .map((e) => `${e.rule}@${e.instancePath}`)
        .join(', ')}`;
      const item = await this.dlq.record({
        payload: object,
        category: 'SCHEMA_VALIDATION_FAILURE',
        reason,
        engine: desc.engine,
        offset: desc.objectId || null,
        capturedAt: this.now(),
      });
      return { status: 'DLQ', item, reason };
    }

    const worm_object_key = evidenceObjectKey(desc.dbId, placement.segment_id, placement.seq, desc.type);
    const toWrite: AppendableObject =
      desc.type === 'cce' ? withBackRefs(object as Cce, worm_object_key, placement.segment_id) : object;
    const bytes = new TextEncoder().encode(serializeCanonical(toWrite));

    try {
      await this.worm.putImmutable(worm_object_key, bytes, this.putOptions());
    } catch (err) {
      const reason = `WORM write failed for "${worm_object_key}": ${(err as Error).message}`;
      const item = await this.dlq.record({
        payload: object,
        category: 'UNEXPECTED_EXCEPTION',
        reason,
        error: err,
        engine: desc.engine,
        offset: desc.objectId || null,
        capturedAt: this.now(),
      });
      return { status: 'DLQ', item, reason };
    }

    return {
      status: 'WRITTEN',
      result: { worm_object_key, segment_id: placement.segment_id, object_id: desc.objectId, object_type: desc.type },
      object: toWrite,
    };
  }
}
