// Full CCE validation: schema + version gate + stateful rules (Epic E1 / EDAM-T008).

import { validateCce, type ValidationResult, type ValidationError } from './validator.js';
import { validateCceStateful } from './stateful.js';

const CCE_VERSION_RE = /^cce-(\d+)\.(\d+)$/;

/** Version gate (CCE §9): reject an unknown MAJOR version. Returns an error or null. */
export function checkVersionGate(schemaVersion: unknown): ValidationError | null {
  if (typeof schemaVersion !== 'string') return null;
  const m = CCE_VERSION_RE.exec(schemaVersion);
  if (m && Number(m[1]) !== 1) {
    return {
      rule: 'VERSION_MAJOR',
      instancePath: '/schema_version',
      keyword: 'version-gate',
      message: `unsupported CCE major version: ${schemaVersion}`,
    };
  }
  return null;
}

/**
 * Validate a CCE against the schema, the major-version gate, and the stateful
 * rules (V3/V4/V6/V12/V13). Stream rules (V14/V15) require ordered context and
 * live in CceStreamValidator.
 */
export function validateCceFull(data: unknown): ValidationResult {
  const errors: ValidationError[] = [...validateCce(data).errors];

  const cce = data as Record<string, unknown> | null;
  if (cce && typeof cce === 'object') {
    const versionErr = checkVersionGate(cce.schema_version);
    if (versionErr) errors.push(versionErr);
    errors.push(...validateCceStateful(cce as Record<string, any>));
  }

  return { valid: errors.length === 0, errors };
}
