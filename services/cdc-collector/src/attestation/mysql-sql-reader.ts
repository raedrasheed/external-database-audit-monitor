// Live read-only SQL reader for attestation (Epic E3).
// Wraps a mysql2 connection; issues only SHOW/SELECT (read-only; INV-1). Used by
// the integrity entrypoint, not by unit tests (those inject fake SqlReaders).

import type { SqlReader } from './types.js';

/** Minimal mysql2 connection surface. */
export interface Mysql2Conn {
  query(sql: string): Promise<[unknown, unknown]>;
}

export class Mysql2SqlReader implements SqlReader {
  constructor(private readonly conn: Mysql2Conn) {}

  async query(sql: string): Promise<Array<Record<string, unknown>>> {
    const [rows] = await this.conn.query(sql);
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  }
}
