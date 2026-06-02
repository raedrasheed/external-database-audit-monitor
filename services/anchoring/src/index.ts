// @edam/anchoring — external anchoring (Sprint-2 / EDAM-T130).
// AnchorProvider abstraction over the frozen {rfc3161, transparency_log,
// dual_custodian} enum. Provider sees only a hash; ANCHORED only after a verified
// token; no fabrication on failure. Interface + fail-closed guard + dev fake.
// Anchor-record builder, state machine, retry/cadence, and real TSA are later
// E2D tasks.

export {
  ANCHOR_PROVIDER_TYPES,
  AnchorTimeoutError,
  AnchorOutageError,
  type AnchorProviderType,
  type AnchorRequest,
  type AnchorProviderProof,
  type AnchorToken,
  type AnchorPendingReason,
  type AnchorFailureReason,
  type AnchorOutcome,
  type AnchorProvider,
} from './types.js';
export { anchorRequestFor } from './request.js';
export {
  requestAnchor,
  isAnchored,
  isWellFormedToken,
  AnchorProviderRegistry,
  DEFAULT_ANCHOR_TIMEOUT_MS,
  type RequestAnchorOptions,
} from './anchor-service.js';
export { FakeAnchorProvider, type FakeAnchorMode, type FakeAnchorProviderOptions } from './fake-provider.js';
export {
  DevRfc3161Provider,
  verifyRfc3161Token,
  type DevRfc3161ProviderOptions,
  type DevTsaCertificate,
  type TstInfo,
  type Rfc3161VerifyResult,
} from './rfc3161.js';
export {
  DevTransparencyLogProvider,
  verifyTransparencyLogToken,
  type DevTransparencyLogProviderOptions,
  type DevLogCertificate,
  type SignedTreeHead,
  type TransparencyLogVerifyResult,
} from './transparency-log.js';
export {
  buildAnchorRecord,
  buildAnchorRef,
  UnverifiedAnchorError,
  AnchorHeadMismatchError,
  AnchorRecordSchemaError,
  type AnchorRecord,
  type AnchorRecordHead,
  type AnchorRecordHsmSignature,
  type AnchorRef,
  type BuildAnchorRecordInput,
} from './anchor-record.js';
export {
  anchorIdFor,
  nextBackoffMs,
  systemClock,
  DEFAULT_RETRY_POLICY,
  AnchorCoordinator,
  InMemoryAnchorRecordStore,
  AnchorIdCollisionError,
  CadencePolicy,
  UnanchoredWindowMonitor,
  type Clock,
  type SleepFn,
  type RetryPolicy,
  type AnchorRecordStore,
  type CoordinatorOutcome,
  type AnchorHeadInput,
  type AnchorCoordinatorOptions,
  type CadenceConfig,
  type AlarmSeverity,
  type WindowAlarm,
  type WindowMonitorOptions,
} from './retry-cadence.js';
