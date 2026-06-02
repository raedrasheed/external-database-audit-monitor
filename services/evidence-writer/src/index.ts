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
// The pure manifest assembly (T111), row-chain verification (T112), and
// segment_hash / cross-segment continuity (T113) — plus their types — moved to
// @edam/evidence (EDAM-T110: determinism keystone shared with the independent
// verifier). The writer imports them directly from @edam/evidence; consumers that
// need those pure functions/types should import them from @edam/evidence.
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
