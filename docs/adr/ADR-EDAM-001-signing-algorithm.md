# ADR-EDAM-001 — Signing Algorithm Standardization

**Status:** **Accepted** (governing decision; adopted 2026-06-04)
**Scope:** evidence anchor signatures (`hsm_signature`) and export-envelope signatures
(`export_signature`). Excludes TSA/transparency-log certs (RFC-3161/RFC-6962, owned by
P2-TSA) and mTLS transport certs (separate PKI).

## Context
EDAM evidence integrity rests on anchor + export signatures verified offline by an
independent verifier (public-inputs-only, INV-EV-4/5) with no builder↔verifier drift
(INV-EV-2). The verifier accepts **only Ed25519** today:
`packages/verifier/src/verify-anchor.ts` and `verify-export.ts` reject any
`sig.algorithm !== 'ed25519'`. All concrete signers (`DevEd25519Signer`, the
`Pkcs11Signer` HSM path) target Ed25519. The four candidate HSMs (AWS CloudHSM, Azure
Managed HSM, YubiHSM 2, SoftHSM 2 ≥ 2.5) all support Ed25519 (`CKM_EDDSA`). FIPS 186-5
(2023) added EdDSA, so Ed25519 is FIPS-approvable. The broader `SignAlgorithm` enum
(`ecdsa-p384 | ed25519 | rsa-pss-3072 | ecdsa-p256`) and the `anchor-record-1.0` schema
retain other members for data-model forward-compatibility only — no verifier path
implements them.

## Decision
**Standardize EDAM production evidence-signing and export-signing on Ed25519 as the
single approved algorithm.** The verifier's Ed25519-only enforcement is **intentional
and ratified**. Production HSM keys are Ed25519 (`CKM_EDDSA`, non-exportable). The enum
members for other algorithms remain in the data model but **no other algorithm is
implemented or supported** in production.

## Alternatives considered
1. **Multi-algorithm from day one (Ed25519 + ECDSA-P384).** Rejected — doubles the
   crypto surface + a pre-hash/encoding contract + drift risk, for no current need.
2. **ECDSA-P384 as the standard.** Rejected — more complex sign/verify (SHA-384
   pre-hash, DER vs IEEE-P1363 encoding ambiguity), larger signatures, no security
   advantage at the relevant level, and would break the current verifier.
3. **RSA-PSS-3072 / ECDSA-P256.** Rejected — no benefit; larger surface.
4. **Ed25519 standard + ECDSA-P384 as a dormant contingency (chosen).**

## Consequences
- **Positive:** simplest correct verify path (PureEdDSA, raw 64-byte signature, no
  pre-hash, no encoding ambiguity); minimal drift surface (INV-EV-2); uniform across
  all candidate HSMs; FIPS 186-5 approvable; already aligned across signer + verifier +
  trust generator.
- **Negative / accepted:** single-algorithm dependency — a future hard requirement
  (an HSM/regulator precluding EdDSA) would need a scoped multi-algorithm project.
- **Operational:** the P2-HSM dry-run + signer use `CKM_EDDSA`; the trust file
  `algorithm` is `ed25519`; no change to the generator or registry.

## Migration path (only if ECDSA-P384 ever becomes required)
1. A new ADR superseding this one, stating the concrete triggering requirement.
2. Verifier: **additive** algorithm dispatch (retain Ed25519; add a P-384 branch with
   SHA-384 + IEEE-P1363 decoding) for both anchor + export; fix the pre-hash contract in
   one shared, tested location to avoid drift.
3. Provision a P-384 HSM key; `KeyRotationRegistry.rotate` with an overlap window;
   regenerate the trust file (P2-TRUST-GENERATOR passes `algorithm` through — no change).
4. New anchors → P-384; **all historical Ed25519 evidence remains verifiable** (dispatch
   + retained branch).
5. Independent security review + dual-algorithm verifier tests + an S3-REVAL-style
   re-validation before sign-off.

## Rationale
Ed25519 minimizes cryptographic and drift risk, is uniformly HSM-supported, is
FIPS-approvable, and is already the only path the verifier implements. Carrying a second
algorithm now would add a security-critical surface and a pre-hash/encoding contract
with zero present benefit. Retaining the enum members preserves a clean, non-breaking
upgrade path should a real requirement ever arise.

## Position on ECDSA-P384
**Removed from the active production roadmap; retained only as a dormant data-model
contingency.** No P2 task plans, implements, or budgets ECDSA-P384. It is re-activated
**only** upon a concrete, documented blocking requirement, at which point it requires a
**separate ADR, independent security review, verifier re-validation, and migration
plan** (per the migration path above). Neither "actively roadmapped" nor "purely
theoretical forever" — a **gated contingency**: closed on the roadmap, open in the
schema, re-opened only by a real requirement.

## Governance note
This ADR governs P2-HSM-DRYRUN and all subsequent P2 signing work. It refines Key
Ceremony Policy decision **D1** ("Ed25519 preferred, ECDSA-P384 fallback"): Ed25519 is
now the **standard**, and the ECDSA-P384 "fallback" is **downgraded to a gated
contingency** not expected to trigger (all candidate HSMs support Ed25519).
