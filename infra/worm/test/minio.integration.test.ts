// MinIO Object-Lock adapter integration test (Sprint-2 / EDAM-T104).
//
// SKIPPED unless WORM_MINIO_ENDPOINT is set, so the default `npm test` / build-test
// gate never requires MinIO (Sprint-1 gates are not weakened). The Sprint-2
// live-stack run sets the env vars and exercises this against a real MinIO.
//
//   WORM_MINIO_ENDPOINT=127.0.0.1 WORM_MINIO_PORT=9000 \
//   WORM_MINIO_ACCESS_KEY=minioadmin WORM_MINIO_SECRET_KEY=minioadmin \
//   npx vitest run infra/worm/test/minio.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createMinioWormStore, WormError, type MinioWormStore } from '../src/index.js';

const ENDPOINT = process.env.WORM_MINIO_ENDPOINT;
const run = ENDPOINT ? describe : describe.skip;

// --- H1 per-role credential config (UNIT — no MinIO required; the minio Client
//     constructor is lazy/does not connect). ---
describe('MinioWormStore per-role credential config (H1, unit)', () => {
  const base = { endPoint: '127.0.0.1', port: 9000, useSSL: false, bucket: 'edam-x' };
  const cred = (k: string) => ({ accessKey: k, secretKey: `${k}-secret` });

  it('single-credential mode is dev-only: role separation NOT enforced', () => {
    const s = createMinioWormStore({ ...base, accessKey: 'minioadmin', secretKey: 'minioadmin' });
    expect(s.roleSeparationEnforced).toBe(false);
  });

  it('per-role credentials enforce role separation', () => {
    const s = createMinioWormStore({ ...base, credentials: { writer: cred('w'), reader: cred('r'), retentionAdmin: cred('a') } });
    expect(s.roleSeparationEnforced).toBe(true);
  });

  it('fail-closed: a missing role credential is rejected', () => {
    expect(() =>
      createMinioWormStore({ ...base, credentials: { writer: cred('w'), reader: cred('r'), retentionAdmin: { accessKey: '', secretKey: '' } } }),
    ).toThrow(WormError);
  });

  it('fail-closed: neither per-role credentials nor accessKey/secretKey is rejected', () => {
    expect(() => createMinioWormStore({ ...base })).toThrow(WormError);
  });
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
/** A retain-until far in the future, so the object is locked for the whole test. */
const FUTURE = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
const LATER = new Date(Date.now() + 1000 * 60 * 60 * 24 * 730).toISOString();
const EARLIER = new Date(Date.now() + 1000 * 60 * 60).toISOString();

run('MinIO Object-Lock WORM adapter (live)', () => {
  let store: MinioWormStore;
  let rawClient: import('minio').Client;
  const bucket = `edam-worm-it-${Date.now().toString(36)}`;

  beforeAll(async () => {
    const port = process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000;
    const useSSL = process.env.WORM_MINIO_SSL === 'true';
    const accessKey = process.env.WORM_MINIO_ACCESS_KEY ?? 'minioadmin';
    const secretKey = process.env.WORM_MINIO_SECRET_KEY ?? 'minioadmin';
    store = createMinioWormStore({ endPoint: ENDPOINT!, port, useSSL, accessKey, secretKey, bucket });
    rawClient = new (await import('minio')).Client({ endPoint: ENDPOINT!, port, useSSL, accessKey, secretKey });
    await store.ensureBucket();
  }, 60_000);

  it('versioning is enabled (W-4)', async () => {
    expect(await store.versioningEnabled()).toBe(true);
  });

  it('Object Lock is asserted Enabled (W-1/H3)', async () => {
    expect(await store.objectLockEnabled()).toBe(true);
  });

  it('refuses to operate on a non-lock bucket — fail-fast (H3)', async () => {
    // A bucket created WITHOUT Object Lock (lock cannot be enabled post-creation).
    const nonLockBucket = `edam-worm-nolock-${Date.now().toString(36)}`;
    const raw = new (await import('minio')).Client({
      endPoint: ENDPOINT!,
      port: process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000,
      useSSL: process.env.WORM_MINIO_SSL === 'true',
      accessKey: process.env.WORM_MINIO_ACCESS_KEY ?? 'minioadmin',
      secretKey: process.env.WORM_MINIO_SECRET_KEY ?? 'minioadmin',
    });
    await raw.makeBucket(nonLockBucket, 'us-east-1'); // no ObjectLocking
    const nonLockStore = createMinioWormStore({
      endPoint: ENDPOINT!,
      port: process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000,
      useSSL: process.env.WORM_MINIO_SSL === 'true',
      accessKey: process.env.WORM_MINIO_ACCESS_KEY ?? 'minioadmin',
      secretKey: process.env.WORM_MINIO_SECRET_KEY ?? 'minioadmin',
      bucket: nonLockBucket,
    });
    await expect(nonLockStore.ensureBucket()).rejects.toBeInstanceOf(WormError);
    expect(await nonLockStore.objectLockEnabled()).toBe(false);
  });

  it('writes and reads an object back', async () => {
    await store.writer().putImmutable('seg/0.json', enc('{"x":1}'), { retentionMode: 'compliance', retainUntil: FUTURE });
    expect(dec(await store.reader().get('seg/0.json'))).toBe('{"x":1}');
  });

  it('writer cannot overwrite an existing object', async () => {
    await expect(
      store.writer().putImmutable('seg/0.json', enc('{"x":2}'), { retentionMode: 'compliance', retainUntil: FUTURE }),
    ).rejects.toBeInstanceOf(WormError);
    expect(dec(await store.reader().get('seg/0.json'))).toBe('{"x":1}'); // original intact
  });

  it('writer identity exposes no delete/retention API', () => {
    const writer = store.writer();
    expect(Object.keys(writer)).toEqual(['putImmutable']);
    for (const f of ['deleteExpired', 'extendRetention', 'placeLegalHold', 'liftLegalHold']) {
      expect(f in writer).toBe(false);
    }
  });

  it('compliance retention blocks deletion within the window (W-7)', async () => {
    await expect(store.retentionAdmin().deleteExpired('seg/0.json', new Date().toISOString())).rejects.toBeInstanceOf(WormError);
    expect(dec(await store.reader().get('seg/0.json'))).toBe('{"x":1}'); // still there
  });

  it('retention can be extended but not shortened (compliance mode)', async () => {
    await store.retentionAdmin().extendRetention('seg/0.json', LATER); // forward -> ok
    expect((await store.reader().headObjectLock('seg/0.json')).retainUntil).not.toBeNull();
    await expect(store.retentionAdmin().extendRetention('seg/0.json', EARLIER)).rejects.toBeTruthy(); // shorten denied
  });

  it('legal hold blocks deletion (W-3)', async () => {
    await store.writer().putImmutable('seg/hold.json', enc('held'), { retentionMode: 'compliance', retainUntil: FUTURE, legalHold: true });
    const lock = await store.reader().headObjectLock('seg/hold.json');
    expect(lock.legalHold).toBe(true);
    await expect(store.retentionAdmin().deleteExpired('seg/hold.json', new Date().toISOString())).rejects.toBeInstanceOf(WormError);
  });

  it('list is deterministic (sorted) and prefix-filtered', async () => {
    expect(await store.reader().list('seg/')).toEqual(['seg/0.json', 'seg/hold.json']);
  });

  it('separate identities remain distinct objects (W-8)', () => {
    expect(store.writer()).not.toBe(store.reader());
    expect('get' in store.writer()).toBe(false);
    expect('putImmutable' in store.reader()).toBe(false);
  });

  it('deleteExpired is VERSION-SCOPED and leaves no delete marker (H2)', async () => {
    // A retained object whose COMPLIANCE retention EXPIRES shortly (lawful expiry).
    const shortRetain = new Date(Date.now() + 2_000).toISOString();
    await store.writer().putImmutable('h2/expiring.json', enc('{"u":1}'), { retentionMode: 'compliance', retainUntil: shortRetain });
    await new Promise((r) => setTimeout(r, 3_000)); // let the retention window pass

    // Capture the actual removeObject call args to prove a versionId is passed.
    const calls: Array<{ key: string; opts: unknown }> = [];
    const raw = (store as unknown as { retentionAdminClient: { removeObject: (b: string, k: string, o?: unknown) => Promise<void> } }).retentionAdminClient;
    const orig = raw.removeObject.bind(raw);
    raw.removeObject = async (b: string, k: string, o?: unknown) => { calls.push({ key: k, opts: o }); return orig(b, k, o); };
    try {
      await store.retentionAdmin().deleteExpired('h2/expiring.json', new Date().toISOString());
    } finally {
      raw.removeObject = orig;
    }
    // (A) delete targeted an explicit versionId, not the bare key alone.
    expect(calls).toHaveLength(1);
    expect((calls[0]!.opts as { versionId?: string })?.versionId).toBeTruthy();
    // (B) no hide marker: the object is genuinely gone (not hidden by a delete marker).
    await expect(store.reader().get('h2/expiring.json')).rejects.toBeInstanceOf(WormError);
    expect(await store.reader().list('h2/expiring.json')).toEqual([]);
  }, 15_000);

  it('deleteExpired denies a still-retained object; object remains visible (H2 compat W-7)', async () => {
    await store.writer().putImmutable('h2/locked.json', enc('{"l":1}'), { retentionMode: 'compliance', retainUntil: FUTURE });
    await expect(store.retentionAdmin().deleteExpired('h2/locked.json', new Date().toISOString())).rejects.toBeInstanceOf(WormError);
    expect(dec(await store.reader().get('h2/locked.json'))).toBe('{"l":1}'); // still visible, not hidden
  });

  it('store is authoritative: a raw version-scoped delete of a locked version is rejected (H2)', async () => {
    // Bypass the adapter pre-check entirely: hit the raw client with a version-scoped
    // delete on a still-locked version — MinIO COMPLIANCE must reject it (store, not app).
    const stat = await rawClient.statObject(bucket, 'h2/locked.json');
    let storeRejected = false;
    try { await rawClient.removeObject(bucket, 'h2/locked.json', { versionId: stat.versionId! }); }
    catch { storeRejected = true; }
    expect(storeRejected).toBe(true);
    expect(dec(await store.reader().get('h2/locked.json'))).toBe('{"l":1}'); // version intact + visible
  });

  it('per-role credential mode routes each role through its own client (H1)', async () => {
    // Per-role mode against the live bucket. Distinct creds (3 MinIO users) are
    // provisioned out-of-band for the SoD/H5 proofs; here we prove the 3-client
    // architecture functions end-to-end (writer writes, reader reads, retention-
    // admin extends retention) — each via its own physical client.
    const c = (k?: string, s?: string) => ({ accessKey: k ?? 'minioadmin', secretKey: s ?? 'minioadmin' });
    const roleStore = createMinioWormStore({
      endPoint: ENDPOINT!,
      port: process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000,
      useSSL: process.env.WORM_MINIO_SSL === 'true',
      bucket,
      credentials: {
        writer: c(process.env.WORM_MINIO_WRITER_KEY, process.env.WORM_MINIO_WRITER_SECRET),
        reader: c(process.env.WORM_MINIO_READER_KEY, process.env.WORM_MINIO_READER_SECRET),
        retentionAdmin: c(process.env.WORM_MINIO_ADMIN_KEY, process.env.WORM_MINIO_ADMIN_SECRET),
      },
    });
    expect(roleStore.roleSeparationEnforced).toBe(true);
    await roleStore.writer().putImmutable('role/0.json', enc('{"role":1}'), { retentionMode: 'compliance', retainUntil: FUTURE });
    expect(dec(await roleStore.reader().get('role/0.json'))).toBe('{"role":1}');
    await roleStore.retentionAdmin().extendRetention('role/0.json', LATER); // retention-admin op via its own client
  });
});
