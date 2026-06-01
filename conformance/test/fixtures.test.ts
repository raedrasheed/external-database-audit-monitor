// Tests for the conformance fixtures (Epic E7 / EDAM-T050).
import { describe, it, expect } from 'vitest';
import { loadFixtures } from '../fixtures/load.js';
import { validateFixture, FixtureValidationError } from '../fixtures/schema.js';

describe('conformance fixtures', () => {
  const fixtures = loadFixtures();

  it('loads and validates all fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  it('has unique fixture ids', () => {
    const ids = fixtures.map((f) => f.fixture_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers UPDATE and DELETE operations and references conformance tests', () => {
    const ops = new Set(fixtures.map((f) => f.expected.operation));
    expect(ops.has('UPDATE')).toBe(true);
    expect(ops.has('DELETE')).toBe(true);
    for (const f of fixtures) {
      expect(f.conformance_refs.length).toBeGreaterThan(0);
    }
  });

  it('does NOT fabricate golden values before Epic E1 (INV-2)', () => {
    for (const f of fixtures) {
      expect(f.golden.status).toBe('PENDING_CANONICAL');
      expect(f.golden.envelope_id).toBeNull();
      expect(f.golden.event_hash).toBeNull();
    }
  });

  it('enforces before/after nullity per operation (CCE §5)', () => {
    for (const f of fixtures) {
      if (f.expected.operation === 'DELETE') expect(f.expected.after).toBeNull();
      if (f.expected.operation === 'INSERT') expect(f.expected.before).toBeNull();
    }
  });

  it('masks sensitive field changes', () => {
    for (const f of fixtures) {
      for (const fc of f.expected.field_changes ?? []) {
        if (fc.sensitive) expect(fc.masked).toBe(true);
      }
    }
  });

  it('rejects a fixture that fabricates a golden value while PENDING', () => {
    const bad = {
      fixture_id: 'bad',
      description: 'd',
      conformance_refs: ['C-3'],
      source: { db_id: 'x', engine: 'mysql', server_uuid: 'u', schema: 'kafel' },
      transaction: { tx_id: 't', commit_ts: '2026-06-01T00:00:00.000Z' },
      input_sql: ['SELECT 1;'],
      expected: { operation: 'UPDATE', object: { schema: 'kafel', name: 'donations' }, before: {}, after: {} },
      golden: { status: 'PENDING_CANONICAL', schema_version: 'cce-1.0', envelope_id: 'fab', event_hash: 'fab' },
    };
    expect(() => validateFixture(bad, 'bad')).toThrow(FixtureValidationError);
  });
});
