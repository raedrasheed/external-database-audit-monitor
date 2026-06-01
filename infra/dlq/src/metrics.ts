// DLQ failure metrics + depth alarm (Epic E5 / EDAM-T040).

import type { DlqStore } from './store.js';
import type { DlqAlarmSink } from './alarms.js';
import type { DlqStatus, FailureCategory } from './types.js';

const CATEGORIES: FailureCategory[] = [
  'MALFORMED_CDC_EVENT',
  'UNSUPPORTED_ENGINE',
  'SCHEMA_VALIDATION_FAILURE',
  'OFFSET_CORRUPTION',
  'SERIALIZATION_FAILURE',
  'UNEXPECTED_EXCEPTION',
  'UNCLASSIFIED',
];

export interface DlqMetricsSnapshot {
  /** Distinct events currently in the DLQ (append-only; never decreases here). */
  depth: number;
  quarantined: number;
  retryable: number;
  /** Total failure occurrences across all events (sum of retry_count + 1). */
  totalOccurrences: number;
  byCategory: Record<FailureCategory, number>;
  byStatus: Record<DlqStatus, number>;
}

export async function collectMetrics(store: DlqStore): Promise<DlqMetricsSnapshot> {
  const items = await store.list();
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<FailureCategory, number>;
  const byStatus: Record<DlqStatus, number> = { retryable: 0, quarantined: 0 };
  let totalOccurrences = 0;
  for (const i of items) {
    byCategory[i.failure_category] += 1;
    byStatus[i.status] += 1;
    totalOccurrences += i.retry_count + 1;
  }
  return {
    depth: items.length,
    quarantined: byStatus.quarantined,
    retryable: byStatus.retryable,
    totalOccurrences,
    byCategory,
    byStatus,
  };
}

/**
 * Raises a DLQ_DEPTH alarm when the DLQ depth exceeds a threshold. With the
 * default threshold of 0, any item in the DLQ is a visible operational signal
 * (a non-empty DLQ implies un-processed events).
 */
export class DlqDepthMonitor {
  constructor(
    private readonly threshold: number,
    private readonly alarms: DlqAlarmSink,
  ) {}

  check(snapshot: DlqMetricsSnapshot, atIso: string): boolean {
    if (snapshot.depth > this.threshold) {
      this.alarms.raise({
        kind: 'DLQ_DEPTH',
        severity: snapshot.quarantined > 0 ? 'high' : 'medium',
        message: `DLQ depth ${snapshot.depth} exceeds threshold ${this.threshold} (quarantined=${snapshot.quarantined})`,
        at: atIso,
        details: { depth: snapshot.depth, quarantined: snapshot.quarantined, threshold: this.threshold },
      });
      return true;
    }
    return false;
  }
}
