// Tests for heartbeat watermark / idle-vs-stalled (Epic E3 / EDAM-T022).
import { describe, it, expect } from 'vitest';
import { CompletenessWatcher } from '../src/completeness/watcher.js';

const iso = (ms: number) => new Date(ms).toISOString();

describe('CompletenessWatcher liveness (heartbeat watermark)', () => {
  it('is idle before any activity', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'db', stallTimeoutMs: 60000, idleThresholdMs: 20000 });
    expect(w.liveness(0)).toBe('idle');
  });

  it('is live right after a data event', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'db', stallTimeoutMs: 60000, idleThresholdMs: 20000 });
    w.observeEventActivity(iso(100000));
    expect(w.liveness(105000)).toBe('live');
  });

  it('is IDLE (not stalled) when heartbeats are current but no data flows', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'db', stallTimeoutMs: 60000, idleThresholdMs: 20000 });
    w.observeEventActivity(iso(100000));
    // 30s later: no data event, but a heartbeat arrives -> idle, not stalled.
    w.observeHeartbeat(iso(130000));
    expect(w.liveness(131000)).toBe('idle');
    expect(w.heartbeatTs).toBe(iso(130000));
  });

  it('is STALLED when neither data nor heartbeats arrive within the timeout', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'db', stallTimeoutMs: 60000, idleThresholdMs: 20000 });
    w.observeHeartbeat(iso(100000));
    expect(w.liveness(150000)).toBe('idle'); // within stall timeout
    expect(w.liveness(170000)).toBe('stalled'); // 70s with no activity
  });

  it('a fresh heartbeat recovers from would-be stall', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'db', stallTimeoutMs: 60000, idleThresholdMs: 20000 });
    w.observeHeartbeat(iso(100000));
    w.observeHeartbeat(iso(155000));
    expect(w.liveness(160000)).toBe('idle'); // not stalled — heartbeat kept it alive
  });
});
