// Secret-hygiene gate CLI (Epic E8 / EDAM-T053). --check fails CI; --report
// writes the proof artifact.

import { verifySecretHygiene, writeProofFile } from '../security/secret-hygiene.js';

function main(): void {
  const checkOnly = process.argv.includes('--check');
  if (process.argv.includes('--report')) writeProofFile();
  const proof = verifySecretHygiene();
  if (proof.ok) {
    process.stdout.write(`[secret-hygiene] OK: scanned ${proof.scanned.runtime_source} source files; no secret/PII leakage.\n`);
    return;
  }
  for (const v of proof.violations) process.stderr.write(`[secret-hygiene] ${v.rule} ${v.file}: ${v.detail}\n`);
  process.stderr.write(`[secret-hygiene] ${proof.violations.length} violation(s).\n`);
  if (checkOnly) process.exitCode = 1;
}

main();
