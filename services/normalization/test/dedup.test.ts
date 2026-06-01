// Tests for the stream guard: idempotency + V14/V15 (Epic E4 / EDAM-T036).
import { describe, it, expect } from 'vitest';
import { CceStreamGuard } from '../src/dedup.js';
import { buildCce, type NormalizedTransaction } from '@edam/cce-model';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';

function tx(seq: number, amount: string, ingest: string): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: ingest, ingest_ts: ingest },
    offset: { gtid: id, binlog_file: 'f', binlog_pos: seq, lsn: null, scn: null, resume_token: null },
    fidelity: { state: 'HEALTHY', source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } },
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount } }],
  };
}

describe('CceStreamGuard', () => {
  it('emits a new CCE, then treats an identical re-delivery as a DUPLICATE (idempotent)', () => {
    const guard = new CceStreamGuard();
    const cce = buildCce(tx(1, '2.00', '2026-06-01T10:00:00.000Z'));
    expect(guard.check(cce).action).toBe('EMIT');
    expect(guard.check(cce).action).toBe('DUPLICATE'); // replay-safe
  });

  it('flags a duplicate envelope_id with a different event_hash as an INTEGRITY_VIOLATION (V15)', () => {
    const guard = new CceStreamGuard();
    const a = buildCce(tx(1, '2.00', '2026-06-01T10:00:00.000Z'));
    // Same tx_id (-> same envelope_id) but different content -> different hash.
    const b = buildCce(tx(1, '999.00', '2026-06-01T10:00:00.000Z'));
    expect(a.envelope_id).toBe(b.envelope_id);
    expect(guard.check(a).action).toBe('EMIT');
    const r = guard.check(b);
    expect(r.action).toBe('INTEGRITY_VIOLATION');
    expect(r.violations.some((v) => v.rule === 'V15')).toBe(true);
  });

  it('reports a non-monotonic ingest (V14) but still emits the event', () => {
    const guard = new CceStreamGuard();
    guard.check(buildCce(tx(1, '2.00', '2026-06-01T10:00:00.000Z')));
    const earlier = guard.check(buildCce(tx(2, '3.00', '2026-06-01T09:00:00.000Z')));
    expect(earlier.action).toBe('EMIT');
    expect(earlier.violations.some((v) => v.rule === 'V14')).toBe(true);
  });
});
