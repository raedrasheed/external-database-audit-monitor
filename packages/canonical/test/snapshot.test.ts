// Snapshot identity helper tests (CCE-AMD-001 Rev 4 §2/§3/§4).
import { describe, it, expect } from 'vitest';
import {
  snapshotEpochId,
  rowKeyHash,
  snapshotTxId,
  snapshotConsumedOffsetKey,
} from '../src/index.js';

const base = {
  db_id: 'kafel-dev-mysql',
  server_uuid: '386be27f-0000-0000-0000-000000000001',
  snapshot_start_binlog_file: 'mysql-bin.000003',
  snapshot_start_binlog_pos: 4096,
  snapshot_start_ts: '2026-06-01T10:00:00.000Z',
};

describe('snapshotEpochId', () => {
  it('is deterministic for identical inputs (replay-stable)', () => {
    expect(snapshotEpochId(base)).toBe(snapshotEpochId({ ...base }));
  });

  it('has the snap-<16hex> shape', () => {
    expect(snapshotEpochId(base)).toMatch(/^snap-[0-9a-f]{16}$/);
  });

  it('idle-DB re-snapshot: same watermark, different start_ts => different epoch (HIGH-2)', () => {
    const later = snapshotEpochId({ ...base, snapshot_start_ts: '2026-06-01T12:00:00.000Z' });
    expect(later).not.toBe(snapshotEpochId(base));
  });

  it('advanced watermark => different epoch', () => {
    expect(snapshotEpochId({ ...base, snapshot_start_binlog_pos: 8192 })).not.toBe(snapshotEpochId(base));
  });
});

describe('rowKeyHash / snapshotTxId (F4: collision-free)', () => {
  const epoch = snapshotEpochId(base);

  it('distinct PKs => distinct row keys', () => {
    const a = rowKeyHash({ schema: 'kafel', name: 'donations', primary_key: { id: 1 } });
    const b = rowKeyHash({ schema: 'kafel', name: 'donations', primary_key: { id: 2 } });
    expect(a).not.toBe(b);
  });

  it('delimiter-bearing PK values cannot alias (canonical-tuple hashing)', () => {
    // Naive "schema:table:pk" joining would alias these; canonical hashing must not.
    const a = snapshotTxId(epoch, { schema: 'kafel', name: 'donations', primary_key: { ref: 'a:b' } });
    const b = snapshotTxId(epoch, { schema: 'kafel', name: 'donations', primary_key: { ref: 'a', x: 'b' } });
    expect(a).not.toBe(b);
  });

  it('tx_id joins fixed-format tokens only', () => {
    expect(snapshotTxId(epoch, { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }))
      .toMatch(/^snapshot:snap-[0-9a-f]{16}:[0-9a-f]{64}$/);
  });
});

describe('snapshotConsumedOffsetKey', () => {
  it('is the epoch key', () => {
    expect(snapshotConsumedOffsetKey('snap-deadbeefdeadbeef')).toBe('snapshot-epoch:snap-deadbeefdeadbeef');
  });
});
