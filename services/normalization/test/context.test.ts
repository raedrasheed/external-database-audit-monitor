// Tests for fidelity/completeness attachment (Epic E4 / EDAM-T026).
import { describe, it, expect } from 'vitest';
import { assembleTransaction, combineFidelity } from '../src/context.js';
import { buildCce, type NormalizedFidelity, type NormalizedCompleteness } from '@edam/cce-model';
import type { GroupedTransaction } from '../src/accumulator.js';

const healthy: NormalizedFidelity = {
  state: 'HEALTHY',
  source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg-1' },
};
const noGap: NormalizedCompleteness = { consumed_offset_key: 'u:1', gap_detected: false, snapshot_phase: 'streaming' };
const gap: NormalizedCompleteness = { consumed_offset_key: 'u:1', gap_detected: true, snapshot_phase: 'streaming' };

const group: GroupedTransaction = {
  source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: 'u', schema: 'kafel' },
  tx_id: 'u:1',
  commit_ts: '2026-06-01T10:00:00.000Z',
  ingest_ts: '2026-06-01T10:00:00.100Z',
  offset: { gtid: 'u:1', binlog_file: 'f', binlog_pos: 1 },
  snapshot_phase: 'streaming',
  changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }],
};

describe('combineFidelity (EDAM v2 §4.3)', () => {
  it('HEALTHY attestation + no gap stays HEALTHY', () => {
    expect(combineFidelity(healthy, noGap).state).toBe('HEALTHY');
  });
  it('HEALTHY attestation + gap becomes DEGRADED', () => {
    const f = combineFidelity(healthy, gap);
    expect(f.state).toBe('DEGRADED');
    expect(f.degraded_reason).toMatch(/gap/);
  });
  it('missing attestation is DEGRADED, never HEALTHY (INV-2)', () => {
    expect(combineFidelity(null, noGap).state).toBe('DEGRADED');
    expect(combineFidelity(null, noGap).source_config.config_snapshot_id).toBe('unattested');
  });
  it('missing completeness is DEGRADED with an honest reason', () => {
    const f = combineFidelity(healthy, null);
    expect(f.state).toBe('DEGRADED');
    expect(f.degraded_reason).toMatch(/completeness not attested/);
  });
});

describe('assembleTransaction', () => {
  it('produces a buildable NormalizedTransaction (HEALTHY path)', () => {
    const tx = assembleTransaction(group, healthy, noGap, { attribution_confidence: 'unattributed' });
    expect(tx.fidelity.state).toBe('HEALTHY');
    expect(tx.completeness.gap_detected).toBe(false);
    expect(() => buildCce(tx)).not.toThrow();
  });

  it('falls back commit_ts to ingest_ts when the source omitted it', () => {
    const tx = assembleTransaction({ ...group, commit_ts: null }, healthy, noGap, { attribution_confidence: 'unattributed' });
    expect(tx.transaction.commit_ts).toBe(group.ingest_ts);
  });

  it('a gap produces a DEGRADED, still-buildable CCE', () => {
    const tx = assembleTransaction(group, healthy, gap, { attribution_confidence: 'unattributed' });
    const cce = buildCce(tx);
    expect(cce.fidelity.state).toBe('DEGRADED');
    expect(cce.completeness.gap_detected).toBe(true);
  });
});
