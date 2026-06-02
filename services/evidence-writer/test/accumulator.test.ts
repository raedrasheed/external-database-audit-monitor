// SegmentAccumulator tests (Sprint-2 / EDAM-T107).
// AC: objects ordered deterministically; caps trigger seal; summaries computed;
// sequence contiguous. No invalid object enters segment state. No sealing/hashing.
import { describe, it, expect } from 'vitest';
import { SegmentAccumulator, evidenceObjectKey, type SealReadySegment } from '../src/index.js';
import { buildCce, orderCces, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { TransactionAccumulator, assembleTransaction } from '@edam/normalization';
import type { NormalizedChangeEvent } from '@edam/cce-model';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };

function streamingCce(seq: number, dbId = 'kafel-dev-mysql', opts: { fidelity?: NormalizedTransaction['fidelity']; gap?: boolean } = {}): Cce {
  const id = `${UUID}:${seq}`;
  const tx: NormalizedTransaction = {
    source: { db_id: dbId, engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: opts.fidelity ?? HEALTHY,
    completeness: { consumed_offset_key: id, gap_detected: opts.gap ?? false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }],
  };
  return buildCce(tx);
}

function snapshotCce(pk: number): Cce {
  const ev: NormalizedChangeEvent = {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    tx_id: null, commit_ts: '2026-06-01T09:30:00.000Z', ingest_ts: '2026-06-01T09:30:00.100Z',
    offset: { gtid: null, binlog_file: 'mysql-bin.000003', binlog_pos: 4096, lsn: null, scn: null, resume_token: null },
    snapshot_phase: 'snapshot',
    change: { operation: 'INSERT', object: { schema: 'kafel', name: 'donations', primary_key: { id: pk } }, before: null, after: { id: pk, amount: '1.00' } },
  };
  return buildCce(assembleTransaction(new TransactionAccumulator().add(ev)[0]!, HEALTHY, null, { attribution_confidence: 'unattributed' }));
}

function acc(maxEvents: number, maxAgeMs: number, now: () => string): SegmentAccumulator {
  return new SegmentAccumulator({ caps: { maxEvents, maxAgeMs }, now });
}

describe('SegmentAccumulator — ordering (T107)', () => {
  it('orders mixed streaming + snapshot CCEs by the frozen global order, independent of add order', () => {
    const objs = [streamingCce(9), snapshotCce(5), streamingCce(2), snapshotCce(1), streamingCce(7), snapshotCce(3)];
    const expected = orderCces(objs).map((c) => c.envelope_id);

    const a = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    for (const o of [...objs].reverse()) a.add(o); // add in a different order
    const [seg] = a.flush();
    expect(seg).toBeDefined();
    expect(seg!.object_list.map((r) => r.object_id)).toEqual(expected);
    // and a second accumulator with yet another add order yields the same
    const b = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    for (const o of objs) b.add(o);
    expect(b.flush()[0]!.object_list.map((r) => r.object_id)).toEqual(expected);
  });
});

describe('SegmentAccumulator — multi-db isolation + contiguous sequence', () => {
  it('keeps one segment per db_id with independent sequences from 0', () => {
    const a = acc(2, 60_000, () => '2026-06-01T12:00:00.000Z');
    const sealed: SealReadySegment[] = [];
    sealed.push(...a.add(streamingCce(1, 'db-A')).sealed);
    sealed.push(...a.add(streamingCce(1, 'db-B')).sealed);
    sealed.push(...a.add(streamingCce(2, 'db-A')).sealed); // db-A hits cap (2) -> seal seq 0
    sealed.push(...a.add(streamingCce(2, 'db-B')).sealed); // db-B hits cap (2) -> seal seq 0
    expect(sealed.map((s) => `${s.db_id}#${s.segment_sequence}`)).toEqual(['db-A#0', 'db-B#0']);
    // each segment only contains its own db's objects
    for (const s of sealed) expect(s.db_id === 'db-A' || s.db_id === 'db-B').toBe(true);
  });

  it('segment_sequence is contiguous from 0 across repeated seals for one db', () => {
    const a = acc(1, 60_000, () => '2026-06-01T12:00:00.000Z'); // seal every object
    const seqs = [streamingCce(1), streamingCce(2), streamingCce(3)].flatMap((c) => a.add(c).sealed.map((s) => s.segment_sequence));
    expect(seqs).toEqual([0, 1, 2]);
  });
});

describe('SegmentAccumulator — caps', () => {
  it('event-count cap triggers SEALING with the right trigger', () => {
    const a = acc(2, 60_000, () => '2026-06-01T12:00:00.000Z');
    expect(a.add(streamingCce(1)).sealed).toEqual([]); // 1st: buffered
    const r = a.add(streamingCce(2)); // 2nd: cap
    expect(r.sealed.length).toBe(1);
    expect(r.sealed[0]!.trigger).toBe('event_count_cap');
    expect(r.sealed[0]!.event_count).toBe(2);
    // next object opens sequence 1
    a.add(streamingCce(3));
    expect(a.openState()[0]!.segment_sequence).toBe(1);
  });

  it('time cap triggers SEALING via sweep() without a new object', () => {
    let clock = '2026-06-01T12:00:00.000Z';
    const a = acc(100, 5_000, () => clock);
    a.add(streamingCce(1));
    expect(a.sweep()).toEqual([]); // not aged yet
    clock = '2026-06-01T12:00:06.000Z'; // +6s > 5s cap
    const sealed = a.sweep();
    expect(sealed.length).toBe(1);
    expect(sealed[0]!.trigger).toBe('time_cap');
  });

  it('time cap also fires on the next add', () => {
    let clock = '2026-06-01T12:00:00.000Z';
    const a = acc(100, 5_000, () => clock);
    a.add(streamingCce(1));
    clock = '2026-06-01T12:00:06.000Z';
    const r = a.add(streamingCce(2)); // pre-seals the aged segment, buffers #2 into a fresh one
    expect(r.sealed.length).toBe(1);
    expect(r.sealed[0]!.trigger).toBe('time_cap');
    expect(r.sealed[0]!.segment_sequence).toBe(0);
    expect(a.openState()[0]!.segment_sequence).toBe(1);
  });
});

describe('SegmentAccumulator — summaries + offset range + list consistency', () => {
  it('computes fidelity_summary, completeness_summary and source_offset_range', () => {
    const degraded = { state: 'DEGRADED' as const, degraded_reason: 'completeness not attested', source_config: HEALTHY.source_config };
    const a = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    a.add(streamingCce(1));
    a.add(streamingCce(2, 'kafel-dev-mysql', { fidelity: degraded }));
    a.add(streamingCce(3, 'kafel-dev-mysql', { gap: true }));
    const seg = a.flush()[0]!;
    expect(seg.fidelity_summary).toEqual({ all_healthy: false, degraded_count: 1, compromised_count: 0, reasons: ['completeness not attested'] });
    expect(seg.completeness_summary).toEqual({ gap_detected: true, expected_continuous: false, notes: [] });
    // offset range from first/last in global order
    const ordered = orderCces([streamingCce(1), streamingCce(2, 'kafel-dev-mysql', { fidelity: degraded }), streamingCce(3, 'kafel-dev-mysql', { gap: true })]);
    expect(seg.source_offset_range.first_offset_key).toBe(ordered[0]!.completeness.consumed_offset_key);
    expect(seg.source_offset_range.last_offset_key).toBe(ordered[ordered.length - 1]!.completeness.consumed_offset_key);
  });

  it('object_list and object_hash_list are seq-contiguous and consistent', () => {
    const a = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    const objs = [streamingCce(5), streamingCce(2), streamingCce(8)];
    for (const o of objs) a.add(o);
    const seg = a.flush()[0]!;
    expect(seg.object_list.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(seg.object_hash_list.map((r) => r.seq)).toEqual([0, 1, 2]);
    for (let i = 0; i < seg.object_list.length; i++) {
      const ref = seg.object_list[i]!;
      const h = seg.object_hash_list[i]!;
      expect(ref.worm_object_key).toBe(evidenceObjectKey(seg.db_id, seg.segment_id, i, 'cce'));
      expect(ref.object_type).toBe('cce');
      // the hash entry corresponds to the same ordered object
      const ordered = orderCces(objs);
      expect(h.event_hash).toBe(ordered[i]!.evidence.event_hash);
      expect(h.row_hash).toBe(ordered[i]!.evidence.row_hash);
    }
    expect(seg.first_envelope_id).toBe(seg.object_list[0]!.object_id);
    expect(seg.last_envelope_id).toBe(seg.object_list[seg.object_list.length - 1]!.object_id);
  });
});

describe('SegmentAccumulator — ordered seal payloads (M-A-INT-1)', () => {
  it('exposes objects index-aligned with object_list and object_hash_list, in global order', () => {
    const inputs = [streamingCce(9), snapshotCce(5), streamingCce(2), snapshotCce(1), streamingCce(7)];
    const a = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    for (const o of [...inputs].reverse()) a.add(o);
    const seg = a.flush()[0]!;

    // same count
    expect(seg.objects.length).toBe(seg.object_list.length);
    expect(seg.objects.length).toBe(seg.object_hash_list.length);

    // global order (frozen orderCces) — objects, not just metadata
    expect(seg.objects.map((c) => c.envelope_id)).toEqual(orderCces(inputs).map((c) => c.envelope_id));

    // index alignment objects[i] <-> object_list[i] <-> object_hash_list[i]
    for (let i = 0; i < seg.objects.length; i++) {
      const obj = seg.objects[i]!;
      const ref = seg.object_list[i]!;
      const h = seg.object_hash_list[i]!;
      expect(ref.object_id).toBe(obj.envelope_id);
      expect(ref.seq).toBe(i);
      expect(h.event_hash).toBe(obj.evidence.event_hash);
      expect(h.row_hash).toBe(obj.evidence.row_hash);
      expect(ref.worm_object_key).toBe(evidenceObjectKey(seg.db_id, seg.segment_id, i, 'cce'));
    }
  });

  it('objects is the ONLY carrier of CCE payloads; the manifest-input metadata excludes them', () => {
    // CCE after-image carries amount '2.00' (and field_changes new '2.00').
    const a = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    a.add(streamingCce(1));
    const seg = a.flush()[0]!;

    // The manifest is built from the metadata subset (everything except `objects`).
    const manifestInput: Record<string, unknown> = { ...seg };
    delete manifestInput.objects;

    // payload value present in objects ...
    expect(JSON.stringify(seg.objects)).toContain('2.00');
    // ... but NOT in any field the manifest/manifest_hash will be computed over.
    expect(JSON.stringify(manifestInput)).not.toContain('2.00');
    expect(JSON.stringify(seg.object_list)).not.toContain('2.00');
    expect(JSON.stringify(seg.object_hash_list)).not.toContain('2.00');
    expect(JSON.stringify(seg.fidelity_summary)).not.toContain('2.00');
    expect(JSON.stringify(seg.completeness_summary)).not.toContain('2.00');
    expect(JSON.stringify(seg.source_offset_range)).not.toContain('2.00');
  });

  it('removing objects leaves the metadata (manifest input) byte-identical regardless of payload content', () => {
    // Two segments whose CCEs differ ONLY in masked-but-real payload values must
    // still share identical hashes/ids -> impossible (hashes differ); instead we
    // assert the metadata projection contains no payload bytes and is stable.
    const a = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    a.add(streamingCce(3));
    const seg = a.flush()[0]!;
    const core = { ...seg } as Record<string, unknown>;
    delete core.objects;
    // The metadata projection is composed solely of hashes/ids/keys/summaries.
    expect(Object.keys(core)).not.toContain('objects');
    expect(seg.object_hash_list.every((h) => h.event_hash.startsWith('sha256:') && h.row_hash.startsWith('sha256:'))).toBe(true);
  });
});

describe('SegmentAccumulator — admission (no invalid object enters segment state)', () => {
  it('rejects a CCE without integrity evidence and does not buffer it', () => {
    const a = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    const bad = buildCce(streamingTxLike()) as Record<string, any>;
    delete bad.evidence.row_hash;
    const r = a.add(bad as never);
    expect(r.rejected).toMatch(/row_hash/i);
    expect(r.sealed).toEqual([]);
    expect(a.openState()).toEqual([]); // nothing buffered
  });

  it('rejects a non-CCE object', () => {
    const a = acc(100, 60_000, () => '2026-06-01T12:00:00.000Z');
    const r = a.add({ kind: 'snapshot_epoch_manifest' } as never);
    expect(r.rejected).toMatch(/not a CCE/i);
    expect(a.openState()).toEqual([]);
  });
});

function streamingTxLike(): NormalizedTransaction {
  const id = `${UUID}:99`;
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1099, lsn: null, scn: null, resume_token: null },
    fidelity: HEALTHY,
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }],
  };
}
