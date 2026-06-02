// Signing layer types (Sprint-2 / EDAM-T120).
//
// The Signer interface deliberately exposes NO private key material: it can
// produce a signature and return the PUBLIC key for a key id, nothing more.
// Concrete signers (dev Ed25519 = T121, HSM/PKCS#11 = T122) hold the private key
// in-process / in-HSM and never surface it. The algorithm enum matches the
// vendored anchor-record-1.0 hsm_signature.algorithm enum (WORM §16.2).

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
 * The cryptographic tip of a sealed segment (WORM §7.5), structurally compatible
 * with the evidence-writer's SegmentHead. Defined locally so @edam/signing
 * depends only on @edam/canonical (isolation).
 */
export interface ChainHead {
  db_id: string;
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
  last_row_hash: string;
}

/** The anchor payload the signer signs (WORM §8): a hash structure, never plaintext. */
export interface AnchorPayload {
  db_id: string;
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
  last_row_hash: string;
  head_count: number;
  signed_at: string;
}

/**
 * Signs hash structures (anchor payloads), never CCE/plaintext. A concrete signer
 * holds its key privately; this interface yields only signatures + public keys.
 */
export interface Signer {
  /** Sign the canonical anchor-payload bytes. Returns the signature + algorithm + key id. */
  sign(payload: Uint8Array): Promise<SignatureResult>;
  /** Return the PUBLIC key for a signing_key_id (no private material), or undefined if unknown. */
  getPublicKey(signingKeyId: string): PublicKey | undefined;
}
