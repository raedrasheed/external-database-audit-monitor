// evidence-conformance gate CLI (EDAM-T148). Runs the WV-1…WV-14 conformance
// suite against the real implementations, writes a traceability proof artifact,
// and exits non-zero if ANY case fails OR if the suite is incomplete (non-vacuous
// guard: all 14 WV ids must be present and run).
//
//   npm run evidence-conformance -- --check --report

import { writeFileSync } from 'node:fs';
import { runWvConformance } from '../wv/run.js';
import { REQUIRED_WV_IDS } from '../wv/types.js';

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const report = process.argv.includes('--report');

  const results = await runWvConformance();
  const ran = new Set(results.map((r) => r.id));
  const missing = REQUIRED_WV_IDS.filter((id) => !ran.has(id));
  const passed = results.filter((r) => r.passed).length;
  const ok = missing.length === 0 && results.every((r) => r.passed);

  const proof = {
    suite: 'wv-conformance',
    generated_at: new Date().toISOString(),
    ok,
    total: results.length,
    passed,
    failed: results.length - passed,
    missing,
    cases: results,
  };
  if (report) writeFileSync('evidence-conformance-report.json', JSON.stringify(proof, null, 2) + '\n', 'utf8');

  for (const r of results) {
    process.stdout.write(`[evidence-conformance] ${r.passed ? 'PASS' : 'FAIL'} ${r.id} ${r.title} <${r.spec_ref}>\n`);
    if (!r.passed) process.stderr.write(`  ${r.detail}\n`);
  }
  if (missing.length > 0) process.stderr.write(`[evidence-conformance] MISSING WV cases: ${missing.join(', ')}\n`);
  process.stdout.write(`[evidence-conformance] ${passed}/${results.length} WV cases passed${ok ? ' — WV-1…WV-14 green.' : '.'}\n`);

  if (!ok && checkOnly) process.exitCode = 1;
}

void main();
