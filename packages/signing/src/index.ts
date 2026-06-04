// @edam/signing — signing layer (Sprint-2 / EDAM-T120, T121, T122).
// Signer interface (no private material) + canonical anchor payload + dev
// Ed25519 signer + HSM/PKCS#11-compatible adapter. Concrete signers: dev Ed25519
// (T121), HSM/PKCS#11 adapter (T122, provider injected; real driver deferred).

export {
  type SignAlgorithm,
  type SignatureResult,
  type PublicKey,
  type ChainHead,
  type AnchorPayload,
  type Signer,
} from './types.js';
export {
  buildAnchorPayload,
  assertValidAnchorPayload,
  serializeAnchorPayload,
  anchorPayloadBytes,
  anchorSigningMessage,
  anchorPayloadHash,
  ANCHOR_PAYLOAD_DOMAIN,
  type AnchorPayloadOptions,
} from './anchor-payload.js';
export {
  DevEd25519Signer,
  verifyAnchorSignature,
  type DevEd25519SignerOptions,
  type KeyRegistration,
} from './dev-signer.js';
export {
  Pkcs11Signer,
  InMemoryKeyRegistry,
  Pkcs11NotConfiguredError,
  UnknownSigningKeyError,
  AlgorithmMismatchError,
  type Pkcs11Provider,
  type Pkcs11SignerConfig,
  type PublicKeyRegistry,
} from './pkcs11-signer.js';
export { createSigner, type SignerConfig } from './factory.js';
export {
  KeyRotationRegistry,
  UnknownKeyError,
  RevokedKeyError,
  KeyNotYetValidError,
  KeyAlgorithmMismatchError,
  KeyAlreadyExistsError,
  CannotRevokeActiveKeyError,
  DualControlError,
  InvalidKeyRecordError,
  type KeyRecord,
  type KeyStatus,
  type DualControlApproval,
  type KeyLifecycleAdmin,
} from './key-registry.js';
export {
  buildTrustFile,
  TrustFileGenerationError,
  type TrustFileSigningKey,
  type TrustFileAnchorCert,
  type TrustFileMeta,
  type GeneratedTrustFile,
  type BuildTrustFileInput,
} from './trust-file.js';
