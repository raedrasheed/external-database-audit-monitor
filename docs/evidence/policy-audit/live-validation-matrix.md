# EDAM-S3-POLICY-AUDIT — Live store-enforced validation (raw clients)

Validation of the three least-privilege identities against a **real MinIO** instance
using **raw clients only** (the `mc` CLI per-role aliases + the `minio` SDK in the
gated integration suite) — **no adapter shortcuts**. Each denial is enforced by the
**store** (IAM policy evaluation), not by application code.

- Date: 2026-06-04
- Store: MinIO (Object Lock COMPLIANCE + versioning), bucket `edam-evidence`, default retention 365d
- Identities: `edam-writer`, `edam-reader`, `edam-retention-admin` (provisioned from the committed policies)

## Result matrix (raw `mc`, keyed on actual store response)

| Identity | Operation | Expected | Observed (store) |
|---|---|---|---|
| writer | PutObject | allow | **allow** (object created, born locked by bucket default) |
| writer | GetObject (read-back) | allow | **allow** |
| writer | DeleteObject | deny | **deny** (`Access Denied`) |
| writer | PutObjectRetention | deny | **deny** (writer lacks lock-config read + explicit Deny → "does not support locking"; SDK `putObjectRetention` rejects) |
| writer | PutObjectLegalHold | deny | **deny** (`Access Denied`) |
| writer | PutBucketVersioning | deny | **deny** |
| reader | GetObject | allow | **allow** |
| reader | ListBucket | allow | **allow** |
| reader | PutObject | deny | **deny** (`Insufficient permissions`; object never created — confirmed by authoritative listing) |
| reader | DeleteObject | deny | **deny** |
| reader | PutObjectRetention | deny | **deny** |
| reader | PutObjectLegalHold | deny | **deny** (`Access Denied`; legal-hold state remained `Not set`) |
| retention-admin | PutObjectRetention (extend) | allow | **allow** (`retention successfully set`) |
| retention-admin | PutObjectLegalHold (set/clear) | allow | **allow** |
| retention-admin | GetObject | allow | **allow** |
| retention-admin | PutObject (content) | deny | **deny** (`Insufficient permissions`; object never created — confirmed by listing) |
| retention-admin | DeleteObject / version-delete | deny | **deny** |
| any | BypassGovernanceRetention | deny | **deny** (explicit policy Deny on all three roles AND COMPLIANCE mode is non-bypassable at the store — a version-scoped delete of a still-locked version is rejected even for root) |

## Notes on `mc` CLI signal reliability

The authoritative signal for each cell is the **store response** (error text) and the
**actual object/lock state**, NOT the `mc` process exit code. Observed `mc` quirks
(verified, none indicate a policy gap):

- `mc legalhold set` / `mc retention set` print an error but exit `0`. Denial was
  confirmed via the printed `Access Denied` and by reading back the unchanged state.
- `mc cp` denial surfaces as `Insufficient permissions to access this path` (not the
  literal "Access Denied"). Denial was confirmed by the authoritative listing showing
  the target object was **never created**.
- A writer `retention set` surfaces as `does not support locking` (the writer also
  lacks `GetBucketObjectLockConfiguration`); the underlying `PutObjectRetention` is
  independently proven to reject via the `minio` SDK in the gated integration suite.

## SDK cross-check (gated integration suite, `minio` client, proper assertions)

`infra/worm/test/minio.integration.test.ts` (28 passed, live) independently asserts
the same matrix with `expect(...).rejects` on raw SDK calls, including:

- writer raw `putObjectRetention` / `setObjectLegalHold` / `removeObject` → reject (store 403);
- reader raw `putObject` / `removeObject` → reject;
- retention-admin raw `putObject` / version `removeObject` → reject;
- "B2: the adapter writer path issues ONLY putObject — never the denied APIs".

## Committed ↔ live drift

`mc admin policy info` exports (see `live-export-edam-*.json`) are **semantically
identical** to the committed `deploy/compose/minio/policies/*.json` (only MinIO's
cosmetic envelope + alphabetized action ordering differ). No drift.
