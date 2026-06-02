// @edam/signing — signing layer (Sprint-2 / EDAM-T120).
// Signer interface (no private material) + canonical anchor payload. Concrete
// signers: dev Ed25519 (T121), HSM/PKCS#11 (T122).

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
  serializeAnchorPayload,
  anchorPayloadBytes,
  anchorPayloadHash,
  type AnchorPayloadOptions,
} from './anchor-payload.js';
