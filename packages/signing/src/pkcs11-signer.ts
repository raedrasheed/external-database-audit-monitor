// HSM / PKCS#11-compatible signer adapter (Sprint-2 / EDAM-T122).
//
// A documented, config-selectable adapter slot implementing the SAME
// AnchorPayload-only `Signer` contract as the dev signer (T121). The real
// PKCS#11 integration is NOT built this sprint: instead this defines the HSM
// driver boundary (`Pkcs11Provider`) that a future `pkcs11js`-backed module
// drops into, and an adapter that fails closed until a provider is configured.
//
// Key custody (INV-EV-4): the adapter holds NO private key — the HSM does, behind
// the provider. The provider's `sign` returns only a signature; it never returns
// private material. The adapter exposes only signatures + published public keys.
//
// Boundary discipline (INV-EV-2 / E2C-SIGN-H1/M4): `sign` takes a typed
// AnchorPayload only — never arbitrary bytes. It validates (inheriting the
// hardened assertValidAnchorPayload) and builds the domain-separated anchor
// message internally, so it can never be used as a generic signing oracle. The
// low-level `Pkcs11Provider.sign(keyId, message)` is an INTERNAL HSM driver SPI
// (the C_Sign analogue), not a package signing entrypoint, and only ever
// receives the domain-separated anchor message this adapter constructs.
//
// No real HSM integration, no native dependency, no anchoring, no WORM, no CCE.

import type { AnchorPayload, PublicKey, SignAlgorithm, SignatureResult, Signer } from './types.js';
import { anchorSigningMessage, assertValidAnchorPayload } from './anchor-payload.js';

/** Raised when the adapter is asked to sign but no HSM provider is configured (fail closed). */
export class Pkcs11NotConfiguredError extends Error {
  constructor(message = 'PKCS#11 signer is not configured: no HSM provider available') {
    super(message);
    this.name = 'Pkcs11NotConfiguredError';
  }
}

/** Raised when the configured signing_key_id is not present in the HSM or not published. */
export class UnknownSigningKeyError extends Error {
  constructor(signingKeyId: string) {
    super(`PKCS#11 signer: unknown signing_key_id ${JSON.stringify(signingKeyId)}`);
    this.name = 'UnknownSigningKeyError';
  }
}

/** Raised when the provider mechanism algorithm does not match the published key algorithm. */
export class AlgorithmMismatchError extends Error {
  constructor(providerAlgorithm: SignAlgorithm, publishedAlgorithm: SignAlgorithm) {
    super(`PKCS#11 signer: algorithm mismatch (provider ${providerAlgorithm} != published ${publishedAlgorithm})`);
    this.name = 'AlgorithmMismatchError';
  }
}

/**
 * The HSM driver boundary (PKCS#11 SPI). A real implementation wraps a PKCS#11
 * module (C_FindObjects / C_Sign). It NEVER returns private material — only a
 * signature. The adapter is the only caller and always passes the
 * domain-separated anchor message; this is not a public signing entrypoint.
 */
export interface Pkcs11Provider {
  /** The signing mechanism's algorithm (must match the published public key). */
  readonly algorithm: SignAlgorithm;
  /** Whether the HSM holds a (non-exportable) private key for this id (C_FindObjects analogue). */
  hasKey(signingKeyId: string): boolean;
  /** Sign the given message bytes with the non-exportable key (C_Sign analogue). Returns signature only. */
  sign(signingKeyId: string, message: Uint8Array): Promise<Uint8Array>;
}

/** Published-public-key lookup abstraction (verifiers/consumers use this; public material only). */
export interface PublicKeyRegistry {
  getPublicKey(signingKeyId: string): PublicKey | undefined;
}

/** A simple in-memory published-public-key registry. Holds public material only. */
export class InMemoryKeyRegistry implements PublicKeyRegistry {
  readonly #keys = new Map<string, PublicKey>();

  constructor(keys: readonly PublicKey[] = []) {
    for (const k of keys) this.#keys.set(k.signing_key_id, k);
  }

  getPublicKey(signingKeyId: string): PublicKey | undefined {
    return this.#keys.get(signingKeyId);
  }
}

export interface Pkcs11SignerConfig {
  /** The HSM driver. If absent, the adapter is NOT configured and signing fails closed. */
  provider?: Pkcs11Provider;
  /** The active signing key id / label (the HSM key handle). */
  signingKeyId: string;
  /** Published public keys (for verification + getPublicKey). Public material only. */
  registry: PublicKeyRegistry;
}

/**
 * HSM / PKCS#11 adapter implementing the AnchorPayload-only `Signer` contract.
 * Holds no private key. Fails closed until a provider is configured.
 */
export class Pkcs11Signer implements Signer {
  readonly #provider: Pkcs11Provider | undefined;
  readonly #signingKeyId: string;
  readonly #registry: PublicKeyRegistry;

  constructor(config: Pkcs11SignerConfig) {
    this.#provider = config.provider;
    this.#signingKeyId = config.signingKeyId;
    this.#registry = config.registry;
  }

  /** True once an HSM provider is configured. */
  get configured(): boolean {
    return this.#provider !== undefined;
  }

  /** The active signing key id. */
  get keyId(): string {
    return this.#signingKeyId;
  }

  /**
   * Sign an anchor payload. Fails closed (throws) if not configured, if the key
   * is unknown/unpublished, if the algorithm does not bind, or if the payload is
   * invalid. Canonicalizes + domain-separates internally; never signs raw bytes.
   */
  async sign(payload: AnchorPayload): Promise<SignatureResult> {
    const provider = this.#provider;
    if (provider === undefined) throw new Pkcs11NotConfiguredError();
    // Validate (inherits the hardened exact-key-set + real-instant checks) BEFORE
    // any HSM interaction — no arbitrary content reaches the signing mechanism.
    assertValidAnchorPayload(payload);
    const published = this.#registry.getPublicKey(this.#signingKeyId);
    if (!provider.hasKey(this.#signingKeyId) || published === undefined) {
      throw new UnknownSigningKeyError(this.#signingKeyId);
    }
    if (provider.algorithm !== published.algorithm) {
      throw new AlgorithmMismatchError(provider.algorithm, published.algorithm);
    }
    const message = anchorSigningMessage(payload);
    const signature = await provider.sign(this.#signingKeyId, message);
    return {
      algorithm: published.algorithm,
      signing_key_id: this.#signingKeyId,
      signature: Buffer.from(signature).toString('base64'),
    };
  }

  /** Return the PUBLIC key for a signing_key_id (no private material), or undefined. */
  getPublicKey(signingKeyId: string): PublicKey | undefined {
    return this.#registry.getPublicKey(signingKeyId);
  }
}
