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
