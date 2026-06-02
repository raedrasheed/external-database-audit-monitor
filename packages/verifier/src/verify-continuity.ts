// Verifier continuity recomputation (Sprint-2 / EDAM-T142): §10 steps 4-6.
//
// Re-proves cross-segment continuity, no-missing-segment, and no-missing-event
// across a set of parsed segments, using ONLY the shared keystone (@edam/evidence)
// + verifier-local logic + the CCE completeness fields (@edam/cce-model). No
// writer/signing/anchoring/DB. Fail-closed and locating:
//   - cross_segment_continuity (§10.4, WV-4/WV-11): recompute segment_hash, verify
//     previous_segment links + boundary row chaining + genesis rule;
//   - no_missing_segment      (§10.5, WV-9): segment_sequence contiguous from the
//     scope floor, no gaps, no duplicates, no out-of-scope sequences;
//   - no_missing_event        (§10.6, WV-10): CCE-completeness corroboration —
//     gap_detected===false, expected_continuous===true, source_offset_range bound
//     to the first/last objects' consumed_offset_key, and generic non-overlap of
//     adjacent segment offset ranges. Deep engine-specific GTID/LSN/SCN gap
//     arithmetic is intentionally NOT done here (recorded as later hardening).

import { verifyCrossSegment } from '@edam/evidence';
import type { VerifierSegment, CheckOutcome } from './verify-segments.js';
import type { VerificationScope } from './input.js';

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

function outcome(offending: string[], problems: string[]): CheckOutcome {
  return offending.length > 0 || problems.length > 0
    ? { result: 'FAIL', offending_ids: dedupe(offending), details: problems.join('; ') }
    : { result: 'PASS', offending_ids: [] };
}

/** Sort a copy of the segments by segment_sequence (ascending). */
export function sortBySequence(segments: readonly VerifierSegment[]): VerifierSegment[] {
  return [...segments].sort((a, b) => a.manifest.segment_sequence - b.manifest.segment_sequence);
}

/** §10.5 no-missing-segment (WV-9): contiguity from the scope floor, no gaps, no duplicates. */
export function recomputeNoMissingSegment(segments: readonly VerifierSegment[], scope: VerificationScope): CheckOutcome {
  const offending: string[] = [];
  const problems: string[] = [];

  const bySeq = new Map<number, string[]>();
  for (const s of segments) {
    const ids = bySeq.get(s.manifest.segment_sequence) ?? [];
    ids.push(s.manifest.segment_id);
    bySeq.set(s.manifest.segment_sequence, ids);
  }

  for (const [seq, ids] of bySeq) {
    if (ids.length > 1) {
      problems.push(`duplicate segment_sequence ${seq}`);
      offending.push(...ids);
    }
  }

  const { first_segment_sequence: first, last_segment_sequence: last } = scope;
  if (first > last) problems.push(`scope first_segment_sequence (${first}) > last_segment_sequence (${last})`);

  for (let seq = first; seq <= last; seq++) {
    if (!bySeq.has(seq)) {
      problems.push(`missing segment_sequence ${seq}`);
      offending.push(`seq:${seq}`);
    }
  }
  for (const seq of bySeq.keys()) {
    if (seq < first || seq > last) {
      problems.push(`segment_sequence ${seq} outside scope [${first},${last}]`);
      offending.push(`seq:${seq}`);
    }
  }

  return outcome(offending, problems);
}

/** §10.4 cross-segment continuity (WV-4/WV-11): segment_hash recompute + link + boundary + genesis. */
export function recomputeCrossSegment(segments: readonly VerifierSegment[]): CheckOutcome {
  const sorted = sortBySequence(segments);
  const bySeq = new Map(sorted.map((s) => [s.manifest.segment_sequence, s]));
  const offending: string[] = [];
  const problems: string[] = [];

  for (const seg of sorted) {
    const seq = seg.manifest.segment_sequence;
    const previous = bySeq.get(seq - 1) ?? null;
    // The current segment's first object's prev_row_hash carries the cross-boundary
    // link (§7.4); unused for genesis. '' (no first object) fails closed for non-genesis.
    const firstPrevRowHash = seg.objects[0]?.evidence.prev_row_hash ?? '';
    const v = verifyCrossSegment(seg.manifest, firstPrevRowHash, previous ? previous.manifest : null);
    if (!v.ok) {
      offending.push(seg.manifest.segment_id);
      for (const f of v.failures) problems.push(`${seg.manifest.segment_id}: ${f.rule} ${f.detail}`);
    }
  }

  return outcome(offending, problems);
}

/** §10.6 no-missing-event (WV-10): CCE-completeness corroboration + offset-range binding + non-overlap. */
export function recomputeNoMissingEvent(segments: readonly VerifierSegment[]): CheckOutcome {
  const sorted = sortBySequence(segments);
  const offending: string[] = [];
  const problems: string[] = [];

  for (const seg of sorted) {
    const m = seg.manifest;
    const cs = m.completeness_summary;

    if (cs?.gap_detected !== false) {
      problems.push(`${m.segment_id}: completeness_summary.gap_detected !== false`);
      offending.push(m.segment_id);
    }
    if (cs?.expected_continuous !== true) {
      problems.push(`${m.segment_id}: completeness_summary.expected_continuous !== true`);
      offending.push(m.segment_id);
    }

    for (const obj of seg.objects) {
      if (obj.completeness?.gap_detected !== false) {
        problems.push(`${obj.envelope_id}: object completeness.gap_detected !== false`);
        offending.push(obj.envelope_id);
      }
    }

    // Bind source_offset_range endpoints to the first/last objects' consumed_offset_key.
    const sor = m.source_offset_range;
    const firstObj = seg.objects[0];
    const lastObj = seg.objects[seg.objects.length - 1];
    if (sor === undefined || typeof sor.first_offset_key !== 'string' || typeof sor.last_offset_key !== 'string') {
      problems.push(`${m.segment_id}: missing/invalid source_offset_range`);
      offending.push(m.segment_id);
    } else if (firstObj === undefined || lastObj === undefined) {
      problems.push(`${m.segment_id}: no objects to corroborate source_offset_range`);
      offending.push(m.segment_id);
    } else {
      if (sor.first_offset_key !== firstObj.completeness.consumed_offset_key) {
        problems.push(`${m.segment_id}: source_offset_range.first_offset_key !== first object consumed_offset_key`);
        offending.push(m.segment_id);
      }
      if (sor.last_offset_key !== lastObj.completeness.consumed_offset_key) {
        problems.push(`${m.segment_id}: source_offset_range.last_offset_key !== last object consumed_offset_key`);
        offending.push(m.segment_id);
      }
    }
  }

  // Generic cross-segment non-overlap: the next segment must not reuse the prior
  // segment's last offset (engine-agnostic). Forward-ordering arithmetic is deferred.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!.manifest.source_offset_range;
    const cur = sorted[i]!.manifest.source_offset_range;
    if (prev !== undefined && cur !== undefined && cur.first_offset_key === prev.last_offset_key) {
      problems.push(`${sorted[i]!.manifest.segment_id}: source_offset_range.first_offset_key reuses previous segment's last_offset_key (offset overlap)`);
      offending.push(sorted[i]!.manifest.segment_id);
    }
  }

  return outcome(offending, problems);
}
