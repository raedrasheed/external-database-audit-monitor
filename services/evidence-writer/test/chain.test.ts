// Intra-segment row-hash chain verification tests (Sprint-2 / EDAM-T112).
import { describe, it, expect } from 'vitest';
import { SegmentAccumulator, type SealReadySegment } from '../src/index.js';
import { verifySegmentChain } from '@edam/evidence';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { rowHash } from '@edam/canonical';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const ZERO = 'sha256:' + '0'.repeat(64);
const NOW = () => '2026-06-01T10:00:00.000Z';

function tx(seq: number): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: HEALTHY,
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }],
  };
}

/** A properly-chained segment: each object's prev_row_hash threads from the prior object's row_hash, in global (gtid) order. */
function chainedSegment(firstPrev?: string): SealReadySegment {
  const c1 = buildCce(tx(1), firstPrev ? { prevRowHash: firstPrev } : {});
  const c2 = buildCce(tx(2), { prevRowHash: c1.evidence.row_hash });
  const c3 = buildCce(tx(3), { prevRowHash: c2.evidence.row_hash });
  const a = new SegmentAccumulator({ caps: { maxEvents: 100, maxAgeMs: 60_000 }, now: NOW });
  for (const c of [c3, c1, c2]) a.add(c); // shuffled add order
  const seg = a.flush()[0]!;
  // sanity: accumulator ordered by gtid (1,2,3) so the threaded chain aligns
  expect(seg.objects.map((c) => c.envelope_id)).toEqual([c1, c2, c3].map((c) => c.envelope_id));
  return seg;
}

/** Mutable handle on a segment's objects (objects is a readonly array, but its Cce elements are mutable). */
function obj(seg: SealReadySegment, i: number): Cce {
  return seg.objects[i]!;
}

describe('verifySegmentChain (T112)', () => {
  it('a valid, properly-chained segment passes', () => {
    const r = verifySegmentChain(chainedSegment());
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.event_count).toBe(3);
    expect(r.checks.every((c) => c.event_hash_ok && c.row_hash_ok && c.prev_link_ok && c.hash_list_ok && c.order_ok)).toBe(true);
  });

  it('broken event_hash (tampered object core) fails closed', () => {
    const seg = chainedSegment();
    (obj(seg, 1).changes[0] as { after: Record<string, unknown> }).after.amount = '999.00'; // core changes -> event_hash no longer recomputes
    const r = verifySegmentChain(seg);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.seq === 1 && f.rule === 'EVENT_HASH')).toBe(true);
  });

  it('broken row_hash fails closed', () => {
    const seg = chainedSegment();
    obj(seg, 2).evidence.row_hash = ZERO; // last object; no successor to also break
    const r = verifySegmentChain(seg);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.seq === 2 && f.rule === 'ROW_HASH')).toBe(true);
  });

  it('broken prev_row_hash linkage fails closed', () => {
    const seg = chainedSegment();
    obj(seg, 1).evidence.prev_row_hash = ZERO; // no longer links to objects[0].row_hash
    const r = verifySegmentChain(seg);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.seq === 1 && f.rule === 'PREV_LINK')).toBe(true);
  });

  it('object_hash_list mismatch fails closed (objects untouched)', () => {
    const seg = chainedSegment();
    seg.object_hash_list[0]!.event_hash = ZERO; // metadata diverges from the object
    const r = verifySegmentChain(seg);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.seq === 0 && f.rule === 'HASH_LIST')).toBe(true);
  });

  it('order/alignment mismatch fails closed', () => {
    const seg = chainedSegment();
    seg.object_list[0]!.object_id = obj(seg, 1).envelope_id; // claim object 0 is object 1
    const r = verifySegmentChain(seg);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.seq === 0 && f.rule === 'ORDER')).toBe(true);
  });

  it('first object: prior-segment linkage is NOT verified here (intra-segment scope)', () => {
    // First object carries a NON-genesis prev_row_hash (links to a prior segment).
    // T112 must still pass — it does not check the prior segment (that is T113).
    const priorLastRowHash = rowHash(ZERO, 'sha256:' + 'a'.repeat(64));
    const r = verifySegmentChain(chainedSegment(priorLastRowHash));
    expect(r.ok).toBe(true);
    expect(r.checks[0]!.prev_link_ok).toBe(true); // not applicable -> not failed
  });

  it('empty segment is rejected', () => {
    const base = chainedSegment();
    const empty: SealReadySegment = { ...base, objects: [], object_list: [], object_hash_list: [], event_count: 0 };
    const r = verifySegmentChain(empty);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'EMPTY')).toBe(true);
  });

  it('an independently-built (unchained) segment fails closed (chain not established)', () => {
    // Each CCE built with default GENESIS prev -> prev_row_hash[1] != row_hash[0].
    const a = new SegmentAccumulator({ caps: { maxEvents: 100, maxAgeMs: 60_000 }, now: NOW });
    a.add(buildCce(tx(1)));
    a.add(buildCce(tx(2)));
    const r = verifySegmentChain(a.flush()[0]!);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'PREV_LINK')).toBe(true);
  });
});
