// Hashing primitives (Epic E1 / EDAM-T002, EDAM-T004).
//
// event_hash and the hash-chain link are defined over the canonical form
// (CCE §8). All hashes are SHA-256, lowercase hex, prefixed `sha256:`.

import { createHash } from 'node:crypto';
import { CanonicalError } from './errors.js';
import { serializeCanonical } from './serialize.js';

const HASH_TOKEN_RE = /^sha256:[0-9a-f]{64}$/;

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * event_hash over already-canonical bytes: `sha256:<64hex>` (CCE §8).
 * Callers pass the canonical serialization of the CCE core (the envelope minus
 * its `evidence` object) — assembling that core is the CCE Builder's job.
 */
export function eventHash(canonicalBytes: string): string {
  return 'sha256:' + sha256Hex(canonicalBytes);
}

/** Convenience: canonicalize a value then hash it. */
export function hashValue(value: unknown): string {
  return eventHash(serializeCanonical(value));
}

/** Assert a string is a well-formed `sha256:<64hex>` token. */
export function assertHashToken(token: string, label = 'hash'): void {
  if (!HASH_TOKEN_RE.test(token)) {
    throw new CanonicalError(`${label} is not a valid sha256 token: ${JSON.stringify(token)}`);
  }
}

export function isHashToken(token: string): boolean {
  return HASH_TOKEN_RE.test(token);
}
