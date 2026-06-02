// Anchor-record builder (Sprint-2 / EDAM-T133).
//
// Assembles an `anchor-record-1.0` (WORM §16.2) from a sealed chain head, the
// signing layer's HSM signature, and a VERIFIED external anchor token (RFC-3161
// or transparency-log). It encodes INV-EV-3 / A-EV5 at the builder boundary: a
// record can only be built from a verified `anchored` outcome (never a
// pending/failed one — no fabrication, INV-EV-6), and the head is bound to the
// token by recomputing the payload hash. Every record is validated against the
// vendored schema before it is returned.
//
// Builder ONLY: no SEALED→ANCHOR_PENDING→ANCHORED state machine, no WORM write,
// no CCE mutation. `buildAnchorRef` produces the CCE `evidence.anchor_ref` VALUE
// the lifecycle stage will later attach to covered objects (no schema change).

import { randomUUID } from 'node:crypto';
import { anchorPayloadHash, type AnchorPayload, type SignAlgorithm, type SignatureResult } from '@edam/signing';
import { validateAnchorRecord } from '@edam/contracts';
import { isAnchored } from './anchor-service.js';
import type { AnchorOutcome, AnchorProviderProof, AnchorProviderType } from './types.js';

/** The `head` object of an anchor record (anchor-record-1.0 §16.2). */
export interface AnchorRecordHead {
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
  last_row_hash: string;
  head_count: number;
  signed_at: string;
}

/** The `hsm_signature` object of an anchor record. */
export interface AnchorRecordHsmSignature {
  algorithm: SignAlgorithm;
  signing_key_id: string;
  signature: string;
  revoked_at?: string | null;
}

/** A built, schema-valid `anchor-record-1.0`. */
export interface AnchorRecord {
  anchor_version: 'anchor-record-1.0';
  anchor_id: string;
  db_id: string;
  head: AnchorRecordHead;
  hsm_signature: AnchorRecordHsmSignature;
  anchor_provider: AnchorProviderProof;
  created_at: string;
}

/** The CCE `evidence.anchor_ref` value (cce-1.1) — the lifecycle stage attaches this to covered objects. */
export interface AnchorRef {
  head_hash: string;
  hsm_signature: string;
  tsa_token?: string;
  anchor_provider: AnchorProviderType;
}

export interface BuildAnchorRecordInput {
  /** The sealed chain head as a signed anchor payload (db_id + §8 head fields). */
  head: AnchorPayload;
  /** The HSM signature over the head's anchor payload (from the signing layer). */
  hsmSignature: SignatureResult;
  /** The anchoring outcome — MUST be a verified `anchored` outcome (from requestAnchor). */
  anchorOutcome: AnchorOutcome;
  /** Optional UUID anchor_id (default: random). */
  anchorId?: string;
  /** Optional RFC3339 record creation instant (default: now). */
  createdAt?: string;
  /** Optional hsm_signature.revoked_at to record. */
  signatureRevokedAt?: string | null;
}

/** Raised when an anchor record is requested without a verified `anchored` token (INV-EV-3). */
export class UnverifiedAnchorError extends Error {
  constructor(status: string) {
    super(`anchor-record: refusing to build — anchoring outcome is ${JSON.stringify(status)}, not a verified 'anchored' token`);
    this.name = 'UnverifiedAnchorError';
  }
}

/** Raised when the head does not match the verified token's payload hash. */
export class AnchorHeadMismatchError extends Error {
  constructor(headHash: string, tokenHash: string) {
    super(`anchor-record: head payload hash ${headHash} does not match the verified token's payload_hash ${tokenHash}`);
    this.name = 'AnchorHeadMismatchError';
  }
}

/** Raised when the assembled record fails anchor-record-1.0 schema validation. */
export class AnchorRecordSchemaError extends Error {
  constructor(public readonly errors: unknown) {
    super(`anchor-record: assembled record failed anchor-record-1.0 validation: ${JSON.stringify(errors)}`);
    this.name = 'AnchorRecordSchemaError';
  }
}

/**
 * Build a schema-valid `anchor-record-1.0` from a sealed head, its HSM signature,
 * and a VERIFIED anchor token. Fails closed (throws) unless the outcome is a
 * verified `anchored` token bound to this head. Does not write WORM, transition
 * state, or mutate any CCE.
 */
export function buildAnchorRecord(input: BuildAnchorRecordInput): AnchorRecord {
  if (!isAnchored(input.anchorOutcome)) throw new UnverifiedAnchorError(input.anchorOutcome.status);
  const token = input.anchorOutcome.token;

  // Bind the head being recorded to the verified token (recompute, do not trust).
  const headHash = anchorPayloadHash(input.head);
  if (headHash !== token.payload_hash) throw new AnchorHeadMismatchError(headHash, token.payload_hash);

  const hsm_signature: AnchorRecordHsmSignature = {
    algorithm: input.hsmSignature.algorithm,
    signing_key_id: input.hsmSignature.signing_key_id,
    signature: input.hsmSignature.signature,
    ...(input.signatureRevokedAt !== undefined ? { revoked_at: input.signatureRevokedAt } : {}),
  };

  const record: AnchorRecord = {
    anchor_version: 'anchor-record-1.0',
    anchor_id: input.anchorId ?? randomUUID(),
    db_id: input.head.db_id,
    head: {
      segment_id: input.head.segment_id,
      segment_sequence: input.head.segment_sequence,
      segment_hash: input.head.segment_hash,
      last_row_hash: input.head.last_row_hash,
      head_count: input.head.head_count,
      signed_at: input.head.signed_at,
    },
    hsm_signature,
    anchor_provider: token.anchor_provider,
    created_at: input.createdAt ?? new Date().toISOString(),
  };

  const result = validateAnchorRecord(record);
  if (!result.valid) throw new AnchorRecordSchemaError(result.errors);
  return record;
}

/**
 * Build the CCE `evidence.anchor_ref` value for a record. The lifecycle stage
 * attaches this to covered objects; this function does not mutate any CCE.
 */
export function buildAnchorRef(record: AnchorRecord): AnchorRef {
  const head: AnchorPayload = { db_id: record.db_id, ...record.head };
  const ap = record.anchor_provider;
  return {
    head_hash: anchorPayloadHash(head),
    hsm_signature: record.hsm_signature.signature,
    ...(ap.type === 'rfc3161' ? { tsa_token: ap.rfc3161_token } : {}),
    anchor_provider: ap.type,
  };
}
