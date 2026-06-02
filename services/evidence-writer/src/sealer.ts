// Segment seal transition + chain-head emit (Sprint-2 / EDAM-T114).
//
// The seal orchestrator that ties E2A/E2B together for one segment. It is the
// owner of E2B-CHAIN-1: it ESTABLISHES the final ordered prev_row_hash chain,
// then verifies (T112 intra-segment, T113 cross-segment) BEFORE completing the
// seal, writes the objects at their final ordered placement (M-A-INT-1 / Option B)
// and writes the manifest immutably, and emits the chain head to the signing
// stage. It performs NO signing and NO anchoring.
//
// Lifecycle (no skip to ANCHORED):
//   OPEN (accumulator) -> SEALING (seal in progress) -> SEALED (success)
//                                                    \-> VERIFICATION_FAILED (terminal, CRITICAL alarm)
// ANCHORED is produced by a later stage (T2D), never here; the head is only
// EMITTED to the signing stage (T2C).

import { serializeCanonical, rowHash, GENESIS_ROW_HASH } from '@edam/canonical';
import type { Cce } from '@edam/cce-model';
import type { PutOptions, WormWriter } from '@edam/worm';
import {
  verifySegmentChain,
  buildSegmentManifest,
  SegmentManifestError,
  deriveSegmentHead,
  verifyCrossSegment,
  type SegmentManifest,
  type SegmentHead,
} from '@edam/evidence';
import type { SealReadySegment } from './accumulator.js';
import type { EvidenceWriter } from './writer.js';

export interface SealAlarm {
  kind: 'VERIFICATION_FAILED' | 'SEAL_WRITE_FAILED';
  severity: 'critical';
  message: string;
  at: string;
  details?: Record<string, unknown>;
}
export interface SealAlarmSink {
  raise(alarm: SealAlarm): void;
}

/** The prior sealed segment (its manifest + head), or null for genesis. */
export interface PreviousSealed {
  manifest: SegmentManifest;
  head: SegmentHead;
}

export type SealOutcome =
  | { status: 'SEALED'; head: SegmentHead; manifest: SegmentManifest; manifest_object_key: string; object_keys: string[] }
  | { status: 'VERIFICATION_FAILED'; stage: 'INTRA_CHAIN' | 'CROSS_SEGMENT' | 'MANIFEST'; failures: string[] }
  | { status: 'WRITE_FAILED'; detail: string };

export interface SegmentSealerDeps {
  /** T106 writer for the CCE objects (validate + back-refs + immutable append). */
  objectWriter: EvidenceWriter;
  /** Append-only WORM writer for the manifest object. */
  worm: WormWriter;
  /** Emit the sealed chain head to the signing stage (T2C). No signing here. */
  emitHead: (head: SegmentHead) => void;
  /** Critical-alarm sink (VERIFICATION_FAILED is terminal). */
  alarms: SealAlarmSink;
  /** Clock; sealed_at is recorded ONCE per seal (stable for reproducibility). */
  now: () => string;
  retainUntil?: string;
  legalHold?: boolean;
}

/** Deterministic WORM key for a segment manifest object. */
export function manifestObjectKey(dbId: string, segmentId: string): string {
  return `${dbId}/${segmentId}/manifest.json`;
}

/**
 * Establish the final ordered chain (E2B-CHAIN-1): re-derive each object's
 * prev_row_hash/row_hash in global order from the boundary. event_hash is
 * UNCHANGED (it excludes `evidence`). Returns a new segment with re-chained
 * objects and recomputed hash-dependent metadata (object_hash_list, first/last
 * row_hash). object_list/source_offset_range/summaries are unchanged.
 */
export function establishChain(seg: SealReadySegment, boundaryPrevRowHash: string): SealReadySegment {
  const chained: Cce[] = [];
  let prev = boundaryPrevRowHash;
  for (const c of seg.objects) {
    const row = rowHash(prev, c.evidence.event_hash);
    chained.push({ ...c, evidence: { ...c.evidence, prev_row_hash: prev, row_hash: row } } as Cce);
    prev = row;
  }
  const n = chained.length;
  return {
    ...seg,
    objects: chained,
    object_hash_list: chained.map((c, seq) => ({ seq, event_hash: c.evidence.event_hash, row_hash: c.evidence.row_hash })),
    first_row_hash: n > 0 ? chained[0]!.evidence.row_hash : seg.first_row_hash,
    last_row_hash: n > 0 ? chained[n - 1]!.evidence.row_hash : seg.last_row_hash,
  };
}

export class SegmentSealer {
  private readonly deps: SegmentSealerDeps;

  constructor(deps: SegmentSealerDeps) {
    this.deps = deps;
  }

  private putOptions(): PutOptions {
    return {
      retentionMode: 'compliance',
      ...(this.deps.retainUntil ? { retainUntil: this.deps.retainUntil } : {}),
      ...(this.deps.legalHold ? { legalHold: true } : {}),
    };
  }

  private failVerification(stage: 'INTRA_CHAIN' | 'CROSS_SEGMENT' | 'MANIFEST', failures: string[], seg: SealReadySegment, at: string): SealOutcome {
    this.deps.alarms.raise({
      kind: 'VERIFICATION_FAILED',
      severity: 'critical',
      message: `segment ${seg.segment_id} (seq ${seg.segment_sequence}) failed ${stage} verification at seal`,
      at,
      details: { db_id: seg.db_id, stage, failures },
    });
    return { status: 'VERIFICATION_FAILED', stage, failures };
  }

  /** Seal one accumulator-prepared segment. Fail-closed; never produces ANCHORED. */
  async seal(segment: SealReadySegment, previous: PreviousSealed | null): Promise<SealOutcome> {
    const at = this.deps.now(); // sealed_at recorded once
    const genesis = segment.segment_sequence === 0;

    if (!genesis && !previous) {
      return this.failVerification('CROSS_SEGMENT', ['non-genesis segment requires a previous sealed segment'], segment, at);
    }

    // --- SEALING: establish the final ordered chain from the boundary ---
    const boundary = genesis ? GENESIS_ROW_HASH : previous!.head.last_row_hash;
    const chained = establishChain(segment, boundary);

    // 1. intra-segment chain verify (T112)
    const chainV = verifySegmentChain(chained);
    if (!chainV.ok) {
      return this.failVerification('INTRA_CHAIN', chainV.failures.map((f) => `${f.rule}@${f.seq}: ${f.detail}`), chained, at);
    }

    // 2. build manifest (T111)
    const previousSegment = genesis
      ? null
      : { segment_id: previous!.manifest.segment_id, segment_sequence: previous!.manifest.segment_sequence, segment_hash: previous!.head.segment_hash };
    let manifest: SegmentManifest;
    try {
      manifest = buildSegmentManifest(chained, { sealedAt: at, previousSegment });
    } catch (err) {
      const detail = err instanceof SegmentManifestError ? err.message : String((err as Error).message);
      return this.failVerification('MANIFEST', [detail], chained, at);
    }

    // 3. cross-segment verify (T113)
    const crossV = verifyCrossSegment(manifest, boundary, previous ? previous.manifest : null);
    if (!crossV.ok) {
      return this.failVerification('CROSS_SEGMENT', crossV.failures.map((f) => `${f.rule}: ${f.detail}`), chained, at);
    }

    const head = deriveSegmentHead(manifest);

    // 4. write objects at the FINAL ordered placement (M-A-INT-1 / Option B)
    const object_keys: string[] = [];
    for (let i = 0; i < chained.objects.length; i++) {
      const out = await this.deps.objectWriter.append(chained.objects[i]!, { segment_id: chained.segment_id, seq: i });
      if (out.status !== 'WRITTEN') {
        return this.writeFailed(`object seq ${i} not written: ${out.reason}`, chained, at);
      }
      const expectedKey = chained.object_list[i]!.worm_object_key;
      if (out.result.worm_object_key !== expectedKey) {
        return this.writeFailed(`object seq ${i} key mismatch: ${out.result.worm_object_key} !== ${expectedKey}`, chained, at);
      }
      object_keys.push(out.result.worm_object_key);
    }

    // 5. write the manifest immutably
    const manifest_object_key = manifestObjectKey(chained.db_id, chained.segment_id);
    try {
      await this.deps.worm.putImmutable(manifest_object_key, new TextEncoder().encode(serializeCanonical(manifest)), this.putOptions());
    } catch (err) {
      return this.writeFailed(`manifest write failed for "${manifest_object_key}": ${(err as Error).message}`, chained, at);
    }

    // 6. SEALED — emit the head to the signing stage (no anchoring here)
    this.deps.emitHead(head);
    return { status: 'SEALED', head, manifest, manifest_object_key, object_keys };
  }

  private writeFailed(detail: string, seg: SealReadySegment, at: string): SealOutcome {
    this.deps.alarms.raise({
      kind: 'SEAL_WRITE_FAILED',
      severity: 'critical',
      message: `segment ${seg.segment_id} (seq ${seg.segment_sequence}) seal write failed`,
      at,
      details: { db_id: seg.db_id, detail },
    });
    return { status: 'WRITE_FAILED', detail };
  }
}
