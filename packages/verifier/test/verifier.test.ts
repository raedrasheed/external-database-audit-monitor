// @edam/verifier skeleton tests (EDAM-T140): builds; export-package validation;
// malformed inputs fail closed; the emitted report validates against the vendored
// verification-report-1.0 schema; trusted-material directories + parsing helpers;
// and a dependency-floor isolation check (placeholder for the T147 gate).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  verify,
  loadExportPackage,
  ExportPackageError,
  VerificationReportBuilder,
  signingKeyDirectoryFromExport,
  InMemoryAnchorCertDirectory,
  parsePublicKey,
  parseCertificate,
  ALL_CHECKS,
  type EvidenceExportPackage,
  type WormReadPort,
} from '../src/index.js';
import { validateVerificationReport } from '@edam/contracts';

const H = (c: string) => 'sha256:' + c.repeat(64);

function validExport(overrides: Partial<EvidenceExportPackage> = {}): EvidenceExportPackage {
  return {
    package_version: 'evidence-export-package-1.0',
    package_id: '11111111-2222-4333-8444-555555555555',
    db_id: 'kafel-dev-mysql',
    purpose: 'legal_audit',
    created_at: '2026-06-01T12:00:00.000Z',
    created_by: 'edam-export',
    object_refs: [{ object_id: '99999999-2222-4333-8444-555555555555', object_type: 'cce', worm_object_key: 'k/0', event_hash: H('1') }],
    segment_manifests: ['{"manifest_version":"evidence-segment-manifest-1.0"}'],
    anchor_records: ['{"anchor_version":"anchor-record-1.0"}'],
    public_keys: [{ key_id: 'edam-dev-ed25519-1', algorithm: 'ed25519', public_key: 'BASE64SPKI', revoked_at: null }],
    timestamp_certificates: ['-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'],
    verification_instructions: { spec_id: 'worm-v1', spec_hash: H('a') },
    chain_of_custody_log: [{ at: '2026-06-01T12:00:00.000Z', actor: 'export', action: 'created' }],
    export_signature: { algorithm: 'ed25519', signing_key_id: 'edam-dev-ed25519-1', signature: 'BASE64SIG', package_hash: H('b') },
    ...overrides,
  };
}

describe('@edam/verifier skeleton (T140)', () => {
  it('builds and verify() emits a schema-valid report (export mode)', () => {
    const report = verify({ mode: 'export', package: validExport() }, { reportId: '33333333-2222-4333-8444-555555555555', generatedAt: '2026-06-01T12:01:00.000Z' });
    expect(validateVerificationReport(report).valid, JSON.stringify(validateVerificationReport(report).errors)).toBe(true);
    expect(report.report_version).toBe('verification-report-1.0');
    expect(report.db_id).toBe('kafel-dev-mysql');
    expect(report.overall_result).toBe('PASS');
  });

  it('emits all §10 checks as SKIPPED (structural scaffold, not an attestation)', () => {
    const report = verify({ mode: 'export', package: validExport() });
    expect(report.checks.map((c) => c.check)).toEqual([...ALL_CHECKS]);
    expect(report.checks.every((c) => c.result === 'SKIPPED')).toBe(true);
  });

  it('worm mode takes db_id + scope from the input', () => {
    const reader: WormReadPort = { get: async () => new Uint8Array(), list: async () => [] };
    const report = verify({ mode: 'worm', reader, dbId: 'kafel-dev-pg', scope: { first_segment_sequence: 0, last_segment_sequence: 4 } });
    expect(report.db_id).toBe('kafel-dev-pg');
    expect(report.scope).toEqual({ first_segment_sequence: 0, last_segment_sequence: 4 });
    expect(validateVerificationReport(report).valid).toBe(true);
  });

  it('loadExportPackage accepts a valid package and rejects malformed input', () => {
    expect(loadExportPackage(validExport()).db_id).toBe('kafel-dev-mysql');
    expect(() => loadExportPackage({})).toThrow(ExportPackageError);
    expect(() => loadExportPackage(validExport({ object_refs: [] }))).toThrow(ExportPackageError); // minItems 1
    expect(() => loadExportPackage(validExport({ db_id: '' }))).toThrow(ExportPackageError); // minLength 1
    const badHash = validExport();
    (badHash.object_refs[0] as { event_hash: string }).event_hash = 'not-a-hash';
    expect(() => loadExportPackage(badHash)).toThrow(ExportPackageError); // pattern
  });

  it('VerificationReportBuilder: a FAIL check makes overall FAIL; report validates', () => {
    const report = new VerificationReportBuilder({ db_id: 'd', verifier: { type: 'independent_external' }, scope: { first_segment_sequence: 0, last_segment_sequence: 0 }, reportId: '44444444-2222-4333-8444-555555555555', generatedAt: '2026-06-01T12:00:00.000Z' })
      .add({ check: 'per_object_hash', result: 'PASS' })
      .add({ check: 'hsm_signature', result: 'FAIL', details: 'forged', offending_ids: ['seg-1'] })
      .build();
    expect(report.overall_result).toBe('FAIL');
    expect(validateVerificationReport(report).valid).toBe(true);
  });

  it('trust directories + parsing helpers (parse-only)', () => {
    const dir = signingKeyDirectoryFromExport(validExport());
    expect(dir.get('edam-dev-ed25519-1')?.algorithm).toBe('ed25519');
    expect(dir.get('missing')).toBeUndefined();
    expect(new InMemoryAnchorCertDirectory([{ ref: 'dev-tsa-1', algorithm: 'ed25519', public_key: 'x' }]).get('dev-tsa-1')?.ref).toBe('dev-tsa-1');

    const { publicKey } = generateKeyPairSync('ed25519');
    const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(parsePublicKey(spkiB64).asymmetricKeyType).toBe('ed25519');
    expect(parsePublicKey(publicKey.export({ format: 'pem', type: 'spki' }).toString()).asymmetricKeyType).toBe('ed25519');
    expect(() => parseCertificate('not-a-cert')).toThrow();
  });

  it('isolation: dependency floor is only canonical + contracts + evidence (no writer/worm/signing/anchoring/db)', () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    const allowed = new Set(['@edam/canonical', '@edam/contracts', '@edam/evidence']);
    expect(deps.every((d) => allowed.has(d)), `unexpected deps: ${deps.filter((d) => !allowed.has(d)).join(', ')}`).toBe(true);
    for (const forbidden of ['@edam/worm', '@edam/signing', '@edam/anchoring', '@edam/evidence-writer', '@edam/dlq', '@edam/cdc-collector']) {
      expect(deps.includes(forbidden)).toBe(false);
    }
  });
});
