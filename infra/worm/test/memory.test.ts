// WORM store fake + role-identity tests (Sprint-2 / EDAM-T103).
// Verifies the AC: interface + in-memory fake; the writer identity exposes no
// delete/overwrite/retention API. Also exercises WORM §4 immutability semantics
// (no overwrite, no shorten, no hold-bypass delete) — WV-8 at the fake level.
import { describe, it, expect } from 'vitest';
import { InMemoryWormStore, WormError, type WormStore } from '../src/index.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const COMPLIANCE = { retentionMode: 'compliance' } as const;

function fresh(): WormStore {
  return new InMemoryWormStore();
}

describe('WORM writer identity (Domain B, append-only)', () => {
  it('can write and the object is readable back', async () => {
    const store = fresh();
    await store.writer().putImmutable('kafel/seg-000000/000000.cce.json', enc('{"x":1}'), COMPLIANCE);
    expect(dec(await store.reader().get('kafel/seg-000000/000000.cce.json'))).toBe('{"x":1}');
  });

  it('exposes NO delete/overwrite/retention/legal-hold API (AC; INV-EV-1)', () => {
    const writer = fresh().writer();
    expect(Object.keys(writer)).toEqual(['putImmutable']);
    for (const forbidden of ['delete', 'deleteExpired', 'remove', 'overwrite', 'extendRetention', 'placeLegalHold', 'liftLegalHold', 'setRetention']) {
      expect(forbidden in writer).toBe(false);
    }
    // Compile-time proof: these members do not exist on the writer type.
    // @ts-expect-error — writer has no deleteExpired
    expect(writer.deleteExpired).toBeUndefined();
    // @ts-expect-error — writer has no extendRetention
    expect(writer.extendRetention).toBeUndefined();
  });

  it('rejects overwrite of an existing key (no mutation; append-only)', async () => {
    const store = fresh();
    await store.writer().putImmutable('k1', enc('v1'), COMPLIANCE);
    await expect(store.writer().putImmutable('k1', enc('v2'), COMPLIANCE)).rejects.toBeInstanceOf(WormError);
    expect(dec(await store.reader().get('k1'))).toBe('v1'); // original intact
  });

  it('stored bytes are immutable to later mutation of the caller buffer', async () => {
    const store = fresh();
    const buf = enc('orig');
    await store.writer().putImmutable('k', buf, COMPLIANCE);
    buf[0] = 0; // mutate caller copy
    expect(dec(await store.reader().get('k'))).toBe('orig');
  });
});

describe('WORM reader identity', () => {
  it('list is deterministic (sorted) and prefix-filtered', async () => {
    const store = fresh();
    const w = store.writer();
    for (const k of ['b/2', 'a/1', 'b/1', 'c/9']) await w.putImmutable(k, enc(k), COMPLIANCE);
    expect(await store.reader().list('b/')).toEqual(['b/1', 'b/2']);
    expect(await store.reader().list('')).toEqual(['a/1', 'b/1', 'b/2', 'c/9']);
  });

  it('get/headObjectLock throw on a missing key', async () => {
    const store = fresh();
    await expect(store.reader().get('nope')).rejects.toBeInstanceOf(WormError);
    await expect(store.reader().headObjectLock('nope')).rejects.toBeInstanceOf(WormError);
  });

  it('headObjectLock reflects compliance mode, retain-until, and legal hold', async () => {
    const store = fresh();
    await store.writer().putImmutable('k', enc('v'), { retentionMode: 'compliance', retainUntil: '2030-01-01T00:00:00.000Z', legalHold: true });
    const lock = await store.reader().headObjectLock('k');
    expect(lock).toEqual({ retentionMode: 'compliance', retainUntil: '2030-01-01T00:00:00.000Z', legalHold: true });
  });
});

describe('WORM retention admin (Domain C, separate identity) — WV-8 semantics', () => {
  it('retention can be extended but never shortened (compliance mode)', async () => {
    const store = fresh();
    await store.writer().putImmutable('k', enc('v'), { retentionMode: 'compliance', retainUntil: '2030-01-01T00:00:00.000Z' });
    const admin = store.retentionAdmin();
    await admin.extendRetention('k', '2031-01-01T00:00:00.000Z'); // ok (forward)
    expect((await store.reader().headObjectLock('k')).retainUntil).toBe('2031-01-01T00:00:00.000Z');
    await expect(admin.extendRetention('k', '2025-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(WormError); // shorten -> denied
  });

  it('cannot set finite retention on an open-ended object (would shorten)', async () => {
    const store = fresh();
    await store.writer().putImmutable('k', enc('v'), COMPLIANCE); // open-ended
    await expect(store.retentionAdmin().extendRetention('k', '2030-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(WormError);
  });

  it('deletion is denied under legal hold (W-3)', async () => {
    const store = fresh();
    await store.writer().putImmutable('k', enc('v'), { retentionMode: 'compliance', retainUntil: '2020-01-01T00:00:00.000Z', legalHold: true });
    await expect(store.retentionAdmin().deleteExpired('k', '2026-06-01T00:00:00.000Z')).rejects.toBeInstanceOf(WormError);
  });

  it('deletion is denied within the retention window (W-7)', async () => {
    const store = fresh();
    await store.writer().putImmutable('k', enc('v'), { retentionMode: 'compliance', retainUntil: '2030-01-01T00:00:00.000Z' });
    await expect(store.retentionAdmin().deleteExpired('k', '2026-06-01T00:00:00.000Z')).rejects.toBeInstanceOf(WormError);
  });

  it('deletion is denied for open-ended (permanent) retention', async () => {
    const store = fresh();
    await store.writer().putImmutable('k', enc('v'), COMPLIANCE);
    await expect(store.retentionAdmin().deleteExpired('k', '2099-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(WormError);
  });

  it('lawful deletion succeeds only after expiry with no hold', async () => {
    const store = fresh();
    await store.writer().putImmutable('k', enc('v'), { retentionMode: 'compliance', retainUntil: '2026-01-01T00:00:00.000Z' });
    await store.retentionAdmin().deleteExpired('k', '2026-06-01T00:00:00.000Z'); // expired, no hold -> ok
    await expect(store.reader().get('k')).rejects.toBeInstanceOf(WormError);
  });

  it('placing/lifting a legal hold gates deletion', async () => {
    const store = fresh();
    const admin = store.retentionAdmin();
    await store.writer().putImmutable('k', enc('v'), { retentionMode: 'compliance', retainUntil: '2026-01-01T00:00:00.000Z' });
    await admin.placeLegalHold('k');
    await expect(admin.deleteExpired('k', '2026-06-01T00:00:00.000Z')).rejects.toBeInstanceOf(WormError);
    await admin.liftLegalHold('k');
    await admin.deleteExpired('k', '2026-06-01T00:00:00.000Z'); // now allowed
    await expect(store.reader().get('k')).rejects.toBeInstanceOf(WormError);
  });
});
