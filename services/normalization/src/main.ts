// Normalization SERVICE entrypoint (R-11c). Consumes CapturedRecords from the bus
// (produced by the collector), normalizes them to CCEs (Normalizer: mapCapturedRecord ->
// assemble -> buildCce), and publishes CCEs to the CCE bus (consumed by the
// evidence-writer). This is the connective stage that makes the pilot end-to-end:
//   Kafel -> Debezium -> collector(edam:captured) -> NORMALIZATION(edam:cce) -> evidence-writer -> WORM
//
// PILOT BOUNDARY: fidelity defaults to UNATTESTED (DEGRADED) unless FIDELITY_ATTESTED=true
// (the runbook pre-flight verifies ROW/FULL/GTID); actor attribution is unattributed.
import Redis from 'ioredis';
import { DlqService, InMemoryDlqStore, InMemoryDlqAlarmSink } from '@edam/dlq';
import type { Cce, NormalizedFidelity } from '@edam/cce-model';
import type { CapturedRecord } from './native-map.js';
import { makeNormalizer } from './service.js';

function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const attested = env.FIDELITY_ATTESTED === 'true';
  const fidelity: NormalizedFidelity | null = attested
    ? {
        state: 'HEALTHY',
        source_config: {
          binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON',
          replica_identity: null, log_bin: 'ON', config_snapshot_id: env.FIDELITY_CONFIG_SNAPSHOT ?? 'pilot',
        },
      }
    : null;
  return {
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    capturedStream: env.CDC_BUS_STREAM ?? 'edam:captured',
    cceStream: env.CDC_CCE_STREAM ?? 'edam:cce',
    pkMap: env.PK_MAP,
    sensitiveFields: env.SENSITIVE_FIELDS ? env.SENSITIVE_FIELDS.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    fidelity,
    flushMs: Number(env.NORM_FLUSH_MS ?? '5000'),
  };
}

interface XReader { xread(...args: unknown[]): Promise<Array<[string, Array<[string, string[]]>]> | null> }
interface XWriter { xadd(...args: unknown[]): Promise<string | null> }

async function main(): Promise<void> {
  const cfg = loadConfig();
  const redisIn = new Redis(cfg.redisUrl);
  const redisOut = new Redis(cfg.redisUrl);
  const dlq = new DlqService({ store: new InMemoryDlqStore(), alarms: new InMemoryDlqAlarmSink() });
  const emit = async (cce: Cce): Promise<void> => { await (redisOut as unknown as XWriter).xadd(cfg.cceStream, '*', 'cce', JSON.stringify(cce)); };
  const n = makeNormalizer({ pkMap: cfg.pkMap, sensitiveFields: cfg.sensitiveFields, fidelity: cfg.fidelity }, emit, dlq);

  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });
  // eslint-disable-next-line no-console
  const flush = setInterval(() => { void n.flush().catch((e) => console.error('[norm] flush error', e)); }, cfg.flushMs);

  // eslint-disable-next-line no-console
  console.log(`[norm] normalization started in=${cfg.capturedStream} out=${cfg.cceStream} fidelity=${cfg.fidelity ? 'attested' : 'unattested(DEGRADED)'}`);

  let lastId = '$';
  while (!stop) {
    const res = await (redisIn as unknown as XReader).xread('BLOCK', 2000, 'COUNT', 100, 'STREAMS', cfg.capturedStream, lastId);
    if (!res) continue;
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        lastId = id;
        const i = fields.indexOf('record');
        if (i < 0) continue;
        try {
          await n.process(JSON.parse(fields[i + 1]!) as CapturedRecord);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[norm] process error', e);
        }
      }
    }
  }

  clearInterval(flush);
  await n.flush();
  await Promise.allSettled([redisIn.quit(), redisOut.quit()]);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[norm] fatal', err);
  process.exitCode = 1;
});
