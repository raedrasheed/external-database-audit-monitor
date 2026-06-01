// Reconnect with exponential backoff (Epic E2 / EDAM-T015).

import type { AlarmSink } from './alarms.js';
import type { Clock } from './clock.js';

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
}

/** Deterministic exponential backoff (no jitter), capped at maxMs. */
export function nextBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 30000;
  const factor = opts.factor ?? 2;
  const delay = base * Math.pow(factor, Math.max(0, attempt));
  return Math.min(max, Math.round(delay));
}

export interface ReconnectDeps {
  sleep(ms: number): Promise<void>;
  alarms: AlarmSink;
  clock: Clock;
  shouldStop?: () => boolean;
}

/**
 * Run a (possibly long-lived) task; if it throws, raise a RECONNECT alarm,
 * back off, and retry until it returns normally or shouldStop() is true.
 */
export async function runWithReconnect(
  task: () => Promise<void>,
  deps: ReconnectDeps,
  opts: BackoffOptions = {},
): Promise<void> {
  let attempt = 0;
  for (;;) {
    if (deps.shouldStop?.()) return;
    try {
      await task();
      return;
    } catch (err) {
      attempt += 1;
      const wait = nextBackoff(attempt - 1, opts);
      deps.alarms.raise({
        kind: 'RECONNECT',
        severity: attempt >= 5 ? 'high' : 'medium',
        message: `source task failed (attempt ${attempt}); retrying in ${wait}ms`,
        at: deps.clock.now(),
        details: { attempt, waitMs: wait, error: String(err) },
      });
      if (deps.shouldStop?.()) return;
      await deps.sleep(wait);
    }
  }
}
