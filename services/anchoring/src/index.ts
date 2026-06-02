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
