// Verifier §10 steps 4-6 tests (EDAM-T142): cross_segment_continuity,
// no_missing_segment, no_missing_event — plus the T141-M1 count check.
// Multi-segment fixtures are built inline from @edam/cce-model + @edam/evidence
// (no writer import, no golden fixtures — T116 deferred), preserving isolation.
import { describe, it, expect } from 'vitest';
import {
  verifySegments,
  recomputeCrossSegment,
  recomputeNoMissingSegment,
  recomputeNoMissingEvent,
  recomputeSegment,
  type VerifierSegment,
} from '../src/index.js';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { buildSegmentManifest, deriveSegmentHead, type SegmentManifest, type SegmentManifestInput, type PreviousSegmentRef } from '@edam/evidence';
import { validateVerificationReport } from '@edam/contracts';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const scopeOf = (first: number, last: number) => ({ first_segment_sequence: first, last_segment_sequence: last });

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

/** Build one segment from a list of (already prev-threaded) CCEs at a given sequence. */
function segmentOf(sequence: number, objects: Cce[], previousSegment: PreviousSegmentRef | null): VerifierSegment {
  const first = objects[0]!;
  const last = objects[objects.length - 1]!;
  const input: SegmentManifestInput = {
    db_id: 'kafel-dev-mysql',
    engine: 'mysql',
    segment_id: `seg-${String(sequence).padStart(6, '0')}`,
    segment_sequence: sequence,
    opened_at: '2026-06-01T10:00:00.000Z',
    event_count: objects.length,
    first_envelope_id: first.envelope_id,
    last_envelope_id: last.envelope_id,
    first_row_hash: first.evidence.row_hash,
    last_row_hash: last.evidence.row_hash,
    object_list: objects.map((c, seq) => ({ seq, object_id: c.envelope_id, worm_object_key: `k/${sequence}/${seq}`, object_type: 'cce' as const })),
    object_hash_list: objects.map((c, seq) => ({ seq, event_hash: c.evidence.event_hash, row_hash: c.evidence.row_hash })),
    source_offset_range: { first_offset_key: first.completeness.consumed_offset_key, last_offset_key: last.completeness.consumed_offset_key },
    fidelity_summary: { all_healthy: true, degraded_count: 0, compromised_count: 0, reasons: [] },
    completeness_summary: { gap_detected: false, expected_continuous: true, notes: [] },
    objects,
  };
  const manifest = buildSegmentManifest(input, { sealedAt: '2026-06-01T10:00:01.000Z', previousSegment });
  return { manifest, objects: structuredClone(objects) as Cce[] };
}

/** A genesis (seq 0) + second (seq 1) chain; object chain threads unbroken across the boundary. */
function twoSegmentChain(): { genesis: VerifierSegment; second: VerifierSegment } {
  const c0 = buildCce(tx(0));
  const c1 = buildCce(tx(1), { prevRowHash: c0.evidence.row_hash });
  const genesis = segmentOf(0, [c0, c1], null);
  const c2 = buildCce(tx(2), { prevRowHash: c1.evidence.row_hash }); // continues the chain across the boundary
  const c3 = buildCce(tx(3), { prevRowHash: c2.evidence.row_hash });
  const prevRef: PreviousSegmentRef = { segment_id: genesis.manifest.segment_id, segment_sequence: 0, segment_hash: deriveSegmentHead(genesis.manifest).segment_hash };
  const second = segmentOf(1, [c2, c3], prevRef);
  return { genesis, second };
}

function mutManifest(seg: VerifierSegment): VerifierSegment {
  return { manifest: structuredClone(seg.manifest) as SegmentManifest, objects: structuredClone(seg.objects) as Cce[] };
}

describe('§10 steps 4-6 (T142)', () => {
  it('valid genesis + second segment: steps 1-6 PASS; overall FAIL-closed (T143 SKIPPED)', () => {
    const { genesis, second } = twoSegmentChain();
    const report = verifySegments({ db_id: 'kafel-dev-mysql', scope: scopeOf(0, 1), segments: [genesis, second], reportId: '11111111-2222-4333-8444-555555555555', generatedAt: '2026-06-01T12:00:00.000Z' });
    expect(validateVerificationReport(report).valid, JSON.stringify(validateVerificationReport(report).errors)).toBe(true);
    const byName = new Map(report.checks.map((c) => [c.check, c.result]));
    for (const c of ['per_object_hash', 'object_chain', 'segment_manifest', 'cross_segment_continuity', 'no_missing_segment', 'no_missing_event'] as const) {
      expect(byName.get(c), c).toBe('PASS');
    }
    for (const c of ['hsm_signature', 'anchor_token', 'projection_consistency'] as const) expect(byName.get(c)).toBe('SKIPPED');
    expect(report.overall_result).toBe('FAIL'); // T140-M1 fail-closed (HSM/anchor still SKIPPED)
  });

  it('segment-sequence gap → no_missing_segment FAIL (located)', () => {
    const { genesis, second } = twoSegmentChain(); // sequences 0, 1
    const r = recomputeNoMissingSegment([genesis, second], scopeOf(0, 2)); // claim 0..2, only 0,1 present
    expect(r.result).toBe('FAIL');
    expect(r.offending_ids).toContain('seq:2');
  });

  it('duplicate sequence → no_missing_segment FAIL (located)', () => {
    const { genesis } = twoSegmentChain();
    const dup = mutManifest(genesis); // second segment also at sequence 0
    const r = recomputeNoMissingSegment([genesis, dup], scopeOf(0, 0));
    expect(r.result).toBe('FAIL');
    expect(r.offending_ids).toContain(genesis.manifest.segment_id);
  });

  it('genesis with non-null previous_segment → cross_segment_continuity FAIL (WV-11)', () => {
    const { genesis } = twoSegmentChain();
    const bad = mutManifest(genesis);
    bad.manifest.previous_segment = { segment_id: 'seg-x', segment_sequence: 9, segment_hash: 'sha256:' + 'a'.repeat(64) };
    const r = recomputeCrossSegment([bad]);
    expect(r.result).toBe('FAIL');
    expect(r.offending_ids).toContain(genesis.manifest.segment_id);
  });

  it('non-genesis missing previous_segment → cross_segment_continuity FAIL', () => {
    const { second } = twoSegmentChain();
    const r = recomputeCrossSegment([second]); // seq 1 alone; predecessor seq 0 not provided
    expect(r.result).toBe('FAIL');
    expect(r.offending_ids).toContain(second.manifest.segment_id);
  });

  it('cross-segment segment_hash mismatch → cross_segment_continuity FAIL', () => {
    const { genesis, second } = twoSegmentChain();
    const bad = mutManifest(second);
    bad.manifest.previous_segment = { ...bad.manifest.previous_segment!, segment_hash: 'sha256:' + 'b'.repeat(64) };
    const r = recomputeCrossSegment([genesis, bad]);
    expect(r.result).toBe('FAIL');
    expect(r.offending_ids).toContain(second.manifest.segment_id);
  });

  it('cross-boundary row_hash mismatch → cross_segment_continuity FAIL', () => {
    const { genesis, second } = twoSegmentChain();
    const bad = mutManifest(second);
    bad.objects[0]!.evidence.prev_row_hash = 'sha256:' + 'c'.repeat(64); // breaks the boundary link
    const r = recomputeCrossSegment([genesis, bad]);
    expect(r.result).toBe('FAIL');
    expect(r.offending_ids).toContain(second.manifest.segment_id);
  });

  it('offset endpoint mismatch → no_missing_event FAIL', () => {
    const { genesis } = twoSegmentChain();
    const bad = mutManifest(genesis);
    bad.manifest.source_offset_range.last_offset_key = `${UUID}:999`; // no longer the last object's consumed_offset_key
    const r = recomputeNoMissingEvent([bad]);
    expect(r.result).toBe('FAIL');
    expect(r.offending_ids).toContain(genesis.manifest.segment_id);
  });

  it('completeness gap_detected === true → no_missing_event FAIL', () => {
    const { genesis } = twoSegmentChain();
    const bad = mutManifest(genesis);
    bad.manifest.completeness_summary.gap_detected = true;
    const r = recomputeNoMissingEvent([bad]);
    expect(r.result).toBe('FAIL');
  });

  it('expected_continuous === false → no_missing_event FAIL', () => {
    const { genesis } = twoSegmentChain();
    const bad = mutManifest(genesis);
    bad.manifest.completeness_summary.expected_continuous = false;
    const r = recomputeNoMissingEvent([bad]);
    expect(r.result).toBe('FAIL');
  });

  it('T141-M1: truncated objects list → segment_manifest FAIL (located segment)', () => {
    const { genesis } = twoSegmentChain();
    const truncated: VerifierSegment = { manifest: genesis.manifest, objects: genesis.objects.slice(0, 1) }; // manifest claims 2, provide 1
    const r = recomputeSegment(truncated);
    expect(r.segment_manifest.result).toBe('FAIL');
    expect(r.segment_manifest.offending_ids).toContain(genesis.manifest.segment_id);
    expect(r.segment_manifest.details ?? '').toMatch(/objects\.length/);
  });

  it('T141-M1: extra objects list → segment_manifest FAIL', () => {
    const { genesis } = twoSegmentChain();
    const extra: VerifierSegment = { manifest: genesis.manifest, objects: [...genesis.objects, genesis.objects[0]!] }; // claims 2, provide 3
    expect(recomputeSegment(extra).segment_manifest.result).toBe('FAIL');
  });

  it('multi-segment aggregation: offending IDs are segment-prefixed and located', () => {
    const { genesis, second } = twoSegmentChain();
    const badSecond = mutManifest(second);
    (badSecond.objects[0]!.changes[0] as { after: Record<string, unknown> }).after.amount = '999.00'; // tamper object in seg 1
    const report = verifySegments({ db_id: 'kafel-dev-mysql', scope: scopeOf(0, 1), segments: [genesis, badSecond] });
    const poh = report.checks.find((c) => c.check === 'per_object_hash');
    expect(poh?.result).toBe('FAIL');
    expect(poh?.offending_ids?.some((id) => id.startsWith(`${second.manifest.segment_id}/`))).toBe(true);
    expect(report.overall_result).toBe('FAIL');
  });
});
