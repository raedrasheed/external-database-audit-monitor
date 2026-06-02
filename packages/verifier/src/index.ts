// @edam/verifier — independent evidence verifier (EDAM-T140 skeleton).
//
// Public-inputs-only. Pure: imports ONLY @edam/canonical + vendored schemas
// (@edam/contracts) + @edam/evidence + node:crypto public-key/cert parsing. No
// writer / WORM-writer-admin / signing-private / anchoring / DB import (WV-12 /
// INV-EV-5; enforced by the T147 isolation gate). This skeleton ships the input
// ports, trusted-material directories + parsing helpers, the verification-report
// scaffold, and a schema-valid `verify()` that emits all §10 checks as SKIPPED.
// The recompute/verification logic lands in T141-T144.

export {
  loadExportPackage,
  ExportPackageError,
  type WormReadPort,
  type VerificationScope,
  type VerifierInput,
  type EvidenceExportPackage,
  type ExportPublicKey,
  type ExportObjectRef,
  type ExportVerificationInstructions,
  type ExportSignature,
} from './input.js';

export {
  InMemorySigningKeyDirectory,
  InMemoryAnchorCertDirectory,
  signingKeyDirectoryFromExport,
  parsePublicKey,
  parseCertificate,
  type TrustedSigningKey,
  type TrustedSigningKeyDirectory,
  type TrustedAnchorCert,
  type TrustedAnchorCertDirectory,
} from './trust.js';

export {
  VerificationReportBuilder,
  VerificationReportError,
  ALL_CHECKS,
  REQUIRED_CHECKS,
  type CheckName,
  type CheckResult,
  type VerificationCheck,
  type VerifierIdentity,
  type VerificationReport,
  type VerificationReportInit,
} from './report.js';

export {
  recomputeSegment,
  type VerifierSegment,
  type CheckOutcome,
  type SegmentRecomputeResult,
} from './verify-segments.js';

export { verify, verifySegments, type VerifyOptions, type VerifySegmentsArgs } from './verify.js';
