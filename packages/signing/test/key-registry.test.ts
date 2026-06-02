// Key registry rotation/revocation tests (Sprint-2 / EDAM-T123): active lookup,
// rotation, revocation, public-key history, verifier-consumable revoked_at,
// fail-closed paths, dual-control stub, and end-to-end historical verification.
import { describe, it, expect } from 'vitest';
import {
  KeyRotationRegistry,
  UnknownKeyError,
  RevokedKeyError,
  KeyNotYetValidError,
  KeyAlgorithmMismatchError,
  KeyAlreadyExistsError,
  CannotRevokeActiveKeyError,
  DualControlError,
  InvalidKeyRecordError,
  DevEd25519Signer,
  verifyAnchorSignature,
  buildAnchorPayload,
  type KeyRecord,
  type DualControlApproval,
  type ChainHead,
} from '../src/index.js';

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);
const head: ChainHead = {
  db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0,
  segment_hash: HASH_A, last_row_hash: HASH_B,
};
const APPROVAL: DualControlApproval = { requestedBy: 'custodian-a', approvedBy: 'custodian-b' };

function rec(id: string, createdAt: string, revokedAt: string | null = null): KeyRecord {
  return { signing_key_id: id, algorithm: 'ed25519', public_key: 'PUB-' + id, created_at: createdAt, revoked_at: revokedAt };
}

describe('KeyRotationRegistry (T123)', () => {
  it('active key lookup + public-key resolution', () => {
    const reg = new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'k1');
    expect(reg.activeKeyId).toBe('k1');
    expect(reg.getActiveKey().signing_key_id).toBe('k1');
    expect(reg.getPublicKey('k1')).toEqual({ algorithm: 'ed25519', signing_key_id: 'k1', public_key: 'PUB-k1', revoked_at: null });
    expect(reg.getPublicKey('nope')).toBeUndefined();
  });

  it('rejects construction with no keys, duplicate ids, a revoked active key, or an unknown active id', () => {
    expect(() => new KeyRotationRegistry([], 'k1')).toThrow(InvalidKeyRecordError);
    expect(() => new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z'), rec('k1', '2026-01-02T00:00:00Z')], 'k1')).toThrow(KeyAlreadyExistsError);
    expect(() => new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')], 'k1')).toThrow(InvalidKeyRecordError);
    expect(() => new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'kX')).toThrow(UnknownKeyError);
  });

  it('rejects invalid key records (bad algorithm / instants / revoked precedes created)', () => {
    expect(() => new KeyRotationRegistry([{ ...rec('k1', '2026-01-01T00:00:00Z'), algorithm: 'rc4' as never }], 'k1')).toThrow(InvalidKeyRecordError);
    expect(() => new KeyRotationRegistry([rec('k1', 'not-a-date')], 'k1')).toThrow(InvalidKeyRecordError);
    expect(() => new KeyRotationRegistry([rec('k1', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z')], 'k1')).toThrow(InvalidKeyRecordError);
  });

  it('rotation moves the active pointer, keeps prior keys (history), and does NOT revoke them', () => {
    const reg = new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'k1');
    const rotated = reg.rotate(rec('k2', '2026-03-01T00:00:00Z'), APPROVAL);
    expect(rotated.activeKeyId).toBe('k2');
    expect(rotated.history().map((k) => k.signing_key_id)).toEqual(['k1', 'k2']);
    // k1 retained and still NOT revoked after rotation (prior anchors stay valid).
    expect(rotated.getKey('k1')!.revoked_at).toBeNull();
    // Original registry is unchanged (immutability).
    expect(reg.activeKeyId).toBe('k1');
    expect(reg.getKey('k2')).toBeUndefined();
  });

  it('rotation rejects duplicate id and a pre-revoked incoming key', () => {
    const reg = new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'k1');
    expect(() => reg.rotate(rec('k1', '2026-03-01T00:00:00Z'), APPROVAL)).toThrow(KeyAlreadyExistsError);
    expect(() => reg.rotate(rec('k2', '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'), APPROVAL)).toThrow(InvalidKeyRecordError);
  });

  it('revocation sets revoked_at, preserves history, and is immutable; cannot revoke the active key', () => {
    const reg = new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'k1').rotate(rec('k2', '2026-03-01T00:00:00Z'), APPROVAL);
    const revoked = reg.revoke('k1', APPROVAL, '2026-04-01T00:00:00Z');
    expect(revoked.getKey('k1')!.revoked_at).toBe('2026-04-01T00:00:00Z');
    expect(revoked.getPublicKey('k1')!.revoked_at).toBe('2026-04-01T00:00:00Z'); // still resolvable for verification
    expect(reg.getKey('k1')!.revoked_at).toBeNull(); // original unchanged
    expect(() => reg.revoke('k2', APPROVAL, '2026-05-01T00:00:00Z')).toThrow(CannotRevokeActiveKeyError);
    expect(() => reg.revoke('unknown', APPROVAL, '2026-05-01T00:00:00Z')).toThrow(UnknownKeyError);
    expect(() => revoked.revoke('k1', APPROVAL, '2026-06-01T00:00:00Z')).toThrow(InvalidKeyRecordError); // already revoked
  });

  it('enforces the dual-control two-person rule on rotate and revoke (stub)', () => {
    const reg = new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'k1');
    const same = { requestedBy: 'x', approvedBy: 'x' };
    expect(() => reg.rotate(rec('k2', '2026-03-01T00:00:00Z'), same)).toThrow(DualControlError);
    const rotated = reg.rotate(rec('k2', '2026-03-01T00:00:00Z'), APPROVAL);
    expect(() => rotated.revoke('k1', same, '2026-04-01T00:00:00Z')).toThrow(DualControlError);
    expect(() => reg.rotate(rec('k2', '2026-03-01T00:00:00Z'), { requestedBy: '', approvedBy: 'b' })).toThrow(DualControlError);
  });

  it('statusAt / isValidAt compute the validity window [created_at, revoked_at) fail-closed', () => {
    const reg = new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'k1').rotate(rec('k2', '2026-03-01T00:00:00Z'), APPROVAL).revoke('k1', APPROVAL, '2026-04-01T00:00:00Z');
    expect(reg.statusAt('k1', '2025-12-31T00:00:00Z')).toBe('not-yet-valid');
    expect(reg.statusAt('k1', '2026-02-01T00:00:00Z')).toBe('active');
    expect(reg.statusAt('k1', '2026-04-01T00:00:00Z')).toBe('revoked'); // at-or-before boundary is revoked
    expect(reg.statusAt('k1', '2026-05-01T00:00:00Z')).toBe('revoked');
    expect(reg.statusAt('unknown', '2026-02-01T00:00:00Z')).toBe('unknown');
    expect(reg.statusAt('k1', 'garbage')).toBe('unknown'); // fail closed on bad instant
    expect(reg.isValidAt('k1', '2026-02-01T00:00:00Z')).toBe(true);
    expect(reg.isValidAt('k1', '2026-04-01T00:00:00Z')).toBe(false);
    expect(reg.isValidAt('k1', '2026-02-01T00:00:00Z', 'ecdsa-p384')).toBe(false); // algorithm mismatch
    expect(reg.isValidAt('unknown', '2026-02-01T00:00:00Z')).toBe(false);
  });

  it('assertSignableActiveKey fails closed on revoked / not-yet-valid / algorithm mismatch (sign-time, L10)', () => {
    const reg = new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'k1');
    expect(reg.assertSignableActiveKey('2026-02-01T00:00:00Z').signing_key_id).toBe('k1');
    expect(() => reg.assertSignableActiveKey('2025-01-01T00:00:00Z')).toThrow(KeyNotYetValidError);
    expect(() => reg.assertSignableActiveKey('2026-02-01T00:00:00Z', 'ecdsa-p384')).toThrow(KeyAlgorithmMismatchError);
    expect(() => reg.assertSignableActiveKey('garbage')).toThrow(RevokedKeyError); // unparseable ⇒ deny
  });

  it('exposes only public material (no private fields in records / public keys)', () => {
    const reg = new KeyRotationRegistry([rec('k1', '2026-01-01T00:00:00Z')], 'k1');
    for (const obj of [reg.getKey('k1')!, reg.getPublicKey('k1')!]) {
      for (const forbidden of ['private_key', 'privateKey', 'secret', 'd', 'pem']) {
        expect(forbidden in (obj as unknown as Record<string, unknown>)).toBe(false);
      }
    }
  });
});

describe('historical verification via the registry (T123 AC: rotation never invalidates prior anchors)', () => {
  it('a signature made before revocation still verifies with the registry public key; at/after revocation it fails', async () => {
    // Two real dev keys with explicit creation instants.
    const signerOld = new DevEd25519Signer({ createdAt: '2026-01-01T00:00:00.000Z' });
    const signerNew = new DevEd25519Signer({ createdAt: '2026-03-01T00:00:00.000Z' });
    const k1 = signerOld.keyRegistration();
    const k2 = signerNew.keyRegistration();

    // Registry: k1 active, then rotate to k2, then revoke k1 as of 2026-04-01.
    const reg = new KeyRotationRegistry([k1], k1.signing_key_id)
      .rotate(k2, APPROVAL)
      .revoke(k1.signing_key_id, APPROVAL, '2026-04-01T00:00:00.000Z');

    // Signed BEFORE revocation -> still verifies via the historical public key.
    const before = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-02-01T00:00:00.000Z' });
    const sigBefore = await signerOld.sign(before);
    expect(verifyAnchorSignature(before, sigBefore, reg.getPublicKey(k1.signing_key_id))).toBe(true);

    // Signed AT/AFTER revocation -> rejected by the verifier (revoked_at honored).
    const after = buildAnchorPayload({ ...head, segment_sequence: 9 }, { headCount: 1, signedAt: '2026-05-01T00:00:00.000Z' });
    const sigAfter = await signerOld.sign(after);
    expect(verifyAnchorSignature(after, sigAfter, reg.getPublicKey(k1.signing_key_id))).toBe(false);

    // The new active key verifies normally.
    const fresh = buildAnchorPayload({ ...head, segment_sequence: 1 }, { headCount: 2, signedAt: '2026-03-15T00:00:00.000Z' });
    const sigNew = await signerNew.sign(fresh);
    expect(verifyAnchorSignature(fresh, sigNew, reg.getPublicKey(k2.signing_key_id))).toBe(true);
  });
});
