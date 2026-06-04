// Normalization SERVICE composition smoke test (R-11c). Proves the minimal pilot wiring
// (makeNormalizer + the static providers) turns a Debezium-shaped CapturedRecord into an
// emitted CCE — in memory, no Redis. Full live integration is the Priority-2 Kafel pilot.
import { describe, it, expect } from 'vitest';
import { DlqService, InMemoryDlqStore, InMemoryDlqAlarmSink } from '@edam/dlq';
import type { Cce } from '@edam/cce-model';
import { makeNormalizer, parsePkResolver } from '../src/service.js';
import type { CapturedRecord } from '../src/native-map.js';

const HEALTHY = {
  state: 'HEALTHY' as const,
  source_config: { binlog_format: 'ROW' as const, binlog_row_image: 'FULL' as const, gtid_mode: 'ON' as const, replica_identity: null, log_bin: 'ON' as const, config_snapshot_id: 'cfg' },
};

function dbzInsert(seq: number): CapturedRecord {
  return {
    raw_native: { op: 'c', source: { table: 'donations' }, before: null, after: { id: seq, amount: '2.00' } },
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: '3e11fa47-71ca-11e1-9e33-c80aa9429562', schema: 'kafel', table: 'donations' },
    offset: { gtid: `g${seq}`, binlog_file: 'mysql-bin.000001', binlog_pos: 100 + seq },
    captured_at: '2026-06-04T10:00:00.000Z',
  };
}

describe('Normalization service composition (R-11c)', () => {
  it('Debezium INSERT CapturedRecord -> one CCE emitted (operator-attested fidelity)', async () => {
    const emitted: Cce[] = [];
    const dlq = new DlqService({ store: new InMemoryDlqStore(), alarms: new InMemoryDlqAlarmSink() });
    const n = makeNormalizer({ fidelity: HEALTHY }, (c) => { emitted.push(c); }, dlq);
    await n.process(dbzInsert(1));
    await n.flush(); // single event buffers until the tx boundary / flush
    expect(n.stats.dlq).toBe(0);
    expect(n.stats.emitted).toBe(1);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.source.db_id).toBe('kafel-dev-mysql');
  });

  it('malformed CDC event -> routed to DLQ, no CCE emitted (fail-closed; no fabrication)', async () => {
    const emitted: Cce[] = [];
    const dlq = new DlqService({ store: new InMemoryDlqStore(), alarms: new InMemoryDlqAlarmSink() });
    const n = makeNormalizer({ fidelity: HEALTHY }, (c) => { emitted.push(c); }, dlq);
    const bad = { ...dbzInsert(1), raw_native: 'not-an-object' };
    await n.process(bad);
    await n.flush();
    expect(n.stats.emitted).toBe(0);
    expect(n.stats.dlq).toBe(1);
    expect(emitted.length).toBe(0);
  });

  it('parsePkResolver: PK_MAP overrides; default is ["id"]', () => {
    const r = parsePkResolver('{"kafel.orders":["order_id"],"widgets":["sku"]}');
    expect(r('kafel', 'orders')).toEqual(['order_id']);
    expect(r('any', 'widgets')).toEqual(['sku']);
    expect(r('kafel', 'donations')).toEqual(['id']);
  });
});
