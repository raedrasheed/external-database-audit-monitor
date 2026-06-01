// @edam/dlq — Dead Letter Queue & failure isolation (Epic E5).

export * from './types.js';
export { stableStringify, payloadHash, deterministicEventId } from './hash.js';
export {
  type DlqStore,
  type DlqFilter,
  type PgLike,
  InMemoryDlqStore,
  PgDlqStore,
} from './store.js';
export { classifyFailure, DEFAULT_RETRYABLE, type Classification } from './classify.js';
export { decideStatus, DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry.js';
export {
  type DlqAlarm,
  type DlqAlarmKind,
  type DlqAlarmSeverity,
  type DlqAlarmSink,
  InMemoryDlqAlarmSink,
  ConsoleDlqAlarmSink,
} from './alarms.js';
export { DlqService, type DlqServiceDeps } from './service.js';
