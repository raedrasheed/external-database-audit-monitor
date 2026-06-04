# EDAM-S3-REVAL — Hardened Store-Level WORM Revalidation Report

**Task:** EDAM-S3-REVAL (Sprint-3 Phase P1, final task).
**Date:** 2026-06-04.
**Goal:** re-run the T161 live evidence path + the T162 offline verifier / tamper
drills on the **hardened** store-level WORM stack, and explicitly **close T161-M2**.
**Not in scope (not started):** production HSM, external TSA/transparency log, mTLS,
S-8 dual-control, any other production-hardening task.

## 1. Determination

**Revalidation PASSES on the hardened stack.** The live evidence path succeeds with
per-role SoD credentials + default COMPLIANCE retention; every written object is
**born locked (COMPLIANCE) at the store**; **overwrite/delete is denied at the store
level** (IAM 403 + Object-Lock WORM, not merely an adapter guard); the valid offline
export **PASSes**; and **all nine tamper drills fail as expected**. **T161-M2 is
closed.** Evidence: `docs/evidence/s3-reval/`.

## 2. Hardened stack used

| Property | Value |
|---|---|
| Store | MinIO S3 Object Lock, bucket `edam-evidence` |
| `object_lock` asserted | true |
| `versioning_enabled` | true |
| Credentials | **per-role SoD** (`edam-writer` / `edam-reader` / `edam-retention-admin`); `role_separation_enforced = true` |
| Default retention | **COMPLIANCE 365 days** (born-locked) |
| IAM policies | the accepted S3-SoD least-privilege policies |
| Store enforcement | the accepted H5 403 matrix |

## 3. Live evidence path (T161-equivalent, hardened)

- Built real CCEs (streaming-phase cce-1.1), **2 segments / 3 objects**:
  `seg-reval-<run>-000000` (2 CCEs) + `seg-reval-<run>-000001` (1 CCE).
- **Wrote** each object via the **writer** role (`putImmutable`); **read back** via the
  **reader** role — `all_read_back_ok = true`.
- **Sealed** (segment manifests + heads), **signed** (in-process `@edam/signing`
  `DevEd25519Signer`), **anchored** (in-process `@edam/anchoring` `DevRfc3161Provider`
  → verified token → `buildAnchorRecord`).
- Confirmed populated: `worm_object_key`, `segment_id`, anchor record / `anchor_ref`
  (`head_hash` + `hsm_signature` + `rfc3161` provider).
- **Born-locked COMPLIANCE:** every read-back object has `retainUntil != null` and raw
  `getObjectRetention().mode === "COMPLIANCE"` (`all_born_locked = true`,
  `all_compliance = true`).

> In-process signer/anchor are **dev** providers (NOT external live services) — same
> boundary as T161; production HSM/TSA are out of scope here.

## 4. T161-M2 closure (store-level immutability — not adapter-only)

| Proof | Result |
|---|---|
| Objects born with **store-level COMPLIANCE retention** | ✅ raw `getObjectRetention` = `COMPLIANCE` on every object |
| Adapter no-overwrite | ✅ `putImmutable` of an existing key rejected (`WormError`) |
| **Store-level** delete denial (raw **writer** credential, no adapter) | ✅ `removeObject` → **`AccessDenied`** (IAM 403) |
| **Store-level** version-delete of a locked version, even for **root**, with `governanceBypass` | ✅ rejected → **`InvalidRequest`** (Object Lock COMPLIANCE; non-bypassable) |
| Object still present after all delete attempts | ✅ true |

**The previous T161-M2 gap is closed:** immutability/retention is now enforced by
MinIO Object Lock + IAM at the store, proven via raw clients that bypass the adapter.

## 5. Offline verifier + tamper drills (T162-equivalent, hardened artifacts)

A fresh export package + sidecar object bundle + out-of-band trust file were built
from the hardened live run and verified with `@edam/verifier-cli`
(`runExportVerification`).

**Valid run:** `export_signature = PASS`, `overall = PASS`, **exit 0**.

| Drill | WV | Via | Outcome | Fails as expected |
|---|---|---|---|---|
| byte-flip | WV-2 | verifier-CLI | `per_object_hash` FAIL, exit 1 | ✅ |
| withhold-object | WV-3 | verifier-CLI | hydration fail-closed, exit 2 | ✅ |
| break-link | WV-4 | verifier-CLI | `object_chain` FAIL, exit 1 | ✅ |
| forge-signature | WV-5 | verifier-CLI | `hsm_signature` FAIL (export_signature PASS), exit 1 | ✅ |
| tamper-token | WV-6 | verifier-CLI | `anchor_token` FAIL, exit 1 | ✅ |
| segment-gap | WV-9 | verifier-CLI | `export_signature` FAIL (package_hash recompute), exit 1 | ✅ |
| offset-gap | WV-10 | verifier-CLI | `no_missing_event` FAIL, exit 1 | ✅ |
| legal-hold-delete | WV-8 | live MinIO/WORM | adapter **and** store deny deletion under hold | ✅ |
| tsa-outage | WV-13 | in-process anchoring | provider yields no token → builder refuses (no fabrication) | ✅ |

`all_drills_fail_as_expected = true`.

A committed regression guard (`conformance/test/s3-reval-offline-verify.test.ts`)
re-verifies the committed hardened export package offline (PASS, exit 0) in the
default `npm test` — no MinIO required.

## 6. Verification

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 |
| full test suite | green (incl. the new S3-REVAL offline re-verify + the S3-policy-audit gate) |
| determinism rig | exit 0 |
| compose-validate | OK |
| policy audit (static gate) | PASS (0 violations) |
| live H5 suite | 33/33 (env-gated) |
| **live S3-REVAL run** | live path OK, valid export PASS, 9/9 drills fail as expected |

## 7. Acceptance

- Live evidence path succeeds on the hardened store-level WORM stack. ✅
- Valid offline export PASSes. ✅
- All tamper drills fail as expected. ✅
- Store-level retention/immutability proven (raw clients, not adapter guards). ✅
- **T161-M2 is closed.** ✅
- No temporary harness committed (the harness was deleted before commit). ✅
- Verification green. ✅

## 8. Status

- **T161-M2 is closed.**
- **Sprint 3 Phase P1 is complete at the store-level WORM boundary**
  (H3 ✓ H1 ✓ H2 ✓ H4 ✓ S3-SoD ✓ SOD-F1/B2 ✓ POLICY-AUDIT ✓ H5 ✓ S3-REVAL ✓).
- **No later production-hardening task was started** (HSM / external TSA / mTLS /
  S-8 dual-control remain future Production Security Sign-Off work).

## 9. Artifacts

- `docs/evidence/s3-reval/s3-reval-result.json` — machine-readable revalidation result.
- `docs/evidence/s3-reval/export-package.json` — hardened-run export package.
- `docs/evidence/s3-reval/objects/**` — sidecar CCE object bundle (read back from live MinIO).
- `docs/evidence/s3-reval/trust.json` — out-of-band trust file.
- `docs/evidence/s3-reval/valid-report.json` — verifier report for the valid run.
- `conformance/test/s3-reval-offline-verify.test.ts` — committed offline re-verify guard.
- `docs/EDAM-S3-REVAL-Report.md` — this report.
