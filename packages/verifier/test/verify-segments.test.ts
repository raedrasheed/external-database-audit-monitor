// Verifier §10 steps 1-3 tests (EDAM-T141): per_object_hash, object_chain,
// segment_manifest recompute — valid path, tampered object, broken chain,
// manifest mismatch, malformed inputs, and fail-closed report semantics
// (T140-M1). Fixtures use ONLY @edam/cce-model + @edam/evidence (no writer
// import) to preserve verifier isolation.
import { describe, it, expect } from 'vitest';
import { recomputeSegment, verifySegments, VerificationReportBuilder, type VerifierSegment } from '../src/index.js';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { buildSegmentManifest, type SegmentManifest, type SegmentManifestInput } from '@edam/evidence';
import { validateVerificationReport } from '@edam/contracts';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const SCOPE = { first_segment_sequence: 0, last_segment_sequence: 0 };

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

/** A valid, properly-chained, manifest-consistent segment, built without the writer. */
function validSegment(): VerifierSegment {
  const c1 = buildCce(tx(1));
  const c2 = buildCce(tx(2), { prevRowHash: c1.evidence.row_hash });
  const c3 = buildCce(tx(3), { prevRowHash: c2.evidence.row_hash });
  const objects = [c1, c2, c3];
  const input: SegmentManifestInput = {
    db_id: 'kafel-dev-mysql',
    engine: 'mysql',
    segment_id: 'seg-000000',
    segment_sequence: 0,
    opened_at: '2026-06-01T10:00:00.000Z',
    event_count: objects.length,
    first_envelope_id: c1.envelope_id,
    last_envelope_id: c3.envelope_id,
    first_row_hash: c1.evidence.row_hash,
    last_row_hash: c3.evidence.row_hash,
    object_list: objects.map((c, seq) => ({ seq, object_id: c.envelope_id, worm_object_key: `k/${seq}`, object_type: 'cce' as const })),
    object_hash_list: objects.map((c, seq) => ({ seq, event_hash: c.evidence.event_hash, row_hash: c.evidence.row_hash })),
    source_offset_range: { first_offset_key: `${UUID}:1`, last_offset_key: `${UUID}:3` },
    fidelity_summary: { all_healthy: true, degraded_count: 0, compromised_count: 0, reasons: [] },
    completeness_summary: { gap_detected: false, expected_continuous: true, notes: [] },
    objects,
  };
  const manifest = buildSegmentManifest(input, { sealedAt: '2026-06-01T10:00:01.000Z', previousSegment: null });
  return { manifest, objects: structuredClone(objects) }; // objects mutable (manifest is frozen)
}

/** A mutable deep copy of a segment (manifest unfrozen) for tamper tests. */
function mutableCopy(seg: VerifierSegment): { manifest: SegmentManifest; objects: Cce[] } {
  return { manifest: structuredClone(seg.manifest) as SegmentManifest, objects: structuredClone(seg.objects) as Cce[] };
}

describe('recomputeSegment / verifySegments — §10 steps 1-3 (T141)', () => {
  it('valid chain: per_object_hash / object_chain / segment_manifest all PASS', () => {
    const r = recomputeSegment(validSegment());
    expect(r.per_object_hash.result).toBe('PASS');
    expect(r.object_chain.result).toBe('PASS');
    expect(r.segment_manifest.result).toBe('PASS');
  });

  it('valid single (genesis) segment: steps 1-6 PASS, T143/T144 SKIPPED, FAIL-closed overall', () => {
    const report = verifySegments({ db_id: 'kafel-dev-mysql', scope: SCOPE, segments: [validSegment()], reportId: '11111111-2222-4333-8444-555555555555', generatedAt: '2026-06-01T12:00:00.000Z' });
    expect(validateVerificationReport(report).valid, JSON.stringify(validateVerificationReport(report).errors)).toBe(true);
    const byName = new Map(report.checks.map((c) => [c.check, c.result]));
    // Steps 1-6 (T141 + T142) all PASS for a valid genesis segment.
    for (const c of ['per_object_hash', 'object_chain', 'segment_manifest', 'cross_segment_continuity', 'no_missing_segment', 'no_missing_event'] as const) {
      expect(byName.get(c), c).toBe('PASS');
    }
    // T143 (HSM/anchor-token) + T144 (projection) remain SKIPPED.
    for (const c of ['hsm_signature', 'anchor_token', 'projection_consistency'] as const) {
      expect(byName.get(c)).toBe('SKIPPED');
    }
    // T140-M1: required checks (HSM/anchor-token) remain SKIPPED ⇒ overall is NOT PASS.
    expect(report.overall_result).toBe('FAIL');
  });

  it('tampered object: per_object_hash FAILs and locates the offending object', () => {
    const seg = mutableCopy(validSegment());
    (seg.objects[1]!.changes[0] as { after: Record<string, unknown> }).after.amount = '999.00'; // mutate core ⇒ event_hash no longer recomputes
    const r = recomputeSegment(seg);
    expect(r.per_object_hash.result).toBe('FAIL');
    expect(r.per_object_hash.offending_ids).toContain(seg.objects[1]!.envelope_id);
    const report = verifySegments({ db_id: 'kafel-dev-mysql', scope: SCOPE, segments: [seg] });
    expect(report.checks.find((c) => c.check === 'per_object_hash')?.result).toBe('FAIL');
    expect(report.overall_result).toBe('FAIL');
  });

  it('broken chain: object_chain FAILs (prev_row_hash / row_hash linkage)', () => {
    const seg = mutableCopy(validSegment());
    seg.objects[2]!.evidence.prev_row_hash = 'sha256:' + 'd'.repeat(64); // break the link into object 2
    const r = recomputeSegment(seg);
    expect(r.object_chain.result).toBe('FAIL');
    expect(r.object_chain.offending_ids).toContain(seg.objects[2]!.envelope_id);
    expect(r.per_object_hash.result).toBe('PASS'); // event_hash (core) is unaffected
  });

  it('manifest mismatch: segment_manifest FAILs (manifest_hash + field cross-check)', () => {
    const seg = mutableCopy(validSegment());
    seg.manifest.last_row_hash = 'sha256:' + 'e'.repeat(64); // tamper a hashed manifest field
    const r = recomputeSegment(seg);
    expect(r.segment_manifest.result).toBe('FAIL');
    expect(r.segment_manifest.offending_ids).toContain('seg-000000');
    expect(r.segment_manifest.details ?? '').toMatch(/manifest_hash|last_row_hash/);
  });

  it('malformed inputs: empty segment and a schema-invalid manifest fail closed', () => {
    const empty: VerifierSegment = { manifest: validSegment().manifest, objects: [] };
    const re = recomputeSegment(empty);
    expect(re.per_object_hash.result).toBe('FAIL');
    expect(re.object_chain.result).toBe('FAIL');

    const seg = mutableCopy(validSegment());
    (seg.manifest as { event_count: unknown }).event_count = -5; // schema-invalid + field mismatch
    expect(recomputeSegment(seg).segment_manifest.result).toBe('FAIL');
  });

  it('fail-closed report semantics (T140-M1)', () => {
    const base = { db_id: 'd', verifier: { type: 'independent_external' as const }, scope: SCOPE, reportId: '22222222-2222-4333-8444-555555555555', generatedAt: '2026-06-01T12:00:00.000Z' };
    const required = ['per_object_hash', 'object_chain', 'segment_manifest', 'cross_segment_continuity', 'no_missing_segment', 'no_missing_event', 'hsm_signature', 'anchor_token'] as const;

    // All required PASS + projection SKIPPED ⇒ PASS (projection is advisory).
    const allPass = new VerificationReportBuilder(base);
    for (const c of required) allPass.add({ check: c, result: 'PASS' });
    allPass.skip('projection_consistency');
    expect(allPass.build().overall_result).toBe('PASS');

    // One required check SKIPPED ⇒ NOT PASS (fail-closed).
    const oneSkipped = new VerificationReportBuilder(base);
    for (const c of required.filter((c) => c !== 'hsm_signature')) oneSkipped.add({ check: c, result: 'PASS' });
    oneSkipped.skip('hsm_signature').skip('projection_consistency');
    expect(oneSkipped.build().overall_result).toBe('FAIL');

    // Any FAIL ⇒ FAIL.
    const oneFail = new VerificationReportBuilder(base);
    for (const c of required) oneFail.add({ check: c, result: c === 'object_chain' ? 'FAIL' : 'PASS' });
    oneFail.skip('projection_consistency');
    expect(oneFail.build().overall_result).toBe('FAIL');
  });
});
