// Tests for operation mapping (TRUNCATE/DDL) + nullity (Epic E4 / EDAM-T027).
import { describe, it, expect } from 'vitest';
import { mapCapturedRecord, type CapturedRecord } from '../src/native-map.js';

const pk = (): string[] => ['id'];

function captured(value: unknown, table = 'donations'): CapturedRecord {
  return {
    raw_native: value,
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: 'srv', schema: 'kafel', table },
    offset: { gtid: 'g:1', binlog_file: 'f', binlog_pos: 1 },
    captured_at: '2026-06-01T10:00:00.000Z',
  };
}

describe('operation mapping + nullity (CCE §5)', () => {
  it('INSERT forces before=null and keeps after', () => {
    const ev = mapCapturedRecord(captured({ op: 'c', before: { stale: true }, after: { id: 1 }, source: { table: 'donations' } }), pk);
    expect(ev.change.operation).toBe('INSERT');
    expect(ev.change.before).toBeNull();
    expect(ev.change.after).toEqual({ id: 1 });
  });

  it('DELETE forces after=null and keeps before', () => {
    const ev = mapCapturedRecord(captured({ op: 'd', before: { id: 1 }, after: { ghost: true }, source: { table: 'donations' } }), pk);
    expect(ev.change.operation).toBe('DELETE');
    expect(ev.change.after).toBeNull();
    expect(ev.change.before).toEqual({ id: 1 });
  });

  it('maps TRUNCATE with no before/after and no primary_key', () => {
    const ev = mapCapturedRecord(captured({ op: 't', source: { table: 'audit_scratch' } }, 'audit_scratch'), pk);
    expect(ev.change.operation).toBe('TRUNCATE');
    expect(ev.change.before).toBeNull();
    expect(ev.change.after).toBeNull();
    expect(ev.change.object.primary_key).toBeUndefined();
  });

  it('maps a DDL schema-change event', () => {
    const ev = mapCapturedRecord(
      captured({ ddl: 'ALTER TABLE kafel.donations ADD COLUMN note VARCHAR(255)', source: { table: 'donations' } }),
      pk,
    );
    expect(ev.change.operation).toBe('DDL');
    expect(ev.change.ddl?.statement).toMatch(/ALTER TABLE/);
    expect(ev.change.before).toBeNull();
    expect(ev.change.after).toBeNull();
  });

  it('maps a DDL event even without a table', () => {
    const ev = mapCapturedRecord(captured({ ddl: 'CREATE TABLE kafel.x (id INT)', source: {} }, ''), pk);
    expect(ev.change.operation).toBe('DDL');
  });
});
