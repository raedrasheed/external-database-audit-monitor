// Tests for native -> normalized mapping (Epic E4 / EDAM-T025).
import { describe, it, expect } from 'vitest';
import { mapCapturedRecord, NormalizationError, type CapturedRecord } from '../src/native-map.js';

const pk = (_s: string, table: string): string[] =>
  table === 'user_roles' ? ['user_id', 'role_id'] : ['id'];

function captured(value: unknown, overrides: Partial<CapturedRecord> = {}): CapturedRecord {
  return {
    raw_native: value,
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: 'srv', schema: 'kafel', table: 'donations' },
    offset: { gtid: 'g:152', binlog_file: 'mysql-bin.000042', binlog_pos: 99812 },
    captured_at: '2026-06-01T10:22:31.480Z',
    ...overrides,
  };
}

describe('mapCapturedRecord', () => {
  it('maps an UPDATE with source/offset/before/after and primary_key', () => {
    const ev = mapCapturedRecord(
      captured({
        op: 'u',
        before: { id: 90211, amount: '100.00', status: 'approved' },
        after: { id: 90211, amount: '100000.00', status: 'approved' },
        source: { table: 'donations', ts_ms: 1748773351000, snapshot: 'false', version: '2.7.3' },
      }),
      pk,
    );
    expect(ev.change.operation).toBe('UPDATE');
    expect(ev.change.object).toEqual({ schema: 'kafel', name: 'donations', primary_key: { id: 90211 } });
    expect(ev.change.before).toEqual({ id: 90211, amount: '100.00', status: 'approved' });
    expect(ev.tx_id).toBe('g:152');
    expect(ev.commit_ts).toBe('2025-06-01T10:22:31.000Z'); // honest conversion of ts_ms
    expect(ev.ingest_ts).toBe('2026-06-01T10:22:31.480Z');
    expect(ev.snapshot_phase).toBe('streaming');
    expect(ev.source.engine_version).toBe('2.7.3');
  });

  it('maps INSERT (before forced null) and DELETE (after forced null)', () => {
    const ins = mapCapturedRecord(captured({ op: 'c', after: { id: 1, amount: '5.00' }, source: { table: 'donations' } }), pk);
    expect(ins.change.operation).toBe('INSERT');
    expect(ins.change.before).toBeNull();

    const del = mapCapturedRecord(
      captured({ op: 'd', before: { id: 5567, balance: '1320.00' }, source: { table: 'beneficiaries' } },
        { source: { db_id: 'd', engine: 'mysql', server_uuid: 's', schema: 'kafel', table: 'beneficiaries' } }),
      pk,
    );
    expect(del.change.operation).toBe('DELETE');
    expect(del.change.after).toBeNull();
    expect(del.change.object.primary_key).toEqual({ id: 5567 });
  });

  it('maps a snapshot read (op r) to INSERT with snapshot phase', () => {
    const ev = mapCapturedRecord(captured({ op: 'r', after: { id: 2, amount: '7.00' }, source: { table: 'donations', snapshot: 'true' } }), pk);
    expect(ev.change.operation).toBe('INSERT');
    expect(ev.snapshot_phase).toBe('snapshot');
  });

  it('extracts composite primary keys', () => {
    const ev = mapCapturedRecord(
      captured({ op: 'u', before: { user_id: 778, role_id: 2 }, after: { user_id: 778, role_id: 1 }, source: { table: 'user_roles' } },
        { source: { db_id: 'd', engine: 'mysql', server_uuid: 's', schema: 'kafel', table: 'user_roles' } }),
      pk,
    );
    expect(ev.change.object.primary_key).toEqual({ user_id: 778, role_id: 2 });
  });

  it('unwraps schema-wrapped Debezium values', () => {
    const ev = mapCapturedRecord(
      captured({ schema: {}, payload: { op: 'u', before: { id: 1 }, after: { id: 1, x: 2 }, source: { table: 'donations' } } }),
      pk,
    );
    expect(ev.change.operation).toBe('UPDATE');
  });

  it('throws NormalizationError on a malformed event (routed to DLQ by caller)', () => {
    expect(() => mapCapturedRecord(captured('not-an-object'), pk)).toThrow(NormalizationError);
    expect(() => mapCapturedRecord(captured({ before: {}, source: { table: 't' } }), pk)).toThrow(NormalizationError);
  });
});
