// CCE model + internal normalized model (Epic E4).
//
// The internal NormalizedTransaction is the engine-agnostic input to the
// builder; the Cce is the frozen CCE v1 output. No field is fabricated: every
// value comes from the source event, the attestation/completeness records, or
// the attribution feed — or is represented honestly (null / unattributed /
// DEGRADED).

export type Operation = 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL' | 'TRUNCATE';
export type FidelityState = 'HEALTHY' | 'DEGRADED' | 'COMPROMISED';
export type SnapshotPhase = 'snapshot' | 'handoff' | 'streaming';
export type AttributionConfidence = 'exact' | 'probable' | 'unattributed';

export interface NormalizedObject {
  schema: string;
  name: string;
  primary_key?: Record<string, unknown>;
}

export interface NormalizedChange {
  operation: Operation;
  object: NormalizedObject;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ddl?: { statement: string; effect?: string };
}

/** One mapped source event before it is grouped into a transaction. */
export interface NormalizedChangeEvent {
  source: {
    db_id: string;
    engine: string;
    server_uuid: string;
    schema: string;
    engine_version?: string;
  };
  tx_id: string | null;
  commit_ts: string | null;
  ingest_ts: string;
  offset: CceOffset;
  snapshot_phase: SnapshotPhase;
  change: NormalizedChange;
}

export interface CceOffset {
  gtid?: string | null;
  binlog_file?: string | null;
  binlog_pos?: number | null;
  lsn?: string | null;
  scn?: string | null;
  resume_token?: string | null;
}

export interface NormalizedFidelity {
  state: FidelityState;
  source_config: {
    binlog_format: string | null;
    binlog_row_image: string | null;
    gtid_mode: string | null;
    replica_identity: string | null;
    log_bin: string | null;
    config_snapshot_id: string;
  };
  notes?: string[];
  degraded_reason?: string | null;
}

export interface NormalizedCompleteness {
  consumed_offset_key: string;
  consumed_gtid_set?: string;
  heartbeat_ts?: string;
  gap_detected: boolean;
  snapshot_phase?: SnapshotPhase;
}

export interface NormalizedActor {
  db_user?: string | null;
  client_host?: string | null;
  connection_id?: string | null;
  application_name?: string | null;
  attribution_confidence: AttributionConfidence;
  audit_event_ref?: string;
  correlation_basis?: string[];
}

export interface NormalizedTransaction {
  source: {
    db_id: string;
    engine: string;
    server_uuid: string;
    schema: string;
    engine_version?: string;
  };
  transaction: { tx_id: string; commit_ts: string; ingest_ts: string };
  offset: CceOffset;
  fidelity: NormalizedFidelity;
  completeness: NormalizedCompleteness;
  actor: NormalizedActor;
  /** Ordered changes for this source transaction. */
  changes: NormalizedChange[];
}

// --- CCE v1 output shape (validated against the frozen schema at build) ---

export interface CceFieldChange {
  path: string[];
  old: unknown;
  new: unknown;
  data_type: string;
  changed: boolean;
  sensitive: boolean;
  masked?: boolean;
}

export interface CceChangeItem {
  seq: number;
  operation: Operation;
  object: NormalizedObject;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  field_changes?: CceFieldChange[];
  ddl?: { statement: string; effect?: string };
}

export interface CceEvidence {
  event_hash: string;
  prev_row_hash: string | null;
  row_hash: string;
}

export interface Cce {
  schema_version: 'cce-1.0';
  envelope_id: string;
  kind: 'transaction';
  source: NormalizedTransaction['source'];
  transaction: { tx_id: string; commit_ts: string; ingest_ts: string; statement_count: number };
  offset: CceOffset;
  fidelity: NormalizedFidelity;
  completeness: NormalizedCompleteness;
  actor: NormalizedActor;
  changes: CceChangeItem[];
  evidence: CceEvidence;
}
