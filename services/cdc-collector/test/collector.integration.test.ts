// Integration test: the CDC collector wired from its components with injected
// fakes (no live infra). Exercises emit-before-commit ordering, handoff, lag,
// and heartbeat handling end to end (Epic E2 / EDAM-T016).
import { describe, it, expect } from 'vitest';
import { CdcCollector } from '../src/collector.js';
import { InMemoryBus } from '../src/bus.js';
import { InMemoryOffsetStore } from '../src/offset-store.js';
import { InMemorySourceStream } from '../src/source-stream.js';
import { InMemoryAlarmSink } from '../src/alarms.js';
import { HandoffTracker, type HandoffEvent } from '../src/handoff.js';
import { LagMonitor } from '../src/lag.js';
import { FakeClock } from '../src/clock.js';
import { mysqlAdapter } from '../src/adapters/mysql.js';
import {
  mysqlSnapshotRead,
  mysqlSnapshotLast,
  mysqlUpdate,
  heartbeat,
} from './fixtures/debezium-events.js';

function build(clockMs: number) {
  const bus = new InMemoryBus();
  const offsets = new InMemoryOffsetStore();
  const alarms = new InMemoryAlarmSink();
  const clock = new FakeClock(clockMs);
  const order: string[] = [];

  // Instrument publish/commit to verify ordering.
  const instrumentedBus = {
    records: bus.records,
    publish: async (r: any) => {
      order.push('publish');
      return bus.publish(r);
    },
  };
  const instrumentedOffsets = {
    load: (k: string) => offsets.load(k),
    commit: async (s: any) => {
      order.push('commit');
      return offsets.commit(s);
    },
    snapshot: (k: string) => offsets.snapshot(k),
  };

  const handoffEvents: HandoffEvent[] = [];
  const collector = new CdcCollector({
    source: new InMemorySourceStream([mysqlSnapshotRead, mysqlSnapshotLast, mysqlUpdate, heartbeat]),
    bus: instrumentedBus as any,
    offsets: instrumentedOffsets as any,
    adapter: mysqlAdapter,
    clock,
    alarms,
    handoff: new HandoffTracker(),
    lag: new LagMonitor({ lagThresholdMs: 30000, stallTimeoutMs: 60000, clock, sink: alarms }),
    dbId: 'kafel-dev-mysql',
    onHandoff: (e) => handoffEvents.push(e),
  });

  return { collector, bus, offsets: instrumentedOffsets, alarms, order, handoffEvents };
}

describe('CdcCollector integration', () => {
  it('emits CAPTURED for data changes, skips heartbeats, and advances the offset', async () => {
    const { collector, bus, offsets } = build(1748773351000);
    const processed = await collector.pump();

    expect(processed).toBe(4); // 3 data + 1 heartbeat consumed
    expect(bus.records).toHaveLength(3); // only data changes emitted
    // Offset advanced to the last data change (the streaming UPDATE).
    expect((await offsets.load('kafel-dev-mysql'))?.gtid).toBe(
      '3E11FA47-71CA-11E1-9E33-C80AA9429562:152',
    );
  });

  it('publishes to the bus BEFORE committing the offset (at-least-once)', async () => {
    const { collector, order } = build(1748773351000);
    await collector.pump();
    // For every committed event, a publish precedes it.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe('publish');
      expect(order[i + 1]).toBe('commit');
    }
  });

  it('records snapshot->stream handoff markers', async () => {
    const { collector, handoffEvents } = build(1748773351000);
    await collector.pump();
    const types = handoffEvents.map((e) => e.type);
    expect(types).toContain('snapshot_start');
    expect(types).toContain('snapshot_complete');
    expect(types).toContain('streaming_resumed');
  });

  it('raises a LAG alarm when the source is behind the threshold', async () => {
    // Clock far ahead of the events' source ts_ms -> large lag.
    const { collector, alarms } = build(1748773351000 + 120000);
    await collector.pump();
    expect(alarms.byKind('LAG').length).toBeGreaterThan(0);
  });

  it('treats heartbeats as activity (no stall) and never emits them', async () => {
    const { collector, bus } = build(1748773351000);
    const r = await collector.processEvent(heartbeat);
    expect(r).toBe('heartbeat');
    expect(bus.records).toHaveLength(0);
  });
});
