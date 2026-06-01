// Native CDC -> normalized event mapping (Epic E4 / EDAM-T025, EDAM-T027).
//
// Maps a CAPTURED record (CDC Collector interface I1) into a NormalizedChangeEvent
// (source/transaction/offset/operation/before/after). Engine-agnostic over the
// Debezium value (MySQL & MariaDB share the format); GTID/offset come from the
// CAPTURED record (already engine-correct per E2 adapters). Malformed events
// throw NormalizationError so the caller routes them to the DLQ — never dropped.

import type {
  CceOffset,
  NormalizedChange,
  NormalizedChangeEvent,
  Operation,
  SnapshotPhase,
} from '@edam/cce-model';

/** CDC Collector output (interface I1). Defined locally to avoid cross-service coupling. */
export interface CapturedRecord {
  raw_native: unknown;
  source: { db_id: string; engine: string; server_uuid: string; schema: string; table: string };
  offset: { gtid: string | null; binlog_file: string | null; binlog_pos: number | null };
  captured_at: string;
}

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizationError';
  }
}

/** Resolve the primary-key column names for a table (from monitored_tables config). */
export type PrimaryKeyResolver = (schema: string, table: string) => string[];

function unwrap(value: unknown): any {
  if (value && typeof value === 'object' && 'payload' in (value as any) && 'schema' in (value as any)) {
    return (value as any).payload;
  }
  return value;
}

function mapOperation(op: unknown, source: any): Operation {
  switch (op) {
    case 'c':
    case 'r': // snapshot read = existing row materialized as an INSERT
      return 'INSERT';
    case 'u':
      return 'UPDATE';
    case 'd':
      return 'DELETE';
    case 't':
      return 'TRUNCATE';
    default:
      // DDL events carry a ddl payload and no row op.
      if (source && typeof source.ddl === 'string') return 'DDL';
      throw new NormalizationError(`unsupported or missing CDC op: ${JSON.stringify(op)}`);
  }
}

function extractPrimaryKey(
  cols: string[],
  image: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!image || cols.length === 0) return undefined;
  const pk: Record<string, unknown> = {};
  for (const c of cols) {
    if (!(c in image)) return undefined; // pk column missing -> let validation (V6) flag it
    pk[c] = image[c];
  }
  return pk;
}

export function mapCapturedRecord(
  record: CapturedRecord,
  pkResolver: PrimaryKeyResolver,
): NormalizedChangeEvent {
  const value = unwrap(record.raw_native);
  if (!value || typeof value !== 'object') {
    throw new NormalizationError('malformed CDC event: value is not an object');
  }
  const src = value.source ?? {};
  const table = String(src.table ?? record.source.table ?? '');
  if (!table && value.op !== undefined && !src.ddl) {
    throw new NormalizationError('malformed CDC event: missing source.table');
  }

  const operation = mapOperation(value.op, src);

  const before = (value.before ?? null) as Record<string, unknown> | null;
  const after = (value.after ?? null) as Record<string, unknown> | null;

  const pkCols = pkResolver(record.source.schema, table);
  // Identity key: the row as it exists for the operation — `before` for
  // UPDATE/DELETE (handles primary-key changes), `after` for INSERT.
  const pkImage = operation === 'INSERT' ? after : before;
  const primary_key =
    operation === 'DDL' || operation === 'TRUNCATE' ? undefined : extractPrimaryKey(pkCols, pkImage);

  const change: NormalizedChange = {
    operation,
    object: { schema: record.source.schema, name: table, ...(primary_key ? { primary_key } : {}) },
    // Nullity per CCE §5 (enforced fully in T027/build): INSERT before=null, DELETE after=null.
    before: operation === 'INSERT' ? null : before,
    after: operation === 'DELETE' || operation === 'TRUNCATE' || operation === 'DDL' ? null : after,
    ...(operation === 'DDL' ? { ddl: { statement: String(src.ddl ?? value.ddl ?? '') } } : {}),
  };

  const commitTsMs = typeof src.ts_ms === 'number' ? src.ts_ms : null;
  const offset: CceOffset = {
    gtid: record.offset.gtid,
    binlog_file: record.offset.binlog_file,
    binlog_pos: record.offset.binlog_pos,
    lsn: null,
    scn: null,
    resume_token: null,
  };
  const snapshot = src.snapshot;
  const snapshot_phase: SnapshotPhase =
    snapshot === undefined || snapshot === false || snapshot === 'false'
      ? 'streaming'
      : snapshot === 'last' || snapshot === 'last_in_data_collection'
        ? 'handoff'
        : 'snapshot';

  return {
    source: {
      db_id: record.source.db_id,
      engine: record.source.engine,
      server_uuid: record.source.server_uuid,
      schema: record.source.schema,
      ...(src.version ? { engine_version: String(src.version) } : {}),
    },
    tx_id: record.offset.gtid,
    commit_ts: commitTsMs !== null ? new Date(commitTsMs).toISOString() : null,
    ingest_ts: record.captured_at,
    offset,
    snapshot_phase,
    change,
  };
}
