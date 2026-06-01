// Golden-value pinning harness (Epic E7 / EDAM-T050).
//
// Pins deterministic `envelope_id` / `event_hash` for each fixture so they
// become the immutable expected outputs of the determinism gate (CCE C-1/C-6).
//
// Computing golden values REQUIRES the canonical serializer (Epic E1,
// `@edam/canonical`) and the CCE builder (Epic E4). Neither is implemented yet,
// and this harness MUST NOT fabricate hashes (INV-2). Therefore:
//   - If @edam/canonical is absent  -> report PENDING and exit 0 (expected
//     pre-E1 state). Use `--check` in CI to assert nothing was fabricated.
//   - If @edam/canonical is present -> compute + write golden values, set
//     status PINNED. (Wired here; activated once E1/E4 land.)
//
// This script does NOT implement any Epic E1 logic; it only consumes it.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixtures, TRANSACTIONS_DIR } from '../fixtures/load.js';

interface CanonicalApi {
  // Anticipated Epic E1 surface. Verified at runtime before use.
  serializeCanonical?: (value: unknown) => string;
  eventHash?: (canonicalBytes: string) => string;
  envelopeId?: (parts: { db_id: string; tx_id: string; server_uuid: string }) => string;
}

async function loadCanonical(): Promise<CanonicalApi | null> {
  try {
    // @ts-expect-error - @edam/canonical is introduced in Epic E1 (not yet present).
    const mod = (await import('@edam/canonical')) as CanonicalApi;
    return mod;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const fixtures = loadFixtures();
  const canonical = await loadCanonical();

  if (!canonical || !canonical.serializeCanonical || !canonical.eventHash || !canonical.envelopeId) {
    const pending = fixtures.filter((f) => f.golden.status === 'PENDING_CANONICAL').length;
    const fabricated = fixtures.filter(
      (f) => f.golden.status === 'PENDING_CANONICAL' &&
        (f.golden.envelope_id !== null || f.golden.event_hash !== null),
    );
    process.stdout.write(
      `[pin] @edam/canonical (Epic E1) not available — golden values remain PENDING.\n` +
      `[pin] fixtures: ${fixtures.length}, pending: ${pending}.\n`,
    );
    if (fabricated.length > 0) {
      process.stderr.write(
        `[pin] FAIL: ${fabricated.length} fixture(s) carry golden values while marked ` +
        `PENDING_CANONICAL — fabrication is forbidden (INV-2).\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (checkOnly) {
      process.stdout.write('[pin] --check OK: no fabricated golden values.\n');
    } else {
      process.stdout.write('[pin] Re-run after Epic E1 (canonical) + E4 (CCE builder) to pin.\n');
    }
    return;
  }

  // --- Activated once Epic E1/E4 are present ---
  for (const f of fixtures) {
    const envelopeId = canonical.envelopeId({
      db_id: f.source.db_id,
      tx_id: f.transaction.tx_id,
      server_uuid: f.source.server_uuid,
    });
    // NOTE: the full CCE core assembly belongs to the CCE builder (Epic E4);
    // this harness will hash the builder's output rather than re-deriving it.
    const eventHash = canonical.eventHash(canonical.serializeCanonical(f.expected));
    f.golden = { status: 'PINNED', schema_version: f.golden.schema_version, envelope_id: envelopeId, event_hash: eventHash };
    if (!checkOnly) {
      writeFileSync(
        join(TRANSACTIONS_DIR, `${f.fixture_id}.json`),
        JSON.stringify(f, null, 2) + '\n',
        'utf8',
      );
    }
  }
  process.stdout.write(`[pin] pinned ${fixtures.length} fixture(s).\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
