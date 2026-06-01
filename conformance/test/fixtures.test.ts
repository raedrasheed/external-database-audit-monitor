// Conformance fixtures: real CCEs, pinned + deterministic (Epic E4 / EDAM-T036).
import { describe, it, expect } from 'vitest';
import { loadFixtures } from '../fixtures/load.js';
import { buildCce, type NormalizedTransaction } from '@edam/cce-model';
import { validateCceFull } from '@edam/contracts';

const fixtures = loadFixtures();

describe('conformance fixtures', () => {
  it('loads at least the five core fixtures, all PINNED (no PENDING)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    for (const f of fixtures) {
      expect(f.golden.status).toBe('PINNED');
      expect(f.golden.event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('rebuilds each fixture to its pinned golden values (determinism)', () => {
    for (const f of fixtures) {
      const cce = buildCce(f.input as unknown as NormalizedTransaction, { sensitiveFields: f.sensitive_fields });
      expect(cce.envelope_id).toBe(f.golden.envelope_id);
      expect(cce.evidence.event_hash).toBe(f.golden.event_hash);
      expect(cce.evidence.row_hash).toBe(f.golden.row_hash);
    }
  });

  it('every rebuilt CCE validates against the frozen contracts', () => {
    for (const f of fixtures) {
      const cce = buildCce(f.input as unknown as NormalizedTransaction, { sensitiveFields: f.sensitive_fields });
      const result = validateCceFull(cce);
      expect(result.valid, `${f.fixture_id}: ${result.errors.map((e) => e.rule).join(',')}`).toBe(true);
    }
  });

  it('masks sensitive fields (no raw sensitive value leaks)', () => {
    const fx = fixtures.find((f) => f.fixture_id === 'FX-003-beneficiary-deletion')!;
    const cce = buildCce(fx.input as unknown as NormalizedTransaction, { sensitiveFields: fx.sensitive_fields });
    expect(JSON.stringify(cce)).not.toContain('Aid Recipient A');
    expect(JSON.stringify(cce)).not.toContain('2011223344');
  });
});
