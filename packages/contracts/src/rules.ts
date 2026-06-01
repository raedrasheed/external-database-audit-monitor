// CCE validation-rule classification (Epic E1 / EDAM-T007, EDAM-T008).
//
// Maps schema validation failures to the CCE §10 rule ids (V1..V15) so callers
// learn WHICH rule a document violates. Rules enforced purely by JSON Schema
// are classified here from the ajv error location; stateful rules
// (V3/V4/V6/V12/V13/V14/V15) are enforced in code (see stateful.ts).

import type { ErrorObject } from 'ajv';

export type RuleId =
  | 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8'
  | 'V9' | 'V10' | 'V11' | 'V12' | 'V13' | 'V14' | 'V15'
  | 'VERSION_MAJOR' | 'SCHEMA';

/** Classify a single ajv error against a CCE document to a §10 rule id. */
export function classifyCceError(e: ErrorObject): RuleId {
  const p = e.instancePath || '';
  const missing = (e.params as { missingProperty?: string } | undefined)?.missingProperty;

  if (p === '/schema_version') return 'V1';
  if (p === '/kind') return 'V2';
  if (p.startsWith('/offset')) return 'V11';
  if (p.startsWith('/fidelity')) return 'V8';
  if (p.startsWith('/completeness')) return 'V9';
  if (p.startsWith('/actor')) return 'V10';
  if (p.includes('/field_changes')) return 'V7';
  if (p.startsWith('/changes')) {
    // V5: operation enum / before-after nullity / required field_changes.
    return 'V5';
  }
  if (e.keyword === 'required' && missing) {
    if (missing === 'fidelity') return 'V8';
    if (missing === 'completeness') return 'V9';
    if (missing === 'actor') return 'V10';
    if (missing === 'offset') return 'V11';
  }
  return 'SCHEMA';
}
