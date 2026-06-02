// @edam/evidence-writer — Domain-B append-only evidence writer (Sprint-2 / EDAM-T106).
export { EvidenceWriter, evidenceObjectKey, type EvidenceWriterDeps } from './writer.js';
export {
  type EvidenceObjectType,
  type AppendableObject,
  type EvidencePlacement,
  type AppendResult,
  type AppendOutcome,
} from './types.js';
// Segment accumulator (Sprint-2 / EDAM-T107). Prepares segment state + marks
// SEALING-ready; does NOT seal / hash-chain (that is E2B).
export {
  SegmentAccumulator,
  type SegmentCaps,
  type AccumulatorDeps,
  type SealTrigger,
  type SealReadySegment,
  type SegmentObjectRef,
  type SegmentObjectHash,
  type AddResult,
} from './accumulator.js';
// Evidence segment manifest builder (Sprint-2 / EDAM-T111). Builds the §6
// manifest core + manifest_hash + validation; no segment_hash / linkage / seal.
export {
  buildSegmentManifest,
  SegmentManifestError,
  type SegmentManifest,
  type PreviousSegmentRef,
  type BuildSegmentManifestOptions,
} from './manifest.js';
// Intra-segment row-hash chain verification (Sprint-2 / EDAM-T112). Fail-closed
// re-verify; no segment_hash / cross-segment linkage / seal / WORM write.
export {
  verifySegmentChain,
  type ChainVerification,
  type ChainFailure,
  type ChainFailureRule,
  type ObjectChainCheck,
} from './chain.js';
// Segment hash + genesis + cross-segment linkage (Sprint-2 / EDAM-T113).
// Pure, fail-closed; no manifest/seal/WORM/lifecycle/signing/anchoring.
export {
  GENESIS_PREVIOUS_SEGMENT_HASH,
  computeSegmentHash,
  segmentHashOf,
  deriveSegmentHead,
  verifyCrossSegment,
  type SegmentHead,
  type CrossSegmentVerification,
  type CrossSegmentFailure,
  type CrossSegmentFailureRule,
} from './cross-segment.js';
// Seal transition + chain-head emit (Sprint-2 / EDAM-T114). Establishes the
// chain, verifies (T112/T113), writes objects + manifest immutably, emits the
// head to the signing stage. No signing / no anchoring / no ANCHORED state.
export {
  SegmentSealer,
  establishChain,
  manifestObjectKey,
  type SegmentSealerDeps,
  type SealOutcome,
  type PreviousSealed,
  type SealAlarm,
  type SealAlarmSink,
} from './sealer.js';
