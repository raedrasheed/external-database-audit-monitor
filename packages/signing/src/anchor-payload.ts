// Canonical anchor payload — re-export shim (EDAM-T110).
//
// The canonical anchor-payload assembly moved to @edam/evidence (the determinism
// keystone shared with the independent verifier) so the writer, signing, and the
// verifier all use ONE byte-identical assembly. This module re-exports it
// verbatim so @edam/signing's public API and signing-internal imports
// (dev-signer, pkcs11-signer) are unchanged. No private key material is involved.

export {
  ANCHOR_PAYLOAD_DOMAIN,
  assertValidAnchorPayload,
  buildAnchorPayload,
  serializeAnchorPayload,
  anchorPayloadBytes,
  anchorSigningMessage,
  anchorPayloadHash,
  type AnchorPayloadOptions,
} from '@edam/evidence';
