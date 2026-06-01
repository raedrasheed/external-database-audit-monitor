// CDC Collector entrypoint (Epic E2 / EDAM-T016).
// Wires the real Redis/PostgreSQL adapters and runs the resilient read loop.
// Not exercised by unit tests (those use injected fakes); runs in the dev
// compose env.

import Redis from 'ioredis';
import pg from 'pg';
import { loadServiceConfig } from './config.js';
import { EnvSecretSource, loadReadOnlyCredential, redactCredential } from './credentials.js';
import { getAdapter } from './adapters/index.js';
import { RedisBus, type RedisStreamWriter } from './bus.js';
import { RedisSourceStream, type XReader } from './source-stream.js';
import { PgOffsetStore, type PgLike } from './offset-store.js';
import { systemClock } from './clock.js';
import { ConsoleAlarmSink } from './alarms.js';
import { HandoffTracker } from './handoff.js';
import { LagMonitor } from './lag.js';
import { CdcCollector } from './collector.js';
import { runWithReconnect } from './backoff.js';

async function main(): Promise<void> {
  const cfg = loadServiceConfig();

  // INV-1: load a read-only credential reference; the collector never holds a
  // Kafel write credential and never connects to the monitored DB to write.
  const cred = await loadReadOnlyCredential(cfg.credentialRef, new EnvSecretSource());
  // eslint-disable-next-line no-console
  console.log(`[cdc] read-only credential ${redactCredential(cred)} (INV-1)`);

  const adapter = getAdapter(cfg.engine);
  const redisPub = new Redis(cfg.redisUrl);
  const redisSub = new Redis(cfg.redisUrl);
  const pool = new pg.Pool({ connectionString: cfg.pgUrl });

  const db: PgLike = { query: (text, values) => pool.query(text, values as unknown[]) };
  const offsets = new PgOffsetStore(db);
  await offsets.ensureSchema();

  const bus = new RedisBus(redisPub as unknown as RedisStreamWriter, cfg.busStreamKey);
  const source = new RedisSourceStream(redisSub as unknown as XReader, cfg.sourceStreamKeys);
  const alarms = new ConsoleAlarmSink();
  const lag = new LagMonitor({
    lagThresholdMs: cfg.lagThresholdMs,
    stallTimeoutMs: cfg.stallTimeoutMs,
    clock: systemClock,
    sink: alarms,
  });
  const handoff = new HandoffTracker();
  const collector = new CdcCollector({
    source,
    bus,
    offsets,
    adapter,
    clock: systemClock,
    alarms,
    handoff,
    lag,
    dbId: cfg.dbId,
    onHandoff: (e) => console.log(`[cdc] handoff ${e.type}`, e.offset),
  });

  let stop = false;
  const requestStop = () => {
    stop = true;
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  // eslint-disable-next-line no-console
  console.log(`[cdc] collector started engine=${cfg.engine} db=${cfg.dbId} bus=${cfg.busStreamKey}`);

  await runWithReconnect(
    async () => {
      while (!stop) {
        const ev = await source.next();
        if (ev === null) {
          lag.checkStall();
          continue;
        }
        await collector.processEvent(ev);
      }
    },
    {
      alarms,
      clock: systemClock,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      shouldStop: () => stop,
    },
  );

  await Promise.allSettled([redisPub.quit(), redisSub.quit(), pool.end()]);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cdc] fatal', err);
  process.exitCode = 1;
});
