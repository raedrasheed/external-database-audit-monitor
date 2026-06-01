// Global ordering for CCEs (Epic E4 / EDAM-T032).
//
// CCE §4.2 defines the global (cross-transaction) order as:
//   ORDER BY commit_ts ASC, then a monotonic offset key ASC (the tie-break).
// Intra-transaction order is the contiguous `seq`. This comparator is used when
// CCEs are chained/sealed (Phase 2); it is deterministic.

import type { Cce } from './types.js';

function offsetTuple(cce: Cce): [number, string] {
  const o = cce.offset;
  if (o.gtid) {
    const m = String(o.gtid).match(/(\d+)(?:-\d+)?$/);
    return [m ? Number(m[1]) : 0, String(o.gtid)];
  }
  if (o.lsn) return [0, String(o.lsn)];
  if (o.scn) return [0, String(o.scn)];
  if (o.binlog_file) return [o.binlog_pos ?? 0, `${o.binlog_file}:${o.binlog_pos ?? 0}`];
  if (o.resume_token) return [0, String(o.resume_token)];
  return [0, ''];
}

export function compareCce(a: Cce, b: Cce): number {
  const at = a.transaction.commit_ts;
  const bt = b.transaction.commit_ts;
  if (at !== bt) return at < bt ? -1 : 1;
  const [an, as] = offsetTuple(a);
  const [bn, bs] = offsetTuple(b);
  if (an !== bn) return an - bn;
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Sort CCEs into the frozen global order (stable, deterministic). */
export function orderCces(cces: Cce[]): Cce[] {
  return [...cces].sort(compareCce);
}
