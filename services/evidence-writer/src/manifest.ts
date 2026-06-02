// Evidence segment manifest builder (Sprint-2 / EDAM-T111).
//
// Assembles the WORM §6 evidence-segment-manifest core from a SealReadySegment's
// METADATA (never its transport-only `objects` payloads) and computes
// manifest_hash deterministically with the single canonical serializer
// (@edam/canonical), then validates against the vendored schema.
//
// In scope (T111): build the manifest core + manifest_hash + validate.
// OUT of scope (deliberately NOT done here): segment_hash, cross-segment linkage
// (the prior segment's segment_hash), the sealing transition, signing, anchoring,
// and any WORM write. `sealed_at` and (for non-genesis segments) `previous_segment`
// are INPUTS supplied by the seal/chain step (E2B/T113/T114); this builder only
// PLACES them — it never computes linkage. For the genesis segment
// (segment_sequence === 0) the schema mandates previous_segment === null, which
// is structural (not linkage) and is handled here.

import { serializeCanonical, eventHash } from '@edam/canonical';
import { validateEvidenceSegmentManifest } from '@edam/contracts';
import type { SealReadySegment, SegmentObjectHash, SegmentObjectRef } from './accumulator.js';

/** Cross-segment link target (the prior segment). Supplied by T113; not computed here. */
export interface PreviousSegmentRef {
  segment_id: string;
  segment_sequence: number;
  segment_hash: string;
}

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
  source_offset_range: { first_offset_key: string; last_offset_key: string; consumed_gtid_set?: string };
  fidelity_summary: { all_healthy: boolean; degraded_count: number; compromised_count: number; reasons: string[] };
  completeness_summary: { gap_detected: boolean; expected_continuous: boolean; notes: string[] };
  previous_segment: PreviousSegmentRef | null;
  manifest_hash: string;
}

export interface BuildSegmentManifestOptions {
  /** Seal timestamp (RFC3339). Supplied by the seal step; T111 only stamps it. */
  sealedAt: string;
  /** Prior segment link (non-genesis). Supplied by T113; null/omitted for genesis. */
  previousSegment?: PreviousSegmentRef | null;
}

export class SegmentManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentManifestError';
  }
}

/** Internal-consistency cross-checks over the SealReadySegment metadata. */
function crossCheck(seg: SealReadySegment): string[] {
  const problems: string[] = [];
  const n = seg.object_list.length;
  if (n < 1) problems.push('event_count must be >= 1 (empty segment)');
  if (seg.event_count !== n) problems.push(`event_count (${seg.event_count}) !== object_list.length (${n})`);
  if (seg.object_hash_list.length !== n) problems.push(`object_hash_list.length (${seg.object_hash_list.length}) !== object_list.length (${n})`);
  for (let i = 0; i < n; i++) {
    if (seg.object_list[i]!.seq !== i) problems.push(`object_list[${i}].seq !== ${i}`);
    if (seg.object_hash_list[i]?.seq !== i) problems.push(`object_hash_list[${i}].seq !== ${i}`);
  }
  if (n >= 1) {
    if (seg.first_envelope_id !== seg.object_list[0]!.object_id) problems.push('first_envelope_id !== object_list[0].object_id');
    if (seg.last_envelope_id !== seg.object_list[n - 1]!.object_id) problems.push('last_envelope_id !== object_list[last].object_id');
    if (seg.first_row_hash !== seg.object_hash_list[0]!.row_hash) problems.push('first_row_hash !== object_hash_list[0].row_hash');
    if (seg.last_row_hash !== seg.object_hash_list[n - 1]!.row_hash) problems.push('last_row_hash !== object_hash_list[last].row_hash');
  }
  return problems;
}

/**
 * Build + validate the evidence-segment-manifest for a SealReadySegment. The
 * manifest core is hashed with the canonical serializer (CCE §12.7) — byte-for-byte
 * reproducible. The transport-only `segment.objects` payloads are NEVER included
 * (the manifest is assembled by explicit field selection; the schema's
 * additionalProperties:false is the backstop). Throws SegmentManifestError on a
 * cross-check failure or an invalid manifest (no fabrication).
 */
export function buildSegmentManifest(seg: SealReadySegment, opts: BuildSegmentManifestOptions): SegmentManifest {
  const problems = crossCheck(seg);
  if (problems.length > 0) {
    throw new SegmentManifestError(`inconsistent SealReadySegment: ${problems.join('; ')}`);
  }

  const genesis = seg.segment_sequence === 0;
  if (genesis && opts.previousSegment) {
    throw new SegmentManifestError('genesis segment (segment_sequence 0) must not have a previous_segment');
  }
  if (!genesis && !opts.previousSegment) {
    throw new SegmentManifestError(`non-genesis segment (segment_sequence ${seg.segment_sequence}) requires a previous_segment`);
  }
  const previous_segment: PreviousSegmentRef | null = genesis ? null : opts.previousSegment!;

  // The manifest CORE = all §6 fields except manifest_hash (explicit selection;
  // `objects`/`closed_at`/`trigger` are intentionally omitted).
  const core = {
    manifest_version: 'evidence-segment-manifest-1.0' as const,
    segment_id: seg.segment_id,
    db_id: seg.db_id,
    engine: seg.engine,
    segment_sequence: seg.segment_sequence,
    opened_at: seg.opened_at,
    sealed_at: opts.sealedAt,
    event_count: seg.event_count,
    first_envelope_id: seg.first_envelope_id,
    last_envelope_id: seg.last_envelope_id,
    first_row_hash: seg.first_row_hash,
    last_row_hash: seg.last_row_hash,
    object_list: seg.object_list,
    object_hash_list: seg.object_hash_list,
    source_offset_range: seg.source_offset_range,
    fidelity_summary: seg.fidelity_summary,
    completeness_summary: seg.completeness_summary,
    previous_segment,
  };

  const manifest_hash = eventHash(serializeCanonical(core));
  const manifest: SegmentManifest = { ...core, manifest_hash };

  const result = validateEvidenceSegmentManifest(manifest);
  if (!result.valid) {
    throw new SegmentManifestError(
      `built segment manifest failed validation: ${result.errors.map((e) => e.instancePath || e.keyword).join(', ')}`,
    );
  }
  return manifest;
}
