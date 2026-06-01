// Tests for the MySQL adapter + Debezium config (Epic E2 / EDAM-T011).
import { describe, it, expect } from 'vitest';
import { mysqlAdapter } from '../src/adapters/mysql.js';
import {
  mysqlUpdate,
  mysqlSnapshotRead,
  mysqlSnapshotLast,
  heartbeat,
  mysqlWrapped,
} from './fixtures/debezium-events.js';

describe('MySqlAdapter', () => {
  it('classifies data changes, snapshot reads, and heartbeats', () => {
    expect(mysqlAdapter.isDataChange(mysqlUpdate)).toBe(true);
    expect(mysqlAdapter.isDataChange(mysqlSnapshotRead)).toBe(true);
    expect(mysqlAdapter.isHeartbeat(heartbeat)).toBe(true);
    expect(mysqlAdapter.isDataChange(heartbeat)).toBe(false);
  });

  it('extracts source metadata (I1), deriving server_uuid from the GTID', () => {
    const src = mysqlAdapter.extractSource(mysqlUpdate, 'kafel-dev-mysql');
    expect(src).toEqual({
      db_id: 'kafel-dev-mysql',
      engine: 'mysql',
      server_uuid: '3E11FA47-71CA-11E1-9E33-C80AA9429562',
      schema: 'kafel',
      table: 'donations',
    });
  });

  it('extracts offset metadata (gtid/file/pos)', () => {
    expect(mysqlAdapter.extractOffset(mysqlUpdate)).toEqual({
      gtid: '3E11FA47-71CA-11E1-9E33-C80AA9429562:152',
      binlog_file: 'mysql-bin.000042',
      binlog_pos: 99812,
    });
  });

  it('maps snapshot phase: streaming / snapshot / handoff', () => {
    expect(mysqlAdapter.snapshotPhase(mysqlUpdate)).toBe('streaming');
    expect(mysqlAdapter.snapshotPhase(mysqlSnapshotRead)).toBe('snapshot');
    expect(mysqlAdapter.snapshotPhase(mysqlSnapshotLast)).toBe('handoff');
  });

  it('unwraps schema-wrapped values', () => {
    expect(mysqlAdapter.isDataChange(mysqlWrapped)).toBe(true);
    expect(mysqlAdapter.extractOffset(mysqlWrapped).binlog_pos).toBe(101244);
  });

  it('validates MySQL-format GTIDs and rejects MariaDB-format', () => {
    expect(mysqlAdapter.isValidGtid('3E11FA47-71CA-11E1-9E33-C80AA9429562:152')).toBe(true);
    expect(mysqlAdapter.isValidGtid('3E11FA47-71CA-11E1-9E33-C80AA9429562:1-152')).toBe(true);
    expect(mysqlAdapter.isValidGtid('0-223355-1052')).toBe(false); // MariaDB format
    expect(mysqlAdapter.isValidGtid('garbage')).toBe(false);
  });

  it('reports source timestamp in ms', () => {
    expect(mysqlAdapter.sourceTimestampMs(mysqlUpdate)).toBe(1748773351000);
  });

  it('generates a Debezium config (ROW/FULL/GTID are source prerequisites)', () => {
    const props = mysqlAdapter.debeziumConfig({
      topicPrefix: 'kafel',
      host: 'mysql',
      port: 3306,
      user: 'cdc',
      password: 'cdc_pw',
      serverId: 184054,
      databaseIncludeList: 'kafel',
      tableIncludeList: 'kafel.donations',
      redisAddress: 'redis:6379',
      offsetFile: '/debezium/data/offsets.dat',
      schemaHistoryFile: '/debezium/data/schema-history.dat',
      heartbeatMs: 10000,
    });
    expect(props).toContain('connector.class=io.debezium.connector.mysql.MySqlConnector');
    expect(props).toContain('snapshot.mode=initial');
    expect(props).toContain('schemas.enable=false');
    expect(props).toContain('heartbeat.interval.ms=10000');
    expect(props).toContain('database.user=cdc');
  });
});
