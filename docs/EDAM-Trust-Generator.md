# EDAM-P2-TRUST-GENERATOR — Implementation Report

**Task:** P2-TRUST-GENERATOR (Production Security Sign-Off, Phase P2). Built on
dev/test keys per decision **D5** (before the real HSM ceremony). Does **not** start
P2-HSM / P2-TSA / P2-DUAL / P2-MTLS or any later task.

## 1. Summary

Implemented the out-of-band **verifier trust-file generator**: it projects the
**PUBLIC** key history of the evidence-signing and export-signing
`KeyRotationRegistry` instances into the verifier trust file (`signing_keys` +
`export_keys`), passes through the P2-TSA-owned `anchor_certs` placeholder, computes a
content hash, carries a monotonic `trust_version`, and is protected by a CI **drift
guard**. The mTLS transport CA is structurally and actively excluded. Both key
validity bounds (`not_before` + `revoked_at`) are now enforced offline.

## 2. The `not_before` decision (both-bounds requirement)

Per the additional requirement, historical validity now enforces
`created_at ≤ signed_at < revoked_at`. The verifier already enforced `revoked_at`; the
**lower bound** (`not_before`, derived from `KeyRecord.created_at`) was missing.

- **Assessment:** small + **backward-compatible** → **included** (per the task rule).
- **Generator:** emits `not_before` on every `signing_keys`/`export_keys` entry.
- **Verifier:** `verify-anchor.ts` (`verifyHsmSignature`) and `verify-export.ts`
  (`verifyExportSignature`) now reject a signature whose instant precedes the key's
  `not_before` — **conditional on `key.not_before != null`**, so trust files without it
  are unaffected. Verified: the committed S3-REVAL and T162 trust files (no
  `not_before`) still PASS unchanged.

## 3. Architecture & data flow

```
evidence KeyRotationRegistry.history() ─┐
export   KeyRotationRegistry.history() ─┤─ buildTrustFile() ─► trust.json (+ trust_version, hash)
P2-TSA anchor_certs (placeholder []) ───┘     │ (mTLS-CA guard; both bounds; sorted/canonical)
                                              ▼
                              loadTrustRoots(trust.json) ◄── verifier (public-inputs-only)
                                              ▲
                CI drift guard: recompute(snapshot) == committed trust.json + hash
```

- **Source of truth:** the registries' **full** public-key history (active + rotated +
  revoked; never pruned).
- **Inputs:** `{ evidence, export: KeyRotationRegistry, anchorCerts?=[], meta:{trust_version,generated_at,ceremony_id?} }`.
- **Outputs:** canonical `trust.json` + `eventHash(serializeCanonical(trust))`.

## 4. Guards & failure modes (fail-closed)

| Condition | Behavior |
|---|---|
| Certificate material in a signing/export key (mTLS-CA) | refuse (`TrustFileGenerationError`) |
| `key_id` in **both** evidence and export planes | refuse (cross-plane collision) |
| All three arrays empty | refuse (mirrors `loadTrustRoots` empty-set) |
| `trust_version` not a positive integer / bad `generated_at` | refuse |
| Malformed `anchor_cert` | refuse |

**mTLS exclusion (3 layers):** the trust-file schema has no transport array (structural);
the generator has no CA input channel; certificate material is refused in the key planes.

## 5. Historical-verification guarantee

`KeyRotationRegistry` never drops a key (`rotate` appends; `revoke` updates in place,
retains). The generator emits the full history, so the **latest** trust file verifies
evidence signed by **older (even revoked)** keys — an old anchor's `signed_at` precedes
its key's `revoked_at`, so the revocation gate passes. The drift guard asserts history
is never pruned.

## 6. Files changed

| File | Change |
|---|---|
| `packages/signing/src/trust-file.ts` | **new** — `buildTrustFile()` generator + types + `TrustFileGenerationError` |
| `packages/signing/src/index.ts` | export the generator API |
| `packages/verifier/src/verify-anchor.ts` | conditional `not_before` lower-bound enforcement (anchor) |
| `packages/verifier/src/verify-export.ts` | conditional `not_before` lower-bound enforcement (export) |
| `packages/verifier/test/verify-anchor.test.ts` | +2 tests (`not_before` reject + at/before-PASS) |
| `conformance/scripts/trust-file.ts` | generator/printer over the committed snapshot (`--write` regenerates) |
| `conformance/test/trust-file-drift.test.ts` | **new** — drift guard (8 tests) |
| `docs/trust/registry-snapshot.json` | committed dev/test registry snapshot (public keys; incl. a rotated+revoked key) |
| `docs/trust/trust.json` | generated trust file (committed) |
| `docs/trust/trust-hash.txt` | published content hash |
| `docs/EDAM-Trust-Generator.md` | this report |

## 7. Verification

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 |
| full test suite | **703 passed / 28 skipped** (+8 drift, +2 `not_before`) |
| determinism rig | exit 0 |
| compose-validate | OK |
| backward-compat | S3-REVAL + T162 offline re-verify still PASS (trust files without `not_before` unaffected) |

## 8. Scope

- `anchor_certs` left an explicit P2-TSA **placeholder** (empty; never fabricated).
- HSM key material **not** required (dev/test keys, D5); production keys slot in later
  by regenerating from a production registry snapshot.
- **Not started:** P2-HSM, P2-TSA, P2-DUAL, P2-MTLS, or any later task.
