// Tests for event_hash / row_hash verification + chaining (Epic E4 / EDAM-T035).
import { describe, it, expect } from 'vitest';
import { buildCce, verifyCce, recomputeEventHash } from '../src/index.js';
import { GENESIS_ROW_HASH } from '@edam/canonical';
import { makeTx } from './build.test.js';

describe('verifyCce', () => {
  it('verifies a freshly built CCE (event_hash + row_hash over the canonical core)', () => {
    const cce = buildCce(makeTx());
    expect(verifyCce(cce)).toEqual({ event_hash_ok: true, row_hash_ok: true });
    expect(recomputeEventHash(cce)).toBe(cce.evidence.event_hash);
    expect(cce.evidence.prev_row_hash).toBe(GENESIS_ROW_HASH); // genesis when no prev
  });

  it('detects a tampered event_hash', () => {
    const cce = buildCce(makeTx());
    const tampered = { ...cce, evidence: { ...cce.evidence, event_hash: 'sha256:' + '0'.repeat(64) } };
    const v = verifyCce(tampered);
    expect(v.event_hash_ok).toBe(false);
  });

  it('detects a tampered core (recomputed hash no longer matches)', () => {
    const cce = buildCce(makeTx());
    const tampered = structuredClone(cce);
    (tampered.changes[0]!.after as any).amount = '999999.99';
    expect(verifyCce(tampered).event_hash_ok).toBe(false);
  });

  it('chains row_hash across transactions via prevRowHash', () => {
    const a = buildCce(makeTx());
    const b = buildCce(
      makeTx({ transaction: { tx_id: 'u:153', commit_ts: '2026-06-01T10:22:32.000Z', ingest_ts: '2026-06-01T10:22:32.000Z' }, offset: { gtid: 'u:153' } }),
      { prevRowHash: a.evidence.row_hash },
    );
    expect(b.evidence.prev_row_hash).toBe(a.evidence.row_hash);
    expect(verifyCce(b)).toEqual({ event_hash_ok: true, row_hash_ok: true });
    expect(b.evidence.row_hash).not.toBe(a.evidence.row_hash);
  });
});
