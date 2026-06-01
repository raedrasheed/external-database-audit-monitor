// WORM no-mutate proof gate (Sprint-2 / EDAM-T105). Asserts INV-EV-1 holds and
// that the detector actually detects a planted mutation path (positive control).
import { describe, it, expect } from 'vitest';
import {
  scanDomainBSource,
  scanWriterPolicy,
  verifyNoWormMutate,
  findWormMutations,
  checkWriterPolicyText,
} from '../scripts/worm-no-mutate-proof.js';

describe('worm-no-mutate proof (INV-EV-1)', () => {
  it('Domain-B writer source has no WORM-mutation path', () => {
    expect(scanDomainBSource(), JSON.stringify(scanDomainBSource(), null, 2)).toEqual([]);
  });

  it('the WORM writer policy (WormWriter interface) is append-only', () => {
    expect(scanWriterPolicy(), JSON.stringify(scanWriterPolicy(), null, 2)).toEqual([]);
  });

  it('produces a machine-verifiable proof: ok=true with the writer-policy in scope', () => {
    const proof = verifyNoWormMutate();
    expect(proof.ok).toBe(true);
    expect(proof.violations).toEqual([]);
    expect(proof.scanned.writer_policy).toBe(1);
  });

  it('positive control: a planted delete/admin call is flagged', () => {
    expect(findWormMutations('services/evidence-writer/src/x.ts', 'await store.retentionAdmin().deleteExpired(k, now);').length).toBeGreaterThan(0);
    expect(findWormMutations('services/evidence-writer/src/x.ts', 'await s3.send(new DeleteObjectCommand({ Bucket, Key }));').length).toBeGreaterThan(0);
    expect(findWormMutations('services/evidence-writer/src/x.ts', 'await admin.extendRetention(key, "2020-01-01T00:00:00Z");').length).toBeGreaterThan(0);
    expect(findWormMutations('services/evidence-writer/src/x.ts', 'putObject({ ObjectLockMode: "GOVERNANCE" });').length).toBeGreaterThan(0);
    expect(findWormMutations('services/evidence-writer/src/x.ts', 'const k = getPrivateKey(keyId);').length).toBeGreaterThan(0);
  });

  it('positive control: a clean append-only writer path is NOT flagged', () => {
    expect(findWormMutations('services/evidence-writer/src/x.ts', 'await store.writer().putImmutable(key, bytes, { retentionMode: "compliance" });')).toEqual([]);
    // a generic Map.delete in unrelated code is not a WORM mutation
    expect(findWormMutations('services/evidence-writer/src/x.ts', 'seen.delete(id);')).toEqual([]);
  });

  it('positive control: a WormWriter interface with a delete member is flagged', () => {
    const bad = 'export interface WormWriter {\n  putImmutable(k: string): Promise<void>;\n  deleteExpired(k: string): Promise<void>;\n}\n';
    expect(checkWriterPolicyText('x.ts', bad).length).toBeGreaterThan(0);
  });

  it('positive control: comments mentioning "overwrite" do not false-positive', () => {
    const ok = 'export interface WormWriter {\n  /** write once; no overwrite */\n  putImmutable(k: string): Promise<void>;\n}\n';
    expect(checkWriterPolicyText('x.ts', ok)).toEqual([]);
  });
});
