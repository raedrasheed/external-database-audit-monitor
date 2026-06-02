// Evidence segment accumulator (Sprint-2 / EDAM-T107).
//
// Pure, in-memory preparation of evidence SEGMENT STATE for one db_id at a time.
// It does NOT write to WORM, does NOT compute manifest_hash/segment_hash, and
// does NOT seal — sealing + chain linkage are E2B. The accumulator only:
//   - opens ONE segment per db_id, segment_sequence contiguous from 0;
//   - admits only structurally-valid CCEs carrying integrity evidence (no
//     invalid/unvalidated object ever enters segment state);
//   - buffers objects and, on an event-count or time cap, orders them with the
//     FROZEN global order (@edam/cce-model orderCces, incl. the Rev-4 snapshot
//     tie-break — no second ordering algorithm here) and produces a SealReady
//     segment with the tracked fields (first/last ids + row_hash, object_list,
//     object_hash_list, source_offset_range, fidelity/completeness summaries).
// Snapshot epoch manifests are companion records (WORM §6 object_type is
// cce|execution_result|db_audit_event), so they are NOT segment objects and are
// not accumulated here.

import { isHashToken } from '@edam/canonical';
import { orderCces, type Cce } from '@edam/cce-model';
import { evidenceObjectKey } from './writer.js';

export interface SegmentCaps {
  /** Seal after this many objects (>=1). */
  maxEvents: number;
  /** Seal once the open segment has been open at least this long (ms). */
  maxAgeMs: number;
}

export interface AccumulatorDeps {
  caps: SegmentCaps;
  /** Clock (DI for determinism). */
  now: () => string;
}

export type SealTrigger = 'event_count_cap' | 'time_cap' | 'flush';

export interface SegmentObjectRef {
  seq: number;
  object_id: string;
  worm_object_key: string;
  object_type: 'cce';
}

export interface SegmentObjectHash {
  seq: number;
  event_hash: string;
  row_hash: string;
}

/**
 * A segment whose state is finalized and is READY FOR SEALING (E2B). It mirrors
 * the WORM §6 manifest fields the accumulator can compute, but deliberately OMITS
 * the sealing/chain fields (manifest_hash, segment_hash, previous_segment,
 * sealed_at) — those are computed by the sealing step (E2B / T111–T113).
 */
export interface SealReadySegment {
  db_id: string;
  engine: string;
  segment_id: string;
  segment_sequence: number;
  opened_at: string;
  /** When the cap fired and the segment was marked ready for sealing. */
  closed_at: string;
  trigger: SealTrigger;
  event_count: number;
  first_envelope_id: string;
  last_envelope_id: string;
  first_row_hash: string;
  last_row_hash: string;
  object_list: SegmentObjectRef[];
  object_hash_list: SegmentObjectHash[];
  source_offset_range: { first_offset_key: string; last_offset_key: string; consumed_gtid_set?: string };
  fidelity_summary: { all_healthy: boolean; degraded_count: number; compromised_count: number; reasons: string[] };
  completeness_summary: { gap_detected: boolean; expected_continuous: boolean; notes: string[] };
  /**
   * TRANSPORT-ONLY (M-A-INT-1): the exact ordered objects from which
   * `object_list` and `object_hash_list` were derived. `objects[i]` aligns
   * EXACTLY with `object_list[i]` and `object_hash_list[i]`. The E2B seal step
   * (T114) writes THESE to WORM at `object_list[i].worm_object_key` and the chain
   * re-verify (T112) runs over THESE — so the hashed manifest and the WORM
   * objects are provably the same set, with no re-fetch.
   *
   * NOT part of the manifest and NOT part of any hash input (manifest_hash /
   * segment_hash are computed over metadata only). This field carries full
   * (masked-but-real) CCE payloads: it is an in-process handle ONLY — do not log
   * or serialize `SealReadySegment` wholesale.
   */
  readonly objects: readonly Cce[];
}

export interface AddResult {
  /** Segments that became ready for sealing during this add (0, 1, or 2). */
  sealed: SealReadySegment[];
  /** Set when the object was NOT admitted (and not buffered). */
  rejected?: string;
}

interface OpenSegment {
  db_id: string;
  engine: string;
  segment_id: string;
  segment_sequence: number;
  opened_at: string;
  objects: Cce[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Admission gate: only structurally-valid CCEs carrying integrity evidence enter segment state. */
function admit(object: Cce): { ok: true } | { ok: false; reason: string } {
  const o = object as unknown;
  if (!isRecord(o) || o.kind !== 'transaction') return { ok: false, reason: 'not a CCE (kind !== transaction)' };
  const src = o.source;
  if (!isRecord(src) || typeof src.db_id !== 'string' || src.db_id.length === 0) return { ok: false, reason: 'missing source.db_id' };
  if (typeof src.engine !== 'string' || src.engine.length === 0) return { ok: false, reason: 'missing source.engine' };
  if (typeof o.envelope_id !== 'string' || o.envelope_id.length === 0) return { ok: false, reason: 'missing envelope_id' };
  const ev = o.evidence;
  if (!isRecord(ev) || typeof ev.event_hash !== 'string' || !isHashToken(ev.event_hash)) return { ok: false, reason: 'missing/invalid evidence.event_hash' };
  if (typeof ev.row_hash !== 'string' || !isHashToken(ev.row_hash)) return { ok: false, reason: 'missing/invalid evidence.row_hash' };
  if (!isRecord(o.fidelity) || typeof o.fidelity.state !== 'string') return { ok: false, reason: 'missing fidelity.state' };
  if (!isRecord(o.completeness) || typeof o.completeness.consumed_offset_key !== 'string') return { ok: false, reason: 'missing completeness.consumed_offset_key' };
  return { ok: true };
}

export class SegmentAccumulator {
  private readonly caps: SegmentCaps;
  private readonly now: () => string;
  private readonly open = new Map<string, OpenSegment>();
  private readonly nextSeq = new Map<string, number>();

  constructor(deps: AccumulatorDeps) {
    if (deps.caps.maxEvents < 1) throw new Error('maxEvents must be >= 1');
    this.caps = deps.caps;
    this.now = deps.now;
  }

  /** Inspect the current OPEN segments (for monitoring/tests). */
  openState(): Array<{ db_id: string; segment_id: string; segment_sequence: number; event_count: number }> {
    return [...this.open.values()].map((s) => ({
      db_id: s.db_id,
      segment_id: s.segment_id,
      segment_sequence: s.segment_sequence,
      event_count: s.objects.length,
    }));
  }

  private aged(seg: OpenSegment, now: string): boolean {
    return Date.parse(now) - Date.parse(seg.opened_at) >= this.caps.maxAgeMs;
  }

  private openSegment(dbId: string, engine: string, now: string): OpenSegment {
    const sequence = this.nextSeq.get(dbId) ?? 0;
    return {
      db_id: dbId,
      engine,
      segment_id: `seg-${String(sequence).padStart(6, '0')}`,
      segment_sequence: sequence,
      opened_at: now,
      objects: [],
    };
  }

  /** Admit + buffer one CCE; seal on a cap. Invalid objects are rejected, not buffered. */
  add(object: Cce): AddResult {
    const adm = admit(object);
    if (!adm.ok) return { sealed: [], rejected: adm.reason };

    const dbId = object.source.db_id;
    const sealed: SealReadySegment[] = [];
    const now = this.now();

    // Time cap on the existing open segment (only when a new object arrives).
    let seg = this.open.get(dbId);
    if (seg && seg.objects.length > 0 && this.aged(seg, now)) {
      sealed.push(this.seal(seg, 'time_cap', now));
      this.open.delete(dbId);
      seg = undefined;
    }
    if (!seg) {
      seg = this.openSegment(dbId, object.source.engine, now);
      this.open.set(dbId, seg);
    }

    seg.objects.push(object);

    if (seg.objects.length >= this.caps.maxEvents) {
      sealed.push(this.seal(seg, 'event_count_cap', this.now()));
      this.open.delete(dbId);
    }
    return { sealed };
  }

  /** Seal all OPEN non-empty segments whose time cap has elapsed (no new object needed). */
  sweep(now: string = this.now()): SealReadySegment[] {
    const sealed: SealReadySegment[] = [];
    for (const [dbId, seg] of [...this.open.entries()]) {
      if (seg.objects.length > 0 && this.aged(seg, now)) {
        sealed.push(this.seal(seg, 'time_cap', now));
        this.open.delete(dbId);
      }
    }
    return sealed;
  }

  /** Force-seal every OPEN non-empty segment (e.g. on shutdown). */
  flush(): SealReadySegment[] {
    const now = this.now();
    const sealed: SealReadySegment[] = [];
    for (const [dbId, seg] of [...this.open.entries()]) {
      if (seg.objects.length > 0) {
        sealed.push(this.seal(seg, 'flush', now));
      }
      this.open.delete(dbId);
    }
    return sealed;
  }

  /** Finalize a segment's state in the frozen global order. Does NOT write or hash-chain. */
  private seal(seg: OpenSegment, trigger: SealTrigger, closedAt: string): SealReadySegment {
    const ordered = orderCces(seg.objects); // FROZEN order (incl. Rev-4 snapshot tie-break)
    const n = ordered.length;
    const first = ordered[0]!;
    const last = ordered[n - 1]!;

    const object_list: SegmentObjectRef[] = ordered.map((c, seq) => ({
      seq,
      object_id: c.envelope_id,
      worm_object_key: evidenceObjectKey(seg.db_id, seg.segment_id, seq, 'cce'),
      object_type: 'cce',
    }));
    const object_hash_list: SegmentObjectHash[] = ordered.map((c, seq) => ({
      seq,
      event_hash: c.evidence.event_hash,
      row_hash: c.evidence.row_hash,
    }));

    let degraded_count = 0;
    let compromised_count = 0;
    const reasons = new Set<string>();
    let gap_detected = false;
    for (const c of ordered) {
      if (c.fidelity.state === 'DEGRADED') degraded_count += 1;
      else if (c.fidelity.state === 'COMPROMISED') compromised_count += 1;
      if (c.fidelity.state !== 'HEALTHY' && c.fidelity.degraded_reason) reasons.add(c.fidelity.degraded_reason);
      if (c.completeness.gap_detected === true) gap_detected = true;
    }

    this.nextSeq.set(seg.db_id, seg.segment_sequence + 1);

    const consumed_gtid_set = last.completeness.consumed_gtid_set;
    return {
      db_id: seg.db_id,
      engine: seg.engine,
      segment_id: seg.segment_id,
      segment_sequence: seg.segment_sequence,
      opened_at: seg.opened_at,
      closed_at: closedAt,
      trigger,
      event_count: n,
      first_envelope_id: first.envelope_id,
      last_envelope_id: last.envelope_id,
      first_row_hash: first.evidence.row_hash,
      last_row_hash: last.evidence.row_hash,
      object_list,
      object_hash_list,
      source_offset_range: {
        first_offset_key: first.completeness.consumed_offset_key,
        last_offset_key: last.completeness.consumed_offset_key,
        ...(consumed_gtid_set ? { consumed_gtid_set } : {}),
      },
      fidelity_summary: {
        all_healthy: degraded_count === 0 && compromised_count === 0,
        degraded_count,
        compromised_count,
        reasons: [...reasons].sort(),
      },
      completeness_summary: { gap_detected, expected_continuous: !gap_detected, notes: [] },
      // Transport-only: the SAME ordered array object_list/object_hash_list were
      // built from (index-aligned). Excluded from the manifest + all hash inputs.
      objects: ordered,
    };
  }
}
