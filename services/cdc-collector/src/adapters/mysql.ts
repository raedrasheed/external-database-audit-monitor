// MySQL CDC adapter (Epic E2 / EDAM-T011).

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A MySQL GTID interval token, e.g. "3E11FA47-...:152" or "...:1-152".
const MYSQL_GTID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+(?:-\d+)?$/i;

function serverUuidFromGtid(gtid: unknown): string {
  if (typeof gtid !== 'string') return '';
  const prefix = gtid.split(':', 1)[0] ?? '';
  return UUID_RE.test(prefix) ? prefix : '';
}

function toPos(pos: unknown): number | null {
  if (typeof pos === 'number') return pos;
  if (typeof pos === 'string' && pos !== '') {
    const n = Number(pos);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class MySqlAdapter implements EngineAdapter {
  readonly engine = 'mysql' as const;

  isHeartbeat(ev: RawSourceEvent): boolean {
    return isHeartbeatEvent(ev);
  }

  isDataChange(ev: RawSourceEvent): boolean {
    return isDataChangeEvent(ev);
  }

  extractSource(ev: RawSourceEvent, dbId: string): SourceMeta {
    const src = debeziumSource(ev);
    // MySQL binlog source carries no server_uuid; it is recoverable from the
    // GTID prefix (empty during the initial snapshot, where GTID is absent).
    return {
      db_id: dbId,
      engine: 'mysql',
      server_uuid: String(src.server_uuid ?? serverUuidFromGtid(src.gtid)),
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
    // A MySQL GTID is one or more comma-separated UUID:interval tokens.
    return gtid.split(',').map((s) => s.trim()).every((t) => MYSQL_GTID_TOKEN.test(t));
  }

  debeziumConfig(opts: DebeziumConfigOptions): string {
    return buildDebeziumProperties('io.debezium.connector.mysql.MySqlConnector', opts);
  }
}

export const mysqlAdapter = new MySqlAdapter();
