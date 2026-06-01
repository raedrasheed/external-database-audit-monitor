// Integration: end-to-end normalization with DLQ isolation (Epic E4 / EDAM-T028).
import { describe, it, expect } from 'vitest';
import { Normalizer, type CapturedRecord } from '../src/index.js';
import type { Cce, NormalizedCompleteness, NormalizedFidelity } from '@edam/cce-model';
import { DlqService, InMemoryDlqStore, InMemoryDlqAlarmSink, type Clock } from '@edam/dlq';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const clock: Clock = { now: () => '2026-06-01T10:00:00.000Z' };

const healthy: NormalizedFidelity = {
  state: 'HEALTHY',
  source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' },
};
const noGap: NormalizedCompleteness = { consumed_offset_key: 'x', gap_detected: false, snapshot_phase: 'streaming' };

function setup() {
  const emitted: Cce[] = [];
  const store = new InMemoryDlqStore();
  const dlq = new DlqService({ store, alarms: new InMemoryDlqAlarmSink(), clock });
  const normalizer = new Normalizer({
    pkResolver: (_s, t) => (t === 'user_roles' ? ['user_id', 'role_id'] : ['id']),
    fidelity: { current: () => healthy },
    completeness: { current: (dbId) => ({ ...noGap, consumed_offset_key: dbId }) },
    sensitiveFields: ['kafel.beneficiaries.national_id'],
    dlq,
    emit: (cce) => { emitted.push(cce); },
  });
  return { normalizer, emitted, store };
}

function rec(seq: number, value: unknown, table = 'donations'): CapturedRecord {
  return {
    raw_native: value,
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel', table },
    offset: { gtid: `${UUID}:${seq}`, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq },
    captured_at: '2026-06-01T10:00:00.000Z',
  };
}

const upd = (seq: number, amount: string) => rec(seq, {
  op: 'u',
  before: { id: 90211, amount: '100.00', status: 'approved' },
  after: { id: 90211, amount, status: 'approved' },
  source: { table: 'donations', ts_ms: 1748773351000, snapshot: 'false' },
});

describe('Normalizer integration', () => {
  it('produces a valid, chained CCE for a clean event', async () => {
    const { normalizer, emitted } = setup();
    await normalizer.process(upd(1, '100000.00'));
    await normalizer.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.schema_version).toBe('cce-1.0');
    expect(emitted[0]!.changes[0]!.field_changes?.[0]?.path).toEqual(['amount']);
  });

  it('chains row_hash across emitted CCEs', async () => {
    const { normalizer, emitted } = setup();
    await normalizer.process(upd(1, '100000.00'));
    await normalizer.flush();
    await normalizer.process(upd(2, '200000.00'));
    await normalizer.flush();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.evidence.prev_row_hash).toBe(emitted[0]!.evidence.row_hash);
  });

  it('routes a malformed event to the DLQ without crashing or emitting', async () => {
    const { normalizer, emitted, store } = setup();
    await normalizer.process(rec(9, 'not-an-object'));
    await normalizer.flush();
    expect(emitted).toHaveLength(0);
    expect(await store.count()).toBe(1);
    expect((await store.list())[0]!.failure_category).toBe('MALFORMED_CDC_EVENT');
  });

  it('skips an idempotent duplicate (same record re-delivered)', async () => {
    const { normalizer, emitted } = setup();
    await normalizer.process(upd(1, '100000.00'));
    await normalizer.flush();
    await normalizer.process(upd(1, '100000.00')); // identical re-delivery
    await normalizer.flush();
    expect(emitted).toHaveLength(1);
    expect(normalizer.stats.duplicates).toBe(1);
  });

  it('NO EVENT LOSS: every record is emitted, deduplicated, or DLQ-routed', async () => {
    const { normalizer, emitted, store } = setup();
    const records = [upd(1, '100000.00'), rec(2, 'garbage'), upd(3, '300000.00'), upd(1, '100000.00')];
    for (const r of records) await normalizer.process(r);
    await normalizer.flush();
    const accounted = normalizer.stats.emitted + normalizer.stats.duplicates + normalizer.stats.dlq;
    expect(accounted).toBe(records.length);
    expect(emitted.length + (await store.count()) + normalizer.stats.duplicates).toBe(records.length);
  });

  it('masks sensitive fields end to end', async () => {
    const { normalizer, emitted } = setup();
    await normalizer.process(rec(5, {
      op: 'd',
      before: { id: 5567, national_id: '2011223344', balance: '1320.00' },
      after: null,
      source: { table: 'beneficiaries', ts_ms: 1748773351000, snapshot: 'false' },
    }, 'beneficiaries'));
    await normalizer.flush();
    expect(JSON.stringify(emitted[0])).not.toContain('2011223344');
  });
});
