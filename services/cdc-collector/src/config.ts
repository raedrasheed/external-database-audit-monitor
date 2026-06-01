// CDC Collector service configuration (Epic E2 / EDAM-T010).
// Loaded from environment; no secrets are stored here (only a secret reference).

import type { Engine } from './engine.js';

export interface ServiceConfig {
  /** Logical id of the monitored database (CCE source.db_id later). */
  dbId: string;
  engine: Engine;
  schema: string;
  /** Redis URL hosting both the Debezium sink stream(s) and the EDAM bus. */
  redisUrl: string;
  /** Debezium sink stream key(s) the collector reads from. */
  sourceStreamKeys: string[];
  /** EDAM internal bus stream key the collector publishes CAPTURED records to. */
  busStreamKey: string;
  /** PostgreSQL URL for the EDAM collector-state DB (offset store). */
  pgUrl: string;
  /** Secret-store reference for the read-only CDC credential. */
  credentialRef: string;
  lagThresholdMs: number;
  stallTimeoutMs: number;
  heartbeatMs: number;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number for ${key}: ${v}`);
  return n;
}

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const engine = (env.CDC_ENGINE ?? 'mysql') as Engine;
  if (engine !== 'mysql' && engine !== 'mariadb') {
    throw new Error(`unsupported CDC_ENGINE: ${engine} (expected mysql|mariadb)`);
  }
  const dbId = env.CDC_DB_ID ?? 'kafel-dev-mysql';
  return {
    dbId,
    engine,
    schema: env.CDC_SCHEMA ?? 'kafel',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    sourceStreamKeys: (env.CDC_SOURCE_STREAMS ?? 'kafel').split(',').map((s) => s.trim()).filter(Boolean),
    busStreamKey: env.CDC_BUS_STREAM ?? 'edam:captured',
    pgUrl: env.EDAM_STATE_PG_URL ?? 'postgres://edam:edampw@127.0.0.1:5432/edam_state',
    credentialRef: env.CDC_CREDENTIAL_REF ?? 'edam/cdc/mysql',
    lagThresholdMs: num(env, 'CDC_LAG_THRESHOLD_MS', 30000),
    stallTimeoutMs: num(env, 'CDC_STALL_TIMEOUT_MS', 60000),
    heartbeatMs: num(env, 'CDC_HEARTBEAT_MS', 10000),
  };
}
