// CCE builder (Epic E4 / EDAM-T031..T036).
//
// Assembles a frozen CCE v1 from a NormalizedTransaction: per-change diff +
// masking, contiguous seq, statement_count, deterministic envelope_id (UUIDv5),
// event_hash + row_hash (over the canonical core, excluding evidence), then
// validates the result against the frozen contracts (V1..V13). Determinism and
// hashing come ONLY from @edam/canonical. Throws CceBuildError on invalid
// output so the caller routes the event to the DLQ (never fabricates a CCE).

import {
  serializeCanonical,
  eventHash,
  rowHash,
  GENESIS_ROW_HASH,
  envelopeId,
} from '@edam/canonical';
import { validateCceFull, type ValidationError } from '@edam/contracts';
import { diffFields } from './diff.js';
import { maskImage, maskFieldChanges } from './mask.js';
import type {
  Cce,
  CceChangeItem,
  NormalizedActor,
  NormalizedCompleteness,
  NormalizedFidelity,
  NormalizedTransaction,
} from './types.js';

// The frozen CCE schema types source_config fields as (non-nullable) strings,
// so null/absent optional values must be OMITTED — never emitted as null. We
// represent unknowns honestly by omission (the fidelity.state + degraded_reason
// carry the "why"), not by inventing values.
function buildSourceConfig(sc: NormalizedFidelity['source_config']): Record<string, unknown> {
  const out: Record<string, unknown> = { config_snapshot_id: sc.config_snapshot_id };
  for (const k of ['binlog_format', 'binlog_row_image', 'gtid_mode', 'replica_identity', 'log_bin'] as const) {
    if (sc[k] !== null && sc[k] !== undefined) out[k] = sc[k];
  }
  return out;
}

function buildFidelity(f: NormalizedFidelity): Record<string, unknown> {
  const out: Record<string, unknown> = { state: f.state, source_config: buildSourceConfig(f.source_config) };
  if (f.notes && f.notes.length) out.notes = f.notes;
  if (f.state !== 'HEALTHY') out.degraded_reason = f.degraded_reason ?? 'fidelity degraded';
  return out;
}

function buildCompleteness(c: NormalizedCompleteness): Record<string, unknown> {
  const out: Record<string, unknown> = {
    consumed_offset_key: c.consumed_offset_key,
    gap_detected: c.gap_detected,
  };
  if (c.consumed_gtid_set !== undefined) out.consumed_gtid_set = c.consumed_gtid_set;
  if (c.heartbeat_ts !== undefined) out.heartbeat_ts = c.heartbeat_ts;
  if (c.snapshot_phase !== undefined) out.snapshot_phase = c.snapshot_phase;
  // Snapshot identity / coverage (CCE-AMD-001 Rev 4). Emitted only when present
  // so existing cce-1.0 streaming events serialize byte-unchanged.
  if (c.snapshot_epoch_id !== undefined) out.snapshot_epoch_id = c.snapshot_epoch_id;
  if (c.snapshot_coverage !== undefined) out.snapshot_coverage = c.snapshot_coverage;
  return out;
}

const REAL_OFFSET_KEYS = ['gtid', 'lsn', 'scn', 'resume_token'] as const;

/**
 * Authoritative schema version (CCE-AMD-001 Rev 4): an offset with a non-empty
 * real engine key is a streaming/log event => `cce-1.0` (byte-unchanged); a
 * binlog-only offset is a snapshot read => `cce-1.1`. This is the exact same
 * predicate the V16 schema guard uses, so the version and the offset shape can
 * never disagree.
 */
function cceSchemaVersion(offset: NormalizedTransaction['offset']): 'cce-1.0' | 'cce-1.1' {
  const hasRealKey = REAL_OFFSET_KEYS.some((k) => {
    const v = offset[k];
    return typeof v === 'string' && v.length > 0;
  });
  return hasRealKey ? 'cce-1.0' : 'cce-1.1';
}

function buildActor(a: NormalizedActor): Record<string, unknown> {
  const out: Record<string, unknown> = { attribution_confidence: a.attribution_confidence };
  for (const k of ['db_user', 'client_host', 'connection_id', 'application_name'] as const) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  if (a.audit_event_ref !== undefined) out.audit_event_ref = a.audit_event_ref;
  if (a.correlation_basis !== undefined) out.correlation_basis = a.correlation_basis;
  return out;
}

export class CceBuildError extends Error {
  constructor(
    message: string,
    readonly errors: ValidationError[] = [],
  ) {
    super(message);
    this.name = 'CceBuildError';
  }
}

export interface BuildOptions {
  /** Sensitive column identifiers (schema.table.col / table.col / col). */
  sensitiveFields?: string[];
  /** Previous row_hash for the chain link; genesis if omitted. */
  prevRowHash?: string | null;
  /** Size-split part index (CCE §12.5); omit for a whole-transaction envelope. */
  part?: number | string;
}

/** Derive the deterministic envelope_id for a transaction (CCE §3). */
export function deriveEnvelopeId(
  input: Pick<NormalizedTransaction, 'source' | 'transaction'>,
  part?: number | string,
): string {
  return envelopeId({
    db_id: input.source.db_id,
    tx_id: input.transaction.tx_id,
    server_uuid: input.source.server_uuid,
    ...(part !== undefined ? { part } : {}),
  });
}

export function buildCce(input: NormalizedTransaction, opts: BuildOptions = {}): Cce {
  const sensitive = new Set(opts.sensitiveFields ?? []);

  const changes: CceChangeItem[] = input.changes.map((change, seq) => {
    const { schema, name } = change.object;
    // Diff from UNMASKED images (correct data_type), then mask.
    const fieldChanges = maskFieldChanges(diffFields(change), schema, name, sensitive);
    const item: CceChangeItem = {
      seq,
      operation: change.operation,
      object: change.object,
      before: maskImage(change.before, schema, name, sensitive),
      after: maskImage(change.after, schema, name, sensitive),
      ...(fieldChanges ? { field_changes: fieldChanges } : {}),
      ...(change.ddl ? { ddl: change.ddl } : {}),
    };
    return item;
  });

  const envelope_id = deriveEnvelopeId(input, opts.part);

  // The CCE core = envelope minus `evidence` (CCE §8). event_hash is over its
  // canonical serialization.
  const core = {
    schema_version: cceSchemaVersion(input.offset),
    envelope_id,
    kind: 'transaction' as const,
    source: input.source,
    transaction: {
      tx_id: input.transaction.tx_id,
      commit_ts: input.transaction.commit_ts,
      ingest_ts: input.transaction.ingest_ts,
      statement_count: changes.length,
    },
    offset: input.offset,
    fidelity: buildFidelity(input.fidelity),
    completeness: buildCompleteness(input.completeness),
    actor: buildActor(input.actor),
    changes,
  };

  const event_hash = eventHash(serializeCanonical(core));
  const prev_row_hash = opts.prevRowHash ?? GENESIS_ROW_HASH;
  const row_hash = rowHash(prev_row_hash, event_hash);

  const cce = { ...core, evidence: { event_hash, prev_row_hash, row_hash } } as unknown as Cce;

  const result = validateCceFull(cce);
  if (!result.valid) {
    throw new CceBuildError(
      `built CCE failed validation: ${result.errors.map((e) => `${e.rule}@${e.instancePath}`).join(', ')}`,
      result.errors,
    );
  }
  return cce;
}
