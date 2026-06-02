// WV conformance runner (EDAM-T148). Runs every WV case (async), catching throws
// as a FAIL so a crashing case can never be reported as green.

import { WV_CASES } from './cases.js';
import type { WvResult } from './types.js';

export async function runWvConformance(): Promise<WvResult[]> {
  const results: WvResult[] = [];
  for (const c of WV_CASES) {
    let outcome;
    try {
      outcome = await c.run();
    } catch (err) {
      outcome = { passed: false, detail: `case threw: ${String((err as Error).message ?? err)}` };
    }
    results.push({ id: c.id, title: c.title, spec_ref: c.spec_ref, passed: outcome.passed, detail: outcome.detail });
  }
  return results;
}
