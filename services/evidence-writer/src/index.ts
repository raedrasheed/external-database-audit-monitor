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
