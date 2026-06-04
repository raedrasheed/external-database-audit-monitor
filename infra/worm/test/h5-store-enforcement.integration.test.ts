// EDAM-T104-H5 — store-level 403 ENFORCEMENT suite (live MinIO, raw clients).
//
// Proves that role separation is enforced by the STORE (MinIO IAM + S3 Object Lock
// COMPLIANCE), NOT by the adapter. Every operation here is issued through a RAW
// `minio` Client constructed with a role's own credentials (or `mc`), bypassing the
// MinioWormStore guards entirely. Expectations are derived from the ACCEPTED
// EDAM-S3-POLICY-AUDIT matrix (conformance/scripts/s3-policy-audit.ts) — H5 verifies
// the live store matches the audited policy model. A mismatch FAILS the suite
// (surfacing it) rather than masking it.
//
// Opt-in (keeps the default `npm test` MinIO-free):
//   WORM_MINIO_ENDPOINT=localhost WORM_MINIO_PORT=9000 WORM_MINIO_H5=true \
//   WORM_MINIO_SOD_WRITER_KEY=edam-writer WORM_MINIO_SOD_WRITER_SECRET=... \
//   WORM_MINIO_SOD_READER_KEY=edam-reader WORM_MINIO_SOD_READER_SECRET=... \
//   WORM_MINIO_SOD_ADMIN_KEY=edam-retention-admin WORM_MINIO_SOD_ADMIN_SECRET=... \
//   [WORM_H5_REPORT_PATH=docs/evidence/h5/h5-enforcement-report.json] \
//   npx vitest run infra/worm/test/h5-store-enforcement.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client, RETENTION_MODES } from 'minio';
import { evaluate, loadPolicy, type Role } from '../../../conformance/scripts/s3-policy-audit.js';

const ENDPOINT = process.env.WORM_MINIO_ENDPOINT;
const h5Run = ENDPOINT && process.env.WORM_MINIO_H5 === 'true' ? describe : describe.skip;

const PORT = process.env.WORM_MINIO_PORT ? Number(process.env.WORM_MINIO_PORT) : 9000;
const USE_SSL = process.env.WORM_MINIO_SSL === 'true';
const BUCKET = 'edam-evidence';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const cred = (k?: string, s?: string) => ({ accessKey: k ?? '', secretKey: s ?? '' });
const ROOT = cred(process.env.WORM_MINIO_ACCESS_KEY ?? 'minioadmin', process.env.WORM_MINIO_SECRET_KEY ?? 'minioadmin');
const WRITER = cred(process.env.WORM_MINIO_SOD_WRITER_KEY, process.env.WORM_MINIO_SOD_WRITER_SECRET);
const READER = cred(process.env.WORM_MINIO_SOD_READER_KEY, process.env.WORM_MINIO_SOD_READER_SECRET);
const ADMIN = cred(process.env.WORM_MINIO_SOD_ADMIN_KEY, process.env.WORM_MINIO_SOD_ADMIN_SECRET);

type Expected = 'allow' | 'deny';
type Actual = 'allow' | 'deny-access' | 'reject-worm' | 'error-other';
type Basis = 'iam-policy' | 'resource-scope' | 'store-worm';

interface ReportRow {
  role: string;
  action: string;
  basis: Basis;
  expected: Expected;
  actual: Actual;
  store: string; // store error code / status
  pass: boolean;
}
const REPORT: ReportRow[] = [];

interface Classified { actual: Actual; store: string }
function classify(err: unknown): Classified {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? '';
  const msg = `${code} ${e?.message ?? String(err)}`.trim();
  if (/AccessDenied|access denied|not authorized|forbidden|insufficient permission/i.test(msg)) {
    return { actual: 'deny-access', store: code || 'AccessDenied' };
  }
  if (/WORM|object lock|retention|cannot be overwritten|legal hold/i.test(msg)) {
    return { actual: 'reject-worm', store: code || 'WORMProtected' };
  }
  return { actual: 'error-other', store: code || msg.slice(0, 80) };
}

/**
 * Run one live op and record a report row. `expected` 'deny' passes when the store
 * blocks it (deny-access for IAM/scope cells; reject-worm for store-worm cells).
 */
async function record(role: string, action: string, basis: Basis, expected: Expected, op: () => Promise<unknown>): Promise<ReportRow> {
  let actual: Actual;
  let store: string;
  try {
    await op();
    actual = 'allow';
    store = '200/OK';
  } catch (err) {
    const c = classify(err);
    actual = c.actual;
    store = c.store;
  }
  let pass: boolean;
  if (expected === 'allow') {
    pass = actual === 'allow';
  } else if (basis === 'store-worm') {
    pass = actual === 'reject-worm' || actual === 'deny-access'; // blocked by Object Lock (or IAM)
  } else {
    pass = actual === 'deny-access'; // IAM / scope cells MUST be a permissions denial
  }
  const row: ReportRow = { role, action, basis, expected, actual, store, pass };
  REPORT.push(row);
  return row;
}

/** Expected effect for an audited s3 action, from the accepted POLICY-AUDIT matrix. */
const iam = (role: Role, s3action: string): Expected => (evaluate(loadPolicy(role), s3action) === 'Allow' ? 'allow' : 'deny');

const consume = async (p: Promise<NodeJS.ReadableStream>): Promise<void> => {
  const s = await p;
  await new Promise<void>((res, rej) => { s.on('data', () => {}); s.on('end', () => res()); s.on('error', rej); });
};

h5Run('EDAM-T104-H5 store-level 403 enforcement (live, raw clients)', () => {
  let root: Client;
  let wc: Client;
  let rc: Client;
  let ac: Client;
  let key: string;
  let versionId: string;
  let unrelated: string;

  beforeAll(async () => {
    const base = { endPoint: ENDPOINT!, port: PORT, useSSL: USE_SSL } as const;
    root = new Client({ ...base, ...ROOT });
    wc = new Client({ ...base, ...WRITER });
    rc = new Client({ ...base, ...READER });
    ac = new Client({ ...base, ...ADMIN });

    // Seed an object via the WRITER (born locked by the bucket default), so every
    // denial below is the ONLY reason the op fails (object genuinely exists + locked).
    key = `h5/obj-${Date.now().toString(36)}.json`;
    await wc.putObject(BUCKET, key, Buffer.from(enc('{"h5":1}')), 8);
    const st = await root.statObject(BUCKET, key);
    versionId = st.versionId ?? '';

    // An UNRELATED bucket (out of the evidence scope) for the retention-admin scope test.
    unrelated = `edam-h5-unrelated-${Date.now().toString(36)}`;
    await root.makeBucket(unrelated, 'us-east-1');
  }, 60_000);

  afterAll(() => {
    const path = process.env.WORM_H5_REPORT_PATH;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const summary = {
      generated_at: new Date().toISOString(),
      bucket: BUCKET,
      total: REPORT.length,
      passed: REPORT.filter((r) => r.pass).length,
      failed: REPORT.filter((r) => !r.pass).length,
      rows: REPORT.slice().sort((a, b) => `${a.role}/${a.action}`.localeCompare(`${b.role}/${b.action}`)),
    };
    writeFileSync(path, JSON.stringify(summary, null, 2) + '\n');
  });

  it('writer: only PutObject/GetObject; every mutation/retention/hold/admin is store-denied', async () => {
    const rows = await Promise.all([
      record('writer', 's3:DeleteObject', 'iam-policy', iam('writer', 's3:DeleteObject'), () => wc.removeObject(BUCKET, key)),
      record('writer', 's3:DeleteObjectVersion', 'iam-policy', iam('writer', 's3:DeleteObjectVersion'), () => wc.removeObject(BUCKET, key, { versionId })),
      record('writer', 's3:PutObjectRetention', 'iam-policy', iam('writer', 's3:PutObjectRetention'), () =>
        wc.putObjectRetention(BUCKET, key, { mode: RETENTION_MODES.COMPLIANCE, retainUntilDate: new Date(Date.now() + 9e10).toISOString(), versionId })),
      record('writer', 's3:PutObjectLegalHold', 'iam-policy', iam('writer', 's3:PutObjectLegalHold'), () =>
        wc.setObjectLegalHold(BUCKET, key, { status: 'ON' as never, versionId }) as unknown as Promise<void>),
      record('writer', 's3:BypassGovernanceRetention', 'iam-policy', iam('writer', 's3:BypassGovernanceRetention'), () =>
        wc.removeObject(BUCKET, key, { versionId, governanceBypass: true })),
      record('writer', 's3:PutBucketPolicy', 'iam-policy', iam('writer', 's3:PutBucketPolicy'), () =>
        wc.setBucketPolicy(BUCKET, JSON.stringify({ Version: '2012-10-17', Statement: [] }))),
      record('writer', 's3:PutBucketObjectLockConfiguration', 'iam-policy', iam('writer', 's3:PutBucketObjectLockConfiguration'), () =>
        wc.setObjectLockConfig(BUCKET, { mode: RETENTION_MODES.COMPLIANCE, unit: 'Days', validity: 10 }) as unknown as Promise<void>),
      record('writer', 's3:PutBucketVersioning', 'iam-policy', iam('writer', 's3:PutBucketVersioning'), () =>
        wc.setBucketVersioning(BUCKET, { Status: 'Suspended' })),
    ]);
    for (const r of rows) expect(r, JSON.stringify(r)).toMatchObject({ pass: true });
  });

  it('reader: read-only — no content/lock mutation, no bucket-config writes', async () => {
    const rows = await Promise.all([
      record('reader', 's3:PutObject', 'iam-policy', iam('reader', 's3:PutObject'), () => rc.putObject(BUCKET, 'h5/reader-w.json', Buffer.from('{}'), 2)),
      record('reader', 's3:DeleteObject', 'iam-policy', iam('reader', 's3:DeleteObject'), () => rc.removeObject(BUCKET, key)),
      record('reader', 's3:DeleteObjectVersion', 'iam-policy', iam('reader', 's3:DeleteObjectVersion'), () => rc.removeObject(BUCKET, key, { versionId })),
      record('reader', 's3:PutObjectRetention', 'iam-policy', iam('reader', 's3:PutObjectRetention'), () =>
        rc.putObjectRetention(BUCKET, key, { mode: RETENTION_MODES.COMPLIANCE, retainUntilDate: new Date(Date.now() + 9e10).toISOString(), versionId })),
      record('reader', 's3:PutObjectLegalHold', 'iam-policy', iam('reader', 's3:PutObjectLegalHold'), () =>
        rc.setObjectLegalHold(BUCKET, key, { status: 'ON' as never, versionId }) as unknown as Promise<void>),
      record('reader', 's3:PutBucketVersioning', 'iam-policy', iam('reader', 's3:PutBucketVersioning'), () => rc.setBucketVersioning(BUCKET, { Status: 'Suspended' })),
      record('reader', 's3:PutBucketObjectLockConfiguration', 'iam-policy', iam('reader', 's3:PutBucketObjectLockConfiguration'), () =>
        rc.setObjectLockConfig(BUCKET, { mode: RETENTION_MODES.COMPLIANCE, unit: 'Days', validity: 10 }) as unknown as Promise<void>),
      record('reader', 's3:PutBucketPolicy', 'iam-policy', iam('reader', 's3:PutBucketPolicy'), () =>
        rc.setBucketPolicy(BUCKET, JSON.stringify({ Version: '2012-10-17', Statement: [] }))),
    ]);
    for (const r of rows) expect(r, JSON.stringify(r)).toMatchObject({ pass: true });
    // and the denied write created NOTHING (authoritative check via root).
    await expect(root.statObject(BUCKET, 'h5/reader-w.json')).rejects.toBeTruthy();
  });

  it('retention-admin: no content write/delete/version-delete/bypass; no unrelated-bucket access', async () => {
    const rows = await Promise.all([
      record('retention-admin', 's3:PutObject', 'iam-policy', iam('retention-admin', 's3:PutObject'), () => ac.putObject(BUCKET, 'h5/admin-w.json', Buffer.from('{}'), 2)),
      record('retention-admin', 's3:DeleteObject', 'iam-policy', iam('retention-admin', 's3:DeleteObject'), () => ac.removeObject(BUCKET, key)),
      record('retention-admin', 's3:DeleteObjectVersion', 'iam-policy', iam('retention-admin', 's3:DeleteObjectVersion'), () => ac.removeObject(BUCKET, key, { versionId })),
      record('retention-admin', 's3:BypassGovernanceRetention', 'iam-policy', iam('retention-admin', 's3:BypassGovernanceRetention'), () =>
        ac.removeObject(BUCKET, key, { versionId, governanceBypass: true })),
      // resource scope: the policy is scoped to edam-evidence only → unrelated bucket denied.
      record('retention-admin', 'unrelated:PutObject', 'resource-scope', 'deny', () => ac.putObject(unrelated, 'x.json', Buffer.from('{}'), 2)),
      record('retention-admin', 'unrelated:GetObject', 'resource-scope', 'deny', () => consume(ac.getObject(unrelated, 'x.json'))),
    ]);
    for (const r of rows) expect(r, JSON.stringify(r)).toMatchObject({ pass: true });
    await expect(root.statObject(BUCKET, 'h5/admin-w.json')).rejects.toBeTruthy(); // never created
  });

  it('positive controls: each role can do exactly its allowed work', async () => {
    // SEQUENTIAL: these have data dependencies (a legal hold must EXIST before the
    // reader reads it; retention extension is forward-only). Order matters.
    const rows: ReportRow[] = [];
    // writer: PutObject only (a fresh key, born locked by bucket default).
    rows.push(await record('writer', 's3:PutObject', 'iam-policy', 'allow', () => wc.putObject(BUCKET, `h5/w-ok-${Date.now().toString(36)}.json`, Buffer.from('{}'), 2)));
    // retention-admin: extend retention (forward) on the seeded object.
    rows.push(await record('retention-admin', 's3:PutObjectRetention', 'iam-policy', 'allow', () =>
      ac.putObjectRetention(BUCKET, key, { mode: RETENTION_MODES.COMPLIANCE, retainUntilDate: new Date(Date.now() + 8e10).toISOString(), versionId })));
    // retention-admin: place a legal hold (so the reader can then READ a real hold).
    rows.push(await record('retention-admin', 's3:PutObjectLegalHold(ON)', 'iam-policy', 'allow', () =>
      ac.setObjectLegalHold(BUCKET, key, { status: 'ON' as never, versionId }) as unknown as Promise<void>));
    // reader: GetObject + read lock metadata (retention + the now-present legal hold).
    rows.push(await record('reader', 's3:GetObject', 'iam-policy', 'allow', () => consume(rc.getObject(BUCKET, key))));
    rows.push(await record('reader', 's3:GetObjectRetention', 'iam-policy', 'allow', () => rc.getObjectRetention(BUCKET, key, { versionId })));
    rows.push(await record('reader', 's3:GetObjectLegalHold', 'iam-policy', 'allow', () => rc.getObjectLegalHold(BUCKET, key, { versionId }) as unknown as Promise<void>));
    rows.push(await record('reader', 's3:ListBucket', 'iam-policy', 'allow', () => new Promise<void>((res, rej) => {
      const s = rc.listObjectsV2(BUCKET, 'h5/', true); s.on('data', () => {}); s.on('end', () => res()); s.on('error', rej);
    })));
    // retention-admin: lift the legal hold.
    rows.push(await record('retention-admin', 's3:PutObjectLegalHold(OFF)', 'iam-policy', 'allow', () =>
      ac.setObjectLegalHold(BUCKET, key, { status: 'OFF' as never, versionId }) as unknown as Promise<void>));
    // retention-admin: required bucket bootstrap WITHIN the evidence bucket (idempotent).
    rows.push(await record('retention-admin', 's3:PutBucketVersioning(edam-evidence)', 'iam-policy', 'allow', () => ac.setBucketVersioning(BUCKET, { Status: 'Enabled' })));
    rows.push(await record('retention-admin', 's3:PutBucketObjectLockConfiguration(edam-evidence)', 'iam-policy', 'allow', () =>
      ac.setObjectLockConfig(BUCKET, { mode: RETENTION_MODES.COMPLIANCE, unit: 'Days', validity: 365 }) as unknown as Promise<void>));
    for (const r of rows) expect(r, JSON.stringify(r)).toMatchObject({ pass: true });
  });

  it('governance bypass cannot defeat COMPLIANCE retention (store-level)', async () => {
    // (a) a privileged identity (root) attempting a governance-bypass version delete of a
    //     COMPLIANCE-locked version is rejected by the STORE — COMPLIANCE is non-bypassable.
    const rootBypass = await record('root', 's3:BypassGovernanceRetention', 'store-worm', 'deny', () =>
      root.removeObject(BUCKET, key, { versionId, governanceBypass: true }));
    expect(rootBypass, JSON.stringify(rootBypass)).toMatchObject({ pass: true });
    expect(rootBypass.actual).toBe('reject-worm'); // proves WORM, not merely IAM
    // (b) the object is still present after the bypass attempt.
    await expect(root.statObject(BUCKET, key)).resolves.toBeTruthy();
  });

  it('every recorded cell passed (H5 enforcement report)', () => {
    const failures = REPORT.filter((r) => !r.pass);
    expect(failures, `H5 failures:\n${JSON.stringify(failures, null, 2)}`).toEqual([]);
    expect(REPORT.length).toBeGreaterThanOrEqual(30);
  });
});
