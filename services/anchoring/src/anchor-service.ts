// Fail-closed anchoring dispatch (Sprint-2 / EDAM-T130).
//
// Wraps an AnchorProvider so a head is reported ANCHORED only after a token that
// (a) is well-formed, (b) binds to the requested hash, and (c) passes the
// provider's own verifyToken (INV-EV-3). Every failure mode — outage, timeout,
// malformed response, hash mismatch, unsupported provider — fails closed with a
// typed pending/failed result and NO fabricated token (INV-EV-6).
//
// No retry/backoff/cadence, no state transition, no WORM here — those are later
// E2D tasks. This is the provider-boundary guard only.

import { isHashToken } from '@edam/canonical';
import {
  ANCHOR_PROVIDER_TYPES,
  AnchorTimeoutError,
  AnchorOutageError,
  type AnchorOutcome,
  type AnchorProvider,
  type AnchorProviderType,
  type AnchorRequest,
  type AnchorToken,
} from './types.js';

/** Default provider call timeout (ms). Exceeding it ⇒ pending (retryable), never a fabricated token. */
export const DEFAULT_ANCHOR_TIMEOUT_MS = 10_000;

export interface RequestAnchorOptions {
  timeoutMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a token is well-formed AND matches the vendored anchor-record-1.0 `anchor_provider` shape. */
export function isWellFormedToken(t: unknown): t is AnchorToken {
  if (!isRecord(t)) return false;
  if (!ANCHOR_PROVIDER_TYPES.includes(t.provider_type as AnchorProviderType)) return false;
  if (typeof t.payload_hash !== 'string' || !isHashToken(t.payload_hash)) return false;
  if (typeof t.anchored_at !== 'string' || !Number.isFinite(Date.parse(t.anchored_at))) return false;
  const ap = t.anchor_provider;
  if (!isRecord(ap) || ap.type !== t.provider_type) return false;
  switch (ap.type) {
    case 'rfc3161':
      return typeof ap.rfc3161_token === 'string' && ap.rfc3161_token.length > 0 && typeof ap.tsa_cert_ref === 'string' && ap.tsa_cert_ref.length > 0;
    case 'transparency_log': {
      const tl = ap.transparency_log;
      return isRecord(tl) && typeof tl.log_id === 'string' && Number.isInteger(tl.leaf_index) && Array.isArray(tl.inclusion_proof) && typeof tl.signed_tree_head === 'string';
    }
    case 'dual_custodian': {
      const dc = ap.dual_custodian;
      return isRecord(dc) && typeof dc.custodian_id === 'string' && typeof dc.signature === 'string' && typeof dc.key_ref === 'string' && typeof dc.timestamp === 'string';
    }
    default:
      return false;
  }
}

function isWellFormedOutcome(o: unknown): o is AnchorOutcome {
  if (!isRecord(o)) return false;
  if (o.status === 'anchored') return isWellFormedToken(o.token);
  if (o.status === 'pending') return o.reason === 'provider_outage' || o.reason === 'provider_timeout' || o.reason === 'provider_error';
  if (o.status === 'failed') {
    return ['unsupported_provider', 'invalid_request', 'malformed_response', 'hash_mismatch', 'token_verification_failed'].includes(o.reason as string);
  }
  return false;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AnchorTimeoutError(ms)), ms);
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** verifyToken can never escalate a failure into success: any throw ⇒ false (fail closed). */
function safeVerify(provider: AnchorProvider, token: AnchorToken, request: AnchorRequest): boolean {
  try {
    return provider.verifyToken(token, request) === true;
  } catch {
    return false;
  }
}

/**
 * Request an anchor token for a hash and fail closed. Returns `anchored` ONLY
 * when a well-formed token binds to the request hash and the provider verifies
 * it (INV-EV-3). Outage/timeout ⇒ pending; everything else suspect ⇒ failed.
 * Never fabricates a token.
 */
export async function requestAnchor(provider: AnchorProvider, request: AnchorRequest, opts: RequestAnchorOptions = {}): Promise<AnchorOutcome> {
  if (!isRecord(request) || typeof request.payload_hash !== 'string' || !isHashToken(request.payload_hash)) {
    return { status: 'failed', reason: 'invalid_request' };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;

  let outcome: unknown;
  try {
    outcome = await withTimeout(Promise.resolve().then(() => provider.anchor(request)), timeoutMs);
  } catch (e) {
    if (e instanceof AnchorTimeoutError) return { status: 'pending', reason: 'provider_timeout' };
    if (e instanceof AnchorOutageError) return { status: 'pending', reason: 'provider_outage' };
    return { status: 'pending', reason: 'provider_error' };
  }

  if (!isWellFormedOutcome(outcome)) return { status: 'failed', reason: 'malformed_response' };
  if (outcome.status !== 'anchored') return outcome; // pending/failed pass through — already token-less

  const token = outcome.token;
  if (token.provider_type !== provider.provider_type) return { status: 'failed', reason: 'malformed_response' };
  if (token.payload_hash !== request.payload_hash) return { status: 'failed', reason: 'hash_mismatch' };
  if (!safeVerify(provider, token, request)) return { status: 'failed', reason: 'token_verification_failed' };
  return { status: 'anchored', token };
}

/** Narrowing guard: a head may transition to ANCHORED only when this is true. */
export function isAnchored(outcome: AnchorOutcome): outcome is { status: 'anchored'; token: AnchorToken } {
  return outcome.status === 'anchored';
}

/**
 * A pluggable set of providers keyed by `provider_type`. Anchoring against an
 * unregistered type fails closed (`unsupported_provider`); registered types go
 * through the fail-closed `requestAnchor` guard.
 */
export class AnchorProviderRegistry {
  readonly #providers: ReadonlyMap<AnchorProviderType, AnchorProvider>;

  constructor(providers: readonly AnchorProvider[] = []) {
    const map = new Map<AnchorProviderType, AnchorProvider>();
    for (const p of providers) {
      if (map.has(p.provider_type)) throw new Error(`AnchorProviderRegistry: duplicate provider for ${p.provider_type}`);
      map.set(p.provider_type, p);
    }
    this.#providers = map;
  }

  supports(type: AnchorProviderType): boolean {
    return this.#providers.has(type);
  }

  get(type: AnchorProviderType): AnchorProvider | undefined {
    return this.#providers.get(type);
  }

  async anchor(type: AnchorProviderType, request: AnchorRequest, opts?: RequestAnchorOptions): Promise<AnchorOutcome> {
    const provider = this.#providers.get(type);
    if (provider === undefined) return { status: 'failed', reason: 'unsupported_provider' };
    return requestAnchor(provider, request, opts);
  }
}
