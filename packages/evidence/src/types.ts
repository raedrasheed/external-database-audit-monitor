// Shared pure evidence types (Sprint-2 / EDAM-T110).
//
// Single source of truth for the segment/manifest/chain-head/segment-head data
// shapes and the structural INPUTS to the pure assembly/verification helpers,
// shared verbatim by the evidence writer and the (future) independent verifier.
// No I/O, no writer/WORM/signing coupling — these are plain data contracts.

import type { Cce } from '@edam/cce-model';

/** A manifest object_list entry (WORM §6). */
export interface SegmentObjectRef {
  seq: number;
  object_id: string;
  worm_object_key: string;
  object_type: 'cce';
}

/** A manifest object_hash_list entry (WORM §6). */
export interface SegmentObjectHash {
  seq: number;
  event_hash: string;
  row_hash: string;
}

export interface SegmentOffsetRange {
  first_offset_key: string;
  last_offset_key: string;
  consumed_gtid_set?: string;
}

export interface SegmentFidelitySummary {
  all_healthy: boolean;
  degraded_count: number;
  compromised_count: number;
  reasons: string[];
}

export interface SegmentCompletenessSummary {
  gap_detected: boolean;
  expected_continuous: boolean;
  notes: string[];
}

/** Cross-segment link target (the prior segment). Supplied by the seal/chain step; never computed by the builder. */
export interface PreviousSegmentRef {
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
}

/** The WORM §6 evidence-segment-manifest (core fields + manifest_hash). */
export interface SegmentManifest {
  manifest_version: 'evidence-segment-manifest-1.0';
  segment_id: string;
  db_id: string;
  engine: string;
  segment_sequence: number;
  opened_at: string;
  sealed_at: string;
  event_count: number;
  first_envelope_id: string;
  last_envelope_id: string;
  first_row_hash: string;
  last_row_hash: string;
  object_list: SegmentObjectRef[];
  object_hash_list: SegmentObjectHash[];
  source_offset_range: SegmentOffsetRange;
  fidelity_summary: SegmentFidelitySummary;
  completeness_summary: SegmentCompletenessSummary;
  previous_segment: PreviousSegmentRef | null;
  manifest_hash: string;
}

/** The cryptographic tip of a sealed segment (WORM §7.5). */
export interface SegmentHead {
  db_id: string;
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
  last_row_hash: string;
}

/**
 * The cryptographic tip of a sealed segment as the signing stage consumes it
 * (WORM §7.5). Structurally identical to SegmentHead; kept distinct so the
 * signing/anchoring layer names its input `ChainHead`.
 */
export interface ChainHead {
  db_id: string;
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
  last_row_hash: string;
}

/** The anchor payload the signer signs (WORM §8): a hash structure, never plaintext. */
export interface AnchorPayload {
  db_id: string;
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
  last_row_hash: string;
  head_count: number;
  signed_at: string;
}

/**
 * Structural input to `buildSegmentManifest` — exactly the segment metadata the
 * builder reads. The writer's `SealReadySegment` satisfies this structurally
 * (it carries these fields plus transport-only extras); the verifier never
 * builds a manifest, so it does not use this.
 */
export interface SegmentManifestInput {
  db_id: string;
  engine: string;
  segment_id: string;
  segment_sequence: number;
  opened_at: string;
  event_count: number;
  first_envelope_id: string;
  last_envelope_id: string;
  first_row_hash: string;
  last_row_hash: string;
  object_list: SegmentObjectRef[];
  object_hash_list: SegmentObjectHash[];
  source_offset_range: SegmentOffsetRange;
  fidelity_summary: SegmentFidelitySummary;
  completeness_summary: SegmentCompletenessSummary;
  /** Transport-only ordered objects, index-aligned with the lists. Never hashed. */
  objects: readonly Cce[];
}

/**
 * Structural input to `verifySegmentChain` — the ordered objects plus their
 * index-aligned list entries. Both the writer (from a SealReadySegment) and the
 * verifier (from WORM reads) satisfy this.
 */
export interface SegmentChainInput {
  object_list: SegmentObjectRef[];
  object_hash_list: SegmentObjectHash[];
  objects: readonly Cce[];
}
