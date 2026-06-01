// Integration tests for the DLQ service / quarantine API (Epic E5 / EDAM-T038).
import { describe, it, expect } from 'vitest';
import {
  DlqService,
  InMemoryDlqStore,
  InMemoryDlqAlarmSink,
  classifyFailure,
  type Clock,
} from '../src/index.js';

const clock: Clock = { now: () => '2026-06-01T10:00:00.000Z' };

function svc(maxRetries = 5) {
  const store = new InMemoryDlqStore();
  const alarms = new InMemoryDlqAlarmSink();
  const service = new DlqService({ store, alarms, clock, policy: { maxRetries } });
  return { service, store, alarms };
}

describe('classifyFailure', () => {
  it('infers categories from errors and defaults retryability', () => {
    expect(classifyFailure({ payload: 'x', error: new SyntaxError('Unexpected token') }))
      .toEqual({ category: 'MALFORMED_CDC_EVENT', retryable: false });
    expect(classifyFailure({ payload: 'x', error: new Error('no adapter for engine oracle') }))
      .toEqual({ category: 'UNSUPPORTED_ENGINE', retryable: false });
    expect(classifyFailure({ payload: 'x', error: new Error('schema validation failed: rule V5') }))
      .toEqual({ category: 'SCHEMA_VALIDATION_FAILURE', retryable: false });
    expect(classifyFailure({ payload: 'x', error: new Error('corrupt offset') }))
      .toEqual({ category: 'OFFSET_CORRUPTION', retryable: false });
    expect(classifyFailure({ payload: 'x', error: new Error('boom') }))
      .toEqual({ category: 'UNEXPECTED_EXCEPTION', retryable: true });
    expect(classifyFailure({ payload: 'x' }))
      .toEqual({ category: 'UNCLASSIFIED', retryable: false });
  });
});

describe('DlqService.record', () => {
  it('persists a malformed event (no loss) and quarantines + alarms', async () => {
    const { service, store, alarms } = svc();
    const item = await service.record({ engine: 'mysql', offset: 'g:1', payload: '{bad', error: new SyntaxError('boom') });
    expect(item.failure_category).toBe('MALFORMED_CDC_EVENT');
    expect(item.status).toBe('quarantined');
    expect(await store.get(item.event_id)).not.toBeNull(); // persisted
    expect(alarms.byKind('DLQ_ENQUEUE')).toHaveLength(1);
    expect(alarms.byKind('DLQ_QUARANTINE')).toHaveLength(1);
  });

  it('routes uncertain classification to quarantine + alarm', async () => {
    const { service, alarms } = svc();
    const item = await service.record({ engine: 'mysql', payload: { weird: true } });
    expect(item.failure_category).toBe('UNCLASSIFIED');
    expect(item.status).toBe('quarantined');
    expect(alarms.byKind('DLQ_ENQUEUE')[0]?.severity).toBe('high');
  });

  it('the same poison event increments retry_count in place (no duplicates)', async () => {
    const { service, store } = svc();
    const ctx = { engine: 'mysql', offset: 'g:1', payload: '{bad', error: new SyntaxError('boom') };
    const a = await service.record(ctx);
    const b = await service.record(ctx);
    expect(await store.count()).toBe(1); // one row
    expect(a.retry_count).toBe(0);
    expect(b.retry_count).toBe(1);
    expect(b.first_seen).toBe(a.first_seen);
  });

  it('caps retryable failures: quarantines at maxRetries (no infinite loop)', async () => {
    const { service, alarms } = svc(2);
    const ctx = { engine: 'mysql', offset: 'g:9', payload: { x: 1 }, error: new Error('transient boom') };
    const r0 = await service.record(ctx); // rc 0 -> retryable
    const r1 = await service.record(ctx); // rc 1 -> retryable
    const r2 = await service.record(ctx); // rc 2 >= max -> quarantined
    expect([r0.status, r1.status, r2.status]).toEqual(['retryable', 'retryable', 'quarantined']);
    expect(alarms.byKind('DLQ_QUARANTINE')).toHaveLength(1); // fires once on transition
  });

  it('is deterministic across service instances (same id for same input)', async () => {
    const s1 = svc();
    const s2 = svc();
    const ctx = { engine: 'mysql', offset: 'g:1', payload: { a: 1 }, error: new Error('boom') };
    const i1 = await s1.service.record(ctx);
    const i2 = await s2.service.record(ctx);
    expect(i1.event_id).toBe(i2.event_id);
    expect(i1.payload_hash).toBe(i2.payload_hash);
  });

  it('records every distinct failure (no event disappears)', async () => {
    const { service, store } = svc();
    await service.record({ engine: 'mysql', offset: 'g:1', payload: 'a', error: new SyntaxError('x') });
    await service.record({ engine: 'mysql', offset: 'g:2', payload: 'b', category: 'UNSUPPORTED_ENGINE' });
    await service.record({ engine: 'mariadb', offset: 'm:1', payload: 'c', category: 'SCHEMA_VALIDATION_FAILURE' });
    expect(await store.count()).toBe(3);
  });
});
