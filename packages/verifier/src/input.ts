// Verifier inputs (Sprint-2 / EDAM-T140 skeleton).
//
// The verifier re-proves evidence from PUBLIC inputs only: either a read-only
// WORM port OR a self-contained export package (WORM §10/§12). This module
// defines those input ports and the export-package loader (parse + schema
// validate). It performs NO cryptographic verification (that is T141-T144) and
// imports NO writer / WORM-writer-admin / anchoring / signing-private / DB code.
//
// The WORM read port is defined LOCALLY (not imported from @edam/worm) so the
// verifier never pulls in the writer/admin/store surface — isolation (INV-EV-5).

import { validateEvidenceExportPackage } from '@edam/contracts';

/**
 * Read-only WORM access the verifier may use (the only WORM capability it needs).
 * Deliberately narrow: get + list, no write/delete/retention/legal-hold. A
 * concrete read adapter is wired by the CLI (T146), never by this pure package.
 */
export interface WormReadPort {
  /** Fetch an object's raw bytes by key. */
  get(key: string): Promise<Uint8Array>;
  /** List keys under a prefix, in deterministic (sorted) order. */
  list(prefix: string): Promise<string[]>;
}

/** The segment range a verification covers. */
export interface VerificationScope {
  first_segment_sequence: number;
  last_segment_sequence: number;
}

/** A published public signing key as carried by an export package (§12.1). PUBLIC ONLY. */
export interface ExportPublicKey {
  key_id: string;
  algorithm: string;
  public_key: string;
  revoked_at?: string | null;
}

/** An object reference in an export package (§12.1). */
export interface ExportObjectRef {
  object_id: string;
  object_type: 'cce' | 'execution_result' | 'db_audit_event';
  worm_object_key: string;
  event_hash: string;
}

/** Pinned verifier-spec reference (§12.1) — the verifier asserts it runs the pinned spec. */
export interface ExportVerificationInstructions {
  spec_id: string;
  spec_hash: string;
  procedure_ref?: string;
}

/** The export signature envelope (§12.1). */
export interface ExportSignature {
  algorithm: string;
  signing_key_id: string;
  signature: string;
  package_hash: string;
}

/**
 * An `evidence-export-package-1.0` (WORM §12.1), typed for the fields the verifier
 * consumes. `segment_manifests`, `anchor_records`, `timestamp_certificates`, and
 * `chain_of_custody_log` are carried verbatim (serialized strings / objects) and
 * are parsed by later steps (T141-T143/T145).
 */
export interface EvidenceExportPackage {
  package_version: 'evidence-export-package-1.0';
  package_id: string;
  db_id: string;
  purpose: 'legal_audit' | 'financial_audit' | 'regulator' | 'court_dispute' | 'internal_investigation';
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

/** The verifier's input: a self-contained export package, or a WORM read port + scope. */
export type VerifierInput =
  | { mode: 'export'; package: EvidenceExportPackage }
  | { mode: 'worm'; reader: WormReadPort; dbId: string; scope: VerificationScope };

/** Raised when an export package fails `evidence-export-package-1.0` schema validation. */
export class ExportPackageError extends Error {
  constructor(public readonly errors: unknown) {
    super(`export package failed evidence-export-package-1.0 validation: ${JSON.stringify(errors)}`);
    this.name = 'ExportPackageError';
  }
}

/**
 * Parse + schema-validate untrusted input into a typed `EvidenceExportPackage`.
 * Throws `ExportPackageError` on any schema violation (fail-closed). Performs NO
 * cryptographic verification (export_signature / package_hash are checked in T145).
 */
export function loadExportPackage(input: unknown): EvidenceExportPackage {
  const result = validateEvidenceExportPackage(input);
  if (!result.valid) throw new ExportPackageError(result.errors);
  return input as EvidenceExportPackage;
}
