// Golden-value pinning harness (Epic E7 / EDAM-T050; harness aligned in E1).
//
// Pinning a fixture's golden values requires:
//   1. @edam/canonical (Epic E1)  -> deterministic envelope_id + hashing  [AVAILABLE]
//   2. the CCE Builder (Epic E4)  -> assembles the full CCE core whose canonical
//      serialization is hashed into event_hash (CCE §8)                    [NOT YET]
//
// `event_hash` is defined over the FULL CCE core (envelope minus `evidence`),
// not over a fixture's partial `expected` shape. Hashing the partial shape
// would NOT be the contract's event_hash — it would be a fabricated value,
// which is forbidden (INV-2). Therefore, until the CCE Builder (E4) exists,
// fixtures remain PENDING_CANONICAL and this harness pins nothing.
//
// `--check` asserts that no fixture has fabricated golden values.

import { loadFixtures } from '../fixtures/load.js';

interface CanonicalApi {
  serializeCanonical?: (value: unknown) => string;
  envelopeId?: (parts: { db_id: string; tx_id: string; server_uuid: string }) => string;
  eventHash?: (canonicalBytes: string) => string;
}

async function loadCanonical(): Promise<CanonicalApi | null> {
  try {
    const mod = await import('@edam/canonical');
    return mod as unknown as CanonicalApi;
  } catch {
    return null;
  }
}

// The CCE Builder (Epic E4) is required to assemble the full CCE core before a
// real event_hash can be computed. It does not exist yet, so pinning is gated.
function cceBuilderAvailable(): boolean {
  return false;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const fixtures = loadFixtures();
  const canonical = await loadCanonical();

  const fabricated = fixtures.filter(
    (f) =>
      f.golden.status === 'PENDING_CANONICAL' &&
      (f.golden.envelope_id !== null || f.golden.event_hash !== null),
  );
  if (fabricated.length > 0) {
    process.stderr.write(
      `[pin] FAIL: ${fabricated.length} fixture(s) carry golden values while marked ` +
        `PENDING_CANONICAL — fabrication is forbidden (INV-2).\n`,
    );
    process.exitCode = 1;
    return;
  }

  const canonicalReady = !!(canonical && canonical.serializeCanonical && canonical.envelopeId && canonical.eventHash);
  process.stdout.write(
    `[pin] fixtures: ${fixtures.length} | @edam/canonical: ${canonicalReady ? 'ready' : 'absent'} | ` +
      `CCE builder (E4): ${cceBuilderAvailable() ? 'ready' : 'absent'}\n`,
  );

  if (!cceBuilderAvailable()) {
    process.stdout.write(
      '[pin] Golden values remain PENDING_CANONICAL: event_hash requires the full CCE ' +
        'core from the CCE Builder (Epic E4). No fabrication (INV-2).\n',
    );
    if (checkOnly) process.stdout.write('[pin] --check OK: no fabricated golden values.\n');
    return;
  }

  // (Activated once Epic E4 lands: assemble the full CCE core via the builder,
  // then envelope_id = canonical.envelopeId(...) and
  // event_hash = canonical.eventHash(canonical.serializeCanonical(core)).)
  process.stdout.write('[pin] CCE builder present — pinning path would run here.\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
