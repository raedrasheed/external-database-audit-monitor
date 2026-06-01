// MariaDB CDC adapter (Epic E2 / EDAM-T016).
//
// Distinct from the MySQL adapter: a different Debezium connector and a
// different GTID format. MariaDB GTIDs are `domain-server-sequence` (e.g.
// "0-223355-1052"), not UUID-based, and MariaDB binlog has no server UUID — the
// numeric server_id is used as the server identity. (Implementation note,
// reported per instructions; not a spec change.)

import type {
  DebeziumConfigOptions,
  EngineAdapter,
  OffsetMeta,
  RawSourceEvent,
  SnapshotPhase,
  SourceMeta,
} from './types.js';
import {
  buildDebeziumProperties,
  debeziumSource,
  isDataChangeEvent,
  isHeartbeatEvent,
  mapSnapshotPhase,
  sourceTimestampMs,
} from './debezium.js';

// MariaDB GTID token: domain-server-sequence.
const MARIADB_GTID_TOKEN = /^\d+-\d+-\d+$/;

function toPos(pos: unknown): number | null {
  if (typeof pos === 'number') return pos;
  if (typeof pos === 'string' && pos !== '') {
    const n = Number(pos);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class MariaDbAdapter implements EngineAdapter {
  readonly engine = 'mariadb' as const;

  isHeartbeat(ev: RawSourceEvent): boolean {
    return isHeartbeatEvent(ev);
  }

  isDataChange(ev: RawSourceEvent): boolean {
    return isDataChangeEvent(ev);
  }

  extractSource(ev: RawSourceEvent, dbId: string): SourceMeta {
    const src = debeziumSource(ev);
    // MariaDB has no server UUID; use server_id as the server identity.
    const identity = src.server_uuid ?? (src.server_id !== undefined ? String(src.server_id) : '');
    return {
      db_id: dbId,
      engine: 'mariadb',
      server_uuid: String(identity),
      schema: String(src.db ?? ''),
      table: String(src.table ?? ''),
    };
  }

  extractOffset(ev: RawSourceEvent): OffsetMeta {
    const src = debeziumSource(ev);
    return {
      gtid: typeof src.gtid === 'string' ? src.gtid : null,
      binlog_file: typeof src.file === 'string' ? src.file : null,
      binlog_pos: toPos(src.pos),
    };
  }

  snapshotPhase(ev: RawSourceEvent): SnapshotPhase {
    return mapSnapshotPhase(debeziumSource(ev).snapshot);
  }

  sourceTimestampMs(ev: RawSourceEvent): number | null {
    return sourceTimestampMs(ev);
  }

  isValidGtid(gtid: string): boolean {
    return gtid.split(',').map((s) => s.trim()).every((t) => MARIADB_GTID_TOKEN.test(t));
  }

  debeziumConfig(opts: DebeziumConfigOptions): string {
    return buildDebeziumProperties('io.debezium.connector.mariadb.MariaDbConnector', opts);
  }
}

export const mariadbAdapter = new MariaDbAdapter();
