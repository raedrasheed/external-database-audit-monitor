// Golden-value verifier (Epic E4 / EDAM-T036).
//
// Rebuilds each fixture via the frozen CCE builder and checks the stored golden
// values still match (cross-machine determinism gate). `--check` exits non-zero
// on any mismatch or remaining PENDING fixture. Re-pinning is done by
// conformance/scripts/build-fixtures.ts.

import { loadFixtures } from '../fixtures/load.js';
import { buildCce, type NormalizedTransaction } from '@edam/cce-model';

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const fixtures = loadFixtures();
  let failures = 0;

  for (const f of fixtures) {
    if (f.golden.status !== 'PINNED') {
      process.stderr.write(`[pin] ${f.fixture_id}: still PENDING — run build-fixtures.ts\n`);
      failures += 1;
      continue;
    }
    const cce = buildCce(f.input as unknown as NormalizedTransaction, { sensitiveFields: f.sensitive_fields });
    const ok =
      cce.envelope_id === f.golden.envelope_id &&
      cce.evidence.event_hash === f.golden.event_hash &&
      cce.evidence.row_hash === f.golden.row_hash;
    if (!ok) {
      process.stderr.write(
        `[pin] ${f.fixture_id}: golden MISMATCH\n  expected ${f.golden.event_hash}\n  rebuilt  ${cce.evidence.event_hash}\n`,
      );
      failures += 1;
    } else {
      process.stdout.write(`[pin] ${f.fixture_id}: OK ${cce.evidence.event_hash}\n`);
    }
  }

  if (failures > 0) {
    process.stderr.write(`[pin] ${failures} fixture(s) failed verification.\n`);
    if (checkOnly) process.exitCode = 1;
    return;
  }
  process.stdout.write(`[pin] all ${fixtures.length} fixtures verified deterministic.\n`);
}

main();
