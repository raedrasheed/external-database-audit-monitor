// EDAM-S3-POLICY-AUDIT — static policy-audit gate (offline; no MinIO required).
// Asserts the committed MinIO IAM policies still encode the S-6/S-7 + B2 separation
// model. This is the durable regression guard for the policy DOCUMENTS; live
// store-level 403 enforcement across the full surface is H5 (a later task).
import { describe, it, expect } from 'vitest';
import {
  auditAll,
  auditRole,
  evaluate,
  loadPolicy,
  effectMatrix,
  ROLES,
} from '../scripts/s3-policy-audit.js';

describe('EDAM-S3-POLICY-AUDIT (static policy audit)', () => {
  it('the committed policies satisfy the full SoD model (no violations)', () => {
    const res = auditAll();
    expect(res.violations, JSON.stringify(res.violations, null, 2)).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.roles.map((r) => r.role).sort()).toEqual(['reader', 'retention-admin', 'writer']);
  });

  it('writer: ALLOW only PutObject + GetObject; explicit Deny on all mutation/retention/hold/admin', () => {
    const p = loadPolicy('writer');
    expect(evaluate(p, 's3:PutObject')).toBe('Allow');
    expect(evaluate(p, 's3:GetObject')).toBe('Allow');
    for (const a of [
      's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectRetention', 's3:PutObjectLegalHold',
      's3:BypassGovernanceRetention', 's3:PutBucketPolicy', 's3:PutBucketObjectLockConfiguration', 's3:PutBucketVersioning',
    ]) {
      expect(evaluate(p, a), a).toBe('Deny'); // explicit Deny (defense-in-depth)
    }
    // B2: the writer Allow set is exactly {PutObject, GetObject}.
    expect(auditRole('writer').allowed).toEqual(['s3:GetObject', 's3:PutObject']);
  });

  it('reader: read-only — every mutating action is blocked', () => {
    const p = loadPolicy('reader');
    expect(evaluate(p, 's3:GetObject')).toBe('Allow');
    for (const a of [
      's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectRetention',
      's3:PutObjectLegalHold', 's3:BypassGovernanceRetention', 's3:PutBucketObjectLockConfiguration', 's3:PutBucketVersioning',
    ]) {
      expect(evaluate(p, a) !== 'Allow', a).toBe(true);
    }
    for (const a of auditRole('reader').allowed) expect(/Put|Delete|Bypass/.test(a), a).toBe(false);
  });

  it('retention-admin: manages retention/legal-hold but cannot write content or delete versions', () => {
    const p = loadPolicy('retention-admin');
    expect(evaluate(p, 's3:PutObjectRetention')).toBe('Allow');
    expect(evaluate(p, 's3:PutObjectLegalHold')).toBe('Allow');
    for (const a of ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:BypassGovernanceRetention']) {
      expect(evaluate(p, a) !== 'Allow', a).toBe(true);
    }
  });

  it('governance bypass is denied for EVERY role', () => {
    for (const role of ROLES) {
      expect(evaluate(loadPolicy(role), 's3:BypassGovernanceRetention') !== 'Allow', role).toBe(true);
    }
  });

  it('every policy is scoped to the edam-evidence bucket and grants no admin actions', () => {
    for (const role of ROLES) {
      const a = auditRole(role);
      expect(a.outOfScopeResources, `${role} out-of-scope`).toEqual([]);
      expect(a.adminActions, `${role} admin actions`).toEqual([]);
    }
  });

  it('effect matrix is consistent with the Option B2 contract narrowing', () => {
    const m = effectMatrix();
    // The writer (Domain B) cannot influence retention/hold — matches WriterPutOptions.
    expect(m.writer['s3:PutObjectRetention']).toBe('Deny');
    expect(m.writer['s3:PutObjectLegalHold']).toBe('Deny');
    // Domain C owns retention/hold.
    expect(m['retention-admin']['s3:PutObjectRetention']).toBe('Allow');
    expect(m['retention-admin']['s3:PutObjectLegalHold']).toBe('Allow');
    // No role may delete object versions (lawful expiry deletion is dual-controlled, not standing).
    for (const role of ROLES) expect(m[role]['s3:DeleteObjectVersion'] !== 'Allow', role).toBe(true);
  });
});
