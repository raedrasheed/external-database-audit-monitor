// Validator API (Epic E1 / EDAM-T007).
//
// Validates a document against a frozen EDAM schema and reports failures with
// CCE §10 rule ids. The vendored schema files are kept byte-verbatim (T006);
// one isolated, documented erratum is compensated at runtime (ERRATA-CCE-001,
// see below) so that valid CCEs are satisfiable, while the normative rule it
// encodes (V6) is enforced in code (stateful.ts).

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import { SCHEMAS, type SchemaId } from './schemas/index.js';
import { classifyCceError, type RuleId } from './rules.js';

export interface ValidationError {
  rule: RuleId;
  instancePath: string;
  keyword: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

/**
 * ERRATA-CCE-001: The frozen CCE change-item conditional requires a top-level
 * `primary_key`, but the property is defined at `object.primary_key` and the
 * item is `additionalProperties:false`, which makes every INSERT/UPDATE/DELETE
 * item unsatisfiable. The normative contract (CCE §10 V6) is "row operations
 * have object.primary_key". We drop only the contradictory top-level
 * requirement from the RUNTIME schema (the vendored file is untouched) and
 * enforce V6 in code. This preserves contract semantics; it does not change
 * what a valid CCE is per the normative §10 rules.
 */
function compensateCceErrata(schema: Record<string, unknown>): void {
  const items = (schema.properties as any)?.changes?.items;
  const then0 = items?.allOf?.[0]?.then;
  if (then0 && Array.isArray(then0.required)) {
    then0.required = then0.required.filter((r: string) => r !== 'primary_key');
  }
}

function runtimeSchema(id: SchemaId): Record<string, unknown> {
  const schema = structuredClone(SCHEMAS[id]) as Record<string, unknown>;
  if (id === 'cce-1.0') compensateCceErrata(schema);
  return schema;
}

const validators = new Map<SchemaId, ReturnType<typeof ajv.compile>>();

function getValidator(id: SchemaId): ReturnType<typeof ajv.compile> {
  let v = validators.get(id);
  if (!v) {
    v = ajv.compile(runtimeSchema(id));
    validators.set(id, v);
  }
  return v;
}

function toError(id: SchemaId, e: ErrorObject): ValidationError {
  return {
    rule: id === 'cce-1.0' ? classifyCceError(e) : 'SCHEMA',
    instancePath: e.instancePath,
    keyword: e.keyword,
    message: e.message ?? '',
  };
}

/** Validate `data` against the named frozen schema (structural validation). */
export function validate(schemaId: SchemaId, data: unknown): ValidationResult {
  const v = getValidator(schemaId);
  const ok = v(data) as boolean;
  if (ok) return { valid: true, errors: [] };
  return { valid: false, errors: (v.errors ?? []).map((e) => toError(schemaId, e)) };
}

/** Convenience for the most common case. */
export function validateCce(data: unknown): ValidationResult {
  return validate('cce-1.0', data);
}
