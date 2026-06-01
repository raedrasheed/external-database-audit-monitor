// Determinism rig (Epic E6 / EDAM-T041, audit mandate A).
//
// Rebuilds every conformance fixture via the frozen builder and prints a STABLE
// artifact of {envelope_id, event_hash, row_hash} per fixture plus a canonical-
// serializer probe. Run on each CI target (ubuntu x86_64, macos arm64); a
// gating job byte-compares the `results`+`probe` across targets. Also self-
// checks each rebuild against the committed golden and exits non-zero on any
// mismatch.
//
//   npx tsx conformance/scripts/determinism-rig.ts > determinism-<os>.json

import { loadFixtures } from '../fixtures/load.js';
import { buildCce, type NormalizedTransaction } from '@edam/cce-model';
import { serializeCanonical, sha256Hex } from '@edam/canonical';

// A fixed probe value exercising key ordering, decimals-as-strings, nesting,
// unicode and nulls — drift here means the serializer is non-deterministic.
const PROBE = {
  z: null,
  a: { 'é': 1, b: [3, 2, 1], amount: '100.00' },
  m: true,
  id: 90211,
};

function main(): void {
  const fixtures = loadFixtures();
  const results: Record<string, { envelope_id: string; event_hash: string; row_hash: string }> = {};
  let mismatches = 0;

  for (const f of fixtures) {
    const cce = buildCce(f.input as unknown as NormalizedTransaction, { sensitiveFields: f.sensitive_fields });
    results[f.fixture_id] = {
      envelope_id: cce.envelope_id,
      event_hash: cce.evidence.event_hash,
      row_hash: cce.evidence.row_hash,
    };
    if (
      f.golden.status === 'PINNED' &&
      (cce.envelope_id !== f.golden.envelope_id ||
        cce.evidence.event_hash !== f.golden.event_hash ||
        cce.evidence.row_hash !== f.golden.row_hash)
    ) {
      mismatches += 1;
      process.stderr.write(`[rig] ${f.fixture_id}: rebuilt values differ from committed golden\n`);
    }
  }

  const canonical = serializeCanonical(PROBE);
  const artifact = {
    results,
    probe: { canonical, sha256: 'sha256:' + sha256Hex(canonical) },
    meta: { os: process.platform, arch: process.arch, node: process.version },
  };
  process.stdout.write(JSON.stringify(artifact, null, 2) + '\n');

  if (mismatches > 0) {
    process.stderr.write(`[rig] ${mismatches} fixture(s) diverged from golden — determinism broken.\n`);
    process.exitCode = 1;
  }
}

main();
