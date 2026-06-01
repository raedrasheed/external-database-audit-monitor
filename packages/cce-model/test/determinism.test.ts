// Determinism + global-ordering tests (Epic E4 / EDAM-T032).
import { describe, it, expect } from 'vitest';
import { buildCce, compareCce, orderCces } from '../src/index.js';
import { makeTx } from './build.test.js';

describe('CCE build determinism', () => {
  it('produces byte-identical hashes/ids across repeated builds', () => {
    const a = buildCce(makeTx());
    const b = buildCce(makeTx());
    expect(a.evidence.event_hash).toBe(b.evidence.event_hash);
    expect(a.envelope_id).toBe(b.envelope_id);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reproduces pinned golden hashes for the canonical transaction', () => {
    const c = buildCce(makeTx());
    expect(c.envelope_id).toBe('5eecc25e-8f27-5834-ad18-16c10571d033');
    expect(c.evidence.event_hash).toBe(
      'sha256:de7ffc6693fb34bdf447b5c3bf4aa1689cf6ee1535c75106b07dde2af2626d2b',
    );
    expect(c.evidence.row_hash).toBe(
      'sha256:b3ae4c06c9e9f2b8ce94830a4862e4ccef586f4cbcbba9c0feeafed459ff7c6d',
    );
  });

  it('is insensitive to NormalizedChange image key order (canonicalization)', () => {
    const a = buildCce(makeTx());
    const reordered = makeTx();
    reordered.changes[0]!.after = { status: 'approved', amount: '100000.00', id: 90211 };
    reordered.changes[0]!.before = { status: 'approved', amount: '100.00', id: 90211 };
    const b = buildCce(reordered);
    expect(b.evidence.event_hash).toBe(a.evidence.event_hash);
  });
});

describe('compareCce / orderCces (CCE §4.2 global order)', () => {
  it('orders by commit_ts then offset monotonic key', () => {
    const early = buildCce(makeTx());
    const late = buildCce(
      makeTx({ transaction: { tx_id: '3e11fa47-71ca-11e1-9e33-c80aa9429562:153', commit_ts: '2026-06-01T10:22:32.000Z', ingest_ts: '2026-06-01T10:22:32.000Z' }, offset: { gtid: '3e11fa47-71ca-11e1-9e33-c80aa9429562:153', binlog_file: 'mysql-bin.000042', binlog_pos: 100000, lsn: null, scn: null, resume_token: null } }),
    );
    expect(compareCce(early, late)).toBeLessThan(0);
    expect(orderCces([late, early]).map((c) => c.transaction.tx_id)).toEqual([
      early.transaction.tx_id,
      late.transaction.tx_id,
    ]);
  });

  it('tie-breaks equal commit_ts by GTID sequence number', () => {
    const ts = '2026-06-01T10:22:31.000Z';
    const a = buildCce(makeTx({ transaction: { tx_id: 'u:5', commit_ts: ts, ingest_ts: ts }, offset: { gtid: 'u:5' } }));
    const b = buildCce(makeTx({ transaction: { tx_id: 'u:9', commit_ts: ts, ingest_ts: ts }, offset: { gtid: 'u:9' } }));
    expect(compareCce(a, b)).toBeLessThan(0);
  });
});
