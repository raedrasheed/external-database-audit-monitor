// Signing layer tests (Sprint-2 / EDAM-T120): canonical anchor payload +
// Signer interface contract (no private material).
import { describe, it, expect } from 'vitest';
import {
  buildAnchorPayload,
  serializeAnchorPayload,
  anchorPayloadBytes,
  anchorPayloadHash,
  type ChainHead,
  type Signer,
  type SignatureResult,
  type PublicKey,
} from '../src/index.js';
import { serializeCanonical } from '@edam/canonical';

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

describe('anchor payload (T120)', () => {
  it('builds the payload from a chain head + head_count + signed_at (exactly the §8 fields)', () => {
    const p = buildAnchorPayload(head, OPTS);
    expect(Object.keys(p).sort()).toEqual([
      'db_id', 'head_count', 'last_row_hash', 'segment_hash', 'segment_id', 'segment_sequence', 'signed_at',
    ]);
    expect(p).toEqual({
      db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0,
      segment_hash: HASH_A, last_row_hash: HASH_B, head_count: 1, signed_at: OPTS.signedAt,
    });
  });

  it('is a hash structure only — no CCE/plaintext fields', () => {
    const p = buildAnchorPayload(head, OPTS) as unknown as Record<string, unknown>;
    for (const forbidden of ['before', 'after', 'changes', 'field_changes', 'objects', 'object_list']) {
      expect(forbidden in p).toBe(false);
    }
  });

  it('rejects a non-hash-token segment_hash / last_row_hash (no plaintext smuggling)', () => {
    expect(() => buildAnchorPayload({ ...head, segment_hash: 'not-a-hash' }, OPTS)).toThrow();
    expect(() => buildAnchorPayload({ ...head, last_row_hash: 'nope' }, OPTS)).toThrow();
  });

  it('rejects an invalid head_count', () => {
    expect(() => buildAnchorPayload(head, { headCount: 0, signedAt: OPTS.signedAt })).toThrow();
    expect(() => buildAnchorPayload(head, { headCount: 1.5, signedAt: OPTS.signedAt })).toThrow();
  });

  it('serialization is canonical (key-order independent) and reproducible byte-for-byte', () => {
    const a = serializeAnchorPayload(buildAnchorPayload(head, OPTS));
    const b = serializeAnchorPayload(buildAnchorPayload(head, OPTS));
    expect(a).toBe(b);
    // canonical: equals serializeCanonical of a key-shuffled equivalent object
    const shuffled = serializeCanonical({
      signed_at: OPTS.signedAt, head_count: 1, last_row_hash: HASH_B, segment_hash: HASH_A,
      segment_sequence: 0, segment_id: 'seg-000000', db_id: 'kafel-dev-mysql',
    });
    expect(a).toBe(shuffled);
  });

  it('bytes + hash are deterministic; content change changes the hash', () => {
    const p = buildAnchorPayload(head, OPTS);
    expect(anchorPayloadBytes(p)).toEqual(anchorPayloadBytes(p));
    expect(anchorPayloadHash(p)).toBe(anchorPayloadHash(p));
    expect(anchorPayloadHash(p)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const p2 = buildAnchorPayload({ ...head, segment_sequence: 1 }, OPTS);
    expect(anchorPayloadHash(p2)).not.toBe(anchorPayloadHash(p));
  });
});

describe('Signer interface contract (T120)', () => {
  // A minimal in-test stub: proves the interface is implementable and exposes
  // NO private material (sign yields a signature; getPublicKey yields only public).
  class StubSigner implements Signer {
    async sign(payload: Uint8Array): Promise<SignatureResult> {
      return { algorithm: 'ed25519', signing_key_id: 'k1', signature: Buffer.from(payload).toString('base64').slice(0, 16) };
    }
    getPublicKey(signingKeyId: string): PublicKey | undefined {
      return signingKeyId === 'k1' ? { algorithm: 'ed25519', signing_key_id: 'k1', public_key: 'PUB', revoked_at: null } : undefined;
    }
  }

  it('sign returns {algorithm, signing_key_id, signature} and nothing private', async () => {
    const s = new StubSigner();
    const res = await s.sign(anchorPayloadBytes(buildAnchorPayload(head, OPTS)));
    expect(Object.keys(res).sort()).toEqual(['algorithm', 'signature', 'signing_key_id']);
    for (const forbidden of ['private_key', 'privateKey', 'secret', 'key', 'pem']) {
      expect(forbidden in (res as unknown as Record<string, unknown>)).toBe(false);
    }
  });

  it('getPublicKey returns only public material (no private fields); undefined for unknown ids', () => {
    const s = new StubSigner();
    const pk = s.getPublicKey('k1')!;
    expect(Object.keys(pk).sort()).toEqual(['algorithm', 'public_key', 'revoked_at', 'signing_key_id']);
    for (const forbidden of ['private_key', 'privateKey', 'secret', 'd']) {
      expect(forbidden in (pk as unknown as Record<string, unknown>)).toBe(false);
    }
    expect(s.getPublicKey('unknown')).toBeUndefined();
  });
});
