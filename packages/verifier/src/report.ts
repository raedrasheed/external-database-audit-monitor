// Verification report scaffold + builder (Sprint-2 / EDAM-T140 skeleton).
//
// Emits a `verification-report-1.0` (WORM §16.4): per-check PASS/FAIL/SKIPPED with
// offending ids. The builder accumulates checks and computes the overall result;
// `build()` validates against the vendored schema (fail-closed on a malformed
// report). The actual checks are filled in by T141-T144; T140 only ships the
// scaffold (skeleton reports emit all §10 checks as SKIPPED).

import { randomUUID } from 'node:crypto';
import { validateVerificationReport } from '@edam/contracts';
import type { VerificationScope } from './input.js';

/** The §10 verification checks (verification-report-1.0 enum). */
export type CheckName =
  | 'per_object_hash'
  | 'object_chain'
  | 'segment_manifest'
  | 'cross_segment_continuity'
  | 'no_missing_segment'
  | 'no_missing_event'
  | 'hsm_signature'
  | 'anchor_token'
  | 'projection_consistency';

export type CheckResult = 'PASS' | 'FAIL' | 'SKIPPED';

export interface VerificationCheck {
  check: CheckName;
  result: CheckResult;
  details?: string;
  offending_ids?: string[];
}

export interface VerifierIdentity {
  type: 'edam_daily' | 'independent_external';
  identity?: string;
}

export interface VerificationReport {
  report_version: 'verification-report-1.0';
  report_id: string;
  db_id: string;
  verifier: VerifierIdentity;
  scope: VerificationScope;
  generated_at: string;
  overall_result: 'PASS' | 'FAIL';
  checks: VerificationCheck[];
  report_signature?: string | null;
}

/** The §10 checks in canonical order — the full set a complete run reports. */
export const ALL_CHECKS: readonly CheckName[] = [
  'per_object_hash',
  'object_chain',
  'segment_manifest',
  'cross_segment_continuity',
  'no_missing_segment',
  'no_missing_event',
  'hsm_signature',
  'anchor_token',
  'projection_consistency',
];

/** Raised when an assembled report fails `verification-report-1.0` validation. */
export class VerificationReportError extends Error {
  constructor(public readonly errors: unknown) {
    super(`verification report failed verification-report-1.0 validation: ${JSON.stringify(errors)}`);
    this.name = 'VerificationReportError';
  }
}

export interface VerificationReportInit {
  db_id: string;
  verifier: VerifierIdentity;
  scope: VerificationScope;
  reportId?: string;
  generatedAt?: string;
}

/**
 * Accumulates per-check results and assembles a schema-valid
 * `verification-report-1.0`. `overall_result` is FAIL iff any check is FAIL,
 * else PASS (SKIPPED does not fail). A report whose checks are ALL SKIPPED is a
 * structural scaffold — NOT an integrity attestation (the real checks land in
 * T141-T144).
 */
export class VerificationReportBuilder {
  readonly #init: VerificationReportInit;
  readonly #checks: VerificationCheck[] = [];

  constructor(init: VerificationReportInit) {
    this.#init = init;
  }

  /** Append a check result. */
  add(check: VerificationCheck): this {
    this.#checks.push({
      check: check.check,
      result: check.result,
      ...(check.details !== undefined ? { details: check.details } : {}),
      ...(check.offending_ids !== undefined ? { offending_ids: [...check.offending_ids] } : {}),
    });
    return this;
  }

  /** Mark a check SKIPPED (not yet implemented / out of the current run). */
  skip(check: CheckName, details = 'not implemented in the T140 skeleton'): this {
    return this.add({ check, result: 'SKIPPED', details });
  }

  /** Build + schema-validate the report. Throws `VerificationReportError` if invalid. */
  build(): VerificationReport {
    const overall_result: 'PASS' | 'FAIL' = this.#checks.some((c) => c.result === 'FAIL') ? 'FAIL' : 'PASS';
    const report: VerificationReport = {
      report_version: 'verification-report-1.0',
      report_id: this.#init.reportId ?? randomUUID(),
      db_id: this.#init.db_id,
      verifier: this.#init.verifier,
      scope: this.#init.scope,
      generated_at: this.#init.generatedAt ?? new Date().toISOString(),
      overall_result,
      checks: this.#checks,
      report_signature: null,
    };
    const result = validateVerificationReport(report);
    if (!result.valid) throw new VerificationReportError(result.errors);
    return report;
  }
}
