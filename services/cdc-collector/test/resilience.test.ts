// Tests for backoff/reconnect + lag/stall (Epic E2 / EDAM-T015).
import { describe, it, expect } from 'vitest';
import { nextBackoff, runWithReconnect } from '../src/backoff.js';
import { LagMonitor } from '../src/lag.js';
import { InMemoryAlarmSink } from '../src/alarms.js';
import { FakeClock } from '../src/clock.js';

describe('nextBackoff', () => {
  it('grows exponentially and caps at maxMs', () => {
    const o = { baseMs: 1000, maxMs: 8000, factor: 2 };
    expect(nextBackoff(0, o)).toBe(1000);
    expect(nextBackoff(1, o)).toBe(2000);
    expect(nextBackoff(2, o)).toBe(4000);
    expect(nextBackoff(3, o)).toBe(8000);
    expect(nextBackoff(10, o)).toBe(8000); // capped
  });
});

describe('runWithReconnect', () => {
  it('retries with backoff on failure and raises RECONNECT alarms, then succeeds', async () => {
    const alarms = new InMemoryAlarmSink();
    const clock = new FakeClock(0);
    const waits: number[] = [];
    let attempts = 0;

    await runWithReconnect(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('connection lost');
      },
      {
        alarms,
        clock,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
      { baseMs: 100, maxMs: 1000, factor: 2 },
    );

    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 200]); // two failures -> two backoffs
    expect(alarms.byKind('RECONNECT')).toHaveLength(2);
  });

  it('stops promptly when shouldStop is set', async () => {
    const alarms = new InMemoryAlarmSink();
    const clock = new FakeClock(0);
    let stop = false;
    let runs = 0;
    await runWithReconnect(
      async () => {
        runs += 1;
        stop = true;
        throw new Error('boom');
      },
      { alarms, clock, sleep: async () => {}, shouldStop: () => stop },
    );
    expect(runs).toBe(1);
  });
});

describe('LagMonitor', () => {
  it('raises LAG when source timestamp is behind the threshold', () => {
    const alarms = new InMemoryAlarmSink();
    const clock = new FakeClock(100000);
    const m = new LagMonitor({ lagThresholdMs: 30000, stallTimeoutMs: 60000, clock, sink: alarms });
    m.observeEvent(100000 - 5000); // 5s lag -> ok
    expect(alarms.byKind('LAG')).toHaveLength(0);
    m.observeEvent(100000 - 45000); // 45s lag -> LAG
    expect(alarms.byKind('LAG')).toHaveLength(1);
  });

  it('raises STALL only after the stall timeout with no activity', () => {
    const alarms = new InMemoryAlarmSink();
    const clock = new FakeClock(0);
    const m = new LagMonitor({ lagThresholdMs: 30000, stallTimeoutMs: 60000, clock, sink: alarms });
    clock.advance(30000);
    expect(m.checkStall()).toBe(false); // within timeout
    m.observeActivity(); // heartbeat keeps it alive
    clock.advance(30000);
    expect(m.checkStall()).toBe(false);
    clock.advance(61000);
    expect(m.checkStall()).toBe(true);
    expect(alarms.byKind('STALL')).toHaveLength(1);
  });
});
