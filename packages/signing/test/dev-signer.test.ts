// Dev Ed25519 signer tests (Sprint-2 / EDAM-T121): typed-payload-only signing
// (H1 closed), domain separation (M1), payload validation (M2), algorithm
// binding + revocation (M3), offline verification, determinism, no private leak.
import { describe, it, expect } from 'vitest';
import {
  DevEd25519Signer,
  verifyAnchorSignature,
  buildAnchorPayload,
  anchorSigningMessage,
  serializeAnchorPayload,
  ANCHOR_PAYLOAD_DOMAIN,
  type AnchorPayload,
  type ChainHead,
} from '../src/index.js';
import { createPublicKey, generateKeyPairSync, verify as edVerify } from 'node:crypto';

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);
const head: ChainHead = {
  db_id: 'kafel-dev-mysql',
  segment_id: 'seg-000000',
  segment_sequence: 0,
  segment_hash: HASH_A,
  last_row_hash: HASH_B,
};
const OPTS = { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' };
const payload = (): AnchorPayload => buildAnchorPayload(head, OPTS);

describe('DevEd25519Signer (T121)', () => {
  it('produces a signature that verifies offline with only the published public key', async () => {
    const signer = new DevEd25519Signer();
    const p = payload();
    const sig = await signer.sign(p);
    expect(sig.algorithm).toBe('ed25519');
    expect(sig.signing_key_id).toBe(signer.keyId);
    const pub = signer.getPublicKey(signer.keyId);
    expect(verifyAnchorSignature(p, sig, pub)).toBe(true);
  });

  it('signs deterministically (Ed25519 RFC 8032) — identical payload yields identical signature', async () => {
    const signer = new DevEd25519Signer();
    const a = await signer.sign(payload());
    const b = await signer.sign(payload());
    expect(a.signature).toBe(b.signature);
  });

  it('binds to the canonical, domain-separated message (M1) — verifiable with raw crypto', async () => {
    const signer = new DevEd25519Signer();
    const p = payload();
    const sig = await signer.sign(p);
    const reg = signer.keyRegistration();
    const key = createPublicKey({ key: Buffer.from(reg.public_key, 'base64'), format: 'der', type: 'spki' });
    const message = Buffer.from(anchorSigningMessage(p));
    // The exact bytes are the domain tag + canonical serialization.
    expect(message.toString()).toBe(`${ANCHOR_PAYLOAD_DOMAIN}:${serializeAnchorPayload(p)}`);
    expect(edVerify(null, message, key, Buffer.from(sig.signature, 'base64'))).toBe(true);
    // A signature over the un-prefixed canonical bytes must NOT verify (domain matters).
    const undomained = Buffer.from(serializeAnchorPayload(p));
    expect(edVerify(null, undomained, key, Buffer.from(sig.signature, 'base64'))).toBe(false);
  });

  it('rejects a tampered payload (segment_hash) at verification', async () => {
    const signer = new DevEd25519Signer();
    const p = payload();
    const sig = await signer.sign(p);
    const tampered: AnchorPayload = { ...p, segment_hash: 'sha256:' + 'c'.repeat(64) };
    expect(verifyAnchorSignature(tampered, sig, signer.getPublicKey(signer.keyId))).toBe(false);
  });

  it('rejects a signature verified against the wrong key', async () => {
    const a = new DevEd25519Signer();
    const b = new DevEd25519Signer();
    const p = payload();
    const sig = await a.sign(p);
    expect(verifyAnchorSignature(p, sig, b.getPublicKey(b.keyId))).toBe(false);
  });

  it('rejects an unknown / undefined public key (M3)', async () => {
    const signer = new DevEd25519Signer();
    const sig = await signer.sign(payload());
    expect(signer.getPublicKey('nope')).toBeUndefined();
    expect(verifyAnchorSignature(payload(), sig, undefined)).toBe(false);
  });

  it('rejects a signing_key_id / algorithm mismatch (M3)', async () => {
    const signer = new DevEd25519Signer();
    const p = payload();
    const sig = await signer.sign(p);
    const pub = signer.getPublicKey(signer.keyId)!;
    // key-id mismatch
    expect(verifyAnchorSignature(p, { ...sig, signing_key_id: 'other' }, pub)).toBe(false);
    // algorithm mismatch (signature claims a different algorithm than the key)
    expect(verifyAnchorSignature(p, { ...sig, algorithm: 'ecdsa-p384' }, pub)).toBe(false);
    expect(verifyAnchorSignature(p, sig, { ...pub, algorithm: 'ecdsa-p384' })).toBe(false);
  });

  it('honors revocation (M3): a key revoked at-or-before signed_at is invalid', async () => {
    const p = payload();
    // signed_at is 2026-06-01T10:05:01Z; revoke at-or-before that instant.
    const revoked = new DevEd25519Signer({ revokedAt: '2026-06-01T10:05:01.000Z' });
    const sig = await revoked.sign(p);
    expect(verifyAnchorSignature(p, sig, revoked.getPublicKey(revoked.keyId))).toBe(false);
    // A key revoked strictly AFTER signed_at still validates the earlier signature.
    const revokedLater = new DevEd25519Signer({ revokedAt: '2026-06-02T00:00:00.000Z' });
    const sig2 = await revokedLater.sign(p);
    expect(verifyAnchorSignature(p, sig2, revokedLater.getPublicKey(revokedLater.keyId))).toBe(true);
  });

  it('H1 closed: sign accepts only a valid typed payload — malformed payloads are rejected, never signed', async () => {
    const signer = new DevEd25519Signer();
    // Not a hash structure / smuggled plaintext -> rejected before any signing.
    await expect(signer.sign({ ...payload(), segment_hash: 'not-a-hash' })).rejects.toThrow();
    await expect(signer.sign({ ...payload(), db_id: '' })).rejects.toThrow();
    await expect(signer.sign({ ...payload(), segment_sequence: -1 })).rejects.toThrow();
    await expect(signer.sign({ ...payload(), head_count: 0 })).rejects.toThrow();
    await expect(signer.sign({ ...payload(), signed_at: 'yesterday' })).rejects.toThrow();
  });

  it('exposes no private material (no PEM/private fields anywhere in the public surface)', () => {
    const signer = new DevEd25519Signer();
    expect(JSON.stringify(signer)).toBe('{}');
    const reg = signer.keyRegistration();
    expect(Object.keys(reg).sort()).toEqual(['algorithm', 'created_at', 'public_key', 'revoked_at', 'signing_key_id']);
    for (const forbidden of ['private_key', 'privateKey', 'secret', 'd', 'pem']) {
      expect(forbidden in (reg as unknown as Record<string, unknown>)).toBe(false);
    }
    const pub = signer.getPublicKey(signer.keyId)!;
    expect(pub.public_key).not.toContain('PRIVATE');
  });

  it('accepts an externally supplied Ed25519 PEM and rejects a non-Ed25519 key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => new DevEd25519Signer({ privateKeyPem: pem })).not.toThrow();
    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => new DevEd25519Signer({ privateKeyPem: rsaPem })).toThrow();
  });

  it('derives a stable content-addressed key id from the public key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const a = new DevEd25519Signer({ privateKeyPem: pem });
    const b = new DevEd25519Signer({ privateKeyPem: pem });
    expect(a.keyId).toBe(b.keyId);
    expect(a.keyId).toMatch(/^edam-dev-ed25519-[0-9a-f]{16}$/);
  });
});
