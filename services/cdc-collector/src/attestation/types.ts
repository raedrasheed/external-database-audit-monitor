// Attestation Monitor types (Epic E3 / EDAM-T017..T020).
//
// The Attestation Monitor samples the monitored DB's audit-critical settings
// READ-ONLY (INV-1) and assesses capture fidelity. It NEVER fabricates a
// HEALTHY state (INV-2): if config cannot be read, or a downgrade is detected,
// the state is DEGRADED/COMPROMISED with a reason.

import type { Engine } from '../engine.js';

/** Capture fidelity state (CCE §6.4 / EDAM v2 §4.3). */
export type FidelityState = 'HEALTHY' | 'DEGRADED' | 'COMPROMISED';

/** Raw source configuration sampled from the monitored DB. */
export interface SourceConfig {
  engine: Engine;
  /** 'ON' | 'OFF' | null (null = could not be read). */
  log_bin: string | null;
  /** 'ROW' | 'STATEMENT' | 'MIXED' | null. */
  binlog_format: string | null;
  /** 'FULL' | 'MINIMAL' | 'NOBLOB' | null. */
  binlog_row_image: string | null;
  /** MySQL: 'ON' | 'OFF'. MariaDB: null (GTID is inherent; gtid_strict_mode used). */
  gtid_mode: string | null;
  /** MariaDB GTID strictness, where applicable. */
  gtid_strict_mode: string | null;
  /** Effective binlog retention in seconds (normalized from days where needed). */
  binlog_expire_logs_seconds: number | null;
  /** Server identity: MySQL @@server_uuid; MariaDB @@server_id (no UUID). */
  server_uuid: string | null;
}

/** Read source configuration; MUST throw if it cannot be read (no fabrication). */
export interface SourceConfigReader {
  read(): Promise<SourceConfig>;
}

/** Minimal read-only SQL surface (SHOW/SELECT only) — satisfied by mysql2. */
export interface SqlReader {
  query(sql: string): Promise<Array<Record<string, unknown>>>;
}

export interface AttestationOptions {
  /** Retention below this (seconds) is a downgrade (gap risk). */
  minBinlogRetentionSeconds: number;
}
