// Tests for DLQ metrics + depth alarm (Epic E5 / EDAM-T040).
import { describe, it, expect } from 'vitest';
import {
  collectMetrics,
  DlqDepthMonitor,
  DlqService,
  InMemoryDlqStore,
  InMemoryDlqAlarmSink,
  type Clock,
} from '../src/index.js';

const clock: Clock = { now: () => '2026-06-01T10:00:00.000Z' };

describe('collectMetrics', () => {
  it('counts depth, status, category, and total occurrences', async () => {
    const store = new InMemoryDlqStore();
    const alarms = new InMemoryDlqAlarmSink();
    const service = new DlqService({ store, alarms, clock, policy: { maxRetries: 2 } });

    await service.record({ engine: 'mysql', offset: 'g:1', payload: 'a', error: new SyntaxError('x') }); // malformed, quarantined
    await service.record({ engine: 'mysql', offset: 'g:2', payload: 'b', category: 'UNSUPPORTED_ENGINE' }); // quarantined
    // a retryable event recorded twice -> retry_count 1, status retryable, 2 occurrences
    const ctx = { engine: 'mysql', offset: 'g:3', payload: { x: 1 }, error: new Error('transient') };
    await service.record(ctx);
    await service.record(ctx);

    const m = await collectMetrics(store);
    expect(m.depth).toBe(3); // 3 distinct events
    expect(m.quarantined).toBe(2);
    expect(m.retryable).toBe(1);
    expect(m.totalOccurrences).toBe(1 + 1 + 2); // g:1(1) + g:2(1) + g:3(2)
    expect(m.byCategory.MALFORMED_CDC_EVENT).toBe(1);
    expect(m.byCategory.UNSUPPORTED_ENGINE).toBe(1);
    expect(m.byCategory.UNEXPECTED_EXCEPTION).toBe(1);
  });
});

describe('DlqDepthMonitor', () => {
  it('raises DLQ_DEPTH when depth exceeds the threshold (default 0 = any item)', async () => {
    const store = new InMemoryDlqStore();
    const alarms = new InMemoryDlqAlarmSink();
    const service = new DlqService({ store, alarms, clock });
    await service.record({ engine: 'mysql', offset: 'g:1', payload: 'a', error: new SyntaxError('x') });

    const monitor = new DlqDepthMonitor(0, alarms);
    const fired = monitor.check(await collectMetrics(store), clock.now());
    expect(fired).toBe(true);
    expect(alarms.byKind('DLQ_DEPTH')).toHaveLength(1);
    expect(alarms.byKind('DLQ_DEPTH')[0]?.severity).toBe('high'); // quarantined > 0
  });

  it('does not alarm when depth is within the threshold', async () => {
    const store = new InMemoryDlqStore();
    const alarms = new InMemoryDlqAlarmSink();
    const monitor = new DlqDepthMonitor(5, alarms);
    expect(monitor.check(await collectMetrics(store), clock.now())).toBe(false);
    expect(alarms.byKind('DLQ_DEPTH')).toHaveLength(0);
  });
});
