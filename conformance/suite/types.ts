// Formal conformance suite types (Epic E6 / EDAM-T042..T046, mandate B).
//
// Each case maps DIRECTLY to a frozen CCE conformance test (C1/C3/.../C10),
// carries a fixture + expected result, and is traceable to the specification.

export interface ConformanceOutcome {
  passed: boolean;
  detail: string;
}

export interface ConformanceCase {
  /** Frozen conformance id (e.g. 'C-3'). */
  id: string;
  title: string;
  /** Traceability to the specification. */
  spec_ref: string;
  run(): ConformanceOutcome;
}

export interface ConformanceResult {
  id: string;
  title: string;
  spec_ref: string;
  passed: boolean;
  detail: string;
}
