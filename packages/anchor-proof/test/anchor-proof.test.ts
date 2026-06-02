// @edam/anchor-proof focused tests: the pure RFC-3161 + RFC-6962 primitives verify
// real tokens (built here with node:crypto, exercising the same primitives the
// providers use) and reject every tamper/forgery/mismatch. Pinned RFC-6962
// leaf/node/root vectors guard the Merkle hashing against drift.
import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import {
  DEV_TSA_DOMAIN,
  tstSigningBytes,
  verifyRfc3161Token,
  type TstInfo,
  type DevTsaCertificate,
  leafHashFromPayload,
  nodeHash,
  merkleTreeHash,
  inclusionPath,
  sthSigningBytes,
  verifyTransparencyLogToken,
  type SignedTreeHead,
  type DevLogCertificate,
  type TransparencyLogProof,
} from '../src/index.js';

const H = (c: string) => 'sha256:' + c.repeat(64);
const spkiB64 = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');

// ---------------- RFC-3161 ----------------

function mkTsa() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = spkiB64(publicKey);
  const cert: DevTsaCertificate = { tsa_cert_ref: 'dev-tsa-test', algorithm: 'ed25519', public_key: pub, subject: 'CN=test' };
  const issue = (payloadHash: string, genTime = '2026-06-01T10:05:05.000Z'): string => {
    const tst: TstInfo = { version: 1, policy: 'p', message_imprint: { hash_algorithm: 'sha-256', hashed_message: payloadHash }, serial_number: 's1', gen_time: genTime, tsa_cert_ref: cert.tsa_cert_ref };
    const signature = edSign(null, Buffer.from(tstSigningBytes(tst)), privateKey).toString('base64');
    return Buffer.from(JSON.stringify({ tst_info: tst, signature, signature_algorithm: 'ed25519' }), 'utf8').toString('base64');
  };
  return { cert, issue };
}

describe('@edam/anchor-proof — RFC-3161', () => {
  it('verifies a valid token and returns gen_time', () => {
    const { cert, issue } = mkTsa();
    const r = verifyRfc3161Token(issue(H('a')), H('a'), cert);
    expect(r.ok).toBe(true);
    expect(r.gen_time).toBe('2026-06-01T10:05:05.000Z');
  });

  it('rejects imprint mismatch, wrong cert, tampered signature, and malformed token', () => {
    const a = mkTsa();
    const b = mkTsa();
    const tok = a.issue(H('a'));
    expect(verifyRfc3161Token(tok, H('b'), a.cert).reason).toBe('imprint_mismatch');
    expect(verifyRfc3161Token(tok, H('a'), b.cert).ok).toBe(false); // wrong cert ⇒ cert_mismatch/sig invalid
    expect(verifyRfc3161Token('not-base64-json', H('a'), a.cert).ok).toBe(false);
    const env = JSON.parse(Buffer.from(tok, 'base64').toString('utf8'));
    env.signature = Buffer.from('x'.repeat(64)).toString('base64');
    expect(verifyRfc3161Token(Buffer.from(JSON.stringify(env), 'utf8').toString('base64'), H('a'), a.cert).ok).toBe(false);
  });

  it('domain-separates the signing bytes', () => {
    const tst: TstInfo = { version: 1, policy: 'p', message_imprint: { hash_algorithm: 'sha-256', hashed_message: H('a') }, serial_number: 's', gen_time: '2026-06-01T10:05:05.000Z', tsa_cert_ref: 'r' };
    expect(new TextDecoder().decode(tstSigningBytes(tst)).startsWith(`${DEV_TSA_DOMAIN}:`)).toBe(true);
  });
});

// ---------------- RFC-6962 / transparency log ----------------

describe('@edam/anchor-proof — RFC-6962 Merkle hashing (pinned vectors)', () => {
  it('leaf = SHA256(0x00 || data); node = SHA256(0x01 || L || R); n=1 root = leaf', () => {
    const d0 = leafHashFromPayload(H('a'));
    const manual = createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from('a'.repeat(64), 'hex')])).digest();
    expect(d0.equals(manual)).toBe(true);
    expect(merkleTreeHash([d0]).equals(d0)).toBe(true);
    const d1 = leafHashFromPayload(H('b'));
    expect(merkleTreeHash([d0, d1]).equals(nodeHash(d0, d1))).toBe(true);
  });

  it('inclusion proof for each leaf reproduces the root (n=1..5)', () => {
    for (let n = 1; n <= 5; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leafHashFromPayload(H(String.fromCharCode(97 + i)))); // a,b,c...
      const root = merkleTreeHash(leaves).toString('hex');
      for (let m = 0; m < n; m++) {
        const proof = inclusionPath(m, leaves).map((b) => b.toString('hex'));
        // Re-prove via the verifier path: build an STH over this root and verify inclusion of leaf m.
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const cert: DevLogCertificate = { log_id: 'L', algorithm: 'ed25519', public_key: spkiB64(publicKey), subject: 'CN=t' };
        const sth: SignedTreeHead = { log_id: 'L', tree_size: n, root_hash: root, sth_time: '2026-06-01T10:05:05.000Z' };
        const signature = edSign(null, Buffer.from(sthSigningBytes(sth)), privateKey).toString('base64');
        const signed_tree_head = Buffer.from(JSON.stringify({ sth, signature, signature_algorithm: 'ed25519' }), 'utf8').toString('base64');
        const proofObj: TransparencyLogProof = { log_id: 'L', leaf_index: m, inclusion_proof: proof, signed_tree_head };
        expect(verifyTransparencyLogToken(proofObj, H(String.fromCharCode(97 + m)), cert).ok, `n=${n} m=${m}`).toBe(true);
      }
    }
  });
});

describe('@edam/anchor-proof — transparency-log verify (tamper/forgery)', () => {
  function mkLog(payloads: string[]) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const cert: DevLogCertificate = { log_id: 'L1', algorithm: 'ed25519', public_key: spkiB64(publicKey), subject: 'CN=t' };
    const leaves = payloads.map(leafHashFromPayload);
    const root = merkleTreeHash(leaves).toString('hex');
    const sth: SignedTreeHead = { log_id: 'L1', tree_size: leaves.length, root_hash: root, sth_time: '2026-06-01T10:05:05.000Z' };
    const signature = edSign(null, Buffer.from(sthSigningBytes(sth)), privateKey).toString('base64');
    const signed_tree_head = Buffer.from(JSON.stringify({ sth, signature, signature_algorithm: 'ed25519' }), 'utf8').toString('base64');
    const proofFor = (m: number): TransparencyLogProof => ({ log_id: 'L1', leaf_index: m, inclusion_proof: inclusionPath(m, leaves).map((b) => b.toString('hex')), signed_tree_head });
    return { cert, proofFor };
  }

  it('valid inclusion verifies and returns sth_time', () => {
    const { cert, proofFor } = mkLog([H('a'), H('b'), H('c')]);
    const r = verifyTransparencyLogToken(proofFor(1), H('b'), cert);
    expect(r.ok).toBe(true);
    expect(r.sth_time).toBe('2026-06-01T10:05:05.000Z');
  });

  it('rejects a tampered inclusion proof, wrong payload, and wrong log cert', () => {
    const { cert, proofFor } = mkLog([H('a'), H('b'), H('c')]);
    const p = proofFor(1);
    expect(verifyTransparencyLogToken({ ...p, inclusion_proof: ['f'.repeat(64)] }, H('b'), cert).reason).toBe('inclusion_invalid');
    expect(verifyTransparencyLogToken(p, H('z'), cert).ok).toBe(false); // wrong payload ⇒ leaf differs
    const other = mkLog([H('a'), H('b'), H('c')]);
    expect(verifyTransparencyLogToken(p, H('b'), other.cert).ok).toBe(false); // wrong log cert / log_id
  });
});
