// HSM / PKCS#11 adapter tests (Sprint-2 / EDAM-T122): same AnchorPayload-only
// contract, fail-closed behavior, no private material, domain separation, and a
// verifiable signature via a fake in-process provider standing in for the HSM.
import { describe, it, expect } from 'vitest';
import {
  Pkcs11Signer,
  InMemoryKeyRegistry,
  Pkcs11NotConfiguredError,
  UnknownSigningKeyError,
  AlgorithmMismatchError,
  createSigner,
  verifyAnchorSignature,
  buildAnchorPayload,
  anchorSigningMessage,
  serializeAnchorPayload,
  ANCHOR_PAYLOAD_DOMAIN,
  type Pkcs11Provider,
  type PublicKey,
  type AnchorPayload,
  type ChainHead,
  type Signer,
} from '../src/index.js';
import {
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

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

// HSM-style opaque key id (NOT the dev content-addressed prefix), so the
// verifier's dev-only key-id recompute is correctly skipped for HSM keys.
const HSM_KEY_ID = 'edam-hsm-ed25519-slot0-key1';

/**
 * A fake HSM provider: holds an Ed25519 private key in-process (as a real HSM
 * would hold it non-exportably) and signs the bytes the adapter passes. It
 * exposes ONLY a signature + the SPKI public key — never private material.
 */
class FakePkcs11Provider implements Pkcs11Provider {
  readonly algorithm = 'ed25519' as const;
  readonly #privateKey: KeyObject;
  readonly #keyId: string;
  readonly publicKeySpkiB64: string;

  constructor(keyId: string) {
    const { privateKey } = generateKeyPairSync('ed25519');
    this.#privateKey = privateKey;
    this.#keyId = keyId;
    this.publicKeySpkiB64 = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  }

  hasKey(signingKeyId: string): boolean {
    return signingKeyId === this.#keyId;
  }

  async sign(signingKeyId: string, message: Uint8Array): Promise<Uint8Array> {
    if (signingKeyId !== this.#keyId) throw new Error('fake hsm: unknown key');
    return edSign(null, Buffer.from(message), this.#privateKey);
  }
}

function publishedKey(provider: FakePkcs11Provider, keyId: string, revokedAt: string | null = null): PublicKey {
  return { algorithm: 'ed25519', signing_key_id: keyId, public_key: provider.publicKeySpkiB64, revoked_at: revokedAt };
}

function configured(): { signer: Pkcs11Signer; provider: FakePkcs11Provider } {
  const provider = new FakePkcs11Provider(HSM_KEY_ID);
  const registry = new InMemoryKeyRegistry([publishedKey(provider, HSM_KEY_ID)]);
  return { signer: new Pkcs11Signer({ provider, signingKeyId: HSM_KEY_ID, registry }), provider };
}

describe('Pkcs11Signer (T122)', () => {
  it('signs an anchor payload via the fake provider and the signature verifies offline with the published key', async () => {
    const { signer } = configured();
    const p = payload();
    const sig = await signer.sign(p);
    expect(sig.algorithm).toBe('ed25519');
    expect(sig.signing_key_id).toBe(HSM_KEY_ID);
    expect(verifyAnchorSignature(p, sig, signer.getPublicKey(HSM_KEY_ID))).toBe(true);
  });

  it('preserves domain separation — signs the domain-tagged message, not the raw canonical bytes', async () => {
    const { signer } = configured();
    const p = payload();
    const sig = await signer.sign(p);
    const pub = signer.getPublicKey(HSM_KEY_ID)!;
    const key = createPublicKey({ key: Buffer.from(pub.public_key, 'base64'), format: 'der', type: 'spki' });
    const message = Buffer.from(anchorSigningMessage(p));
    expect(message.toString()).toBe(`${ANCHOR_PAYLOAD_DOMAIN}:${serializeAnchorPayload(p)}`);
    expect(edVerify(null, message, key, Buffer.from(sig.signature, 'base64'))).toBe(true);
    // Same signature must NOT verify over the un-domained canonical bytes.
    const undomained = Buffer.from(serializeAnchorPayload(p));
    expect(edVerify(null, undomained, key, Buffer.from(sig.signature, 'base64'))).toBe(false);
  });

  it('fails closed when not configured (no HSM provider)', async () => {
    const registry = new InMemoryKeyRegistry();
    const signer = new Pkcs11Signer({ signingKeyId: HSM_KEY_ID, registry });
    expect(signer.configured).toBe(false);
    await expect(signer.sign(payload())).rejects.toBeInstanceOf(Pkcs11NotConfiguredError);
  });

  it('fails closed for an unknown / unpublished signing key', async () => {
    const provider = new FakePkcs11Provider(HSM_KEY_ID);
    // Provider has the key but it is NOT published in the registry.
    const signerUnpublished = new Pkcs11Signer({ provider, signingKeyId: HSM_KEY_ID, registry: new InMemoryKeyRegistry() });
    await expect(signerUnpublished.sign(payload())).rejects.toBeInstanceOf(UnknownSigningKeyError);
    // Provider does NOT hold the configured key (published but absent in HSM).
    const registry = new InMemoryKeyRegistry([publishedKey(provider, 'edam-hsm-ed25519-other')]);
    const signerAbsent = new Pkcs11Signer({ provider, signingKeyId: 'edam-hsm-ed25519-other', registry });
    await expect(signerAbsent.sign(payload())).rejects.toBeInstanceOf(UnknownSigningKeyError);
  });

  it('fails closed on algorithm mismatch (provider mechanism != published key algorithm)', async () => {
    const provider = new FakePkcs11Provider(HSM_KEY_ID); // ed25519 mechanism
    // Published key claims a different algorithm than the provider mechanism.
    const registry = new InMemoryKeyRegistry([
      { algorithm: 'ecdsa-p384', signing_key_id: HSM_KEY_ID, public_key: provider.publicKeySpkiB64, revoked_at: null },
    ]);
    const signer = new Pkcs11Signer({ provider, signingKeyId: HSM_KEY_ID, registry });
    await expect(signer.sign(payload())).rejects.toBeInstanceOf(AlgorithmMismatchError);
  });

  it('fails closed on payload validation (no arbitrary bytes / no smuggled fields)', async () => {
    const { signer } = configured();
    await expect(signer.sign({ ...payload(), segment_hash: 'not-a-hash' })).rejects.toThrow();
    await expect(signer.sign({ ...payload(), db_id: '' })).rejects.toThrow();
    await expect(signer.sign({ ...payload(), signed_at: '2026-13-45T99:99:99Z' })).rejects.toThrow();
    // M4: extra fields cannot ride into the signed bytes via the HSM adapter either.
    await expect(signer.sign({ ...payload(), leaked: 'secret' } as unknown as AnchorPayload)).rejects.toThrow();
  });

  it('exposes only public material (getPublicKey is public-only; signer serializes to nothing private)', async () => {
    const { signer } = configured();
    expect(JSON.stringify(signer)).toBe('{}');
    const pub = signer.getPublicKey(HSM_KEY_ID)!;
    expect(Object.keys(pub).sort()).toEqual(['algorithm', 'public_key', 'revoked_at', 'signing_key_id']);
    for (const forbidden of ['private_key', 'privateKey', 'secret', 'd', 'pem']) {
      expect(forbidden in (pub as unknown as Record<string, unknown>)).toBe(false);
    }
    expect(pub.public_key).not.toContain('PRIVATE');
    expect(signer.getPublicKey('unknown')).toBeUndefined();
    const sig = await signer.sign(payload());
    expect(Object.keys(sig).sort()).toEqual(['algorithm', 'signature', 'signing_key_id']);
  });

  it('honors revocation through the shared verifier (key revoked at-or-before signed_at)', async () => {
    const provider = new FakePkcs11Provider(HSM_KEY_ID);
    const registry = new InMemoryKeyRegistry([publishedKey(provider, HSM_KEY_ID, '2026-06-01T10:05:01.000Z')]);
    const signer = new Pkcs11Signer({ provider, signingKeyId: HSM_KEY_ID, registry });
    const p = payload();
    const sig = await signer.sign(p);
    expect(verifyAnchorSignature(p, sig, signer.getPublicKey(HSM_KEY_ID))).toBe(false);
  });
});

describe('createSigner factory (T122) — swapping signer requires no caller change', () => {
  // A caller that depends ONLY on the Signer interface.
  async function callerSignsAndVerifies(signer: Signer): Promise<boolean> {
    const p = payload();
    const sig = await signer.sign(p);
    return verifyAnchorSignature(p, sig, signer.getPublicKey(sig.signing_key_id));
  }

  it('produces a working dev signer', async () => {
    const signer = createSigner({ kind: 'dev' });
    expect(await callerSignsAndVerifies(signer)).toBe(true);
  });

  it('produces a working HSM/pkcs11 signer with no change to the caller', async () => {
    const provider = new FakePkcs11Provider(HSM_KEY_ID);
    const registry = new InMemoryKeyRegistry([publishedKey(provider, HSM_KEY_ID)]);
    const signer = createSigner({ kind: 'pkcs11', config: { provider, signingKeyId: HSM_KEY_ID, registry } });
    expect(await callerSignsAndVerifies(signer)).toBe(true);
  });

  it('produces an unconfigured HSM signer that fails closed', async () => {
    const signer = createSigner({ kind: 'pkcs11', config: { signingKeyId: HSM_KEY_ID, registry: new InMemoryKeyRegistry() } });
    await expect(signer.sign(payload())).rejects.toBeInstanceOf(Pkcs11NotConfiguredError);
  });
});
