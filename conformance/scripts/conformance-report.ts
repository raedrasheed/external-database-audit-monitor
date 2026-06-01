// Conformance report (Epic E6 / EDAM-T042..T046, mandate B).
// Runs the suite, writes a traceability report artifact, and exits non-zero if
// any case fails.
//
//   npx tsx conformance/scripts/conformance-report.ts

import { writeFileSync } from 'node:fs';
import { runConformance } from '../suite/run.js';

function main(): void {
  const results = runConformance();
  const report = {
    suite: 'cce-conformance',
    generated_at: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    cases: results,
  };
  writeFileSync('conformance-report.json', JSON.stringify(report, null, 2) + '\n', 'utf8');

  for (const r of results) {
    process.stdout.write(`[conformance] ${r.passed ? 'PASS' : 'FAIL'} ${r.id} ${r.title} <${r.spec_ref}>\n`);
    if (!r.passed) process.stderr.write(`  ${r.detail}\n`);
  }
  process.stdout.write(`[conformance] ${report.passed}/${report.total} passed.\n`);
  if (report.failed > 0) process.exitCode = 1;
}

main();
