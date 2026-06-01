// Tests for the transaction accumulator (Epic E4 / EDAM-T031).
import { describe, it, expect } from 'vitest';
import { TransactionAccumulator } from '../src/accumulator.js';
import type { NormalizedChangeEvent } from '@edam/cce-model';

function ev(txId: string | null, col: number, phase: NormalizedChangeEvent['snapshot_phase'] = 'streaming'): NormalizedChangeEvent {
  return {
    source: { db_id: 'db', engine: 'mysql', server_uuid: 's', schema: 'kafel' },
    tx_id: txId,
    commit_ts: '2026-06-01T10:00:00.000Z',
    ingest_ts: '2026-06-01T10:00:00.100Z',
    offset: { gtid: txId, binlog_file: 'f', binlog_pos: col },
    snapshot_phase: phase,
    change: { operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: col } }, before: { id: col }, after: { id: col, x: 1 } },
  };
}

describe('TransactionAccumulator', () => {
  it('groups changes that share a tx_id and flushes on boundary change', () => {
    const acc = new TransactionAccumulator();
    expect(acc.add(ev('g:1', 1))).toEqual([]); // buffered
    expect(acc.add(ev('g:1', 2))).toEqual([]); // same tx -> still buffered
    const completed = acc.add(ev('g:2', 3)); // new tx -> flush g:1
    expect(completed).toHaveLength(1);
    expect(completed[0]?.tx_id).toBe('g:1');
    expect(completed[0]?.changes).toHaveLength(2);
    const tail = acc.flush();
    expect(tail?.tx_id).toBe('g:2');
    expect(tail?.changes).toHaveLength(1);
  });

  it('emits snapshot reads (no GTID) as individual transactions', () => {
    const acc = new TransactionAccumulator();
    const a = acc.add(ev(null, 1, 'snapshot'));
    const b = acc.add(ev(null, 2, 'snapshot'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.tx_id).not.toBe(b[0]?.tx_id); // deterministic synthetic, distinct
    expect(acc.flush()).toBeNull();
  });

  it('flushes a buffered transaction explicitly', () => {
    const acc = new TransactionAccumulator();
    acc.add(ev('g:9', 1));
    expect(acc.flush()?.tx_id).toBe('g:9');
    expect(acc.flush()).toBeNull();
  });
});
