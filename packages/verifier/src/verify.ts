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
import { recomputeCrossSegment, recomputeNoMissingSegment, recomputeNoMissingEvent } from './verify-continuity.js';
import { verifyAnchorForSegment } from './verify-anchor.js';
import type { TrustedSigningKeyDirectory, TrustedAnchorCertDirectory } from './trust.js';
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
  /** Trusted published signing keys (T140). When both directories are provided, §10 steps 7-8 run; else they are SKIPPED. */
  trustedKeys?: TrustedSigningKeyDirectory;
  /** Trusted published anchor-authority certs (T140). */
  trustedCerts?: TrustedAnchorCertDirectory;
  verifier?: VerifierIdentity;
  reportId?: string;
  generatedAt?: string;
}

const DEFAULT_VERIFIER: VerifierIdentity = { type: 'independent_external' };

/**
 * Aggregate a per-segment anchor outcome (segment-prefixed offending ids; PASS iff
 * all segments PASS). Details from BOTH PASS and FAIL outcomes are surfaced, so the
 * token timestamp (gen_time / sth_time) is recorded in the report even on PASS.
 */
function aggregateAnchor(items: readonly { segId: string; outcome: CheckOutcome }[]): CheckOutcome {
  const offending: string[] = [];
  const details: string[] = [];
  let anyFail = false;
  for (const { segId, outcome } of items) {
    if (outcome.result === 'FAIL') {
      anyFail = true;
      for (const id of outcome.offending_ids) offending.push(`${segId}/${id}`);
    }
    if (outcome.details) details.push(`${segId}: ${outcome.details}`);
  }
  return {
    result: anyFail ? 'FAIL' : 'PASS',
    offending_ids: offending,
    ...(details.length > 0 ? { details: details.join(' | ') } : {}),
  };
}

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
 * Verify §10 steps 1-6 over parsed segments and emit a `verification-report-1.0`.
 * per_object_hash / object_chain / segment_manifest (steps 1-3) are recomputed
 * per segment; cross_segment_continuity / no_missing_segment / no_missing_event
 * (steps 4-6) are recomputed across the whole set (sorted by segment_sequence).
 * Each is PASS for a valid chain and FAIL with located offending ids on a
 * tamper/gap/genesis error. hsm_signature / anchor_token (T143) and
 * projection_consistency (T144) remain SKIPPED, so the overall result is
 * FAIL-CLOSED (never PASS while required checks remain SKIPPED — T140-M1).
 */
export function verifySegments(args: VerifySegmentsArgs): VerificationReport {
  const builder = new VerificationReportBuilder({
    db_id: args.db_id,
    verifier: args.verifier ?? DEFAULT_VERIFIER,
    scope: args.scope,
    ...(args.reportId !== undefined ? { reportId: args.reportId } : {}),
    ...(args.generatedAt !== undefined ? { generatedAt: args.generatedAt } : {}),
  });

  // Steps 1-3 (per-segment).
  addCheck(builder, 'per_object_hash', aggregate(args.segments, (r) => r.per_object_hash));
  addCheck(builder, 'object_chain', aggregate(args.segments, (r) => r.object_chain));
  addCheck(builder, 'segment_manifest', aggregate(args.segments, (r) => r.segment_manifest));
  // Steps 4-6 (across the segment set).
  addCheck(builder, 'cross_segment_continuity', recomputeCrossSegment(args.segments));
  addCheck(builder, 'no_missing_segment', recomputeNoMissingSegment(args.segments, args.scope));
  addCheck(builder, 'no_missing_event', recomputeNoMissingEvent(args.segments));

  // Steps 7-8 (T143): only when trusted published material is supplied; else SKIPPED (fail-closed overall).
  if (args.trustedKeys !== undefined && args.trustedCerts !== undefined) {
    const keys = args.trustedKeys;
    const certs = args.trustedCerts;
    const results = args.segments.map((seg) => ({ segId: seg.manifest.segment_id, ...verifyAnchorForSegment(seg, keys, certs) }));
    addCheck(builder, 'hsm_signature', aggregateAnchor(results.map((r) => ({ segId: r.segId, outcome: r.hsm_signature }))));
    addCheck(builder, 'anchor_token', aggregateAnchor(results.map((r) => ({ segId: r.segId, outcome: r.anchor_token }))));
  } else {
    builder.skip('hsm_signature');
    builder.skip('anchor_token');
  }

  // Deferred (T144): projection consistency stays advisory + SKIPPED.
  builder.skip('projection_consistency');

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
