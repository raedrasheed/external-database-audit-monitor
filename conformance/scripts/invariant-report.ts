// Honesty invariant report (Epic E8 / EDAM-T054). Runs the invariant suite,
// writes a report artifact, and exits non-zero if any invariant is violated.
//
//   npx tsx conformance/scripts/invariant-report.ts [--check]

import { writeFileSync } from 'node:fs';
import { runInvariants } from '../security/invariants.js';

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const results = await runInvariants();
  const report = {
    suite: 'honesty-invariants',
    generated_at: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    invariants: results,
  };
  writeFileSync('invariant-report.json', JSON.stringify(report, null, 2) + '\n', 'utf8');

  for (const r of results) {
    process.stdout.write(`[invariant] ${r.passed ? 'HOLDS' : 'VIOLATED'} ${r.id} — ${r.description} <${r.spec_ref}>\n`);
    if (!r.passed) process.stderr.write(`  ${r.detail}\n`);
  }
  process.stdout.write(`[invariant] ${report.passed}/${report.total} invariants hold.\n`);
  if (report.failed > 0 && checkOnly) process.exitCode = 1;
}

main();
