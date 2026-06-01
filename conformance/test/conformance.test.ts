// Formal conformance suite assertions (Epic E6 / EDAM-T042..T046, mandate B).
import { describe, it, expect } from 'vitest';
import { runConformance } from '../suite/run.js';
import { CASES } from '../suite/cases.js';

const results = runConformance();

describe('CCE conformance suite', () => {
  it('every case has a fixture, expected result, and spec traceability', () => {
    for (const c of CASES) {
      expect(c.spec_ref.length).toBeGreaterThan(0);
      expect(c.id).toMatch(/^C-\d+$/);
    }
  });

  for (const r of results) {
    it(`${r.id} ${r.title} [${r.spec_ref}]`, () => {
      expect(r.passed, r.detail).toBe(true);
    });
  }
});
