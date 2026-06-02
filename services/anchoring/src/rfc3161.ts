// Dev RFC-3161 TSA provider (Sprint-2 / EDAM-T131).
//
// A development RFC-3161 Time-Stamping Authority: a local authority with a dev
// keypair ("dev cert") that issues and validates a TimeStampToken over the
// message imprint (the hash of the signed anchor payload) per WORM §9.1.
//
// REAL verification, NOT self-attestation (closes E2D-ANCHOR-M1 at the provider):
// the token carries a genuine Ed25519 signature by the TSA key over the canonical
// TstInfo, and `verifyRfc3161Token` re-proves it against the TSA's PUBLISHED
// public cert — using only public inputs, so the future independent verifier
// (T2E) can reuse it offline. A forged token without the TSA private key fails.
//
// Dev limitations (documented): the cert is a dev/self-issued key (not a
// publicly-trusted TSA), and the token is RFC-3161 in SEMANTICS (message imprint
// + genTime + serial, signed by the TSA) rather than full ASN.1/CMS DER — DER
// wire format + a real public TSA are a production concern. The provider receives
// ONLY the payload hash; no plaintext (INV-EV-2). The TSA private key is held in
// a #field and never exported or logged (INV-EV-4 hygiene).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { serializeCanonical, isHashToken } from '@edam/canonical';
import type { AnchorOutcome, AnchorProvider, AnchorRequest, AnchorToken } from './types.js';

/** Domain separation for the dev-TSA signature (scopes it to TstInfo, never other structures). */
const DEV_TSA_DOMAIN = 'edam-dev-rfc3161-tstinfo-v1';
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

export interface DevRfc3161ProviderOptions {
  /** Existing Ed25519 TSA private key (PEM/PKCS#8). If omitted, a fresh dev key is generated. */
  privateKeyPem?: string;
  /** TSA policy identifier (dev). */
  policy?: string;
  /** Deterministic gen_time (RFC3339). Defaults to issue-time `now`. */
  genTime?: string;
  /** Deterministic serial number. Defaults to a random hex serial. */
  serialNumber?: string;
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

/** The exact bytes the TSA signs: domain tag + canonical TstInfo. */
function tstSigningBytes(info: TstInfo): Uint8Array {
  return new TextEncoder().encode(`${DEV_TSA_DOMAIN}:${serializeCanonical(info)}`);
}

function spkiDerB64(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

function deriveCertRef(spkiB64: string): string {
  return `dev-tsa-ed25519-${createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').slice(0, 16)}`;
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

/**
 * Dev RFC-3161 TSA provider. Issues a real Ed25519-signed TimeStampToken over the
 * payload hash and verifies tokens against its published dev cert. Holds no
 * plaintext; never exposes the TSA private key.
 */
export class DevRfc3161Provider implements AnchorProvider {
  readonly provider_type = 'rfc3161' as const;
  readonly #privateKey: KeyObject;
  readonly #cert: DevTsaCertificate;
  readonly #policy: string;
  readonly #genTime: string | undefined;
  readonly #serialNumber: string | undefined;

  constructor(opts: DevRfc3161ProviderOptions = {}) {
    if (opts.privateKeyPem !== undefined) {
      this.#privateKey = createPrivateKey({ key: opts.privateKeyPem, format: 'pem' });
      if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error(`DevRfc3161Provider: expected an ed25519 TSA key (got ${String(this.#privateKey.asymmetricKeyType)})`);
      }
    } else {
      this.#privateKey = generateKeyPairSync('ed25519').privateKey;
    }
    const publicKeyB64 = spkiDerB64(createPublicKey(this.#privateKey));
    this.#cert = { tsa_cert_ref: deriveCertRef(publicKeyB64), algorithm: 'ed25519', public_key: publicKeyB64, subject: 'CN=EDAM Dev TSA' };
    this.#policy = opts.policy ?? 'edam.dev.tsa.policy.1';
    this.#genTime = opts.genTime;
    this.#serialNumber = opts.serialNumber;
  }

  /** The published dev-TSA certificate (public material only). */
  getCertificate(): DevTsaCertificate {
    return { ...this.#cert };
  }

  async anchor(request: AnchorRequest): Promise<AnchorOutcome> {
    if (!isHashToken(request.payload_hash)) return { status: 'failed', reason: 'invalid_request' };
    const genTime = this.#genTime ?? new Date().toISOString();
    const tstInfo: TstInfo = {
      version: 1,
      policy: this.#policy,
      message_imprint: { hash_algorithm: 'sha-256', hashed_message: request.payload_hash },
      serial_number: this.#serialNumber ?? randomBytes(8).toString('hex'),
      gen_time: genTime,
      tsa_cert_ref: this.#cert.tsa_cert_ref,
    };
    const signature = edSign(null, Buffer.from(tstSigningBytes(tstInfo)), this.#privateKey).toString('base64');
    const rfc3161Token = Buffer.from(JSON.stringify({ tst_info: tstInfo, signature, signature_algorithm: 'ed25519' }), 'utf8').toString('base64');
    return {
      status: 'anchored',
      token: {
        provider_type: 'rfc3161',
        anchor_provider: { type: 'rfc3161', rfc3161_token: rfc3161Token, tsa_cert_ref: this.#cert.tsa_cert_ref },
        anchored_at: genTime,
        payload_hash: request.payload_hash,
      },
    };
  }

  verifyToken(token: AnchorToken, request: AnchorRequest): boolean {
    if (token.provider_type !== 'rfc3161' || token.anchor_provider.type !== 'rfc3161') return false;
    if (token.payload_hash !== request.payload_hash) return false;
    if (token.anchor_provider.tsa_cert_ref !== this.#cert.tsa_cert_ref) return false;
    const result = verifyRfc3161Token(token.anchor_provider.rfc3161_token, request.payload_hash, this.#cert);
    if (!result.ok) return false;
    // The asserted anchored_at must match the signed gen_time (no out-of-band time).
    return token.anchored_at === result.gen_time;
  }
}
