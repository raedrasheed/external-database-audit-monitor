// T162 reproducibility check (EDAM-T162, D1). Re-runs the verifier-CLI's offline
// verification logic against the COMMITTED base export package + sidecar bundle +
// out-of-band trust file, and asserts the valid offline PASS remains reproducible
// (envelope PASS + overall PASS + exit-0 mapping). Minimal: this is the only
// committed test for T162 — it does NOT re-derive the live run, only proves the
// committed reproducibility artifacts still verify.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runExportVerification, loadTrustRoots, exitCodeFor, EXIT_PASS } from '@edam/verifier-cli';

const DIR = resolve(process.cwd(), 'docs/evidence/t162');

describe('T162 committed export package re-verifies offline (reproducibility)', () => {
  it('valid base package PASSes through the verifier-CLI logic (exit 0)', () => {
    const pkg: unknown = JSON.parse(readFileSync(resolve(DIR, 'base-export-package.json'), 'utf8'));
    const trust = loadTrustRoots(JSON.parse(readFileSync(resolve(DIR, 'trust.json'), 'utf8')));
    const result = runExportVerification(pkg, {
      objectsDir: resolve(DIR, 'objects'),
      trust,
      reportId: '99999999-2222-4333-8444-555555555555',
      generatedAt: '2026-06-03T00:00:00.000Z',
    });
    expect(result.export_signature.result, JSON.stringify(result.export_signature)).toBe('PASS');
    expect(result.report.overall_result, JSON.stringify(result.report.checks)).toBe('PASS');
    expect(exitCodeFor(result)).toBe(EXIT_PASS);
  });
});
