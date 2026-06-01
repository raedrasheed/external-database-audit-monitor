// Lag and stall monitoring (Epic E2 / EDAM-T015).
//
// LAG  — source-to-now delay exceeds a threshold (replication falling behind).
// STALL — no source activity (neither data nor heartbeat) for too long.
// Heartbeats count as activity (idle vs stalled), so a quiet-but-healthy stream
// does not trip the stall alarm.

import type { AlarmSink } from './alarms.js';
import type { Clock } from './clock.js';

export interface LagMonitorOptions {
  lagThresholdMs: number;
  stallTimeoutMs: number;
  clock: Clock;
  sink: AlarmSink;
}

export class LagMonitor {
  private lastActivityMs: number;

  constructor(private readonly opts: LagMonitorOptions) {
    this.lastActivityMs = opts.clock.nowMs();
  }

  /** Any source activity (data change OR heartbeat) resets the stall timer. */
  observeActivity(): void {
    this.lastActivityMs = this.opts.clock.nowMs();
  }

  /** Observe a data event's source timestamp and raise LAG if behind. */
  observeEvent(sourceTsMs: number | null): void {
    this.observeActivity();
    if (sourceTsMs === null) return;
    const lag = this.opts.clock.nowMs() - sourceTsMs;
    if (lag > this.opts.lagThresholdMs) {
      this.opts.sink.raise({
        kind: 'LAG',
        severity: lag > this.opts.lagThresholdMs * 3 ? 'high' : 'medium',
        message: `replication lag ${lag}ms exceeds threshold ${this.opts.lagThresholdMs}ms`,
        at: this.opts.clock.now(),
        details: { lagMs: lag, thresholdMs: this.opts.lagThresholdMs },
      });
    }
  }

  /** Raise STALL if no activity within the stall timeout. Returns true if stalled. */
  checkStall(): boolean {
    const idle = this.opts.clock.nowMs() - this.lastActivityMs;
    if (idle > this.opts.stallTimeoutMs) {
      this.opts.sink.raise({
        kind: 'STALL',
        severity: 'high',
        message: `no source activity for ${idle}ms exceeds stall timeout ${this.opts.stallTimeoutMs}ms`,
        at: this.opts.clock.now(),
        details: { idleMs: idle, stallTimeoutMs: this.opts.stallTimeoutMs },
      });
      return true;
    }
    return false;
  }
}
