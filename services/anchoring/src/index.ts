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
export { DevRfc3161Provider, type DevRfc3161ProviderOptions } from './rfc3161.js';
export { DevTransparencyLogProvider, type DevTransparencyLogProviderOptions } from './transparency-log.js';
// The pure RFC-3161 + transparency-log verifiers and their proof/cert/result
// types moved to @edam/anchor-proof (shared with the independent verifier;
// single implementation, no builder<->verifier drift). Re-exported here so the
// @edam/anchoring public API is unchanged for existing consumers.
export {
  verifyRfc3161Token,
  verifyTransparencyLogToken,
  type DevTsaCertificate,
  type TstInfo,
  type Rfc3161VerifyResult,
  type DevLogCertificate,
  type SignedTreeHead,
  type TransparencyLogVerifyResult,
  type TransparencyLogProof,
} from '@edam/anchor-proof';
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
