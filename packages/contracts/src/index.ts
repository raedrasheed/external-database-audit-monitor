// @edam/contracts — frozen EDAM schemas + validation (Epic E1).

export { SCHEMAS, SCHEMA_IDS, type SchemaId } from './schemas/index.js';
export {
  validate,
  validateCce,
  validateSnapshotEpochManifest,
  validateEvidenceSegmentManifest,
  validateAnchorRecord,
  validateVerificationReport,
  validateEvidenceExportPackage,
  type ValidationError,
  type ValidationResult,
} from './validator.js';
export { type RuleId } from './rules.js';
export { validateCceFull, checkVersionGate } from './full.js';
export { validateCceStateful, computeEventHash, CceStreamValidator } from './stateful.js';
