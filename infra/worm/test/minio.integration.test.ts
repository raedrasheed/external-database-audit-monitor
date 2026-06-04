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
// SoD allow/deny needs the THREE provisioned least-privilege users (minio-init).
// Opt-in via WORM_MINIO_SOD=true so the default live run isn't coupled to it.
const sodRun = ENDPOINT && process.env.WORM_MINIO_SOD === 'true' ? describe : describe.skip;

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

// --- H4 mandatory/default retention config (UNIT — no MinIO; the fail-closed check
//     in putImmutable runs BEFORE any network call). ---
describe('MinioWormStore mandatory retention config (H4, unit)', () => {
  const base = { endPoint: '127.0.0.1', port: 9000, useSSL: false, bucket: 'edam-x', accessKey: 'minioadmin', secretKey: 'minioadmin' };
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('rejects a non-positive / non-integer defaultRetentionDays', () => {
    expect(() => createMinioWormStore({ ...base, defaultRetentionDays: 0 })).toThrow(WormError);
    expect(() => createMinioWormStore({ ...base, defaultRetentionDays: -1 })).toThrow(WormError);
    expect(() => createMinioWormStore({ ...base, defaultRetentionDays: 1.5 })).toThrow(WormError);
  });

  it('fail-closed: write without retainUntil and without defaultRetentionDays is refused (before any network call)', async () => {
    const store = createMinioWormStore({ ...base }); // no defaultRetentionDays
    await expect(store.writer().putImmutable('k.json', enc('{}'), { retentionMode: 'compliance' })).rejects.toBeInstanceOf(WormError);
  });
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
/** Retention instants used by the retention-admin (Domain C) extension tests. */
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
    // B2: the writer relies SOLELY on the bucket default COMPLIANCE retention
    // (born locked). Configure a default so writer puts succeed without retainUntil.
    store = createMinioWormStore({ endPoint: ENDPOINT!, port, useSSL, accessKey, secretKey, bucket, defaultRetentionDays: 1 });
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

  it('writes and reads an object back (born locked by the bucket default, B2)', async () => {
    await store.writer().putImmutable('seg/0.json', enc('{"x":1}'), { retentionMode: 'compliance' });
    expect(dec(await store.reader().get('seg/0.json'))).toBe('{"x":1}');
    // born locked: the bucket default applied COMPLIANCE retention server-side.
    expect((await store.reader().headObjectLock('seg/0.json')).retainUntil).not.toBeNull();
  });

  it('writer cannot overwrite an existing object', async () => {
    await expect(
      store.writer().putImmutable('seg/0.json', enc('{"x":2}'), { retentionMode: 'compliance' }),
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

  it('legal hold blocks deletion (W-3) — placed by Domain C, never the writer (B2)', async () => {
    await store.writer().putImmutable('seg/hold.json', enc('held'), { retentionMode: 'compliance' });
    await store.retentionAdmin().placeLegalHold('seg/hold.json'); // Domain-C op
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
    // B2: the writer can no longer create a short-retained object (retention is the
    // bucket default, ≥1 day). Build the pre-expired locked object via the RAW client
    // in a dedicated no-default object-locked bucket, then exercise the ADAPTER's
    // lawful version-scoped delete path.
    const h2bucket = `edam-worm-h2-${Date.now().toString(36)}`;
    const port = process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000;
    const h2store = createMinioWormStore({
      endPoint: ENDPOINT!, port, useSSL: process.env.WORM_MINIO_SSL === 'true',
      accessKey: process.env.WORM_MINIO_ACCESS_KEY ?? 'minioadmin', secretKey: process.env.WORM_MINIO_SECRET_KEY ?? 'minioadmin',
      bucket: h2bucket, // NO default retention: lets the raw fixture set a short window
    });
    await h2store.ensureBucket();
    const shortRetain = new Date(Date.now() + 2_000).toISOString();
    const buf = Buffer.from(enc('{"u":1}'));
    await rawClient.putObject(h2bucket, 'h2/expiring.json', buf, buf.length);
    const st0 = await rawClient.statObject(h2bucket, 'h2/expiring.json');
    await rawClient.putObjectRetention(h2bucket, 'h2/expiring.json', { mode: 'COMPLIANCE' as never, retainUntilDate: shortRetain, versionId: st0.versionId ?? '' });
    await new Promise((r) => setTimeout(r, 3_000)); // let the retention window pass

    // Capture the actual removeObject call args to prove a versionId is passed.
    const calls: Array<{ key: string; opts: unknown }> = [];
    const raw = (h2store as unknown as { retentionAdminClient: { removeObject: (b: string, k: string, o?: unknown) => Promise<void> } }).retentionAdminClient;
    const orig = raw.removeObject.bind(raw);
    raw.removeObject = async (b: string, k: string, o?: unknown) => { calls.push({ key: k, opts: o }); return orig(b, k, o); };
    try {
      await h2store.retentionAdmin().deleteExpired('h2/expiring.json', new Date().toISOString());
    } finally {
      raw.removeObject = orig;
    }
    // (A) delete targeted an explicit versionId, not the bare key alone.
    expect(calls).toHaveLength(1);
    expect((calls[0]!.opts as { versionId?: string })?.versionId).toBeTruthy();
    // (B) no hide marker: the object is genuinely gone (not hidden by a delete marker).
    await expect(h2store.reader().get('h2/expiring.json')).rejects.toBeInstanceOf(WormError);
    expect(await h2store.reader().list('h2/expiring.json')).toEqual([]);
  }, 15_000);

  it('deleteExpired denies a still-retained object; object remains visible (H2 compat W-7)', async () => {
    await store.writer().putImmutable('h2/locked.json', enc('{"l":1}'), { retentionMode: 'compliance' });
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

  it('mandatory/default retention: a write without retainUntil is born locked; no unlocked object (H4)', async () => {
    // A SEPARATE store/bucket configured with a default retention floor.
    const defBucket = `edam-worm-h4-${Date.now().toString(36)}`;
    const defStore = createMinioWormStore({
      endPoint: ENDPOINT!,
      port: process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000,
      useSSL: process.env.WORM_MINIO_SSL === 'true',
      accessKey: process.env.WORM_MINIO_ACCESS_KEY ?? 'minioadmin',
      secretKey: process.env.WORM_MINIO_SECRET_KEY ?? 'minioadmin',
      bucket: defBucket,
      defaultRetentionDays: 1,
    });
    await defStore.ensureBucket();

    // (default) write WITHOUT retainUntil -> object is born locked by the bucket default.
    await defStore.writer().putImmutable('d/auto.json', enc('{"a":1}'), { retentionMode: 'compliance' });
    const autoLock = await defStore.reader().headObjectLock('d/auto.json');
    expect(autoLock.retainUntil).not.toBeNull(); // headObjectLock reads retention for written objects
    // no unlocked object: raw getObjectRetention confirms COMPLIANCE retention exists at the store.
    const rawRet = (await (rawClient.getObjectRetention(defBucket, 'd/auto.json') as unknown as Promise<{ mode?: string } | null>));
    expect(rawRet?.mode).toBe('COMPLIANCE');

    // (longer retention, B2) the writer writes at the default floor; a LONGER
    // retention is applied AFTER the write by Domain C (retentionAdmin), never the writer.
    await defStore.writer().putImmutable('d/explicit.json', enc('{"e":1}'), { retentionMode: 'compliance' });
    await defStore.retentionAdmin().extendRetention('d/explicit.json', LATER);
    expect((await defStore.reader().headObjectLock('d/explicit.json')).retainUntil).not.toBeNull();

    // (fail-closed) a store WITHOUT a default cannot write unretained.
    const noDef = createMinioWormStore({
      endPoint: ENDPOINT!, port: process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000,
      useSSL: process.env.WORM_MINIO_SSL === 'true',
      accessKey: process.env.WORM_MINIO_ACCESS_KEY ?? 'minioadmin', secretKey: process.env.WORM_MINIO_SECRET_KEY ?? 'minioadmin',
      bucket: defBucket,
    });
    await expect(noDef.writer().putImmutable('d/nope.json', enc('{}'), { retentionMode: 'compliance' })).rejects.toBeInstanceOf(WormError);
  }, 30_000);

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
      defaultRetentionDays: 1, // B2: writer relies on the bucket default retention
      credentials: {
        writer: c(process.env.WORM_MINIO_WRITER_KEY, process.env.WORM_MINIO_WRITER_SECRET),
        reader: c(process.env.WORM_MINIO_READER_KEY, process.env.WORM_MINIO_READER_SECRET),
        retentionAdmin: c(process.env.WORM_MINIO_ADMIN_KEY, process.env.WORM_MINIO_ADMIN_SECRET),
      },
    });
    expect(roleStore.roleSeparationEnforced).toBe(true);
    await roleStore.writer().putImmutable('role/0.json', enc('{"role":1}'), { retentionMode: 'compliance' });
    expect(dec(await roleStore.reader().get('role/0.json'))).toBe('{"role":1}');
    await roleStore.retentionAdmin().extendRetention('role/0.json', LATER); // retention-admin op via its own client
  });
});

// --- EDAM-S3-SoD: separation of duties via least-privilege IAM identities.
//     Requires the three provisioned users (minio-init) on the edam-evidence bucket.
//     WORM_MINIO_SOD=true
//     WORM_MINIO_WRITER_KEY/SECRET, _READER_KEY/SECRET, _ADMIN_KEY/SECRET ---
sodRun('MinIO WORM separation of duties (live IAM)', () => {
  const port = process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000;
  const useSSL = process.env.WORM_MINIO_SSL === 'true';
  const cred = (k?: string, s?: string) => ({ accessKey: k!, secretKey: s! });
  const writer = cred(process.env.WORM_MINIO_SOD_WRITER_KEY, process.env.WORM_MINIO_SOD_WRITER_SECRET);
  const reader = cred(process.env.WORM_MINIO_SOD_READER_KEY, process.env.WORM_MINIO_SOD_READER_SECRET);
  const admin = cred(process.env.WORM_MINIO_SOD_ADMIN_KEY, process.env.WORM_MINIO_SOD_ADMIN_SECRET);
  const bucket = 'edam-evidence';
  // Run-unique key: the bucket is shared + object-locked, so a fixed key would
  // collide (no-overwrite) on a re-run.
  const KEY = `sod/it-${Date.now().toString(36)}.json`;
  let store: MinioWormStore;

  beforeAll(async () => {
    store = createMinioWormStore({ endPoint: ENDPOINT!, port, useSSL, bucket, defaultRetentionDays: 1, credentials: { writer, reader, retentionAdmin: admin } });
    await store.ensureBucket();
  }, 60_000);

  it('three roles are distinct IAM identities', () => {
    const keys = new Set([writer.accessKey, reader.accessKey, admin.accessKey]);
    expect(keys.size).toBe(3);
    expect(store.roleSeparationEnforced).toBe(true);
  });

  it('allow: writer writes, reader reads, retention-admin manages retention/legal-hold', async () => {
    await store.writer().putImmutable(KEY, enc('{"sod":1}'), { retentionMode: 'compliance' });
    expect(dec(await store.reader().get(KEY))).toBe('{"sod":1}');
    expect((await store.reader().headObjectLock(KEY)).retainUntil).not.toBeNull();
    await store.retentionAdmin().placeLegalHold(KEY);
    await store.retentionAdmin().liftLegalHold(KEY);
    await store.retentionAdmin().extendRetention(KEY, new Date(Date.now() + 10 * 86_400_000).toISOString());
  });

  it('B2: the adapter writer path issues ONLY putObject — never the denied retention/hold/delete APIs', async () => {
    // Spy on the writer client (the restricted edam-writer identity). The writer
    // put must touch NONE of putObjectRetention / setObjectLegalHold / removeObject,
    // so it is compatible with the least-privilege writer policy (EDAM-S3-SOD-F1).
    const wc = (store as unknown as { writerClient: Record<string, (...a: unknown[]) => unknown> }).writerClient;
    const denied = ['putObjectRetention', 'setObjectLegalHold', 'removeObject'] as const;
    const attempted: string[] = [];
    const origs: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of denied) {
      origs[m] = wc[m]!.bind(wc);
      wc[m] = (...a: unknown[]) => { attempted.push(m); return origs[m]!(...a); };
    }
    const k2 = `sod/b2-${Date.now().toString(36)}.json`;
    try {
      await store.writer().putImmutable(k2, enc('{"b2":1}'), { retentionMode: 'compliance' });
    } finally {
      for (const m of denied) wc[m] = origs[m]!;
    }
    expect(attempted).toEqual([]); // writer attempted none of the denied store calls
    expect((await store.reader().headObjectLock(k2)).retainUntil).not.toBeNull(); // still born locked by the bucket default
  });

  it('deny: writer cannot delete / set retention / set legal hold (store 403)', async () => {
    const wc = new (await import('minio')).Client({ endPoint: ENDPOINT!, port, useSSL, ...writer });
    const st = await wc.statObject(bucket, KEY).catch(() => null);
    await expect(wc.removeObject(bucket, KEY, { versionId: st?.versionId ?? undefined })).rejects.toBeTruthy();
    await expect(wc.putObjectRetention(bucket, KEY, { mode: 'COMPLIANCE' as never, retainUntilDate: new Date(Date.now() + 1e11).toISOString(), versionId: st?.versionId ?? '' })).rejects.toBeTruthy();
    await expect((wc.setObjectLegalHold(bucket, KEY, { status: 'ON' as never }) as unknown as Promise<void>)).rejects.toBeTruthy();
  });

  it('deny: reader cannot write or delete (store 403)', async () => {
    const rc = new (await import('minio')).Client({ endPoint: ENDPOINT!, port, useSSL, ...reader });
    await expect(rc.putObject(bucket, 'sod/reader-x.json', Buffer.from('{}'), 2)).rejects.toBeTruthy();
    await expect(rc.removeObject(bucket, KEY)).rejects.toBeTruthy();
  });

  it('deny: retention-admin cannot write content or delete versions (store 403)', async () => {
    const ac = new (await import('minio')).Client({ endPoint: ENDPOINT!, port, useSSL, ...admin });
    await expect(ac.putObject(bucket, 'sod/admin-y.json', Buffer.from('{}'), 2)).rejects.toBeTruthy();
    const st = await ac.statObject(bucket, 'sod/it.json').catch(() => null);
    await expect(ac.removeObject(bucket, 'sod/it.json', { versionId: st?.versionId ?? undefined })).rejects.toBeTruthy();
  });
});
