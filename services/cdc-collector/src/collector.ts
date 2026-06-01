// CDC Collector orchestration (Epic E2 / EDAM-T016).
//
// Ties the pieces together: read a raw event -> select the engine adapter ->
// build the CAPTURED record -> PUBLISH to the bus (durable handoff) -> THEN
// advance the durable offset -> track snapshot/stream handoff -> update lag.
//
// The publish-before-commit order is the at-least-once guarantee (T012): if the
// process dies after publish but before commit, the event is re-read and
// re-published on restart — never silently lost. The collector NEVER writes to
// the monitored database (INV-1); it only reads Debezium's output and writes to
// EDAM's own bus/state.

import type { EngineAdapter, RawSourceEvent } from './adapters/types.js';
import type { Bus } from './bus.js';
import type { OffsetStore } from './offset-store.js';
import type { Clock } from './clock.js';
import type { AlarmSink } from './alarms.js';
import type { HandoffEvent } from './handoff.js';
import { HandoffTracker } from './handoff.js';
import { LagMonitor } from './lag.js';
import { buildCapturedRecord } from './captured.js';

export type ProcessResult = 'event' | 'heartbeat' | 'idle';

export interface CollectorDeps {
  source: { next(): Promise<RawSourceEvent | null> };
  bus: Bus;
  offsets: OffsetStore;
  adapter: EngineAdapter;
  clock: Clock;
  alarms: AlarmSink;
  handoff: HandoffTracker;
  lag: LagMonitor;
  dbId: string;
  onHandoff?: (event: HandoffEvent) => void;
}

export class CdcCollector {
  constructor(private readonly deps: CollectorDeps) {}

  async processEvent(ev: RawSourceEvent): Promise<ProcessResult> {
    const { adapter, lag } = this.deps;

    if (adapter.isHeartbeat(ev)) {
      lag.observeActivity(); // heartbeat = liveness, distinguishes idle from stalled
      return 'heartbeat';
    }
    if (!adapter.isDataChange(ev)) {
      return 'idle';
    }

    const phase = adapter.snapshotPhase(ev);
    const capturedAt = this.deps.clock.now();
    const record = buildCapturedRecord(adapter, ev, this.deps.dbId, capturedAt);

    // (1) Durable handoff to the bus FIRST.
    await this.deps.bus.publish(record);

    // (2) Only then advance the durable offset (at-least-once on restart).
    await this.deps.offsets.commit({
      streamKey: this.deps.dbId,
      gtid: record.offset.gtid,
      binlogFile: record.offset.binlog_file,
      binlogPos: record.offset.binlog_pos,
      phase,
      sourceStreamId: ev.streamId ?? null,
      updatedAt: capturedAt,
    });

    // (3) Snapshot->stream handoff markers (T013).
    for (const event of this.deps.handoff.observe(phase, record.offset, capturedAt)) {
      this.deps.onHandoff?.(event);
    }

    // (4) Lag tracking (T015).
    lag.observeEvent(adapter.sourceTimestampMs(ev));
    return 'event';
  }

  /** Process up to `maxEvents` currently-available events; returns the count. */
  async pump(maxEvents = Number.POSITIVE_INFINITY): Promise<number> {
    let n = 0;
    while (n < maxEvents) {
      const ev = await this.deps.source.next();
      if (ev === null) break;
      await this.processEvent(ev);
      n += 1;
    }
    return n;
  }
}
