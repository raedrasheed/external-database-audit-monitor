# EDAM Key Ceremony Policy (DRAFT)

**Doc ID:** EDAM-KEY-POLICY-1.0
**Status:** PLANNING ONLY — this is a design/policy draft for Production Security
Sign-Off (Phase P2, task P2-KEY). It does **not** authorize, schedule, or constitute
any implementation, HSM provisioning, or configuration change. Nothing here is wired
into running code yet (see "Code gaps", §11).

This document is grounded in the existing EDAM signing/verifier interfaces:
`Signer` / `createSigner` / `Pkcs11Signer` / `Pkcs11Provider` (`packages/signing`),
`KeyRotationRegistry` / `KeyRecord` / `DualControlApproval`
(`packages/signing/src/key-registry.ts`), the `SignAlgorithm` enum, the verifier
`TrustFile` (`signing_keys` / `anchor_certs` / `export_keys`,
`apps/verifier-cli/src/trust.ts`), and `ExportSigner` + `exportSigningMessage`
(`@edam/export`).

## 1. Purpose & scope
Governs creation, custody, publication, rotation, revocation, and emergency
replacement of all EDAM trust keys, in support of §15 S-4 (secure crypto path) and
S-9 (audited keys). Two **trust planes** are governed distinctly:

- **Evidence trust** — keys whose public halves the independent verifier consumes to
  validate evidence (evidence-signing + export-signing). Auditor-reproducible.
- **Transport trust** — the mTLS PKI that authenticates service-to-service traffic.
  **Never** consulted to validate evidence and **explicitly excluded** from the
  verifier trust file.

## 2. Root trust hierarchy
```
Offline Root of Trust (air-gapped HSM, M-of-N) — signs ONLY class roots
  ├── Evidence-Signing root → rotating anchor keys (verifier trust.signing_keys)
  ├── Export-Signing root    → rotating export keys (verifier trust.export_keys)
  └── mTLS Issuing CA         → service SVIDs (TRANSPORT ONLY; excluded from verifier trust)
```
The Root signs nothing operational; it activates only under quorum and is otherwise
sealed.

## 3. Key classes
| Class | Purpose | Signs | Lifecycle home | Trust output |
|---|---|---|---|---|
| **Evidence-signing** | anchor-record `hsm_signature` | canonical `AnchorPayload` via `Signer.sign` | `KeyRotationRegistry` | `trust.signing_keys` |
| **Export-signing** | export-package `export_signature` | domain-tagged `exportSigningMessage(packageHash)` | `KeyRotationRegistry` (export instance) | `trust.export_keys` |
| **mTLS intermediate CA** | issue short-lived service SVIDs | X.509 CSRs | cert tooling (SPIRE / cert-manager) | **none — excluded from verifier trust** |

## 4. Algorithm decision (APPROVED)
- **Preferred: Ed25519.**
- **Fallback: ECDSA-P384** — used **only** if the selected HSM does **not** support
  Ed25519 natively.
- Both are members of `SignAlgorithm = ecdsa-p384 | ed25519 | rsa-pss-3072 | ecdsa-p256`
  (matches `anchor-record-1.0` §16.2).
- The published `KeyRecord.algorithm` **MUST** equal the HSM provider's algorithm or
  `Pkcs11Signer` fails closed (`AlgorithmMismatchError`). One algorithm per key class;
  mixing is prohibited.
- The mTLS CA may use ECDSA-P256/P384 independently (transport plane), decided by the
  cert tooling, not this policy.

## 5. Custodian model (M-of-N) — APPROVED 3-of-5
- **Production quorum: 3-of-5.** Five distinct, role-separated custodians (S-7/S-8);
  no individual holds quorum. Quorum is required for root activation, `rotate`,
  `revoke`, and emergency replacement.
- Custodian replacement is itself a quorum-approved, WORM-logged event. The `N > M`
  margin is maintained at all times.

## 6. Rotation cadence
- **Scheduled:** evidence-signing and export-signing keys rotate **annually** (or per
  the governing regulatory policy, whichever is shorter). mTLS SVIDs auto-rotate
  ≤ 24 h via transport tooling (out of scope of this policy's evidence plane).
- **Overlap window is mandatory:** the prior key remains in `KeyRotationRegistry`
  history and verifiable for anchors signed before the switch (`created_at ≤ signed_at`).
- Off-cycle rotation is permitted on suspected weakening; always quorum-approved.

## 7. Revocation policy
- `revoke(id, approval, revokedAt)` sets `revoked_at`. **Rotate-before-revoke** is
  enforced (`CannotRevokeActiveKeyError`).
- Verifier-consumable semantics: a signature with `signed_at < revoked_at` remains
  **valid**; `signed_at ≥ revoked_at` is rejected (`RevokedKeyError`).
- Revocation never retroactively invalidates lawfully-anchored prior evidence.
  **Historical public keys are never purged.**

## 8. Emergency replacement policy
- On compromise: quorum-authorized emergency key generation; `revoke` the compromised
  key with `revoked_at` set to the earliest suspected-compromise instant; immediate
  trust-file republication; **critical alarm**; mandatory post-incident review.
- **Re-anchor decision** (documented, not automated): whether anchors in the suspect
  window are re-anchored depends on a forensic determination of misuse.
- Break-glass is time-boxed, dual-approved, and fully audited (operational build is
  the separate task P2-DUAL-CONTROL).

## 9. Audit & WORM custody requirements (S-9)
Every ceremony and lifecycle event is **born-locked** in the evidence WORM store:
ceremony transcript + witnesses; each `KeyRecord` change with the M-of-N approval,
ticket id, ceremony id, and `requestedBy` / `approvedBy` / witnesses; custodian roster
+ share custody; HSM model / firmware / FIPS cert; trust-file publication hash. All
auditor-reproducible from public inputs (INV-EV-5).

- **WORM transcript path:** `p2-key/ceremony/<ceremony_id>/...`
- **Repository reproducibility artifacts:** `docs/evidence/p2-key/`

## 10. HSM provider (DECISION OPEN)
The final HSM provider is **intentionally not selected** in this planning package.
Candidate options carried forward (to be decided in a later task):
- **AWS CloudHSM** — dedicated FIPS 140-3 L3, native Ed25519, PKCS#11.
- **Azure Managed HSM** — managed FIPS 140-3 L3 pool (Azure-resident deployments).
- **YubiHSM 2** — on-prem device, lowest TCO for self-hosted / low-throughput.

(Other providers, e.g. GCP Cloud HSM, may be evaluated; Ed25519 native support is a
gating criterion per §4.)

## 11. Code gaps (NOT production-sufficient yet)
This policy is **not** backed by production code. The following gaps exist and are
deferred to later, separately-approved tasks (see the planning package index):
- **HSM-backed `ExportSigner` missing** (dev node:crypto signer only).
- **Concrete `Pkcs11Provider` missing** (`Pkcs11Signer.sign` throws
  `Pkcs11NotConfiguredError`).
- **Trust-file generator missing** (no module turns `KeyRotationRegistry` history into
  a `trust.json`).
- **Dual-control stub still present** — the registry's `assertDualControl` enforces
  only `requestedBy !== approvedBy` and is **explicitly marked a STUB, not production
  sufficient**.
- **Ceremony artifacts not yet modeled** (no `KeyLifecycleAuditRecord` schema / WORM
  writer wiring).
- **CI drift guard not yet present** (no conformance test recomputing the trust file
  from the registry).
