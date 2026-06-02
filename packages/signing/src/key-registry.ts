// Key registry with rotation + revocation (Sprint-2 / EDAM-T123).
//
// A crypto-free, immutable registry of PUBLIC key registrations supporting the
// key lifecycle: active-key lookup, rotation, revocation, and public-key history
// for offline verification of historical signatures (WORM §8, §19.9; A-EV4).
//
// Custody (INV-EV-4): the registry holds ONLY public material — never a private
// key. It is the published source of truth a verifier consults to resolve the
// public key (and its `revoked_at`) for any signature's signing_key_id, INCLUDING
// rotated-away and revoked keys, so signatures created before revocation remain
// verifiable forever (rotation/revocation never invalidate prior anchors).
//
// `revoked_at` semantics (verifier-consumable): a signature is valid only if
// created_at <= signed_at < revoked_at; a key revoked at-or-before signed_at is
// rejected. Actual signature cryptography stays in `verifyAnchorSignature` — this
// module implements NO verifier and NO anchoring; it only resolves keys + status.
//
// Dual-control is a STUB: rotation/revocation enforce a two-person rule
// (requester != approver) as a dev approximation. Real dual-control + a
// WORM-logged custody record is a Domain-C operational control, deferred.

import type { PublicKey, SignAlgorithm } from './types.js';
import type { PublicKeyRegistry } from './pkcs11-signer.js';

/** Runtime witness for the SignAlgorithm union (anchor-record-1.0 enum). */
const SIGN_ALGORITHMS: readonly SignAlgorithm[] = ['ecdsa-p384', 'ed25519', 'rsa-pss-3072', 'ecdsa-p256'];

/** A published key registration — PUBLIC material only (WORM §8 / plan key-registration record). */
export interface KeyRecord {
  signing_key_id: string;
  algorithm: SignAlgorithm;
  /** Public key material (e.g. SPKI/base64). NOT private. */
  public_key: string;
  /** RFC3339 instant the key became usable. */
  created_at: string;
  /** RFC3339 instant the key was revoked, or null if active. */
  revoked_at: string | null;
}

/** Lifecycle status of a key AT a given instant. */
export type KeyStatus = 'unknown' | 'not-yet-valid' | 'active' | 'revoked';

/** A two-person-rule approval (dual-control STUB — real custody control deferred). */
export interface DualControlApproval {
  requestedBy: string;
  approvedBy: string;
}

/** Rotation/revocation interface (returns a NEW registry; the registry is immutable). */
export interface KeyLifecycleAdmin {
  rotate(newKey: KeyRecord, approval: DualControlApproval): KeyRotationRegistry;
  revoke(signingKeyId: string, approval: DualControlApproval, revokedAt: string): KeyRotationRegistry;
}

export class UnknownKeyError extends Error {
  constructor(signingKeyId: string) {
    super(`key registry: unknown signing_key_id ${JSON.stringify(signingKeyId)}`);
    this.name = 'UnknownKeyError';
  }
}
export class RevokedKeyError extends Error {
  constructor(signingKeyId: string, signedAt: string) {
    super(`key registry: key ${JSON.stringify(signingKeyId)} is revoked at-or-before ${JSON.stringify(signedAt)}`);
    this.name = 'RevokedKeyError';
  }
}
export class KeyNotYetValidError extends Error {
  constructor(signingKeyId: string, signedAt: string) {
    super(`key registry: key ${JSON.stringify(signingKeyId)} is not yet valid at ${JSON.stringify(signedAt)}`);
    this.name = 'KeyNotYetValidError';
  }
}
export class KeyAlgorithmMismatchError extends Error {
  constructor(signingKeyId: string, expected: SignAlgorithm, actual: SignAlgorithm) {
    super(`key registry: algorithm mismatch for ${JSON.stringify(signingKeyId)} (expected ${expected}, key is ${actual})`);
    this.name = 'KeyAlgorithmMismatchError';
  }
}
export class KeyAlreadyExistsError extends Error {
  constructor(signingKeyId: string) {
    super(`key registry: signing_key_id ${JSON.stringify(signingKeyId)} already exists`);
    this.name = 'KeyAlreadyExistsError';
  }
}
export class CannotRevokeActiveKeyError extends Error {
  constructor(signingKeyId: string) {
    super(`key registry: cannot revoke the active key ${JSON.stringify(signingKeyId)}; rotate to a new active key first`);
    this.name = 'CannotRevokeActiveKeyError';
  }
}
export class DualControlError extends Error {
  constructor(message: string) {
    super(`key registry: dual-control violation: ${message}`);
    this.name = 'DualControlError';
  }
}
export class InvalidKeyRecordError extends Error {
  constructor(message: string) {
    super(`key registry: invalid key record: ${message}`);
    this.name = 'InvalidKeyRecordError';
  }
}

function isRealInstant(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && Number.isFinite(Date.parse(s));
}

/** Validate + freeze a public key record. Throws InvalidKeyRecordError on any violation. */
function validateRecord(r: KeyRecord): Readonly<KeyRecord> {
  if (typeof r.signing_key_id !== 'string' || r.signing_key_id.length === 0) throw new InvalidKeyRecordError('signing_key_id must be a non-empty string');
  if (!SIGN_ALGORITHMS.includes(r.algorithm)) throw new InvalidKeyRecordError(`algorithm must be one of ${SIGN_ALGORITHMS.join(', ')} (got ${String(r.algorithm)})`);
  if (typeof r.public_key !== 'string' || r.public_key.length === 0) throw new InvalidKeyRecordError('public_key must be a non-empty string');
  if (!isRealInstant(r.created_at)) throw new InvalidKeyRecordError(`created_at must be a real RFC3339 instant (got ${JSON.stringify(r.created_at)})`);
  if (r.revoked_at !== null) {
    if (!isRealInstant(r.revoked_at)) throw new InvalidKeyRecordError(`revoked_at must be null or a real RFC3339 instant (got ${JSON.stringify(r.revoked_at)})`);
    if (Date.parse(r.revoked_at) < Date.parse(r.created_at)) throw new InvalidKeyRecordError('revoked_at must not precede created_at');
  }
  return Object.freeze({
    signing_key_id: r.signing_key_id,
    algorithm: r.algorithm,
    public_key: r.public_key,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
  });
}

function assertDualControl(a: DualControlApproval): void {
  if (typeof a?.requestedBy !== 'string' || a.requestedBy.length === 0) throw new DualControlError('requestedBy is required');
  if (typeof a?.approvedBy !== 'string' || a.approvedBy.length === 0) throw new DualControlError('approvedBy is required');
  if (a.requestedBy === a.approvedBy) throw new DualControlError('requester and approver must be different principals (two-person rule)');
}

/**
 * Immutable public-key registry with rotation + revocation. Implements
 * PublicKeyRegistry (drop-in for Pkcs11Signer / verifier) and KeyLifecycleAdmin.
 */
export class KeyRotationRegistry implements PublicKeyRegistry, KeyLifecycleAdmin {
  readonly #keys: ReadonlyMap<string, Readonly<KeyRecord>>;
  readonly #activeKeyId: string;

  constructor(records: readonly KeyRecord[], activeKeyId: string) {
    if (records.length === 0) throw new InvalidKeyRecordError('registry requires at least one key record');
    const map = new Map<string, Readonly<KeyRecord>>();
    for (const r of records) {
      const frozen = validateRecord(r);
      if (map.has(frozen.signing_key_id)) throw new KeyAlreadyExistsError(frozen.signing_key_id);
      map.set(frozen.signing_key_id, frozen);
    }
    const active = map.get(activeKeyId);
    if (active === undefined) throw new UnknownKeyError(activeKeyId);
    if (active.revoked_at !== null) throw new InvalidKeyRecordError(`active key ${JSON.stringify(activeKeyId)} must not be revoked`);
    this.#keys = map;
    this.#activeKeyId = activeKeyId;
  }

  /** The id of the current active (signing) key. */
  get activeKeyId(): string {
    return this.#activeKeyId;
  }

  /** The current active key record (public material). */
  getActiveKey(): Readonly<KeyRecord> {
    // The active key is guaranteed present by construction.
    return this.#keys.get(this.#activeKeyId)!;
  }

  /** Look up any key record by id — including rotated-away and revoked keys (history). */
  getKey(signingKeyId: string): Readonly<KeyRecord> | undefined {
    return this.#keys.get(signingKeyId);
  }

  /** PublicKeyRegistry: resolve the published PUBLIC key (incl. historical/revoked), or undefined. */
  getPublicKey(signingKeyId: string): PublicKey | undefined {
    const r = this.#keys.get(signingKeyId);
    if (r === undefined) return undefined;
    return { algorithm: r.algorithm, signing_key_id: r.signing_key_id, public_key: r.public_key, revoked_at: r.revoked_at };
  }

  /** Full public-key history (all registered keys, in insertion order). */
  history(): readonly Readonly<KeyRecord>[] {
    return Object.freeze([...this.#keys.values()]);
  }

  /** Lifecycle status of a key AT an instant (fail-closed: unknown id / unparseable instant ⇒ 'unknown'). */
  statusAt(signingKeyId: string, instant: string): KeyStatus {
    const r = this.#keys.get(signingKeyId);
    if (r === undefined) return 'unknown';
    const t = Date.parse(instant);
    if (!Number.isFinite(t)) return 'unknown';
    if (t < Date.parse(r.created_at)) return 'not-yet-valid';
    if (r.revoked_at !== null && t >= Date.parse(r.revoked_at)) return 'revoked';
    return 'active';
  }

  /**
   * Whether a key may have validly produced a signature at `signedAt`: the key
   * exists, the algorithm matches (if supplied), and created_at <= signedAt <
   * revoked_at. Verifier-consumable; pairs with verifyAnchorSignature's crypto.
   */
  isValidAt(signingKeyId: string, signedAt: string, expectedAlgorithm?: SignAlgorithm): boolean {
    const r = this.#keys.get(signingKeyId);
    if (r === undefined) return false;
    if (expectedAlgorithm !== undefined && r.algorithm !== expectedAlgorithm) return false;
    return this.statusAt(signingKeyId, signedAt) === 'active';
  }

  /**
   * Sign-time fail-closed check for the ACTIVE key (E2C-SIGN-L10): throws if the
   * active key's algorithm does not match, if it is not yet valid, or if it is
   * revoked at-or-before `signedAt`. Returns the active key record on success.
   * Lets the anchoring stage refuse to sign with a revoked key WITHOUT changing
   * the Signer interface.
   */
  assertSignableActiveKey(signedAt: string, expectedAlgorithm?: SignAlgorithm): Readonly<KeyRecord> {
    const active = this.getActiveKey();
    if (expectedAlgorithm !== undefined && active.algorithm !== expectedAlgorithm) {
      throw new KeyAlgorithmMismatchError(active.signing_key_id, expectedAlgorithm, active.algorithm);
    }
    const status = this.statusAt(active.signing_key_id, signedAt);
    if (status === 'not-yet-valid') throw new KeyNotYetValidError(active.signing_key_id, signedAt);
    // 'revoked' or 'unknown' (e.g. unparseable signedAt) ⇒ fail closed: deny signing.
    if (status !== 'active') throw new RevokedKeyError(active.signing_key_id, signedAt);
    return active;
  }

  /**
   * Rotate to a NEW active key (dual-control). Returns a new registry; the
   * previous key is retained, NOT revoked, so prior anchors remain valid.
   */
  rotate(newKey: KeyRecord, approval: DualControlApproval): KeyRotationRegistry {
    assertDualControl(approval);
    const frozen = validateRecord(newKey);
    if (this.#keys.has(frozen.signing_key_id)) throw new KeyAlreadyExistsError(frozen.signing_key_id);
    if (frozen.revoked_at !== null) throw new InvalidKeyRecordError('a newly rotated-in active key must not be revoked');
    return new KeyRotationRegistry([...this.#keys.values(), frozen], frozen.signing_key_id);
  }

  /**
   * Revoke a key as of `revokedAt` (dual-control). Returns a new registry. The
   * active key cannot be revoked (rotate first). Revocation never removes the key
   * from history and never invalidates signatures made strictly before revokedAt.
   */
  revoke(signingKeyId: string, approval: DualControlApproval, revokedAt: string): KeyRotationRegistry {
    assertDualControl(approval);
    const r = this.#keys.get(signingKeyId);
    if (r === undefined) throw new UnknownKeyError(signingKeyId);
    if (signingKeyId === this.#activeKeyId) throw new CannotRevokeActiveKeyError(signingKeyId);
    if (r.revoked_at !== null) throw new InvalidKeyRecordError(`key ${JSON.stringify(signingKeyId)} is already revoked`);
    if (!isRealInstant(revokedAt)) throw new InvalidKeyRecordError(`revokedAt must be a real RFC3339 instant (got ${JSON.stringify(revokedAt)})`);
    if (Date.parse(revokedAt) < Date.parse(r.created_at)) throw new InvalidKeyRecordError('revokedAt must not precede the key created_at');
    const next = [...this.#keys.values()].map((k) => (k.signing_key_id === signingKeyId ? { ...k, revoked_at: revokedAt } : { ...k }));
    return new KeyRotationRegistry(next, this.#activeKeyId);
  }
}
