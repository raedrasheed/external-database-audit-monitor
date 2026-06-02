// Trusted public-material directories + parsing helpers (Sprint-2 / EDAM-T140 skeleton).
//
// The verifier resolves signing-key-ids and anchor-cert refs to TRUSTED PUBLISHED
// material — sourced from an export package's `public_keys` / `timestamp_certificates`
// or from a separately-published key/cert set — NEVER from a live EDAM service or
// any private key. These are INPUTS to the verifier (this is what makes the
// re-verification trust-minimized; it closes M1/AR1 once T143 consumes them).
//
// This module provides the directory interfaces, in-memory implementations,
// loaders from an export package, and PARSING-ONLY helpers over node:crypto. It
// performs NO signature verification (that is T143).

import { createPublicKey, X509Certificate, type KeyObject } from 'node:crypto';
import type { EvidenceExportPackage } from './input.js';

/** A trusted published signing public key (with optional validity window + revocation). PUBLIC ONLY. */
export interface TrustedSigningKey {
  key_id: string;
  algorithm: string;
  /** Public key material (SPKI DER base64 or PEM). */
  public_key: string;
  not_before?: string;
  not_after?: string;
  revoked_at?: string | null;
}

/** Resolves a `signing_key_id` to its trusted published key, or undefined if unknown. */
export interface TrustedSigningKeyDirectory {
  get(keyId: string): TrustedSigningKey | undefined;
}

/** A trusted published anchor-authority cert/key (TSA cert / transparency-log key). PUBLIC ONLY. */
export interface TrustedAnchorCert {
  /** The reference this entry resolves (e.g. `tsa_cert_ref` or transparency-log `log_id`). */
  ref: string;
  algorithm: string;
  /** Public certificate (PEM/DER base64) or public key material. */
  public_key: string;
  not_before?: string;
  not_after?: string;
  revoked_at?: string | null;
}

/** Resolves an anchor-cert ref / log_id to its trusted published cert/key, or undefined if unknown. */
export interface TrustedAnchorCertDirectory {
  get(ref: string): TrustedAnchorCert | undefined;
}

/** In-memory `TrustedSigningKeyDirectory` keyed by key_id (first entry wins on duplicates). */
export class InMemorySigningKeyDirectory implements TrustedSigningKeyDirectory {
  readonly #keys = new Map<string, TrustedSigningKey>();
  constructor(keys: readonly TrustedSigningKey[] = []) {
    for (const k of keys) if (!this.#keys.has(k.key_id)) this.#keys.set(k.key_id, k);
  }
  get(keyId: string): TrustedSigningKey | undefined {
    return this.#keys.get(keyId);
  }
  get size(): number {
    return this.#keys.size;
  }
}

/** In-memory `TrustedAnchorCertDirectory` keyed by ref (first entry wins on duplicates). */
export class InMemoryAnchorCertDirectory implements TrustedAnchorCertDirectory {
  readonly #certs = new Map<string, TrustedAnchorCert>();
  constructor(certs: readonly TrustedAnchorCert[] = []) {
    for (const c of certs) if (!this.#certs.has(c.ref)) this.#certs.set(c.ref, c);
  }
  get(ref: string): TrustedAnchorCert | undefined {
    return this.#certs.get(ref);
  }
  get size(): number {
    return this.#certs.size;
  }
}

/** Build a signing-key directory from an export package's published `public_keys`. */
export function signingKeyDirectoryFromExport(pkg: EvidenceExportPackage): TrustedSigningKeyDirectory {
  return new InMemorySigningKeyDirectory(
    pkg.public_keys.map((k) => ({ key_id: k.key_id, algorithm: k.algorithm, public_key: k.public_key, revoked_at: k.revoked_at ?? null })),
  );
}

/**
 * Parse SPKI/PEM public key material (PARSING ONLY — no signature verification).
 * Accepts a PEM string or base64-encoded SPKI DER. Throws on unparseable input.
 */
export function parsePublicKey(material: string): KeyObject {
  const trimmed = material.trim();
  if (trimmed.includes('-----BEGIN')) return createPublicKey(trimmed);
  return createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
}

/**
 * Parse an X.509 certificate (PARSING ONLY — no chain/signature validation).
 * Accepts PEM or base64-encoded DER. Throws on unparseable input.
 */
export function parseCertificate(material: string): X509Certificate {
  const trimmed = material.trim();
  if (trimmed.includes('-----BEGIN')) return new X509Certificate(trimmed);
  return new X509Certificate(Buffer.from(trimmed, 'base64'));
}
