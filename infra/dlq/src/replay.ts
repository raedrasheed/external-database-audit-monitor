// DLQ inspection + replay interfaces (Epic E5 / EDAM-T039).
//
// Inspection (read-only) IS implemented. Replay EXECUTION is intentionally NOT
// implemented in Epic E5 — it is defined as an interface only. Replay must be a
// manual, human-initiated action; auto-reprocessing could silently mask a real
// gap, so the placeholder executor throws rather than ever reprocessing.

import type { DlqFilter, DlqStore } from './store.js';
import type { DlqItem } from './types.js';

// ---------------------------------------------------------------------------
// Inspection (read-only) — IMPLEMENTED
// ---------------------------------------------------------------------------

export interface DlqInspector {
  list(filter?: DlqFilter): Promise<DlqItem[]>;
  get(eventId: string): Promise<DlqItem | null>;
}

export class StoreDlqInspector implements DlqInspector {
  constructor(private readonly store: DlqStore) {}

  list(filter?: DlqFilter): Promise<DlqItem[]> {
    return this.store.list(filter);
  }
  get(eventId: string): Promise<DlqItem | null> {
    return this.store.get(eventId);
  }
}

// ---------------------------------------------------------------------------
// Replay (reprocess) — INTERFACE DEFINITION ONLY (not implemented in E5)
// ---------------------------------------------------------------------------

export interface ReplayRequest {
  event_id: string;
  reason: string;
  /** Human who initiated the replay (replay is never automatic). */
  requested_by: string;
}

export type ReplayStatus = 'replayed' | 'rejected';

export interface ReplayResult {
  event_id: string;
  status: ReplayStatus;
  detail: string;
}

export interface ReplayExecutor {
  /**
   * Reprocess a quarantined event through the pre-CCE pipeline. NOT implemented
   * in Epic E5 (no Normalization/CCE Builder yet, and replay must be manual).
   */
  replay(request: ReplayRequest): Promise<ReplayResult>;
}

export class ReplayNotImplementedError extends Error {
  constructor() {
    super(
      'DLQ replay execution is not implemented in Epic E5: quarantined events require manual, ' +
        'human-initiated review. Auto-reprocessing is disabled to avoid silently masking a gap.',
    );
    this.name = 'ReplayNotImplementedError';
  }
}

/** Placeholder: every replay attempt throws — nothing is ever reprocessed. */
export class UnimplementedReplayExecutor implements ReplayExecutor {
  async replay(_request: ReplayRequest): Promise<ReplayResult> {
    throw new ReplayNotImplementedError();
  }
}
