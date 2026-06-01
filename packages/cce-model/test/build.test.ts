// Tests for the CCE builder: grouping/seq + valid CCE output (Epic E4 / EDAM-T031).
import { describe, it, expect } from 'vitest';
import { buildCce, CceBuildError, type NormalizedTransaction } from '../src/index.js';

export function makeTx(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: '3e11fa47-71ca-11e1-9e33-c80aa9429562', schema: 'kafel' },
    transaction: { tx_id: '3e11fa47-71ca-11e1-9e33-c80aa9429562:152', commit_ts: '2026-06-01T10:22:31.000Z', ingest_ts: '2026-06-01T10:22:31.480Z' },
    offset: { gtid: '3e11fa47-71ca-11e1-9e33-c80aa9429562:152', binlog_file: 'mysql-bin.000042', binlog_pos: 99812, lsn: null, scn: null, resume_token: null },
    fidelity: { state: 'HEALTHY', source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg-test' } },
    completeness: { consumed_offset_key: '3e11fa47-71ca-11e1-9e33-c80aa9429562:152', gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [
      {
        operation: 'UPDATE',
        object: { schema: 'kafel', name: 'donations', primary_key: { id: 90211 } },
        before: { id: 90211, amount: '100.00', status: 'approved' },
        after: { id: 90211, amount: '100000.00', status: 'approved' },
      },
    ],
    ...overrides,
  };
}

describe('buildCce', () => {
  it('produces a valid CCE with statement_count and contiguous seq', () => {
    const tx = makeTx({
      changes: [
        { operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 90211 } }, before: { id: 90211, amount: '100.00' }, after: { id: 90211, amount: '100000.00' } },
        { operation: 'INSERT', object: { schema: 'kafel', name: 'donations', primary_key: { id: 5 } }, before: null, after: { id: 5, amount: '5.00' } },
      ],
    });
    const cce = buildCce(tx);
    expect(cce.schema_version).toBe('cce-1.0');
    expect(cce.kind).toBe('transaction');
    expect(cce.transaction.statement_count).toBe(2);
    expect(cce.changes.map((c) => c.seq)).toEqual([0, 1]);
    expect(cce.changes[0]?.field_changes?.[0]?.path).toEqual(['amount']);
    expect(cce.evidence.event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cce.evidence.row_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('masks sensitive fields in images and field_changes', () => {
    const tx = makeTx({
      changes: [
        {
          operation: 'DELETE',
          object: { schema: 'kafel', name: 'beneficiaries', primary_key: { id: 5567 } },
          before: { id: 5567, name: 'Aid Recipient A', national_id: '2011223344', balance: '1320.00' },
          after: null,
        },
      ],
    });
    const cce = buildCce(tx, { sensitiveFields: ['beneficiaries.name', 'beneficiaries.national_id'] });
    expect(JSON.stringify(cce)).not.toContain('Aid Recipient A');
    expect(JSON.stringify(cce)).not.toContain('2011223344');
    expect((cce.changes[0]?.before as any).name).toBe('***');
  });

  it('throws CceBuildError when the result would be invalid (no fabricated CCE)', () => {
    const tx = makeTx({ changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations' }, before: { id: 1, x: 1 }, after: { id: 1, x: 2 } }] });
    // No primary_key on a row op -> V6 fails.
    expect(() => buildCce(tx)).toThrow(CceBuildError);
  });
});
