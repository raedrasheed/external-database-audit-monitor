// Cross-segment chain verification tests (Sprint-2 / EDAM-T113).
import { describe, it, expect } from 'vitest';
import {
  SegmentAccumulator,
  buildSegmentManifest,
  computeSegmentHash,
  segmentHashOf,
  deriveSegmentHead,
  verifyCrossSegment,
  GENESIS_PREVIOUS_SEGMENT_HASH,
  type SealReadySegment,
  type SegmentManifest,
} from '../src/index.js';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { GENESIS_ROW_HASH } from '@edam/canonical';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const WRONG = 'sha256:' + 'f'.repeat(64);
const NOW = () => '2026-06-01T10:00:00.000Z';
const SEALED_AT = '2026-06-01T10:05:00.000Z';

function tx(seq: number, dbId = 'kafel-dev-mysql'): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  return {
    source: { db_id: dbId, engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: HEALTHY,
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }],
  };
}

/** Build two genuinely-linked segments for one db: seg0 (genesis) then seg1, with the chain threaded across the boundary. */
function linkedSegments(): { seg0: SealReadySegment; m0: SegmentManifest; sh0: string; seg1: SealReadySegment; m1: SegmentManifest } {
  const a = new SegmentAccumulator({ caps: { maxEvents: 2, maxAgeMs: 60_000 }, now: NOW });
  const c0a = buildCce(tx(1));
  const c0b = buildCce(tx(2), { prevRowHash: c0a.evidence.row_hash });
  a.add(c0a);
  const seg0 = a.add(c0b).sealed[0]!; // seals seq 0
  const m0 = buildSegmentManifest(seg0, { sealedAt: SEALED_AT });
  const sh0 = deriveSegmentHead(m0).segment_hash;

  const c1a = buildCce(tx(3), { prevRowHash: seg0.last_row_hash }); // boundary: chains from seg0's last row
  const c1b = buildCce(tx(4), { prevRowHash: c1a.evidence.row_hash });
  a.add(c1a);
  const seg1 = a.add(c1b).sealed[0]!; // seals seq 1
  const m1 = buildSegmentManifest(seg1, { sealedAt: SEALED_AT, previousSegment: { segment_id: m0.segment_id, segment_sequence: 0, segment_hash: sh0 } });
  return { seg0, m0, sh0, seg1, m1 };
}

const firstPrev = (seg: SealReadySegment): string => (seg.objects[0] as Cce).evidence.prev_row_hash!;

describe('segment_hash (T113)', () => {
  it('genesis segment_hash uses the all-zero previous_segment_hash', () => {
    const { m0 } = linkedSegments();
    expect(GENESIS_PREVIOUS_SEGMENT_HASH).toBe('sha256:' + '0'.repeat(64));
    expect(deriveSegmentHead(m0).segment_hash).toBe(computeSegmentHash(m0.manifest_hash, m0.last_row_hash, GENESIS_PREVIOUS_SEGMENT_HASH));
  });

  it('non-genesis segment_hash links to the prior segment_hash', () => {
    const { m1, sh0 } = linkedSegments();
    expect(segmentHashOf(m1)).toBe(computeSegmentHash(m1.manifest_hash, m1.last_row_hash, sh0));
  });

  it('segment_hash is deterministic', () => {
    const a = linkedSegments();
    const b = linkedSegments();
    expect(segmentHashOf(a.m1)).toBe(segmentHashOf(b.m1));
  });
});

describe('verifyCrossSegment (T113)', () => {
  it('genesis segment passes (no prior; previous_segment null)', () => {
    const { m0 } = linkedSegments();
    const r = verifyCrossSegment(m0, GENESIS_ROW_HASH, null);
    expect(r.ok).toBe(true);
    expect(r.genesis).toBe(true);
  });

  it('valid linked segment passes', () => {
    const { m0, m1, seg1 } = linkedSegments();
    const r = verifyCrossSegment(m1, firstPrev(seg1), m0);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('broken previous manifest hash fails closed', () => {
    const { m0, m1, seg1 } = linkedSegments();
    const tamperedPrev: SegmentManifest = { ...m0, manifest_hash: WRONG }; // prior manifest_hash changed
    const r = verifyCrossSegment(m1, firstPrev(seg1), tamperedPrev);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'PREVIOUS_SEGMENT_HASH')).toBe(true);
  });

  it('broken previous segment hash fails closed', () => {
    const { m0, seg1 } = linkedSegments();
    // build m1 with a WRONG previous_segment.segment_hash
    const m1bad = buildSegmentManifest(seg1, { sealedAt: SEALED_AT, previousSegment: { segment_id: m0.segment_id, segment_sequence: 0, segment_hash: WRONG } });
    const r = verifyCrossSegment(m1bad, firstPrev(seg1), m0);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'PREVIOUS_SEGMENT_HASH')).toBe(true);
  });

  it('broken row boundary fails closed', () => {
    const { m0, m1 } = linkedSegments();
    const r = verifyCrossSegment(m1, WRONG, m0); // first object prev_row_hash != prev.last_row_hash
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'ROW_BOUNDARY')).toBe(true);
  });

  it('wrong sequence continuity fails closed', () => {
    const { m0, m1, seg1 } = linkedSegments();
    const skewed: SegmentManifest = { ...m1, segment_sequence: 5 };
    const r = verifyCrossSegment(skewed, firstPrev(seg1), m0);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'SEQUENCE')).toBe(true);
  });

  it('missing previous segment (non-genesis) fails closed', () => {
    const { m1, seg1 } = linkedSegments();
    const r = verifyCrossSegment(m1, firstPrev(seg1), null);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'MISSING_PREVIOUS')).toBe(true);
  });

  it('mismatched db_id fails closed', () => {
    const { m0, m1, seg1 } = linkedSegments();
    const otherDb: SegmentManifest = { ...m1, db_id: 'other-db' };
    const r = verifyCrossSegment(otherDb, firstPrev(seg1), m0);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'DB_ID')).toBe(true);
  });

  it('fail-closed: any single failure yields ok=false', () => {
    const { m1, seg1 } = linkedSegments();
    // missing previous + (implicitly) cannot verify -> ok false
    expect(verifyCrossSegment(m1, firstPrev(seg1), null).ok).toBe(false);
  });
});
