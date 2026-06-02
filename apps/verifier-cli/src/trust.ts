// Out-of-band trust loading (EDAM-T146, Q4/Q5).
//
// Real verification requires a MANDATORY `--trust trust.json` file: the published,
// out-of-band trust roots an independent auditor obtains separately from the
// export. The package's own `public_keys` / `timestamp_certificates` are
// CONVENIENCE INFORMATION ONLY — never authoritative (a forger who re-signed the
// package would otherwise supply their own keys). This module parses the trust
// file into the three authoritative directories the verifier consumes:
//   - signing keys (HSM anchor-signing public keys),
//   - anchor certificates (TSA / transparency-log public certs/keys),
//   - export-signing keys (the key that signs the export envelope).

import {
  InMemorySigningKeyDirectory,
  InMemoryAnchorCertDirectory,
  type TrustedSigningKey,
  type TrustedSigningKeyDirectory,
  type TrustedAnchorCert,
  type TrustedAnchorCertDirectory,
} from '@edam/verifier';

/** The on-disk trust-file shape (out-of-band published material). */
export interface TrustFile {
  /** HSM anchor-signing public keys, resolved by `signing_key_id`. */
  signing_keys?: TrustedSigningKey[];
  /** TSA / transparency-log certs/keys, resolved by `tsa_cert_ref` / `log_id` (the `ref`). */
  anchor_certs?: TrustedAnchorCert[];
  /** Export-envelope signing public keys, resolved by `signing_key_id`. */
  export_keys?: TrustedSigningKey[];
}

/** The authoritative trust roots, as directories the verifier consumes. */
export interface TrustRoots {
  signingKeys: TrustedSigningKeyDirectory;
  anchorCerts: TrustedAnchorCertDirectory;
  exportKeys: TrustedSigningKeyDirectory;
}

/** Raised when the trust file is missing required material or is malformed. Fail-closed. */
export class TrustFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustFileError';
  }
}

function isStringKey(k: unknown): k is TrustedSigningKey {
  return typeof k === 'object' && k !== null
    && typeof (k as TrustedSigningKey).key_id === 'string'
    && typeof (k as TrustedSigningKey).algorithm === 'string'
    && typeof (k as TrustedSigningKey).public_key === 'string';
}

function isAnchorCert(c: unknown): c is TrustedAnchorCert {
  return typeof c === 'object' && c !== null
    && typeof (c as TrustedAnchorCert).ref === 'string'
    && typeof (c as TrustedAnchorCert).algorithm === 'string'
    && typeof (c as TrustedAnchorCert).public_key === 'string';
}

/**
 * Parse + validate an out-of-band trust file into the three authoritative
 * directories. Fail-closed: a malformed shape or a completely empty trust set is
 * an error (a trust file that grants nothing cannot support real verification).
 */
export function loadTrustRoots(raw: unknown): TrustRoots {
  if (typeof raw !== 'object' || raw === null) throw new TrustFileError('trust file must be a JSON object');
  const t = raw as TrustFile;

  const signing = t.signing_keys ?? [];
  const certs = t.anchor_certs ?? [];
  const exports = t.export_keys ?? [];

  if (!Array.isArray(signing) || !signing.every(isStringKey)) throw new TrustFileError('trust file: signing_keys must be {key_id,algorithm,public_key}[]');
  if (!Array.isArray(certs) || !certs.every(isAnchorCert)) throw new TrustFileError('trust file: anchor_certs must be {ref,algorithm,public_key}[]');
  if (!Array.isArray(exports) || !exports.every(isStringKey)) throw new TrustFileError('trust file: export_keys must be {key_id,algorithm,public_key}[]');

  if (signing.length === 0 && certs.length === 0 && exports.length === 0) {
    throw new TrustFileError('trust file is empty: no signing_keys / anchor_certs / export_keys to verify against');
  }

  return {
    signingKeys: new InMemorySigningKeyDirectory(signing),
    anchorCerts: new InMemoryAnchorCertDirectory(certs),
    exportKeys: new InMemorySigningKeyDirectory(exports),
  };
}
