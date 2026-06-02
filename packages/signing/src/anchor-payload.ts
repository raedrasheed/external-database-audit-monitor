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

export interface AnchorPayloadOptions {
  /** Cumulative head count for this anchored head (>= 1). Supplied by the anchoring stage. */
  headCount: number;
  /** When the head is signed (RFC3339). Recorded once by the anchoring stage. */
  signedAt: string;
}

/** Build the anchor payload from a chain head. Asserts the hash fields are tokens (no plaintext). */
export function buildAnchorPayload(head: ChainHead, opts: AnchorPayloadOptions): AnchorPayload {
  if (!Number.isInteger(opts.headCount) || opts.headCount < 1) {
    throw new Error(`head_count must be an integer >= 1 (got ${opts.headCount})`);
  }
  assertHashToken(head.segment_hash, 'segment_hash');
  assertHashToken(head.last_row_hash, 'last_row_hash');
  return {
    db_id: head.db_id,
    segment_id: head.segment_id,
    segment_sequence: head.segment_sequence,
    segment_hash: head.segment_hash,
    last_row_hash: head.last_row_hash,
    head_count: opts.headCount,
    signed_at: opts.signedAt,
  };
}

/** Canonical serialization of the anchor payload — reproducible byte-for-byte. */
export function serializeAnchorPayload(payload: AnchorPayload): string {
  return serializeCanonical(payload);
}

/** The exact bytes a Signer signs. */
export function anchorPayloadBytes(payload: AnchorPayload): Uint8Array {
  return new TextEncoder().encode(serializeAnchorPayload(payload));
}

/** sha256: digest of the canonical anchor payload (a hash over the hash structure). */
export function anchorPayloadHash(payload: AnchorPayload): string {
  return eventHash(serializeAnchorPayload(payload));
}
