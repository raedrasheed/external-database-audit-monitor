// Retry policy + status decision (Epic E5 / EDAM-T038).
//
// Guarantees no infinite retry loop: a retryable event becomes 'quarantined'
// (poison) once retry_count reaches maxRetries. Non-retryable and uncertain
// failures go straight to quarantine.

import type { DlqStatus, FailureCategory } from './types.js';

export interface RetryPolicy {
  maxRetries: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 5 };

export function decideStatus(
  category: FailureCategory,
  retryable: boolean,
  retryCount: number,
  policy: RetryPolicy,
): DlqStatus {
  if (category === 'UNCLASSIFIED') return 'quarantined'; // uncertain -> quarantine
  if (!retryable) return 'quarantined'; // non-retryable data defect
  if (retryCount >= policy.maxRetries) return 'quarantined'; // poison-event: stop retrying
  return 'retryable';
}
