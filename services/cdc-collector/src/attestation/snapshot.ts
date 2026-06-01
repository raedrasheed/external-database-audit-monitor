// Config snapshot (Epic E3 / EDAM-T018).
//
// Produces config_snapshot records that the Normalization Service (E4) later
// attaches to a CCE's fidelity.source_config / fidelity.state. The embedded
// `source_config` carries exactly the CCE §6.4 keys; sampled retention/server
// identity travel as separate context. The id is content-addressed
// deterministically via @edam/canonical (no fabrication). This module does NOT
// build CCEs.

import { serializeCanonical, sha256Hex } from '@edam/canonical';
import type { Engine } from '../engine.js';
import type { FidelityState, SourceConfig } from './types.js';

export interface FidelityAssessment {
  state: FidelityState;
  degraded_reason: string | null;
  notes: string[];
}

/** Exactly the CCE §6.4 fidelity.source_config keys. */
export interface CceSourceConfig {
  binlog_format: string | null;
  binlog_row_image: string | null;
  gtid_mode: string | null;
  replica_identity: string | null; // Postgres-only; null for MySQL/MariaDB
  log_bin: string | null;
  config_snapshot_id: string;
}

export interface ConfigSnapshot {
  config_snapshot_id: string;
  db_id: string;
  engine: Engine;
  sampled_at: string;
  state: FidelityState;
  degraded_reason: string | null;
  notes: string[];
  /** CCE-mappable source_config (attached to fidelity.source_config later). */
  source_config: CceSourceConfig;
  /** Additional sampled context (not part of the CCE source_config keys). */
  sampled: {
    binlog_expire_logs_seconds: number | null;
    gtid_strict_mode: string | null;
    server_uuid: string | null;
  };
}

/** Deterministic, content-addressed snapshot id. */
export function computeConfigSnapshotId(
  dbId: string,
  engine: Engine,
  sampledAt: string,
  config: SourceConfig,
): string {
  const digest = sha256Hex(
    serializeCanonical({
      db_id: dbId,
      engine,
      sampled_at: sampledAt,
      binlog_format: config.binlog_format,
      binlog_row_image: config.binlog_row_image,
      gtid_mode: config.gtid_mode,
      gtid_strict_mode: config.gtid_strict_mode,
      log_bin: config.log_bin,
      binlog_expire_logs_seconds: config.binlog_expire_logs_seconds,
      server_uuid: config.server_uuid,
    }),
  );
  return `cfg-${digest.slice(0, 16)}`;
}

export function buildConfigSnapshot(
  dbId: string,
  config: SourceConfig,
  assessment: FidelityAssessment,
  sampledAt: string,
): ConfigSnapshot {
  const id = computeConfigSnapshotId(dbId, config.engine, sampledAt, config);
  return {
    config_snapshot_id: id,
    db_id: dbId,
    engine: config.engine,
    sampled_at: sampledAt,
    state: assessment.state,
    degraded_reason: assessment.degraded_reason,
    notes: assessment.notes,
    source_config: {
      binlog_format: config.binlog_format,
      binlog_row_image: config.binlog_row_image,
      gtid_mode: config.gtid_mode,
      replica_identity: null,
      log_bin: config.log_bin,
      config_snapshot_id: id,
    },
    sampled: {
      binlog_expire_logs_seconds: config.binlog_expire_logs_seconds,
      gtid_strict_mode: config.gtid_strict_mode,
      server_uuid: config.server_uuid,
    },
  };
}

/** Sink for config snapshots (so Normalization/E4 can consume them later). */
export interface ConfigSnapshotSink {
  emit(snapshot: ConfigSnapshot): Promise<void>;
}

export class InMemoryConfigSnapshotSink implements ConfigSnapshotSink {
  readonly snapshots: ConfigSnapshot[] = [];
  async emit(snapshot: ConfigSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }
}
