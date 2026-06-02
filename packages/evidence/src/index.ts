// @edam/evidence — pure shared evidence determinism keystone (EDAM-T110).
//
// Segment/manifest/chain-head/segment-head types + canonical manifest assembly,
// segment_hash, cross-segment continuity, row-chain verification, and canonical
// anchor-payload assembly. Reuses the SINGLE canonical serializer (@edam/canonical)
// — no second serializer. Pure; depends only on @edam/canonical, @edam/contracts,
// @edam/cce-model. Shared verbatim by the evidence writer and the independent
// verifier (no writer / WORM / signing-private / anchoring / DB coupling).

export type {
  SegmentObjectRef,
  SegmentObjectHash,
  SegmentOffsetRange,
  SegmentFidelitySummary,
  SegmentCompletenessSummary,
  PreviousSegmentRef,
  SegmentManifest,
  SegmentHead,
  ChainHead,
  AnchorPayload,
  SegmentManifestInput,
  SegmentChainInput,
} from './types.js';

export {
  buildSegmentManifest,
  assembleManifestCore,
  computeManifestHash,
  SegmentManifestError,
  type SegmentManifestCore,
  type BuildSegmentManifestOptions,
} from './manifest.js';

export {
  verifySegmentChain,
  type ChainVerification,
  type ChainFailure,
  type ChainFailureRule,
  type ObjectChainCheck,
} from './chain.js';

export {
  GENESIS_PREVIOUS_SEGMENT_HASH,
  computeSegmentHash,
  segmentHashOf,
  deriveSegmentHead,
  verifyCrossSegment,
  type CrossSegmentVerification,
  type CrossSegmentFailure,
  type CrossSegmentFailureRule,
} from './cross-segment.js';

export {
  ANCHOR_PAYLOAD_DOMAIN,
  assertValidAnchorPayload,
  buildAnchorPayload,
  serializeAnchorPayload,
  anchorPayloadBytes,
  anchorSigningMessage,
  anchorPayloadHash,
  type AnchorPayloadOptions,
} from './anchor-payload.js';
