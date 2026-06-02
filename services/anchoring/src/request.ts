// Building an AnchorRequest from a signed anchor payload (Sprint-2 / EDAM-T130).
//
// The anchoring service is handed the signed anchor payload (already a hash
// structure), but reduces it to ONLY its sha256 digest before it reaches a
// provider — so the provider sees no plaintext and no structured fields
// (INV-EV-2, §9/§19.4).

import { anchorPayloadHash, type AnchorPayload } from '@edam/signing';
import type { AnchorRequest } from './types.js';

/**
 * Reduce a signed anchor payload to the hash-only request a provider may see.
 * `anchorPayloadHash` validates + canonicalizes the payload (inherits the T121
 * hardening), so the digest is reproducible and the payload is well-formed.
 */
export function anchorRequestFor(payload: AnchorPayload): AnchorRequest {
  return { payload_hash: anchorPayloadHash(payload) };
}
