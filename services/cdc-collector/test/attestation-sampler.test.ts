// Tests for the read-only source-config sampler (Epic E3 / EDAM-T017).
import { describe, it, expect } from 'vitest';
import { SqlSourceConfigReader, readSourceConfig } from '../src/attestation/sql-config-reader.js';
import type { SqlReader } from '../src/attestation/types.js';

function fakeVars(vars: Record<string, string>): SqlReader {
  return {
    async query(sql: string) {
      expect(sql).toMatch(/^SHOW GLOBAL VARIABLES WHERE/i); // read-only (INV-1)
      return Object.entries(vars).map(([Variable_name, Value]) => ({ Variable_name, Value }));
    },
  };
}

describe('SqlSourceConfigReader (MySQL)', () => {
  it('samples the audit-critical variables read-only', async () => {
    const reader = new SqlSourceConfigReader(
      'mysql',
      fakeVars({
        log_bin: 'ON',
        binlog_format: 'ROW',
        binlog_row_image: 'FULL',
        gtid_mode: 'ON',
        binlog_expire_logs_seconds: '604800',
        server_uuid: '3E11FA47-71CA-11E1-9E33-C80AA9429562',
      }),
    );
    const cfg = await readSourceConfig(reader);
    expect(cfg).toEqual({
      engine: 'mysql',
      log_bin: 'ON',
      binlog_format: 'ROW',
      binlog_row_image: 'FULL',
      gtid_mode: 'ON',
      gtid_strict_mode: null,
      binlog_expire_logs_seconds: 604800,
      server_uuid: '3E11FA47-71CA-11E1-9E33-C80AA9429562',
    });
  });

  it('normalizes expire_logs_days to seconds when seconds is absent', async () => {
    const reader = new SqlSourceConfigReader(
      'mysql',
      fakeVars({ log_bin: 'ON', binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', expire_logs_days: '7' }),
    );
    expect((await reader.read()).binlog_expire_logs_seconds).toBe(7 * 86400);
  });

  it('returns nulls for variables the server does not expose (no fabrication)', async () => {
    const reader = new SqlSourceConfigReader('mysql', fakeVars({ log_bin: 'ON' }));
    const cfg = await reader.read();
    expect(cfg.binlog_format).toBeNull();
    expect(cfg.binlog_row_image).toBeNull();
    expect(cfg.server_uuid).toBeNull();
  });
});

describe('SqlSourceConfigReader (MariaDB)', () => {
  it('uses server_id as identity and gtid_strict_mode (no gtid_mode)', async () => {
    const reader = new SqlSourceConfigReader(
      'mariadb',
      fakeVars({
        log_bin: 'ON',
        binlog_format: 'ROW',
        binlog_row_image: 'FULL',
        gtid_strict_mode: 'ON',
        server_id: '223355',
        binlog_expire_logs_seconds: '604800',
      }),
    );
    const cfg = await reader.read();
    expect(cfg.gtid_mode).toBeNull(); // n/a on MariaDB
    expect(cfg.gtid_strict_mode).toBe('ON');
    expect(cfg.server_uuid).toBe('223355'); // server_id as identity
  });
});

describe('read failure', () => {
  it('propagates the error (caller assesses DEGRADED; no fabricated HEALTHY)', async () => {
    const failing: SqlReader = {
      async query() {
        throw new Error('connection refused');
      },
    };
    await expect(readSourceConfig(new SqlSourceConfigReader('mysql', failing))).rejects.toThrow(
      'connection refused',
    );
  });
});
