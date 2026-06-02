// Dev Ed25519 signer (Sprint-2 / EDAM-T121).
//
// A development/test signer that holds an Ed25519 private key in-process and
// signs ONLY typed anchor payloads (never arbitrary bytes — closes E2C-SIGN-H1).
// It canonicalizes + domain-separates internally (closes E2C-SIGN-M1) and
// validates the payload before signing (E2C-SIGN-M2). The private key is never
// surfaced: only signatures and the PUBLIC key are exposed. Ed25519 (RFC 8032)
// is deterministic, so signatures are byte-for-byte reproducible.
//
// This is NOT the production custody path: T122 (HSM/PKCS#11) supersedes it for
// live validation. No PKCS#11, no anchoring, no WORM, no CCE here.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import type { AnchorPayload, PublicKey, SignatureResult, Signer } from './types.js';
import { anchorSigningMessage, assertValidAnchorPayload } from './anchor-payload.js';

const ED25519 = 'ed25519' as const;

/** A published key registration: the PUBLIC half plus its lifecycle metadata. */
export interface KeyRegistration {
  algorithm: 'ed25519';
  signing_key_id: string;
  /** SPKI DER, base64. PUBLIC ONLY. */
  public_key: string;
  /** RFC3339 instant the key was created. */
  created_at: string;
  /** RFC3339 instant the key was revoked, or null if active. */
  revoked_at: string | null;
}

export interface DevEd25519SignerOptions {
  /** Existing Ed25519 private key (PEM/PKCS#8). If omitted, a fresh key is generated. */
  privateKeyPem?: string;
  /** Key creation instant (RFC3339). Defaults to the unix epoch for determinism in tests. */
  createdAt?: string;
  /** Key revocation instant (RFC3339), or null/undefined if active. */
  revokedAt?: string | null;
}

function spkiDerBase64(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** Derive a stable, content-addressed key id from the SPKI public key. */
function deriveKeyId(spkiB64: string): string {
  const digest = createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex');
  return `edam-dev-ed25519-${digest.slice(0, 16)}`;
}

/**
 * Dev Ed25519 signer. Signs typed anchor payloads only; canonicalizes + domain-
 * separates + validates internally; never exposes private material.
 */
export class DevEd25519Signer implements Signer {
  readonly #privateKey: KeyObject;
  readonly #publicKeyB64: string;
  readonly #signingKeyId: string;
  readonly #createdAt: string;
  readonly #revokedAt: string | null;

  constructor(opts: DevEd25519SignerOptions = {}) {
    if (opts.privateKeyPem !== undefined) {
      this.#privateKey = createPrivateKey({ key: opts.privateKeyPem, format: 'pem' });
      if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error(`DevEd25519Signer: expected an ed25519 private key (got ${String(this.#privateKey.asymmetricKeyType)})`);
      }
    } else {
      const { privateKey } = generateKeyPairSync('ed25519');
      this.#privateKey = privateKey;
    }
    const publicKey = createPublicKey(this.#privateKey);
    this.#publicKeyB64 = spkiDerBase64(publicKey);
    this.#signingKeyId = deriveKeyId(this.#publicKeyB64);
    this.#createdAt = opts.createdAt ?? '1970-01-01T00:00:00.000Z';
    this.#revokedAt = opts.revokedAt ?? null;
  }

  /** The id of the key this signer signs with. */
  get keyId(): string {
    return this.#signingKeyId;
  }

  /** Sign an anchor payload. Validates + canonicalizes + domain-separates internally. */
  async sign(payload: AnchorPayload): Promise<SignatureResult> {
    assertValidAnchorPayload(payload);
    const message = Buffer.from(anchorSigningMessage(payload));
    const signature = edSign(null, message, this.#privateKey);
    return {
      algorithm: ED25519,
      signing_key_id: this.#signingKeyId,
      signature: signature.toString('base64'),
    };
  }

  /** Return the PUBLIC key for a signing_key_id (no private material), or undefined. */
  getPublicKey(signingKeyId: string): PublicKey | undefined {
    if (signingKeyId !== this.#signingKeyId) return undefined;
    return {
      algorithm: ED25519,
      signing_key_id: this.#signingKeyId,
      public_key: this.#publicKeyB64,
      revoked_at: this.#revokedAt,
    };
  }

  /** The published key registration (public half + lifecycle). No private material. */
  keyRegistration(): KeyRegistration {
    return {
      algorithm: ED25519,
      signing_key_id: this.#signingKeyId,
      public_key: this.#publicKeyB64,
      created_at: this.#createdAt,
      revoked_at: this.#revokedAt,
    };
  }
}

/**
 * Verify an anchor signature offline using only the PUBLIC key (INV-EV-4). Returns
 * false (never throws) on any failure. Enforces algorithm binding (E2C-SIGN-M3):
 * the public key must exist, its signing_key_id must match the signature's, both
 * must be ed25519, and a key revoked at-or-before signed_at is rejected.
 */
export function verifyAnchorSignature(
  payload: AnchorPayload,
  signature: SignatureResult,
  publicKey: PublicKey | undefined,
): boolean {
  try {
    if (publicKey === undefined) return false;
    if (signature.signing_key_id !== publicKey.signing_key_id) return false;
    if (signature.algorithm !== publicKey.algorithm) return false;
    if (publicKey.algorithm !== ED25519) return false;
    // Honor revocation: a key revoked at-or-before the signing instant is invalid.
    if (publicKey.revoked_at != null) {
      const revoked = Date.parse(publicKey.revoked_at);
      const signedAt = Date.parse(payload.signed_at);
      if (Number.isFinite(revoked) && Number.isFinite(signedAt) && signedAt >= revoked) return false;
    }
    assertValidAnchorPayload(payload);
    const key = createPublicKey({ key: Buffer.from(publicKey.public_key, 'base64'), format: 'der', type: 'spki' });
    const message = Buffer.from(anchorSigningMessage(payload));
    return edVerify(null, message, key, Buffer.from(signature.signature, 'base64'));
  } catch {
    return false;
  }
}
