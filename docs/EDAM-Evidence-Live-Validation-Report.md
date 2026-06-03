# EDAM Evidence Live Validation Report

### Epic E2F — Live-stack Validation (Sprint-2 evidence tier) · EDAM-T163

This report synthesises the Sprint-2 evidence-tier live validation: the live
evidence path (T161), the offline verifier run + tamper drills (T162), the
in-process WV conformance suite (T148), and the CI/conformance gates. It covers
**A-EV1…A-EV11** and **WV-1…WV-14** and renders a **SCOPED GO**. It uses only
evidence already committed in the repository and cites exact files.

---

## 1. Executive Summary

The Sprint-2 evidence tier was live-validated end-to-end: real CCEs were written
to **live MinIO WORM**, sealed into segments, signed, and anchored (T161); a real
evidence-export package was verified **offline through the actual `verifier-cli`
binary** with an independently-reproducible PASS, and **nine tamper drills** each
**failed-as-expected** (T162); all **fourteen WV conformance cases** pass
in-process against the real implementations (T148); and **all CI/conformance
gates are green**.

**Final decision: SCOPED GO.** The Sprint-2 evidence tier is validated for
evidence generation, sealing, signing, anchoring, export verification, offline
verification, tamper detection, and no-fabrication properties. **This validation
does not constitute production security sign-off. Final security approval remains
gated by T164 and the outstanding H1/H2/H3/H5 controls.**

## 2. Validation Scope

**In scope (validated):** evidence generation (CCE → WORM), segment sealing +
manifest/segment hashing, head signing, external anchoring (anchored-only-after-
verified-token + no fabrication), evidence-export-package assembly, offline
independent verification (public-inputs-only), located tamper detection, WORM
durability + append-only overwrite-rejection + live legal-hold-deny.

**Out of scope (NOT validated here; deferred):** store-level WORM enforcement of
read-path integrity under a compromised writer (object-level S3 Object Lock
retention — see T161-M2 and §12); the formal security sign-off and INV-EV-1…7
enforcement (T164); the outstanding adapter-hardening controls **H1/H2/H3/H5**;
production go-live. The dashboard, risk engine, business projection DB, and
reversal remain out of Sprint-2 scope entirely.

## 3. Environment and Methodology

| Layer | What ran | Classification |
|---|---|---|
| WORM store | MinIO with S3 Object Lock bucket `edam-evidence` at `127.0.0.1:9000`; `ensureBucket` / `putImmutable` / `get` / legal-hold-deny | **LIVE** |
| Image | cached `quay.io/minio/minio:latest` retagged `minio/minio:latest` (Docker Hub unauthenticated pull rate-limit) | LIVE (same MinIO binary) |
| Verifier | the actual `verifier-cli` binary — `npx tsx apps/verifier-cli/src/main.ts verify --export … --objects … --trust … --json` (real exit codes 0/1/2) | **OFFLINE** (no services contacted) |
| Signer | `@edam/signing` `DevEd25519Signer` | **IN-PROCESS dev provider — NOT an external live service** |
| Anchor provider | `@edam/anchoring` `DevRfc3161Provider` / `FakeAnchorProvider` | **IN-PROCESS dev provider — NOT an external live service** |
| WV suite | `conformance/wv/` (14 cases) via the `evidence-conformance` gate | IN-PROCESS, real implementations |

**Methodology (D4):** all CI/conformance gates and the T162 reproducibility check
were **re-run at report time** (results in §9/§10). The live evidence runs were
**not** re-executed — committed T161/T162 evidence is reused. The temporary T161
and T162 harnesses were **never committed** (only result records + reproducibility
artifacts). The live stack was torn down at close-out (§12, `docker compose down -v`).

> **Explicit statement.** Signing and anchoring were performed by **in-process
> development providers** (`DevEd25519Signer` / `DevRfc3161Provider` /
> `FakeAnchorProvider`). They are **not external live services**; there was no
> live HSM and no live external TSA/transparency-log in this validation.

## 4. A-EV1…A-EV11 Coverage Matrix

| AC | Property | Status | Evidence |
|---|---|---|---|
| **A-EV1** | Immutable ordered append + back-refs | **Met** (live durability + app-level append-only; store-level enforcement deferred — T161-M2) | `docs/evidence/T161-live-run-result.json` (3 objects written + read back; `worm_object_key`/`segment_id` populated live; overwrite rejected) |
| **A-EV2** | Segments / genesis / contiguity | **Met** | T161 2 segments (genesis seq 0 + successor seq 1); WV-11 live; T148 WV-9/WV-11 |
| **A-EV3** | Deterministic manifest/segment hash | **Met** | T161 `wv1_deterministic_manifest_hash: true`; T148 WV-1; `determinism-rig` gate (§10) |
| **A-EV4** | Signing; HSM-ready | **Met In-Process** | in-process `DevEd25519Signer` (not external HSM); valid run `hsm_signature` PASS; T162 forge-signature drill → located FAIL (`docs/evidence/t162/drills/d4-forge-sig.json`) |
| **A-EV5** | Anchored only after a verified token | **Met In-Process** | in-process `DevRfc3161Provider` + `requestAnchor`; valid run `anchor_token` PASS; tamper-token drill → FAIL (`d5-tamper-token.json`) |
| **A-EV6** | No fabrication on failure | **Met** | T162 TSA-outage drill: pending/no-token/builder-refused (`d9-tsa-outage.json`); `anchor-no-fabrication` gate green |
| **A-EV7** | Verifier offline, public-inputs only | **Met** | T162 offline `verifier-cli` PASS, **independently reproducible** (`base-export-package.json` + `objects/` + `trust.json` → exit 0); `verifier-isolation-proof` gate green |
| **A-EV8** | Tamper located | **Met** | T162 located drills: byte-flip/break-link/forge-sig/tamper-token/offset-gap (offending ids), withhold (exit 2 named key), segment-gap (`export_signature`) — `docs/evidence/t162/T162-drill-result-summary.json` |
| **A-EV9** | Export self-verifies | **Met** | T162 valid export self-verifies offline (reproducible PASS); `docs/evidence/t162/valid-report.json` |
| **A-EV10** | All gates green | **Met** | 14 CI/conformance gates re-run green at report time (§9) |
| **A-EV11** | Invariants; scope discipline | **Deferred to T164** | `invariants` gate green now, but the formal INV-1…4 + INV-EV-1…7 sign-off and scope-discipline confirmation are **T164** |

## 5. WV-1…WV-14 Coverage Matrix

| WV | Property | In-Process Validation (T148) | Live / Offline CLI Validation (T161 / T162) | Final Status |
|---|---|---|---|---|
| **WV-1** | Deterministic manifest hashing | ✅ T148 | ✅ T161 live (`wv1=true`) | **Met** |
| **WV-2** | Tampered CCE | ✅ T148 | ✅ T162 byte-flip via CLI (exit 1, located) | **Met** |
| **WV-3** | Missing object | ✅ T148 | ✅ T162 withhold via CLI (**exit 2**, fail-closed, missing key named) | **Met** (live fail-closed) |
| **WV-4** | Broken chain | ✅ T148 | ✅ T162 break-link via CLI (exit 1, located) | **Met** |
| **WV-5** | Invalid HSM signature | ✅ T148 | ✅ T162 forge-sig via CLI (exit 1, located) | **Met** |
| **WV-6** | Invalid timestamp token | ✅ T148 | ✅ T162 tamper-token via CLI (exit 1, located) | **Met** |
| **WV-7** | Projection drift (advisory) | ✅ T148 | — (not exercised as a live drill) | **Met In-Process** |
| **WV-8** | Legal hold enforcement | ✅ T148 (in-memory) | ✅ T162 legal-hold-delete on **live MinIO** (denied, W-3) | **Met** (live deny) |
| **WV-9** | No missing segment | ✅ T148 (explicit scope) | ⚠️ T162 segment-gap detected via **`export_signature`** (CLI derives scope from present manifests; `no_missing_segment` itself is in-process) | **Met** (live detection; §10 check in-process) |
| **WV-10** | No missing event (offset) | ✅ T148 | ✅ T162 offset-gap via CLI (exit 1, located) | **Met** |
| **WV-11** | Genesis correctness | ✅ T148 | ✅ T161 live (`wv11=true`) | **Met** |
| **WV-12** | Independent verifier isolation | ✅ T148 | ✅ T162 offline CLI + `verifier-isolation-proof` gate | **Met** |
| **WV-13** | Anchor outage behaviour | ✅ T148 | ✅ T162 TSA-outage **in-process** (no live external TSA) | **Met In-Process** |
| **WV-14** | Export self-verification | ✅ T148 | ✅ T162 offline CLI PASS (reproducible) | **Met** |

## 6. T161 Live Evidence Results

Source: [`docs/evidence/T161-live-run-result.json`](./evidence/T161-live-run-result.json) · [`.md`](./evidence/T161-live-run-result.md). Accepted review: backlog §13.2aa.

- **Live (MinIO WORM):** **3** CCEs written across **2** segments (`seg-mpyikifx-000000`, `seg-mpyikifx-000001`); **3/3** read back; overwrite rejected (append-only).
- `evidence.worm_object_key` (e.g. `kafel-dev-mysql/seg-mpyikifx-000000/000000.cce.json`) and `evidence.segment_id` populated **in the live WORM object** and read back.
- `evidence.anchor_ref` populated on the **post-anchor projection view** (derived from live anchoring) — **not** in the immutable WORM object (T161-M1; architecturally correct).
- No fabricated anchor tokens; WV-1 and WV-11 confirmed live.
- **In-process:** signer + anchor provider (dev, not external services).
- Open finding **T161-M2:** the live objects were not S3-Object-Lock-retained by default; the overwrite-rejection is the adapter's application-level existence guard, not S3 Object Lock enforcement (see §11/§12).

## 7. T162 Offline Verification Results

Source: [`docs/evidence/t162/`](./evidence/t162/) (base-export-package.json, objects/, trust.json, valid-report.json, drills/, T162-drill-result-summary.json). Accepted review: backlog §13.2ab.

- **Offline `verifier-cli` binary** on the committed package → **exit 0**, `overall_result = PASS`, `export_signature = PASS`; all eight §10 checks PASS, `projection_consistency` SKIPPED.
- **Reproducible:** re-running the actual CLI on the committed `base-export-package.json` + `objects/` + `trust.json` reproduces exit 0 / PASS (re-confirmed at report time; the conformance test `conformance/test/t162-offline-verify.test.ts` asserts the same under `npm test`).
- Live MinIO writes/reads for the source chain: **3 / 3**.
- **In-process:** signer + anchor providers (dev, not external services).

## 8. Tamper Drill Results

Source: [`docs/evidence/t162/T162-drill-result-summary.json`](./evidence/t162/T162-drill-result-summary.json) + per-drill reports in `drills/`. `all_drills_fail_as_expected: true`.

| # | Drill | WV | Channel | Outcome | Fails as expected |
|---|---|---|---|---|---|
| 1 | byte-flip | WV-2 | verifier-cli (offline) | `per_object_hash` FAIL + located id, exit 1 | ✅ |
| 2 | withhold-object | WV-3 | verifier-cli (offline) | hydration error naming the missing key, **exit 2** (fail-closed; not a §10 FAIL) | ✅ |
| 3 | break-link | WV-4 | verifier-cli (offline) | `object_chain` FAIL + located id, exit 1 | ✅ |
| 4 | forge-signature | WV-5 | verifier-cli (offline) | `hsm_signature` FAIL + located id, exit 1 | ✅ |
| 5 | tamper-token | WV-6 | verifier-cli (offline) | `anchor_token` FAIL + located id, exit 1 | ✅ |
| 6 | segment-gap | WV-9 | verifier-cli (offline) | dropped manifest caught by `export_signature` recompute, exit 1 (`no_missing_segment` stays PASS over the reduced scope) | ✅ |
| 7 | offset-gap | WV-10 | verifier-cli (offline) | `no_missing_event` FAIL + located segment, exit 1 | ✅ |
| 8 | legal-hold-delete | WV-8 | **live MinIO/WORM** (non-CLI) | deletion denied — "under legal hold; deletion denied (W-3)" | ✅ |
| 9 | TSA-outage | WV-13 | **in-process** anchoring (non-CLI) | `pending(provider_outage)`, no token, `buildAnchorRecord` refuses — no fabrication | ✅ |

## 9. Gate Results

Re-run at report time (D4) — all green:

| Gate / job | Result |
|---|---|
| `build-test` (typecheck + full suite) | ✅ typecheck EXIT 0; **678 passed / 9 skipped** |
| `lint` | ✅ EXIT 0 |
| `coverage` | ✅ thresholds met (90/80/90/90) |
| `conformance` (CCE suite) | ✅ |
| `no-write-proof` | ✅ |
| `evidence-schemas-verbatim` | ✅ |
| `worm-no-mutate-proof` | ✅ |
| `verifier-isolation-proof` | ✅ |
| `evidence-conformance` (WV-1…WV-14) | ✅ 14/14 |
| `secret-hygiene` | ✅ |
| `signing-key-hygiene` | ✅ |
| `anchor-no-fabrication` | ✅ |
| `compose-validate` | ✅ |
| `invariants` | ✅ |

## 10. Determinism Results

- `determinism-rig` re-run at report time: **EXIT 0** (cross-target reproducible manifest/segment/anchor hashing — WV-1 / A-EV3).
- The cross-target `determinism-compare` (two-OS) job is enforced in CI (Ubuntu + macOS).

## 11. Residual Risks and Accepted Findings

All findings below are **accepted and tracked** (backlog §13.2v–§13.2ab); none are Critical/High. None block T164.

**T148 (WV conformance):**
- **T148-L1** — WV-2 conformance asserts the implementation's localization (`per_object_hash` only); spec wording says both `per_object_hash` + `object_chain`. Security-equivalent (orthogonal, jointly exhaustive). Track for spec/verifier reconciliation.
- **T148-L2** — WV-3 located at segment granularity; the withheld key is in the harness detail, not `offending_ids`.
- **T148-L3** — negatives assert the targeted check only, not that other checks stay PASS.
- **T148-L4** — minor test robustness (inline mock trust dir; rfc3161 cast; substring matching; `void main()`).

**T160 (dev compose):**
- **T160-L1** — dev-signer/dev-tsa-log port-override foot-gun (healthcheck/container port hardcoded).
- **T160-L2** — `minio-init` does not enable/verify Object Lock on a pre-existing bucket.
- **T160-L3** — `compose-validate` is structural-only, not in-suite.
- **T160-L4** — unpinned `:latest` image tags.

**T161 (live evidence):**
- **T161-M1** — `anchor_ref` is not in the immutable WORM object; it exists only on the post-anchor projection view (architecturally correct; record wording overstated "all back-refs populated"). Non-blocking.
- **T161-M2** — **OPEN:** the live objects were not S3-Object-Lock-retained; overwrite-rejection is the adapter's application-level existence guard, not S3 Object Lock enforcement. Full store-level WORM enforcement is **not** claimed (see §12). Aligns with the §13.3 gating (H1/H2/H3/H5).
- **T161-L1** — acceptance flags / WV-1 / WV-11 / no-fabrication self-attested in the T161 record (corroborated by the committed T148 suite).
- **T161-L2** — "streaming + snapshot" not fully met (0 snapshot-phase CCEs; disclosed).

**T162 (offline verifier + drills):**
- **T162-L1** — drills 4/5/7 used fresh per-drill packages (ephemeral export key); isolated-form outcomes not reproducible from committed artifacts (detection is reproducible).
- **T162-L2** — the committed reproducibility test re-verifies via `runExportVerification` (CLI in-process core), not the binary subprocess (the binary path was independently verified in review).
- **T162-L3** — self-attested operational counters (live writes/reads, D8/D9) not reproducible from committed inputs; corroborated and disclosed.

## 12. Validation Boundaries

- **In-process vs external:** signing and anchoring were performed by **in-process development providers** (`DevEd25519Signer` / `DevRfc3161Provider` / `FakeAnchorProvider`). They are **not external live services** — there was no live HSM and no live external TSA/transparency-log.
- **Store-level WORM enforcement is NOT claimed (T161-M2 OPEN):** the live MinIO objects were not under S3 Object Lock retention by default; the append-only overwrite-rejection observed is the adapter's application-level existence guard. **Full store-level WORM read-path-integrity-under-a-compromised-writer enforcement is not asserted by this report.**
- **H1/H2/H3/H5 remain OPEN and are deferred to T164** (H4 also addressed by T164). Per the §13.3 gating statement, WORM enforcement / INV-EV-1 must not be asserted on the current MinIO adapter until these are closed. Evidence **durability** holds (locked versions persist + are recoverable); read-path integrity under a compromised writer is **not yet store-enforced**.
- **No production readiness, no final security approval, no full WORM enforcement** is claimed by this report. Production go-live and the formal security sign-off remain **T164** + the outstanding controls.

## 13. Go / No-Go Decision

> ## ✅ **SCOPED GO**
>
> **The Sprint-2 evidence tier is validated for evidence generation, sealing,
> signing, anchoring, export verification, offline verification, tamper
> detection, and no-fabrication properties. This validation does not constitute
> production security sign-off. Final security approval remains gated by T164 and
> the outstanding H1/H2/H3/H5 controls.**

This is **not** a production go-live and **not** the final security sign-off. It
is a scoped validation of the Sprint-2 evidence tier against the committed
evidence and gates, with store-level WORM enforcement (T161-M2) and the formal
invariant sign-off (A-EV11) explicitly deferred to **T164**.

## 14. References to Evidence Artifacts

- **T161 live evidence:** `docs/evidence/T161-live-run-result.json`, `docs/evidence/T161-live-run-result.md`
- **T162 offline verifier + drills:** `docs/evidence/t162/base-export-package.json`, `docs/evidence/t162/objects/`, `docs/evidence/t162/trust.json`, `docs/evidence/t162/valid-report.json`, `docs/evidence/t162/drills/d1-byte-flip.json` … `d9-tsa-outage.json`, `docs/evidence/t162/T162-drill-result-summary.json`, `docs/evidence/t162/T162-offline-verifier-and-tamper-drills.md`
- **Reproducibility test:** `conformance/test/t162-offline-verify.test.ts`
- **WV conformance suite (in-process):** `conformance/wv/cases.ts`, `conformance/scripts/evidence-conformance.ts`
- **Gates / CI:** `.github/workflows/ci.yml`, `conformance/scripts/*.ts`, `conformance/security/*.ts`
- **Findings ledger:** `docs/EDAM-Sprint2-Backlog.md` §13.2v–§13.2ab; gating statement §13.3
- **Live stack definition:** `deploy/compose/docker-compose.yml` (T160)

---

*Close-out: the live MinIO stack was torn down via `docker compose -f
deploy/compose/docker-compose.yml down -v` after evidence capture. Only this
report is committed for T163; the temporary T161/T162 harnesses were never
committed. Final security sign-off is EDAM-T164.*
