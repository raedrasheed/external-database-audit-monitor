// EDAM-S3-REVAL reproducibility check. Re-runs the verifier-CLI's offline logic
// against the COMMITTED hardened-stack export package + sidecar objects + trust
// file produced by the S3-REVAL live run, asserting the valid offline PASS is
// reproducible (envelope PASS + overall PASS + exit 0). Offline-only — no MinIO.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runExportVerification, loadTrustRoots, exitCodeFor, EXIT_PASS } from '@edam/verifier-cli';

const DIR = resolve(process.cwd(), 'docs/evidence/s3-reval');

describe('S3-REVAL hardened-stack export re-verifies offline (reproducibility)', () => {
  it('valid hardened export package PASSes through the verifier-CLI logic (exit 0)', () => {
    const pkg: unknown = JSON.parse(readFileSync(resolve(DIR, 'export-package.json'), 'utf8'));
    const trust = loadTrustRoots(JSON.parse(readFileSync(resolve(DIR, 'trust.json'), 'utf8')));
    const result = runExportVerification(pkg, {
      objectsDir: resolve(DIR, 'objects'),
      trust,
      reportId: '99999999-2222-4333-8444-555555555555',
      generatedAt: '2026-06-04T00:00:00.000Z',
    });
    expect(result.export_signature.result, JSON.stringify(result.export_signature)).toBe('PASS');
    expect(result.report.overall_result, JSON.stringify(result.report.checks)).toBe('PASS');
    expect(exitCodeFor(result)).toBe(EXIT_PASS);
  });
});
