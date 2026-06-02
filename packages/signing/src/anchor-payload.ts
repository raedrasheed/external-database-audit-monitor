// Canonical anchor payload (Sprint-2 / EDAM-T120).
//
// The HSM/dev signer signs the anchor payload (WORM §8):
//   canonical({db_id, segment_id, segment_sequence, segment_hash, last_row_hash,
//              head_count, signed_at})
// It is a HASH STRUCTURE — segment_hash/last_row_hash are sha256 tokens; no CCE
// plaintext is ever included. Serialization is the single canonical serializer
// (CCE §12.7), so the signed bytes are byte-for-byte reproducible by a verifier.

import { serializeCanonical, eventHash, assertHashToken } from '@edam/canonical';
import type { AnchorPayload, ChainHead } from './types.js';

/**
 * Fixed domain-separation tag (E2C-SIGN-M1). Signatures are over
 * `${ANCHOR_PAYLOAD_DOMAIN}:${canonical(payload)}`, so an anchor-payload
 * signature is cryptographically scoped to this domain and cannot be confused
 * with a signature over any other structure.
 */
export const ANCHOR_PAYLOAD_DOMAIN = 'edam-anchor-payload-v1';

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export interface AnchorPayloadOptions {
  /** Cumulative head count for this anchored head (>= 1). Supplied by the anchoring stage. */
  headCount: number;
  /** When the head is signed (RFC3339). Recorded once by the anchoring stage. */
  signedAt: string;
}

/**
 * Validate an anchor payload (E2C-SIGN-M2): hash-token fields, head_count >= 1,
 * non-empty RFC3339 signed_at, segment_sequence integer >= 0, non-empty db_id /
 * segment_id. Throws on any violation — a signer MUST call this before signing.
 */
export function assertValidAnchorPayload(p: AnchorPayload): void {
  if (typeof p.db_id !== 'string' || p.db_id.length === 0) throw new Error('anchor payload: db_id must be a non-empty string');
  if (typeof p.segment_id !== 'string' || p.segment_id.length === 0) throw new Error('anchor payload: segment_id must be a non-empty string');
  if (!Number.isInteger(p.segment_sequence) || p.segment_sequence < 0) throw new Error(`anchor payload: segment_sequence must be an integer >= 0 (got ${p.segment_sequence})`);
  assertHashToken(p.segment_hash, 'segment_hash');
  assertHashToken(p.last_row_hash, 'last_row_hash');
  if (!Number.isInteger(p.head_count) || p.head_count < 1) throw new Error(`anchor payload: head_count must be an integer >= 1 (got ${p.head_count})`);
  if (typeof p.signed_at !== 'string' || !RFC3339_RE.test(p.signed_at)) throw new Error(`anchor payload: signed_at must be a non-empty RFC3339 instant (got ${JSON.stringify(p.signed_at)})`);
}

/** Build a validated anchor payload from a chain head. */
export function buildAnchorPayload(head: ChainHead, opts: AnchorPayloadOptions): AnchorPayload {
  const payload: AnchorPayload = {
    db_id: head.db_id,
    segment_id: head.segment_id,
    segment_sequence: head.segment_sequence,
    segment_hash: head.segment_hash,
    last_row_hash: head.last_row_hash,
    head_count: opts.headCount,
    signed_at: opts.signedAt,
  };
  assertValidAnchorPayload(payload);
  return payload;
}

/** Canonical serialization of the anchor payload — reproducible byte-for-byte. */
export function serializeAnchorPayload(payload: AnchorPayload): string {
  return serializeCanonical(payload);
}

/** The exact canonical bytes (no domain tag). Retained for the determinism rig. */
export function anchorPayloadBytes(payload: AnchorPayload): Uint8Array {
  return new TextEncoder().encode(serializeAnchorPayload(payload));
}

/**
 * The exact bytes a Signer signs (E2C-SIGN-M1): the fixed domain-separation tag
 * prefixed to the canonical payload, `${ANCHOR_PAYLOAD_DOMAIN}:${canonical}`. A
 * signature is therefore cryptographically scoped to anchor payloads and cannot
 * be replayed as a signature over any other structure.
 */
export function anchorSigningMessage(payload: AnchorPayload): Uint8Array {
  assertValidAnchorPayload(payload);
  return new TextEncoder().encode(`${ANCHOR_PAYLOAD_DOMAIN}:${serializeAnchorPayload(payload)}`);
}

/** sha256: digest of the canonical anchor payload (a hash over the hash structure). */
export function anchorPayloadHash(payload: AnchorPayload): string {
  return eventHash(serializeAnchorPayload(payload));
}
