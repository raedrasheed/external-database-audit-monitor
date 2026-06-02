// WV-1…WV-14 conformance suite types (EDAM-T148).
//
// Each WV case exercises the REAL frozen implementations (writer/seal model,
// signing, anchoring, verifier, export, WORM) and asserts the spec §17.2
// behavior — positive verdicts for the happy path, and located FAILs for every
// tamper/gap/forgery. Mirrors the frozen CCE conformance harness shape.

export interface WvOutcome {
  passed: boolean;
  detail: string;
}

export interface WvCase {
  /** Conformance id, e.g. 'WV-1'. */
  id: string;
  title: string;
  /** Traceability to the WORM/anchoring spec (§17.2). */
  spec_ref: string;
  run(): WvOutcome | Promise<WvOutcome>;
}

export interface WvResult {
  id: string;
  title: string;
  spec_ref: string;
  passed: boolean;
  detail: string;
}

/** The full set of WV ids the suite MUST cover (non-vacuous guard). */
export const REQUIRED_WV_IDS: readonly string[] = [
  'WV-1', 'WV-2', 'WV-3', 'WV-4', 'WV-5', 'WV-6', 'WV-7',
  'WV-8', 'WV-9', 'WV-10', 'WV-11', 'WV-12', 'WV-13', 'WV-14',
];
