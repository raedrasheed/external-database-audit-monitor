// Intra-segment row-hash chain verification (Sprint-2 / EDAM-T112).
//
// Pure, fail-closed re-verification of a SealReadySegment's object chain BEFORE
// sealing. For each object (in the accumulator's global order) it confirms:
//   - event_hash recomputes over the canonical core (verifyCce);
//   - row_hash == SHA256(prev_row_hash ?? GENESIS ‖ event_hash) (verifyCce);
//   - object_hash_list[i] equals objects[i].evidence.{event_hash,row_hash};
//   - object_list[i]/object_hash_list[i] are seq-ordered and aligned with objects[i];
//   - prev_row_hash linkage: objects[i].evidence.prev_row_hash == objects[i-1].row_hash.
// The FIRST object's prev_row_hash links to the PRIOR SEGMENT's last_row_hash —
// that cross-segment continuity is NOT checked here; it is T113's job. This
// module computes NO segment_hash, performs NO cross-segment linkage, writes
// NOTHING to WORM, and raises NO alarm / lifecycle transition (that is the seal
// step, T114). It only DETECTS, returning every broken link; the caller maps a
// failure to VERIFICATION_FAILED + a CRITICAL alarm.
//
// NOTE: this VERIFIES an established chain; it does not ESTABLISH it. Segments
// whose objects were built independently (each prev_row_hash = GENESIS) are a
// genuinely broken chain and fail closed here — threading prev_row_hash in global
// order is a build/seal concern, out of T112 scope.

import { verifyCce, type Cce } from '@edam/cce-model';
import type { SealReadySegment } from './accumulator.js';

export type ChainFailureRule = 'EMPTY' | 'ORDER' | 'HASH_LIST' | 'EVENT_HASH' | 'ROW_HASH' | 'PREV_LINK';

export interface ChainFailure {
  /** Object sequence (or -1 for whole-segment failures like EMPTY). */
  seq: number;
  rule: ChainFailureRule;
  detail: string;
}

export interface ObjectChainCheck {
  seq: number;
  object_id: string;
  event_hash_ok: boolean;
  row_hash_ok: boolean;
  prev_link_ok: boolean;
  hash_list_ok: boolean;
  order_ok: boolean;
}

export interface ChainVerification {
  ok: boolean;
  event_count: number;
  checks: ObjectChainCheck[];
  failures: ChainFailure[];
}

/**
 * Re-verify a segment's intra-segment object chain. Fail-closed: `ok` is true
 * only when every object passes every check and the segment is non-empty.
 */
export function verifySegmentChain(seg: SealReadySegment): ChainVerification {
  const failures: ChainFailure[] = [];
  const checks: ObjectChainCheck[] = [];
  const objects = seg.objects;
  const n = objects.length;

  if (n === 0) {
    failures.push({ seq: -1, rule: 'EMPTY', detail: 'segment has no objects' });
    return { ok: false, event_count: 0, checks, failures };
  }

  let prevRowHash: string | null = null; // previous object's row_hash (intra-segment)

  for (let i = 0; i < n; i++) {
    const obj: Cce = objects[i]!;
    const ref = seg.object_list[i];
    const h = seg.object_hash_list[i];

    // --- order / alignment ---
    let order_ok = true;
    if (!ref || ref.seq !== i || ref.object_id !== obj.envelope_id) {
      order_ok = false;
      failures.push({ seq: i, rule: 'ORDER', detail: `object_list[${i}] missing or misaligned with objects[${i}]` });
    }
    if (!h || h.seq !== i) {
      order_ok = false;
      failures.push({ seq: i, rule: 'ORDER', detail: `object_hash_list[${i}] missing or wrong seq` });
    }

    // --- event_hash / row_hash self-consistency (verifyCce) ---
    let event_hash_ok = false;
    let row_hash_ok = false;
    try {
      const v = verifyCce(obj);
      event_hash_ok = v.event_hash_ok;
      row_hash_ok = v.row_hash_ok;
    } catch (err) {
      failures.push({ seq: i, rule: 'EVENT_HASH', detail: `verifyCce threw (canonical serialization failed): ${(err as Error).message}` });
    }
    if (!event_hash_ok) failures.push({ seq: i, rule: 'EVENT_HASH', detail: `event_hash does not recompute over the canonical core` });
    if (!row_hash_ok) failures.push({ seq: i, rule: 'ROW_HASH', detail: `row_hash does not recompute from prev_row_hash + event_hash` });

    // --- object_hash_list matches the object's evidence ---
    let hash_list_ok = true;
    if (!h) {
      hash_list_ok = false;
    } else {
      if (h.event_hash !== obj.evidence.event_hash) {
        hash_list_ok = false;
        failures.push({ seq: i, rule: 'HASH_LIST', detail: `object_hash_list[${i}].event_hash !== objects[${i}].evidence.event_hash` });
      }
      if (h.row_hash !== obj.evidence.row_hash) {
        hash_list_ok = false;
        failures.push({ seq: i, rule: 'HASH_LIST', detail: `object_hash_list[${i}].row_hash !== objects[${i}].evidence.row_hash` });
      }
    }

    // --- prev_row_hash linkage (intra-segment; i === 0 is prior-segment scope, T113) ---
    let prev_link_ok = true;
    if (i > 0) {
      if (obj.evidence.prev_row_hash !== prevRowHash) {
        prev_link_ok = false;
        failures.push({ seq: i, rule: 'PREV_LINK', detail: `objects[${i}].evidence.prev_row_hash !== objects[${i - 1}].evidence.row_hash` });
      }
    }

    checks.push({ seq: i, object_id: obj.envelope_id, event_hash_ok, row_hash_ok, prev_link_ok, hash_list_ok, order_ok });
    prevRowHash = obj.evidence.row_hash;
  }

  return { ok: failures.length === 0, event_count: n, checks, failures };
}
