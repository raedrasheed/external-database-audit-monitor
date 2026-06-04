// Evidence Export Package builder (EDAM-T145): §12.1 assembly + §12.2 continuity.
//
// Pure producer: assemble a schema-valid evidence-export-package-1.0 with
// genesis-rooted continuity-preserving selection, compute package_hash over the
// canonical package (minus the signature), sign via the injected ExportSigner,
// and validate against the vendored schema. Fail-closed: refuses gapped /
// cherry-picked / uncovered selections and any schema-invalid result. Depends
// only on @edam/canonical + @edam/contracts. WORM write is a separate optional
// helper over an injected port (no concrete WORM implementation imported).

import { serializeCanonical, eventHash } from '@edam/canonical';
import { validateEvidenceExportPackage } from '@edam/contracts';
import type {
  BuildExportInput,
  EvidenceExportPackage,
  ExportPackageWithoutSignature,
  ExportSignature,
  WormPutOptions,
  WormWritePort,
} from './types.js';

/** Fixed domain tag for the export-signing message (signature scope; not the schema field). */
export const EXPORT_SIGNATURE_DOMAIN = 'edam-evidence-export-package-v1';

/** The exact bytes an ExportSigner signs: `${EXPORT_SIGNATURE_DOMAIN}:${package_hash}`. Shared with the future verifier. */
export function exportSigningMessage(packageHash: string): Uint8Array {
  return new TextEncoder().encode(`${EXPORT_SIGNATURE_DOMAIN}:${packageHash}`);
}

/** Raised when the export cannot be assembled (continuity violation) or fails schema validation. Fail-closed. */
export class ExportPackageError extends Error {
  constructor(message: string, public readonly problems?: unknown) {
    super(message);
    this.name = 'ExportPackageError';
  }
}

/**
 * Continuity-preserving (genesis-rooted) selection check (§12.2). The supplied
 * segments must be contiguous from sequence 0 through the maximum covering
 * segment, each with a non-empty manifest + anchor record, and every selected
 * object must be covered by an included segment. Returns problems (empty = ok).
 */
function continuityProblems(input: BuildExportInput): string[] {
  const problems: string[] = [];
  const segments = [...input.segments].sort((a, b) => a.segment_sequence - b.segment_sequence);

  if (segments.length === 0) {
    problems.push('no segments supplied');
    return problems;
  }

  // Duplicate sequence?
  const bySeq = new Map<number, (typeof segments)[number]>();
  for (const s of segments) {
    if (bySeq.has(s.segment_sequence)) problems.push(`duplicate segment_sequence ${s.segment_sequence}`);
    bySeq.set(s.segment_sequence, s);
  }

  // object_id -> covering segment_sequence (from each segment's declared object_ids).
  const coverage = new Map<string, number>();
  for (const s of segments) for (const id of s.object_ids) coverage.set(id, s.segment_sequence);

  // Maximum sequence we must root the chain to: the highest segment covering a selected object.
  let maxSelected = -1;
  for (const ref of input.selected_object_refs) {
    const seq = coverage.get(ref.object_id);
    if (seq === undefined) {
      problems.push(`selected object ${ref.object_id} is not covered by any included segment manifest`);
    } else if (seq > maxSelected) {
      maxSelected = seq;
    }
  }
  if (maxSelected < 0) {
    // No selected object is covered (or none selected) — cannot prove continuity.
    if (input.selected_object_refs.length === 0) problems.push('no selected object refs');
    return problems;
  }

  // Genesis-rooted contiguous from 0..maxSelected: every sequence present, none missing.
  if (!bySeq.has(0)) problems.push('missing genesis segment (segment_sequence 0)');
  for (let seq = 0; seq <= maxSelected; seq++) {
    const seg = bySeq.get(seq);
    if (seg === undefined) {
      problems.push(`missing covering segment manifest for segment_sequence ${seq} (gap)`);
      continue;
    }
    if (typeof seg.serialized_manifest !== 'string' || seg.serialized_manifest.length === 0) {
      problems.push(`missing manifest for segment_sequence ${seq}`);
    }
    if (typeof seg.serialized_anchor_record !== 'string' || seg.serialized_anchor_record.length === 0) {
      problems.push(`missing anchor record for segment_sequence ${seq}`);
    }
  }

  // Segments beyond the rooted range are out of scope (cherry-picking guard the other way).
  for (const seq of bySeq.keys()) {
    if (seq > maxSelected) problems.push(`segment_sequence ${seq} is beyond the selected range [0,${maxSelected}]`);
  }

  return problems;
}

/** manifest_hash-style package hash: eventHash(canonical(package minus export_signature)). */
export function computePackageHash(pkg: ExportPackageWithoutSignature): string {
  return eventHash(serializeCanonical(pkg));
}

/**
 * Build a schema-valid `evidence-export-package-1.0`. Enforces genesis-rooted
 * continuity-preserving selection (§12.2), computes package_hash, signs via the
 * injected ExportSigner over the domain-tagged message, and validates against the
 * vendored schema. Throws `ExportPackageError` on a continuity violation or an
 * invalid package (fail-closed).
 */
export function buildEvidenceExportPackage(input: BuildExportInput): EvidenceExportPackage {
  const problems = continuityProblems(input);
  if (problems.length > 0) {
    throw new ExportPackageError(`continuity-preserving selection violated: ${problems.join('; ')}`, problems);
  }

  const ordered = [...input.segments].sort((a, b) => a.segment_sequence - b.segment_sequence);

  const core: ExportPackageWithoutSignature = {
    package_version: 'evidence-export-package-1.0',
    package_id: input.package_id,
    db_id: input.db_id,
    purpose: input.purpose,
    created_at: input.created_at,
    created_by: input.created_by,
    ...(input.case_reference !== undefined ? { case_reference: input.case_reference } : {}),
    object_refs: input.selected_object_refs.map((r) => ({ object_id: r.object_id, object_type: r.object_type, worm_object_key: r.worm_object_key, event_hash: r.event_hash })),
    segment_manifests: ordered.map((s) => s.serialized_manifest),
    anchor_records: ordered.map((s) => s.serialized_anchor_record),
    public_keys: input.public_keys.map((k) => ({ key_id: k.key_id, algorithm: k.algorithm, public_key: k.public_key, ...(k.revoked_at !== undefined ? { revoked_at: k.revoked_at } : {}) })),
    timestamp_certificates: [...input.timestamp_certificates],
    verification_instructions: {
      spec_id: input.verification_instructions.spec_id,
      spec_hash: input.verification_instructions.spec_hash,
      ...(input.verification_instructions.procedure_ref !== undefined ? { procedure_ref: input.verification_instructions.procedure_ref } : {}),
    },
    chain_of_custody_log: input.chain_of_custody_log.map((e) => ({ ...e })),
  };

  const package_hash = computePackageHash(core);
  const signed = input.signer.signExport(package_hash);
  const export_signature: ExportSignature = {
    algorithm: signed.algorithm,
    signing_key_id: signed.signing_key_id,
    signature: signed.signature,
    package_hash,
  };

  const pkg: EvidenceExportPackage = { ...core, export_signature };

  const result = validateEvidenceExportPackage(pkg);
  if (!result.valid) {
    throw new ExportPackageError(`assembled package failed evidence-export-package-1.0 validation: ${result.errors.map((e) => e.instancePath || e.keyword).join(', ')}`, result.errors);
  }
  return pkg;
}

/**
 * Optional helper: write a completed export package to WORM via an injected,
 * locally-typed write port (compliance-mode). Returns the WORM object key. The
 * builder stays pure; this is the only I/O surface and imports no concrete WORM.
 */
export async function writeExportPackageToWorm(
  worm: WormWritePort,
  pkg: EvidenceExportPackage,
  opts: { keyPrefix?: string } = {},
): Promise<string> {
  const key = `${opts.keyPrefix ?? 'exports'}/${pkg.db_id}/${pkg.package_id}.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(pkg));
  // B2: the writer cannot set retainUntil/legalHold; retention is the store default.
  const putOpts: WormPutOptions = { retentionMode: 'compliance' };
  await worm.putImmutable(key, bytes, putOpts);
  return key;
}
