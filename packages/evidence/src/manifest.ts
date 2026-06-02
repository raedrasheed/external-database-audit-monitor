// Evidence segment manifest assembly (Sprint-2 / EDAM-T110; logic from T111).
//
// Pure, shared by the writer (BUILD) and the verifier (RECOMPUTE). Assembles the
// WORM §6 evidence-segment-manifest core from segment METADATA (never transport
// `objects` payloads) and computes manifest_hash with the SINGLE canonical
// serializer (@edam/canonical) — byte-for-byte reproducible — then validates
// against the vendored schema. `assembleManifestCore` + `computeManifestHash`
// are exported so the verifier recomputes manifest_hash via the EXACT same path.
//
// Out of scope (as in T111): segment_hash, cross-segment linkage, sealing,
// signing, anchoring, WORM writes. `sealed_at` and (non-genesis) `previous_segment`
// are INPUTS; this builder only PLACES them.

import { serializeCanonical, eventHash } from '@edam/canonical';
import { validateEvidenceSegmentManifest } from '@edam/contracts';
import type { PreviousSegmentRef, SegmentManifest, SegmentManifestInput } from './types.js';

export type { PreviousSegmentRef } from './types.js';

/** The manifest CORE (all §6 fields except manifest_hash). */
export type SegmentManifestCore = Omit<SegmentManifest, 'manifest_hash'>;

export interface BuildSegmentManifestOptions {
  /** Seal timestamp (RFC3339). Supplied by the seal step; this only stamps it. */
  sealedAt: string;
  /** Prior segment link (non-genesis). Supplied by the chain step; null/omitted for genesis. */
  previousSegment?: PreviousSegmentRef | null;
}

export class SegmentManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentManifestError';
  }
}

/**
 * Internal-consistency cross-checks over the segment metadata.
 * Undefined-safe: a length mismatch yields a clean problem string, never a throw.
 */
function crossCheck(seg: SegmentManifestInput): string[] {
  const problems: string[] = [];
  const n = seg.object_list.length;
  if (n < 1) problems.push('event_count must be >= 1 (empty segment)');
  if (seg.event_count !== n) problems.push(`event_count (${seg.event_count}) !== object_list.length (${n})`);
  if (seg.object_hash_list.length !== n) problems.push(`object_hash_list.length (${seg.object_hash_list.length}) !== object_list.length (${n})`);
  if (seg.objects.length !== n) problems.push(`objects.length (${seg.objects.length}) !== object_list.length (${n})`);

  for (let i = 0; i < n; i++) {
    const ref = seg.object_list[i]!; // exists: i < n = object_list.length
    const h = seg.object_hash_list[i];
    const obj = seg.objects[i];
    if (ref.seq !== i) problems.push(`object_list[${i}].seq !== ${i}`);
    if (h === undefined) {
      problems.push(`object_hash_list[${i}] missing`);
    } else if (h.seq !== i) {
      problems.push(`object_hash_list[${i}].seq !== ${i}`);
    }
    // L1: per-index object_list <-> object_hash_list <-> objects correspondence.
    if (obj === undefined) {
      problems.push(`objects[${i}] missing`);
    } else {
      if (ref.object_id !== obj.envelope_id) problems.push(`object_list[${i}].object_id !== objects[${i}].envelope_id`);
      if (h !== undefined && h.event_hash !== obj.evidence.event_hash) problems.push(`object_hash_list[${i}].event_hash !== objects[${i}].evidence.event_hash`);
      if (h !== undefined && h.row_hash !== obj.evidence.row_hash) problems.push(`object_hash_list[${i}].row_hash !== objects[${i}].evidence.row_hash`);
    }
  }

  if (n >= 1) {
    const first = seg.object_list[0];
    const last = seg.object_list[n - 1];
    const h0 = seg.object_hash_list[0];
    const hl = seg.object_hash_list[n - 1];
    if (first && seg.first_envelope_id !== first.object_id) problems.push('first_envelope_id !== object_list[0].object_id');
    if (last && seg.last_envelope_id !== last.object_id) problems.push('last_envelope_id !== object_list[last].object_id');
    if (h0 === undefined) problems.push('object_hash_list[0] missing (first_row_hash uncheckable)');
    else if (seg.first_row_hash !== h0.row_hash) problems.push('first_row_hash !== object_hash_list[0].row_hash');
    if (hl === undefined) problems.push('object_hash_list[last] missing (last_row_hash uncheckable)');
    else if (seg.last_row_hash !== hl.row_hash) problems.push('last_row_hash !== object_hash_list[last].row_hash');
  }
  return problems;
}

/** Resolve the genesis-aware previous_segment from the options (structural, not linkage). */
function resolvePreviousSegment(seg: SegmentManifestInput, opts: BuildSegmentManifestOptions): PreviousSegmentRef | null {
  const genesis = seg.segment_sequence === 0;
  if (genesis && opts.previousSegment) {
    throw new SegmentManifestError('genesis segment (segment_sequence 0) must not have a previous_segment');
  }
  if (!genesis && !opts.previousSegment) {
    throw new SegmentManifestError(`non-genesis segment (segment_sequence ${seg.segment_sequence}) requires a previous_segment`);
  }
  return genesis ? null : opts.previousSegment!;
}

/**
 * Assemble the manifest CORE (all §6 fields except manifest_hash) by explicit
 * field selection, DEEP-COPYING every embedded sub-structure so the core shares
 * no mutable reference with the input. The transport-only `objects` payloads are
 * NEVER included.
 */
export function assembleManifestCore(seg: SegmentManifestInput, opts: BuildSegmentManifestOptions): SegmentManifestCore {
  const previous_segment = resolvePreviousSegment(seg, opts);
  return {
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
    object_list: structuredClone(seg.object_list),
    object_hash_list: structuredClone(seg.object_hash_list),
    source_offset_range: structuredClone(seg.source_offset_range),
    fidelity_summary: structuredClone(seg.fidelity_summary),
    completeness_summary: structuredClone(seg.completeness_summary),
    previous_segment: previous_segment === null ? null : structuredClone(previous_segment),
  };
}

/** manifest_hash = eventHash(canonical(core)) — the single canonical serializer (CCE §12.7). */
export function computeManifestHash(core: SegmentManifestCore): string {
  return eventHash(serializeCanonical(core));
}

/**
 * Build + validate the evidence-segment-manifest for a segment. The manifest core
 * is hashed with the canonical serializer (byte-for-byte reproducible). Throws
 * SegmentManifestError on a cross-check failure or an invalid manifest (no
 * fabrication). Returns a deep-frozen manifest.
 */
export function buildSegmentManifest(seg: SegmentManifestInput, opts: BuildSegmentManifestOptions): SegmentManifest {
  const problems = crossCheck(seg);
  if (problems.length > 0) {
    throw new SegmentManifestError(`inconsistent SealReadySegment: ${problems.join('; ')}`);
  }

  const core = assembleManifestCore(seg, opts);
  const manifest_hash = computeManifestHash(core);
  const manifest: SegmentManifest = { ...core, manifest_hash };

  const result = validateEvidenceSegmentManifest(manifest);
  if (!result.valid) {
    throw new SegmentManifestError(
      `built segment manifest failed validation: ${result.errors.map((e) => e.instancePath || e.keyword).join(', ')}`,
    );
  }

  return deepFreeze(manifest);
}

/** Recursively freeze an object graph (arrays + nested objects). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
