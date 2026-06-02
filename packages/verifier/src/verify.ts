// Verifier entrypoints (Sprint-2 / EDAM-T140 skeleton + EDAM-T141 §10 steps 1-3).
//
// `verifySegments` (T141) re-proves §10 steps 1-3 over already-parsed segments
// (manifest + ordered CCE objects): per_object_hash, object_chain, segment_manifest.
// The remaining checks (cross_segment_continuity / no_missing_segment /
// no_missing_event = T142; hsm_signature / anchor_token = T143;
// projection_consistency = T144) are emitted SKIPPED. The overall result is
// FAIL-CLOSED (T140-M1): PASS only when every REQUIRED integrity check ran and
// passed — so a T141-stage report (with T142/T143 checks SKIPPED) is never PASS.
//
// `verify` resolves db_id/scope from a WORM-read-port or export-package input.
// Reading/parsing/ordering segments from those inputs (WORM I/O; export object
// payloads — see the recorded T140 readiness notes) is wired in later stages;
// until then `verify` emits the §10 checks SKIPPED and is FAIL-closed. Pass
// parsed segments to `verifySegments` for the T141 recompute.

import { VerificationReportBuilder, ALL_CHECKS, type CheckName, type VerificationReport, type VerifierIdentity } from './report.js';
import { recomputeSegment, type VerifierSegment, type CheckOutcome } from './verify-segments.js';
import type { VerifierInput, VerificationScope } from './input.js';

export interface VerifyOptions {
  /** Verifier identity recorded in the report (default: independent_external). */
  verifier?: VerifierIdentity;
  /** Deterministic report id (default: random uuid). */
  reportId?: string;
  /** Deterministic report timestamp (default: now). */
  generatedAt?: string;
  /** Scope override for export-mode input (later stages derive this from the parsed manifests). */
  scope?: VerificationScope;
}

export interface VerifySegmentsArgs {
  db_id: string;
  scope: VerificationScope;
  segments: readonly VerifierSegment[];
  verifier?: VerifierIdentity;
  reportId?: string;
  generatedAt?: string;
}

const DEFAULT_VERIFIER: VerifierIdentity = { type: 'independent_external' };

/** The §10 checks NOT implemented in T141 (filled by T142-T144); emitted SKIPPED. */
const SKIPPED_CHECKS: readonly CheckName[] = [
  'cross_segment_continuity',
  'no_missing_segment',
  'no_missing_event',
  'hsm_signature',
  'anchor_token',
  'projection_consistency',
];

/** Aggregate one check across segments: PASS iff all PASS; offending ids located per-segment. */
function aggregate(segments: readonly VerifierSegment[], pick: (r: ReturnType<typeof recomputeSegment>) => CheckOutcome): CheckOutcome {
  const offending: string[] = [];
  const details: string[] = [];
  for (const seg of segments) {
    const outcome = pick(recomputeSegment(seg));
    if (outcome.result === 'FAIL') {
      for (const id of outcome.offending_ids) offending.push(`${seg.manifest.segment_id}/${id}`);
      if (outcome.details) details.push(`${seg.manifest.segment_id}: ${outcome.details}`);
    }
  }
  return offending.length > 0 || details.length > 0
    ? { result: 'FAIL', offending_ids: offending, details: details.join(' | ') }
    : { result: 'PASS', offending_ids: [] };
}

function addCheck(builder: VerificationReportBuilder, check: CheckName, outcome: CheckOutcome): void {
  builder.add({
    check,
    result: outcome.result,
    ...(outcome.details !== undefined ? { details: outcome.details } : {}),
    ...(outcome.offending_ids.length > 0 ? { offending_ids: outcome.offending_ids } : {}),
  });
}

/**
 * Verify §10 steps 1-3 over parsed segments and emit a `verification-report-1.0`.
 * per_object_hash / object_chain / segment_manifest are recomputed (PASS for a
 * valid chain; FAIL with located offending ids on tamper); the remaining checks
 * are SKIPPED. Overall is FAIL-CLOSED (never PASS while required checks remain
 * SKIPPED — T140-M1).
 */
export function verifySegments(args: VerifySegmentsArgs): VerificationReport {
  const builder = new VerificationReportBuilder({
    db_id: args.db_id,
    verifier: args.verifier ?? DEFAULT_VERIFIER,
    scope: args.scope,
    ...(args.reportId !== undefined ? { reportId: args.reportId } : {}),
    ...(args.generatedAt !== undefined ? { generatedAt: args.generatedAt } : {}),
  });

  addCheck(builder, 'per_object_hash', aggregate(args.segments, (r) => r.per_object_hash));
  addCheck(builder, 'object_chain', aggregate(args.segments, (r) => r.object_chain));
  addCheck(builder, 'segment_manifest', aggregate(args.segments, (r) => r.segment_manifest));
  for (const check of SKIPPED_CHECKS) builder.skip(check);

  return builder.build();
}

/** Resolve db_id + scope from the input (worm carries both; export takes db_id from the package). */
function resolveContext(input: VerifierInput, opts: VerifyOptions): { db_id: string; scope: VerificationScope } {
  if (input.mode === 'worm') return { db_id: input.dbId, scope: input.scope };
  return { db_id: input.package.db_id, scope: opts.scope ?? { first_segment_sequence: 0, last_segment_sequence: 0 } };
}

/**
 * Verify evidence from a WORM-read-port or export-package input. Segment
 * reading/parsing from those inputs is wired in a later stage (see the recorded
 * T140 readiness notes); until then this emits the §10 checks SKIPPED and is
 * FAIL-closed. Use `verifySegments` to run the T141 recompute over parsed segments.
 */
export function verify(input: VerifierInput, opts: VerifyOptions = {}): VerificationReport {
  const { db_id, scope } = resolveContext(input, opts);
  const builder = new VerificationReportBuilder({
    db_id,
    verifier: opts.verifier ?? DEFAULT_VERIFIER,
    scope,
    ...(opts.reportId !== undefined ? { reportId: opts.reportId } : {}),
    ...(opts.generatedAt !== undefined ? { generatedAt: opts.generatedAt } : {}),
  });
  for (const check of ALL_CHECKS) builder.skip(check);
  return builder.build();
}
