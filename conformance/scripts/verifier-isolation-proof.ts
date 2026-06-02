// verifier-isolation-proof gate CLI (Sprint-2 / EDAM-T147). --check fails CI on
// any forbidden import; --report writes the proof artifact. Statically proves
// WV-12 / INV-EV-5 / A-EV7: packages/verifier imports only the pure, public-
// inputs-only allow-list (no EDAM service/secret/DB). Scope is strictly
// packages/verifier — apps/verifier-cli is intentionally not scanned.

import { verifyVerifierIsolation, writeProofFile } from '../security/verifier-isolation.js';

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const report = process.argv.includes('--report');

  const proof = report ? writeProofFile() : verifyVerifierIsolation();

  if (proof.ok) {
    process.stdout.write(
      `[verifier-isolation-proof] OK (WV-12 / INV-EV-5): scanned ${proof.scanned.source_files} verifier source file(s) + ` +
        `${proof.scanned.manifest} manifest; imports stay within the allow-list [${proof.allow_list.join(', ')}].\n`,
    );
    return;
  }
  for (const v of proof.violations) process.stderr.write(`[verifier-isolation-proof] ${v.rule} ${v.file}: ${v.detail}\n`);
  process.stderr.write(`[verifier-isolation-proof] ${proof.violations.length} violation(s) — verifier isolation (WV-12 / INV-EV-5) at risk.\n`);
  if (checkOnly) process.exitCode = 1;
}

main();
