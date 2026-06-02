// AnchorProvider abstraction types (Sprint-2 / EDAM-T130).
//
// A head is ANCHORED only after a VERIFIED external token (INV-EV-3, WORM §19.5).
// The provider proves WHEN a signed head existed using a source EDAM does not
// control. It receives ONLY the hash of the signed anchor payload — never CCE or
// audit plaintext (INV-EV-2, §9/§19.4). On failure nothing is fabricated: the
// outcome union carries no token on pending/failed (INV-EV-6, §19.12).

/** Frozen anchor-provider enum (WORM §9 / anchor-record-1.0). No new types this sprint. */
export type AnchorProviderType = 'rfc3161' | 'transparency_log' | 'dual_custodian';
export const ANCHOR_PROVIDER_TYPES: readonly AnchorProviderType[] = ['rfc3161', 'transparency_log', 'dual_custodian'];

/**
 * What an AnchorProvider receives: ONLY the sha256 token of the signed anchor
 * payload. No db_id / segment fields / plaintext — the provider sees a digest.
 */
export interface AnchorRequest {
  /** `sha256:<64hex>` digest of the signed anchor payload (§9 common rules). */
  payload_hash: string;
}

/**
 * The external proof, shaped exactly like the vendored `anchor-record-1.0`
 * `anchor_provider` object (§16.2) so the anchored output is AnchorRecord-ready.
 */
export type AnchorProviderProof =
  | { type: 'rfc3161'; rfc3161_token: string; tsa_cert_ref: string }
  | {
      type: 'transparency_log';
      transparency_log: { log_id: string; leaf_index: number; inclusion_proof: string[]; signed_tree_head: string };
    }
  | { type: 'dual_custodian'; dual_custodian: { custodian_id: string; signature: string; key_ref: string; timestamp: string } };

/** A verifiable external anchor token (AnchorRecord-compatible proof + asserted instant + bound hash). */
export interface AnchorToken {
  provider_type: AnchorProviderType;
  /** External proof, ready to drop into an anchor-record `anchor_provider`. */
  anchor_provider: AnchorProviderProof;
  /** RFC3339 instant the external authority asserts the hash existed. */
  anchored_at: string;
  /** The hash the token commits to — MUST equal the request `payload_hash`. */
  payload_hash: string;
}

/** Retryable: stay ANCHOR_PENDING (no token produced). */
export type AnchorPendingReason = 'provider_outage' | 'provider_timeout' | 'provider_error';
/** Terminal / fail-closed (no token produced). */
export type AnchorFailureReason =
  | 'unsupported_provider'
  | 'invalid_request'
  | 'malformed_response'
  | 'hash_mismatch'
  | 'token_verification_failed';

/**
 * The typed result of an anchoring attempt. ANCHORED carries a verified token;
 * PENDING/FAILED carry NO token — fabrication is impossible by construction.
 */
export type AnchorOutcome =
  | { status: 'anchored'; token: AnchorToken }
  | { status: 'pending'; reason: AnchorPendingReason }
  | { status: 'failed'; reason: AnchorFailureReason };

/**
 * Pluggable external anchor authority. `anchor` requests a token over a hash;
 * `verifyToken` re-proves a token binds to that hash (offline, idempotent).
 * Implementations see only the hash — never plaintext (INV-EV-2).
 */
export interface AnchorProvider {
  readonly provider_type: AnchorProviderType;
  anchor(request: AnchorRequest): Promise<AnchorOutcome>;
  verifyToken(token: AnchorToken, request: AnchorRequest): boolean;
}

/** Thrown internally when a provider call exceeds the anchoring timeout. */
export class AnchorTimeoutError extends Error {
  constructor(ms: number) {
    super(`anchor provider timed out after ${ms}ms`);
    this.name = 'AnchorTimeoutError';
  }
}

/** A provider may throw this to signal a (retryable) outage of the external authority. */
export class AnchorOutageError extends Error {
  constructor(message = 'external anchor authority is unavailable') {
    super(message);
    this.name = 'AnchorOutageError';
  }
}
