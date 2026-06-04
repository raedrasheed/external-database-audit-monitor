// Evidence-writer SERVICE entrypoint (R-11b). Consumes CCEs from the bus and runs the
// EvidenceWriterService (seal -> sign -> anchor -> WORM). Live wiring: Redis CCE stream
// + MinIO WORM (per-role SoD creds, born-locked COMPLIANCE) + dev signer + dev RFC-3161
// anchoring (DEV-anchored, R-01). The CCE stream is produced by the normalization
// service (R-11c); until that lands there is no input. Full end-to-end is validated in
// the Priority-2 Kafel pilot.
import Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { createMinioWormStore } from '@edam/worm';
import { DevEd25519Signer } from '@edam/signing';
import { DevRfc3161Provider } from '@edam/anchoring';
import { DlqService, InMemoryDlqStore, InMemoryDlqAlarmSink } from '@edam/dlq';
import type { Cce } from '@edam/cce-model';
import { EvidenceWriterService } from './service.js';

interface Cred { accessKey: string; secretKey: string }
function reqCred(env: NodeJS.ProcessEnv, userKey: string, secretKey: string): Cred {
  const accessKey = env[userKey];
  const secret = env[secretKey];
  if (!accessKey || !secret) throw new Error(`evidence-writer: missing ${userKey}/${secretKey}`);
  return { accessKey, secretKey: secret };
}

function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    cceStream: env.CDC_CCE_STREAM ?? 'edam:cce',
    dbId: env.CDC_DB_ID ?? 'kafel-dev-mysql',
    worm: {
      endPoint: env.WORM_MINIO_ENDPOINT ?? '127.0.0.1',
      port: env.WORM_MINIO_PORT ? Number(env.WORM_MINIO_PORT) : 9000,
      useSSL: env.WORM_MINIO_SSL === 'true',
      bucket: env.MINIO_BUCKET ?? 'edam-evidence',
      defaultRetentionDays: Number(env.WORM_DEFAULT_RETENTION_DAYS ?? '365'),
      credentials: {
        writer: reqCred(env, 'WORM_WRITER_USER', 'WORM_WRITER_SECRET'),
        reader: reqCred(env, 'WORM_READER_USER', 'WORM_READER_SECRET'),
        retentionAdmin: reqCred(env, 'WORM_RETENTION_ADMIN_USER', 'WORM_RETENTION_ADMIN_SECRET'),
      },
    },
    caps: { maxEvents: Number(env.EVW_MAX_EVENTS ?? '512'), maxAgeMs: Number(env.EVW_MAX_AGE_MS ?? '300000') },
    sweepMs: Number(env.EVW_SWEEP_MS ?? '15000'),
    // B6: FIXED dev signing + TSA keys (PEM file paths) so produced anchor records have a
    // stable signing_key_id and are offline-verifiable against the published trust file.
    // Omit ⇒ ephemeral keys (NOT offline-verifiable) — the pilot runbook requires these.
    signingKeyPemFile: env.EVW_SIGNING_KEY_PEM_FILE,
    tsaKeyPemFile: env.EVW_TSA_KEY_PEM_FILE,
  };
}

interface XReader { xread(...args: unknown[]): Promise<Array<[string, Array<[string, string[]]>]> | null> }

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = createMinioWormStore(cfg.worm);
  await store.ensureBucket();

  const signingPem = cfg.signingKeyPemFile ? readFileSync(cfg.signingKeyPemFile, 'utf8') : undefined;
  const tsaPem = cfg.tsaKeyPemFile ? readFileSync(cfg.tsaKeyPemFile, 'utf8') : undefined;
  if (!signingPem || !tsaPem) {
    // eslint-disable-next-line no-console
    console.warn('[evw] WARNING: EVW_SIGNING_KEY_PEM_FILE/EVW_TSA_KEY_PEM_FILE not set — using EPHEMERAL keys; produced evidence will NOT be offline-verifiable (set fixed keys per the pilot runbook).');
  }

  const svc = new EvidenceWriterService({
    store,
    signer: new DevEd25519Signer(signingPem ? { privateKeyPem: signingPem } : {}),   // DEV-anchored (R-01); FIXED key (B6)
    anchor: new DevRfc3161Provider(tsaPem ? { privateKeyPem: tsaPem } : {}),          // DEV-anchored (R-01); FIXED key (B6)
    dlq: new DlqService({ store: new InMemoryDlqStore(), alarms: new InMemoryDlqAlarmSink() }),
    caps: cfg.caps,
    dbId: cfg.dbId,
    // eslint-disable-next-line no-console
    onAlarm: (a) => console.error('[evw] ALARM', a),
  });

  const redis = new Redis(cfg.redisUrl);
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });
  // eslint-disable-next-line no-console
  const sweep = setInterval(() => { void svc.sweep().catch((e) => console.error('[evw] sweep error', e)); }, cfg.sweepMs);

  // eslint-disable-next-line no-console
  console.log(`[evw] evidence-writer started db=${cfg.dbId} cce-stream=${cfg.cceStream} bucket=${cfg.worm.bucket} (DEV-anchored, R-01)`);

  let lastId = '$';
  while (!stop) {
    const res = await (redis as unknown as XReader).xread('BLOCK', 2000, 'COUNT', 50, 'STREAMS', cfg.cceStream, lastId);
    if (!res) continue;
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        lastId = id;
        const i = fields.indexOf('cce');
        if (i < 0) continue;
        try {
          await svc.ingest(JSON.parse(fields[i + 1]!) as Cce);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[evw] ingest error', e);
        }
      }
    }
  }

  clearInterval(sweep);
  await redis.quit();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[evw] fatal', err);
  process.exitCode = 1;
});
