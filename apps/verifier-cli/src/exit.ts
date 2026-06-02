// Exit-code policy (EDAM-T146, Q6).
//
//   0 = PASS              (§10 overall PASS AND export envelope signature PASS)
//   1 = integrity failure (§10 overall FAIL, or export signature FAIL)
//   2 = usage / parse / schema error (handled by the caller via thrown errors)
//
// Projection drift NEVER changes the exit code: `projection_consistency` is
// advisory and is already excluded from the report's fail-closed overall result
// (REQUIRED_CHECKS), so an advisory drift FAIL leaves `overall_result` PASS.

import type { ExportVerificationResult } from './run-export.js';

export const EXIT_PASS = 0;
export const EXIT_INTEGRITY_FAIL = 1;
export const EXIT_USAGE_ERROR = 2;

/** Exit 0 only when both the §10 report and the export envelope seal PASS; else 1. */
export function exitCodeFor(result: ExportVerificationResult): typeof EXIT_PASS | typeof EXIT_INTEGRITY_FAIL {
  if (result.export_signature.result !== 'PASS') return EXIT_INTEGRITY_FAIL;
  if (result.report.overall_result !== 'PASS') return EXIT_INTEGRITY_FAIL;
  return EXIT_PASS;
}
