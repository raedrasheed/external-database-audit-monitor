// @edam/export — Evidence Export Package builder (EDAM-T145).
//
// Pure producer that assembles a schema-valid evidence-export-package-1.0 (WORM
// §12.1) with continuity-preserving (genesis-rooted) selection, computes
// package_hash, signs via an injected ExportSigner, and validates against the
// vendored schema. WORM write is an optional helper over an injected, locally-
// typed port (no concrete WORM implementation imported). Producer-oriented; not
// the verifier.

export {
  buildEvidenceExportPackage,
  writeExportPackageToWorm,
  computePackageHash,
  exportSigningMessage,
  EXPORT_SIGNATURE_DOMAIN,
  ExportPackageError,
} from './build.js';

export type {
  EvidenceExportPackage,
  ExportPackageWithoutSignature,
  ExportObjectRef,
  ExportPublicKey,
  ExportVerificationInstructions,
  ExportSignature,
  ExportPurpose,
  ExportSigner,
  ExportSegmentInput,
  BuildExportInput,
  WormPutOptions,
  WormWritePort,
} from './types.js';
