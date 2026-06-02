// Signing-key-hygiene gate CLI (Epic E2C-S2 / EDAM-T124). --check fails CI;
// --report writes the proof artifact.

import { verifySigningKeyHygiene, writeProofFile } from '../security/signing-key-hygiene.js';

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  if (process.argv.includes('--report')) await writeProofFile();
  const proof = await verifySigningKeyHygiene();
  if (proof.ok) {
    process.stdout.write(
      `[signing-key-hygiene] OK (INV-EV-4): scanned ${proof.scanned.runtime_source} source + ${proof.scanned.env_compose} env/compose file(s); ` +
        `probed ${proof.scanned.signers_probed} signer/registry surfaces; no private key material crosses the public API. Positive controls fired.\n`,
    );
    return;
  }
  for (const v of proof.violations) process.stderr.write(`[signing-key-hygiene] ${v.rule} ${v.file}: ${v.detail}\n`);
  if (!proof.positive_control.static_detected) process.stderr.write('[signing-key-hygiene] positive control NOT detected (static scanner failed)\n');
  if (!proof.positive_control.runtime_detected) process.stderr.write('[signing-key-hygiene] positive control NOT detected (runtime leakage detector failed)\n');
  process.stderr.write(`[signing-key-hygiene] ${proof.violations.length} violation(s).\n`);
  if (checkOnly) process.exitCode = 1;
}

void main();
