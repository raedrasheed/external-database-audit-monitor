// WV-1…WV-14 conformance suite (EDAM-T148). Asserts every WV case passes against
// the REAL implementations, that the suite is complete (all 14 ids, non-vacuous),
// and that each case carries spec traceability. This is the in-suite enforcement
// of the evidence-conformance gate (the dedicated CI job runs the same suite).
import { describe, it, expect } from 'vitest';
import { runWvConformance } from '../wv/run.js';
import { WV_CASES } from '../wv/cases.js';
import { REQUIRED_WV_IDS } from '../wv/types.js';

const results = await runWvConformance();

describe('WV-1…WV-14 conformance suite', () => {
  it('covers exactly the required WV ids (non-vacuous)', () => {
    expect(results.map((r) => r.id).sort()).toEqual([...REQUIRED_WV_IDS].sort());
    expect(results.length).toBe(14);
  });

  it('every case carries spec traceability + a well-formed id', () => {
    for (const c of WV_CASES) {
      expect(c.id).toMatch(/^WV-\d+$/);
      expect(c.spec_ref.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
    }
  });

  for (const r of results) {
    it(`${r.id} ${r.title} [${r.spec_ref}]`, () => {
      expect(r.passed, r.detail).toBe(true);
    });
  }
});
