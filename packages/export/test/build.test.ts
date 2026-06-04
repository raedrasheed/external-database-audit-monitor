// Evidence Export Package builder tests (EDAM-T145). Fixtures build real
// segments/manifests/anchor-records with @edam/evidence + @edam/anchor-proof +
// node:crypto (a dev ExportSigner). Covers schema validity, package_hash,
// export-signature verification, §12.1 completeness, genesis-rooted continuity
// (accept + every refusal), loadExportPackage round-trip, and the optional WORM
// write helper over an injected port (no concrete WORM imported).
import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import {
  buildEvidenceExportPackage,
  writeExportPackageToWorm,
  computePackageHash,
  exportSigningMessage,
  ExportPackageError,
  type BuildExportInput,
  type ExportSegmentInput,
  type ExportObjectRef,
  type ExportSigner,
  type WormPutOptions,
  type WormWritePort,
} from '../src/index.js';
import { serializeCanonical, eventHash } from '@edam/canonical';
import { validateEvidenceExportPackage } from '@edam/contracts';
import { loadExportPackage } from '@edam/verifier';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { buildSegmentManifest, deriveSegmentHead, buildAnchorPayload, anchorPayloadHash, type SegmentManifest, type SegmentManifestInput, type PreviousSegmentRef } from '@edam/evidence';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const H = (c: string) => 'sha256:' + c.repeat(64);
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
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: seq } }, before: { id: seq, amount: '1.00' }, after: { id: seq, amount: '2.00' } }],
  };
}

function manifestFor(sequence: number, objects: Cce[], previousSegment: PreviousSegmentRef | null): SegmentManifest {
  const first = objects[0]!;
  const last = objects[objects.length - 1]!;
  const input: SegmentManifestInput = {
    db_id: 'kafel-dev-mysql', engine: 'mysql', segment_id: `seg-${String(sequence).padStart(6, '0')}`, segment_sequence: sequence, opened_at: '2026-06-01T10:00:00.000Z',
    event_count: objects.length, first_envelope_id: first.envelope_id, last_envelope_id: last.envelope_id,
    first_row_hash: first.evidence.row_hash, last_row_hash: last.evidence.row_hash,
    object_list: objects.map((c, seq) => ({ seq, object_id: c.envelope_id, worm_object_key: `db/seg-${sequence}/obj-${seq}`, object_type: 'cce' as const })),
    object_hash_list: objects.map((c, seq) => ({ seq, event_hash: c.evidence.event_hash, row_hash: c.evidence.row_hash })),
    source_offset_range: { first_offset_key: `${UUID}:${sequence}.0`, last_offset_key: `${UUID}:${sequence}.${objects.length - 1}` },
    fidelity_summary: { all_healthy: true, degraded_count: 0, compromised_count: 0, reasons: [] },
    completeness_summary: { gap_detected: false, expected_continuous: true, notes: [] },
    objects,
  };
  return buildSegmentManifest(input, { sealedAt: '2026-06-01T10:00:01.000Z', previousSegment });
}

/** A dev ExportSigner: Ed25519 over the domain-tagged export message. */
function devExportSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = spki(publicKey);
  const signing_key_id = 'edam-dev-export-ed25519-' + createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
  const signer: ExportSigner = {
    signExport(packageHash) {
      return { algorithm: 'ed25519', signing_key_id, signature: edSign(null, Buffer.from(exportSigningMessage(packageHash)), privateKey).toString('base64') };
    },
  };
  return { signer, signing_key_id, public_key: pub };
}

/** Two contiguous segments (genesis seq 0 + seq 1) with their manifests + minimal anchor-record strings. */
function twoSegments() {
  const c0 = buildCce(tx(0));
  const c1 = buildCce(tx(1), { prevRowHash: c0.evidence.row_hash });
  const seg0 = manifestFor(0, [c0, c1], null);
  const c2 = buildCce(tx(2), { prevRowHash: c1.evidence.row_hash });
  const seg1 = manifestFor(1, [c2], { segment_id: seg0.segment_id, segment_sequence: 0, segment_hash: deriveSegmentHead(seg0).segment_hash });
  const anchorRecord = (m: SegmentManifest): string => {
    const head = deriveSegmentHead(m);
    const payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
    return JSON.stringify({ anchor_version: 'anchor-record-1.0', anchor_id: UUID, db_id: 'kafel-dev-mysql', head: { ...payload }, payload_hash: anchorPayloadHash(payload) });
  };
  const segIn = (m: SegmentManifest, objs: Cce[]): ExportSegmentInput => ({
    segment_sequence: m.segment_sequence,
    object_ids: objs.map((c) => c.envelope_id),
    serialized_manifest: JSON.stringify(m),
    serialized_anchor_record: anchorRecord(m),
  });
  return { seg0In: segIn(seg0, [c0, c1]), seg1In: segIn(seg1, [c2]), objects: { c0, c1, c2 } };
}

function objectRef(c: Cce, sequence: number, seq: number): ExportObjectRef {
  return { object_id: c.envelope_id, object_type: 'cce', worm_object_key: `db/seg-${sequence}/obj-${seq}`, event_hash: c.evidence.event_hash };
}

function baseInput(overrides: Partial<BuildExportInput> = {}): BuildExportInput {
  const { seg0In, seg1In, objects } = twoSegments();
  const { signer } = devExportSigner();
  return {
    package_id: '11111111-2222-4333-8444-555555555555',
    db_id: 'kafel-dev-mysql',
    purpose: 'legal_audit',
    created_at: '2026-06-01T12:00:00.000Z',
    created_by: 'edam-export',
    selected_object_refs: [objectRef(objects.c2, 1, 0)], // a seq-1 object => requires segments 0 and 1
    segments: [seg0In, seg1In],
    public_keys: [{ key_id: 'edam-dev-ed25519-1', algorithm: 'ed25519', public_key: 'BASE64SPKI', revoked_at: null }],
    timestamp_certificates: ['{"tsa_cert_ref":"dev-tsa","algorithm":"ed25519","public_key":"x"}'],
    verification_instructions: { spec_id: 'worm-v1', spec_hash: H('a') },
    chain_of_custody_log: [{ custody_event_id: 'ce-1', action: 'export', reviewer_identity: 'auditor', reason: 'case-123', occurred_at: '2026-06-01T12:00:00.000Z' }],
    signer,
    ...overrides,
  };
}

describe('buildEvidenceExportPackage (T145)', () => {
  it('1. package validates against evidence-export-package-1.0', () => {
    const pkg = buildEvidenceExportPackage(baseInput());
    expect(validateEvidenceExportPackage(pkg).valid, JSON.stringify(validateEvidenceExportPackage(pkg).errors)).toBe(true);
  });

  it('2. package_hash equals canonical hash of the package without export_signature', () => {
    const pkg = buildEvidenceExportPackage(baseInput());
    const { export_signature, ...withoutSig } = pkg;
    expect(export_signature.package_hash).toBe(eventHash(serializeCanonical(withoutSig)));
    expect(export_signature.package_hash).toBe(computePackageHash(withoutSig));
  });

  it('3. export signature verifies against the dev export public key (domain-tagged message)', () => {
    const { seg0In, seg1In, objects } = twoSegments();
    const { signer, public_key } = devExportSigner();
    const pkg = buildEvidenceExportPackage(baseInput({ segments: [seg0In, seg1In], selected_object_refs: [objectRef(objects.c2, 1, 0)], signer }));
    const key = createPublicKey({ key: Buffer.from(public_key, 'base64'), format: 'der', type: 'spki' });
    const ok = edVerify(null, Buffer.from(exportSigningMessage(pkg.export_signature.package_hash)), key, Buffer.from(pkg.export_signature.signature, 'base64'));
    expect(ok).toBe(true);
  });

  it('4. all §12.1 components are present', () => {
    const pkg = buildEvidenceExportPackage(baseInput());
    expect(pkg.object_refs.length).toBeGreaterThan(0);
    expect(pkg.segment_manifests.length).toBe(2); // genesis-rooted: segments 0 + 1
    expect(pkg.anchor_records.length).toBe(2);
    expect(pkg.public_keys.length).toBeGreaterThan(0);
    expect(pkg.timestamp_certificates.length).toBeGreaterThan(0);
    expect(pkg.verification_instructions.spec_hash).toMatch(/^sha256:/);
    expect(pkg.chain_of_custody_log.length).toBeGreaterThan(0);
    expect(pkg.export_signature.signing_key_id).toMatch(/^edam-dev-export-ed25519-/);
  });

  it('5. genesis-rooted contiguous selection succeeds', () => {
    expect(() => buildEvidenceExportPackage(baseInput())).not.toThrow();
  });

  it('6. gapped/cherry-picked selection is refused (segment 0 omitted -> seq 1 only)', () => {
    const { seg1In, objects } = twoSegments();
    expect(() => buildEvidenceExportPackage(baseInput({ segments: [seg1In], selected_object_refs: [objectRef(objects.c2, 1, 0)] }))).toThrow(ExportPackageError);
  });

  it('7. missing genesis is refused', () => {
    const { seg1In, objects } = twoSegments();
    // Select a seq-1 object but supply only seq 1 => genesis (0) missing.
    expect(() => buildEvidenceExportPackage(baseInput({ segments: [seg1In], selected_object_refs: [objectRef(objects.c2, 1, 0)] }))).toThrow(/genesis|gap|missing covering/);
  });

  it('8. missing covering manifest (empty manifest string) is refused', () => {
    const { seg0In, seg1In, objects } = twoSegments();
    expect(() => buildEvidenceExportPackage(baseInput({ segments: [{ ...seg0In, serialized_manifest: '' }, seg1In], selected_object_refs: [objectRef(objects.c2, 1, 0)] }))).toThrow(/missing manifest/);
  });

  it('9. missing anchor record is refused', () => {
    const { seg0In, seg1In, objects } = twoSegments();
    expect(() => buildEvidenceExportPackage(baseInput({ segments: [{ ...seg0In, serialized_anchor_record: '' }, seg1In], selected_object_refs: [objectRef(objects.c2, 1, 0)] }))).toThrow(/missing anchor record/);
  });

  it('10. selected object ref not covered by included manifests is refused', () => {
    const { seg0In, seg1In } = twoSegments();
    const ghost: ExportObjectRef = { object_id: '99999999-2222-4333-8444-555555555555', object_type: 'cce', worm_object_key: 'db/x', event_hash: H('e') };
    expect(() => buildEvidenceExportPackage(baseInput({ segments: [seg0In, seg1In], selected_object_refs: [ghost] }))).toThrow(/not covered/);
  });

  it('11. package loads through the verifier loadExportPackage', () => {
    const pkg = buildEvidenceExportPackage(baseInput());
    expect(loadExportPackage(pkg).package_id).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('12 & 13. optional WORM write helper uses the injected putImmutable (no concrete WORM import)', async () => {
    const pkg = buildEvidenceExportPackage(baseInput());
    const writes: Array<{ key: string; opts: WormPutOptions; bytes: number }> = [];
    const worm: WormWritePort = {
      async putImmutable(key, bytes, opts) {
        writes.push({ key, opts, bytes: bytes.length });
      },
    };
    const key = await writeExportPackageToWorm(worm, pkg, {});
    expect(key).toBe('exports/kafel-dev-mysql/11111111-2222-4333-8444-555555555555.json');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.opts.retentionMode).toBe('compliance');
    // B2: the writer's options carry ONLY retentionMode — no retainUntil/legalHold.
    expect(Object.keys(writes[0]!.opts)).toEqual(['retentionMode']);
    expect(writes[0]!.bytes).toBeGreaterThan(0);
  });
});
