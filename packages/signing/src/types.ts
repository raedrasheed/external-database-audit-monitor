// Signing layer types (Sprint-2 / EDAM-T120).
//
// The Signer interface deliberately exposes NO private key material: it can
// produce a signature and return the PUBLIC key for a key id, nothing more.
// Concrete signers (dev Ed25519 = T121, HSM/PKCS#11 = T122) hold the private key
// in-process / in-HSM and never surface it. The algorithm enum matches the
// vendored anchor-record-1.0 hsm_signature.algorithm enum (WORM §16.2).

import type { AnchorPayload } from '@edam/evidence';

// ChainHead + AnchorPayload moved to @edam/evidence (EDAM-T110: the determinism
// keystone shared with the independent verifier). Re-exported here so the
// @edam/signing public API is unchanged for existing consumers.
export type { ChainHead, AnchorPayload } from '@edam/evidence';

export type SignAlgorithm = 'ecdsa-p384' | 'ed25519' | 'rsa-pss-3072' | 'ecdsa-p256';

/** The result of signing: algorithm + key id + the signature (base64). No private material. */
export interface SignatureResult {
  algorithm: SignAlgorithm;
  signing_key_id: string;
  /** Base64 signature over the canonical anchor-payload bytes. */
  signature: string;
}

/** A published PUBLIC key. Verifiers use this offline; it carries no private material. */
export interface PublicKey {
  algorithm: SignAlgorithm;
  signing_key_id: string;
  /** Public key material (e.g. SPKI/base64 or PEM). NOT private. */
  public_key: string;
  /** Set when the key is revoked; anchors signed before this remain valid. */
  revoked_at?: string | null;
}

/**
 * Signs anchor payloads (hash structures), never CCE/plaintext. `sign` takes a
 * typed AnchorPayload (NOT arbitrary bytes) — the signer canonicalizes + domain-
 * separates internally, so it cannot be used as a generic signing oracle
 * (E2C-SIGN-H1/M1). A concrete signer holds its key privately; this interface
 * yields only signatures + public keys.
 */
export interface Signer {
  /** Sign an anchor payload. The signer canonicalizes + domain-separates internally. */
  sign(payload: AnchorPayload): Promise<SignatureResult>;
  /** Return the PUBLIC key for a signing_key_id (no private material), or undefined if unknown. */
  getPublicKey(signingKeyId: string): PublicKey | undefined;
}
