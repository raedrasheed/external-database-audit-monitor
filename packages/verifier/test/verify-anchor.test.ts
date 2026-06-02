// Verifier §10 steps 7-8 tests (EDAM-T143): hsm_signature + anchor_token.
//
// Fixtures (a real Ed25519 HSM signature + a real RFC-3161 / transparency-log
// token) are built with node:crypto + @edam/evidence + @edam/anchor-proof ONLY —
// no @edam/signing, no @edam/anchoring imports — so the verifier test stays
// isolation-clean and proves the verifier accepts genuinely-produced artifacts
// using nothing but trusted published key/cert directories.
import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import {
  verifySegments,
  InMemorySigningKeyDirectory,
  InMemoryAnchorCertDirectory,
  type VerifierSegment,
  type AnchorRecord,
  type AnchorRecordProvider,
} from '../src/index.js';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import {
  buildSegmentManifest,
  deriveSegmentHead,
  buildAnchorPayload,
  anchorSigningMessage,
  anchorPayloadHash,
  type SegmentManifest,
  type SegmentManifestInput,
  type AnchorPayload,
} from '@edam/evidence';
import { tstSigningBytes, leafHashFromPayload, merkleTreeHash, inclusionPath, sthSigningBytes } from '@edam/anchor-proof';
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

function transparencyLog(payloadHash: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const log_id = 'dev-ct-test';
  const leaves = [leafHashFromPayload(payloadHash)];
  const sth = { log_id, tree_size: 1, root_hash: merkleTreeHash(leaves).toString('hex'), sth_time: GEN_TIME };
  const signature = edSign(null, Buffer.from(sthSigningBytes(sth as never)), privateKey).toString('base64');
  const signed_tree_head = Buffer.from(JSON.stringify({ sth, signature, signature_algorithm: 'ed25519' }), 'utf8').toString('base64');
  const proof = { log_id, leaf_index: 0, inclusion_proof: inclusionPath(0, leaves).map((b) => b.toString('hex')), signed_tree_head };
  return { provider: { type: 'transparency_log' as const, transparency_log: proof }, cert: { ref: log_id, algorithm: 'ed25519', public_key: spki(publicKey) } };
}

function anchoredSegment(kind: 'rfc3161' | 'transparency_log') {
  const objects = [buildCce(tx(0))];
  objects.push(buildCce(tx(1), { prevRowHash: objects[0]!.evidence.row_hash }));
  const manifest = genesisManifest(objects);
  const head = deriveSegmentHead(manifest);
  const payload = buildAnchorPayload(head, { headCount: 1, signedAt: SIGNED_AT });
  const payloadHash = anchorPayloadHash(payload);
  const { hsm_signature, key } = hsmSign(payload);
  const anchor = kind === 'rfc3161' ? rfc3161(payloadHash) : transparencyLog(payloadHash);
  const record: AnchorRecord = {
    anchor_version: 'anchor-record-1.0', anchor_id: '99999999-2222-4333-8444-555555555555', db_id: 'kafel-dev-mysql',
    head: { segment_id: head.segment_id, segment_sequence: head.segment_sequence, segment_hash: head.segment_hash, last_row_hash: head.last_row_hash, head_count: 1, signed_at: SIGNED_AT },
    hsm_signature, anchor_provider: anchor.provider as AnchorRecordProvider, created_at: GEN_TIME,
  };
  const segment: VerifierSegment = { manifest, objects: structuredClone(objects) as Cce[], anchorRecord: record };
  return { segment, key, cert: anchor.cert };
}

function run(seg: VerifierSegment, keys?: InMemorySigningKeyDirectory, certs?: InMemoryAnchorCertDirectory) {
  return verifySegments({ db_id: 'kafel-dev-mysql', scope: SCOPE, segments: [seg], trustedKeys: keys, trustedCerts: certs, reportId: '11111111-2222-4333-8444-555555555555', generatedAt: '2026-06-01T12:00:00.000Z' });
}
const dirs = (f: ReturnType<typeof anchoredSegment>) => ({ keys: new InMemorySigningKeyDirectory([f.key]), certs: new InMemoryAnchorCertDirectory([f.cert]) });
const checkOf = (r: ReturnType<typeof verifySegments>, name: string) => r.checks.find((c) => c.check === name)!;

describe('§10 steps 7-8 (T143)', () => {
  it('1. valid HSM signature + RFC-3161 token => overall PASS', () => {
    const f = anchoredSegment('rfc3161');
    const { keys, certs } = dirs(f);
    const r = run(f.segment, keys, certs);
    expect(validateVerificationReport(r).valid, JSON.stringify(validateVerificationReport(r).errors)).toBe(true);
    expect(checkOf(r, 'hsm_signature').result).toBe('PASS');
    expect(checkOf(r, 'anchor_token').result).toBe('PASS');
    expect(checkOf(r, 'anchor_token').details ?? '').toMatch(/gen_time=/);
    expect(checkOf(r, 'projection_consistency').result).toBe('SKIPPED');
    expect(r.overall_result).toBe('PASS');
  });

  it('2. valid HSM signature + transparency-log token => overall PASS', () => {
    const f = anchoredSegment('transparency_log');
    const { keys, certs } = dirs(f);
    const r = run(f.segment, keys, certs);
    expect(checkOf(r, 'anchor_token').details ?? '').toMatch(/sth_time=/);
    expect(r.overall_result).toBe('PASS');
  });

  it('3. forged HSM signature => hsm_signature FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { keys, certs } = dirs(f);
    f.segment.anchorRecord!.hsm_signature.signature = Buffer.from('x'.repeat(64)).toString('base64');
    expect(checkOf(run(f.segment, keys, certs), 'hsm_signature').result).toBe('FAIL');
  });

  it('4. unknown signing key => hsm_signature FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { certs } = dirs(f);
    expect(checkOf(run(f.segment, new InMemorySigningKeyDirectory([]), certs), 'hsm_signature').details ?? '').toMatch(/unknown signing_key_id/);
  });

  it('5. algorithm mismatch => hsm_signature FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { certs } = dirs(f);
    const wrong = new InMemorySigningKeyDirectory([{ ...f.key, algorithm: 'ecdsa-p384' }]);
    expect(checkOf(run(f.segment, wrong, certs), 'hsm_signature').result).toBe('FAIL');
  });

  it('6. key revoked at/before signed_at => hsm_signature FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { certs } = dirs(f);
    const revoked = new InMemorySigningKeyDirectory([{ ...f.key, revoked_at: '2026-06-01T10:05:00.000Z' }]); // before signed_at 10:05:01
    expect(checkOf(run(f.segment, revoked, certs), 'hsm_signature').details ?? '').toMatch(/revoked/);
  });

  it('7. signature over a different head => hsm_signature FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { keys, certs } = dirs(f);
    f.segment.anchorRecord!.head.segment_hash = 'sha256:' + 'd'.repeat(64);
    expect(checkOf(run(f.segment, keys, certs), 'hsm_signature').result).toBe('FAIL');
  });

  it('8. forged RFC-3161 token => anchor_token FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { keys, certs } = dirs(f);
    f.segment.anchorRecord!.anchor_provider.rfc3161_token = Buffer.from('{"tst_info":{"version":1},"signature":"x","signature_algorithm":"ed25519"}').toString('base64');
    expect(checkOf(run(f.segment, keys, certs), 'anchor_token').result).toBe('FAIL');
  });

  it('9. forged transparency-log token => anchor_token FAIL', () => {
    const f = anchoredSegment('transparency_log');
    const { keys, certs } = dirs(f);
    f.segment.anchorRecord!.anchor_provider.transparency_log!.inclusion_proof = ['f'.repeat(64)];
    expect(checkOf(run(f.segment, keys, certs), 'anchor_token').result).toBe('FAIL');
  });

  it('10. missing TSA/log cert => anchor_token FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { keys } = dirs(f);
    expect(checkOf(run(f.segment, keys, new InMemoryAnchorCertDirectory([])), 'anchor_token').details ?? '').toMatch(/missing TSA cert/);
  });

  it('11. token over the wrong payload hash => anchor_token FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { keys, certs } = dirs(f);
    f.segment.anchorRecord!.head.head_count = 7; // recomputed payload hash now differs from the token imprint
    expect(checkOf(run(f.segment, keys, certs), 'anchor_token').result).toBe('FAIL');
  });

  it('12. post-anchor object tamper: HSM signature stays valid, object checks FAIL, overall FAIL', () => {
    const f = anchoredSegment('rfc3161');
    const { keys, certs } = dirs(f);
    (f.segment.objects[1]!.changes[0] as { after: Record<string, unknown> }).after.amount = '999.00'; // tamper content (manifest unchanged)
    const r = run(f.segment, keys, certs);
    expect(checkOf(r, 'hsm_signature').result).toBe('PASS'); // signature still valid for the unchanged head — proves post-seal
    expect(checkOf(r, 'per_object_hash').result).toBe('FAIL'); // §10.1 locates the tamper
    expect(r.overall_result).toBe('FAIL');
  });

  it('13. absent anchor record / trust roots => hsm_signature & anchor_token SKIPPED, overall FAIL-closed', () => {
    const f = anchoredSegment('rfc3161');
    const noTrust = run({ manifest: f.segment.manifest, objects: f.segment.objects }); // no trust dirs, no anchorRecord
    expect(checkOf(noTrust, 'hsm_signature').result).toBe('SKIPPED');
    expect(checkOf(noTrust, 'anchor_token').result).toBe('SKIPPED');
    expect(noTrust.overall_result).toBe('FAIL');
  });
});
