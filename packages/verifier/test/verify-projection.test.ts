// Verifier §10 step 9 tests (EDAM-T144): projection_consistency (advisory).
// Builds a fully-valid signed + anchored genesis segment (node:crypto +
// @edam/evidence + @edam/anchor-proof only — isolation-clean), so overall can
// reach PASS, then exercises projection PASS/FAIL/SKIP and proves drift is
// reported SEPARATELY from evidence integrity (drift FAIL keeps overall PASS).
import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import {
  verifySegments,
  InMemorySigningKeyDirectory,
  InMemoryAnchorCertDirectory,
  type VerifierSegment,
  type AnchorRecord,
  type AnchorRecordProvider,
  type ProjectionSnapshot,
} from '../src/index.js';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { buildSegmentManifest, deriveSegmentHead, buildAnchorPayload, anchorSigningMessage, anchorPayloadHash, type SegmentManifest, type SegmentManifestInput, type AnchorPayload } from '@edam/evidence';
import { tstSigningBytes } from '@edam/anchor-proof';
import { validateVerificationReport } from '@edam/contracts';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const SCOPE = { first_segment_sequence: 0, last_segment_sequence: 0 };
const SIGNED_AT = '2026-06-01T10:05:01.000Z';
const GEN_TIME = '2026-06-01T10:05:05.000Z';
const spki = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');

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

function genesisManifest(objects: Cce[]): SegmentManifest {
  const first = objects[0]!;
  const last = objects[objects.length - 1]!;
  const input: SegmentManifestInput = {
    db_id: 'kafel-dev-mysql', engine: 'mysql', segment_id: 'seg-000000', segment_sequence: 0, opened_at: '2026-06-01T10:00:00.000Z',
    event_count: objects.length, first_envelope_id: first.envelope_id, last_envelope_id: last.envelope_id,
    first_row_hash: first.evidence.row_hash, last_row_hash: last.evidence.row_hash,
    object_list: objects.map((c, seq) => ({ seq, object_id: c.envelope_id, worm_object_key: `k/${seq}`, object_type: 'cce' as const })),
    object_hash_list: objects.map((c, seq) => ({ seq, event_hash: c.evidence.event_hash, row_hash: c.evidence.row_hash })),
    source_offset_range: { first_offset_key: `${UUID}:0`, last_offset_key: `${UUID}:${objects.length - 1}` },
    fidelity_summary: { all_healthy: true, degraded_count: 0, compromised_count: 0, reasons: [] },
    completeness_summary: { gap_detected: false, expected_continuous: true, notes: [] },
    objects,
  };
  return buildSegmentManifest(input, { sealedAt: '2026-06-01T10:00:01.000Z', previousSegment: null });
}

function hsmSign(payload: AnchorPayload) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = spki(publicKey);
  const signing_key_id = 'edam-dev-ed25519-' + createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
  const signature = edSign(null, Buffer.from(anchorSigningMessage(payload)), privateKey).toString('base64');
  return { hsm_signature: { algorithm: 'ed25519', signing_key_id, signature }, key: { key_id: signing_key_id, algorithm: 'ed25519', public_key: pub, revoked_at: null as string | null } };
}

function rfc3161(payloadHash: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const tsa_cert_ref = 'dev-tsa-test';
  const tst = { version: 1, policy: 'p', message_imprint: { hash_algorithm: 'sha-256', hashed_message: payloadHash }, serial_number: 's1', gen_time: GEN_TIME, tsa_cert_ref };
  const signature = edSign(null, Buffer.from(tstSigningBytes(tst as never)), privateKey).toString('base64');
  const rfc3161_token = Buffer.from(JSON.stringify({ tst_info: tst, signature, signature_algorithm: 'ed25519' }), 'utf8').toString('base64');
  return { provider: { type: 'rfc3161' as const, rfc3161_token, tsa_cert_ref }, cert: { ref: tsa_cert_ref, algorithm: 'ed25519', public_key: spki(publicKey) } };
}

/** A fully-valid signed + anchored genesis segment + the trusted directories. */
function validAnchored() {
  const objects = [buildCce(tx(0))];
  objects.push(buildCce(tx(1), { prevRowHash: objects[0]!.evidence.row_hash }));
  const manifest = genesisManifest(objects);
  const head = deriveSegmentHead(manifest);
  const payload = buildAnchorPayload(head, { headCount: 1, signedAt: SIGNED_AT });
  const { hsm_signature, key } = hsmSign(payload);
  const anchor = rfc3161(anchorPayloadHash(payload));
  const record: AnchorRecord = {
    anchor_version: 'anchor-record-1.0', anchor_id: '99999999-2222-4333-8444-555555555555', db_id: 'kafel-dev-mysql',
    head: { segment_id: head.segment_id, segment_sequence: head.segment_sequence, segment_hash: head.segment_hash, last_row_hash: head.last_row_hash, head_count: 1, signed_at: SIGNED_AT },
    hsm_signature, anchor_provider: anchor.provider as AnchorRecordProvider, created_at: GEN_TIME,
  };
  const segment: VerifierSegment = { manifest, objects: structuredClone(objects) as Cce[], anchorRecord: record };
  return {
    segment,
    keys: new InMemorySigningKeyDirectory([key]),
    certs: new InMemoryAnchorCertDirectory([anchor.cert]),
    matchingProjection: { rows: segment.objects.map((c) => ({ object_id: c.envelope_id, row_hash: c.evidence.row_hash })) } as ProjectionSnapshot,
  };
}

function run(f: ReturnType<typeof validAnchored>, projection?: ProjectionSnapshot, seg = f.segment) {
  return verifySegments({ db_id: 'kafel-dev-mysql', scope: SCOPE, segments: [seg], trustedKeys: f.keys, trustedCerts: f.certs, projection, reportId: '11111111-2222-4333-8444-555555555555', generatedAt: '2026-06-01T12:00:00.000Z' });
}
const checkOf = (r: ReturnType<typeof verifySegments>, name: string) => r.checks.find((c) => c.check === name)!;

describe('§10 step 9 projection_consistency (T144)', () => {
  it('1. matching projection => projection_consistency PASS, overall PASS, report validates', () => {
    const f = validAnchored();
    const r = run(f, f.matchingProjection);
    expect(validateVerificationReport(r).valid, JSON.stringify(validateVerificationReport(r).errors)).toBe(true);
    expect(checkOf(r, 'projection_consistency').result).toBe('PASS');
    expect(r.overall_result).toBe('PASS');
  });

  it('2 & 8. row-hash mismatch => projection_consistency FAIL but overall PASS (advisory; integrity intact)', () => {
    const f = validAnchored();
    const drifted: ProjectionSnapshot = { rows: f.matchingProjection.rows.map((row, i) => (i === 1 ? { ...row, row_hash: 'sha256:' + 'd'.repeat(64) } : row)) };
    const r = run(f, drifted);
    expect(checkOf(r, 'projection_consistency').result).toBe('FAIL');
    expect(checkOf(r, 'projection_consistency').offending_ids).toContain(f.segment.objects[1]!.envelope_id);
    // integrity checks all PASS, so overall stays PASS despite the advisory drift
    expect(checkOf(r, 'hsm_signature').result).toBe('PASS');
    expect(r.overall_result).toBe('PASS');
    expect(validateVerificationReport(r).valid).toBe(true);
  });

  it('3. missing projection row => FAIL with the located object_id (overall PASS)', () => {
    const f = validAnchored();
    const missing: ProjectionSnapshot = { rows: [f.matchingProjection.rows[0]!] }; // omit object 1
    const r = run(f, missing);
    expect(checkOf(r, 'projection_consistency').result).toBe('FAIL');
    expect(checkOf(r, 'projection_consistency').offending_ids).toContain(f.segment.objects[1]!.envelope_id);
    expect(r.overall_result).toBe('PASS');
  });

  it('4. extra projection row => FAIL with the located object_id (overall PASS)', () => {
    const f = validAnchored();
    const extra: ProjectionSnapshot = { rows: [...f.matchingProjection.rows, { object_id: 'ghost-object', row_hash: 'sha256:' + 'e'.repeat(64) }] };
    const r = run(f, extra);
    expect(checkOf(r, 'projection_consistency').result).toBe('FAIL');
    expect(checkOf(r, 'projection_consistency').offending_ids).toContain('ghost-object');
    expect(r.overall_result).toBe('PASS');
  });

  it('5. absent projection => projection_consistency SKIPPED (overall PASS)', () => {
    const f = validAnchored();
    const r = run(f, undefined);
    expect(checkOf(r, 'projection_consistency').result).toBe('SKIPPED');
    expect(r.overall_result).toBe('PASS');
  });

  it('6. integrity FAIL + projection PASS => overall FAIL (integrity dominates)', () => {
    const f = validAnchored();
    (f.segment.objects[1]!.changes[0] as { after: Record<string, unknown> }).after.amount = '999.00'; // tamper => per_object_hash FAIL
    const r = run(f, f.matchingProjection);
    expect(checkOf(r, 'projection_consistency').result).toBe('PASS'); // projection still matches the (unchanged) row_hashes
    expect(checkOf(r, 'per_object_hash').result).toBe('FAIL');
    expect(r.overall_result).toBe('FAIL');
    expect(validateVerificationReport(r).valid).toBe(true);
  });

  it('7. report validates across all projection states', () => {
    const f = validAnchored();
    for (const proj of [f.matchingProjection, { rows: [] } as ProjectionSnapshot, undefined]) {
      expect(validateVerificationReport(run(f, proj)).valid).toBe(true);
    }
  });
});
