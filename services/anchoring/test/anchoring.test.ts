// AnchorProvider abstraction tests (Sprint-2 / EDAM-T130): hash-only input,
// frozen enum, pluggability, fail-closed failure modes, no fabrication, and
// ANCHORED only after a verified token.
import { describe, it, expect } from 'vitest';
import {
  ANCHOR_PROVIDER_TYPES,
  anchorRequestFor,
  requestAnchor,
  isAnchored,
  isWellFormedToken,
  AnchorProviderRegistry,
  FakeAnchorProvider,
  type AnchorOutcome,
  type AnchorProvider,
  type AnchorProviderType,
  type AnchorRequest,
  type AnchorToken,
} from '../src/index.js';
import { buildAnchorPayload, anchorPayloadHash, type ChainHead } from '@edam/signing';
import { isHashToken } from '@edam/canonical';

const head: ChainHead = {
  db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0,
  segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64),
};
const payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
const request = anchorRequestFor(payload);

describe('AnchorProvider abstraction (T130)', () => {
  it('exposes the frozen provider enum and nothing else', () => {
    expect(ANCHOR_PROVIDER_TYPES).toEqual(['rfc3161', 'transparency_log', 'dual_custodian']);
  });

  it('reduces a signed payload to a HASH-ONLY request (provider sees no plaintext)', () => {
    expect(Object.keys(request)).toEqual(['payload_hash']);
    expect(isHashToken(request.payload_hash)).toBe(true);
    expect(request.payload_hash).toBe(anchorPayloadHash(payload));
    // None of the payload's structured fields are present in the request.
    const blob = JSON.stringify(request);
    for (const leak of [head.db_id, head.segment_id, head.segment_hash, head.last_row_hash]) {
      expect(blob.includes(leak)).toBe(false);
    }
  });

  it('anchors and verifies for every frozen provider type; token is AnchorRecord-compatible', async () => {
    for (const type of ANCHOR_PROVIDER_TYPES) {
      const provider = new FakeAnchorProvider(type, { mode: 'anchored' });
      const outcome = await requestAnchor(provider, request);
      expect(isAnchored(outcome)).toBe(true);
      if (!isAnchored(outcome)) throw new Error('unreachable');
      const token = outcome.token;
      expect(token.provider_type).toBe(type);
      expect(token.payload_hash).toBe(request.payload_hash);
      expect(token.anchor_provider.type).toBe(type);
      expect(isWellFormedToken(token)).toBe(true);
      expect(provider.verifyToken(token, request)).toBe(true);
    }
  });

  it('shape of each provider proof matches anchor-record-1.0 anchor_provider', async () => {
    const rfc = await requestAnchor(new FakeAnchorProvider('rfc3161'), request);
    const tl = await requestAnchor(new FakeAnchorProvider('transparency_log'), request);
    const dc = await requestAnchor(new FakeAnchorProvider('dual_custodian'), request);
    if (!isAnchored(rfc) || !isAnchored(tl) || !isAnchored(dc)) throw new Error('expected anchored');
    expect(rfc.token.anchor_provider).toMatchObject({ type: 'rfc3161', rfc3161_token: expect.any(String), tsa_cert_ref: expect.any(String) });
    expect(tl.token.anchor_provider).toMatchObject({ type: 'transparency_log', transparency_log: { log_id: expect.any(String), leaf_index: 0 } });
    expect(dc.token.anchor_provider).toMatchObject({ type: 'dual_custodian', dual_custodian: { custodian_id: expect.any(String), timestamp: expect.any(String) } });
  });

  // ---- fail-closed failure modes (no fabrication) ----

  it('fails closed (PENDING, no token) on outage', async () => {
    const outcome = await requestAnchor(new FakeAnchorProvider('rfc3161', { mode: 'outage' }), request);
    expect(outcome).toEqual({ status: 'pending', reason: 'provider_outage' });
    expect('token' in outcome).toBe(false);
  });

  it('fails closed (PENDING, no token) on timeout', async () => {
    const outcome = await requestAnchor(new FakeAnchorProvider('rfc3161', { mode: 'timeout' }), request, { timeoutMs: 20 });
    expect(outcome).toEqual({ status: 'pending', reason: 'provider_timeout' });
    expect('token' in outcome).toBe(false);
  });

  it('fails closed (FAILED, no token) on a malformed provider response', async () => {
    const outcome = await requestAnchor(new FakeAnchorProvider('rfc3161', { mode: 'malformed' }), request);
    expect(outcome).toEqual({ status: 'failed', reason: 'malformed_response' });
    expect('token' in outcome).toBe(false);
  });

  it('fails closed (FAILED) when the token commits to a different hash', async () => {
    const outcome = await requestAnchor(new FakeAnchorProvider('rfc3161', { mode: 'wrong_hash' }), request);
    expect(outcome).toEqual({ status: 'failed', reason: 'hash_mismatch' });
  });

  it('fails closed (FAILED) when the token does not verify (forged proof) — WV-6', async () => {
    const outcome = await requestAnchor(new FakeAnchorProvider('rfc3161', { mode: 'forged' }), request);
    expect(outcome).toEqual({ status: 'failed', reason: 'token_verification_failed' });
  });

  it('ANCHORED only after a verified token: a provider whose verifyToken always fails never anchors', async () => {
    const liar: AnchorProvider = {
      provider_type: 'rfc3161',
      anchor: async () => ({ status: 'anchored', token: {
        provider_type: 'rfc3161', anchored_at: '2026-06-01T10:05:05.000Z', payload_hash: request.payload_hash,
        anchor_provider: { type: 'rfc3161', rfc3161_token: 'x', tsa_cert_ref: 'y' },
      } as AnchorToken }),
      verifyToken: () => false,
    };
    const outcome = await requestAnchor(liar, request);
    expect(outcome).toEqual({ status: 'failed', reason: 'token_verification_failed' });
  });

  it('a verifyToken that throws cannot escalate into success (fail closed)', async () => {
    const thrower: AnchorProvider = {
      provider_type: 'rfc3161',
      anchor: async () => ({ status: 'anchored', token: {
        provider_type: 'rfc3161', anchored_at: '2026-06-01T10:05:05.000Z', payload_hash: request.payload_hash,
        anchor_provider: { type: 'rfc3161', rfc3161_token: 'x', tsa_cert_ref: 'y' },
      } as AnchorToken }),
      verifyToken: () => { throw new Error('boom'); },
    };
    expect(await requestAnchor(thrower, request)).toEqual({ status: 'failed', reason: 'token_verification_failed' });
  });

  it('rejects an invalid request (non-hash payload_hash)', async () => {
    const bad = { payload_hash: 'not-a-hash' } as AnchorRequest;
    expect(await requestAnchor(new FakeAnchorProvider('rfc3161'), bad)).toEqual({ status: 'failed', reason: 'invalid_request' });
  });
});

describe('AnchorProviderRegistry (T130) — pluggable + unsupported fails closed', () => {
  it('dispatches to a registered provider and verifies', async () => {
    const reg = new AnchorProviderRegistry([new FakeAnchorProvider('rfc3161'), new FakeAnchorProvider('transparency_log')]);
    expect(reg.supports('rfc3161')).toBe(true);
    expect(reg.supports('dual_custodian')).toBe(false);
    const outcome = await reg.anchor('transparency_log', request);
    expect(isAnchored(outcome)).toBe(true);
  });

  it('fails closed (FAILED, no token) for an unsupported provider type', async () => {
    const reg = new AnchorProviderRegistry([new FakeAnchorProvider('rfc3161')]);
    const outcome: AnchorOutcome = await reg.anchor('dual_custodian' as AnchorProviderType, request);
    expect(outcome).toEqual({ status: 'failed', reason: 'unsupported_provider' });
    expect('token' in outcome).toBe(false);
  });

  it('rejects duplicate provider registration', () => {
    expect(() => new AnchorProviderRegistry([new FakeAnchorProvider('rfc3161'), new FakeAnchorProvider('rfc3161')])).toThrow();
  });
});
