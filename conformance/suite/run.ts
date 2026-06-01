// Conformance runner (Epic E6 / EDAM-T042..T046).

import { CASES } from './cases.js';
import type { ConformanceResult } from './types.js';

export function runConformance(): ConformanceResult[] {
  return CASES.map((c) => {
    let outcome;
    try {
      outcome = c.run();
    } catch (err) {
      outcome = { passed: false, detail: `case threw: ${String((err as Error).message ?? err)}` };
    }
    return { id: c.id, title: c.title, spec_ref: c.spec_ref, passed: outcome.passed, detail: outcome.detail };
  });
}
