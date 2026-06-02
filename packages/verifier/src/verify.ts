// Verifier entrypoint (Sprint-2 / EDAM-T140 skeleton).
//
// Loads public inputs (WORM read port OR export package), establishes the report
// scope/db_id, and emits a schema-valid `verification-report-1.0`. The §10 checks
// are emitted as SKIPPED — the real recompute/verification logic lands in
// T141 (per-object/chain/manifest), T142 (continuity), T143 (HSM signature +
// anchor token), T144 (projection consistency + final report). This skeleton
// runs NO cryptographic verification and reads no bytes from the WORM port yet.
//
// A skeleton report (all checks SKIPPED) is a STRUCTURAL scaffold, NOT an
// integrity attestation.

import { VerificationReportBuilder, ALL_CHECKS, type VerificationReport, type VerifierIdentity } from './report.js';
import type { VerifierInput, VerificationScope } from './input.js';

export interface VerifyOptions {
  /** Verifier identity recorded in the report (default: independent_external). */
  verifier?: VerifierIdentity;
  /** Deterministic report id (default: random uuid). */
  reportId?: string;
  /** Deterministic report timestamp (default: now). */
  generatedAt?: string;
  /** Scope override for export-mode input (T141 will derive this from the parsed manifests). */
  scope?: VerificationScope;
}

const DEFAULT_VERIFIER: VerifierIdentity = { type: 'independent_external' };

/** Resolve db_id + scope from the input (worm-mode carries both; export-mode takes db_id from the package). */
function resolveContext(input: VerifierInput, opts: VerifyOptions): { db_id: string; scope: VerificationScope } {
  if (input.mode === 'worm') {
    return { db_id: input.dbId, scope: input.scope };
  }
  // export mode: db_id from the package; scope derivation from manifests is T141.
  return { db_id: input.package.db_id, scope: opts.scope ?? { first_segment_sequence: 0, last_segment_sequence: 0 } };
}

/**
 * Verify evidence from public inputs and return a `verification-report-1.0`.
 *
 * T140 SKELETON: validates the input shape and emits the report with every §10
 * check SKIPPED. It performs no cryptographic verification — that is T141-T144.
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
