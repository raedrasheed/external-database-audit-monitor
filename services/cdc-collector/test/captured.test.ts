// Tests for CAPTURED record + bus + source decoding (Epic E2 / EDAM-T014).
import { describe, it, expect } from 'vitest';
import { buildCapturedRecord } from '../src/captured.js';
import { InMemoryBus } from '../src/bus.js';
import { decodeRedisEntry, InMemorySourceStream } from '../src/source-stream.js';
import { mysqlAdapter } from '../src/adapters/mysql.js';
import { mysqlUpdate } from './fixtures/debezium-events.js';

describe('buildCapturedRecord (I1)', () => {
  it('produces exactly the I1 shape with no CCE fields', () => {
    const rec = buildCapturedRecord(mysqlAdapter, mysqlUpdate, 'kafel-dev-mysql', '2026-06-01T10:22:31.480Z');
    expect(Object.keys(rec).sort()).toEqual(['captured_at', 'offset', 'raw_native', 'source']);
    expect(rec.source.table).toBe('donations');
    expect(rec.offset.gtid).toBe('3E11FA47-71CA-11E1-9E33-C80AA9429562:152');
    expect(rec.captured_at).toBe('2026-06-01T10:22:31.480Z');
    expect(rec.raw_native).toBe(mysqlUpdate.value); // raw native preserved losslessly
    // No fabricated downstream CCE fields.
    for (const k of ['fidelity', 'completeness', 'changes', 'evidence', 'actor', 'envelope_id']) {
      expect(k in rec).toBe(false);
    }
  });
});

describe('InMemoryBus', () => {
  it('publishes records and returns ids', async () => {
    const bus = new InMemoryBus();
    const rec = buildCapturedRecord(mysqlAdapter, mysqlUpdate, 'kafel-dev-mysql', 't');
    const id = await bus.publish(rec);
    expect(id).toBe('0');
    expect(bus.records).toHaveLength(1);
  });
});

describe('decodeRedisEntry', () => {
  it('decodes the explicit value/key layout', () => {
    const ev = decodeRedisEntry('kafel.kafel.donations', '5-0', [
      'key', '{"id":90211}', 'value', '{"op":"u","source":{"table":"donations"}}',
    ]);
    expect(ev.streamId).toBe('5-0');
    expect(ev.topic).toBe('kafel.kafel.donations');
    expect((ev.value as any).op).toBe('u');
    expect((ev.key as any).id).toBe(90211);
  });

  it('decodes the Debezium key-as-field-name layout', () => {
    const ev = decodeRedisEntry('kafel.kafel.wallets', '6-0', [
      '{"id":4412}', '{"op":"u","source":{"table":"wallets"}}',
    ]);
    expect((ev.value as any).source.table).toBe('wallets');
    expect((ev.key as any).id).toBe(4412);
  });
});

describe('InMemorySourceStream', () => {
  it('replays events then returns null', async () => {
    const s = new InMemorySourceStream([mysqlUpdate]);
    expect(await s.next()).toBe(mysqlUpdate);
    expect(await s.next()).toBeNull();
  });
});
