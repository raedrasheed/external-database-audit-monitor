// Transparency-log (RFC 6962) anchor-proof primitives (EDAM @edam/anchor-proof; extracted from T132).
//
// Pure: RFC 6962 Merkle leaf/node/tree/inclusion hashing + canonical STH signing
// bytes + the offline token verifier, shared by the dev transparency-log provider
// (which builds the tree / inclusion proof / STH) and the independent verifier
// (which recomputes the root + checks the STH signature) so there is ONE Merkle/
// STH implementation and no builder<->verifier drift. No private key material —
// the key-holding `DevTransparencyLogProvider` stays in `services/anchoring` and
// imports these primitives. Depends only on @edam/canonical + node:crypto.
//
// Merkle hashing follows RFC 6962: leaf = SHA256(0x00 || data), node = SHA256(
// 0x01 || left || right).

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { serializeCanonical, isHashToken } from '@edam/canonical';

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

/** The vendored transparency_log proof object (anchor-record-1.0). Exported (closes CT6). */
export interface TransparencyLogProof {
  log_id: string;
  leaf_index: number;
  inclusion_proof: string[];
  signed_tree_head: string;
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

/** RFC 6962 leaf hash over the 32 raw bytes of a `sha256:` token. Shared (build + verify). */
export function leafHashFromPayload(payloadHash: string): Buffer {
  return sha256(LEAF_PREFIX, Buffer.from(payloadHash.slice('sha256:'.length), 'hex'));
}

/** RFC 6962 interior-node hash. Shared (build + verify). */
export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** Largest power of two k with k < n <= 2k (RFC 6962), for n > 1. */
function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/** Merkle Tree Hash over already-hashed leaves (RFC 6962 §2.1). Build-side (provider). */
export function merkleTreeHash(leaves: readonly Buffer[]): Buffer {
  const n = leaves.length;
  if (n === 0) return sha256(Buffer.alloc(0));
  if (n === 1) return leaves[0]!;
  const k = largestPowerOfTwoLessThan(n);
  return nodeHash(merkleTreeHash(leaves.slice(0, k)), merkleTreeHash(leaves.slice(k)));
}

/** Audit path for leaf m in the tree of leaves (RFC 6962 §2.1.1). Build-side (provider). */
export function inclusionPath(m: number, leaves: readonly Buffer[]): Buffer[] {
  const n = leaves.length;
  if (n === 1) return [];
  const k = largestPowerOfTwoLessThan(n);
  if (m < k) return [...inclusionPath(m, leaves.slice(0, k)), merkleTreeHash(leaves.slice(k))];
  return [...inclusionPath(m - k, leaves.slice(k)), merkleTreeHash(leaves.slice(0, k))];
}

/** Recompute the root from an inclusion proof (RFC 6962 §2.1.1 verification). Verify-side. */
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

/** The exact bytes the log signs: domain tag + canonical STH. Shared by provider (sign) + verifier (check). */
export function sthSigningBytes(sth: SignedTreeHead): Uint8Array {
  return new TextEncoder().encode(`${STH_DOMAIN}:${serializeCanonical(sth)}`);
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
