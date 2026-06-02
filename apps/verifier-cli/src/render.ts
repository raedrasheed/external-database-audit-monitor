// Report rendering (EDAM-T146): human-readable + JSON (deliverables 9 & 10).
//
// Pure string producers (no console / process) so they are unit-testable. The
// human form prints the export-envelope outcome + a per-check table with located
// offending ids and flags the advisory projection check; the JSON form emits the
// verification-report-1.0 verbatim plus the envelope outcome.

import type { ExportVerificationResult } from './run-export.js';

const ADVISORY_CHECK = 'projection_consistency';

/** Machine-readable output: the §10 report verbatim + the export-envelope outcome. */
export function renderJson(result: ExportVerificationResult): string {
  return JSON.stringify(
    {
      package_id: result.package_id,
      db_id: result.db_id,
      export_signature: result.export_signature,
      report: result.report,
    },
    null,
    2,
  );
}

/** Human-readable output: header, envelope seal, per-check table, overall verdict. */
export function renderHuman(result: ExportVerificationResult): string {
  const lines: string[] = [];
  const { report, export_signature } = result;

  lines.push('EDAM Evidence Verification (offline, export mode)');
  lines.push(`  package_id : ${result.package_id}`);
  lines.push(`  db_id      : ${result.db_id}`);
  lines.push(`  scope      : segments ${report.scope.first_segment_sequence}..${report.scope.last_segment_sequence}`);
  lines.push('');

  const envSuffix = export_signature.details ? ` — ${export_signature.details}` : '';
  lines.push(`Export envelope signature: ${export_signature.result}${envSuffix}`);
  if (export_signature.result !== 'PASS' && export_signature.offending_ids.length > 0) {
    lines.push(`  offending: ${export_signature.offending_ids.join(', ')}`);
  }
  lines.push('');

  lines.push('§10 checks:');
  for (const c of report.checks) {
    const advisory = c.check === ADVISORY_CHECK ? ' (advisory)' : '';
    lines.push(`  [${c.result.padEnd(7)}] ${c.check}${advisory}`);
    if (c.result !== 'PASS' && c.details) lines.push(`            ${c.details}`);
    if (c.offending_ids && c.offending_ids.length > 0) lines.push(`            offending: ${c.offending_ids.join(', ')}`);
  }
  lines.push('');
  lines.push(`OVERALL: ${report.overall_result}${export_signature.result !== 'PASS' ? ' (export envelope FAILED)' : ''}`);

  return lines.join('\n');
}
