// Integrity service entrypoint (Epic E3 / EDAM-T024).
//
// Co-located with the collector deployment but logically separate. It:
//   - periodically runs the Attestation Monitor (read-only source config) and
//     the Audit-Plugin watcher, emitting config_snapshots + downgrade/tamper
//     alarms;
//   - reads the Debezium source stream (read-only) to track the consumed GTID
//     set, heartbeats, and snapshot phase, emitting CompletenessUpdates and
//     gap alarms.
//
// Read-only throughout (INV-1): Redis (source) + a read-only mysql2 connection
// for attestation. Not exercised by unit tests; runs in the dev compose env.

import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { loadServiceConfig } from '../config.js';
import { EnvSecretSource, loadReadOnlyCredential, redactCredential } from '../credentials.js';
import { getAdapter } from '../adapters/index.js';
import { RedisSourceStream, type XReader } from '../source-stream.js';
import { systemClock } from '../clock.js';
import { ConsoleAlarmSink } from '../alarms.js';
import { Mysql2SqlReader } from '../attestation/mysql-sql-reader.js';
import { SqlSourceConfigReader } from '../attestation/sql-config-reader.js';
import { AttestationMonitor } from '../attestation/monitor.js';
import { AuditPluginWatcher } from '../attestation/audit.js';
import { InMemoryConfigSnapshotSink } from '../attestation/snapshot.js';
import { CompletenessWatcher, InMemoryCompletenessUpdateSink } from '../completeness/watcher.js';

async function main(): Promise<void> {
  const cfg = loadServiceConfig();
  const cred = await loadReadOnlyCredential(cfg.credentialRef, new EnvSecretSource());
  // eslint-disable-next-line no-console
  console.log(`[integrity] read-only credential ${redactCredential(cred)} (INV-1)`);

  const adapter = getAdapter(cfg.engine);
  const alarms = new ConsoleAlarmSink();

  // Read-only mysql2 connection for attestation/audit.
  const sourceHost = process.env.CDC_SOURCE_HOST ?? '127.0.0.1';
  const sourcePort = Number(process.env.CDC_SOURCE_PORT ?? (cfg.engine === 'mariadb' ? 3307 : 3306));
  const conn = await mysql.createConnection({
    host: sourceHost,
    port: sourcePort,
    user: cred.username,
    password: cred.password,
    database: cfg.schema,
  });
  const sql = new Mysql2SqlReader(conn);

  const attestation = new AttestationMonitor({
    engine: cfg.engine,
    dbId: cfg.dbId,
    reader: new SqlSourceConfigReader(cfg.engine, sql),
    sink: new InMemoryConfigSnapshotSink(),
    alarms,
    clock: systemClock,
    options: { minBinlogRetentionSeconds: 86400 },
  });
  const audit = new AuditPluginWatcher({ engine: cfg.engine, dbId: cfg.dbId, sql, alarms, clock: systemClock });

  const completeness = new CompletenessWatcher({
    engine: cfg.engine,
    dbId: cfg.dbId,
    stallTimeoutMs: cfg.stallTimeoutMs,
    idleThresholdMs: cfg.lagThresholdMs,
  });
  const updateSink = new InMemoryCompletenessUpdateSink();

  const redisSub = new Redis(cfg.redisUrl);
  const source = new RedisSourceStream(redisSub as unknown as XReader, cfg.sourceStreamKeys);

  let stop = false;
  const requestStop = () => { stop = true; };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  // Periodic attestation sampling.
  const attestationTimer = setInterval(() => {
    void attestation.sample();
    void audit.check();
  }, cfg.heartbeatMs);

  // eslint-disable-next-line no-console
  console.log(`[integrity] started engine=${cfg.engine} db=${cfg.dbId}`);

  while (!stop) {
    const ev = await source.next();
    const now = systemClock.now();
    if (ev === null) {
      const update = completeness.buildUpdate({ alarms, atIso: now, nowMs: systemClock.nowMs() });
      await updateSink.emit(update);
      continue;
    }
    if (adapter.isHeartbeat(ev)) {
      completeness.observeHeartbeat(now);
      continue;
    }
    if (!adapter.isDataChange(ev)) continue;

    completeness.observeEvent({
      gtid: adapter.extractOffset(ev).gtid,
      phase: adapter.snapshotPhase(ev),
      at: now,
    });
    const update = completeness.buildUpdate({ alarms, atIso: now, nowMs: systemClock.nowMs() });
    await updateSink.emit(update);
  }

  clearInterval(attestationTimer);
  await Promise.allSettled([redisSub.quit(), conn.end()]);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[integrity] fatal', err);
  process.exitCode = 1;
});
