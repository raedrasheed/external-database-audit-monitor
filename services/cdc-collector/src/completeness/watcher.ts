// Completeness Watcher (Epic E3 / EDAM-T021..T024).
//
// Tracks the consumed GTID set, detects continuity gaps, distinguishes an idle
// stream from a stalled one (heartbeat watermark), computes snapshot_phase, and
// produces CompletenessUpdate records (CCE §6.5 shape) that Normalization (E4)
// attaches to CCE `completeness`. INV-2: gap_detected reflects real analysis;
// it is never forced false.

import type { Engine } from '../engine.js';
import type { SnapshotPhase } from '../adapters/types.js';
import type { AlarmSink } from '../alarms.js';
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

  private currentPhase: SnapshotPhase = 'streaming';

  observePhase(phase: SnapshotPhase): void {
    this.currentPhase = phase;
  }

  get snapshotPhase(): SnapshotPhase {
    return this.currentPhase;
  }

  /** Main per-event entry: track gtid, phase, and activity together. */
  observeEvent(args: { gtid: string | null; phase: SnapshotPhase; at: string }): void {
    this.observePhase(args.phase);
    // GTID continuity is meaningful for streamed transactions; snapshot reads
    // carry no GTID and are skipped by observeConsumed(null).
    this.observeConsumed(args.gtid);
    this.observeEventActivity(args.at);
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

  private readonly alarmedGaps = new Set<string>();

  /**
   * Compute the gap and raise a CRITICAL COMPLETENESS_GAP alarm for any NEW gap
   * (deduplicated by signature so a persistent gap does not spam). A detected
   * gap degrades completeness (gap_detected=true), which Normalization (E4)
   * reflects as fidelity DEGRADED (EDAM v2 §4.3). INV-2: never forced false.
   */
  checkGap(sourceExecuted: string | null | undefined, alarms: AlarmSink, atIso: string): GapResult {
    const result = this.computeGap(sourceExecuted);
    if (!result.gap_detected) return result;

    const signatures = [
      ...result.internal_gap_keys.map((k) => `internal:${k}`),
      ...result.missing_below_watermark.map((m) => `missing:${m.key}:${m.start}-${m.end}`),
    ];
    for (const sig of signatures) {
      if (this.alarmedGaps.has(sig)) continue;
      this.alarmedGaps.add(sig);
      alarms.raise({
        kind: 'COMPLETENESS_GAP',
        severity: 'critical',
        message: `GTID continuity gap detected (${sig}): a transaction may have been missed`,
        at: atIso,
        details: { db_id: this.opts.dbId, signature: sig },
      });
    }
    return result;
  }

  /**
   * Produce a CompletenessUpdate (CCE §6.5 shape) for Normalization (E4) to
   * attach to CCE `completeness`. Runs checkGap (raising alarms for new gaps).
   */
  buildUpdate(args: {
    sourceExecuted?: string | null;
    alarms: AlarmSink;
    atIso: string;
    nowMs: number;
  }): CompletenessUpdate {
    const gap = this.checkGap(args.sourceExecuted, args.alarms, args.atIso);
    return {
      db_id: this.opts.dbId,
      consumed_offset_key: this.consumedOffsetKey,
      consumed_gtid_set: this.consumed.toString(),
      heartbeat_ts: this.lastHeartbeatIso,
      gap_detected: gap.gap_detected,
      snapshot_phase: this.currentPhase,
      liveness: this.liveness(args.nowMs),
    };
  }
}

/** CCE §6.5 completeness shape (+ db_id / liveness context). */
export interface CompletenessUpdate {
  db_id: string;
  consumed_offset_key: string | null;
  consumed_gtid_set: string;
  heartbeat_ts: string | null;
  gap_detected: boolean;
  snapshot_phase: SnapshotPhase;
  liveness: Liveness;
}

export interface CompletenessUpdateSink {
  emit(update: CompletenessUpdate): Promise<void>;
}

export class InMemoryCompletenessUpdateSink implements CompletenessUpdateSink {
  readonly updates: CompletenessUpdate[] = [];
  async emit(update: CompletenessUpdate): Promise<void> {
    this.updates.push(update);
  }
}

export type { SnapshotPhase };
