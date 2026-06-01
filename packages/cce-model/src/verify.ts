// CCE hash verification (Epic E4 / EDAM-T035).
//
// Recomputes event_hash over the canonical core (envelope minus `evidence`) and
// the row_hash chain link, using ONLY @edam/canonical. Lets a consumer confirm
// a CCE's evidence without trusting the producer (the same property the
// independent verifier relies on in Phase 2).

import { serializeCanonical, eventHash, rowHash, GENESIS_ROW_HASH } from '@edam/canonical';
import type { Cce } from './types.js';

export function recomputeEventHash(cce: Cce): string {
  const core = { ...(cce as unknown as Record<string, unknown>) };
  delete core.evidence;
  return eventHash(serializeCanonical(core));
}

export interface HashVerification {
  event_hash_ok: boolean;
  row_hash_ok: boolean;
}

export function verifyCce(cce: Cce): HashVerification {
  const event_hash_ok = recomputeEventHash(cce) === cce.evidence.event_hash;
  const prev = cce.evidence.prev_row_hash ?? GENESIS_ROW_HASH;
  const row_hash_ok = rowHash(prev, cce.evidence.event_hash) === cce.evidence.row_hash;
  return { event_hash_ok, row_hash_ok };
}
