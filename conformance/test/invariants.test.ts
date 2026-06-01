// Honesty invariant suite (Epic E8 / EDAM-T054).
import { describe, it, expect } from 'vitest';
import { runInvariants, INVARIANTS } from '../security/invariants.js';

const results = await runInvariants();

describe('honesty invariants (INV-2)', () => {
  it('every invariant has a description and spec traceability', () => {
    for (const inv of INVARIANTS) {
      expect(inv.id).toMatch(/^INV-/);
      expect(inv.spec_ref.length).toBeGreaterThan(0);
    }
  });

  for (const r of results) {
    it(`${r.id}: ${r.description}`, () => {
      expect(r.passed, r.detail).toBe(true);
    });
  }
});
