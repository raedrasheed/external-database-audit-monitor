// Sensitive-field masking (Epic E4 / EDAM-T030).
//
// Masks configured sensitive columns BEFORE they ever leave the builder — in
// both the before/after images and the field_changes. data_type is computed
// from the original value (in the diff, before masking), so masking does not
// erase type information. A masked value becomes "***"; null stays null.
// Sensitive raw values never appear in a CCE.

import type { CceFieldChange } from './types.js';

export const MASK = '***';

/** Match a column against the sensitive set by full / table / bare name. */
export function isSensitiveColumn(
  column: string,
  schema: string,
  table: string,
  sensitive: Set<string>,
): boolean {
  return (
    sensitive.has(`${schema}.${table}.${column}`) ||
    sensitive.has(`${table}.${column}`) ||
    sensitive.has(column)
  );
}

export function maskImage(
  image: Record<string, unknown> | null,
  schema: string,
  table: string,
  sensitive: Set<string>,
): Record<string, unknown> | null {
  if (image === null) return null;
  if (sensitive.size === 0) return { ...image };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(image)) {
    out[k] = v !== null && v !== undefined && isSensitiveColumn(k, schema, table, sensitive) ? MASK : v;
  }
  return out;
}

export function maskFieldChanges(
  fieldChanges: CceFieldChange[] | undefined,
  schema: string,
  table: string,
  sensitive: Set<string>,
): CceFieldChange[] | undefined {
  if (!fieldChanges) return fieldChanges;
  return fieldChanges.map((fc) => {
    const column = fc.path[0] ?? '';
    if (!isSensitiveColumn(column, schema, table, sensitive)) return fc;
    return {
      ...fc,
      sensitive: true,
      masked: true,
      old: fc.old === null || fc.old === undefined ? null : MASK,
      new: fc.new === null || fc.new === undefined ? null : MASK,
    };
  });
}
