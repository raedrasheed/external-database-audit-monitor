// DLQ types (Epic E5 / EDAM-T037).
//
// The DLQ captures pre-CCE processing failures so that NO EVENT EVER DISAPPEARS
// SILENTLY. Every failed event becomes a durable, deterministically-identified
// DLQ item. INV-2: failures are recorded honestly; success is never fabricated.

export type FailureCategory =
  | 'MALFORMED_CDC_EVENT'
  | 'UNSUPPORTED_ENGINE'
  | 'SCHEMA_VALIDATION_FAILURE'
  | 'OFFSET_CORRUPTION'
  | 'SERIALIZATION_FAILURE'
  | 'UNEXPECTED_EXCEPTION'
  /** Uncertain classification — routed to quarantine + alarmed. */
  | 'UNCLASSIFIED';

export type DlqStatus = 'retryable' | 'quarantined';

/** A durable DLQ record. Stored append-only (no deletion); keyed by event_id. */
export interface DlqItem {
  /** Deterministic id derived from (engine, offset, payload_hash). */
  event_id: string;
  source_engine: string;
  /** Offset / GTID key, or null when it could not be determined. */
  offset: string | null;
  failure_category: FailureCategory;
  failure_reason: string;
  captured_at: string;
  retry_count: number;
  retryable: boolean;
  status: DlqStatus;
  /** The original payload, preserved losslessly. */
  original_payload: unknown;
  /** Deterministic sha256:<hex> of the original payload. */
  payload_hash: string;
  first_seen: string;
  last_seen: string;
}

/** Input to the DLQ when a pre-CCE stage fails to process an event. */
export interface FailureContext {
  engine?: string;
  offset?: string | null;
  payload: unknown;
  /** The thrown error, if any (used to infer the category). */
  error?: unknown;
  /** Explicit category override; otherwise inferred. */
  category?: FailureCategory;
  /** Explicit retryability override (e.g. a known-transient infra error). */
  retryable?: boolean;
  /** Human-readable reason override. */
  reason?: string;
  /** When the failure first occurred (defaults to the service clock). */
  capturedAt?: string;
}

/** Minimal clock (the DLQ package stays self-contained). */
export interface Clock {
  now(): string;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date().toISOString() };
