// Hash-chain link helper (Epic E1 / EDAM-T004).
//
// CCE §8 / WORM spec §7: row_hash[n] = SHA-256( prev_row_hash ‖ event_hash[n] ).
// Defined now to freeze the construction; consumed when evidence is sealed in
// Phase 2 (no sealing logic is implemented here).
//
// Construction (frozen): the concatenation is over the canonical `sha256:<hex>`
// TOKEN STRINGS (UTF-8), in the order prev_row_hash then event_hash. The
// genesis link uses an all-zero prev_row_hash.

import { sha256Hex, assertHashToken } from './hash.js';

/** Genesis predecessor for the first link in a chain. */
export const GENESIS_ROW_HASH = 'sha256:' + '0'.repeat(64);

/** Compute the next row_hash from the previous link and this event's hash. */
export function rowHash(prevRowHash: string, eventHash: string): string {
  assertHashToken(prevRowHash, 'prev_row_hash');
  assertHashToken(eventHash, 'event_hash');
  return 'sha256:' + sha256Hex(prevRowHash + eventHash);
}
