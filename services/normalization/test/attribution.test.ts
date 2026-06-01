// Tests for attribution correlation (Epic E4 / EDAM-T034).
import { describe, it, expect } from 'vitest';
import { correlateActor, type DbAuditEventLike, type CorrelationQuery } from '../src/attribution.js';

const query: CorrelationQuery = {
  dbId: 'kafel-dev-mysql',
  commitTs: '2026-06-01T10:00:00.000Z',
  tables: ['donations'],
  windowMs: 5000,
};

const cand = (over: Partial<DbAuditEventLike>): DbAuditEventLike => ({
  audit_event_id: 'dbaudit:1',
  db_user: 'ops_admin',
  client_host: '10.0.0.5',
  connection_id: '338217',
  event_ts: '2026-06-01T10:00:01.000Z',
  objects: [{ schema: 'kafel', name: 'donations' }],
  ...over,
});

describe('correlateActor', () => {
  it('returns unattributed when there are no candidates (INV-2)', () => {
    expect(correlateActor(query, [])).toEqual({ attribution_confidence: 'unattributed' });
  });

  it('returns probable for a single time-window + table candidate', () => {
    const actor = correlateActor(query, [cand({})]);
    expect(actor.attribution_confidence).toBe('probable');
    expect(actor.db_user).toBe('ops_admin');
    expect(actor.audit_event_ref).toBe('dbaudit:1');
    expect(actor.correlation_basis).toEqual(['time_window', 'table']);
  });

  it('returns exact on a hard connection_id key match', () => {
    const actor = correlateActor({ ...query, connectionId: '338217' }, [cand({})]);
    expect(actor.attribution_confidence).toBe('exact');
    expect(actor.audit_event_ref).toBe('dbaudit:1');
  });

  it('returns unattributed when candidates are ambiguous', () => {
    const actor = correlateActor(query, [cand({ audit_event_id: 'a' }), cand({ audit_event_id: 'b', connection_id: '999' })]);
    expect(actor.attribution_confidence).toBe('unattributed');
  });

  it('returns unattributed when the audit feed is disabled (tamper indicator)', () => {
    const actor = correlateActor(query, [cand({ tamper_indicators: ['AUDIT_PLUGIN_DISABLED'] })]);
    expect(actor.attribution_confidence).toBe('unattributed');
  });

  it('excludes candidates outside the time window or touching other tables', () => {
    expect(correlateActor(query, [cand({ event_ts: '2026-06-01T11:00:00.000Z' })]).attribution_confidence).toBe('unattributed');
    expect(correlateActor(query, [cand({ objects: [{ schema: 'kafel', name: 'wallets' }] })]).attribution_confidence).toBe('unattributed');
  });
});
