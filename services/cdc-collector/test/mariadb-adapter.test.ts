// Tests for the MariaDB adapter + registry (Epic E2 / EDAM-T016).
import { describe, it, expect } from 'vitest';
import { mariadbAdapter } from '../src/adapters/mariadb.js';
import { getAdapter } from '../src/adapters/index.js';
import { mariadbUpdate } from './fixtures/debezium-events.js';

describe('MariaDbAdapter (distinct adapter)', () => {
  it('uses server_id as the server identity (no UUID in MariaDB)', () => {
    const src = mariadbAdapter.extractSource(mariadbUpdate, 'kafel-dev-mariadb');
    expect(src.engine).toBe('mariadb');
    expect(src.server_uuid).toBe('223355');
    expect(src.table).toBe('donations');
  });

  it('extracts a MariaDB-format GTID offset', () => {
    expect(mariadbAdapter.extractOffset(mariadbUpdate)).toEqual({
      gtid: '0-223355-1052',
      binlog_file: 'maria-bin.000007',
      binlog_pos: 4120,
    });
  });

  it('validates MariaDB GTID format and rejects MySQL format', () => {
    expect(mariadbAdapter.isValidGtid('0-223355-1052')).toBe(true);
    expect(mariadbAdapter.isValidGtid('0-1-5,0-2-9')).toBe(true);
    expect(mariadbAdapter.isValidGtid('3E11FA47-71CA-11E1-9E33-C80AA9429562:152')).toBe(false);
  });

  it('generates the MariaDB connector config', () => {
    const props = mariadbAdapter.debeziumConfig({
      topicPrefix: 'kafel',
      host: 'mariadb',
      port: 3306,
      user: 'cdc',
      password: 'cdc_pw',
      serverId: 200000,
      databaseIncludeList: 'kafel',
      tableIncludeList: 'kafel.donations',
      redisAddress: 'redis:6379',
      offsetFile: '/debezium/data/offsets.dat',
      schemaHistoryFile: '/debezium/data/schema-history.dat',
    });
    expect(props).toContain('connector.class=io.debezium.connector.mariadb.MariaDbConnector');
  });
});

describe('adapter registry', () => {
  it('returns distinct adapters per engine', () => {
    expect(getAdapter('mysql').engine).toBe('mysql');
    expect(getAdapter('mariadb').engine).toBe('mariadb');
  });

  it('the two adapters disagree on GTID validation (proving distinctness)', () => {
    const mysqlGtid = '3E11FA47-71CA-11E1-9E33-C80AA9429562:152';
    const mariaGtid = '0-223355-1052';
    expect(getAdapter('mysql').isValidGtid(mysqlGtid)).toBe(true);
    expect(getAdapter('mariadb').isValidGtid(mysqlGtid)).toBe(false);
    expect(getAdapter('mariadb').isValidGtid(mariaGtid)).toBe(true);
    expect(getAdapter('mysql').isValidGtid(mariaGtid)).toBe(false);
  });
});
