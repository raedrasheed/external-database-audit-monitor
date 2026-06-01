// Frozen JSON Schema registry (Epic E1 / EDAM-T006).
// Schemas are vendored VERBATIM from the frozen specifications and pinned by
// schema_version. They are loaded as JSON (resolveJsonModule).

import cce from './cce-1.0.schema.json' with { type: 'json' };
import cce11 from './cce-1.1.schema.json' with { type: 'json' };
import reversalDirective from './reversal-directive-1.0.schema.json' with { type: 'json' };
import executionResult from './execution-result-1.0.schema.json' with { type: 'json' };
import dbAuditEvent from './db-audit-event-1.0.schema.json' with { type: 'json' };
import snapshotEpochManifest from './snapshot-epoch-manifest-1.0.schema.json' with { type: 'json' };
// Sprint-2 evidence schemas (EDAM-T101) — vendored VERBATIM from the WORM
// Evidence Segment & Anchoring Specification v1 §16.1–§16.4.
import evidenceSegmentManifest from './evidence-segment-manifest-1.0.schema.json' with { type: 'json' };
import anchorRecord from './anchor-record-1.0.schema.json' with { type: 'json' };
import verificationReport from './verification-report-1.0.schema.json' with { type: 'json' };
import evidenceExportPackage from './evidence-export-package-1.0.schema.json' with { type: 'json' };

export type SchemaId =
  | 'cce-1.0'
  | 'cce-1.1'
  | 'reversal-directive-1.0'
  | 'execution-result-1.0'
  | 'db-audit-event-1.0'
  | 'snapshot-epoch-manifest-1.0'
  | 'evidence-segment-manifest-1.0'
  | 'anchor-record-1.0'
  | 'verification-report-1.0'
  | 'evidence-export-package-1.0';

export const SCHEMAS: Record<SchemaId, Record<string, unknown>> = {
  'cce-1.0': cce as Record<string, unknown>,
  'cce-1.1': cce11 as Record<string, unknown>,
  'reversal-directive-1.0': reversalDirective as Record<string, unknown>,
  'execution-result-1.0': executionResult as Record<string, unknown>,
  'db-audit-event-1.0': dbAuditEvent as Record<string, unknown>,
  'snapshot-epoch-manifest-1.0': snapshotEpochManifest as Record<string, unknown>,
  'evidence-segment-manifest-1.0': evidenceSegmentManifest as Record<string, unknown>,
  'anchor-record-1.0': anchorRecord as Record<string, unknown>,
  'verification-report-1.0': verificationReport as Record<string, unknown>,
  'evidence-export-package-1.0': evidenceExportPackage as Record<string, unknown>,
};

export const SCHEMA_IDS = Object.keys(SCHEMAS) as SchemaId[];
