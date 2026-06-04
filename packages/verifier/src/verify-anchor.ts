// Verifier anchor verification (Sprint-2 / EDAM-T143): §10 steps 7-8.
//
// Re-proves, per segment, the HSM signature over the anchored head and the
// external anchor token (RFC-3161 / transparency-log) against TRUSTED PUBLISHED
// material — offline, never via a live provider (closes E2D-ANCHOR-M1 / AR1 for
// the verifier path). Uses ONLY:
//   - @edam/evidence: anchorSigningMessage / anchorPayloadHash / segmentHashOf
//     (the SAME canonical assembly the signer/provider used — no drift),
//   - @edam/anchor-proof: verifyRfc3161Token / verifyTransparencyLogToken,
//   - the trusted signing-key + anchor-cert directories (T140), and node:crypto.
// Does NOT import @edam/signing or services/anchoring. Fail-closed throughout.
//
// CT1 (transparency-log equivocation) is NOT addressed here (inclusion-to-STH
// only); the export-based anchor-cert loader is deferred to T145.

import { verify as edVerify } from 'node:crypto';
import { anchorSigningMessage, anchorPayloadHash, segmentHashOf, type AnchorPayload } from '@edam/evidence';
import { validateAnchorRecord } from '@edam/contracts';
import {
  verifyRfc3161Token,
  verifyTransparencyLogToken,
  type DevTsaCertificate,
  type DevLogCertificate,
  type TransparencyLogProof,
} from '@edam/anchor-proof';
import type { CheckOutcome, VerifierSegment } from './verify-segments.js';
import { parsePublicKey, type TrustedSigningKeyDirectory, type TrustedAnchorCertDirectory } from './trust.js';

/** The anchored head (anchor-record-1.0 §16.2 `head`). */
export interface AnchorRecordHead {
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
  last_row_hash: string;
  head_count: number;
  signed_at: string;
}

/** The `hsm_signature` of an anchor record. */
export interface AnchorRecordHsmSignature {
  algorithm: string;
  signing_key_id: string;
  signature: string;
  revoked_at?: string | null;
}

/** The `anchor_provider` of an anchor record (the vendored proof shape). */
export interface AnchorRecordProvider {
  type: 'rfc3161' | 'transparency_log' | 'dual_custodian';
  rfc3161_token?: string;
  tsa_cert_ref?: string;
  transparency_log?: TransparencyLogProof;
  dual_custodian?: { custodian_id: string; signature: string; key_ref: string; timestamp: string };
}

/** A parsed `anchor-record-1.0` (verifier-local; not imported from services/anchoring). */
export interface AnchorRecord {
  anchor_version: 'anchor-record-1.0';
  anchor_id: string;
  db_id: string;
  head: AnchorRecordHead;
  hsm_signature: AnchorRecordHsmSignature;
  anchor_provider: AnchorRecordProvider;
  created_at: string;
}

function pass(): CheckOutcome {
  return { result: 'PASS', offending_ids: [] };
}

function fail(offending_ids: string[], details: string): CheckOutcome {
  return { result: 'FAIL', offending_ids, details };
}

/** Reconstruct the canonical anchor payload from a verified head (the bytes the signer signed). */
function payloadOf(record: AnchorRecord): AnchorPayload {
  return {
    db_id: record.db_id,
    segment_id: record.head.segment_id,
    segment_sequence: record.head.segment_sequence,
    segment_hash: record.head.segment_hash,
    last_row_hash: record.head.last_row_hash,
    head_count: record.head.head_count,
    signed_at: record.head.signed_at,
  };
}

/** §10.7 HSM signature: bind the anchored head to the recomputed segment head, then verify the signature. */
function verifyHsmSignature(segment: VerifierSegment, record: AnchorRecord, payload: AnchorPayload, keys: TrustedSigningKeyDirectory): CheckOutcome {
  const segId = segment.manifest.segment_id;

  // Same-head binding: the anchored head MUST be the recomputed head of THIS segment.
  const recomputedSegmentHash = segmentHashOf(segment.manifest);
  if (record.head.segment_hash !== recomputedSegmentHash) return fail([segId], 'anchored head.segment_hash !== recomputed segment_hash');
  if (record.head.last_row_hash !== segment.manifest.last_row_hash) return fail([segId], 'anchored head.last_row_hash !== manifest.last_row_hash');
  if (record.head.segment_id !== segment.manifest.segment_id || record.head.segment_sequence !== segment.manifest.segment_sequence) {
    return fail([segId], 'anchored head segment_id/segment_sequence !== manifest');
  }

  const sig = record.hsm_signature;
  const key = keys.get(sig.signing_key_id);
  if (key === undefined) return fail([segId], `unknown signing_key_id ${sig.signing_key_id}`);
  if (sig.algorithm !== key.algorithm) return fail([segId], `algorithm mismatch: signature ${sig.algorithm} !== key ${key.algorithm}`);
  if (sig.algorithm !== 'ed25519') return fail([segId], `unsupported signature algorithm ${sig.algorithm}`);

  // Honor revocation: a key revoked at-or-before the signing instant is invalid (anchors signed before remain valid).
  if (key.revoked_at != null) {
    const revoked = Date.parse(key.revoked_at);
    const signedAt = Date.parse(payload.signed_at);
    if (Number.isFinite(revoked) && Number.isFinite(signedAt) && signedAt >= revoked) return fail([segId], 'signing key revoked at/before signed_at');
  }
  // Honor the lower validity bound: a key used BEFORE its not_before is not yet valid
  // (P2-TRUST-GENERATOR — both bounds: created_at <= signed_at < revoked_at). Conditional:
  // trust files without not_before are unaffected (backward-compatible).
  if (key.not_before != null) {
    const notBefore = Date.parse(key.not_before);
    const signedAt = Date.parse(payload.signed_at);
    if (Number.isFinite(notBefore) && Number.isFinite(signedAt) && signedAt < notBefore) return fail([segId], 'signing key not yet valid at signed_at (signed before not_before)');
  }

  try {
    const message = Buffer.from(anchorSigningMessage(payload)); // validates the payload + shared canonical bytes
    const pub = parsePublicKey(key.public_key);
    const ok = edVerify(null, message, pub, Buffer.from(sig.signature, 'base64'));
    return ok ? pass() : fail([segId], 'HSM signature does not verify');
  } catch {
    return fail([segId], 'HSM signature verification error (malformed key/signature/payload)');
  }
}

/** §10.8 anchor token: verify the external token against the trusted published cert + same-head commitment. */
function verifyAnchorToken(record: AnchorRecord, payloadHash: string, certs: TrustedAnchorCertDirectory): CheckOutcome {
  const segId = record.head.segment_id;
  const ap = record.anchor_provider;

  if (ap.type === 'rfc3161') {
    if (typeof ap.rfc3161_token !== 'string' || typeof ap.tsa_cert_ref !== 'string') return fail([segId], 'malformed rfc3161 anchor_provider');
    const trusted = certs.get(ap.tsa_cert_ref);
    if (trusted === undefined) return fail([segId], `missing TSA cert ${ap.tsa_cert_ref}`);
    if (trusted.algorithm !== 'ed25519') return fail([segId], `unsupported TSA cert algorithm ${trusted.algorithm}`);
    const cert: DevTsaCertificate = { tsa_cert_ref: trusted.ref, algorithm: 'ed25519', public_key: trusted.public_key, subject: '' };
    const r = verifyRfc3161Token(ap.rfc3161_token, payloadHash, cert);
    return r.ok ? { result: 'PASS', offending_ids: [], details: `rfc3161 gen_time=${r.gen_time}` } : fail([segId], `rfc3161 ${r.reason}`);
  }

  if (ap.type === 'transparency_log') {
    const tl = ap.transparency_log;
    if (tl === undefined || typeof tl.log_id !== 'string') return fail([segId], 'malformed transparency_log anchor_provider');
    const trusted = certs.get(tl.log_id);
    if (trusted === undefined) return fail([segId], `missing transparency-log cert ${tl.log_id}`);
    if (trusted.algorithm !== 'ed25519') return fail([segId], `unsupported log cert algorithm ${trusted.algorithm}`);
    const cert: DevLogCertificate = { log_id: trusted.ref, algorithm: 'ed25519', public_key: trusted.public_key, subject: '' };
    const r = verifyTransparencyLogToken(tl, payloadHash, cert);
    return r.ok ? { result: 'PASS', offending_ids: [], details: `transparency_log sth_time=${r.sth_time}` } : fail([segId], `transparency_log ${r.reason}`);
  }

  return fail([segId], `unsupported anchor provider type ${String(ap.type)}`);
}

/**
 * §10 steps 7-8 for one segment: validate the anchor record, then verify the HSM
 * signature and the anchor token. A segment without an anchor record fails closed
 * (cannot attest an un-anchored segment when anchor verification is requested).
 */
export function verifyAnchorForSegment(segment: VerifierSegment, keys: TrustedSigningKeyDirectory, certs: TrustedAnchorCertDirectory): { hsm_signature: CheckOutcome; anchor_token: CheckOutcome } {
  const segId = segment.manifest.segment_id;
  const record = segment.anchorRecord;
  if (record === undefined) {
    const f = fail([segId], 'no anchor record supplied for segment (cannot verify HSM signature / anchor token)');
    return { hsm_signature: f, anchor_token: f };
  }
  const schema = validateAnchorRecord(record);
  if (!schema.valid) {
    const f = fail([segId], `anchor record failed anchor-record-1.0 validation: ${schema.errors.map((e) => e.instancePath || e.keyword).join(', ')}`);
    return { hsm_signature: f, anchor_token: f };
  }
  const payload = payloadOf(record);
  return {
    hsm_signature: verifyHsmSignature(segment, record, payload, keys),
    anchor_token: verifyAnchorToken(record, anchorPayloadHash(payload), certs),
  };
}
