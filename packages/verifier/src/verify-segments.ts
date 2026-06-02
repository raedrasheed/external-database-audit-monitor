// Verifier recomputation (Sprint-2 / EDAM-T141): §10 steps 1-3.
//
// Re-proves a segment from PUBLIC inputs (its parsed manifest + ordered CCE
// objects) using ONLY the shared determinism keystone (@edam/evidence) and the
// CCE hash recompute (@edam/cce-model) — no second serializer, no writer/
// signing/anchoring/DB. Produces the three §10 check outcomes:
//   - per_object_hash      (§10.1, WV-1/WV-2): event_hash recomputes per object;
//   - object_chain         (§10.2, WV-4): row_hash linkage + list alignment/order;
//   - segment_manifest     (§10.3, WV-1): manifest_hash recomputes + field /
//                          object cross-checks.
// Fail-closed and tamper-locating: every failure records the offending ids.
// No cryptographic signature/anchor verification here (that is T143).

import type { Cce } from '@edam/cce-model';
import { validateEvidenceSegmentManifest } from '@edam/contracts';
import {
  verifySegmentChain,
  computeManifestHash,
  type SegmentManifest,
  type SegmentManifestCore,
  type SegmentChainInput,
} from '@edam/evidence';
import type { AnchorRecord } from './verify-anchor.js';

/** A parsed segment ready for re-verification: its manifest + the ordered objects it covers. */
export interface VerifierSegment {
  manifest: SegmentManifest;
  /** Ordered CCE objects, index-aligned with `manifest.object_list` / `object_hash_list`. */
  objects: readonly Cce[];
  /** Optional parsed anchor-record-1.0 for this segment's head (§10 steps 7-8; T143). */
  anchorRecord?: AnchorRecord;
}

/** A single check outcome with located offending ids. */
export interface CheckOutcome {
  result: 'PASS' | 'FAIL';
  offending_ids: string[];
  details?: string;
}

/** The §10 steps 1-3 outcomes for one segment. */
export interface SegmentRecomputeResult {
  per_object_hash: CheckOutcome;
  object_chain: CheckOutcome;
  segment_manifest: CheckOutcome;
}

function pass(): CheckOutcome {
  return { result: 'PASS', offending_ids: [] };
}

function fail(offending_ids: string[], details: string): CheckOutcome {
  return { result: 'FAIL', offending_ids, details };
}

/** §10.3 manifest integrity: recompute manifest_hash + intra-manifest + object cross-checks. */
function recomputeManifest(segment: VerifierSegment): CheckOutcome {
  const manifest = segment.manifest;
  const problems: string[] = [];

  const schema = validateEvidenceSegmentManifest(manifest);
  if (!schema.valid) {
    problems.push(`schema: ${schema.errors.map((e) => e.instancePath || e.keyword).join(', ')}`);
  }

  // manifest_hash recompute over the same canonical core the writer hashed.
  const { manifest_hash, ...core } = manifest;
  if (computeManifestHash(core as SegmentManifestCore) !== manifest_hash) {
    problems.push('manifest_hash does not recompute over the canonical core');
  }

  const ol = manifest.object_list ?? [];
  const ohl = manifest.object_hash_list ?? [];
  const n = ol.length;
  if (manifest.event_count !== n) problems.push(`event_count (${manifest.event_count}) !== object_list.length (${n})`);
  if (ohl.length !== n) problems.push(`object_hash_list.length (${ohl.length}) !== object_list.length (${n})`);
  // T141-M1: the provided object set must EXACTLY match the manifest's lists —
  // a truncated or extra object set must fail closed (not just the empty case).
  if (segment.objects.length !== n) problems.push(`objects.length (${segment.objects.length}) !== object_list.length (${n})`);
  if (segment.objects.length !== ohl.length) problems.push(`objects.length (${segment.objects.length}) !== object_hash_list.length (${ohl.length})`);

  for (let i = 0; i < n; i++) {
    if (ol[i]!.seq !== i) problems.push(`object_list[${i}].seq !== ${i}`);
    if (ohl[i]?.seq !== i) problems.push(`object_hash_list[${i}].seq !== ${i}`);
  }

  if (n >= 1) {
    if (manifest.first_envelope_id !== ol[0]!.object_id) problems.push('first_envelope_id !== object_list[0].object_id');
    if (manifest.last_envelope_id !== ol[n - 1]!.object_id) problems.push('last_envelope_id !== object_list[last].object_id');
    if (manifest.first_row_hash !== ohl[0]?.row_hash) problems.push('first_row_hash !== object_hash_list[0].row_hash');
    if (manifest.last_row_hash !== ohl[n - 1]?.row_hash) problems.push('last_row_hash !== object_hash_list[last].row_hash');
  }

  // Bind the manifest to the actual objects it claims to cover.
  const m = Math.min(n, segment.objects.length);
  for (let i = 0; i < m; i++) {
    const obj = segment.objects[i]!;
    if (ol[i]!.object_id !== obj.envelope_id) problems.push(`object_list[${i}].object_id !== objects[${i}].envelope_id`);
    if (ohl[i]?.event_hash !== obj.evidence.event_hash) problems.push(`object_hash_list[${i}].event_hash !== objects[${i}].evidence.event_hash`);
    if (ohl[i]?.row_hash !== obj.evidence.row_hash) problems.push(`object_hash_list[${i}].row_hash !== objects[${i}].evidence.row_hash`);
  }

  return problems.length > 0 ? fail([manifest.segment_id], problems.join('; ')) : pass();
}

/**
 * Re-verify §10 steps 1-3 for a single segment. Fail-closed: every check FAILs
 * with located offending ids on any mismatch (a tampered object/manifest or a
 * broken chain is detected and located). Performs NO signature/anchor verification.
 */
export function recomputeSegment(segment: VerifierSegment): SegmentRecomputeResult {
  const segId = segment.manifest.segment_id;

  if (segment.objects.length === 0) {
    const empty = fail([segId], 'segment has no objects');
    return { per_object_hash: empty, object_chain: empty, segment_manifest: recomputeManifest(segment) };
  }

  const chainInput: SegmentChainInput = {
    object_list: segment.manifest.object_list,
    object_hash_list: segment.manifest.object_hash_list,
    objects: segment.objects,
  };
  const chain = verifySegmentChain(chainInput);

  // §10.1 per-object event_hash recompute (WV-1/WV-2).
  const eventHashFails = chain.checks.filter((c) => !c.event_hash_ok).map((c) => c.object_id);
  const per_object_hash = eventHashFails.length > 0 ? fail(eventHashFails, 'event_hash does not recompute over the canonical core') : pass();

  // §10.2 object chain: row_hash linkage + list alignment/order (WV-4).
  const chainFails = chain.checks
    .filter((c) => !(c.row_hash_ok && c.prev_link_ok && c.hash_list_ok && c.order_ok))
    .map((c) => c.object_id);
  const chainDetail = chain.failures
    .filter((f) => f.rule !== 'EVENT_HASH')
    .map((f) => f.detail)
    .join('; ');
  const object_chain = chainFails.length > 0 ? fail(chainFails, chainDetail || 'object chain linkage/alignment failed') : pass();

  return { per_object_hash, object_chain, segment_manifest: recomputeManifest(segment) };
}
