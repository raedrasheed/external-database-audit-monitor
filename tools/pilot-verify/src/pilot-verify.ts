// EDAM pilot offline-verification tooling (B6 + B7). Enables validation-plan step 5:
// export pilot WORM evidence -> build a trust file from the (FIXED dev) keys -> run the
// verifier-CLI -> PASS; tampered evidence -> FAIL.
//
// PILOT BOUNDARY: dev signer + dev RFC-3161 (DEV-anchored, R-01). No HSM/TSA/mTLS/
// dual-control/production crypto. Keys are operator-supplied PEMs (gitignored) or
// generated for tests; trust publishes PUBLIC material only.
import { createPrivateKey, createPublicKey, generateKeyPairSync, createHash, sign as edSign, type KeyObject } from 'node:crypto';
import { DevEd25519Signer } from '@edam/signing';
import { DevRfc3161Provider } from '@edam/anchoring';
import { exportSigningMessage, buildEvidenceExportPackage, type BuildExportInput, type ExportSegmentInput, type ExportObjectRef, type ExportSigner } from '@edam/export';
import type { TrustFile } from '@edam/verifier-cli';
import type { WormReader } from '@edam/worm';

const spki = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');

/** A node:crypto Ed25519 export signer (signs the domain-tagged export message). */
export interface ExportKey { signer: ExportSigner; key_id: string; public_key: string }
export function exportSignerFromPem(pem?: string): ExportKey {
  const priv = pem ? createPrivateKey(pem) : generateKeyPairSync('ed25519').privateKey;
  const pub = spki(createPublicKey(priv));
  const key_id = 'edam-pilot-export-ed25519-' + createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
  const signer: ExportSigner = {
    signExport(packageHash) {
      return { algorithm: 'ed25519', signing_key_id: key_id, signature: edSign(null, Buffer.from(exportSigningMessage(packageHash)), priv).toString('base64') };
    },
  };
  return { signer, key_id, public_key: pub };
}

/** The fixed dev key set used by BOTH the evidence-writer (sign/anchor) and the exporter. */
export interface PilotKeys { signer: DevEd25519Signer; tsa: DevRfc3161Provider; exportKey: ExportKey }
export function loadPilotKeys(opts: { signingPem?: string; tsaPem?: string; exportPem?: string } = {}): PilotKeys {
  return {
    signer: new DevEd25519Signer(opts.signingPem ? { privateKeyPem: opts.signingPem } : {}),
    tsa: new DevRfc3161Provider(opts.tsaPem ? { privateKeyPem: opts.tsaPem } : {}),
    exportKey: exportSignerFromPem(opts.exportPem),
  };
}

/** Generate a fresh dev PEM key set (for `pilot:keys` — operator runs once; PEMs gitignored). */
export function generatePilotPems(): { signingPem: string; tsaPem: string; exportPem: string } {
  const pem = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  return { signingPem: pem(), tsaPem: pem(), exportPem: pem() };
}

/** Build the PUBLIC trust file matching the pilot keys (signing_keys + anchor_certs + export_keys). */
export function buildPilotTrust(keys: PilotKeys): TrustFile {
  const reg = keys.signer.keyRegistration();
  const cert = keys.tsa.getCertificate();
  return {
    signing_keys: [{ key_id: reg.signing_key_id, algorithm: reg.algorithm, public_key: reg.public_key, revoked_at: reg.revoked_at ?? null }],
    anchor_certs: [{ ref: cert.tsa_cert_ref, algorithm: cert.algorithm, public_key: cert.public_key }],
    export_keys: [{ key_id: keys.exportKey.key_id, algorithm: 'ed25519', public_key: keys.exportKey.public_key }],
  };
}

interface ManifestLike {
  segment_sequence: number;
  object_list: Array<{ seq: number; object_id: string; worm_object_key: string; object_type: 'cce' }>;
  object_hash_list: Array<{ seq: number; event_hash: string; row_hash: string }>;
}

export interface ExportedEvidence {
  pkg: ReturnType<typeof buildEvidenceExportPackage>;
  /** The CCE object bytes keyed by worm_object_key (written to the verifier's objectsDir). */
  objects: Array<{ key: string; bytes: Uint8Array }>;
}

/**
 * Assemble an evidence export package from WORM evidence (manifests + anchor records +
 * CCE objects under `dbId/`). Reads via the injected WormReader (Minio or InMemory).
 */
export async function exportFromWorm(reader: WormReader, dbId: string, exportKey: ExportKey, keys: PilotKeys): Promise<ExportedEvidence> {
  const keysUnder = await reader.list(`${dbId}/`);
  const segIds = [...new Set(keysUnder.filter((k) => k.endsWith('/manifest.json')).map((k) => k.split('/')[1]!))];
  if (segIds.length === 0) throw new Error(`no segments (manifest.json) under ${dbId}/`);

  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const segments: ExportSegmentInput[] = [];
  const objects: Array<{ key: string; bytes: Uint8Array }> = [];
  const refsBySeq = new Map<number, ExportObjectRef>();

  for (const segId of segIds) {
    const manifestKey = `${dbId}/${segId}/manifest.json`;
    const anchorKey = `${dbId}/${segId}/anchor.json`;
    const serialized_manifest = dec(await reader.get(manifestKey));
    const serialized_anchor_record = dec(await reader.get(anchorKey));
    const m = JSON.parse(serialized_manifest) as ManifestLike;
    const object_ids = m.object_list.map((o) => o.object_id);
    segments.push({ segment_sequence: m.segment_sequence, object_ids, serialized_manifest, serialized_anchor_record });
    for (const o of m.object_list) {
      objects.push({ key: o.worm_object_key, bytes: await reader.get(o.worm_object_key) });
      const eh = m.object_hash_list.find((h) => h.seq === o.seq)?.event_hash ?? '';
      refsBySeq.set(m.segment_sequence, { object_id: o.object_id, object_type: 'cce', worm_object_key: o.worm_object_key, event_hash: eh });
    }
  }

  // Select an object in the highest segment (roots continuity over segments 0..max).
  const maxSeq = Math.max(...segments.map((s) => s.segment_sequence));
  const selected = refsBySeq.get(maxSeq)!;

  const input: BuildExportInput = {
    package_id: '11111111-2222-4333-8444-555555555555',
    db_id: dbId,
    purpose: 'legal_audit',
    created_at: '2026-06-04T12:00:00.000Z',
    created_by: 'edam-pilot-export',
    selected_object_refs: [selected],
    segments: segments.sort((a, b) => a.segment_sequence - b.segment_sequence),
    public_keys: [{ key_id: keys.signer.keyId, algorithm: 'ed25519', public_key: keys.signer.keyRegistration().public_key, revoked_at: null }],
    timestamp_certificates: [JSON.stringify(keys.tsa.getCertificate())],
    verification_instructions: { spec_id: 'worm-v1', spec_hash: 'sha256:' + 'a'.repeat(64) },
    chain_of_custody_log: [{ custody_event_id: 'ce-1', action: 'export', reviewer_identity: 'pilot', reason: 'pilot-validation', occurred_at: '2026-06-04T12:00:00.000Z' }],
    signer: exportKey.signer,
  };
  return { pkg: buildEvidenceExportPackage(input), objects };
}
