// Evidence Export Package types (EDAM-T145).
//
// Mirrors the vendored `evidence-export-package-1.0` schema (WORM §12.1). For
// T145 the package carries object REFERENCES (object_refs) — not object blobs —
// plus INLINE segment manifests + anchor records + keys/certs + custody log +
// the export signature. Offline per-object-content recomputation from an export
// package is intentionally DEFERRED (the schema carries no object content; a
// self-contained object-blob bundle is a later export/verifier decision —
// T146/T148 or a future bundle task).

/** An object reference (anchor: object_id + worm key + event_hash; no content). */
export interface ExportObjectRef {
  object_id: string;
  object_type: 'cce' | 'execution_result' | 'db_audit_event';
  worm_object_key: string;
  event_hash: string;
}

/** A published signing public key carried in the package (PUBLIC ONLY). */
export interface ExportPublicKey {
  key_id: string;
  algorithm: string;
  public_key: string;
  revoked_at?: string | null;
}

/** Pinned published-verifier-spec reference (caller-supplied; shape-validated only). */
export interface ExportVerificationInstructions {
  spec_id: string;
  spec_hash: string;
  procedure_ref?: string;
}

/** The export-integrity signature over `package_hash` (the canonical hash of the package minus this field). */
export interface ExportSignature {
  algorithm: string;
  signing_key_id: string;
  signature: string;
  package_hash: string;
}

export type ExportPurpose = 'legal_audit' | 'financial_audit' | 'regulator' | 'court_dispute' | 'internal_investigation';

/** A schema-valid `evidence-export-package-1.0`. */
export interface EvidenceExportPackage {
  package_version: 'evidence-export-package-1.0';
  package_id: string;
  db_id: string;
  purpose: ExportPurpose;
  created_at: string;
  created_by: string;
  case_reference?: string;
  object_refs: ExportObjectRef[];
  segment_manifests: string[];
  anchor_records: string[];
  public_keys: ExportPublicKey[];
  timestamp_certificates: string[];
  verification_instructions: ExportVerificationInstructions;
  chain_of_custody_log: Record<string, unknown>[];
  export_signature: ExportSignature;
}

/** The package minus its export signature — the canonical bytes that `package_hash` covers. */
export type ExportPackageWithoutSignature = Omit<EvidenceExportPackage, 'export_signature'>;

/**
 * Injected export signer. Implementations sign the domain-tagged export message
 * (`exportSigningMessage(packageHash)`) — never `@edam/signing` (which only signs
 * anchor payloads). Returns the algorithm + key id + base64 signature.
 */
export interface ExportSigner {
  signExport(packageHash: string): { algorithm: string; signing_key_id: string; signature: string };
}

/**
 * A WORM compliance-mode write option set (locally typed; structurally compatible
 * with the WORM writer). Carries ONLY `retentionMode` (EDAM-S3-SOD-F1 / B2): the
 * writer cannot set retainUntil/legalHold — retention is the store's bucket-default
 * COMPLIANCE retention; extension/hold are Domain-C ops.
 */
export interface WormPutOptions {
  retentionMode: 'compliance';
}

/** A minimal, locally-defined WORM write port (no concrete WORM implementation imported). */
export interface WormWritePort {
  putImmutable(key: string, bytes: Uint8Array, opts: WormPutOptions): Promise<void>;
}

/** One supplied segment for the export: its sequence, the objects it covers, and its serialized manifest + anchor record. */
export interface ExportSegmentInput {
  segment_sequence: number;
  /** object_ids this segment's manifest covers (from its object_list). */
  object_ids: string[];
  /** Serialized evidence-segment-manifest (carried inline in `segment_manifests`). */
  serialized_manifest: string;
  /** Serialized anchor-record for this segment's head (carried inline in `anchor_records`). */
  serialized_anchor_record: string;
}

/** Input to `buildEvidenceExportPackage`. */
export interface BuildExportInput {
  package_id: string;
  db_id: string;
  purpose: ExportPurpose;
  created_at: string;
  created_by: string;
  case_reference?: string;
  /** The objects in scope (references). Each must be covered by an included segment. */
  selected_object_refs: ExportObjectRef[];
  /** The supplied segments. Must be genesis-rooted contiguous (0..max selected); each with manifest + anchor record. */
  segments: ExportSegmentInput[];
  public_keys: ExportPublicKey[];
  timestamp_certificates: string[];
  verification_instructions: ExportVerificationInstructions;
  chain_of_custody_log: Record<string, unknown>[];
  signer: ExportSigner;
}
