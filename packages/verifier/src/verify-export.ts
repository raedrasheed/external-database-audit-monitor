// Export-package envelope verification (Sprint-2 / EDAM-T146).
//
// The Evidence Export Package (§12.1) carries its own `export_signature` over a
// canonical `package_hash`. This module re-proves that envelope seal from PUBLIC
// inputs only: it RECOMPUTES `package_hash` over the canonical package minus the
// signature (never trusting the carried value), then verifies the signature
// against a TRUSTED, out-of-band export-signing key directory — NEVER the
// package's own embedded keys (T145 carry-forward note).
//
// This is the package envelope check; the §10 evidence checks (steps 1-9) are
// the separate `verifySegments` path. Pure: re-derives the export-signing domain
// tag LOCALLY (no @edam/export dependency — verifier isolation, WV-12) and uses
// only @edam/canonical + node:crypto + the existing trust helpers.

import { serializeCanonical, eventHash } from '@edam/canonical';
import { verify as edVerify } from 'node:crypto';
import type { EvidenceExportPackage } from './input.js';
import { parsePublicKey, type TrustedSigningKeyDirectory } from './trust.js';
import type { CheckOutcome } from './verify-segments.js';

/**
 * The fixed export-signing domain tag, RE-DERIVED here (NOT imported from
 * @edam/export) to keep the verifier's dependency floor minimal and isolation
 * intact (Q3). MUST stay byte-identical to `@edam/export`'s
 * `EXPORT_SIGNATURE_DOMAIN` — a divergence would (correctly, fail-closed) reject
 * otherwise-valid exports.
 */
export const EXPORT_SIGNATURE_DOMAIN = 'edam-evidence-export-package-v1';

/** The exact bytes an export signer signs: `${EXPORT_SIGNATURE_DOMAIN}:${package_hash}` (mirrors @edam/export). */
export function exportSigningMessage(packageHash: string): Uint8Array {
  return new TextEncoder().encode(`${EXPORT_SIGNATURE_DOMAIN}:${packageHash}`);
}

/** Recompute the canonical package hash: eventHash(canonical(package minus export_signature)). */
export function recomputeExportPackageHash(pkg: EvidenceExportPackage): string {
  const { export_signature: _omit, ...withoutSignature } = pkg;
  return eventHash(serializeCanonical(withoutSignature));
}

function pass(details: string): CheckOutcome {
  return { result: 'PASS', offending_ids: [], details };
}

function fail(packageId: string, details: string): CheckOutcome {
  return { result: 'FAIL', offending_ids: [packageId], details };
}

/**
 * Verify the export envelope seal (§12.1). Fail-closed:
 *  1. RECOMPUTE `package_hash` and confirm it equals the carried value (never
 *     trust the claimed hash);
 *  2. resolve `export_signature.signing_key_id` in the TRUSTED (out-of-band)
 *     export-key directory — an unknown key is a FAIL (package-embedded keys are
 *     NOT authoritative);
 *  3. enforce algorithm match + Ed25519, honor `revoked_at`;
 *  4. verify the signature over the domain-tagged message for the RECOMPUTED hash.
 * Returns a `CheckOutcome` locating the package_id on failure.
 */
export function verifyExportSignature(pkg: EvidenceExportPackage, trustedExportKeys: TrustedSigningKeyDirectory): CheckOutcome {
  const id = pkg.package_id;
  const sig = pkg.export_signature;

  const recomputed = recomputeExportPackageHash(pkg);
  if (recomputed !== sig.package_hash) {
    return fail(id, `export package_hash does not recompute (carried ${sig.package_hash} !== recomputed ${recomputed})`);
  }

  const key = trustedExportKeys.get(sig.signing_key_id);
  if (key === undefined) return fail(id, `unknown (untrusted) export signing_key_id ${sig.signing_key_id}`);
  if (sig.algorithm !== key.algorithm) return fail(id, `export signature algorithm mismatch: ${sig.algorithm} !== trusted key ${key.algorithm}`);
  if (sig.algorithm !== 'ed25519') return fail(id, `unsupported export signature algorithm ${sig.algorithm}`);

  // Honor revocation: a key revoked at-or-before the export's created_at is invalid.
  if (key.revoked_at != null) {
    const revoked = Date.parse(key.revoked_at);
    const createdAt = Date.parse(pkg.created_at);
    if (Number.isFinite(revoked) && Number.isFinite(createdAt) && createdAt >= revoked) {
      return fail(id, 'export signing key revoked at/before the package created_at');
    }
  }

  try {
    const message = Buffer.from(exportSigningMessage(recomputed));
    const pub = parsePublicKey(key.public_key);
    const ok = edVerify(null, message, pub, Buffer.from(sig.signature, 'base64'));
    return ok ? pass(`export signature verifies (key ${sig.signing_key_id})`) : fail(id, 'export signature does not verify');
  } catch {
    return fail(id, 'export signature verification error (malformed key/signature)');
  }
}
