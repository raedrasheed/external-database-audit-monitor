// In-memory WORM store fake (Sprint-2 / EDAM-T103).
//
// A deterministic, dependency-free WormStore for unit/integration tests. It
// enforces the same immutability semantics a compliance-mode Object-Lock backend
// must (the real MinIO adapter is EDAM-T104):
//   - putImmutable rejects an existing key (no overwrite);
//   - retention can only be extended, never shortened (compliance mode);
//   - deletion is allowed only after retain-until passes AND no legal hold.
// No ambient clock: deleteExpired takes `now` from the caller (DI / determinism).

import {
  WormError,
  type ObjectLock,
  type PutOptions,
  type WormBytes,
  type WormObjectKey,
  type WormReader,
  type WormRetentionAdmin,
  type WormStore,
  type WormWriter,
} from './types.js';

interface StoredObject {
  bytes: WormBytes;
  lock: ObjectLock;
}

function ms(instant: string): number {
  const t = Date.parse(instant);
  if (Number.isNaN(t)) throw new WormError(`invalid RFC3339 instant: ${instant}`);
  return t;
}

export class InMemoryWormStore implements WormStore {
  private readonly objects = new Map<WormObjectKey, StoredObject>();

  // --- data plane (private; exposed only through role-scoped handles) ---

  // Methods are async so any policy violation surfaces as a REJECTED promise
  // (never a synchronous throw), matching the contract of a real I/O backend.
  private async putImmutable(key: WormObjectKey, bytes: WormBytes, opts: PutOptions): Promise<void> {
    if (this.objects.has(key)) {
      throw new WormError(`object already exists at "${key}"; WORM is append-only (no overwrite)`);
    }
    this.objects.set(key, {
      bytes: Uint8Array.from(bytes), // defensive copy: stored bytes are immutable
      lock: {
        retentionMode: opts.retentionMode,
        retainUntil: opts.retainUntil ?? null,
        legalHold: opts.legalHold ?? false,
      },
    });
  }

  private require(key: WormObjectKey): StoredObject {
    const obj = this.objects.get(key);
    if (!obj) throw new WormError(`no object at "${key}"`);
    return obj;
  }

  private async get(key: WormObjectKey): Promise<WormBytes> {
    return Uint8Array.from(this.require(key).bytes); // copy out
  }

  private async list(prefix: string): Promise<WormObjectKey[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  private async headObjectLock(key: WormObjectKey): Promise<ObjectLock> {
    return { ...this.require(key).lock };
  }

  private async extendRetention(key: WormObjectKey, retainUntil: string): Promise<void> {
    const obj = this.require(key);
    const next = ms(retainUntil);
    if (obj.lock.retainUntil === null) {
      throw new WormError(`cannot set a finite retention on an open-ended object at "${key}" (would shorten)`);
    }
    if (next < ms(obj.lock.retainUntil)) {
      throw new WormError(`retention can only be extended, never shortened (compliance mode) at "${key}"`);
    }
    obj.lock = { ...obj.lock, retainUntil };
  }

  private async setLegalHold(key: WormObjectKey, legalHold: boolean): Promise<void> {
    const obj = this.require(key);
    obj.lock = { ...obj.lock, legalHold };
  }

  private async deleteExpired(key: WormObjectKey, now: string): Promise<void> {
    const obj = this.require(key);
    if (obj.lock.legalHold) {
      throw new WormError(`object at "${key}" is under legal hold; deletion denied (W-3)`);
    }
    if (obj.lock.retainUntil === null) {
      throw new WormError(`object at "${key}" has open-ended retention; it never expires`);
    }
    if (ms(now) < ms(obj.lock.retainUntil)) {
      throw new WormError(`object at "${key}" is within its retention window; deletion denied (W-7)`);
    }
    this.objects.delete(key);
  }

  // --- role-scoped identities (W-8) ---

  writer(): WormWriter {
    return {
      putImmutable: (key, bytes, opts) => this.putImmutable(key, bytes, opts),
    };
  }

  reader(): WormReader {
    return {
      get: (key) => this.get(key),
      list: (prefix) => this.list(prefix),
      headObjectLock: (key) => this.headObjectLock(key),
    };
  }

  retentionAdmin(): WormRetentionAdmin {
    return {
      extendRetention: (key, retainUntil) => this.extendRetention(key, retainUntil),
      placeLegalHold: (key) => this.setLegalHold(key, true),
      liftLegalHold: (key) => this.setLegalHold(key, false),
      deleteExpired: (key, now) => this.deleteExpired(key, now),
    };
  }
}
