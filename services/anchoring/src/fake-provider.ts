// Dev/test AnchorProvider double (Sprint-2 / EDAM-T130).
//
// A deterministic stand-in for an EXTERNAL anchor authority — NOT for production
// (no real RFC-3161 TSA / transparency log; that is a later E2D task). It exists
// so the abstraction and its fail-closed guard are testable end-to-end, like
// InMemoryWormStore. EDAM's own anchoring code never mints a token; this dev
// authority does, and commits the token to the requested hash so verifyToken can
// re-prove the binding offline. Injectable behavior drives the failure modes.

import { sha256Hex } from '@edam/canonical';
import {
  AnchorOutageError,
  type AnchorOutcome,
  type AnchorProvider,
  type AnchorProviderProof,
  type AnchorProviderType,
  type AnchorRequest,
  type AnchorToken,
} from './types.js';

export type FakeAnchorMode =
  | 'anchored' // issue a verifiable token bound to the hash
  | 'outage' // throw AnchorOutageError ⇒ pending(provider_outage)
  | 'timeout' // never resolve ⇒ pending(provider_timeout)
  | 'malformed' // return a structurally invalid outcome ⇒ failed(malformed_response)
  | 'wrong_hash' // token commits to a different hash ⇒ failed(hash_mismatch)
  | 'forged'; // token claims the right hash but the proof does not verify ⇒ failed(token_verification_failed)

export interface FakeAnchorProviderOptions {
  mode?: FakeAnchorMode;
  /** Deterministic external instant the authority asserts. */
  anchoredAt?: string;
}

/** Deterministic commitment binding (provider_type, payload_hash, anchored_at). */
function commit(providerType: AnchorProviderType, payloadHash: string, anchoredAt: string): string {
  return sha256Hex(`edam-anchor-commit|${providerType}|${payloadHash}|${anchoredAt}`);
}

function proofFor(providerType: AnchorProviderType, c: string, anchoredAt: string): AnchorProviderProof {
  switch (providerType) {
    case 'rfc3161':
      return { type: 'rfc3161', rfc3161_token: `dev-tsa:${c}`, tsa_cert_ref: 'dev-tsa-cert-1' };
    case 'transparency_log':
      return { type: 'transparency_log', transparency_log: { log_id: 'dev-log-1', leaf_index: 0, inclusion_proof: [c], signed_tree_head: `dev-sth:${c}` } };
    case 'dual_custodian':
      return { type: 'dual_custodian', dual_custodian: { custodian_id: 'dev-custodian-1', signature: `dev-sig:${c}`, key_ref: 'dev-key-1', timestamp: anchoredAt } };
  }
}

/** Recover the commitment embedded in a proof (for verifyToken). */
function commitFromProof(proof: AnchorProviderProof): string | undefined {
  switch (proof.type) {
    case 'rfc3161':
      return proof.rfc3161_token.startsWith('dev-tsa:') ? proof.rfc3161_token.slice('dev-tsa:'.length) : undefined;
    case 'transparency_log':
      return proof.transparency_log.inclusion_proof[0];
    case 'dual_custodian':
      return proof.dual_custodian.signature.startsWith('dev-sig:') ? proof.dual_custodian.signature.slice('dev-sig:'.length) : undefined;
  }
}

export class FakeAnchorProvider implements AnchorProvider {
  readonly provider_type: AnchorProviderType;
  readonly #mode: FakeAnchorMode;
  readonly #anchoredAt: string;

  constructor(providerType: AnchorProviderType, opts: FakeAnchorProviderOptions = {}) {
    this.provider_type = providerType;
    this.#mode = opts.mode ?? 'anchored';
    this.#anchoredAt = opts.anchoredAt ?? '2026-06-01T10:05:05.000Z';
  }

  async anchor(request: AnchorRequest): Promise<AnchorOutcome> {
    switch (this.#mode) {
      case 'outage':
        throw new AnchorOutageError('dev anchor authority: simulated outage');
      case 'timeout':
        return new Promise<AnchorOutcome>(() => { /* never resolves */ });
      case 'malformed':
        return { status: 'anchored', token: { provider_type: this.provider_type } as unknown as AnchorToken };
      case 'wrong_hash': {
        const other = sha256Hex(`tampered|${request.payload_hash}`);
        const otherHash = `sha256:${other}`;
        const c = commit(this.provider_type, otherHash, this.#anchoredAt);
        return { status: 'anchored', token: { provider_type: this.provider_type, anchor_provider: proofFor(this.provider_type, c, this.#anchoredAt), anchored_at: this.#anchoredAt, payload_hash: otherHash } };
      }
      case 'forged': {
        const bogus = sha256Hex(`forged|${request.payload_hash}`);
        return { status: 'anchored', token: { provider_type: this.provider_type, anchor_provider: proofFor(this.provider_type, bogus, this.#anchoredAt), anchored_at: this.#anchoredAt, payload_hash: request.payload_hash } };
      }
      case 'anchored':
      default: {
        const c = commit(this.provider_type, request.payload_hash, this.#anchoredAt);
        return { status: 'anchored', token: { provider_type: this.provider_type, anchor_provider: proofFor(this.provider_type, c, this.#anchoredAt), anchored_at: this.#anchoredAt, payload_hash: request.payload_hash } };
      }
    }
  }

  verifyToken(token: AnchorToken, request: AnchorRequest): boolean {
    if (token.provider_type !== this.provider_type) return false;
    if (token.payload_hash !== request.payload_hash) return false;
    if (token.anchor_provider.type !== this.provider_type) return false;
    const embedded = commitFromProof(token.anchor_provider);
    if (embedded === undefined) return false;
    const expected = commit(this.provider_type, request.payload_hash, token.anchored_at);
    return embedded === expected;
  }
}
