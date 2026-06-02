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

/**
 * The exact, ordered field set of an anchor payload (WORM §8). The signed bytes
 * are over EXACTLY these fields — no more, no less (E2C-SIGN-M4).
 */
const ANCHOR_PAYLOAD_KEYS = [
  'db_id', 'segment_id', 'segment_sequence', 'segment_hash', 'last_row_hash', 'head_count', 'signed_at',
] as const;

export interface AnchorPayloadOptions {
  /** Cumulative head count for this anchored head (>= 1). Supplied by the anchoring stage. */
  headCount: number;
  /** When the head is signed (RFC3339). Recorded once by the anchoring stage. */
  signedAt: string;
}

/**
 * Validate an anchor payload (E2C-SIGN-M2/M4/L4): EXACT key set (no unknown
 * fields — closes the structured-oracle / plaintext-smuggling residue), hash-
 * token fields, head_count >= 1, real RFC3339 signed_at, segment_sequence
 * integer >= 0, non-empty db_id / segment_id. Throws on any violation — a signer
 * MUST call this before signing.
 */
export function assertValidAnchorPayload(p: AnchorPayload): void {
  if (typeof p !== 'object' || p === null) throw new Error('anchor payload: must be an object');
  // Exact key-set: reject ANY field outside the §8 schema (E2C-SIGN-M4). This
  // prevents smuggling arbitrary plaintext into the signed bytes via extra keys.
  const allowed = new Set<string>(ANCHOR_PAYLOAD_KEYS);
  for (const k of Object.keys(p)) {
    if (!allowed.has(k)) throw new Error(`anchor payload: unexpected field ${JSON.stringify(k)} (only the §8 fields may be signed)`);
  }
  if (typeof p.db_id !== 'string' || p.db_id.length === 0) throw new Error('anchor payload: db_id must be a non-empty string');
  if (typeof p.segment_id !== 'string' || p.segment_id.length === 0) throw new Error('anchor payload: segment_id must be a non-empty string');
  if (!Number.isInteger(p.segment_sequence) || p.segment_sequence < 0) throw new Error(`anchor payload: segment_sequence must be an integer >= 0 (got ${p.segment_sequence})`);
  assertHashToken(p.segment_hash, 'segment_hash');
  assertHashToken(p.last_row_hash, 'last_row_hash');
  if (!Number.isInteger(p.head_count) || p.head_count < 1) throw new Error(`anchor payload: head_count must be an integer >= 1 (got ${p.head_count})`);
  // signed_at must be a real RFC3339 instant: structural shape AND a parseable
  // instant (rejects impossible dates like 2026-13-45T99:99:99Z) (E2C-SIGN-L4).
  if (typeof p.signed_at !== 'string' || !RFC3339_RE.test(p.signed_at) || !Number.isFinite(Date.parse(p.signed_at))) {
    throw new Error(`anchor payload: signed_at must be a real RFC3339 instant (got ${JSON.stringify(p.signed_at)})`);
  }
}

/**
 * Validate, then reconstruct a CLEAN payload containing EXACTLY the §8 fields
 * (E2C-SIGN-M4). Even though `assertValidAnchorPayload` already rejects unknown
 * keys, signing/verification serialize this reconstructed object — never the
 * caller's object as-is — so the signed bytes can never carry extra content.
 */
function cleanAnchorPayload(p: AnchorPayload): AnchorPayload {
  assertValidAnchorPayload(p);
  return {
    db_id: p.db_id,
    segment_id: p.segment_id,
    segment_sequence: p.segment_sequence,
    segment_hash: p.segment_hash,
    last_row_hash: p.last_row_hash,
    head_count: p.head_count,
    signed_at: p.signed_at,
  };
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

/**
 * Canonical serialization of the anchor payload — reproducible byte-for-byte.
 * Validates and reconstructs a clean §8-only object first (E2C-SIGN-M4), so the
 * serialized form never carries unknown/extra fields.
 */
export function serializeAnchorPayload(payload: AnchorPayload): string {
  return serializeCanonical(cleanAnchorPayload(payload));
}

/**
 * The exact canonical bytes WITHOUT the domain tag. NOT for signing or
 * verification — those MUST use `anchorSigningMessage` (E2C-SIGN-L7). Retained
 * only for the cross-target determinism rig (E2C-SIGN-L1).
 */
export function anchorPayloadBytes(payload: AnchorPayload): Uint8Array {
  return new TextEncoder().encode(serializeAnchorPayload(payload));
}

/**
 * The exact bytes a Signer signs (E2C-SIGN-M1): the fixed domain-separation tag
 * prefixed to the canonical payload, `${ANCHOR_PAYLOAD_DOMAIN}:${canonical}`. A
 * signature is therefore cryptographically scoped to anchor payloads and cannot
 * be replayed as a signature over any other structure. Serialization validates +
 * reconstructs a clean §8-only payload (E2C-SIGN-M4).
 */
export function anchorSigningMessage(payload: AnchorPayload): Uint8Array {
  return new TextEncoder().encode(`${ANCHOR_PAYLOAD_DOMAIN}:${serializeAnchorPayload(payload)}`);
}

/** sha256: digest of the canonical anchor payload (a hash over the hash structure). */
export function anchorPayloadHash(payload: AnchorPayload): string {
  return eventHash(serializeAnchorPayload(payload));
}
