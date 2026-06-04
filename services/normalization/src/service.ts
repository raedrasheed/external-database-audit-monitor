// Normalization SERVICE composition helpers (R-11c). Wires the existing Normalizer
// (mapCapturedRecord -> assemble -> buildCce) into a runnable service with MINIMAL
// pilot providers — no architectural redesign. Stage: CapturedRecord (bus) -> CCE (bus).
//
// PILOT BOUNDARY: fidelity defaults to UNATTESTED (DEGRADED) unless the operator supplies
// an attested source config (pre-flight verifies ROW/FULL/GTID); completeness is the
// no-attestation default; actor attribution is unattributed (no audit source wired).
import type { Cce, NormalizedFidelity } from '@edam/cce-model';
import type { DlqService } from '@edam/dlq';
import { Normalizer } from './normalizer.js';
import type { PrimaryKeyResolver } from './native-map.js';
import type { FidelityProvider, CompletenessProvider } from './context.js';

/**
 * A primary-key resolver from a static map. `PK_MAP` is JSON keyed by `schema.table`
 * (or bare `table`); falls back to `['id']`. Minimal for the pilot — Debezium row images
 * carry the PK columns; a richer schema-registry resolver is a later enhancement.
 */
export function parsePkResolver(pkMapJson: string | undefined): PrimaryKeyResolver {
  let map: Record<string, string[]> = {};
  if (pkMapJson) {
    const parsed: unknown = JSON.parse(pkMapJson);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('PK_MAP must be a JSON object {"schema.table":["col",...]}');
    map = parsed as Record<string, string[]>;
  }
  return (schema, table) => map[`${schema}.${table}`] ?? map[table] ?? ['id'];
}

/** A fixed fidelity provider (or `null` ⇒ UNATTESTED/DEGRADED in assembly). */
export function staticFidelityProvider(fidelity: NormalizedFidelity | null): FidelityProvider {
  return { current: () => fidelity };
}

/** No-attestation completeness provider (assembly applies the default). */
export function nullCompletenessProvider(): CompletenessProvider {
  return { current: () => null };
}

export interface NormalizationConfig {
  /** Optional `schema.table -> [pk cols]` JSON (else `['id']`). */
  pkMap?: string;
  /** Fields to redact in the CCE (CCE §5). */
  sensitiveFields?: string[];
  /** Operator-attested source fidelity (pre-flight verified) or null ⇒ DEGRADED. */
  fidelity?: NormalizedFidelity | null;
}

/** Build a Normalizer with the minimal pilot providers + the supplied CCE sink + DLQ. */
export function makeNormalizer(cfg: NormalizationConfig, emit: (cce: Cce) => void | Promise<void>, dlq: DlqService): Normalizer {
  return new Normalizer({
    pkResolver: parsePkResolver(cfg.pkMap),
    fidelity: staticFidelityProvider(cfg.fidelity ?? null),
    completeness: nullCompletenessProvider(),
    sensitiveFields: cfg.sensitiveFields,
    dlq,
    emit,
  });
}
