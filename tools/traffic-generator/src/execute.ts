// Transaction executor (Epic E7 / EDAM-T049).
// Applies a planned set of transactions against the dev MySQL/MariaDB so the
// CDC pipeline observes them. Each TxPlan runs in one transaction where the
// engine allows; DDL/TRUNCATE implicitly commit and are issued directly.

import mysql from 'mysql2/promise';
import type { TxPlan } from './types.js';

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const IMPLICIT_COMMIT = new Set(['DDL', 'TRUNCATE']);

export async function executePlans(plans: readonly TxPlan[], cfg: DbConfig): Promise<void> {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: false,
  });

  try {
    for (const plan of plans) {
      const implicit = plan.ops.some((o) => IMPLICIT_COMMIT.has(o.op));
      if (implicit) {
        for (const op of plan.ops) {
          await conn.query(op.sql);
        }
        continue;
      }
      await conn.beginTransaction();
      try {
        for (const op of plan.ops) {
          await conn.query(op.sql);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    }
  } finally {
    await conn.end();
  }
}
