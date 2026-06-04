// EDAM-P2-TRUST-GENERATOR drift guard (offline; no MinIO/HSM). Recomputes the
// out-of-band verifier trust file from the committed registry snapshot and asserts
// it equals the committed docs/trust/trust.json + hash — so the trust file can never
// be hand-edited or go stale (single source of truth = the KeyRotationRegistry).
// Also enforces: loadable by the verifier, mTLS-CA exclusion, full key history
// (never pruned), both validity bounds present, and fail-closed policy violations.
import { describe, it, expect } from 'vitest';
import { serializeCanonical } from '@edam/canonical';
import { KeyRotationRegistry, buildTrustFile, TrustFileGenerationError } from '@edam/signing';
import { loadTrustRoots } from '@edam/verifier-cli';
import { generateFromSnapshot, committed, loadSnapshot } from '../scripts/trust-file.js';

describe('EDAM-P2-TRUST-GENERATOR drift guard', () => {
  it('committed trust.json == generated-from-snapshot (no drift)', () => {
    const gen = generateFromSnapshot();
    const com = committed();
    expect(serializeCanonical(gen.trust)).toBe(serializeCanonical(com.trust));
    expect(gen.hash).toBe(com.hash);
  });

  it('the committed trust file loads through the verifier (non-empty, well-formed)', () => {
    const roots = loadTrustRoots(committed().trust);
    // resolvable by key_id, carrying both validity bounds (loadTrustRoots is fail-closed on empty).
    const active = roots.signingKeys.get('edam-dev-ed25519-acc748c4927f0b2c');
    expect(active?.not_before).toBe('2026-03-01T00:00:00.000Z');
    expect(roots.exportKeys.get('edam-dev-ed25519-3613db6a6fd1b959')?.revoked_at ?? null).toBeNull();
    // a revoked historical key still resolves (history retained) with its revoked_at.
    expect(roots.signingKeys.get('edam-dev-ed25519-6056025be23803d0')?.revoked_at).toBe('2026-03-01T00:00:00.000Z');
  });

  it('key history is NEVER pruned — every snapshot key appears in the trust file', () => {
    const snap = loadSnapshot();
    const trust = committed().trust as { signing_keys: { key_id: string }[]; export_keys: { key_id: string }[] };
    expect(trust.signing_keys.map((k) => k.key_id).sort()).toEqual(snap.evidence.records.map((r) => r.signing_key_id).sort());
    expect(trust.export_keys.map((k) => k.key_id).sort()).toEqual(snap.export.records.map((r) => r.signing_key_id).sort());
    // includes the rotated-away + revoked evidence key (history retained).
    const revoked = trust.signing_keys.find((k) => k.key_id === 'edam-dev-ed25519-6056025be23803d0') as { revoked_at?: string } | undefined;
    expect(revoked?.revoked_at).toBe('2026-03-01T00:00:00.000Z');
  });

  it('every signing/export key exposes BOTH validity bounds (not_before + revoked_at)', () => {
    const trust = committed().trust as { signing_keys: Record<string, unknown>[]; export_keys: Record<string, unknown>[] };
    for (const k of [...trust.signing_keys, ...trust.export_keys]) {
      expect(typeof k.not_before).toBe('string');
      expect('revoked_at' in k).toBe(true);
    }
  });

  it('anchor_certs is the explicit P2-TSA placeholder (empty until P2-TSA)', () => {
    const trust = committed().trust as { anchor_certs: unknown[] };
    expect(trust.anchor_certs).toEqual([]);
  });

  it('mTLS-exclusion: X.509 CERTIFICATE material is refused in the evidence/export key planes', () => {
    const certPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const evidence = new KeyRotationRegistry(
      [{ signing_key_id: 'mtls-ca-1', algorithm: 'ed25519', public_key: certPem, created_at: '2026-01-01T00:00:00.000Z', revoked_at: null }],
      'mtls-ca-1',
    );
    const exportReg = new KeyRotationRegistry(
      [{ signing_key_id: 'x1', algorithm: 'ed25519', public_key: 'AAAA', created_at: '2026-01-01T00:00:00.000Z', revoked_at: null }],
      'x1',
    );
    expect(() => buildTrustFile({ evidence, export: exportReg, meta: { trust_version: 1, generated_at: '2026-06-04T00:00:00.000Z' } })).toThrow(TrustFileGenerationError);
  });

  it('cross-plane key_id collision is refused', () => {
    const rec = { signing_key_id: 'dup', algorithm: 'ed25519' as const, public_key: 'AAAA', created_at: '2026-01-01T00:00:00.000Z', revoked_at: null };
    const evidence = new KeyRotationRegistry([rec], 'dup');
    const exportReg = new KeyRotationRegistry([rec], 'dup');
    expect(() => buildTrustFile({ evidence, export: exportReg, meta: { trust_version: 1, generated_at: '2026-06-04T00:00:00.000Z' } })).toThrow(/cross-plane collision/);
  });

  it('fail-closed: a non-positive trust_version is refused', () => {
    const snap = loadSnapshot();
    const evidence = new KeyRotationRegistry(snap.evidence.records, snap.evidence.active_key_id);
    const exportReg = new KeyRotationRegistry(snap.export.records, snap.export.active_key_id);
    expect(() => buildTrustFile({ evidence, export: exportReg, meta: { trust_version: 0, generated_at: '2026-06-04T00:00:00.000Z' } })).toThrow(TrustFileGenerationError);
  });
});
