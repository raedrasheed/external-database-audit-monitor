# EDAM Sprint-2 Evidence Security Sign-Off

### Epic E2F — Evidence Security Sign-Off (EDAM-T164) · extends [`EDAM-Sprint1-Security-Signoff.md`](./EDAM-Sprint1-Security-Signoff.md)

This document is the formal Sprint-2 evidence-tier security sign-off. It verifies
that the Sprint-1 invariants (INV-1…INV-4) remain preserved, that the evidence
invariants (INV-EV-1…INV-EV-7) are enforced, that scope discipline held, and that
all gates are green — and renders a **SCOPED GO**. It is a documentation +
verification + security-review deliverable; it implements no product code and
resolves no findings.

---

## 1. Executive Summary & Recommendation

> ## ✅ **SCOPED GO**
>
> **The Sprint-2 evidence tier is approved for evidence-generation, sealing,
> signing, anchoring, export verification, offline verification, tamper
> detection, determinism, and no-fabrication validation.**
>
> **This approval does not constitute production security approval. Store-level
> WORM enforcement remains deferred to H1/H2/H3/H4/H5.**

The Sprint-2 evidence foundation is functionally complete and architecturally
sound: all fourteen WV conformance cases pass, the live evidence path and the
offline verifier + nine tamper drills were validated (T161–T163), every invariant
is enforced at the contract/CI level (and several live/in-process), and all
fourteen CI/conformance gates are green. **One control class is explicitly
deferred:** store-level WORM enforcement under a compromised writer (INV-EV-1
live), which is gated on the open production-hardening items **H1/H2/H3/H4/H5**
(§8) and the open finding **T161-M2** (§9). This sign-off therefore **does not**
claim production WORM guarantees, production security approval, or production
go-live — consistent with the §13.3 gating statement and the Sprint-1 sign-off's
scoped GO.

## 2. Scope & Boundary

**In scope (signed off):** evidence generation (CCE → WORM), segment sealing +
deterministic manifest/segment hashing, head signing, external anchoring
(anchored-only-after-verified-token; no fabrication), evidence-export-package
assembly, offline public-inputs-only verification, located tamper detection, and
WORM durability + append-only overwrite-rejection + live legal-hold-deny.

**Explicitly out of scope (deferred — see §8):** store-level WORM enforcement of
read-path integrity under a compromised writer (per-role MinIO credentials,
version-scoped 403 deletes, lock-config assertion, mandatory retention,
store-level enforcement tests — H1/H2/H3/H4/H5); the production HSM and the
external TSA/transparency-log; production go-live. The dashboard, risk engine,
business-projection DB, and reversal **system** remain out of Sprint-2 scope
entirely (§6).

## 3. Verification Evidence (gates) — re-run at sign-off time

| Gate / job | Invariant / property | Result |
|---|---|---|
| `build-test` (typecheck + full suite) | compile + behavior | ✅ typecheck EXIT 0; **678 passed / 9 skipped** |
| `lint` (`--max-warnings 0`) | hygiene | ✅ EXIT 0 |
| `coverage` (≥90/80/90/90) | test depth | ✅ thresholds met |
| `conformance` (CCE suite incl. Rev-4) | CCE semantics | ✅ |
| `determinism-rig` (+ `determinism-compare` in CI) | INV-4 / A-EV3 / WV-1 | ✅ EXIT 0 |
| `no-write-proof` | **INV-1** (no monitored-DB write) | ✅ |
| `evidence-schemas-verbatim` | evidence schemas unchanged | ✅ |
| `worm-no-mutate-proof` | **INV-EV-1 / INV-3** (writer holds no mutate path — contract level) | ✅ |
| `verifier-isolation-proof` | **INV-EV-5** (verifier isolation) | ✅ |
| `evidence-conformance` (WV-1…WV-14) | WV-1…WV-14 | ✅ 14/14 |
| `secret-hygiene` | **INV-3/INV-4 (masking/secret)** | ✅ |
| `signing-key-hygiene` | **INV-EV-4** (non-exportable keys) | ✅ |
| `anchor-no-fabrication` | **INV-EV-6 / WV-13** (no fabrication) | ✅ |
| `compose-validate` | M-Live stack completeness | ✅ |
| `invariants` (honesty suite) | **INV-2** (no fabrication / honesty) | ✅ |

**T162 reproducibility re-run (sign-off time):** the actual `verifier-cli`
binary on the committed base package (`docs/evidence/t162/`) → **exit 0, OVERALL
PASS** — the valid offline verification is independently reproducible.

## 4. Invariant Verification

Enforcement is classified as **CI/contract** (statically/CI-proven), **live**
(proven against live MinIO), **in-process** (proven against the real
implementations in-process), or **deferred** (production-hardening).

### 4.1 Sprint-1 invariants (INV-1…INV-4) — preserved

| Inv | Property | Enforcement | Evidence |
|---|---|---|---|
| **INV-1** | No monitored-DB write path | **CI** | `no-write-proof` green; Sprint-2 added no monitored-DB writer (collector creds unchanged, read-only) |
| **INV-2** | No fabrication / honesty | **CI + live** | `invariants` gate green; T162 TSA-outage drill (no token, builder refused) |
| **INV-3** | Append-only / WORM | **CI/contract enforced; store-level deferred** | `worm-no-mutate-proof` green (writer interface exposes only `putImmutable`); **store-level enforcement deferred to H1/H2/H3/H5** (§8) |
| **INV-4** | Single canonical implementation | **CI** | `@edam/canonical` reused verbatim (no second hasher); `determinism-rig` green; no change to canonical hashing/serialization |

### 4.2 Evidence invariants (INV-EV-1…INV-EV-7) — enforced

| Inv | Property (spec §19) | Enforcement | Evidence |
|---|---|---|---|
| **INV-EV-1** | Domain B holds an append-only WORM writer only — no delete/overwrite/retention-shorten/legal-hold-lift/key-read path (§19.2) | **CI/contract = ENFORCED; store-level (live) = DEFERRED** | `worm-no-mutate-proof` green (static, contract level). **Store-level NOT fully enforced** on the current MinIO adapter (single credential; app-level delete guard; no lock-config assertion; optional retention) — gated on **H1/H2/H3/H4/H5** + finding **T161-M2** (§8/§9). |
| **INV-EV-2** | Sign/anchor only hash structures; no CCE/audit plaintext to HSM/TSA (§19.4) | **CI + in-process** | T121/T122 exact-key-set anchor-payload (no extra-field smuggling); `anchorRequestFor` reduces to a hash; `anchor-no-fabrication` green |
| **INV-EV-3** | ANCHORED only after a verified external token (§19.5) | **in-process + live drill** | `requestAnchor` returns `anchored` only on a verified token; T162 tamper-token drill → `anchor_token` FAIL; TSA-outage → never ANCHORED |
| **INV-EV-4** | Signing keys non-exportable; Signer exposes no private material (§19.x) | **CI** | `signing-key-hygiene` green; dev key generated at runtime, never committed/logged |
| **INV-EV-5** | Verifier needs only public inputs (§19.7) | **CI + live/offline** | `verifier-isolation-proof` green (T147); T162 offline `verifier-cli` PASS using only package + sidecar + out-of-band trust |
| **INV-EV-6** | No fabrication on failure (§19.12) | **CI + live/in-process** | `anchor-no-fabrication` green; T162 TSA-outage drill: pending / no token / `buildAnchorRecord` refuses |
| **INV-EV-7** | `VERIFICATION_FAILED` is terminal / software-irreversible (§19.8) | **CI + in-process** | verifier fail-closed `#computeOverall` (a required check FAIL/SKIPPED ⇒ overall FAIL; no INDETERMINATE; no software path to PASS); T162: every tamper drill yields a fail-closed FAIL/exit 1-or-2, none recover to PASS |

## 5. Conformance Outcomes (WV-1…WV-14, A-EV1…A-EV11)

The detailed coverage matrices are in
[`EDAM-Evidence-Live-Validation-Report.md`](./EDAM-Evidence-Live-Validation-Report.md)
(T163) §4–§5 and are incorporated here by reference.

- **WV-1…WV-14:** all 14 proven **in-process** (T148 `evidence-conformance` gate);
  WV-1/WV-11 also **live** (T161); WV-2/WV-4/WV-5/WV-6/WV-10/WV-12/WV-14 also via
  the **offline CLI** (T162); WV-8 **live MinIO** legal-hold-deny; WV-3 **live**
  exit-2 fail-closed; WV-9 **live** detection via `export_signature` (the §10
  `no_missing_segment` check itself is in-process); WV-7 and WV-13 **in-process**.
- **A-EV1…A-EV11:** A-EV1…A-EV3, A-EV6…A-EV10 **Met**; A-EV4/A-EV5 **Met
  In-Process** (in-process dev signer/anchor); **A-EV11 is this sign-off** (now
  rendered, SCOPED). A-EV1's store-level enforcement carries the same deferral as
  INV-EV-1.

## 6. Repository Scope-Discipline Review (documented scan)

A repository scan was performed at sign-off time (`packages/`, `services/`,
`apps/`, `infra/`, `tools/`, `conformance/`):

| Forbidden subsystem | Result |
|---|---|
| **Dashboard** | ✅ none introduced — no dashboard package/service/app |
| **Risk engine** | ✅ none introduced — no risk-engine code |
| **Reversal system** | ✅ none introduced — only the frozen `reversal-directive-1.0` **data contract** is vendored (propose-only; EDAM records/proposes reversal directives, it never executes reversals). No reversal engine/executor. |
| **Business-projection DB** | ✅ none introduced |
| **CCE semantics** | ✅ unchanged — the CCE schemas (`cce-1.0`, `cce-1.1`) were last modified at foundation (pre-Sprint-2, CCE-AMD-001 Rev 4); the `conformance` CCE suite is green; no Sprint-2 evidence task changed CCE semantics |
| **Evidence schemas** | ✅ unchanged — `evidence-schemas-verbatim` gate green (`evidence-segment-manifest-1.0`, `anchor-record-1.0`, `verification-report-1.0`, `evidence-export-package-1.0` match the spec verbatim) |

Code surface added in Sprint-2 is strictly the evidence tier:
`packages/{anchor-proof, evidence, export, verifier}`,
`services/{anchoring, evidence-writer}` deltas, `apps/verifier-cli`, and the
`conformance/{wv,security,scripts}` gates — no dashboard/risk-engine/reversal/
business-projection.

## 7. Enforcement Classification (explicit)

| Class | What it covers here |
|---|---|
| **Contract / CI enforcement** | INV-1, INV-2, INV-3 (contract), INV-4, INV-EV-1 (contract), INV-EV-2, INV-EV-4, INV-EV-5, INV-EV-6, INV-EV-7; all 14 gates; WV-1…14 in-process; determinism |
| **Live validation** | T161 live evidence path (write/read/overwrite-reject); T162 live legal-hold-deny (WV-8); WV-1/WV-11 live |
| **In-process validation** | dev signer + dev anchor providers (real `@edam/signing`/`@edam/anchoring` libraries, **NOT external live services**); the WV suite; the TSA-outage drill |
| **Deferred controls** | **Store-level INV-EV-1 / INV-3 (live)** — H1/H2/H3/H4/H5 (§8) |

> **Explicit statement.** Signing and anchoring in the live/in-process validations
> were performed by **in-process development providers**
> (`DevEd25519Signer` / `DevRfc3161Provider` / `FakeAnchorProvider`). They are
> **not external live services** — there was no live HSM and no live external
> TSA/transparency-log.

## 8. Deferred Production-Hardening Controls

The following P0/P1 adapter-hardening controls (tracked as **EDAM-T104-H1…H5**,
backlog §13.1) are **OPEN** — the `MinioWormStore` is unchanged since T104. They
are **explicitly deferred** to a production-hardening phase and are **prerequisites
for any production WORM / store-level INV-EV-1 claim** (§13.3 gating). They are
**not** implemented or resolved by this sign-off.

| Item | Control | Risk if unaddressed | Status |
|---|---|---|---|
| **H1** | Distinct MinIO credentials per identity (writer credential physically incapable of delete/overwrite/retention/legal-hold-lift; proven via MinIO 403) | **R1** — a compromised Domain-B process could hide/supersede evidence at the read path | **OPEN** (P0) |
| **H2** | Version-scoped delete enforcement (operate on versionIds so COMPLIANCE blocks the delete; no delete-marker hide path) | **R1** | **OPEN** (P0) |
| **H3** | Bucket Object-Lock verification at `ensureBucket`/startup (refuse to operate on a non-lock bucket) | **R2** — non-lock bucket → silently mutable evidence | **OPEN** (P0) |
| **H4** | Mandatory/default COMPLIANCE retention (no object writable unlocked) | **R2** | **OPEN** (P1) |
| **H5** | Store-level enforcement tests bypassing the adapter pre-check (assert MinIO 403 on version-scoped delete of a locked object, earlier-date retention, delete under legal hold) | **R3** — false confidence that green adapter tests imply store enforcement | **OPEN** (P0) |

Until H1/H2/H3/H5 are closed (H4 by the same phase), **store-level WORM
read-path-integrity-under-a-compromised-writer enforcement is NOT asserted**.
Evidence **durability** holds (locked versions persist and are recoverable); the
append-only overwrite-rejection observed live is the adapter's application-level
existence guard, not S3 Object Lock enforcement.

## 9. Residual Risks & Accepted Findings

All accepted findings (backlog §13.2a–§13.2ab) are Low/Medium and tracked. None
are Critical/High. The store-level finding is the only one tied to the deferral.

- **T161-M2 (Medium, OPEN):** the live MinIO objects were not S3-Object-Lock-
  retained; overwrite-rejection is the adapter's app-level existence guard, not
  S3 Object Lock. **Tied to H1/H2/H3/H4/H5; blocks a full store-level INV-EV-1 GO;
  does not block this SCOPED GO.**
- **Informational (non-blocking):** T148-L1…L4 (WV-suite spec-wording/test-gap
  nuances), T160-L1…L6 (dev-compose port/lock/structure/pinning notes),
  T161-M1 (`anchor_ref` lives in the post-anchor projection view, not the
  immutable WORM object — architecturally correct), T161-L1/L2 (self-attested
  flags; streaming-only CCEs), T162-L1…L3 (per-drill package reproducibility;
  in-process vs binary test; operational counters).

**Accepted (scoped) vs Rejected (enforced as failing gates):** all honesty,
isolation, no-fabrication, no-monitored-DB-write, deterministic-hash, and
verifier-public-inputs properties are **enforced as failing gates** (rejected as
risks). The single **accepted-and-deferred** risk is store-level WORM enforcement
(H-items), accepted **only** under the SCOPED, non-production boundary of this
sign-off.

## 10. Production Non-Claims (explicit)

This sign-off explicitly states:
- **Store-level INV-EV-1 is NOT fully enforced** (contract/CI enforced; live store-level deferred).
- **T161-M2 remains OPEN.**
- **Production WORM guarantees are NOT claimed.**
- **Production security approval is NOT granted.**
- **Production go-live is NOT approved.**

Final production security approval remains gated by closing **H1/H2/H3/H4/H5**
(and the production HSM + external anchoring authority), in a subsequent
production-hardening phase.

## 11. Final Decision

> ## ✅ **SCOPED GO**
>
> **The Sprint-2 evidence tier is approved for evidence-generation, sealing,
> signing, anchoring, export verification, offline verification, tamper
> detection, determinism, and no-fabrication validation.**
>
> **This approval does not constitute production security approval.**
>
> **Store-level WORM enforcement remains deferred to H1/H2/H3/H4/H5.**

## 12. Final Determination

- **Is Sprint 2 feature complete?** **Yes.** All Sprint-2 feature tasks (E2A–E2F,
  T101–T163) are committed; all 14 gates and WV-1…WV-14 are green.
- **Is Sprint 2 evidence validation complete?** **Yes.** The live evidence path
  (T161), the offline verifier + nine tamper drills (T162), and the live-stack
  validation report (T163) are complete and accepted; the offline PASS is
  independently reproducible.
- **Is Sprint 2 production ready?** **No.** Store-level WORM enforcement
  (H1/H2/H3/H4/H5), the production HSM, and the external anchoring authority are
  not in place; production security approval and go-live are **not** granted.
- **What remains open?** The production-hardening controls **H1/H2/H3/H4/H5**
  (and finding **T161-M2**), plus the production HSM + external TSA/transparency-
  log. These are tracked as `EDAM-T104-H1…H5` and are prerequisites for a future
  production security approval.

---

*This sign-off is documentation + verification only. It implements no product
code, modifies no schemas or evidence artifacts, and resolves no findings. It is
the Sprint-2 evidence-tier SCOPED GO; it is not the production security sign-off.*
