// @edam/anchor-proof — pure RFC-3161 + RFC-6962 anchor-proof primitives.
//
// Shared by the anchoring providers (build/sign) and the independent verifier
// (check) so there is ONE implementation and no builder<->verifier drift. Pure;
// depends only on @edam/canonical + node:crypto. No services / WORM /
// signing-private / DB — verifier-importable (WV-12 isolation).

export {
  DEV_TSA_DOMAIN,
  tstSigningBytes,
  verifyRfc3161Token,
  type TstInfo,
  type DevTsaCertificate,
  type Rfc3161VerifyResult,
} from './rfc3161.js';

export {
  leafHashFromPayload,
  nodeHash,
  merkleTreeHash,
  inclusionPath,
  sthSigningBytes,
  verifyTransparencyLogToken,
  type SignedTreeHead,
  type DevLogCertificate,
  type TransparencyLogVerifyResult,
  type TransparencyLogProof,
} from './transparency-log.js';
