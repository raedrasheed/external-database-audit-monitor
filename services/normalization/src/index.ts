// @edam/normalization — Normalization Service (Epic E4).

export {
  mapCapturedRecord,
  NormalizationError,
  type CapturedRecord,
  type PrimaryKeyResolver,
} from './native-map.js';
export { TransactionAccumulator, type GroupedTransaction } from './accumulator.js';
export {
  assembleTransaction,
  combineFidelity,
  UNATTESTED_FIDELITY,
  type FidelityProvider,
  type CompletenessProvider,
} from './context.js';
export {
  correlateActor,
  type AuditEventSource,
  type DbAuditEventLike,
  type CorrelationQuery,
} from './attribution.js';
export { CceStreamGuard, type EmitAction, type GuardResult } from './dedup.js';
export { Normalizer, type NormalizerDeps, type NormalizerStats } from './normalizer.js';
