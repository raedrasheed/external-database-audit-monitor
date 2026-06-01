// Stream guard: idempotency + V14/V15 (Epic E4 / EDAM-T036).
//
// Wraps the frozen CceStreamValidator (V14 monotonic ingest, V15 duplicate
// envelope_id with a differing event_hash) and adds idempotent de-duplication:
//   - same envelope_id + same event_hash  -> DUPLICATE (skip; replay-safe)
//   - same envelope_id + different hash    -> INTEGRITY_VIOLATION (V15, critical)
//   - otherwise                            -> EMIT
// A non-monotonic ingest (V14) is reported but does not drop the event.

import { CceStreamValidator, type ValidationError } from '@edam/contracts';
import type { Cce } from '@edam/cce-model';

export type EmitAction = 'EMIT' | 'DUPLICATE' | 'INTEGRITY_VIOLATION';

export interface GuardResult {
  action: EmitAction;
  violations: ValidationError[];
}

export class CceStreamGuard {
  private readonly stream = new CceStreamValidator();
  private readonly seen = new Map<string, string>(); // envelope_id -> event_hash

  check(cce: Cce): GuardResult {
    const violations = this.stream.check(cce as unknown as Record<string, unknown>);
    const id = cce.envelope_id;
    const hash = cce.evidence.event_hash;
    const prior = this.seen.get(id);

    if (prior !== undefined && prior !== hash) {
      return { action: 'INTEGRITY_VIOLATION', violations };
    }
    if (prior === hash) {
      return { action: 'DUPLICATE', violations };
    }
    this.seen.set(id, hash);
    return { action: 'EMIT', violations };
  }
}
