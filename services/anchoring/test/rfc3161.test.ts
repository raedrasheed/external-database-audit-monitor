// Dev RFC-3161 TSA provider tests (Sprint-2 / EDAM-T131): real token issuance +
// authoritative verification against the dev cert (not self-attestation),
// embedded-imprint matches recomputed hash, WV-6 forgery/tamper fails closed,
// hash-only input, no plaintext, TSA private key never exposed.
import { describe, it, expect } from 'vitest';
import {
  DevRfc3161Provider,
  verifyRfc3161Token,
  anchorRequestFor,
  requestAnchor,
  isAnchored,
  type DevTsaCertificate,
} from '../src/index.js';
import { buildAnchorPayload, anchorPayloadHash, type ChainHead } from '@edam/signing';
import { generateKeyPairSync } from 'node:crypto';

const head: ChainHead = {
  db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0,
  segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64),
};
const payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
const request = anchorRequestFor(payload);
const GEN_TIME = '2026-06-01T10:05:05.000Z';

function devPem(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

/** Decode → mutate the TstInfo/signature → re-encode an rfc3161_token (attacker view). */
function reencode(rfc3161Token: string, mutate: (decoded: Record<string, unknown>) => void): string {
  const decoded = JSON.parse(Buffer.from(rfc3161Token, 'base64').toString('utf8')) as Record<string, unknown>;
  mutate(decoded);
  return Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64');
}

describe('DevRfc3161Provider (T131)', () => {
  it('issues a TimeStampToken that verifies against the dev cert; embedded hash matches recomputed (AC)', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    const outcome = await tsa.anchor(request);
    expect(isAnchored(outcome)).toBe(true);
    if (!isAnchored(outcome)) throw new Error('unreachable');
    const ap = outcome.token.anchor_provider;
    expect(ap.type).toBe('rfc3161');
    if (ap.type !== 'rfc3161') throw new Error('unreachable');
    const cert = tsa.getCertificate();
    expect(ap.tsa_cert_ref).toBe(cert.tsa_cert_ref);
    // Verified against the dev cert (public only).
    const res = verifyRfc3161Token(ap.rfc3161_token, anchorPayloadHash(payload), cert);
    expect(res.ok).toBe(true);
    expect(res.gen_time).toBe(GEN_TIME);
    // Embedded imprint equals the independently recomputed payload hash.
    const decoded = JSON.parse(Buffer.from(ap.rfc3161_token, 'base64').toString('utf8'));
    expect(decoded.tst_info.message_imprint).toEqual({ hash_algorithm: 'sha-256', hashed_message: anchorPayloadHash(payload) });
  });

  it('verifyToken is authoritative (real signature), not self-attestation, through requestAnchor', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    const outcome = await requestAnchor(tsa, request);
    expect(isAnchored(outcome)).toBe(true);
    if (!isAnchored(outcome)) throw new Error('unreachable');
    expect(tsa.verifyToken(outcome.token, request)).toBe(true);
  });

  it('signs deterministically given a fixed key + gen_time + serial (reproducible token)', async () => {
    const pem = devPem();
    const a = new DevRfc3161Provider({ privateKeyPem: pem, genTime: GEN_TIME, serialNumber: 'serial-1' });
    const b = new DevRfc3161Provider({ privateKeyPem: pem, genTime: GEN_TIME, serialNumber: 'serial-1' });
    const ta = await a.anchor(request);
    const tb = await b.anchor(request);
    if (!isAnchored(ta) || !isAnchored(tb)) throw new Error('unreachable');
    expect(ta.token).toEqual(tb.token);
  });

  // ---- WV-6: tamper / forgery fails closed ----

  it('rejects a token whose embedded imprint was tampered (WV-6)', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    const outcome = await tsa.anchor(request);
    if (!isAnchored(outcome) || outcome.token.anchor_provider.type !== 'rfc3161') throw new Error('unreachable');
    const tampered = reencode(outcome.token.anchor_provider.rfc3161_token, (d) => {
      (d.tst_info as { message_imprint: { hashed_message: string } }).message_imprint.hashed_message = 'sha256:' + 'c'.repeat(64);
    });
    // Against the original hash: imprint mismatch; against the tampered hash: signature invalid.
    expect(verifyRfc3161Token(tampered, request.payload_hash, tsa.getCertificate()).ok).toBe(false);
    expect(verifyRfc3161Token(tampered, 'sha256:' + 'c'.repeat(64), tsa.getCertificate()).reason).toBe('signature_invalid');
  });

  it('rejects a token whose signature was tampered (WV-6)', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    const outcome = await tsa.anchor(request);
    if (!isAnchored(outcome) || outcome.token.anchor_provider.type !== 'rfc3161') throw new Error('unreachable');
    const flipped = reencode(outcome.token.anchor_provider.rfc3161_token, (d) => {
      const raw = Buffer.from(d.signature as string, 'base64');
      raw[0] = raw[0]! ^ 0xff;
      d.signature = raw.toString('base64');
    });
    expect(verifyRfc3161Token(flipped, request.payload_hash, tsa.getCertificate()).reason).toBe('signature_invalid');
  });

  it('rejects a forged token re-signed by a different key but claiming the cert ref (WV-6)', async () => {
    const real = new DevRfc3161Provider({ genTime: GEN_TIME });
    const attacker = new DevRfc3161Provider({ genTime: GEN_TIME });
    const out = await attacker.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'rfc3161') throw new Error('unreachable');
    // Attacker stamps the real TSA's cert_ref onto a token they signed.
    const forged = reencode(out.token.anchor_provider.rfc3161_token, (d) => {
      (d.tst_info as { tsa_cert_ref: string }).tsa_cert_ref = real.getCertificate().tsa_cert_ref;
    });
    expect(verifyRfc3161Token(forged, request.payload_hash, real.getCertificate()).ok).toBe(false);
  });

  it('rejects verification against the wrong cert / algorithm', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    const other = new DevRfc3161Provider({ genTime: GEN_TIME });
    const out = await tsa.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'rfc3161') throw new Error('unreachable');
    const token = out.token.anchor_provider.rfc3161_token;
    expect(verifyRfc3161Token(token, request.payload_hash, other.getCertificate()).ok).toBe(false);
    const badAlg = { ...tsa.getCertificate(), algorithm: 'ecdsa-p384' } as unknown as DevTsaCertificate;
    expect(verifyRfc3161Token(token, request.payload_hash, badAlg).reason).toBe('algorithm_mismatch');
  });

  it('verifyToken rejects a token bound to a different payload hash (no replay across payloads)', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    const out = await tsa.anchor(request);
    if (!isAnchored(out)) throw new Error('unreachable');
    const otherPayload = buildAnchorPayload({ ...head, segment_sequence: 9 }, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
    const otherReq = anchorRequestFor(otherPayload);
    expect(tsa.verifyToken(out.token, otherReq)).toBe(false);
  });

  it('a forged/tampered token fails closed through requestAnchor (no token returned)', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    const out = await tsa.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'rfc3161') throw new Error('unreachable');
    const tamperedToken = { ...out.token, anchor_provider: { ...out.token.anchor_provider, rfc3161_token: reencode(out.token.anchor_provider.rfc3161_token, (d) => { d.signature = Buffer.from('garbage').toString('base64'); }) } };
    const liar = { provider_type: 'rfc3161' as const, anchor: async () => ({ status: 'anchored' as const, token: tamperedToken }), verifyToken: (t: typeof tamperedToken, r: typeof request) => tsa.verifyToken(t, r) };
    const outcome = await requestAnchor(liar, request);
    expect(outcome).toEqual({ status: 'failed', reason: 'token_verification_failed' });
    expect('token' in outcome).toBe(false);
  });

  // ---- custody / hygiene ----

  it('exposes only public cert material; never the TSA private key', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    // Only the public provider_type is enumerable; the #privateKey never serializes.
    expect(JSON.stringify(tsa)).toBe('{"provider_type":"rfc3161"}');
    expect(JSON.stringify(tsa)).not.toContain('PRIVATE');
    const cert = tsa.getCertificate();
    expect(Object.keys(cert).sort()).toEqual(['algorithm', 'public_key', 'subject', 'tsa_cert_ref']);
    for (const forbidden of ['private_key', 'privateKey', 'secret', 'd', 'pem']) {
      expect(forbidden in (cert as unknown as Record<string, unknown>)).toBe(false);
    }
    const out = await tsa.anchor(request);
    expect(JSON.stringify(out)).not.toContain('PRIVATE');
  });

  it('rejects a non-ed25519 TSA key', () => {
    const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => new DevRfc3161Provider({ privateKeyPem: rsaPem })).toThrow();
  });

  it('rejects an invalid request (non-hash payload_hash)', async () => {
    const tsa = new DevRfc3161Provider({ genTime: GEN_TIME });
    expect(await tsa.anchor({ payload_hash: 'not-a-hash' })).toEqual({ status: 'failed', reason: 'invalid_request' });
  });
});
