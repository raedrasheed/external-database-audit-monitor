// @edam/signing — signing layer (Sprint-2 / EDAM-T120, EDAM-T121).
// Signer interface (no private material) + canonical anchor payload + dev
// Ed25519 signer. Concrete signers: dev Ed25519 (T121), HSM/PKCS#11 (T122).

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
