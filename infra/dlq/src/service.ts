// DLQ service / quarantine API (Epic E5 / EDAM-T038).
//
// The single entry point for pre-CCE stages (CDC collector, future
// Normalization) to record a failure. Guarantees:
//   - NO EVENT LOSS: the item is PERSISTED before alarms; if persistence fails,
//     record() rejects (the caller must not drop — never fabricate success).
//   - NO DUPLICATES / NO UNBOUNDED GROWTH: deterministic event_id keys the row;
//     re-recording the same poison event increments retry_count in place.
//   - NO INFINITE RETRY: the retry policy quarantines at maxRetries.
//   - UNCERTAIN => QUARANTINE + ALARM.

import { classifyFailure } from './classify.js';
import { decideStatus, DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry.js';
import { payloadHash, deterministicEventId } from './hash.js';
import type { DlqStore } from './store.js';
import type { DlqAlarmSeverity, DlqAlarmSink } from './alarms.js';
import { SYSTEM_CLOCK, type Clock, type DlqItem, type FailureCategory, type FailureContext } from './types.js';

function reasonFrom(ctx: FailureContext): string {
  if (ctx.reason) return ctx.reason;
  if (ctx.error instanceof Error) return ctx.error.message;
  if (typeof ctx.error === 'string') return ctx.error;
  return 'unspecified failure';
}

function enqueueSeverity(category: FailureCategory): DlqAlarmSeverity {
  if (category === 'UNCLASSIFIED' || category === 'OFFSET_CORRUPTION') return 'high';
  return 'medium';
}

export interface DlqServiceDeps {
  store: DlqStore;
  alarms: DlqAlarmSink;
  clock?: Clock;
  policy?: RetryPolicy;
}

export class DlqService {
  private readonly store: DlqStore;
  private readonly alarms: DlqAlarmSink;
  private readonly clock: Clock;
  private readonly policy: RetryPolicy;

  constructor(deps: DlqServiceDeps) {
    this.store = deps.store;
    this.alarms = deps.alarms;
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.policy = deps.policy ?? DEFAULT_RETRY_POLICY;
  }

  async record(ctx: FailureContext): Promise<DlqItem> {
    const now = this.clock.now();
    const { category, retryable } = classifyFailure(ctx);
    const reason = reasonFrom(ctx);
    const pHash = payloadHash(ctx.payload);
    const engine = ctx.engine ?? 'unknown';
    const offset = ctx.offset ?? null;
    const eventId = deterministicEventId(engine, offset, pHash);

    const existing = await this.store.get(eventId);
    const retryCount = existing ? existing.retry_count + 1 : 0;
    const status = decideStatus(category, retryable, retryCount, this.policy);

    const item: DlqItem = {
      event_id: eventId,
      source_engine: engine,
      offset,
      failure_category: category,
      failure_reason: reason,
      captured_at: existing?.captured_at ?? ctx.capturedAt ?? now,
      retry_count: retryCount,
      retryable,
      status,
      original_payload: ctx.payload,
      payload_hash: pHash,
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
    };

    // Persist FIRST — the event is durable before anything else (no loss).
    await this.store.upsert(item);

    if (!existing) {
      this.alarms.raise({
        kind: 'DLQ_ENQUEUE',
        severity: enqueueSeverity(category),
        message: `event routed to DLQ: ${category} — ${reason}`,
        at: now,
        details: { event_id: eventId, category, retryable },
      });
    }
    if (status === 'quarantined' && existing?.status !== 'quarantined') {
      this.alarms.raise({
        kind: 'DLQ_QUARANTINE',
        severity: 'high',
        message: `event quarantined (${category}) after ${retryCount} retr${retryCount === 1 ? 'y' : 'ies'}`,
        at: now,
        details: { event_id: eventId, retry_count: retryCount },
      });
    }

    return item;
  }
}
