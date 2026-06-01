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
  // ERRATA-CCE-001 is carried verbatim into cce-1.1 (the amendment is additive
  // and did not touch the change-item conditional), so compensate both.
  if (id === 'cce-1.0' || id === 'cce-1.1') compensateCceErrata(schema);
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
    rule: id === 'cce-1.0' || id === 'cce-1.1' ? classifyCceError(e) : 'SCHEMA',
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

/**
 * Convenience for the most common case. The authoritative CCE validation
 * schema is `cce-1.1` (CCE-AMD-001 Rev 4): a strict additive superset of
 * `cce-1.0` that accepts every existing `cce-1.0` event and self-enforces the
 * version/engine/phase scoping of the snapshot binlog-offset branch (V16).
 */
export function validateCce(data: unknown): ValidationResult {
  return validate('cce-1.1', data);
}

/**
 * Validate a Snapshot Epoch Manifest (CCE-AMD-001 Rev 4 §3). This is a COMPANION
 * record — not a CCE — so it is validated against its own schema, never against
 * the CCE change-event schema.
 */
export function validateSnapshotEpochManifest(data: unknown): ValidationResult {
  return validate('snapshot-epoch-manifest-1.0', data);
}

// --- Sprint-2 evidence/WORM record validators (EDAM-T101) ---
// Structural validation against the schemas vendored verbatim from the WORM
// spec §16. Stateful checks (hash recomputation, chain continuity, signature /
// anchor verification) are enforced by later Sprint-2 tasks + the conformance
// suite, not by JSON Schema alone (WORM §16 preamble).

/** Validate an Evidence Segment Manifest (WORM §16.1). */
export function validateEvidenceSegmentManifest(data: unknown): ValidationResult {
  return validate('evidence-segment-manifest-1.0', data);
}

/** Validate an Anchor Record (WORM §16.2). */
export function validateAnchorRecord(data: unknown): ValidationResult {
  return validate('anchor-record-1.0', data);
}

/** Validate a Verification Report (WORM §16.3). */
export function validateVerificationReport(data: unknown): ValidationResult {
  return validate('verification-report-1.0', data);
}

/** Validate an Evidence Export Package (WORM §16.4). */
export function validateEvidenceExportPackage(data: unknown): ValidationResult {
  return validate('evidence-export-package-1.0', data);
}
