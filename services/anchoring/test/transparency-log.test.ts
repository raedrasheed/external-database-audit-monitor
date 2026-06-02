// Dev transparency-log provider tests (Sprint-2 / EDAM-T132): inclusion proof
// verifies to the STH; STH signature verifies (AC); RFC 6962 correctness across
// tree sizes; WV-6 tamper/forgery fails closed; hash-only input; log key hidden.
import { describe, it, expect } from 'vitest';
import {
  DevTransparencyLogProvider,
  verifyTransparencyLogToken,
  anchorRequestFor,
  requestAnchor,
  isAnchored,
  type DevLogCertificate,
} from '../src/index.js';
import { buildAnchorPayload, anchorPayloadHash, type ChainHead } from '@edam/signing';
import { createHash, generateKeyPairSync } from 'node:crypto';

const head: ChainHead = {
  db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0,
  segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64),
};
const payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
const request = anchorRequestFor(payload);
const STH_TIME = '2026-06-01T10:05:05.000Z';

function reqFor(seq: number) {
  return anchorRequestFor(buildAnchorPayload({ ...head, segment_sequence: seq }, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' }));
}
function devPem(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}
function reencodeSth(signedTreeHead: string, mutate: (env: Record<string, unknown>) => void): string {
  const env = JSON.parse(Buffer.from(signedTreeHead, 'base64').toString('utf8')) as Record<string, unknown>;
  mutate(env);
  return Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
}

describe('DevTransparencyLogProvider (T132)', () => {
  it('inclusion proof verifies to the STH and the STH signature verifies (AC)', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const outcome = await log.anchor(request);
    expect(isAnchored(outcome)).toBe(true);
    if (!isAnchored(outcome) || outcome.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    const tl = outcome.token.anchor_provider.transparency_log;
    expect(tl.leaf_index).toBe(0);
    const res = verifyTransparencyLogToken(tl, anchorPayloadHash(payload), log.getCertificate());
    expect(res.ok).toBe(true);
    expect(res.sth_time).toBe(STH_TIME);
  });

  it('first leaf has an empty inclusion proof whose root equals the leaf hash', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const out = await log.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    const tl = out.token.anchor_provider.transparency_log;
    expect(tl.inclusion_proof).toEqual([]);
    const env = JSON.parse(Buffer.from(tl.signed_tree_head, 'base64').toString('utf8'));
    const leaf = createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from(request.payload_hash.slice(7), 'hex')])).digest('hex');
    expect(env.sth.tree_size).toBe(1);
    expect(env.sth.root_hash).toBe(leaf);
  });

  it('verifies every leaf across a growing tree (RFC 6962 across sizes/indices)', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const tokens = [];
    for (let i = 0; i < 6; i++) {
      const r = reqFor(i);
      const out = await log.anchor(r);
      if (!isAnchored(out) || out.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
      tokens.push({ r, tl: out.token.anchor_provider.transparency_log });
    }
    for (const { r, tl } of tokens) {
      expect(verifyTransparencyLogToken(tl, r.payload_hash, log.getCertificate()).ok).toBe(true);
    }
  });

  it('works end-to-end through requestAnchor', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const outcome = await requestAnchor(log, request);
    expect(isAnchored(outcome)).toBe(true);
    if (!isAnchored(outcome)) throw new Error('unreachable');
    expect(log.verifyToken(outcome.token, request)).toBe(true);
  });

  it('signs the STH deterministically given a fixed key + sth_time + append sequence', async () => {
    const pem = devPem();
    const a = new DevTransparencyLogProvider({ privateKeyPem: pem, sthTime: STH_TIME });
    const b = new DevTransparencyLogProvider({ privateKeyPem: pem, sthTime: STH_TIME });
    const ta = await a.anchor(request);
    const tb = await b.anchor(request);
    if (!isAnchored(ta) || !isAnchored(tb)) throw new Error('unreachable');
    expect(ta.token).toEqual(tb.token);
  });

  // ---- WV-6: tamper / forgery fails closed ----

  it('rejects a tampered inclusion proof', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    await log.anchor(reqFor(0));
    const out = await log.anchor(reqFor(1)); // leaf_index 1, proof = [leafHash(0)]
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    const tl = out.token.anchor_provider.transparency_log;
    const tampered = { ...tl, inclusion_proof: ['f'.repeat(64)] };
    expect(verifyTransparencyLogToken(tampered, reqFor(1).payload_hash, log.getCertificate()).reason).toBe('inclusion_invalid');
  });

  it('rejects a tampered STH root (signature no longer matches)', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const out = await log.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    const tl = out.token.anchor_provider.transparency_log;
    const sth2 = reencodeSth(tl.signed_tree_head, (env) => { (env.sth as { root_hash: string }).root_hash = 'c'.repeat(64); });
    expect(verifyTransparencyLogToken({ ...tl, signed_tree_head: sth2 }, request.payload_hash, log.getCertificate()).reason).toBe('sth_signature_invalid');
  });

  it('rejects a tampered STH signature', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const out = await log.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    const tl = out.token.anchor_provider.transparency_log;
    const sth2 = reencodeSth(tl.signed_tree_head, (env) => {
      const raw = Buffer.from(env.signature as string, 'base64'); raw[0] = raw[0]! ^ 0xff; env.signature = raw.toString('base64');
    });
    expect(verifyTransparencyLogToken({ ...tl, signed_tree_head: sth2 }, request.payload_hash, log.getCertificate()).reason).toBe('sth_signature_invalid');
  });

  it('rejects a forged STH signed by a different log key but claiming the log id (WV-6)', async () => {
    const real = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const attacker = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const out = await attacker.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    const tl = out.token.anchor_provider.transparency_log;
    const forged = { ...tl, log_id: real.getCertificate().log_id, signed_tree_head: reencodeSth(tl.signed_tree_head, (env) => { (env.sth as { log_id: string }).log_id = real.getCertificate().log_id; }) };
    expect(verifyTransparencyLogToken(forged, request.payload_hash, real.getCertificate()).ok).toBe(false);
  });

  it('rejects verification against the wrong log cert / algorithm', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const other = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const out = await log.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    const tl = out.token.anchor_provider.transparency_log;
    expect(verifyTransparencyLogToken(tl, request.payload_hash, other.getCertificate()).ok).toBe(false);
    const badAlg = { ...log.getCertificate(), algorithm: 'ecdsa-p384' } as unknown as DevLogCertificate;
    expect(verifyTransparencyLogToken(tl, request.payload_hash, badAlg).reason).toBe('algorithm_mismatch');
  });

  it('verifyToken rejects a token bound to a different payload hash (no cross-payload replay)', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const out = await log.anchor(request);
    if (!isAnchored(out)) throw new Error('unreachable');
    expect(log.verifyToken(out.token, reqFor(9))).toBe(false);
  });

  it('a tampered token fails closed through requestAnchor (no token returned)', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    const out = await log.anchor(request);
    if (!isAnchored(out) || out.token.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    const tl = out.token.anchor_provider.transparency_log;
    const tamperedToken = { ...out.token, anchor_provider: { type: 'transparency_log' as const, transparency_log: { ...tl, inclusion_proof: ['a'.repeat(64)] } } };
    const liar = { provider_type: 'transparency_log' as const, anchor: async () => ({ status: 'anchored' as const, token: tamperedToken }), verifyToken: (t: typeof tamperedToken, r: typeof request) => log.verifyToken(t, r) };
    const outcome = await requestAnchor(liar, request);
    expect(outcome).toEqual({ status: 'failed', reason: 'token_verification_failed' });
    expect('token' in outcome).toBe(false);
  });

  // ---- custody / hygiene ----

  it('exposes only public log cert material; never the log private key', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    expect(JSON.stringify(log)).not.toContain('PRIVATE');
    const cert = log.getCertificate();
    expect(Object.keys(cert).sort()).toEqual(['algorithm', 'log_id', 'public_key', 'subject']);
    for (const forbidden of ['private_key', 'privateKey', 'secret', 'd', 'pem']) {
      expect(forbidden in (cert as unknown as Record<string, unknown>)).toBe(false);
    }
  });

  it('rejects a non-ed25519 log key and an invalid request', async () => {
    const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => new DevTransparencyLogProvider({ privateKeyPem: rsaPem })).toThrow();
    const log = new DevTransparencyLogProvider({ sthTime: STH_TIME });
    expect(await log.anchor({ payload_hash: 'not-a-hash' })).toEqual({ status: 'failed', reason: 'invalid_request' });
  });
});
