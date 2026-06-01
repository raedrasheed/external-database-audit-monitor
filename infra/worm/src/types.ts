// WORM store abstraction — types + role-scoped identities (Sprint-2 / EDAM-T103).
//
// Implements the WORM §4 storage requirements as code-level separation of duties
// (W-8) so the guarantees are enforced at the TYPE level, not by convention:
//   - WormWriter (Domain B): append-only `putImmutable` ONLY. It has no delete,
//     overwrite, retention, or legal-hold method — INV-EV-1 (the writer cannot
//     mutate WORM) is unrepresentable, not merely forbidden.
//   - WormReader: read/list/inspect-lock only.
//   - WormRetentionAdmin (Domain C): retention/legal-hold/lawful-deletion. A
//     SEPARATE identity, never held by the writer.
// A WormStore mints each role-scoped handle; no single handle holds two roles.
// Concrete backends (the in-memory fake here; the MinIO Object-Lock adapter in
// EDAM-T104) enforce the same immutability semantics on the data plane.

export type WormObjectKey = string;
export type WormBytes = Uint8Array;

/**
 * WORM retention is ALWAYS compliance-mode (W-2). Governance mode is
 * intentionally NOT offered: retention can never be weakened to a state an
 * admin (or root) could shorten or delete inside the window.
 */
export type RetentionMode = 'compliance';

export interface PutOptions {
  /** Always 'compliance' (W-2). Typed as the literal so governance is unrepresentable. */
  readonly retentionMode: RetentionMode;
  /** RFC3339 instant until which the object may not be deleted; omit for open-ended (permanent). */
  readonly retainUntil?: string;
  /** Apply a legal hold at write time (W-3). */
  readonly legalHold?: boolean;
}

export interface ObjectLock {
  readonly retentionMode: RetentionMode;
  /** null = open-ended/permanent (strongest — never expires). */
  readonly retainUntil: string | null;
  readonly legalHold: boolean;
}

/** Raised on any WORM-policy violation (overwrite, missing object, retention shortening, hold-blocked delete). */
export class WormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WormError';
  }
}

/**
 * Domain B — append-only writer. Deliberately exposes ONLY `putImmutable`:
 * there is no delete/overwrite/retention/legal-hold method on this type.
 */
export interface WormWriter {
  /** Write an object once. MUST reject if the key already exists (no overwrite). */
  putImmutable(key: WormObjectKey, bytes: WormBytes, opts: PutOptions): Promise<void>;
}

/** Read-only / exporter identity (chain-of-custody gated in production). */
export interface WormReader {
  get(key: WormObjectKey): Promise<WormBytes>;
  /** Keys under `prefix`, in deterministic (sorted) order. */
  list(prefix: string): Promise<WormObjectKey[]>;
  headObjectLock(key: WormObjectKey): Promise<ObjectLock>;
}

/**
 * Domain C — retention/legal-hold custodian + lawful deletion. A separate
 * identity (dual-control in production); never the writer. Retention can only be
 * extended (forward-only); deletion is permitted only after retention expiry
 * with no legal hold.
 */
export interface WormRetentionAdmin {
  /** Extend (never shorten) the retain-until instant (compliance mode). */
  extendRetention(key: WormObjectKey, retainUntil: string): Promise<void>;
  placeLegalHold(key: WormObjectKey): Promise<void>;
  liftLegalHold(key: WormObjectKey): Promise<void>;
  /** Lawful deletion: only if `now` is past retain-until AND no legal hold (W-3/W-7). */
  deleteExpired(key: WormObjectKey, now: string): Promise<void>;
}

/**
 * A WORM store mints role-scoped identities (W-8). The conceptual data plane
 * (putImmutable / get / list / headObjectLock + retention admin) is partitioned
 * across these handles so no caller can both produce evidence and mutate it.
 */
export interface WormStore {
  /** Domain B append-only writer handle. */
  writer(): WormWriter;
  /** Reader/exporter handle. */
  reader(): WormReader;
  /** Domain C retention/hold/lawful-deletion handle. */
  retentionAdmin(): WormRetentionAdmin;
}
