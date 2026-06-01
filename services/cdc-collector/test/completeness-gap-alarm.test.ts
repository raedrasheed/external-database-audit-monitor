// Tests for gap -> degraded + alarm (Epic E3 / EDAM-T023).
import { describe, it, expect } from 'vitest';
import { CompletenessWatcher } from '../src/completeness/watcher.js';
import { InMemoryAlarmSink } from '../src/alarms.js';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';

describe('CompletenessWatcher.checkGap', () => {
  it('raises a CRITICAL COMPLETENESS_GAP alarm on an internal hole', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    const alarms = new InMemoryAlarmSink();
    for (const n of [1, 2, 4, 5]) w.observeConsumed(`${UUID}:${n}`); // missing 3
    const r = w.checkGap(null, alarms, '2026-06-01T10:00:00.000Z');
    expect(r.gap_detected).toBe(true);
    expect(alarms.byKind('COMPLETENESS_GAP').some((a) => a.severity === 'critical')).toBe(true);
  });

  it('raises no alarm when there is no gap (no fabrication)', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    const alarms = new InMemoryAlarmSink();
    for (let n = 1; n <= 5; n++) w.observeConsumed(`${UUID}:${n}`);
    const r = w.checkGap(`${UUID}:1-10`, alarms, '2026-06-01T10:00:00.000Z'); // source ahead = lag
    expect(r.gap_detected).toBe(false);
    expect(alarms.alarms).toHaveLength(0);
  });

  it('deduplicates a persistent gap (one alarm per signature)', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    const alarms = new InMemoryAlarmSink();
    for (const n of [1, 2, 4, 5]) w.observeConsumed(`${UUID}:${n}`);
    w.checkGap(null, alarms, '2026-06-01T10:00:00.000Z');
    w.checkGap(null, alarms, '2026-06-01T10:00:05.000Z');
    expect(alarms.byKind('COMPLETENESS_GAP')).toHaveLength(1);
  });

  it('detects a source gtid we skipped below the watermark', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    const alarms = new InMemoryAlarmSink();
    // consume 1,2,5 (skip 3,4) then compare to source 1-10.
    for (const n of [1, 2, 5]) w.observeConsumed(`${UUID}:${n}`);
    const r = w.checkGap(`${UUID}:1-10`, alarms, '2026-06-01T10:00:00.000Z');
    expect(r.gap_detected).toBe(true);
    expect(alarms.byKind('COMPLETENESS_GAP').length).toBeGreaterThan(0);
  });
});
