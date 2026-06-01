// Conformance fixture schema + validator (Epic E4 / EDAM-T036).
//
// A fixture stores a complete NormalizedTransaction `input` and the PINNED
// deterministic golden values produced by the frozen CCE builder. PENDING is
// still accepted (with null golden values) and must never carry fabricated
// values, but Epic E4 pins all fixtures.

export type GoldenStatus = 'PINNED' | 'PENDING_CANONICAL';

export interface FixtureGolden {
  status: GoldenStatus;
  schema_version: string;
  envelope_id: string | null;
  event_hash: string | null;
  row_hash?: string | null;
}

export interface Fixture {
  fixture_id: string;
  description: string;
  conformance_refs: string[];
  sensitive_fields?: string[];
  input: Record<string, unknown>;
  golden: FixtureGolden;
}

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FixtureValidationError extends Error {}

function req(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new FixtureValidationError(msg);
}

export function validateFixture(value: unknown, ref = '<fixture>'): Fixture {
  req(typeof value === 'object' && value !== null, `${ref}: not an object`);
  const f = value as Record<string, unknown>;

  req(typeof f.fixture_id === 'string' && f.fixture_id.length > 0, `${ref}: fixture_id missing`);
  req(typeof f.description === 'string', `${ref}: description missing`);
  req(Array.isArray(f.conformance_refs) && f.conformance_refs.length > 0, `${ref}: conformance_refs must be non-empty`);
  if (f.sensitive_fields !== undefined) {
    req(Array.isArray(f.sensitive_fields), `${ref}: sensitive_fields must be an array`);
  }

  const input = f.input as Record<string, unknown> | undefined;
  req(!!input && typeof input === 'object', `${ref}: input missing`);
  req(!!input!.source && !!input!.transaction && Array.isArray(input!.changes), `${ref}: input must have source/transaction/changes`);

  const g = f.golden as Record<string, unknown> | undefined;
  req(!!g && (g.status === 'PINNED' || g.status === 'PENDING_CANONICAL'), `${ref}: golden.status invalid`);
  req(typeof g!.schema_version === 'string', `${ref}: golden.schema_version missing`);

  if (g!.status === 'PINNED') {
    req(typeof g!.envelope_id === 'string' && UUID_RE.test(g!.envelope_id as string), `${ref}: PINNED envelope_id must be a UUID`);
    req(typeof g!.event_hash === 'string' && SHA256_RE.test(g!.event_hash as string), `${ref}: PINNED event_hash must be sha256`);
    req(typeof g!.row_hash === 'string' && SHA256_RE.test(g!.row_hash as string), `${ref}: PINNED row_hash must be sha256`);
  } else {
    req(g!.envelope_id === null && g!.event_hash === null, `${ref}: PENDING fixtures must have null golden values (no fabrication)`);
  }

  return value as Fixture;
}
