# EDAM Implementation Kickoff Package
### Everything the engineering team needs to start Sprint 1 on day one

> **Document class:** Team operating manual / kickoff (process artifact). It introduces **no** new architecture, specifications, or scope; it operationalizes the frozen plan for execution.
> **Frozen baseline (honored, unmodified):** v1 plan, architecture review, v2 architecture, CCE v1, companion contracts, WORM/anchoring spec, risk-rule spec, Engineering Blueprint, Sprint 1 plan, Sprint 1 backlog.
> **Scope:** Sprint 1 = Phase 1 (Ingestion + CCE Foundation). Tasks referenced as `EDAM-T###` from the backlog.
> **Status:** Process/planning only — no production code.
> **Date:** 2026-06-01.

---

## 0. Reference team (roles → people placeholders)

| Role | Code | Headcount (Sprint 1) | Placeholder |
|---|---|---|---|
| Backend Engineer (lead) | **BE1** | 1 | _assign_ |
| Backend Engineer | **BE2** | 1 | _assign_ |
| Data Engineer | **DE** | 1 | _assign_ |
| Security Engineer | **SEC** | 0.5–1 | _assign_ |
| QA Engineer | **QA** | 0.5–1 | _assign_ |
| DevOps/SRE | **DEVOPS** | 0.5–1 | _assign_ |
| Tech/Product Lead | **LEAD** | 0.5 | _assign_ |

Matches Engineering Blueprint §15 and Sprint 1 plan §15 sizing (~4–5 FTE).

---

## 1. Development Team Assignments

Every Sprint 1 backlog task mapped to a **primary owner (R)** and **support/reviewer (S)**. "Verifier" = who signs the acceptance/invariant check.

| Task | Title | Primary (R) | Support (S) | Verifier |
|---|---|---|---|---|
| EDAM-T001 | Canonical serialization rules | BE1 | BE2 | QA |
| EDAM-T002 | SHA-256 over canonical bytes | BE1 | BE2 | QA |
| EDAM-T003 | Deterministic UUIDv5 helper | BE1 | — | QA |
| EDAM-T004 | Hash-chain link helper | BE1 | BE2 | QA |
| EDAM-T005 | Exact-decimal / float-rejection | BE1 | DE | QA |
| EDAM-T006 | Vendor frozen JSON Schemas | BE2 | LEAD | QA |
| EDAM-T007 | Validator API | BE2 | BE1 | QA |
| EDAM-T008 | Stateful rule checks (V3/V4/V14/V15) | BE2 | BE1 | QA |
| EDAM-T009 | Invalid-fixture suite + version gate | QA | BE2 | QA |
| EDAM-T010 | Provision read-only CDC credential | DE | SEC | **SEC** |
| EDAM-T011 | Configure Debezium ROW+FULL+GTID | DE | BE2 | QA |
| EDAM-T012 | Offset/GTID tracking | BE2 | DE | QA |
| EDAM-T013 | Snapshot↔stream handoff | BE2 | DE | QA |
| EDAM-T014 | Emit CAPTURED records to bus | BE2 | — | QA |
| EDAM-T015 | Backoff/reconnect + lag alarm | DE | BE2 | QA |
| EDAM-T016 | MySQL vs MariaDB adapters | DE | BE2 | QA |
| EDAM-T017 | Config sampler | DE | SEC | QA |
| EDAM-T018 | Emit config_snapshot | DE | BE2 | QA |
| EDAM-T019 | Downgrade detection + CRITICAL alarm | BE2 | SEC | **SEC** |
| EDAM-T020 | Audit-plugin state watch | SEC | DE | QA |
| EDAM-T021 | Consumed-GTID tracking + gap compute | BE2 | DE | QA |
| EDAM-T022 | Heartbeat watermark | DE | BE2 | QA |
| EDAM-T023 | Gap → degraded + alarm | BE2 | DE | QA |
| EDAM-T024 | Snapshot-phase computation | DE | — | QA |
| EDAM-T025 | Native → CCE skeleton | BE1 | BE2 | QA |
| EDAM-T026 | Attach fidelity & completeness | BE1 | BE2 | **SEC** |
| EDAM-T027 | Operation mapping + nullity | BE1 | BE2 | QA |
| EDAM-T028 | Poison record → DLQ | BE2 | DE | QA |
| EDAM-T029 | Field-level diff engine | BE1 | BE2 | QA |
| EDAM-T030 | Sensitive-field masking | BE1 | SEC | **SEC** |
| EDAM-T031 | Transaction grouping + seq | BE1 | BE2 | QA |
| EDAM-T032 | Deterministic ordering | BE1 | BE2 | QA |
| EDAM-T033 | Deterministic envelope_id | BE1 | — | QA |
| EDAM-T034 | Attribution correlation | BE2 | SEC | QA |
| EDAM-T035 | Compute event_hash | BE1 | BE2 | QA |
| EDAM-T036 | Validate + idempotency + dup detection | BE1 | BE2 | QA |
| EDAM-T037 | DLQ store schema | DE | BE2 | QA |
| EDAM-T038 | Quarantine API + alarm | BE2 | DE | QA |
| EDAM-T039 | DLQ inspection/replay tooling | DE | BE2 | QA |
| EDAM-T040 | DLQ depth metric + alert | DEVOPS | DE | QA |
| EDAM-T041 | Two-target determinism rig | QA | DEVOPS | **QA** |
| EDAM-T042 | Conformance C-3 | QA | BE1 | QA |
| EDAM-T043 | Conformance C-4 & C-5 | QA | BE1 | QA |
| EDAM-T044 | Conformance C-6 | QA | BE1 | QA |
| EDAM-T045 | Conformance C-7 & C-8 | QA | BE2 | QA |
| EDAM-T046 | Conformance C-10 | QA | BE2 | QA |
| EDAM-T047 | Integration & unit coverage gate | QA | DEVOPS | QA |
| EDAM-T048 | Compose stack | DEVOPS | DE | DEVOPS |
| EDAM-T049 | Seeded schema + traffic generator | DE | DEVOPS | QA |
| EDAM-T050 | Pinned fixtures | QA | BE1 | QA |
| EDAM-T051 | CI two-target setup | DEVOPS | QA | DEVOPS |
| EDAM-T052 | No-write-path proof | SEC | DEVOPS | **SEC** |
| EDAM-T053 | Masking & log-hygiene audit | SEC | BE1 | **SEC** |
| EDAM-T054 | Honesty-path verification | SEC | QA | **SEC** |
| EDAM-T055 | Sprint security review sign-off | SEC | LEAD | **SEC/LEAD** |

**Load summary (primary ownership):** BE1 ≈ canonical + diff/build core; BE2 ≈ CDC/normalization/integrity/DLQ; DE ≈ infra-adjacent (creds, connector, attestation, DLQ store, fixtures); QA ≈ conformance/determinism/fixtures; SEC ≈ invariants + masking + sign-off; DEVOPS ≈ env/CI/metrics.

---

## 2. Day-1 Setup Checklist

**Per engineer**
- [ ] Repo access (monorepo) granted; SSH/commit signing configured.
- [ ] Local toolchain installed (Node LTS + package manager, Docker + Compose, Git).
- [ ] Pre-commit hooks installed (lint, format, secret-scan).
- [ ] Read & acknowledge: CCE v1 §3/§4/§5/§6/§12, Sprint 1 plan, backlog, this kickoff.
- [ ] Access to the issue tracker; backlog imported (Jira CSV from backlog §9).

**Team-level (LEAD/DEVOPS)**
- [ ] Monorepo created with skeleton dirs (per §3 bootstrap).
- [ ] CI project created with **two OS/arch runners** (determinism).
- [ ] Secret store (Vault-dev or cloud) provisioned; **read-only** CDC credential placeholder created (no write grants — INV-1).
- [ ] Replica access confirmed ROW+FULL+GTID (Phase-0 sign-off) — or dev seeds enforce it.
- [ ] Communication channels + ceremony calendar set (§15–18).
- [ ] Risk register opened (backlog §8 tags) with an owner (LEAD).

**Definition of "Day-1 done":** every engineer can `compose up` the stack locally and run the (empty) test suite green in CI on both targets.

---

## 3. Repository Bootstrap Checklist

- [ ] Monorepo root with workspace config (packages/services/apps).
- [ ] Directory skeleton per Blueprint §4 / Sprint plan §4:
  `packages/{canonical,contracts,cce-model}`, `services/{cdc-collector,normalization,cce-builder}`, `infra/dlq`, `deploy/compose`, `conformance`, `docs`.
- [ ] `docs/` contains the frozen specs (read-only; protected by CODEOWNERS).
- [ ] Lint/format/typecheck config at root; shared `tsconfig`/ESLint/Prettier.
- [ ] Pre-commit: format, lint, **secret scanning**, no-floats-in-money check (lightweight).
- [ ] Test runner + coverage configured; conformance harness scaffold.
- [ ] `.editorconfig`, `.gitignore`, `.nvmrc`/engine pin.
- [ ] `CODEOWNERS` (per §9), PR template, issue templates with the backlog labels (§10 of backlog).
- [ ] `CONTRIBUTING.md` referencing this kickoff (branch/PR/review rules).
- [ ] Branch protection on `main` (per §5).
- [ ] CI pipeline file committed (per §10) — green on empty repo.

---

## 4. Branch Strategy

**Trunk-based with short-lived feature branches.**

```
main  ──────●────────●────────●────────●───────►   (always green, protected)
             \        \        \
   feat/T001  ●──●──●  │        │     (1 task or tight task-group per branch)
   feat/T011         ●──●       │
   feat/T029                 ●──●──●
```

- Branch naming: `feat/EDAM-T###-short-slug`, `fix/EDAM-T###-...`, `chore/...`, `test/...`.
- One branch ≈ one backlog task (or a tightly coupled pair, e.g., T001+T002 if delivered together).
- Branch off latest `main`; rebase (no long-lived divergence). Max branch age target: **≤ 3 days**.
- No direct commits to `main`. No force-push to shared branches.
- Delete branch on merge.

---

## 5. Pull Request Rules

- **Small & focused:** one task; target < ~400 changed lines where feasible.
- **Linked:** PR references `EDAM-T###`; closes the issue on merge.
- **Template required:** what/why, task link, test evidence, conformance impact, invariant impact (`inv:no-write`/`inv:honesty` checkbox), risk tags.
- **Green required:** all CI gates pass (lint, typecheck, unit, integration where applicable, determinism rig for determinism-tagged tasks, secret scan).
- **Reviews:** ≥1 approval for normal tasks; **≥2 approvals** for `packages/canonical`, `packages/contracts`, and anything tagged `inv:no-write`/`inv:honesty`/`risk:determinism`/`risk:integrity` (one must be the area CODEOWNER; invariant tasks also require **SEC** approval).
- **No self-merge** of P0/critical-path or invariant-tagged PRs.
- **Conformance/determinism PRs** must attach the two-target rig output.
- **Frozen docs:** any PR touching `docs/` frozen specs is **blocked** unless explicitly a typo/clarity fix approved by LEAD (no semantic change to contracts).
- Squash-merge to keep `main` history linear; PR title = conventional commit.

---

## 6. Code Review Rules

**Reviewers check, in priority order:**
1. **Invariants** — no Kafel write path/credential (INV-1); no fabrication (INV-2: degraded/gap/unattributed produced honestly); single shared `canonical` used (INV-4).
2. **Determinism** — no map-iteration/locale/timezone/float leakage into serialized/hashed output.
3. **Contract conformance** — matches frozen CCE/companion field names, nullity, enums; no schema drift.
4. **Scope** — no Phase-2 (WORM/anchor/projection-query/risk/alert/reversal) logic creeping in.
5. **Correctness & tests** — acceptance criteria covered; negative/honesty fixtures present.
6. **Security/privacy** — masking before emit; no sensitive values in logs/metrics/DLQ-without-controls.
7. **Readability** — matches surrounding style; no dead code; clear naming.

**Review SLAs:** first review within **1 business day**; P0/critical-path within **4 working hours**. Reviewers leave explicit `approve`/`request-changes`; nits prefixed `nit:` are non-blocking.

---

## 7. Coding Standards

- **Language:** TypeScript (NestJS services, shared packages) per Blueprint §5.
- **Style:** enforced by Prettier + ESLint; no manual style debates — the linter is the authority.
- **Determinism-critical code (`canonical`):** pure, side-effect-free, no ambient locale/timezone/Date.now in serialization; explicit sorting; decimals as strings; documented and golden-vector tested.
- **Money/decimals:** never floating-point; exact decimal strings end-to-end (CCE §12.8). A lint/CI check flags float arithmetic on monetary paths.
- **Errors:** no silent catches; failures surface as alarms/DLQ, never swallowed (completeness).
- **Logging:** structured JSON, correlation id per CCE/segment; **never** log sensitive values; redact by default.
- **Config over hardcode:** monitored tables, sensitive fields, thresholds are configuration.
- **No secrets in code:** references only; secret scan in pre-commit + CI.
- **Tests co-located**, deterministic, no network in unit tests; integration uses the compose stack.
- **Public package APIs documented**; `canonical`/`contracts` are import-only (packages never import services).

---

## 8. Package Ownership Matrix

| Path | Owner (R) | Backup | 2-approval? | Notes |
|---|---|---|---|---|
| `packages/canonical` | BE1 | BE2 | **Yes** | Determinism keystone; changes are high-blast-radius. |
| `packages/contracts` | BE2 | BE1 | **Yes** | Frozen schemas; no semantic edits. |
| `packages/cce-model` | BE1 | BE2 | No | Pure model. |
| `services/cdc-collector` | BE2 | DE | No | Hosts attestation + completeness modules. |
| `services/normalization` | BE1 | BE2 | No | — |
| `services/cce-builder` | BE1 | BE2 | **Yes** | Identity/ordering/hash convergence point. |
| `infra/dlq` | DE | BE2 | No | Treat raw payloads as sensitive. |
| `deploy/compose` | DEVOPS | DE | No | Dev env. |
| `conformance` | QA | BE1 | No | Conformance + determinism. |
| `docs` (frozen specs) | LEAD | SEC | **Yes** | Read-only; no semantic change. |
| CI / pipeline config | DEVOPS | QA | No | — |

---

## 9. CODEOWNERS Proposal

> Illustrative `.github/CODEOWNERS` (map placeholders to GitHub handles). Most-specific rule wins.

```
# Default
*                                   @lead

# Determinism keystone — 2 approvals incl. owner
/packages/canonical/               @be1 @be2
/packages/contracts/               @be2 @be1

/packages/cce-model/               @be1
/services/cdc-collector/           @be2 @de
/services/normalization/           @be1
/services/cce-builder/             @be1 @be2
/infra/dlq/                        @de
/deploy/compose/                   @devops
/conformance/                      @qa

# Frozen specifications — protected; LEAD + SEC only, no semantic edits
/docs/*.md                         @lead @sec

# CI / security-sensitive
/.github/                          @devops @lead
/.github/workflows/                @devops @sec
```

Branch protection: require CODEOWNER review on the paths above; require SEC review on any PR labeled `inv:no-write` / `inv:honesty` / `risk:privacy` / `risk:security`.

---

## 10. CI/CD Pipeline Definition

> Sprint 1 ships **no production deployment** (services run locally/staging only). "CD" here = artifact build + staging compose, not prod release.

**Pipeline stages (per PR):**
1. **Setup** — checkout, install, cache.
2. **Static** — lint, typecheck, format check, **secret scan**, money-float check.
3. **Unit tests** — all packages/services; coverage threshold gate (`T047`).
4. **Build** — compile packages + service images.
5. **Integration** — spin compose stack; run pipeline integration tests.
6. **Conformance** — CCE subset C-1,3,4,5,6,7,8,10 through the live pipeline.
7. **Determinism rig** — run on **two OS/arch runners**; diff canonical bytes/hashes/ids (`T041`/`T051`). **Hard gate** for determinism-tagged PRs.
8. **Invariant checks** — automated `inv:no-write` scan (no Kafel write credential/grant); honesty negative-fixture assertions.
9. **Report** — publish test/coverage/conformance artifacts to the PR.

**Merge gate:** stages 1–4 + 8 required for all PRs; 5–7 required when touched areas affect them (and always on `cce-builder`/`canonical`/`contracts`/`conformance`). **Red CI blocks merge.**

**Main pipeline (post-merge):** full suite + nightly determinism rerun + build of staging images.

---

## 11. Local Development Workflow

1. `git pull --rebase origin main` → `git checkout -b feat/EDAM-T###-slug`.
2. `compose up` the Sprint-1 stack (MySQL ROW+FULL+GTID, MariaDB audit, Debezium, Redis bus, PostgreSQL state, vault-dev).
3. Run the service(s) in watch mode against the stack.
4. Generate traffic via the seeded traffic generator (`T049`); use pinned fixtures (`T050`) for deterministic expectations.
5. `run tests` (unit + relevant integration); run the local determinism check for canonical/builder changes.
6. Commit (signed, conventional message), push, open PR with the template.
7. Address review; keep branch rebased; squash-merge on green.

**Golden rule:** if your change touches serialization/hashing/ordering/ids, run the determinism check **before** pushing — a red rig in CI is a hard stop.

---

## 12. Testing Workflow

| Layer | When | Owner | Gate |
|---|---|---|---|
| **Unit** | every PR | author | must pass + coverage threshold |
| **Integration** (compose) | PRs touching ingestion/normalize/build/DLQ | author + QA | must pass |
| **Conformance** (CCE C-subset) | PRs touching builder/normalize/attestation/completeness; always on `cce-builder` | QA | must pass for affected cases; full subset before sprint acceptance |
| **Determinism rig** (2 targets) | PRs touching `canonical`/ordering/ids/hash | QA + DEVOPS | hard gate |
| **Invariant/honesty** | PRs touching creds/masking/fidelity/attribution | SEC | hard gate |

- Negative fixtures are first-class: every honesty path (downgrade→DEGRADED, gap→gap_detected, missing-audit→unattributed, poison→DLQ) has an explicit failing-input test.
- Conformance cases map 1:1 to backlog tasks T042–T046; QA owns the harness (`conformance/`).

---

## 13. Release Workflow

> No production release in Sprint 1. This defines how Sprint 1 output is **promoted to staging** and tagged.

1. **Versioning:** packages use semver; the monorepo tags sprint deliverables `sprint-1-rcN`.
2. **Staging promotion:** on green `main`, build images and deploy to the **staging** compose/K8s mirror (Blueprint §11.2) with real-ish config (no prod data).
3. **Release notes:** auto-generated from squash-merge conventional commits, grouped by Epic.
4. **Sign-off to "Sprint 1 complete":** LEAD tags `sprint-1` only after MVP-relevant acceptance (A1–A11) + milestones M1–M5 + SEC sign-off (`T055`).
5. **No prod path exists yet** — production release workflow is defined later (post-MVP), with the Go/Live checklist (§20) as its gate.

---

## 14. Security Review Workflow

- **Continuous:** SEC reviews every PR labeled `inv:no-write`, `inv:honesty`, `risk:privacy`, `risk:security` (required approver via CODEOWNERS).
- **Per-task verifier gates:** SEC is the named **Verifier** for T010, T019, T026, T030, T052, T053, T054, T055 (§1).
- **Three standing checks SEC owns this sprint:**
  1. **No-write-path proof (`T052`)** — automated assertion that no service/config holds a Kafel write credential or grant; collector write attempt is denied. Run in CI (stage 8).
  2. **Masking & log hygiene (`T053`)** — scan logs/metrics/DLQ for sensitive values; confirm masking-before-emit; DLQ raw treated as sensitive + access-controlled.
  3. **Honesty-path verification (`T054`)** — negative fixtures yield DEGRADED/gap/unattributed, never fabricated.
- **Sprint security sign-off (`T055`):** SEC + LEAD record a documented sign-off; **no open P0 security findings** is a hard gate for sprint completion.
- **Escalation:** any discovered write path, credential leak, or sensitive-data exposure is a **Sev-1**, halts the affected work, and triggers the risk process (§19).

---

## 15. Sprint Ceremony Plan

| Ceremony | Cadence | Duration | Attendees | Output |
|---|---|---|---|---|
| **Sprint Planning** | Day 1 | 2h | all | committed backlog, owners, DoR confirmed |
| **Daily Standup** | daily | 15m | all | blockers surfaced (§16) |
| **Backlog Refinement** | mid-week (×1–2) | 45m | LEAD, BE1, BE2, QA | next tasks meet DoR; estimates adjusted |
| **Determinism/Integrity sync** | 2×/week | 30m | BE1, BE2, QA, DEVOPS | rig status, conformance progress |
| **Security touchpoint** | weekly | 30m | SEC, LEAD, BE leads | invariant status, findings |
| **Sprint Review/Demo** | last day | 1h | all + stakeholders | A1–A11 demo, M1–M5 status |
| **Retrospective** | last day | 45m | all | improvements for Sprint 2 |

---

## 16. Daily Standup Structure

Async-first (written) + 15-min live for blockers. Each member posts:
1. **Yesterday:** task ids progressed (`EDAM-T###`) + merged PRs.
2. **Today:** task ids in focus.
3. **Blockers:** dependency waits, red CI, ambiguous spec point (escalate, don't guess).
4. **Invariant/risk flags:** anything touching `inv:no-write`/`inv:honesty`/`risk:determinism`.

**Standby rules:** a blocker older than 1 day is escalated to LEAD; a red determinism rig on `main` is an all-hands stop until green.

---

## 17. Weekly Progress Reporting

LEAD publishes a weekly status (end of week):

- **Milestones:** M1–M5 status (not-started/in-progress/done) with gating tasks.
- **Burndown:** SP completed vs remaining vs ideal (§18).
- **Critical path health:** position on the `canonical → CDC → completeness → build → conformance` chain; any slippage.
- **Conformance scoreboard:** C-1,3,4,5,6,7,8,10 → pass/in-progress/fail.
- **Invariant status:** `inv:no-write` and `inv:honesty` green/at-risk.
- **Risks:** open items from the register (§19) with owners + due dates.
- **Decisions/escalations:** anything needing stakeholder input.

---

## 18. Sprint Burndown Tracking

- **Unit:** Story Points (total ≈ **89 SP**, backlog §2).
- **Track:** remaining SP per day vs an ideal line over the 3-week sprint.
- **Board columns:** `Backlog → Ready (DoR) → In Progress → In Review → In Test/Conformance → Done (DoD)`.
- **WIP limits:** ≤ 2 in-progress tasks per engineer; ≤ 5 in review team-wide (keep the pipeline flowing).
- **Done = DoD met** (backlog §12): merged, tests + conformance green, determinism (where tagged), invariants verified — *not* "code written."
- **Leading indicators watched:** critical-path tasks (T001/T002/T010-T012/T035/T036/T041/T044) must trend done by their week (§ allocation); lag here predicts sprint slip earlier than raw burndown.

---

## 19. Risk Escalation Process

**Severity ladder**
| Sev | Definition | Response time | Owner |
|---|---|---|---|
| **Sev-1** | Invariant breach (write path/credential, sensitive-data exposure) or determinism broken on `main`. | immediate; stop affected work | SEC/LEAD |
| **Sev-2** | Critical-path task blocked > 1 day; conformance case unachievable as specified. | same day | LEAD |
| **Sev-3** | Non-critical blocker, flaky test, estimate slip. | next standup | task owner |

**Flow:** detect → tag issue with `risk:*` + severity → post in standup/channel → owner assigned → mitigation logged in the risk register → LEAD tracks to closure in weekly report.

**Hard rules:**
- A suspected **write path to Kafel** or **sensitive-data leak** is an automatic **Sev-1**; merge freeze on the affected area until cleared by SEC.
- **Ambiguity in a frozen spec is never resolved by guessing in code** — it is raised to LEAD; if a real contract gap exists, it is documented and deferred, never silently changed (specs are frozen).
- A **red determinism rig** on `main` blocks all merges until green.

---

## 20. Go-Live Preparation Checklist (forward-looking)

> Sprint 1 does **not** go to production. This is the standing pre-prod gate (from Blueprint §17), surfaced now so the team builds toward it. Items are **N/A for Sprint 1 exit** but tracked.

- [ ] (Phase 2) Independent verifier passes on prod-config WORM using only public inputs.
- [ ] (Phase 2) WORM compliance-mode Object Lock + geo-replication confirmed.
- [ ] (Phase 2) HSM keys non-exportable, Domain-C custody, usage audited.
- [ ] Source-config attestation + GTID-gap + lag alarms live and tested. *(Sprint 1 builds these.)*
- [ ] **Zero Kafel write credentials anywhere; no execution endpoint deployed.** *(Sprint 1 proves the no-write-path foundation via T052.)*
- [ ] mTLS + OIDC + TOTP + RBAC + IP allowlist active (Phase 3).
- [ ] Failure-scenario runbooks exercised (CDC/PG/WORM/HSM/TSA/queue).
- [ ] Backups encrypted + object-locked; DR restore drill incl. evidence verification.
- [ ] Full conformance suites green (CCE/WORM/Risk/contract subsets).
- [ ] Security review / threat-model sign-off; pen-test scheduled/passed.
- [ ] Stakeholder/compliance acceptance of MVP scope (read-only, propose-only, evidence-grade).

**Gate:** production proceeds only when integrity, completeness, security-boundary, and no-write-path groups are fully checked (Blueprint §17).

---

## 21. MVP Exit Criteria (Sprint 1 contribution)

> Full MVP exit spans Phases 1–5 (Blueprint §16). **Sprint 1's exit contribution** is the foundation below; it is *necessary, not sufficient* for MVP.

**Sprint 1 is complete when:**
1. **A1–A11** (Sprint 1 plan §12) all pass on the compose stack.
2. **M1–M5** (backlog §7) milestones reached.
3. Conformance **C-1,3,4,5,6,7,8,10** green through the live pipeline.
4. **Determinism** proven on two OS/arch targets (`T041`).
5. **Invariants** verified: no Kafel write credential (`T052`); honesty paths produce DEGRADED/gap/unattributed (`T054`); single `canonical` everywhere.
6. **Masking/log hygiene** signed off (`T053`); DLQ never drops (poison→quarantine).
7. **SEC sprint sign-off** recorded (`T055`); no open P0 security findings.
8. **No scope leakage** into Phase 2+ (no WORM sealing/anchoring/projection-query/risk/alert/reversal logic).

**Deliverable handoff to Sprint 2 (Phase 2 — Evidence/Anchoring):** validated, deterministic, fidelity-honest complete CCEs on the bus, with `event_hash` computed and the `row_hash` chain-link helper defined — ready to be sealed into WORM without revisiting identity, ordering, or hashing.

---

## 22. Implementation Governance Rules

The non-negotiables that govern all Sprint 1 (and beyond) work:

1. **Specs are frozen.** No PR changes the meaning of any frozen spec. Gaps are escalated to LEAD and documented, never patched in code.
2. **Invariants are law.** INV-1 (no EDAM write to Kafel), INV-2 (no fabrication), INV-3 (append-only/WORM — honored as "don't preclude it" this sprint), INV-4 (determinism via one `canonical`). A PR that weakens any invariant is rejected regardless of other merits.
3. **Determinism gate is absolute.** A red two-target rig blocks merges to `main`.
4. **No write path, proven continuously.** `inv:no-write` runs in CI; any standing Kafel write credential is a Sev-1.
5. **Honesty over green dashboards.** Degraded fidelity, gaps, and unattributed actors are surfaced, never hidden to make a demo look clean.
6. **Scope discipline.** Phase boundaries are hard; Phase-2 (WORM/anchoring) logic does not enter Sprint 1 even if convenient.
7. **Two-approval rule** on `canonical`, `contracts`, `cce-builder`, and all invariant-tagged PRs; SEC approval on security/privacy/invariant PRs.
8. **Traceability.** Every PR links a backlog task; every task links a plan item and (where relevant) a CCE clause/conformance test.
9. **Decisions are recorded.** Architectural/process decisions affecting execution are logged (lightweight ADR in `docs/decisions/` — *operational notes only, not new specs*) and surfaced in the weekly report.
10. **Definition of Done is the only "done."** Code written ≠ done; DoD (merged + tested + conformance + determinism + invariants) is.

---

*End of Implementation Kickoff Package. Process/planning artifact only — no production code; no existing documents modified. Operationalizes the frozen Sprint 1 backlog and plan; preserves all frozen invariants.*
