// Segment hash + genesis + cross-segment linkage verification (Sprint-2 / EDAM-T110; logic from T113).
//
// Pure, fail-closed. Computes the WORM §7.2 segment_hash and verifies §7.3/§7.4
// cross-segment continuity. Computes NO manifest, performs NO intra-segment chain
// verify, writes NOTHING, drives NO lifecycle/alarm/seal, and does NO
// signing/anchoring. Shared by the writer (seal) and the verifier (re-prove).
//
//   segment_hash = SHA-256( manifest_hash ‖ last_row_hash ‖ previous_segment_hash )
//
// mirroring the FROZEN row_hash construction (token-string concatenation of
// `sha256:<hex>` values; no new byte layout — INV-4). Genesis (segment_sequence 0)
// uses previous_segment_hash = the all-zero hash; later segments link to the prior
// segment's segment_hash and the object chain does not reset across the boundary.

import { sha256Hex, assertHashToken } from '@edam/canonical';
import type { SegmentHead, SegmentManifest } from './types.js';

export type { SegmentHead } from './types.js';

/** Genesis predecessor for the first segment (WORM §7.3): the all-zero hash. */
export const GENESIS_PREVIOUS_SEGMENT_HASH = 'sha256:' + '0'.repeat(64);

export type CrossSegmentFailureRule =
  | 'GENESIS'
  | 'MISSING_PREVIOUS'
  | 'DB_ID'
  | 'SEQUENCE'
  | 'PREVIOUS_SEGMENT'
  | 'PREVIOUS_SEGMENT_HASH'
  | 'ROW_BOUNDARY';

export interface CrossSegmentFailure {
  rule: CrossSegmentFailureRule;
  detail: string;
}

export interface CrossSegmentVerification {
  ok: boolean;
  genesis: boolean;
  failures: CrossSegmentFailure[];
}

/** WORM §7.2 segment_hash: SHA-256 over the three `sha256:` token strings, in order. */
export function computeSegmentHash(manifestHash: string, lastRowHash: string, previousSegmentHash: string): string {
  assertHashToken(manifestHash, 'manifest_hash');
  assertHashToken(lastRowHash, 'last_row_hash');
  assertHashToken(previousSegmentHash, 'previous_segment_hash');
  return 'sha256:' + sha256Hex(manifestHash + lastRowHash + previousSegmentHash);
}

/** The previous_segment_hash a manifest links to (genesis ⇒ all-zero; else its previous_segment.segment_hash). */
function previousSegmentHashOf(manifest: SegmentManifest): string {
  if (manifest.segment_sequence === 0) return GENESIS_PREVIOUS_SEGMENT_HASH;
  if (!manifest.previous_segment) {
    throw new Error(`non-genesis manifest ${manifest.segment_id} has no previous_segment`);
  }
  return manifest.previous_segment.segment_hash;
}

/** Recompute a manifest's OWN segment_hash from its fields. */
export function segmentHashOf(manifest: SegmentManifest): string {
  return computeSegmentHash(manifest.manifest_hash, manifest.last_row_hash, previousSegmentHashOf(manifest));
}

/** Derive the chain head (incl. segment_hash) for a sealed manifest. */
export function deriveSegmentHead(manifest: SegmentManifest): SegmentHead {
  return {
    db_id: manifest.db_id,
    segment_id: manifest.segment_id,
    segment_sequence: manifest.segment_sequence,
    segment_hash: segmentHashOf(manifest),
    last_row_hash: manifest.last_row_hash,
  };
}

/**
 * Verify cross-segment continuity (WORM §7.3/§7.4, §10.4). Fail-closed.
 *   - genesis (segment_sequence 0): no prior manifest; previous_segment must be null.
 *   - non-genesis: prior manifest present; same db_id; sequence == prior+1;
 *     previous_segment links to the prior (id/sequence) and its segment_hash equals
 *     the recomputed prior segment_hash; and the object chain is unbroken across
 *     the boundary (current first object's prev_row_hash equals the prior segment's
 *     last_row_hash).
 *
 * @param current the current segment's manifest.
 * @param currentFirstPrevRowHash the current segment's first object's prev_row_hash.
 * @param previous the prior segment's manifest, or null for genesis.
 */
export function verifyCrossSegment(
  current: SegmentManifest,
  currentFirstPrevRowHash: string,
  previous: SegmentManifest | null,
): CrossSegmentVerification {
  const failures: CrossSegmentFailure[] = [];
  const genesis = current.segment_sequence === 0;

  if (genesis) {
    if (previous !== null) failures.push({ rule: 'GENESIS', detail: 'genesis segment must have no previous manifest' });
    if (current.previous_segment !== null) failures.push({ rule: 'GENESIS', detail: 'genesis manifest.previous_segment must be null' });
    return { ok: failures.length === 0, genesis: true, failures };
  }

  if (!previous) {
    failures.push({ rule: 'MISSING_PREVIOUS', detail: `non-genesis segment (sequence ${current.segment_sequence}) requires a previous manifest` });
    return { ok: false, genesis: false, failures };
  }

  if (current.db_id !== previous.db_id) {
    failures.push({ rule: 'DB_ID', detail: `db_id "${current.db_id}" !== previous db_id "${previous.db_id}"` });
  }
  if (current.segment_sequence !== previous.segment_sequence + 1) {
    failures.push({ rule: 'SEQUENCE', detail: `segment_sequence ${current.segment_sequence} !== previous ${previous.segment_sequence} + 1` });
  }

  const ps = current.previous_segment;
  if (!ps) {
    failures.push({ rule: 'PREVIOUS_SEGMENT', detail: 'non-genesis manifest.previous_segment must not be null' });
  } else {
    if (ps.segment_id !== previous.segment_id) failures.push({ rule: 'PREVIOUS_SEGMENT', detail: `previous_segment.segment_id "${ps.segment_id}" !== "${previous.segment_id}"` });
    if (ps.segment_sequence !== previous.segment_sequence) failures.push({ rule: 'PREVIOUS_SEGMENT', detail: `previous_segment.segment_sequence ${ps.segment_sequence} !== ${previous.segment_sequence}` });
    const recomputedPrev = segmentHashOf(previous);
    if (ps.segment_hash !== recomputedPrev) {
      failures.push({ rule: 'PREVIOUS_SEGMENT_HASH', detail: `previous_segment.segment_hash !== recomputed prior segment_hash (prior manifest_hash/last_row_hash/segment_hash continuity broken)` });
    }
  }

  // §7.4.2: the object chain does not reset at the boundary.
  if (currentFirstPrevRowHash !== previous.last_row_hash) {
    failures.push({ rule: 'ROW_BOUNDARY', detail: `current first object prev_row_hash !== previous segment last_row_hash` });
  }

  return { ok: failures.length === 0, genesis: false, failures };
}
