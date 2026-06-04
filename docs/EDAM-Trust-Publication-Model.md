# EDAM Trust Publication Model (DRAFT)

**Doc ID:** EDAM-TRUST-PUBLICATION-1.0
**Status:** PLANNING ONLY — design for how the verifier trust file is produced and
kept honest. **No generator exists yet** (see "Code gaps", §8); this defines the model
the later task **P2-TRUST-GENERATOR** will implement (per decision D5, built **before**
the real HSM ceremony, using dev/test keys first, then pointed at production
HSM-generated keys).

Grounded in the verifier `TrustFile` shape (`signing_keys` / `anchor_certs` /
`export_keys`, `apps/verifier-cli/src/trust.ts`, consumed via `loadTrustRoots`) and
`KeyRotationRegistry` (`packages/signing/src/key-registry.ts`).

## 1. The three trust planes (distinct)
| Plane | Keys | Verifier trust array | Who owns it |
|---|---|---|---|
| **Evidence trust** | evidence-signing (anchor `hsm_signature`) | `signing_keys` | P2-KEY (this model) |
| **Export trust** | export-signing (`export_signature`) | `export_keys` | P2-KEY (this model) |
| **TSA/anchor trust** | RFC-3161 / transparency-log roots | `anchor_certs` | **P2-TSA** (placeholder here) |
| **Transport (mTLS)** | mTLS intermediate CA | **none** | cert tooling — **excluded** |

## 2. Source of truth
`KeyRotationRegistry` public-key **history** is the single source of truth. It resolves
**active + rotated + revoked** keys (`getPublicKey` / the public-key history), and
historical keys are **never purged**, so anchors signed under a rotated/revoked key
remain verifiable.

## 3. `signing_keys` generation
Map each **evidence-class** `KeyRecord` → a trust entry
`{ key_id, algorithm, public_key, revoked_at }`. Includes every historical evidence
key (active, rotated, revoked) so the verifier can resolve any anchor's
`signing_key_id`.

## 4. `export_keys` generation
Same mapping for the **export-class** registry (the export-signing keys that sign
`exportSigningMessage(packageHash)`).

## 5. `anchor_certs` — P2-TSA integration placeholder
`anchor_certs` (`{ ref, algorithm, public_key }`) holds the production TSA / transparency
-log roots. It is **owned by P2-TSA** and left as a **placeholder** (empty / staged) in
this model. Until P2-TSA lands, anchor verifications that require a real TSA root remain
pending; the generator MUST leave a clearly-marked placeholder rather than fabricate a
root.

## 6. mTLS CA exclusion (invariant)
The mTLS intermediate CA is **never** written to any evidence-trust array. It
authenticates transport, not evidence. The generator MUST **reject** any attempt to add
a CA certificate to `signing_keys` / `export_keys` / `anchor_certs`.

## 7. Versioning, hashing & drift prevention
- **Versioning:** `trust.json` carries a monotonically increasing `trust_version`,
  `generated_at`, and the `ceremony_id` that produced it. Each rotation / revocation
  bumps the version.
- **Hash publication:** publish `sha256(canonical(trust.json))` to an out-of-band,
  append-only channel **and** the WORM audit log, so auditors pin the exact trust roots.
- **Drift prevention:** the trust file is **generated, never hand-edited**. A **CI
  drift guard** (analogous to the accepted `conformance/test/s3-policy-audit.test.ts`
  gate) recomputes the trust file from the committed registry snapshot and **fails on
  mismatch**. The verifier loads only the published, hash-pinned trust file via
  `loadTrustRoots`.

## 8. Code gaps (not yet implemented)
- **Trust-file generator missing** — to be built in P2-TRUST-GENERATOR.
- **CI drift guard not yet present** — to be added alongside the generator.
- (Related) **dual-control stub still present**, **HSM `Pkcs11Provider` / `ExportSigner`
  missing**, **ceremony artifacts not yet modeled** — tracked in the planning package
  index; they gate when the generator is pointed at **production** keys (it may use
  dev/test keys first, per D5).
