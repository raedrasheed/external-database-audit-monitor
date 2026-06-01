// CDC engine-adapter contract (Epic E2 / EDAM-T011, EDAM-T016).
// MySQL and MariaDB are handled by distinct adapters behind this one interface.

import type { Engine } from '../engine.js';

export type { Engine };

/** A raw change event as read from the Debezium sink stream (pre-CCE). */
export interface RawSourceEvent {
  /** Debezium topic / Redis stream key (used to detect heartbeats). */
  topic?: string;
  key?: unknown;
  /** Parsed Debezium value (schema-wrapped envelopes are unwrapped by adapters). */
  value: unknown;
  /** Redis stream entry id, for durable resume. */
  streamId?: string;
}

/** Source metadata extracted for the CAPTURED record (Sprint plan I1). */
export interface SourceMeta {
  db_id: string;
  engine: Engine;
  server_uuid: string;
  schema: string;
  table: string;
}

/** Offset metadata extracted for the CAPTURED record (Sprint plan I1). */
export interface OffsetMeta {
  gtid: string | null;
  binlog_file: string | null;
  binlog_pos: number | null;
}

export type SnapshotPhase = 'snapshot' | 'handoff' | 'streaming';

export interface DebeziumConfigOptions {
  topicPrefix: string;
  host: string;
  port: number;
  /** Read-only DB user (INV-1). */
  user: string;
  password: string;
  serverId: number;
  databaseIncludeList: string;
  tableIncludeList: string;
  redisAddress: string;
  offsetFile: string;
  schemaHistoryFile: string;
  heartbeatMs?: number;
}

export interface EngineAdapter {
  readonly engine: Engine;
  isHeartbeat(ev: RawSourceEvent): boolean;
  isDataChange(ev: RawSourceEvent): boolean;
  extractSource(ev: RawSourceEvent, dbId: string): SourceMeta;
  extractOffset(ev: RawSourceEvent): OffsetMeta;
  snapshotPhase(ev: RawSourceEvent): SnapshotPhase;
  sourceTimestampMs(ev: RawSourceEvent): number | null;
  /** Engine-specific GTID validation (the key MySQL vs MariaDB difference). */
  isValidGtid(gtid: string): boolean;
  /** Generate a Debezium Server application.properties for this engine. */
  debeziumConfig(opts: DebeziumConfigOptions): string;
}
