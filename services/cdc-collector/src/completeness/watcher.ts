// Completeness Watcher (Epic E3 / EDAM-T021..T024).
//
// Tracks the consumed GTID set, detects continuity gaps, distinguishes an idle
// stream from a stalled one (heartbeat watermark), computes snapshot_phase, and
// produces CompletenessUpdate records (CCE §6.5 shape) that Normalization (E4)
// attaches to CCE `completeness`. INV-2: gap_detected reflects real analysis;
// it is never forced false.

import type { Engine } from '../engine.js';
import type { SnapshotPhase } from '../adapters/types.js';
import { GtidSet, getCodec, type GtidCodec, type GtidInterval } from './gtid.js';

export interface GapResult {
  gap_detected: boolean;
  internal_gap_keys: string[];
  missing_below_watermark: GtidInterval[];
}

export type Liveness = 'live' | 'idle' | 'stalled';

export interface CompletenessWatcherOptions {
  engine: Engine;
  dbId: string;
  /** No activity (data OR heartbeat) for longer than this => stalled. */
  stallTimeoutMs?: number;
  /** No data events (but heartbeats current) for longer than this => idle. */
  idleThresholdMs?: number;
}

export class CompletenessWatcher {
  private readonly codec: GtidCodec;
  private readonly consumed = new GtidSet();
  private consumedOffsetKey: string | null = null;
  private readonly stallTimeoutMs: number;
  private readonly idleThresholdMs: number;

  private lastHeartbeatIso: string | null = null;
  private lastActivityMs: number | null = null;
  private lastEventMs: number | null = null;

  constructor(private readonly opts: CompletenessWatcherOptions) {
    this.codec = getCodec(opts.engine);
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 60000;
    this.idleThresholdMs = opts.idleThresholdMs ?? 20000;
  }

  private markActivity(atIso: string): void {
    const ms = Date.parse(atIso);
    if (Number.isFinite(ms)) {
      this.lastActivityMs = this.lastActivityMs === null ? ms : Math.max(this.lastActivityMs, ms);
    }
  }

  /** Heartbeat watermark — keeps a quiet-but-healthy stream from looking stalled. */
  observeHeartbeat(atIso: string): void {
    this.lastHeartbeatIso = atIso;
    this.markActivity(atIso);
  }

  /** Data-event activity (separate from gtid tracking). */
  observeEventActivity(atIso: string): void {
    const ms = Date.parse(atIso);
    if (Number.isFinite(ms)) this.lastEventMs = ms;
    this.markActivity(atIso);
  }

  get heartbeatTs(): string | null {
    return this.lastHeartbeatIso;
  }

  /**
   * Distinguish a healthy-but-quiet stream (idle) from a stalled one using the
   * heartbeat/activity watermark. Heartbeats count as activity.
   */
  liveness(nowMs: number): Liveness {
    if (this.lastActivityMs === null) return 'idle'; // nothing observed yet
    if (nowMs - this.lastActivityMs > this.stallTimeoutMs) return 'stalled';
    if (this.lastEventMs === null) return 'idle'; // heartbeats only
    if (nowMs - this.lastEventMs > this.idleThresholdMs) return 'idle';
    return 'live';
  }

  /** Record a consumed transaction's GTID (called per processed data event). */
  observeConsumed(gtid: string | null): void {
    if (!gtid) return;
    this.consumed.addToken(this.codec, gtid);
    this.consumedOffsetKey = gtid;
  }

  consumedSetString(): string {
    return this.consumed.toString();
  }

  get lastConsumedOffsetKey(): string | null {
    return this.consumedOffsetKey;
  }

  /**
   * Compute gap status: an internal hole in the consumed set, and (if the
   * source executed set is provided) gtids at/below our watermark that we
   * never consumed. gtids ABOVE our watermark are lag, not a gap.
   */
  computeGap(sourceExecuted?: string | null): GapResult {
    const internal = this.consumed.internalGapKeys();
    let missing: GtidInterval[] = [];
    if (sourceExecuted) {
      const source = GtidSet.parse(this.codec, sourceExecuted);
      missing = this.consumed.missingBelowWatermark(source);
    }
    return {
      gap_detected: internal.length > 0 || missing.length > 0,
      internal_gap_keys: internal,
      missing_below_watermark: missing,
    };
  }
}

export type { SnapshotPhase };
