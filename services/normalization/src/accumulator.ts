// Transaction accumulator (Epic E4 / EDAM-T031).
//
// Groups mapped change events into transactions by tx_id (GTID). Emits a
// completed group when the tx boundary changes; events with no GTID (e.g.
// snapshot reads) are grouped individually under a deterministic synthetic key
// so each still becomes one transaction. flush() returns any buffered group.

import type { NormalizedChange, NormalizedChangeEvent, CceOffset, SnapshotPhase } from '@edam/cce-model';

export interface GroupedTransaction {
  source: NormalizedChangeEvent['source'];
  tx_id: string;
  commit_ts: string | null;
  ingest_ts: string;
  offset: CceOffset;
  snapshot_phase: SnapshotPhase;
  changes: NormalizedChange[];
}

function effectiveTxId(ev: NormalizedChangeEvent): string {
  if (ev.tx_id) return ev.tx_id;
  // No GTID (snapshot read): deterministic synthetic, one transaction per event.
  return `snapshot:${ev.offset.binlog_file ?? ''}:${ev.offset.binlog_pos ?? ''}`;
}

export class TransactionAccumulator {
  private key: string | null = null;
  private group: GroupedTransaction | null = null;

  /** Add a mapped event; returns any completed group(s) (flushed on tx change). */
  add(ev: NormalizedChangeEvent): GroupedTransaction[] {
    const key = effectiveTxId(ev);
    const completed: GroupedTransaction[] = [];

    if (this.group && key !== this.key) {
      completed.push(this.group);
      this.group = null;
    }

    if (!this.group) {
      this.key = key;
      this.group = {
        source: ev.source,
        tx_id: key,
        commit_ts: ev.commit_ts,
        ingest_ts: ev.ingest_ts,
        offset: ev.offset,
        snapshot_phase: ev.snapshot_phase,
        changes: [],
      };
    }

    this.group.changes.push(ev.change);
    // Snapshot reads (synthetic key) never group with anything else.
    if (!ev.tx_id) {
      completed.push(this.group);
      this.group = null;
      this.key = null;
    }
    return completed;
  }

  /** Force-flush the current buffered transaction, if any. */
  flush(): GroupedTransaction | null {
    const g = this.group;
    this.group = null;
    this.key = null;
    return g;
  }
}
