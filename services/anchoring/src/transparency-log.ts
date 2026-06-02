// Dev transparency-log provider (Sprint-2 / EDAM-T132).
//
// An append-only Merkle transparency log (RFC 6962-style) acting as an external
// anchor authority (WORM §9.2). Each anchored payload hash is appended as a leaf;
// the provider returns an inclusion proof to a Signed Tree Head (STH) that is
// signed by the log's key.
//
// REAL verification, NOT self-attestation (same posture as the dev TSA, T131):
// the STH carries a genuine Ed25519 signature, and `verifyTransparencyLogToken`
// re-proves it offline using ONLY the published log cert plus the inclusion
// proof — so the future independent verifier (T2E) reuses it. The anchoring-time
// `requestAnchor` path still uses the provider's own cert (E2D-ANCHOR-M1-RESIDUAL,
// closed by T2E against a trusted published cert).
//
// Merkle hashing follows RFC 6962: leaf = SHA256(0x00 || data), node = SHA256(
// 0x01 || left || right). The STH/token are modeled (canonical JSON, not RFC 6962
// wire format); a real CT log + DER/TLS encoding is a production concern. The
// provider receives ONLY the payload hash; no plaintext (INV-EV-2). The log
// private key is held in a #field and never exported or logged (INV-EV-4).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { serializeCanonical, isHashToken } from '@edam/canonical';
import type { AnchorOutcome, AnchorProvider, AnchorRequest, AnchorToken } from './types.js';

const STH_DOMAIN = 'edam-dev-ct-sth-v1';
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/** A modeled Signed Tree Head (RFC 6962 §3.5, simplified): the signed root at a tree size. */
export interface SignedTreeHead {
  log_id: string;
  tree_size: number;
  root_hash: string;
  sth_time: string;
}

/** A published dev transparency-log certificate — PUBLIC material only. */
export interface DevLogCertificate {
  log_id: string;
  algorithm: 'ed25519';
  /** SPKI DER, base64. PUBLIC ONLY. */
  public_key: string;
  subject: string;
}

export interface TransparencyLogVerifyResult {
  ok: boolean;
  reason?: string;
  sth_time?: string;
}

export interface DevTransparencyLogProviderOptions {
  /** Existing Ed25519 log private key (PEM/PKCS#8). If omitted, a fresh dev key is generated. */
  privateKeyPem?: string;
  /** Deterministic STH time (RFC3339). Defaults to issue-time `now`. */
  sthTime?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRealInstant(s: unknown): s is string {
  return typeof s === 'string' && RFC3339_RE.test(s) && Number.isFinite(Date.parse(s));
}

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** RFC 6962 leaf hash over the 32 raw bytes of a `sha256:` token. */
function leafHashFromPayload(payloadHash: string): Buffer {
  return sha256(LEAF_PREFIX, Buffer.from(payloadHash.slice('sha256:'.length), 'hex'));
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** Largest power of two k with k < n <= 2k (RFC 6962), for n > 1. */
function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/** Merkle Tree Hash over already-hashed leaves (RFC 6962 §2.1). */
function merkleTreeHash(leaves: readonly Buffer[]): Buffer {
  const n = leaves.length;
  if (n === 0) return sha256(Buffer.alloc(0));
  if (n === 1) return leaves[0]!;
  const k = largestPowerOfTwoLessThan(n);
  return nodeHash(merkleTreeHash(leaves.slice(0, k)), merkleTreeHash(leaves.slice(k)));
}

/** Audit path for leaf m in the tree of leaves (RFC 6962 §2.1.1). */
function inclusionPath(m: number, leaves: readonly Buffer[]): Buffer[] {
  const n = leaves.length;
  if (n === 1) return [];
  const k = largestPowerOfTwoLessThan(n);
  if (m < k) return [...inclusionPath(m, leaves.slice(0, k)), merkleTreeHash(leaves.slice(k))];
  return [...inclusionPath(m - k, leaves.slice(k)), merkleTreeHash(leaves.slice(0, k))];
}

/** Recompute the root from an inclusion proof (RFC 6962 §2.1.1 verification). */
function rootFromInclusion(leafIndex: number, treeSize: number, leafHash: Buffer, proof: readonly Buffer[]): Buffer | undefined {
  if (!Number.isInteger(leafIndex) || !Number.isInteger(treeSize) || leafIndex < 0 || leafIndex >= treeSize) return undefined;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leafHash;
  for (const p of proof) {
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 ? r : undefined;
}

function isValidSth(s: unknown): s is SignedTreeHead {
  if (!isRecord(s)) return false;
  if (typeof s.log_id !== 'string' || s.log_id.length === 0) return false;
  if (!Number.isInteger(s.tree_size) || (s.tree_size as number) < 1) return false;
  if (typeof s.root_hash !== 'string' || !HEX64_RE.test(s.root_hash)) return false;
  if (!isRealInstant(s.sth_time)) return false;
  return true;
}

function sthSigningBytes(sth: SignedTreeHead): Uint8Array {
  return new TextEncoder().encode(`${STH_DOMAIN}:${serializeCanonical(sth)}`);
}

function spkiDerB64(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

function deriveLogId(spkiB64: string): string {
  return `dev-ct-ed25519-${createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').slice(0, 16)}`;
}

/** The vendored transparency_log proof object (anchor-record-1.0). */
interface TransparencyLogProof {
  log_id: string;
  leaf_index: number;
  inclusion_proof: string[];
  signed_tree_head: string;
}

/**
 * Verify a transparency-log token offline using ONLY the published log cert. The
 * trust-minimized check the independent verifier reuses: the STH signature
 * verifies against the log public key, AND the inclusion proof for the recomputed
 * leaf reproduces the STH root. Returns ok=false (never throws) on any
 * malformed/forged/mismatched input.
 */
export function verifyTransparencyLogToken(proof: TransparencyLogProof, payloadHash: string, cert: DevLogCertificate): TransparencyLogVerifyResult {
  try {
    if (!isHashToken(payloadHash)) return { ok: false, reason: 'invalid_payload_hash' };
    if (cert.algorithm !== 'ed25519') return { ok: false, reason: 'algorithm_mismatch' };
    if (!isRecord(proof) || typeof proof.log_id !== 'string' || !Number.isInteger(proof.leaf_index) || !Array.isArray(proof.inclusion_proof) || typeof proof.signed_tree_head !== 'string') {
      return { ok: false, reason: 'malformed_proof' };
    }
    if (proof.log_id !== cert.log_id) return { ok: false, reason: 'log_mismatch' };
    const envelope: unknown = JSON.parse(Buffer.from(proof.signed_tree_head, 'base64').toString('utf8'));
    if (!isRecord(envelope) || envelope.signature_algorithm !== 'ed25519' || typeof envelope.signature !== 'string') {
      return { ok: false, reason: 'malformed_sth' };
    }
    const sth = envelope.sth;
    if (!isValidSth(sth)) return { ok: false, reason: 'malformed_sth' };
    if (sth.log_id !== cert.log_id) return { ok: false, reason: 'log_mismatch' };
    // (1) STH signature verifies against the published log public key.
    const key = createPublicKey({ key: Buffer.from(cert.public_key, 'base64'), format: 'der', type: 'spki' });
    if (!edVerify(null, Buffer.from(sthSigningBytes(sth)), key, Buffer.from(envelope.signature, 'base64'))) {
      return { ok: false, reason: 'sth_signature_invalid' };
    }
    // (2) Inclusion proof for the recomputed leaf reproduces the STH root.
    if (!proof.inclusion_proof.every((h) => typeof h === 'string' && HEX64_RE.test(h))) return { ok: false, reason: 'malformed_proof' };
    const proofBufs = proof.inclusion_proof.map((h) => Buffer.from(h, 'hex'));
    const root = rootFromInclusion(proof.leaf_index, sth.tree_size, leafHashFromPayload(payloadHash), proofBufs);
    if (root === undefined || root.toString('hex') !== sth.root_hash) return { ok: false, reason: 'inclusion_invalid' };
    return { ok: true, sth_time: sth.sth_time };
  } catch {
    return { ok: false, reason: 'malformed_token' };
  }
}

/**
 * Dev transparency-log provider. Appends each payload hash as a Merkle leaf and
 * returns an inclusion proof to a signed tree head. Holds no plaintext; never
 * exposes the log private key.
 */
export class DevTransparencyLogProvider implements AnchorProvider {
  readonly provider_type = 'transparency_log' as const;
  readonly #privateKey: KeyObject;
  readonly #cert: DevLogCertificate;
  readonly #sthTime: string | undefined;
  readonly #leaves: Buffer[] = [];

  constructor(opts: DevTransparencyLogProviderOptions = {}) {
    if (opts.privateKeyPem !== undefined) {
      this.#privateKey = createPrivateKey({ key: opts.privateKeyPem, format: 'pem' });
      if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error(`DevTransparencyLogProvider: expected an ed25519 log key (got ${String(this.#privateKey.asymmetricKeyType)})`);
      }
    } else {
      this.#privateKey = generateKeyPairSync('ed25519').privateKey;
    }
    const publicKeyB64 = spkiDerB64(createPublicKey(this.#privateKey));
    this.#cert = { log_id: deriveLogId(publicKeyB64), algorithm: 'ed25519', public_key: publicKeyB64, subject: 'CN=EDAM Dev Transparency Log' };
    this.#sthTime = opts.sthTime;
  }

  /** The published log certificate (public material only). */
  getCertificate(): DevLogCertificate {
    return { ...this.#cert };
  }

  /** Current number of appended leaves. */
  get treeSize(): number {
    return this.#leaves.length;
  }

  async anchor(request: AnchorRequest): Promise<AnchorOutcome> {
    if (!isHashToken(request.payload_hash)) return { status: 'failed', reason: 'invalid_request' };
    const leafIndex = this.#leaves.length;
    this.#leaves.push(leafHashFromPayload(request.payload_hash));
    const treeSize = this.#leaves.length;
    const inclusion = inclusionPath(leafIndex, this.#leaves).map((b) => b.toString('hex'));
    const sthTime = this.#sthTime ?? new Date().toISOString();
    const sth: SignedTreeHead = {
      log_id: this.#cert.log_id,
      tree_size: treeSize,
      root_hash: merkleTreeHash(this.#leaves).toString('hex'),
      sth_time: sthTime,
    };
    const signature = edSign(null, Buffer.from(sthSigningBytes(sth)), this.#privateKey).toString('base64');
    const signedTreeHead = Buffer.from(JSON.stringify({ sth, signature, signature_algorithm: 'ed25519' }), 'utf8').toString('base64');
    return {
      status: 'anchored',
      token: {
        provider_type: 'transparency_log',
        anchor_provider: { type: 'transparency_log', transparency_log: { log_id: this.#cert.log_id, leaf_index: leafIndex, inclusion_proof: inclusion, signed_tree_head: signedTreeHead } },
        anchored_at: sthTime,
        payload_hash: request.payload_hash,
      },
    };
  }

  verifyToken(token: AnchorToken, request: AnchorRequest): boolean {
    if (token.provider_type !== 'transparency_log' || token.anchor_provider.type !== 'transparency_log') return false;
    if (token.payload_hash !== request.payload_hash) return false;
    const proof = token.anchor_provider.transparency_log;
    if (proof.log_id !== this.#cert.log_id) return false;
    const result = verifyTransparencyLogToken(proof, request.payload_hash, this.#cert);
    if (!result.ok) return false;
    return token.anchored_at === result.sth_time;
  }
}
