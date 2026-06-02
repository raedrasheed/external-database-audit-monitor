// RFC-3161 anchor-proof primitives (EDAM @edam/anchor-proof; extracted from T131).
//
// Pure: the canonical TstInfo signing bytes + the offline token verifier, shared
// by the dev RFC-3161 provider (which signs) and the independent verifier (which
// checks) so there is ONE implementation and no builder<->verifier drift. No
// private key material here — the key-holding `DevRfc3161Provider` stays in
// `services/anchoring` and imports these primitives. Depends only on
// @edam/canonical + node:crypto.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import { serializeCanonical, isHashToken } from '@edam/canonical';

/** Domain separation for the dev-TSA signature (scopes it to TstInfo, never other structures). */
export const DEV_TSA_DOMAIN = 'edam-dev-rfc3161-tstinfo-v1';
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** RFC-3161 TstInfo (modeled, §9.1): the signed assertion that an imprint existed at gen_time. */
export interface TstInfo {
  version: 1;
  policy: string;
  message_imprint: { hash_algorithm: 'sha-256'; hashed_message: string };
  serial_number: string;
  gen_time: string;
  tsa_cert_ref: string;
}

/** A published dev-TSA certificate — PUBLIC material only. */
export interface DevTsaCertificate {
  tsa_cert_ref: string;
  algorithm: 'ed25519';
  /** SPKI DER, base64. PUBLIC ONLY. */
  public_key: string;
  subject: string;
}

export interface Rfc3161VerifyResult {
  ok: boolean;
  reason?: string;
  gen_time?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRealInstant(s: unknown): s is string {
  return typeof s === 'string' && RFC3339_RE.test(s) && Number.isFinite(Date.parse(s));
}

function isValidTstInfo(t: unknown): t is TstInfo {
  if (!isRecord(t)) return false;
  if (t.version !== 1) return false;
  if (typeof t.policy !== 'string' || t.policy.length === 0) return false;
  if (typeof t.serial_number !== 'string' || t.serial_number.length === 0) return false;
  if (!isRealInstant(t.gen_time)) return false;
  if (typeof t.tsa_cert_ref !== 'string' || t.tsa_cert_ref.length === 0) return false;
  const mi = t.message_imprint;
  if (!isRecord(mi) || mi.hash_algorithm !== 'sha-256') return false;
  if (typeof mi.hashed_message !== 'string' || !isHashToken(mi.hashed_message)) return false;
  return true;
}

/** The exact bytes the TSA signs: domain tag + canonical TstInfo. Shared by provider (sign) + verifier (check). */
export function tstSigningBytes(info: TstInfo): Uint8Array {
  return new TextEncoder().encode(`${DEV_TSA_DOMAIN}:${serializeCanonical(info)}`);
}

/**
 * Verify an RFC-3161 dev token offline using ONLY the published cert (the
 * trust-minimized check the independent verifier reuses). Returns ok=false
 * (never throws) on any malformed/forged/mismatched token. Confirms: the
 * embedded message imprint equals the recomputed payload hash, the cert ref +
 * algorithm bind, and the TSA signature verifies against the cert public key.
 */
export function verifyRfc3161Token(rfc3161Token: string, payloadHash: string, cert: DevTsaCertificate): Rfc3161VerifyResult {
  try {
    if (!isHashToken(payloadHash)) return { ok: false, reason: 'invalid_payload_hash' };
    if (cert.algorithm !== 'ed25519') return { ok: false, reason: 'algorithm_mismatch' };
    const decoded: unknown = JSON.parse(Buffer.from(rfc3161Token, 'base64').toString('utf8'));
    if (!isRecord(decoded)) return { ok: false, reason: 'malformed_token' };
    if (decoded.signature_algorithm !== 'ed25519') return { ok: false, reason: 'algorithm_mismatch' };
    if (typeof decoded.signature !== 'string' || decoded.signature.length === 0) return { ok: false, reason: 'malformed_token' };
    const tst = decoded.tst_info;
    if (!isValidTstInfo(tst)) return { ok: false, reason: 'malformed_tstinfo' };
    if (tst.message_imprint.hashed_message !== payloadHash) return { ok: false, reason: 'imprint_mismatch' };
    if (tst.tsa_cert_ref !== cert.tsa_cert_ref) return { ok: false, reason: 'cert_mismatch' };
    const key = createPublicKey({ key: Buffer.from(cert.public_key, 'base64'), format: 'der', type: 'spki' });
    const ok = edVerify(null, Buffer.from(tstSigningBytes(tst)), key, Buffer.from(decoded.signature, 'base64'));
    return ok ? { ok: true, gen_time: tst.gen_time } : { ok: false, reason: 'signature_invalid' };
  } catch {
    return { ok: false, reason: 'malformed_token' };
  }
}
