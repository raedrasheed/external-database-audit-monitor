// Trust-file generator (EDAM-P2-TRUST-GENERATOR).
//
// Projects the PUBLIC key history of the evidence-signing and export-signing
// KeyRotationRegistry instances into the verifier's out-of-band trust file
// (signing_keys + export_keys), passing through the P2-TSA-owned anchor_certs
// (placeholder until P2-TSA lands). PUBLIC MATERIAL ONLY (INV-EV-4) — the registry
// holds no private key, so neither does the trust file.
//
// Trust planes: evidence (signing_keys) + export (export_keys) + TSA (anchor_certs).
// The mTLS transport CA is structurally EXCLUDED: there is no transport array in the
// trust file and no input channel for a CA here; additionally, certificate material
// is refused in the evidence/export key planes (mTLS-exclusion guard).
//
// Both validity bounds are exposed for the verifier: `not_before` (from
// KeyRecord.created_at) + `revoked_at`, so the verifier can enforce
// created_at <= signed_at < revoked_at. History is NEVER pruned (rotated/revoked
// keys are retained) so a verifier holding the latest trust file verifies evidence
// signed by older keys.

import { serializeCanonical, eventHash } from '@edam/canonical';
import { KeyRotationRegistry } from './key-registry.js';

/** A published signing/export key entry (PUBLIC ONLY) — structurally a verifier TrustedSigningKey. */
export interface TrustFileSigningKey {
  key_id: string;
  algorithm: string;
  public_key: string;
  /** Lower validity bound (= KeyRecord.created_at). */
  not_before: string;
  /** Upper validity bound, or null if active. */
  revoked_at: string | null;
}

/** A published anchor-authority cert (TSA / transparency-log) — owned by P2-TSA. */
export interface TrustFileAnchorCert {
  ref: string;
  algorithm: string;
  public_key: string;
  revoked_at?: string | null;
}

/** Generator metadata (header; ignored by loadTrustRoots, consumed by audit). */
export interface TrustFileMeta {
  trust_version: number;
  generated_at: string;
  ceremony_id?: string;
}

/** The generated out-of-band trust file. */
export interface GeneratedTrustFile {
  trust_version: number;
  generated_at: string;
  ceremony_id?: string;
  /** The currently-active signing/export key ids (audit aid; not authoritative for verification). */
  active_signing_key_id: string;
  active_export_key_id: string;
  signing_keys: TrustFileSigningKey[];
  export_keys: TrustFileSigningKey[];
  anchor_certs: TrustFileAnchorCert[];
}

export interface BuildTrustFileInput {
  /** Evidence-signing registry → signing_keys. */
  evidence: KeyRotationRegistry;
  /** Export-signing registry → export_keys. */
  export: KeyRotationRegistry;
  /** P2-TSA anchor certs; default [] (explicit placeholder — never fabricated). */
  anchorCerts?: readonly TrustFileAnchorCert[];
  meta: TrustFileMeta;
}

/** Raised on any generation-policy violation (fail-closed). */
export class TrustFileGenerationError extends Error {
  constructor(message: string) {
    super(`trust-file generator: ${message}`);
    this.name = 'TrustFileGenerationError';
  }
}

/** PEM certificate material is refused in the evidence/export key planes (mTLS-exclusion). */
function assertNotCertificate(plane: string, keyId: string, material: string): void {
  if (/-----BEGIN[A-Z ]*CERTIFICATE-----/.test(material)) {
    throw new TrustFileGenerationError(
      `${plane} key ${JSON.stringify(keyId)} carries X.509 CERTIFICATE material; evidence trust requires a RAW public key (mTLS-CA / certificate material is excluded)`,
    );
  }
}

/** Project a registry's PUBLIC history into trust key entries (sorted by key_id; full history, never pruned). */
function projectKeys(reg: KeyRotationRegistry, plane: 'signing_keys' | 'export_keys'): TrustFileSigningKey[] {
  const out = reg.history().map((r) => {
    assertNotCertificate(plane, r.signing_key_id, r.public_key);
    return {
      key_id: r.signing_key_id,
      algorithm: r.algorithm,
      public_key: r.public_key,
      not_before: r.created_at,
      revoked_at: r.revoked_at,
    };
  });
  return [...out].sort((a, b) => a.key_id.localeCompare(b.key_id));
}

/**
 * Build the out-of-band trust file from the evidence + export registries. Pure,
 * deterministic (sorted, canonical). Returns the trust object and its content hash
 * (`eventHash(serializeCanonical(trust))`). Fail-closed on policy violations.
 */
export function buildTrustFile(input: BuildTrustFileInput): { trust: GeneratedTrustFile; hash: string } {
  if (!Number.isInteger(input.meta.trust_version) || input.meta.trust_version < 1) {
    throw new TrustFileGenerationError(`meta.trust_version must be a positive integer (got ${String(input.meta.trust_version)})`);
  }
  if (typeof input.meta.generated_at !== 'string' || !Number.isFinite(Date.parse(input.meta.generated_at))) {
    throw new TrustFileGenerationError('meta.generated_at must be a real RFC3339 instant');
  }

  const signing_keys = projectKeys(input.evidence, 'signing_keys');
  const export_keys = projectKeys(input.export, 'export_keys');

  // Cross-plane collision: a key_id must not appear in BOTH evidence and export planes.
  const signingIds = new Set(signing_keys.map((k) => k.key_id));
  for (const k of export_keys) {
    if (signingIds.has(k.key_id)) {
      throw new TrustFileGenerationError(`key_id ${JSON.stringify(k.key_id)} appears in both signing_keys and export_keys (cross-plane collision)`);
    }
  }

  const anchor_certs = [...(input.anchorCerts ?? [])]
    .map((c) => {
      if (typeof c.ref !== 'string' || c.ref.length === 0 || typeof c.algorithm !== 'string' || typeof c.public_key !== 'string' || c.public_key.length === 0) {
        throw new TrustFileGenerationError(`malformed anchor_cert ${JSON.stringify(c.ref)} (need {ref,algorithm,public_key})`);
      }
      return { ref: c.ref, algorithm: c.algorithm, public_key: c.public_key, ...(c.revoked_at !== undefined ? { revoked_at: c.revoked_at } : {}) };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref));

  // Fail-closed: a trust file that grants nothing cannot support verification (mirrors loadTrustRoots).
  if (signing_keys.length === 0 && export_keys.length === 0 && anchor_certs.length === 0) {
    throw new TrustFileGenerationError('refusing to emit an empty trust file (no signing_keys / export_keys / anchor_certs)');
  }

  const trust: GeneratedTrustFile = {
    trust_version: input.meta.trust_version,
    generated_at: input.meta.generated_at,
    ...(input.meta.ceremony_id !== undefined ? { ceremony_id: input.meta.ceremony_id } : {}),
    active_signing_key_id: input.evidence.activeKeyId,
    active_export_key_id: input.export.activeKeyId,
    signing_keys,
    export_keys,
    anchor_certs,
  };

  const hash = eventHash(serializeCanonical(trust));
  return { trust, hash };
}
