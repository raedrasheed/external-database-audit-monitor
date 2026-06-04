# EDAM-P2-HSM-DRYRUN — Implementation Report

**Task:** P2-HSM-DRYRUN (Production Security Sign-Off, Phase P2). **Governed by
ADR-EDAM-001** (Ed25519 sole production algorithm). Scope strictly limited to:
**SoftHSM2 only**, **Ed25519 / `CKM_EDDSA` only**, **PKCS#11 integration only**,
**test-scoped**, **gated**, **no production keys / deployment**. No CloudHSM / Azure /
YubiHSM / ceremony / dual-control / TSA / mTLS work.

## 1. Summary

Proved the **existing** `Pkcs11Signer` HSM seam works **unchanged** against a real
PKCS#11 module: generate a **non-exportable Ed25519** key in SoftHSM2 → sign an
`AnchorPayload` via `createSigner({kind:'pkcs11'})` → verify → build a trust file from
the registry (P2-TRUST-GENERATOR) → **end-to-end** verify through the published trust
roots → prove the private key never leaves the HSM → exercise fail-closed paths. **5/5
live tests pass.**

## 2. The seam is unchanged (non-negotiable constraints honored)

| Constraint | Status |
|---|---|
| Signer API (`Signer.sign`) | **unchanged** |
| `createSigner()` | **unchanged** (used as-is; `{kind:'pkcs11'}`) |
| `Pkcs11Signer` / `Pkcs11Provider` SPI | **unchanged** (the helper *implements* the SPI) |
| `KeyRotationRegistry` | **unchanged** |
| Trust-file generation (`buildTrustFile`) | **unchanged** (consumed as-is) |
| Production verification behavior | **unchanged** (no verifier edits in this task) |
| Fail-closed | preserved (`Pkcs11NotConfiguredError`, `AlgorithmMismatchError`) |

All changes are **test-scoped + docs/evidence** — no `packages/*/src` runtime file was modified.

## 3. What was built

- **`packages/signing/test/helpers/softhsm-ed25519.ts`** — a SoftHSM2-backed
  `Pkcs11Provider` (Ed25519 / `CKM_EDDSA`) + keygen helper (`CKA_EXTRACTABLE=false`,
  `CKA_SENSITIVE=true`) + **SPKI export** (EC_POINT → 32-byte raw → Ed25519 SPKI DER →
  base64, verifier-compatible) + non-exportability prover. `pkcs11js` is loaded
  **dynamically via a variable specifier**, so the repo typechecks/lints/CI-runs
  **without** the native dependency; the gated test is the only consumer.
- **`packages/signing/test/pkcs11-softhsm.integration.test.ts`** — gated suite
  (`PKCS11_MODULE_PATH` set ⇒ run; else skip). Tests: sign+verify; **end-to-end via the
  trust generator**; non-exportability proof; two fail-closed paths.
- **`docs/adr/ADR-EDAM-001-signing-algorithm.md`** — the adopted governing ADR.
- **`docs/evidence/p2-hsm-dryrun/dryrun-result.json`** — the evidence artifact.

## 4. Security analysis

- **Private key never leaves the HSM (INV-EV-4):** generated `CKA_EXTRACTABLE=false`,
  `CKA_SENSITIVE=true`; reading `CKA_VALUE` on the private key is **denied**
  (`value_read_denied=true`). The `Pkcs11Provider` SPI returns **only a 64-byte
  signature**; no method exposes private material.
- **No signing oracle (INV-EV-2):** the adapter signs a typed `AnchorPayload` only
  (validated + domain-separated in-process); the HSM mechanism (`CKM_EDDSA`) only ever
  receives the domain-separated anchor message.
- **Algorithm binding:** the provider's algorithm is checked against the published key
  (`AlgorithmMismatchError`); Ed25519 only (ADR-EDAM-001).
- **Fail-closed:** unconfigured signer ⇒ `Pkcs11NotConfiguredError`; mismatch ⇒
  `AlgorithmMismatchError`; any HSM error throws (no fabricated signatures).
- **Signature compatibility:** SoftHSM2 `CKM_EDDSA` emits a raw 64-byte Ed25519
  signature that Node `crypto.verify(null, …)` (the verifier's path) accepts directly —
  no DER/encoding ambiguity. End-to-end verification through a P2-TRUST-GENERATOR trust
  file PASSes.
- **SoftHSM2 caveat:** software HSM — validates the *integration*, **not** FIPS 140-3 /
  hardware tamper-resistance (that requires a real HSM; deferred to sign-off).

## 5. Verification results

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 |
| full test suite (no HSM env) | green; the HSM suite **skips** (5 skipped) |
| determinism rig | exit 0 |
| compose-validate | OK |
| **live SoftHSM2 dry-run** | **5/5 passed** |

### End-to-end verification (live)
- Ed25519 key generated in SoftHSM2 (`CKA_EXTRACTABLE=false`).
- `createSigner({kind:'pkcs11'})` signed an `AnchorPayload` → 64-byte signature → verifies.
- Trust file built from a `KeyRotationRegistry` holding the HSM key's SPKI → `loadTrustRoots` →
  the **published** key verifies the HSM signature (HSM → SPKI → trust generator → verifier).
- Non-exportability: `extractable=false`, `sensitive=true`, `value_read_denied=true`.
- Fail-closed: `Pkcs11NotConfiguredError`, `AlgorithmMismatchError`.

## 6. Files changed

| File | Type |
|---|---|
| `packages/signing/test/helpers/softhsm-ed25519.ts` | new (test helper / provider) |
| `packages/signing/test/pkcs11-softhsm.integration.test.ts` | new (gated test) |
| `docs/adr/ADR-EDAM-001-signing-algorithm.md` | new (adopted ADR) |
| `docs/EDAM-P2-HSM-DryRun.md` | new (this report) |
| `docs/evidence/p2-hsm-dryrun/dryrun-result.json` | new (evidence artifact) |

No production/runtime/`src` files changed. `pkcs11js` is **not** a committed
dependency — running the dry-run locally requires `npm install pkcs11js` + SoftHSM2 ≥ 2.5
and the `PKCS11_MODULE_PATH` / `SOFTHSM2_CONF` / token env (documented in the test header).

## 7. Evidence artifact

`docs/evidence/p2-hsm-dryrun/dryrun-result.json` — SoftHSM2 version, Ed25519 key
attributes (signing_key_id + SPKI), sign/verify result, end-to-end result,
non-exportability proof, fail-closed proof.

## 8. Independent adversarial-review readiness

Ready. A reviewer can: confirm the footprint is test/docs-only and the seam files are
unchanged; install SoftHSM2 + pkcs11js, init a token, run the gated suite (5/5) and
reproduce the evidence; independently verify a SoftHSM2 EDDSA signature against the
exported SPKI with `openssl`/Node; confirm the gated test skips without the env; re-run
typecheck/lint/full-suite/determinism/compose. The dry-run changes nothing in the
production path, so regression risk is zero (the HSM suite is gated/skipped by default).

## 9. Scope statement

- **Not started:** P2-HSM-SIGNER, P2-HSM-EXPORT-SIGNER, P2-DUAL-CONTROL, P2-TSA, P2-MTLS,
  ceremony execution, or any later task.
- Deferred to **P2-HSM-SIGNER**: production `Pkcs11Provider` (HA sessions/pooling/retries,
  vendor config), real-HSM FIPS attestation, wiring into the live anchoring/evidence-writer
  path, production key provisioning.
