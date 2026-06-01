// Conformance fixture types + runtime validator (Epic E7 / EDAM-T050).
//
// A fixture is a KNOWN input transaction plus its EXPECTED CCE change shape.
// Golden values (envelope_id / event_hash) are intentionally NOT computed here:
// computing them requires the canonical serializer (Epic E1) and CCE builder
// (Epic E4). Until then `golden.status` is "PENDING_CANONICAL" and the values
// are null. Fabricating golden hashes would violate INV-2 (no fabrication) and
// would poison the determinism gate, so it is forbidden.
//
// This module depends on NOTHING from Epic E1; it is a pure schema + validator.

export type GoldenStatus = 'PENDING_CANONICAL' | 'PINNED';

export interface FixtureFieldChange {
  path: string[];
  old: unknown;
  new: unknown;
  data_type: string;
  changed: boolean;
  sensitive: boolean;
  masked?: boolean;
}

export interface FixtureExpected {
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL' | 'TRUNCATE';
  object: { schema: string; name: string; primary_key?: Record<string, unknown> };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  field_changes?: FixtureFieldChange[];
}

export interface FixtureGolden {
  status: GoldenStatus;
  schema_version: string;
  envelope_id: string | null;
  event_hash: string | null;
}

export interface Fixture {
  fixture_id: string;
  description: string;
  conformance_refs: string[];
  source: { db_id: string; engine: string; server_uuid: string; schema: string };
  transaction: { tx_id: string; commit_ts: string };
  input_sql: string[];
  expected: FixtureExpected;
  golden: FixtureGolden;
}

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['INSERT', 'UPDATE', 'DELETE', 'DDL', 'TRUNCATE']);

export class FixtureValidationError extends Error {}

function req(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new FixtureValidationError(msg);
}

/** Validate an unknown value as a Fixture; throws FixtureValidationError on failure. */
export function validateFixture(value: unknown, ref = '<fixture>'): Fixture {
  req(typeof value === 'object' && value !== null, `${ref}: not an object`);
  const f = value as Record<string, unknown>;

  req(typeof f.fixture_id === 'string' && f.fixture_id.length > 0, `${ref}: fixture_id missing`);
  req(typeof f.description === 'string', `${ref}: description missing`);
  req(Array.isArray(f.conformance_refs) && f.conformance_refs.length > 0,
    `${ref}: conformance_refs must be a non-empty array`);
  req(Array.isArray(f.input_sql) && f.input_sql.length > 0,
    `${ref}: input_sql must be a non-empty array`);

  const src = f.source as Record<string, unknown> | undefined;
  req(!!src && typeof src.db_id === 'string' && typeof src.engine === 'string'
    && typeof src.server_uuid === 'string' && typeof src.schema === 'string',
    `${ref}: source incomplete`);

  const tx = f.transaction as Record<string, unknown> | undefined;
  req(!!tx && typeof tx.tx_id === 'string' && typeof tx.commit_ts === 'string',
    `${ref}: transaction incomplete`);

  const exp = f.expected as Record<string, unknown> | undefined;
  req(!!exp, `${ref}: expected missing`);
  req(typeof exp!.operation === 'string' && OPERATIONS.has(exp!.operation as string),
    `${ref}: expected.operation invalid`);
  const obj = exp!.object as Record<string, unknown> | undefined;
  req(!!obj && typeof obj.schema === 'string' && typeof obj.name === 'string',
    `${ref}: expected.object incomplete`);
  // before/after nullity per operation (CCE §5).
  const op = exp!.operation as string;
  if (op === 'INSERT') req(exp!.before === null, `${ref}: INSERT must have before=null`);
  if (op === 'DELETE') req(exp!.after === null, `${ref}: DELETE must have after=null`);

  const g = f.golden as Record<string, unknown> | undefined;
  req(!!g && (g.status === 'PENDING_CANONICAL' || g.status === 'PINNED'),
    `${ref}: golden.status invalid`);
  req(typeof g!.schema_version === 'string', `${ref}: golden.schema_version missing`);
  if (g!.status === 'PENDING_CANONICAL') {
    req(g!.envelope_id === null && g!.event_hash === null,
      `${ref}: PENDING_CANONICAL fixtures must have null golden values (no fabrication)`);
  } else {
    req(typeof g!.envelope_id === 'string' && UUID_RE.test(g!.envelope_id as string),
      `${ref}: PINNED golden.envelope_id must be a UUID`);
    req(typeof g!.event_hash === 'string' && SHA256_RE.test(g!.event_hash as string),
      `${ref}: PINNED golden.event_hash must be sha256:<64hex>`);
  }

  return value as Fixture;
}
