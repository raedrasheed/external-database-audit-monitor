// Clock abstraction (Epic E2). Injectable so time-based logic is testable.

export interface Clock {
  /** RFC 3339 timestamp string. */
  now(): string;
  /** Epoch milliseconds. */
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  constructor(private ms = 0) {}
  set(ms: number): void {
    this.ms = ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  now(): string {
    return new Date(this.ms).toISOString();
  }
  nowMs(): number {
    return this.ms;
  }
}
