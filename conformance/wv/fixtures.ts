// WV conformance fixtures (EDAM-T148): build a canonical genesis-rooted, signed,
// anchored two-segment chain using the REAL frozen implementations, plus the
// out-of-band trust roots, the export package, and the sidecar object bundle.
// Negative WV cases mutate copies of these artifacts. No verifier behavior is
// touched — the verifier/CLI are consumed as-is.

import { buildCce, type Cce, type NormalizedChange, type NormalizedTransaction } from '@edam/cce-model';
import {
  buildSegmentManifest, deriveSegmentHead, buildAnchorPayload, computeManifestHash, GENESIS_PREVIOUS_SEGMENT_HASH,
  type SegmentManifest, type SegmentManifestInput, type SegmentManifestCore, type PreviousSegmentRef,
} from '@edam/evidence';
import { DevEd25519Signer } from '@edam/signing';
import { DevRfc3161Provider, requestAnchor, anchorRequestFor, isAnchored, buildAnchorRecord } from '@edam/anchoring';
import {
  InMemorySigningKeyDirectory, InMemoryAnchorCertDirectory,
  type TrustedSigningKeyDirectory, type TrustedAnchorCertDirectory, type VerifierSegment, type AnchorRecord as VerifierAnchorRecord,
} from '@edam/verifier';
import { buildEvidenceExportPackage, exportSigningMessage, type BuildExportInput, type ExportSegmentInput, type ExportObjectRef, type ExportSigner } from '@edam/export';
import { generateKeyPairSync, createHash, sign as edSign, type KeyObject } from 'node:crypto';

export const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
export const DB = 'kafel-dev-mysql';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const spki = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');

function tx(seq: number, consumedOffsetKey?: string): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  const changes: NormalizedChange[] = [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: seq } }, before: { id: seq, amount: '1.00' }, after: { id: seq, amount: '2.00' } }];
  return {
    source: { db_id: DB, engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: HEALTHY,
    completeness: { consumed_offset_key: consumedOffsetKey ?? id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes,
  };
}

export function wormKey(segId: string, seq: number): string {
  return `${DB}/${segId}/${String(seq).padStart(6, '0')}.cce.json`;
}

export function manifestFor(sequence: number, segId: string, objects: Cce[], previousSegment: PreviousSegmentRef | null): SegmentManifest {
  const first = objects[0]!;
  const last = objects[objects.length - 1]!;
  const input: SegmentManifestInput = {
    db_id: DB, engine: 'mysql', segment_id: segId, segment_sequence: sequence, opened_at: '2026-06-01T10:00:00.000Z',
    event_count: objects.length, first_envelope_id: first.envelope_id, last_envelope_id: last.envelope_id,
    first_row_hash: first.evidence.row_hash, last_row_hash: last.evidence.row_hash,
    object_list: objects.map((c, seq) => ({ seq, object_id: c.envelope_id, worm_object_key: wormKey(segId, seq), object_type: 'cce' as const })),
    object_hash_list: objects.map((c, seq) => ({ seq, event_hash: c.evidence.event_hash, row_hash: c.evidence.row_hash })),
    source_offset_range: { first_offset_key: first.completeness.consumed_offset_key, last_offset_key: last.completeness.consumed_offset_key },
    fidelity_summary: { all_healthy: true, degraded_count: 0, compromised_count: 0, reasons: [] },
    completeness_summary: { gap_detected: false, expected_continuous: true, notes: [] },
    objects,
  };
  return buildSegmentManifest(input, { sealedAt: '2026-06-01T10:00:01.000Z', previousSegment });
}

/** A dev export signer: Ed25519 over the domain-tagged export message. */
function devExportSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = spki(publicKey);
  const signing_key_id = 'edam-dev-export-' + createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
  const signer: ExportSigner = {
    signExport: (h) => ({ algorithm: 'ed25519', signing_key_id, signature: edSign(null, Buffer.from(exportSigningMessage(h)), privateKey).toString('base64') }),
  };
  return { signer, signing_key_id, public_key: pub };
}

export interface BaseChain {
  db_id: string;
  /** Per-segment ordered CCE objects: [[c0,c1],[c2]]. */
  segObjects: Cce[][];
  manifests: SegmentManifest[];
  anchorRecords: VerifierAnchorRecord[];
  trustedKeys: TrustedSigningKeyDirectory;
  trustedCerts: TrustedAnchorCertDirectory;
  hsmKey: { key_id: string; algorithm: string; public_key: string };
  tsaCert: { tsa_cert_ref: string; algorithm: string; public_key: string };
  /** Out-of-band trust file (CLI path). */
  trustFile: { signing_keys: unknown[]; anchor_certs: unknown[]; export_keys: unknown[] };
  /** The export package (CLI path). */
  exportPackage: ReturnType<typeof buildEvidenceExportPackage>;
  /** Sidecar objects keyed by worm_object_key (CLI path). */
  sidecar: { key: string; cce: Cce }[];
}

/** Build the canonical anchored chain via the real impls. `offsetOverlap` makes seg1 reuse seg0's last offset key (WV-10). */
export async function buildBaseChain(opts: { offsetOverlap?: boolean } = {}): Promise<BaseChain> {
  const signer = new DevEd25519Signer();
  const provider = new DevRfc3161Provider();
  const hsmPub = signer.getPublicKey(signer.keyId)!;
  const tsaCert = provider.getCertificate();

  const seg0Id = 'seg-000000';
  const seg1Id = 'seg-000001';
  const c0 = buildCce(tx(0));
  const c1 = buildCce(tx(1), { prevRowHash: c0.evidence.row_hash });
  // WV-10: force c2 to reuse c1's consumed_offset_key so adjacent segments overlap.
  const c2 = buildCce(tx(2, opts.offsetOverlap ? `${UUID}:1` : undefined), { prevRowHash: c1.evidence.row_hash });

  const seg0 = manifestFor(0, seg0Id, [c0, c1], null);
  const seg1 = manifestFor(1, seg1Id, [c2], { segment_id: seg0.segment_id, segment_sequence: 0, segment_hash: deriveSegmentHead(seg0).segment_hash });

  const anchorRecordFor = async (manifest: SegmentManifest): Promise<VerifierAnchorRecord> => {
    const head = deriveSegmentHead(manifest);
    const payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
    const hsmSignature = await signer.sign(payload);
    const outcome = await requestAnchor(provider, anchorRequestFor(payload));
    if (!isAnchored(outcome)) throw new Error(`fixture anchoring failed: ${JSON.stringify(outcome)}`);
    const record = buildAnchorRecord({ head: payload, hsmSignature, anchorOutcome: outcome, anchorId: UUID, createdAt: '2026-06-01T10:05:03.000Z' });
    // Round-trip through JSON (as WORM/export carry it) and type as the verifier's AnchorRecord.
    return JSON.parse(JSON.stringify(record)) as VerifierAnchorRecord;
  };

  const ar0 = await anchorRecordFor(seg0);
  const ar1 = await anchorRecordFor(seg1);

  const trustedKeys = new InMemorySigningKeyDirectory([{ key_id: hsmPub.signing_key_id, algorithm: hsmPub.algorithm, public_key: hsmPub.public_key, revoked_at: hsmPub.revoked_at ?? null }]);
  const trustedCerts = new InMemoryAnchorCertDirectory([{ ref: tsaCert.tsa_cert_ref, algorithm: tsaCert.algorithm, public_key: tsaCert.public_key }]);

  // Export package (real T145 builder) + out-of-band trust file + sidecar bundle.
  const { signer: exportSigner, signing_key_id: exportKeyId, public_key: exportPub } = devExportSigner();
  const segIn = (m: SegmentManifest, ar: VerifierAnchorRecord, objs: Cce[]): ExportSegmentInput => ({
    segment_sequence: m.segment_sequence,
    object_ids: objs.map((c) => c.envelope_id),
    serialized_manifest: JSON.stringify(m),
    serialized_anchor_record: JSON.stringify(ar),
  });
  const ref = (c: Cce, segId: string, seq: number): ExportObjectRef => ({ object_id: c.envelope_id, object_type: 'cce', worm_object_key: wormKey(segId, seq), event_hash: c.evidence.event_hash });
  const exportInput: BuildExportInput = {
    package_id: '11111111-2222-4333-8444-555555555555', db_id: DB, purpose: 'legal_audit',
    created_at: '2026-06-01T12:00:00.000Z', created_by: 'edam-export',
    selected_object_refs: [ref(c2, seg1Id, 0)],
    segments: [segIn(seg0, ar0, [c0, c1]), segIn(seg1, ar1, [c2])],
    public_keys: [{ key_id: hsmPub.signing_key_id, algorithm: hsmPub.algorithm, public_key: hsmPub.public_key, revoked_at: null }],
    timestamp_certificates: [JSON.stringify(tsaCert)],
    verification_instructions: { spec_id: 'worm-v1', spec_hash: 'sha256:' + 'a'.repeat(64) },
    chain_of_custody_log: [{ custody_event_id: 'ce-1', action: 'export', reviewer_identity: 'auditor', reason: 'case-123', occurred_at: '2026-06-01T12:00:00.000Z' }],
    signer: exportSigner,
  };
  const exportPackage = buildEvidenceExportPackage(exportInput);

  const trustFile = {
    signing_keys: [{ key_id: hsmPub.signing_key_id, algorithm: hsmPub.algorithm, public_key: hsmPub.public_key, revoked_at: null }],
    anchor_certs: [{ ref: tsaCert.tsa_cert_ref, algorithm: tsaCert.algorithm, public_key: tsaCert.public_key }],
    export_keys: [{ key_id: exportKeyId, algorithm: 'ed25519', public_key: exportPub }],
  };
  const sidecar = [
    { key: wormKey(seg0Id, 0), cce: c0 },
    { key: wormKey(seg0Id, 1), cce: c1 },
    { key: wormKey(seg1Id, 0), cce: c2 },
  ];

  return {
    db_id: DB, segObjects: [[c0, c1], [c2]], manifests: [seg0, seg1], anchorRecords: [ar0, ar1],
    trustedKeys, trustedCerts,
    hsmKey: { key_id: hsmPub.signing_key_id, algorithm: hsmPub.algorithm, public_key: hsmPub.public_key },
    tsaCert: { tsa_cert_ref: tsaCert.tsa_cert_ref, algorithm: tsaCert.algorithm, public_key: tsaCert.public_key },
    trustFile, exportPackage, sidecar,
  };
}

/** Assemble VerifierSegment[] from (possibly mutated) manifests/objects/anchor records. */
export function toSegments(manifests: SegmentManifest[], segObjects: Cce[][], anchorRecords: (VerifierAnchorRecord | undefined)[]): VerifierSegment[] {
  return manifests.map((manifest, i) => ({
    manifest,
    objects: segObjects[i] ?? [],
    ...(anchorRecords[i] !== undefined ? { anchorRecord: anchorRecords[i] } : {}),
  }));
}

/** Deep clone helper (structuredClone over plain JSON-able fixtures). */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Recompute a manifest_hash over the canonical core (WV-1 helper). */
export function recomputeManifestHash(manifest: SegmentManifest): string {
  const { manifest_hash: _omit, ...core } = manifest;
  return computeManifestHash(core as SegmentManifestCore);
}

export { GENESIS_PREVIOUS_SEGMENT_HASH };
