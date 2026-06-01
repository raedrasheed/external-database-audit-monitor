// Snapshot -> stream handoff tracking (Epic E2 / EDAM-T013).
//
// Records the GTID/offset at snapshot start and at the snapshot->stream handoff,
// and logs an explicit handoff event so that streaming is proven to resume with
// no gap. This is a CDC-boundary concern; the Completeness Watcher (Epic E3)
// consumes these markers — it is NOT implemented here.

import type { OffsetMeta, SnapshotPhase } from './adapters/types.js';

export type HandoffType = 'snapshot_start' | 'snapshot_complete' | 'streaming_resumed';

export interface HandoffEvent {
  type: HandoffType;
  at: string;
  fromPhase: SnapshotPhase | null;
  toPhase: SnapshotPhase;
  offset: OffsetMeta;
}

/**
 * Observes per-event phase transitions and emits a HandoffEvent when the phase
 * changes. Transitions:
 *   (none) -> snapshot     => snapshot_start
 *   snapshot -> handoff    => snapshot_complete   (GTID recorded at boundary)
 *   snapshot|handoff -> streaming => streaming_resumed (and snapshot_complete
 *     first, if the 'last' marker was skipped)
 */
export class HandoffTracker {
  private prevPhase: SnapshotPhase | null = null;
  private snapshotStartOffset: OffsetMeta | null = null;
  private snapshotEndOffset: OffsetMeta | null = null;

  observe(phase: SnapshotPhase, offset: OffsetMeta, at: string): HandoffEvent[] {
    const events: HandoffEvent[] = [];
    const prev = this.prevPhase;

    if (prev === phase) {
      this.prevPhase = phase;
      return events;
    }

    if (prev === null && phase === 'snapshot') {
      this.snapshotStartOffset = offset;
      events.push({ type: 'snapshot_start', at, fromPhase: prev, toPhase: phase, offset });
    } else if (phase === 'handoff') {
      this.snapshotEndOffset = offset;
      events.push({ type: 'snapshot_complete', at, fromPhase: prev, toPhase: phase, offset });
    } else if (phase === 'streaming') {
      // If we never saw an explicit 'last', record the snapshot completion at
      // the streaming boundary so the GTID handoff is still captured.
      if (prev === 'snapshot') {
        this.snapshotEndOffset = offset;
        events.push({ type: 'snapshot_complete', at, fromPhase: prev, toPhase: phase, offset });
      }
      // Cold start directly into streaming (prev === null) also lands here and
      // emits only streaming_resumed.
      events.push({ type: 'streaming_resumed', at, fromPhase: prev, toPhase: phase, offset });
    }

    this.prevPhase = phase;
    return events;
  }

  get currentPhase(): SnapshotPhase | null {
    return this.prevPhase;
  }

  get snapshotBoundary(): { start: OffsetMeta | null; end: OffsetMeta | null } {
    return { start: this.snapshotStartOffset, end: this.snapshotEndOffset };
  }
}
