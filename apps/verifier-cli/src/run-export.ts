// Export-mode verification orchestration (EDAM-T146, Q2/Q8).
//
// Drives the full offline procedure from an Evidence Export Package + a sidecar
// object bundle + out-of-band trust roots:
//   1. schema-validate the package (loadExportPackage);
//   2. verify the export ENVELOPE signature (recomputed package_hash, trusted
//      out-of-band export key);
//   3. parse the inline manifests + anchor records, hydrate the covered objects,
//      and build VerifierSegment[];
//   4. run the pure §10 procedure via `verifySegments` directly (Q2 — `verify()`
//      is left unchanged).
// Returns the export-signature outcome and the §10 verification report; exit-code
// mapping lives in `exit.ts`.

import {
  loadExportPackage,
  verifyExportSignature,
  verifySegments,
  type EvidenceExportPackage,
  type VerifierSegment,
  type VerificationReport,
  type CheckOutcome,
  type VerificationScope,
  type VerifierIdentity,
} from '@edam/verifier';
import type { SegmentManifest } from '@edam/evidence';
import { parseManifest, parseAnchorRecord } from './parse.js';
import { hydrateSegmentObjects } from './hydrate.js';
import type { TrustRoots } from './trust.js';

export interface RunExportOptions {
  objectsDir: string;
  trust: TrustRoots;
  verifier?: VerifierIdentity;
  reportId?: string;
  generatedAt?: string;
}

export interface ExportVerificationResult {
  package_id: string;
  db_id: string;
  /** The export ENVELOPE seal outcome (§12.1 export_signature). */
  export_signature: CheckOutcome;
  /** The §10 evidence verification report (steps 1-9). */
  report: VerificationReport;
}

/** Derive the covered scope from the parsed manifests. */
function scopeFromManifests(manifests: readonly SegmentManifest[]): VerificationScope {
  const seqs = manifests.map((m) => m.segment_sequence);
  return { first_segment_sequence: Math.min(...seqs), last_segment_sequence: Math.max(...seqs) };
}

/**
 * Verify an already-parsed export package object against a sidecar object bundle
 * and out-of-band trust roots. Throws on schema-invalid input (parse layer) and
 * on an incomplete sidecar bundle (hydration layer); otherwise returns the
 * envelope-signature outcome + the §10 report (both fail-closed internally).
 */
export function runExportVerification(rawPackage: unknown, opts: RunExportOptions): ExportVerificationResult {
  // 1. Schema-validate (fail-closed; throws ExportPackageError on violation).
  const pkg: EvidenceExportPackage = loadExportPackage(rawPackage);

  // 2. Envelope seal: recompute package_hash + verify against the TRUSTED export key.
  const export_signature = verifyExportSignature(pkg, opts.trust.exportKeys);

  // 3. Parse inline manifests + anchor records, hydrate objects, build segments.
  const manifests = pkg.segment_manifests.map((s, i) => parseManifest(s, i));
  const anchorRecords = pkg.anchor_records.map((s, i) => parseAnchorRecord(s, i));

  const segments: VerifierSegment[] = manifests.map((manifest, i) => ({
    manifest,
    objects: hydrateSegmentObjects(opts.objectsDir, manifest.object_list ?? []),
    ...(anchorRecords[i] !== undefined ? { anchorRecord: anchorRecords[i] } : {}),
  }));

  // 4. Run the pure §10 procedure directly (Q2). Trust roots are out-of-band (Q4/Q5).
  const report = verifySegments({
    db_id: pkg.db_id,
    scope: scopeFromManifests(manifests),
    segments,
    trustedKeys: opts.trust.signingKeys,
    trustedCerts: opts.trust.anchorCerts,
    ...(opts.verifier !== undefined ? { verifier: opts.verifier } : {}),
    ...(opts.reportId !== undefined ? { reportId: opts.reportId } : {}),
    ...(opts.generatedAt !== undefined ? { generatedAt: opts.generatedAt } : {}),
  });

  return { package_id: pkg.package_id, db_id: pkg.db_id, export_signature, report };
}
