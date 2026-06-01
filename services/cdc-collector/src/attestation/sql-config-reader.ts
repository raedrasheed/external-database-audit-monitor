// Read-only source-config sampler (Epic E3 / EDAM-T017).
//
// Reads audit-critical server variables via SHOW GLOBAL VARIABLES (read-only;
// INV-1). Engine-aware: MySQL exposes gtid_mode + server_uuid; MariaDB exposes
// gtid_strict_mode + server_id (no UUID). If the read fails the error
// propagates so the caller assesses DEGRADED (no fabricated HEALTHY; INV-2).

import type { Engine } from '../engine.js';
import type { SourceConfig, SourceConfigReader, SqlReader } from './types.js';

const VARIABLES = [
  'log_bin',
  'binlog_format',
  'binlog_row_image',
  'gtid_mode',
  'gtid_strict_mode',
  'binlog_expire_logs_seconds',
  'expire_logs_days',
  'server_uuid',
  'server_id',
];

function upper(v: string | undefined): string | null {
  return v && v !== '' ? v.toUpperCase() : null;
}

export class SqlSourceConfigReader implements SourceConfigReader {
  constructor(
    private readonly engine: Engine,
    private readonly sql: SqlReader,
  ) {}

  async read(): Promise<SourceConfig> {
    const list = VARIABLES.map((v) => `'${v}'`).join(',');
    const rows = await this.sql.query(`SHOW GLOBAL VARIABLES WHERE Variable_name IN (${list})`);

    const map = new Map<string, string>();
    for (const r of rows) {
      const name = String(r.Variable_name ?? r.variable_name ?? '').toLowerCase();
      const value = r.Value ?? r.value;
      if (name) map.set(name, value === null || value === undefined ? '' : String(value));
    }

    const numOf = (k: string): number | null => {
      const v = map.get(k);
      if (v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const seconds = numOf('binlog_expire_logs_seconds');
    const days = numOf('expire_logs_days');
    const retention = seconds ?? (days !== null ? days * 86400 : null);

    const serverUuid =
      this.engine === 'mysql'
        ? (map.get('server_uuid') ?? '') || null
        : (map.get('server_id') ?? '') || null;

    return {
      engine: this.engine,
      log_bin: upper(map.get('log_bin')),
      binlog_format: upper(map.get('binlog_format')),
      binlog_row_image: upper(map.get('binlog_row_image')),
      gtid_mode: this.engine === 'mysql' ? upper(map.get('gtid_mode')) : null,
      gtid_strict_mode: this.engine === 'mariadb' ? upper(map.get('gtid_strict_mode')) : null,
      binlog_expire_logs_seconds: retention,
      server_uuid: serverUuid,
    };
  }
}

/** Convenience: read the config (errors propagate, by design). */
export async function readSourceConfig(reader: SourceConfigReader): Promise<SourceConfig> {
  return reader.read();
}
