// Evidence segment manifest builder tests (Sprint-2 / EDAM-T111).
import { describe, it, expect } from 'vitest';
import { SegmentAccumulator, type SealReadySegment } from '../src/index.js';
import { buildSegmentManifest, SegmentManifestError, type PreviousSegmentRef } from '@edam/evidence';
import { validateEvidenceSegmentManifest } from '@edam/contracts';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const SEALED_AT = '2026-06-01T10:05:00.000Z';
const ZERO = 'sha256:' + '0'.repeat(64);

function streamingCce(seq: number, dbId = 'kafel-dev-mysql'): Cce {
  const id = `${UUID}:${seq}`;
  const tx: NormalizedTransaction = {
    source: { db_id: dbId, engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: HEALTHY,
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }],
  };
  return buildCce(tx);
}

function genesisSegment(seqs = [3, 1, 2]): SealReadySegment {
  const a = new SegmentAccumulator({ caps: { maxEvents: 100, maxAgeMs: 60_000 }, now: () => '2026-06-01T10:00:00.000Z' });
  for (const s of seqs) a.add(streamingCce(s));
  return a.flush()[0]!;
}

describe('buildSegmentManifest (T111)', () => {
  it('builds a manifest that validates against the vendored schema', () => {
    const m = buildSegmentManifest(genesisSegment(), { sealedAt: SEALED_AT });
    expect(validateEvidenceSegmentManifest(m)).toEqual({ valid: true, errors: [] });
    expect(m.manifest_version).toBe('evidence-segment-manifest-1.0');
    expect(m.previous_segment).toBeNull(); // genesis
    expect(m.manifest_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('manifest_hash is deterministic (byte-for-byte) across rebuilds', () => {
    const a = buildSegmentManifest(genesisSegment(), { sealedAt: SEALED_AT });
    const b = buildSegmentManifest(genesisSegment(), { sealedAt: SEALED_AT });
    expect(a.manifest_hash).toBe(b.manifest_hash);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('changing manifest content changes manifest_hash', () => {
    const a = buildSegmentManifest(genesisSegment(), { sealedAt: SEALED_AT });
    const b = buildSegmentManifest(genesisSegment(), { sealedAt: '2026-06-01T10:06:00.000Z' }); // different sealed_at
    expect(b.manifest_hash).not.toBe(a.manifest_hash);
  });

  it('field cross-checks: manifest mirrors the segment metadata', () => {
    const seg = genesisSegment();
    const m = buildSegmentManifest(seg, { sealedAt: SEALED_AT });
    expect(m.event_count).toBe(seg.event_count);
    expect(m.first_envelope_id).toBe(seg.first_envelope_id);
    expect(m.last_envelope_id).toBe(seg.last_envelope_id);
    expect(m.first_row_hash).toBe(seg.first_row_hash);
    expect(m.last_row_hash).toBe(seg.last_row_hash);
    expect(m.object_list).toEqual(seg.object_list);
    expect(m.object_hash_list).toEqual(seg.object_hash_list);
    expect(m.source_offset_range).toEqual(seg.source_offset_range);
    expect(m.fidelity_summary).toEqual(seg.fidelity_summary);
    expect(m.completeness_summary).toEqual(seg.completeness_summary);
  });

  it('objects[] payload is EXCLUDED from the manifest (and thus from manifest_hash)', () => {
    const seg = genesisSegment();
    expect(JSON.stringify(seg.objects)).toContain('2.00'); // payload is in the transport field
    const m = buildSegmentManifest(seg, { sealedAt: SEALED_AT });
    expect('objects' in m).toBe(false); // not a manifest field
    expect(JSON.stringify(m)).not.toContain('2.00'); // no payload anywhere in the manifest
    // additionalProperties:false would have rejected the manifest if objects leaked in
    expect(validateEvidenceSegmentManifest(m).valid).toBe(true);
  });

  it('rejects an inconsistent SealReadySegment (cross-check failure)', () => {
    const seg = { ...genesisSegment() };
    (seg as { event_count: number }).event_count = 99; // tamper
    expect(() => buildSegmentManifest(seg, { sealedAt: SEALED_AT })).toThrow(SegmentManifestError);

    const seg2 = { ...genesisSegment() };
    (seg2 as { first_envelope_id: string }).first_envelope_id = 'not-the-first';
    expect(() => buildSegmentManifest(seg2, { sealedAt: SEALED_AT })).toThrow(/first_envelope_id/);
  });

  it('genesis handling: sequence 0 => previous_segment null; passing a previous_segment is rejected', () => {
    const prev: PreviousSegmentRef = { segment_id: 'seg-x', segment_sequence: 0, segment_hash: ZERO };
    expect(() => buildSegmentManifest(genesisSegment(), { sealedAt: SEALED_AT, previousSegment: prev })).toThrow(SegmentManifestError);
  });

  it('non-genesis (sequence > 0): requires a previous_segment input and validates (no linkage computed here)', () => {
    const seg1 = seq1Segment();
    expect(seg1.segment_sequence).toBe(1);

    expect(() => buildSegmentManifest(seg1, { sealedAt: SEALED_AT })).toThrow(/requires a previous_segment/);
    const prev: PreviousSegmentRef = { segment_id: 'seg-000000', segment_sequence: 0, segment_hash: ZERO };
    const m = buildSegmentManifest(seg1, { sealedAt: SEALED_AT, previousSegment: prev });
    expect(m.previous_segment).toEqual(prev);
    expect(validateEvidenceSegmentManifest(m).valid).toBe(true);
  });
});

function seq1Segment(): SealReadySegment {
  const a = new SegmentAccumulator({ caps: { maxEvents: 2, maxAgeMs: 60_000 }, now: () => '2026-06-01T10:00:00.000Z' });
  a.add(streamingCce(1));
  a.add(streamingCce(2)); // seals sequence 0
  a.add(streamingCce(3));
  return a.flush()[0]!;
}

describe('buildSegmentManifest — immutability + cross-check hardening (M1/L1/L4)', () => {
  it('M1: mutating the input SealReadySegment after build does not change the manifest/hash/validation', () => {
    const seg = genesisSegment();
    const m = buildSegmentManifest(seg, { sealedAt: SEALED_AT });
    const snapshot = JSON.stringify(m);
    const hashBefore = m.manifest_hash;

    // tamper every embedded sub-structure on the ORIGINAL input
    seg.object_list[0]!.object_id = 'TAMPERED';
    seg.object_hash_list[0]!.event_hash = ZERO;
    seg.source_offset_range.first_offset_key = 'TAMPERED';
    seg.fidelity_summary.reasons.push('tampered');
    seg.completeness_summary.notes.push('tampered');
    (seg as { last_row_hash: string }).last_row_hash = ZERO;

    expect(JSON.stringify(m)).toBe(snapshot); // content unchanged
    expect(m.manifest_hash).toBe(hashBefore); // hash unchanged
    expect(validateEvidenceSegmentManifest(m).valid).toBe(true); // still valid
  });

  it('M1: mutating the previousSegment input after build does not change the manifest', () => {
    const seg1 = seq1Segment();
    const prev: PreviousSegmentRef = { segment_id: 'seg-000000', segment_sequence: 0, segment_hash: ZERO };
    const m = buildSegmentManifest(seg1, { sealedAt: SEALED_AT, previousSegment: prev });
    const hashBefore = m.manifest_hash;
    prev.segment_hash = 'sha256:' + 'f'.repeat(64); // tamper the input
    expect(m.previous_segment!.segment_hash).toBe(ZERO);
    expect(m.manifest_hash).toBe(hashBefore);
  });

  it('M1: the returned manifest is deep-frozen', () => {
    const m = buildSegmentManifest(genesisSegment(), { sealedAt: SEALED_AT });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.object_list)).toBe(true);
    expect(Object.isFrozen(m.object_list[0])).toBe(true);
    expect(Object.isFrozen(m.object_hash_list)).toBe(true);
    expect(Object.isFrozen(m.fidelity_summary)).toBe(true);
    expect(Object.isFrozen(m.source_offset_range)).toBe(true);
  });

  it('L4: a schema-invalid manifest (bad engine) is rejected via validation', () => {
    const seg = { ...genesisSegment() };
    (seg as { engine: string }).engine = 'notanengine';
    expect(() => buildSegmentManifest(seg, { sealedAt: SEALED_AT })).toThrow(/failed validation/);
  });

  it('L4: object_hash_list length mismatch is rejected with SegmentManifestError (no TypeError)', () => {
    const seg = genesisSegment();
    seg.object_hash_list.pop();
    expect(() => buildSegmentManifest(seg, { sealedAt: SEALED_AT })).toThrow(SegmentManifestError);
  });

  it('L4: last_row_hash mismatch is rejected', () => {
    const seg = genesisSegment();
    (seg as { last_row_hash: string }).last_row_hash = ZERO;
    expect(() => buildSegmentManifest(seg, { sealedAt: SEALED_AT })).toThrow(/last_row_hash/);
  });

  it('L1: a middle per-index object_hash_list/objects mismatch is rejected', () => {
    const seg = genesisSegment([3, 1, 2]); // n = 3
    seg.object_hash_list[1]!.event_hash = ZERO; // no longer matches objects[1]
    expect(() => buildSegmentManifest(seg, { sealedAt: SEALED_AT })).toThrow(/object_hash_list\[1\]/);
  });
});
