// Frozen JSON Schema registry (Epic E1 / EDAM-T006).
// Schemas are vendored VERBATIM from the frozen specifications and pinned by
// schema_version. They are loaded as JSON (resolveJsonModule).

import cce from './cce-1.0.schema.json' with { type: 'json' };
import cce11 from './cce-1.1.schema.json' with { type: 'json' };
import reversalDirective from './reversal-directive-1.0.schema.json' with { type: 'json' };
import executionResult from './execution-result-1.0.schema.json' with { type: 'json' };
import dbAuditEvent from './db-audit-event-1.0.schema.json' with { type: 'json' };

export type SchemaId =
  | 'cce-1.0'
  | 'cce-1.1'
  | 'reversal-directive-1.0'
  | 'execution-result-1.0'
  | 'db-audit-event-1.0';

export const SCHEMAS: Record<SchemaId, Record<string, unknown>> = {
  'cce-1.0': cce as Record<string, unknown>,
  'cce-1.1': cce11 as Record<string, unknown>,
  'reversal-directive-1.0': reversalDirective as Record<string, unknown>,
  'execution-result-1.0': executionResult as Record<string, unknown>,
  'db-audit-event-1.0': dbAuditEvent as Record<string, unknown>,
};

export const SCHEMA_IDS = Object.keys(SCHEMAS) as SchemaId[];
