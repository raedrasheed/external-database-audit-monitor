// Global ordering for CCEs (Epic E4 / EDAM-T032; CCE-AMD-001 Rev 4 §5).
//
// CCE §4.2 defines the global (cross-transaction) order as:
//   ORDER BY commit_ts ASC, then a monotonic offset key ASC.
// CCE-AMD-001 Rev 4 §5 appends a STRICTLY SUBORDINATE tie-break chain, engaged
// only when commit_ts AND the offset key are equal, terminating in the unique
// deterministic envelope_id. This makes the order a deterministic TOTAL order
// (required for a reproducible row_hash / WORM seal over snapshot rows, which
// share one commit_ts and one binlog coordinate). It does NOT reorder any pair
// §4.2 already ordered — streaming events differ at the offset key, so the
// subordinate keys never engage for them and existing chains are unchanged.

import { rowKeyHash } from '@edam/canonical';
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

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareCce(a: Cce, b: Cce): number {
  // §4.2 key 1 — commit_ts.
  const at = a.transaction.commit_ts;
  const bt = b.transaction.commit_ts;
  if (at !== bt) return at < bt ? -1 : 1;

  // §4.2 key 2 — monotonic offset key.
  const [an, as] = offsetTuple(a);
  const [bn, bs] = offsetTuple(b);
  if (an !== bn) return an - bn;
  if (as !== bs) return as < bs ? -1 : 1;

  // ---- Rev-4 §5 subordinate tie-break (only reached when the above tie) ----
  // snapshot_epoch_id ASC NULLS LAST.
  const ae = a.completeness?.snapshot_epoch_id;
  const be = b.completeness?.snapshot_epoch_id;
  if (ae !== be) {
    if (ae === undefined) return 1;
    if (be === undefined) return -1;
    return cmpStr(ae, be);
  }

  // schema, then table name.
  const ao = a.changes[0]?.object;
  const bo = b.changes[0]?.object;
  const schemaCmp = cmpStr(ao?.schema ?? '', bo?.schema ?? '');
  if (schemaCmp !== 0) return schemaCmp;
  const nameCmp = cmpStr(ao?.name ?? '', bo?.name ?? '');
  if (nameCmp !== 0) return nameCmp;

  // canonical primary-key identity hash.
  const arh = ao ? rowKeyHash(ao) : '';
  const brh = bo ? rowKeyHash(bo) : '';
  const rhCmp = cmpStr(arh, brh);
  if (rhCmp !== 0) return rhCmp;

  // final, total-order tie-break — the unique deterministic envelope_id.
  return cmpStr(a.envelope_id, b.envelope_id);
}

/** Sort CCEs into the frozen global order (stable, deterministic total order). */
export function orderCces(cces: Cce[]): Cce[] {
  return [...cces].sort(compareCce);
}
