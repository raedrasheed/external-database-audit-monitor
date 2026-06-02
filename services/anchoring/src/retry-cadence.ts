// Anchor retry / backoff / cadence (Sprint-2 / EDAM-T134).
//
// Idempotent, no-fabrication orchestration ON TOP of the T130 fail-closed guard
// (`requestAnchor`) and the T133 builder (`buildAnchorRecord`). It bounds the
// un-anchored window (WORM §9 common rules, §13, A-EV6, WV-13):
//
//   - Idempotent re-request over the same hash: a head+provider has a
//     DETERMINISTIC anchor_id (UUIDv5), so retries and restarts reuse the same
//     identity; a verified record is built/stored at most once, and re-requests
//     return the stored record instead of re-anchoring (addresses E2D-ANCHOR-AR6).
//   - Exponential backoff over retryable (pending) provider outcomes.
//   - Cadence: anchor every N events or T minutes, whichever first.
//   - Escalating alarm when the max un-anchored window is exceeded.
//
// NO fabrication (INV-EV-6): pending/failed carry NO token and NO record — only a
// VERIFIED `anchored` outcome yields a record. The builder boundary (head ↔
// payload_hash) and the provider hash-only boundary are preserved; signing stays
// in the signing layer (the HSM signature is consumed, never produced here).
//
// Pure + in-memory + clock/sleep-injected: no real timers, no WORM write, no
// state machine. The store interface lets the future lifecycle swap in WORM.

import { createHash } from 'node:crypto';
import { anchorPayloadHash, type AnchorPayload, type SignatureResult } from '@edam/signing';
import { requestAnchor, isAnchored } from './anchor-service.js';
import { buildAnchorRecord, type AnchorRecord } from './anchor-record.js';
import type { AnchorFailureReason, AnchorPendingReason, AnchorProvider, AnchorProviderType, AnchorRequest } from './types.js';

// ---------------------------------------------------------------------------
// Deterministic anchor identity (RFC 4122 UUIDv5) — addresses E2D-ANCHOR-AR6.
// ---------------------------------------------------------------------------

/** Fixed EDAM namespace for anchor identities (a constant UUID). */
const EDAM_ANCHOR_NS = '2f9d6a1e-7c43-5b08-9e21-3a4b5c6d7e8f';

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function uuidv5(name: string, namespace: string): string {
  const hash = createHash('sha1').update(uuidToBytes(namespace)).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/** Deterministic anchor_id for a (head payload hash, provider type) pair. Stable across retries/restarts. */
export function anchorIdFor(payloadHash: string, providerType: AnchorProviderType): string {
  return uuidv5(`${payloadHash}|${providerType}`, EDAM_ANCHOR_NS);
}

// ---------------------------------------------------------------------------
// Injected time / sleep.
// ---------------------------------------------------------------------------

/** Monotonic-ish wall clock in ms since epoch. Injected for determinism. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

// ---------------------------------------------------------------------------
// Retry / backoff policy.
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Total attempts including the first (>= 1). */
  maxAttempts: number;
  /** Backoff base delay (ms). */
  baseDelayMs: number;
  /** Backoff cap (ms). */
  maxDelayMs: number;
  /** Backoff multiplier (default 2). */
  factor?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000, factor: 2 };

/** Backoff delay BEFORE the attempt after `completedAttempt` (zero-based), capped at maxDelayMs. */
export function nextBackoffMs(completedAttempt: number, policy: RetryPolicy): number {
  const factor = policy.factor ?? 2;
  return Math.min(policy.maxDelayMs, Math.round(policy.baseDelayMs * factor ** completedAttempt));
}

// ---------------------------------------------------------------------------
// Anchor-record store (dedup boundary). In-memory default; WORM later.
// ---------------------------------------------------------------------------

export interface AnchorRecordStore {
  get(anchorId: string): AnchorRecord | undefined;
  /** Store if absent; return the stored record (the EXISTING one if already present). First write wins. */
  putIfAbsent(record: AnchorRecord): AnchorRecord;
}

export class InMemoryAnchorRecordStore implements AnchorRecordStore {
  readonly #records = new Map<string, AnchorRecord>();

  get(anchorId: string): AnchorRecord | undefined {
    return this.#records.get(anchorId);
  }

  putIfAbsent(record: AnchorRecord): AnchorRecord {
    const existing = this.#records.get(record.anchor_id);
    if (existing !== undefined) return existing;
    this.#records.set(record.anchor_id, record);
    return record;
  }

  get size(): number {
    return this.#records.size;
  }
}

/** Raised when a deterministic anchor_id resolves to a record bound to a DIFFERENT head (collision). */
export class AnchorIdCollisionError extends Error {
  constructor(anchorId: string, storedHeadHash: string, requestedHeadHash: string) {
    super(`anchor-coordinator: anchor_id ${anchorId} already bound to head ${storedHeadHash}, refusing request for head ${requestedHeadHash}`);
    this.name = 'AnchorIdCollisionError';
  }
}

// ---------------------------------------------------------------------------
// Coordinator: idempotent anchor-with-retry.
// ---------------------------------------------------------------------------

export type CoordinatorOutcome =
  | { status: 'anchored'; record: AnchorRecord; anchor_id: string; deduplicated: boolean }
  | { status: 'pending'; reason: AnchorPendingReason; attempts: number }
  | { status: 'failed'; reason: AnchorFailureReason };

export interface AnchorHeadInput {
  /** The sealed chain head as a signed anchor payload. */
  head: AnchorPayload;
  /** The HSM signature over the head's anchor payload (from the signing layer). */
  hsmSignature: SignatureResult;
  /** Optional hsm_signature.revoked_at to record. */
  signatureRevokedAt?: string | null;
}

export interface AnchorCoordinatorOptions {
  store?: AnchorRecordStore;
  retry?: RetryPolicy;
  clock?: Clock;
  sleep?: SleepFn;
  /** Per-attempt provider timeout (ms), passed to requestAnchor. */
  timeoutMs?: number;
}

/**
 * Coordinates idempotent, backed-off, no-fabrication anchoring for a head over a
 * single provider. A head+provider anchors at most once; re-requests return the
 * stored verified record. Pending/failed outcomes never carry a record.
 */
export class AnchorCoordinator {
  readonly #store: AnchorRecordStore;
  readonly #retry: RetryPolicy;
  readonly #clock: Clock;
  readonly #sleep: SleepFn;
  readonly #timeoutMs: number | undefined;
  readonly #inflight = new Map<string, Promise<CoordinatorOutcome>>();

  constructor(opts: AnchorCoordinatorOptions = {}) {
    this.#store = opts.store ?? new InMemoryAnchorRecordStore();
    this.#retry = opts.retry ?? DEFAULT_RETRY_POLICY;
    if (!Number.isInteger(this.#retry.maxAttempts) || this.#retry.maxAttempts < 1) {
      throw new Error('AnchorCoordinator: retry.maxAttempts must be an integer >= 1');
    }
    this.#clock = opts.clock ?? systemClock;
    this.#sleep = opts.sleep ?? realSleep;
    this.#timeoutMs = opts.timeoutMs;
  }

  /** Anchor a head over a provider, idempotently and with backoff. Never fabricates a token. */
  async anchorHead(provider: AnchorProvider, input: AnchorHeadInput): Promise<CoordinatorOutcome> {
    const payloadHash = anchorPayloadHash(input.head); // also validates the head (T121)
    const anchorId = anchorIdFor(payloadHash, provider.provider_type);

    // Coalesce concurrent attempts for the same identity ⇒ one provider call.
    const inflight = this.#inflight.get(anchorId);
    if (inflight !== undefined) return inflight;

    const run = this.#run(provider, input, payloadHash, anchorId);
    this.#inflight.set(anchorId, run);
    try {
      return await run;
    } finally {
      this.#inflight.delete(anchorId);
    }
  }

  async #run(provider: AnchorProvider, input: AnchorHeadInput, payloadHash: string, anchorId: string): Promise<CoordinatorOutcome> {
    // Idempotency: a verified record already exists ⇒ return it, do NOT re-anchor.
    const existing = this.#store.get(anchorId);
    if (existing !== undefined) {
      this.#assertSameHead(existing, payloadHash);
      return { status: 'anchored', record: existing, anchor_id: anchorId, deduplicated: true };
    }

    const request: AnchorRequest = { payload_hash: payloadHash };
    let lastPending: AnchorPendingReason = 'provider_error';

    for (let attempt = 0; attempt < this.#retry.maxAttempts; attempt++) {
      const outcome = await requestAnchor(provider, request, this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {});

      if (isAnchored(outcome)) {
        const createdAt = new Date(this.#clock.now()).toISOString(); // captured once
        const record = buildAnchorRecord({
          head: input.head,
          hsmSignature: input.hsmSignature,
          anchorOutcome: outcome,
          anchorId,
          createdAt,
          signatureRevokedAt: input.signatureRevokedAt,
        });
        const stored = this.#store.putIfAbsent(record);
        this.#assertSameHead(stored, payloadHash);
        return { status: 'anchored', record: stored, anchor_id: anchorId, deduplicated: stored !== record };
      }

      if (outcome.status === 'failed') return { status: 'failed', reason: outcome.reason }; // terminal, no retry

      // pending ⇒ retryable (outage / timeout / error).
      lastPending = outcome.reason;
      if (attempt < this.#retry.maxAttempts - 1) await this.#sleep(nextBackoffMs(attempt, this.#retry));
    }

    return { status: 'pending', reason: lastPending, attempts: this.#retry.maxAttempts };
  }

  #assertSameHead(record: AnchorRecord, payloadHash: string): void {
    const recordHash = anchorPayloadHash({ db_id: record.db_id, ...record.head });
    if (recordHash !== payloadHash) throw new AnchorIdCollisionError(record.anchor_id, recordHash, payloadHash);
  }
}

// ---------------------------------------------------------------------------
// Cadence policy: every N events or T minutes, whichever first (WORM §9).
// ---------------------------------------------------------------------------

export interface CadenceConfig {
  /** Trigger after this many accumulated events. */
  maxEvents: number;
  /** Trigger after this much elapsed time (ms) since the last anchor. */
  maxIntervalMs: number;
}

export class CadencePolicy {
  readonly #maxEvents: number;
  readonly #maxIntervalMs: number;
  readonly #clock: Clock;
  #events = 0;
  #lastAnchorAt: number;

  constructor(config: CadenceConfig, opts: { clock?: Clock; startAt?: number } = {}) {
    if (!Number.isInteger(config.maxEvents) || config.maxEvents < 1) throw new Error('CadencePolicy: maxEvents must be an integer >= 1');
    if (!(config.maxIntervalMs > 0)) throw new Error('CadencePolicy: maxIntervalMs must be > 0');
    this.#maxEvents = config.maxEvents;
    this.#maxIntervalMs = config.maxIntervalMs;
    this.#clock = opts.clock ?? systemClock;
    this.#lastAnchorAt = opts.startAt ?? this.#clock.now();
  }

  /** Accumulate sealed-head events toward the cadence trigger. */
  recordEvents(count = 1): void {
    if (!Number.isInteger(count) || count < 0) throw new Error('CadencePolicy: count must be a non-negative integer');
    this.#events += count;
  }

  get pendingEvents(): number {
    return this.#events;
  }

  /** Why anchoring is due now, or undefined if not due (events first, then interval). */
  dueReason(now: number = this.#clock.now()): 'events' | 'interval' | undefined {
    if (this.#events >= this.#maxEvents) return 'events';
    if (now - this.#lastAnchorAt >= this.#maxIntervalMs) return 'interval';
    return undefined;
  }

  due(now?: number): boolean {
    return this.dueReason(now) !== undefined;
  }

  /** Reset the cadence window after an anchoring cycle completes. */
  markAnchored(now: number = this.#clock.now()): void {
    this.#events = 0;
    this.#lastAnchorAt = now;
  }
}

// ---------------------------------------------------------------------------
// Un-anchored window monitor: escalating alarm on window breach (WORM §13).
// ---------------------------------------------------------------------------

export type AlarmSeverity = 'none' | 'warning' | 'critical' | 'emergency';

export interface WindowAlarm {
  breached: boolean;
  severity: AlarmSeverity;
  ageMs: number;
  oldestUnanchoredAt?: number;
  pendingCount: number;
}

export interface WindowMonitorOptions {
  /** Max tolerated un-anchored window (ms). Exceeding it breaches and alarms. */
  maxWindowMs: number;
  clock?: Clock;
  /** Invoked whenever `check` observes a breach. */
  onAlarm?: (alarm: WindowAlarm) => void;
}

/**
 * Tracks the oldest un-anchored head and raises an ESCALATING alarm when the
 * un-anchored window is exceeded. Severity escalates with breach duration:
 * warning (>1x) → critical (>2x) → emergency (>4x maxWindow).
 */
export class UnanchoredWindowMonitor {
  readonly #maxWindowMs: number;
  readonly #clock: Clock;
  readonly #onAlarm: ((alarm: WindowAlarm) => void) | undefined;
  readonly #pending = new Map<string, number>(); // headId -> sealedAt (ms)

  constructor(opts: WindowMonitorOptions) {
    if (!(opts.maxWindowMs > 0)) throw new Error('UnanchoredWindowMonitor: maxWindowMs must be > 0');
    this.#maxWindowMs = opts.maxWindowMs;
    this.#clock = opts.clock ?? systemClock;
    this.#onAlarm = opts.onAlarm;
  }

  /** Record that a head is un-anchored (sealed/pending). Oldest sealedAt wins for a given head. */
  observePending(headId: string, sealedAt: number = this.#clock.now()): void {
    const prev = this.#pending.get(headId);
    if (prev === undefined || sealedAt < prev) this.#pending.set(headId, sealedAt);
  }

  /** Record that a head is now anchored; it leaves the un-anchored window. */
  observeAnchored(headId: string): void {
    this.#pending.delete(headId);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  oldestUnanchoredAt(): number | undefined {
    let oldest: number | undefined;
    for (const at of this.#pending.values()) if (oldest === undefined || at < oldest) oldest = at;
    return oldest;
  }

  #severityFor(ageMs: number): AlarmSeverity {
    if (ageMs <= this.#maxWindowMs) return 'none';
    if (ageMs <= 2 * this.#maxWindowMs) return 'warning';
    if (ageMs <= 4 * this.#maxWindowMs) return 'critical';
    return 'emergency';
  }

  /** Evaluate the un-anchored window now; emit (and return) an escalating alarm on breach. */
  check(now: number = this.#clock.now()): WindowAlarm {
    const oldest = this.oldestUnanchoredAt();
    if (oldest === undefined) return { breached: false, severity: 'none', ageMs: 0, pendingCount: 0 };
    const ageMs = now - oldest;
    const severity = this.#severityFor(ageMs);
    const alarm: WindowAlarm = { breached: severity !== 'none', severity, ageMs, oldestUnanchoredAt: oldest, pendingCount: this.#pending.size };
    if (alarm.breached) this.#onAlarm?.(alarm);
    return alarm;
  }
}
