// Verifier projection consistency (Sprint-2 / EDAM-T144): §10 step 9.
//
// Compares a SUPPLIED projection snapshot (the queryable PostgreSQL copy's
// per-object row_hash) against the VERIFIED WORM evidence row_hash per object
// (§11). Drift is a PROJECTION finding — rebuildable, NOT an evidence-integrity
// failure (§10.2): `projection_consistency` FAILs on drift, but the overall
// result is decided only by the required integrity checks (the projection check
// is advisory; see report.#computeOverall).
//
// Pure + public-inputs-only: a row_hash comparison over already-verified objects
// + a supplied snapshot. The verifier does NOT rebuild projection rows from
// content (that is the projection engine, out of verifier scope — deferred) and
// makes no DB connection. No new dependency.

import type { CheckOutcome, VerifierSegment } from './verify-segments.js';

/** A supplied projection snapshot: the projection's per-object row_hash (public input). */
export interface ProjectionSnapshot {
  rows: Array<{ object_id: string; row_hash: string }>;
}

/**
 * §10.9 projection consistency: compare the supplied projection rows to the
 * verified WORM evidence row_hash per object. Drift (hash mismatch, a WORM object
 * missing from the projection, or an extra projection row with no WORM object) =>
 * FAIL with the affected object_ids located. No drift => PASS.
 *
 * This is ADVISORY — a FAIL here does not fail evidence integrity (the report's
 * overall result is decided by the required checks only).
 */
export function recomputeProjectionConsistency(segments: readonly VerifierSegment[], projection: ProjectionSnapshot): CheckOutcome {
  // Verified WORM row_hash per object_id (from the recomputed/verified segment objects).
  const wormRowHash = new Map<string, string>();
  for (const seg of segments) {
    for (const obj of seg.objects) wormRowHash.set(obj.envelope_id, obj.evidence.row_hash);
  }

  const offending: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const row of projection.rows) {
    seen.add(row.object_id);
    const worm = wormRowHash.get(row.object_id);
    if (worm === undefined) {
      problems.push(`projection row ${row.object_id} has no corresponding WORM object (extra row)`);
      offending.push(row.object_id);
    } else if (worm !== row.row_hash) {
      problems.push(`projection row ${row.object_id} row_hash drifted from the WORM object`);
      offending.push(row.object_id);
    }
  }

  for (const objectId of wormRowHash.keys()) {
    if (!seen.has(objectId)) {
      problems.push(`WORM object ${objectId} has no projection row (missing row)`);
      offending.push(objectId);
    }
  }

  return offending.length > 0
    ? { result: 'FAIL', offending_ids: [...new Set(offending)], details: problems.join('; ') }
    : { result: 'PASS', offending_ids: [] };
}
