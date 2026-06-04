# EDAM-T104-H5 — Store-Level 403 Enforcement Report

**Task:** EDAM-T104-H5 (Sprint-3 Phase P1, after EDAM-S3-POLICY-AUDIT).
**Date:** 2026-06-04.
**Goal:** prove that WORM role separation is enforced by the **store** (MinIO IAM +
S3 Object Lock COMPLIANCE), not by the adapter — by exercising every required
operation through **raw `minio` clients** (and `mc`), bypassing `MinioWormStore`
entirely. **Not in scope:** S3-REVAL, production hardening.

## 1. Determination

**All store-level enforcement holds.** The live suite recorded **33/33 cells passing**:
every denied operation is rejected by the **store** (HTTP 403 `AccessDenied` for IAM
cells; `InvalidRequest`/WORM for the COMPLIANCE-bypass cell), every allowed operation
succeeds, and a governance-bypass delete of a COMPLIANCE-locked version is rejected
**even for the root identity**. Expectations were derived from the accepted
EDAM-S3-POLICY-AUDIT matrix; **no policy mismatch was found**, so no policy was
changed.

## 2. Method

- **Raw clients only.** Each operation is issued through a `new minio.Client(...)`
  built with a role's own credentials (`edam-writer` / `edam-reader` /
  `edam-retention-admin`) or root — never through the adapter. There are no
  application-level guards in the path; a denial is a store decision.
- **Expectations from the audit.** `infra/worm/test/h5-store-enforcement.integration.test.ts`
  imports `evaluate()`/`loadPolicy()` from `conformance/scripts/s3-policy-audit.ts`
  and derives the expected effect per `(role, s3:action)` from the **accepted
  POLICY-AUDIT matrix**. A live result that contradicts the audited model FAILS the
  suite (it does not silently "fix" anything).
- **Real, locked fixture.** A writer-seeded object (born locked by the bucket default
  COMPLIANCE retention) is the target, so a denial is the *only* reason an op fails.
- **Machine-readable evidence.** The suite emits
  `docs/evidence/h5/h5-enforcement-report.json` (role, action, basis, expected,
  actual, store status, pass) when `WORM_H5_REPORT_PATH` is set.
- **Opt-in gate:** `WORM_MINIO_ENDPOINT` + `WORM_MINIO_H5=true` — the default
  `npm test` stays MinIO-free (the suite is skipped).

## 3. Enforcement matrix (live, store-enforced)

`deny-access` = store IAM 403; `reject-worm` = S3 Object Lock COMPLIANCE rejection;
`allow` = 200/OK. Full rows: `docs/evidence/h5/h5-enforcement-report.json`.

### writer (`edam-writer`)
| Action | Expected | Actual (store) |
|---|---|---|
| `PutObject` | allow | **allow** (born locked by bucket default) |
| `DeleteObject` | deny | **deny-access** (403) |
| `DeleteObjectVersion` | deny | **deny-access** (403) |
| `PutObjectRetention` | deny | **deny-access** (403) |
| `PutObjectLegalHold` | deny | **deny-access** (403) |
| `BypassGovernanceRetention` | deny | **deny-access** (403) |
| `PutBucketPolicy` | deny | **deny-access** (403) |
| `PutBucketObjectLockConfiguration` | deny | **deny-access** (403) |
| `PutBucketVersioning` | deny | **deny-access** (403) |

### reader (`edam-reader`)
| Action | Expected | Actual (store) |
|---|---|---|
| `GetObject` | allow | **allow** |
| `GetObjectRetention` | allow | **allow** |
| `GetObjectLegalHold` | allow | **allow** |
| `ListBucket` | allow | **allow** |
| `PutObject` | deny | **deny-access** (403; object never created) |
| `DeleteObject` / `DeleteObjectVersion` | deny | **deny-access** (403) |
| `PutObjectRetention` / `PutObjectLegalHold` | deny | **deny-access** (403) |
| `PutBucketVersioning` / `PutBucketObjectLockConfiguration` / `PutBucketPolicy` | deny | **deny-access** (403) |

### retention-admin (`edam-retention-admin`)
| Action | Expected | Actual (store) |
|---|---|---|
| `PutObjectRetention` (extend, forward) | allow | **allow** |
| `PutObjectLegalHold` (ON / OFF) | allow | **allow** |
| `PutBucketVersioning` (edam-evidence) | allow | **allow** |
| `PutBucketObjectLockConfiguration` (edam-evidence) | allow | **allow** |
| `PutObject` (content) | deny | **deny-access** (403; object never created) |
| `DeleteObject` / `DeleteObjectVersion` | deny | **deny-access** (403) |
| `BypassGovernanceRetention` | deny | **deny-access** (403) |
| **unrelated bucket** `PutObject` / `GetObject` | deny | **deny-access** (403; resource scope) |

### governance bypass (COMPLIANCE physics)
| Identity | Action | Expected | Actual (store) |
|---|---|---|---|
| root | `removeObject(versionId, governanceBypass:true)` on a COMPLIANCE-locked version | blocked | **reject-worm** (`InvalidRequest`; object still present) |

## 4. Positive controls

writer can `PutObject` only; reader can `GetObject` + read retention/legal-hold +
`ListBucket`; retention-admin can extend retention, place/lift legal hold, and perform
the **required bucket bootstrap within the evidence bucket only** (`PutBucketVersioning`,
`PutBucketObjectLockConfiguration` on `edam-evidence`). All succeeded.

## 5. Governance bypass

A `governanceBypass` version-delete of a COMPLIANCE-locked version is **rejected by the
store even for root** — COMPLIANCE retention is non-bypassable (governance bypass only
applies to GOVERNANCE mode, which EDAM never uses; `RetentionMode = 'compliance'`). The
three roles additionally **explicitly Deny** `s3:BypassGovernanceRetention` (defense in
depth). The object remained present after the attempt.

## 6. Policy-audit integration

Expectations are driven by the accepted POLICY-AUDIT matrix. The live store matched the
audited model on **every** cell; **no mismatch** was discovered, therefore **no policy
file was modified** (per the task rule to stop-and-report on a real mismatch rather than
silently change a policy).

## 7. Verification

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 |
| full test (no MinIO) | green (H5 suite skips without the env gate) |
| determinism rig | exit 0 |
| compose-validate | OK |
| **live H5 integration suite** | **6 tests passed; 33/33 enforcement cells PASS** |

## 8. Acceptance

- Every denied operation is denied by **store-level** enforcement (raw clients, no
  adapter guards) — IAM 403 for permission cells, WORM rejection for the COMPLIANCE
  bypass cell. ✅
- Every allowed operation succeeds. ✅
- Governance bypass fails at the store. ✅
- The H5 report shows all required cells passing (33/33). ✅
- Contracts unchanged; product code unchanged (test + evidence + report only). ✅

## 9. Artifacts

- `infra/worm/test/h5-store-enforcement.integration.test.ts` — the gated live suite.
- `docs/evidence/h5/h5-enforcement-report.json` — machine-readable enforcement report.
- `docs/EDAM-T104-H5-Store-Enforcement.md` — this report.
