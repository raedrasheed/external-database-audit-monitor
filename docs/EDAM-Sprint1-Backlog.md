# EDAM Sprint 1 — Implementation Backlog
### Importable into Jira / Azure DevOps / GitHub Projects / Linear

> **Document class:** Backlog (work-tracking artifact). Derived **only** from `docs/EDAM-Sprint1-Implementation-Plan.md`; introduces no new scope, specs, or architecture.
> **Frozen baseline (honored, unmodified):** the Sprint 1 plan, the Engineering Blueprint, and all contract specs (CCE v1, companions, WORM, risk rules).
> **Status:** Planning/tracking only — no production code.
> **Estimate unit:** Story Points (SP), Fibonacci. Reference: 1 SP ≈ 0.5 ideal-day; 2 SP ≈ 1 day; 3 SP ≈ 1.5 days; 5 SP ≈ 2.5–3 days; 8 SP ≈ 4–5 days.
> **Date:** 2026-06-01.

---

## 0. How to use this document

- **Hierarchy:** `Epic → Story → Task`. IDs are stable and import-safe (`EDAM-E#`, `EDAM-S#`, `EDAM-T###`).
- The **Jira-ready CSV-style hierarchy** (§11) and **GitHub labels** (§12) are provided for direct import.
- Every task carries: id, title, description, dependencies, priority, estimate, acceptance criteria, and risk tags.
- Priorities: **P0** = blocker / on critical path; **P1** = sprint-critical; **P2** = needed, parallelizable.
- Sprint 1 maps to **Phase 1 — Ingestion + CCE Foundation** of the blueprint. Definition of success: byte-deterministic, fidelity-honest, complete CCEs on the bus, with **no Kafel write credential** anywhere.

---

## 1. Epics

| Epic ID | Title | Goal | Maps to (Sprint 1 plan) | Priority |
|---|---|---|---|---|
| **EDAM-E1** | Canonical & Contracts Foundation | Deterministic serialization/hashing + frozen schema validation — the keystone everything depends on. | §3.1, §3.2; D1, D2 | P0 |
| **EDAM-E2** | Source Ingestion (CDC) | Read-only ROW+FULL+GTID streaming from the replica with durable offsets. | §3.3; D3 | P0 |
| **EDAM-E3** | Fidelity & Completeness Integrity | Attestation of source config + completeness/gap proof + heartbeat. | §3.4, §3.5; D4, D5 | P1 |
| **EDAM-E4** | Normalization & CCE Build | Native → partial CCE → complete, validated CCE (diff, masking, attribution, ids, hash). | §3.6, §3.7; D6, D7 | P0 |
| **EDAM-E5** | Resilience (Dead Letter Queue) | Poison records quarantined, never dropped. | §3.8; D8 | P1 |
| **EDAM-E6** | Test, Conformance & Determinism | Unit + integration + CCE conformance subset + two-target determinism rig. | §11; D9 | P0 |
| **EDAM-E7** | Dev Environment & Enablement | Docker Compose stack, fixtures, secrets, CI targets. | §10, §9; D10 | P0 |
| **EDAM-E8** | Security & Invariant Verification | Prove read-only/no-write-path, masking, DLQ sensitivity, honesty paths. | §13, §17; INV-1/2/4 | P1 |

---

## 2. Stories & Tasks

> Estimates roll up: Task SP → Story SP → Epic SP. Acceptance criteria (AC) are objective and testable.

### EPIC EDAM-E1 — Canonical & Contracts Foundation  (13 SP)

#### Story EDAM-S1 — Deterministic canonical serialization & hashing *(canonical package)* — P0 — 8 SP
*As an engineer, I need one byte-deterministic serializer + hasher so every service produces identical hashes.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T001** | Define canonical serialization rules | Implement CCE §12.7 rules: UTF-8 NFC, lexicographic key sort, exact-decimal money as strings, plain integers, explicit nulls, RFC3339 UTC ms, no insignificant whitespace. (S1-CAN-1) | — | P0 | 3 | Given tricky inputs (unicode, nested objects, nulls), output bytes are stable and spec-conformant; documented algorithm. | `risk:determinism` |
| **EDAM-T002** | SHA-256 hashing over canonical bytes | Produce `event_hash` form `sha256:<64hex>` over canonical core. (S1-CAN-2) | T001 | P0 | 2 | Hash matches a pinned golden vector; stable across runs. | `risk:determinism` |
| **EDAM-T003** | Deterministic UUIDv5 helper | Fixed EDAM namespace; `envelope_id = UUIDv5(db_id|tx_id|server_uuid[,part])`. (S1-CAN-3) | — | P0 | 1 | Same inputs → same UUID; differs on `part`; golden vectors pass. | `risk:determinism` |
| **EDAM-T004** | Hash-chain link helper | `row_hash = H(prev_row_hash ‖ event_hash)`; genesis all-zero. Define now, used Phase 2. (S1-CAN-4) | T002 | P1 | 1 | Unit test reproduces a known chain; no segment/WORM logic added. | `risk:scope-leak` |
| **EDAM-T005** | Exact-decimal / float-rejection | Money as exact decimal strings; reject float inputs; exact compare/format. (S1-CAN-6) | T001 | P0 | 1 | Float-encoded money rejected; `100.00` vs `100.000` handled per rule. | `risk:financial-accuracy` |

#### Story EDAM-S2 — Frozen schema validation *(contracts package)* — P0 — 5 SP
*As an engineer, I need to validate every CCE against the frozen schemas, including stateful rules.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T006** | Vendor frozen JSON Schemas | Copy CCE v1 (Appendix B) + companion schemas verbatim; pin `schema_version`. (S1-CON-1) | — | P0 | 2 | Schemas byte-match the frozen specs; versions pinned; no edits. | `risk:contract-drift` |
| **EDAM-T007** | Validator API | `validate(obj) → {valid, errors[] with rule ids}`. (S1-CON-2) | T006 | P0 | 1 | Valid fixtures pass; errors carry machine-readable rule ids. | — |
| **EDAM-T008** | Stateful rule checks | Encode V3 (envelope_id derivation), V4 (seq contiguity / statement_count), V14 (monotonic ingest), V15 (dup-id/differing-hash). (S1-CON-3) | T003, T007 | P0 | 1 | Each stateful rule has a passing + failing test. | `risk:integrity` |
| **EDAM-T009** | Invalid-fixture suite + version gate | One invalid fixture per V1–V15; reject unknown major, ignore unknown optional minor. (S1-CON-4/5) | T007 | P0 | 1 | Every invalid fixture fails with expected rule id; major mismatch rejected; minor optional ignored. | `risk:contract-drift` |

---

### EPIC EDAM-E2 — Source Ingestion (CDC)  (13 SP)

#### Story EDAM-S3 — Read-only CDC streaming with durable offsets *(CDC Collector)* — P0 — 13 SP
*As the platform, I need committed row changes streamed read-only from the replica with reliable resume.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T010** | Provision read-only CDC credential | Replication+SELECT only; no writes (INV-1); stored as secret reference. (S1-CDC-1) | E7 env | P0 | 2 | Credential proven read-only (write attempt denied); secret in store, not code. | `risk:security` `inv:no-write` |
| **EDAM-T011** | Configure Debezium ROW+FULL+GTID | Connector for MySQL/MariaDB; snapshot mode for selected tables. (S1-CDC-2) | T010 | P0 | 3 | Connector streams selected tables; ROW+FULL+GTID confirmed. | `risk:source-config` |
| **EDAM-T012** | Offset/GTID tracking | Advance offset only after durable handoff; persist resume position. (S1-CDC-3) | T011 | P0 | 3 | Restart resumes exactly; no duplicate/loss across restart. | `risk:completeness` |
| **EDAM-T013** | Snapshot↔stream handoff | Record GTID at snapshot start/end; resume streaming with no gap; log handoff. (S1-CDC-4) | T012 | P0 | 2 | Integration test shows continuous GTID across handoff; no gap. | `risk:completeness` |
| **EDAM-T014** | Emit CAPTURED records to bus | Raw native + offset + table identity onto internal bus (I1). (S1-CDC-5) | T011 | P0 | 1 | CAPTURED message matches I1 contract; observable on bus. | — |
| **EDAM-T015** | Backoff/reconnect + lag alarm | Reconnect on errors preserving offset; alarm on stall/lag. (S1-CDC-6) | T012 | P1 | 1 | Simulated disconnect recovers w/o data loss; lag metric + alarm fire. | `risk:reliability` |
| **EDAM-T016** | MySQL vs MariaDB distinct adapters | One interface, two adapters (GTID semantics differ). (S1-CDC-7) | T011 | P1 | 1 | Both engines stream through their adapter; tests for each. | `risk:vendor` |

---

### EPIC EDAM-E3 — Fidelity & Completeness Integrity  (8 SP)

#### Story EDAM-S4 — Source-configuration attestation *(Attestation Monitor)* — P1 — 4 SP
*As an auditor, I need proof of capture conditions and loud alarms when they degrade.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T017** | Config sampler | Periodic read-only sample of binlog_format, binlog_row_image, gtid_mode, log_bin, retention, server_uuid. (S1-ATT-1) | T010 | P1 | 1 | Sampler reads all targets read-only at interval. | `risk:source-config` |
| **EDAM-T018** | Emit config_snapshot | Produce `fidelity.source_config` snapshot (id+values) for Normalization (I2). (S1-ATT-2) | T017 | P1 | 1 | Each snapshot has stable id; resolvable later. | — |
| **EDAM-T019** | Downgrade detection + CRITICAL alarm | row_image≠FULL / format≠ROW / gtid≠ON / retention<threshold → DEGRADED + alarm. (S1-ATT-3) | T017 | **P0** | 1 | Simulated downgrade flips fidelity DEGRADED with reason + CRITICAL alarm (C-7 dependency). | `risk:integrity` `inv:honesty` |
| **EDAM-T020** | Audit-plugin state watch | Watch native audit plugin loaded/logging for tamper indicators. (S1-ATT-4) | T017 | P1 | 1 | Plugin disabled → tamper indicator surfaced for attribution capping. | `risk:attribution` |

#### Story EDAM-S5 — Completeness proof *(Completeness Watcher)* — P1 — 4 SP
*As the platform, I must prove no events were silently missed.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T021** | Consumed-GTID tracking + gap compute | Maintain consumed set; read source `gtid_executed`; gap = source − consumed (excl. in-flight). (S1-CMP-1) | T012 | **P0** | 2 | Injected gap detected; in-flight not false-flagged. | `risk:completeness` `inv:honesty` |
| **EDAM-T022** | Heartbeat watermark | Low-rate heartbeat distinguishes idle vs stalled. (S1-CMP-2) | T011 | P1 | 1 | Idle stream stays HEALTHY; stalled stream flagged. | `risk:reliability` |
| **EDAM-T023** | Gap → degraded + alarm | Non-empty gap → `gap_detected=true`, fidelity DEGRADED, alarm (I3). (S1-CMP-3) | T021 | P0 | 1 | C-8 path: gap surfaced, not swallowed. | `risk:integrity` `inv:honesty` |
| **EDAM-T024** | Snapshot-phase computation | Compute `snapshot/handoff/streaming` for completeness. (S1-CMP-4) | T013 | P2 | — | Phase correctly reported across lifecycle. *(folded into T013/T021 testing)* | — |

---

### EPIC EDAM-E4 — Normalization & CCE Build  (21 SP)

#### Story EDAM-S6 — Native → partial CCE *(Normalization Service)* — P1 — 7 SP
*As the pipeline, I need native events mapped to partial CCEs carrying truthful fidelity/completeness.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T025** | Native → CCE skeleton | Map Debezium event → `source`/`transaction`/`offset`. (S1-NRM-1) | T014, E1 | P1 | 2 | Skeleton fields populated correctly from native event. | — |
| **EDAM-T026** | Attach fidelity & completeness | Stamp `fidelity` (I2) + `completeness` (I3) on each event. (S1-NRM-2) | T018, T023, T025 | **P0** | 2 | Every partial CCE carries truthful fidelity/completeness from first event (no retrofit). | `inv:honesty` |
| **EDAM-T027** | Operation mapping + nullity | INSERT/UPDATE/DELETE/DDL/TRUNCATE with correct before/after nullity (CCE §5). (S1-NRM-3) | T025 | P1 | 2 | Each op type maps with spec-correct nullity (C-3 dependency). | `risk:contract-drift` |
| **EDAM-T028** | Poison record → DLQ | Unmappable record → DLQ with raw payload + offset + reason + alarm; never drop. (S1-NRM-4) | T037 | P1 | 1 | Malformed event lands in DLQ; pipeline neither stalls nor drops. | `risk:completeness` `inv:honesty` |

#### Story EDAM-S7 — Complete CCE assembly *(CCE Builder)* — P0 — 14 SP
*As the platform, I need complete, validated, deterministic CCEs with diff, masking, and honest attribution.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T029** | Field-level diff engine | Per-column/path `{old,new,data_type,changed,sensitive}`; nested `path` arrays. (S1-BLD-1) | T027 | P0 | 3 | Correct diff for all op types; nested paths for document-readiness. | `risk:contract-drift` |
| **EDAM-T030** | Sensitive-field masking | Mask from `sensitive_fields` config; never emit raw sensitive; `masked=true`. (S1-BLD-2) | T029 | **P0** | 2 | Sensitive values masked everywhere; raw never leaves Builder. | `risk:privacy` `inv:honesty` |
| **EDAM-T031** | Transaction grouping + seq | One envelope per source txn; contiguous `seq` from 0; `statement_count`. (S1-BLD-3) | T027 | P0 | 2 | Multi-row txn → one envelope, seq 0..n-1, count matches (C-4). | `risk:integrity` |
| **EDAM-T032** | Deterministic ordering | Intra-txn order by source; global key `(commit_ts, offset tie-break)`. (S1-BLD-4) | T031 | P0 | 2 | Equal-timestamp txns ordered deterministically (C-5). | `risk:determinism` |
| **EDAM-T033** | Deterministic envelope_id | UUIDv5(`db_id|tx_id|server_uuid`)(+part). (S1-BLD-5) | T003, T031 | P0 | 1 | Replays produce identical id (C-6). | `risk:determinism` |
| **EDAM-T034** | Attribution correlation | Join DB-Audit Events (I5) on connection_id/window/thread/gtid → `actor`+confidence; `unattributed` when no match. (S1-BLD-6) | T020, T031 | P1 | 2 | Audit present → exact/probable + ref; absent/disabled → `unattributed` (C-10); never faked. | `risk:attribution` `inv:honesty` |
| **EDAM-T035** | Compute event_hash | Hash canonical core via `canonical`; expose value (no sealing/segments). (S1-BLD-7) | T002, T032 | P0 | 1 | event_hash byte-stable; no Phase-2 logic introduced. | `risk:scope-leak` |
| **EDAM-T036** | Validate + idempotency + dup detection | Validate against `contracts` before publish; dedupe same id+hash; **different hash for same id → CRITICAL** (V15). (S1-BLD-8/9) | T009, T035 | P0 | 1 | Invalid CCE rejected; duplicate deduped; dup-id/differing-hash alarms. | `risk:integrity` |

---

### EPIC EDAM-E5 — Resilience (Dead Letter Queue)  (5 SP)

#### Story EDAM-S8 — Poison-record quarantine *(DLQ)* — P1 — 5 SP
*As an operator, I need unmappable records retained and visible, never silently lost.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T037** | DLQ store schema | raw payload, offset, source, reason, first_seen, count; append-only. (S1-DLQ-1) | E7 db | P1 | 2 | Schema migrated; rows immutable; encrypted at rest. | `risk:privacy` |
| **EDAM-T038** | Quarantine API + alarm | Used by Normalization/Builder failure paths; alarm on enqueue. (S1-DLQ-2) | T037 | P1 | 1 | Enqueue path works from both services; alarm fires. | `risk:completeness` |
| **EDAM-T039** | Inspection/replay tooling | Manual read-only inspect/replay; no auto-reprocess that masks a gap. (S1-DLQ-3) | T037 | P2 | 1 | Operator can inspect; replay is explicit + logged. | — |
| **EDAM-T040** | DLQ depth metric + alert | DLQ depth > 0 is a visible operational signal. (S1-DLQ-4) | T037 | P1 | 1 | Metric exported; alert at depth>0. | `risk:completeness` |

---

### EPIC EDAM-E6 — Test, Conformance & Determinism  (13 SP)

#### Story EDAM-S9 — Determinism rig & conformance harness — P0 — 13 SP
*As QA, I need automated proof of determinism and CCE conformance through the live pipeline.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T041** | Two-target determinism rig | Run fixtures on two OS/arch CI targets; diff bytes + hashes. (S1-CAN-5) | T002, E7 | **P0** | 3 | Identical canonical bytes/`event_hash`/`envelope_id` on both targets (C-1/C-6). | `risk:determinism` |
| **EDAM-T042** | Conformance C-3 | INSERT/UPDATE/DELETE/DDL/TRUNCATE representations + nullity (incl. TRUNCATE no-row-image = C-9). | T027, T029 | P0 | 2 | All op cases pass via live pipeline. | `risk:contract-drift` |
| **EDAM-T043** | Conformance C-4 & C-5 | Multi-row grouping; deterministic ordering on equal commit_ts. | T031, T032 | P0 | 2 | C-4 + C-5 pass. | `risk:integrity` |
| **EDAM-T044** | Conformance C-6 | Replay idempotency; perturbed replay flagged (V15). | T033, T036 | P0 | 2 | Same ids/hashes on replay; perturbation flagged. | `risk:integrity` |
| **EDAM-T045** | Conformance C-7 & C-8 | Row-image downgrade → DEGRADED+reason; injected GTID gap → gap_detected. | T019, T023 | P0 | 2 | C-7 + C-8 pass. | `risk:integrity` `inv:honesty` |
| **EDAM-T046** | Conformance C-10 | Attribution exact/probable vs `unattributed` on audit disable. | T034 | P1 | 1 | C-10 passes; no fabricated identity. | `risk:attribution` |
| **EDAM-T047** | Integration & unit coverage gate | Wire unit + integration suites; coverage thresholds; CI gate. | most tasks | P1 | 1 | CI red on failure; coverage thresholds enforced. | `risk:reliability` |

---

### EPIC EDAM-E7 — Dev Environment & Enablement  (8 SP)

#### Story EDAM-S10 — Local dev stack & fixtures — P0 — 8 SP
*As an engineer, I need a reproducible local stack and deterministic fixtures.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T048** | Compose stack | MySQL (ROW+FULL+GTID, seeded), MariaDB audit, Debezium, Redis bus, PostgreSQL state, vault-dev. (§10) | — | P0 | 3 | `compose up` yields a working stack; source config compliant. | `risk:source-config` |
| **EDAM-T049** | Seeded schema + traffic generator | Kafel-like tables; scripts generating INSERT/UPDATE/DELETE/DDL/TRUNCATE. | T048 | P0 | 2 | Deterministic traffic reproducible across runs. | — |
| **EDAM-T050** | Pinned fixtures | Known transactions with pinned expected `envelope_id`/`event_hash` for tests. | T049, T002, T003 | P0 | 2 | Fixtures shared by integration + conformance; golden values pinned. | `risk:determinism` |
| **EDAM-T051** | CI two-target setup | CI runners on two OS/arch targets for determinism. | T048 | P0 | 1 | CI runs rig on both targets per PR. | `risk:determinism` |

---

### EPIC EDAM-E8 — Security & Invariant Verification  (5 SP)

#### Story EDAM-S11 — Invariant & security gates — P1 — 5 SP
*As a security engineer, I must prove the frozen invariants hold before sign-off.*

| Task | Title | Description | Deps | Pri | Est | Acceptance criteria | Risk tags |
|---|---|---|---|---|---|---|---|
| **EDAM-T052** | No-write-path proof | Automated check: no Kafel write credential in any service/config; collector write attempt denied. (INV-1) | T010 | **P0** | 2 | CI/security check passes; documented evidence. | `risk:security` `inv:no-write` |
| **EDAM-T053** | Masking & log-hygiene audit | No sensitive values in logs/metrics; DLQ raw treated as sensitive. | T030, T037 | P1 | 1 | Log scan finds no sensitive values; DLQ access-controlled. | `risk:privacy` |
| **EDAM-T054** | Honesty-path verification | DEGRADED on downgrade, gap_detected on gap, unattributed on missing audit — all on negative fixtures. (INV-2) | T019, T023, T034 | P1 | 1 | Negative fixtures yield honest outputs, never fabricated. | `inv:honesty` |
| **EDAM-T055** | Sprint security review sign-off | Review trust boundary, read-only creds, masking, DLQ sensitivity. (§13) | T052, T053, T054 | P1 | 1 | Security sign-off recorded; no open P0 findings. | `risk:security` |

**Total Sprint 1: ~89 SP** (≈ the ~55 ideal-days in the plan, including test/env/security overhead).

---

## 3. Dependency Graph

```
                ┌──────────── EDAM-E7 (Dev Env) ────────────┐
                │ T048 → T049 → T050 ; T048 → T051           │
                └───────────────┬────────────────────────────┘
                                │ (env precondition for ingestion & tests)
   EDAM-E1 (Canonical/Contracts)│
   T001→T002→T004               │
   T001→T005                    │
   T003 ───────────────┐        │
   T006→T007→T008(+T003)│        │
   T007→T009            │        │
        │ (E1 blocks build+validation+rig)
        ▼               ▼        ▼
   EDAM-E2 (CDC)        EDAM-E6 rig (T041 needs T002)
   T010→T011→T012→T013
   T011→T014 ; T012→T015 ; T011→T016
        │
        ├──────────────► EDAM-E3 (Fidelity/Completeness)
        │   T017→T018 ; T017→T019 ; T017→T020
        │   T012→T021→T023 ; T011→T022 ; T013→T024
        ▼
   EDAM-E4 (Normalize/Build)
   T014+E1 → T025
   T018,T023,T025 → T026          (honesty stamped here)
   T025 → T027 → T029 → T030
   T027 → T031 → T032 → T033(+T003)
   T031 → T034 (needs T020 audit)
   T032+T002 → T035 → T036(+T009)
   T037 → T028 (DLQ before Normalization poison path)
        │
        ▼
   EDAM-E6 conformance (T042..T047) consume E2/E3/E4 outputs
        │
        ▼
   EDAM-E8 (Security/Invariants) T052..T055 consume E2/E4/E5
```

**Edge legend:** `A → B` = B depends on A. DLQ (T037) is built before the Normalization poison path (T028).

---

## 4. Critical Path

The longest blocking chain that determines sprint duration:

```
T001 → T002 → T035 → T036 → T044 (C-6 conformance) → Sprint Acceptance
  └────────────→ T041 (determinism rig, needs T002) ─┘
        and in parallel feeding T035/T036:
T010 → T011 → T012 → T021 → T023 → T026 → T029 → T031 → T032 → T035
```

**Critical path (consolidated):**
`T001 → T002 → (T010→T011→T012) → T021→T023 → T025→T026 → T027→T029 → T031→T032 → T035 → T036 → T044/T041 → Acceptance`

- **T001/T002 (canonical)** and **T010–T012 (CDC offsets)** are the two earliest blockers; both should start day 1.
- **T035→T036 (event_hash + validation/idempotency)** is the convergence point; conformance C-6 (T044) and the determinism rig (T041) gate sign-off.

---

## 5. Parallelizable Work

| Parallel track | Tasks | Can run alongside | Note |
|---|---|---|---|
| Dev env | T048, T049, T051 | everything | Needed early; unblocks ingestion + rig. |
| Canonical | T001→T002, T003, T005 | dev env | Pure library; no infra dependency. |
| Contracts | T006→T007→T009 | canonical (T008 needs T003) | Schema vendoring independent of services. |
| CDC | T010→T016 | canonical/contracts | Independent until Normalization. |
| Attestation | T017→T020 | Completeness | Both sit on the collector connection. |
| Completeness | T021→T024 | Attestation | — |
| DLQ | T037→T040 | everything (needs db) | Build before T028. |
| Security | T052 early (after T010); T053–T055 late | most | T052 (no-write proof) can start as soon as creds exist. |

**Not parallelizable:** the diff→group→order→id→hash→validate chain in E4 is largely sequential; and conformance C-6/C-7/C-8 depend on their upstream features landing first.

---

## 6. Suggested Sprint Allocation

> One 3-week sprint (per plan), 4–5 engineers. If capacity forces a split, the **week boundaries below double as two 1.5-week sub-sprints**.

| Window | Focus | Tasks (primary) | Owners (roles) |
|---|---|---|---|
| **Week 1** | Foundations + ingestion start | T001,T002,T003,T005 (BE); T006,T007 (BE/QA); T048,T049,T051 (DE/DevOps); T010,T011,T012 (BE/DE) | BE×2, DE, DevOps |
| **Week 2** | Integrity + normalization | T008,T009 (BE); T013,T015,T016 (BE/DE); T017–T020 (BE/Sec); T021–T024 (BE/DE); T037,T038,T040 (BE/DE); T025,T026,T027 (BE); T052 (Sec) | BE×2, DE, Sec |
| **Week 3** | Build + conformance + sign-off | T028 (BE); T029–T036 (BE); T041–T047 (QA); T050 (DE); T053,T054,T055 (Sec); T039 (BE/DE, P2) | BE×2, QA, Sec |

P2 tasks (T024 folded, T039) are pulled only if capacity allows.

---

## 7. Milestone Mapping

| Milestone | Definition | Gating tasks | Maps to plan/blueprint |
|---|---|---|---|
| **M1 — Deterministic core** | Canonical + contracts proven byte-stable on two targets. | T001,T002,T003,T009,T041 | Plan A2; CCE C-1/C-6 |
| **M2 — Live capture** | Read-only CDC streaming with durable offsets + handoff. | T010,T011,T012,T013 | Plan A1/A10; Blueprint Phase 1 |
| **M3 — Integrity honesty** | Downgrade & gap surface loudly; fidelity/completeness stamped on CCEs. | T019,T021,T023,T026 | Plan A5/A6; CCE C-7/C-8 |
| **M4 — Complete CCE** | Validated, masked, attributed, deterministic CCEs on the bus. | T029–T036 | Plan A3/A4/A7/A9; CCE C-3/C-4/C-5/C-10 |
| **M5 — Sprint acceptance** | A1–A11 pass; conformance subset + rig green; security sign-off. | T042–T047,T052–T055 | Plan §12 A1–A11; §17 DoD |

---

## 8. Risk Tags (legend + register)

| Tag | Meaning | Primary tasks | Mitigation |
|---|---|---|---|
| `risk:determinism` | Non-deterministic output breaks all hashing/evidence. | T001,T002,T003,T032,T033,T041,T050,T051 | Single `canonical`; two-target rig from day 1; ban floats. |
| `risk:source-config` | Replica not ROW+FULL/GTID. | T011,T017,T048 | Attestation early; dev seeds enforce; M1 gate. |
| `risk:completeness` | Silent missed events / dropped records. | T012,T013,T021,T023,T028,T038,T040 | GTID continuity proof; DLQ; heartbeat. |
| `risk:integrity` | Tamper/ordering/grouping errors. | T008,T019,T023,T031,T036,T043,T044,T045 | Stateful validation; conformance gates. |
| `risk:attribution` | Wrong/ambiguous actor. | T020,T034,T046 | Confidence model; `unattributed` over guessing. |
| `risk:privacy` | Sensitive data leakage. | T030,T037,T053 | Mask before emit; DLQ as sensitive; log hygiene. |
| `risk:security` | Trust-boundary / credential issues. | T010,T052,T055 | Read-only creds; no-write proof; security review. |
| `risk:vendor` | MySQL vs MariaDB quirks. | T016 | Distinct adapters; test both. |
| `risk:reliability` | Stalls/lag/recovery. | T015,T022,T047 | Backoff; lag alarms; CI gate. |
| `risk:contract-drift` | Divergence from frozen schemas. | T006,T009,T027,T029,T042 | Vendor verbatim; version pin; conformance. |
| `risk:scope-leak` | Phase-2 (WORM/anchor) creeping in. | T004,T035 | Hard boundary: define helpers, no sealing. |
| `risk:financial-accuracy` | Float money corruption. | T005 | Exact decimal; reject floats. |
| `inv:no-write` | Must hold: no Kafel write path. | T010,T052 | Automated CI proof. |
| `inv:honesty` | Must hold: no fabrication. | T019,T023,T026,T030,T034,T045,T054 | Negative fixtures assert DEGRADED/gap/unattributed. |

---

## 9. Jira-ready Hierarchy (import CSV-style)

> Columns: `Issue Type, Key, Summary, Parent, Priority, Story Points, Labels`. Import as-is or map columns to your tracker. (Epics have no Story Points; Stories roll up tasks.)

```
Issue Type,Key,Summary,Parent,Priority,Story Points,Labels
Epic,EDAM-E1,Canonical & Contracts Foundation,,P0,,phase-1;epic;determinism
Story,EDAM-S1,Deterministic canonical serialization & hashing,EDAM-E1,P0,8,canonical;determinism
Task,EDAM-T001,Define canonical serialization rules,EDAM-S1,P0,3,canonical;risk-determinism
Task,EDAM-T002,SHA-256 hashing over canonical bytes,EDAM-S1,P0,2,canonical;risk-determinism
Task,EDAM-T003,Deterministic UUIDv5 helper,EDAM-S1,P0,1,canonical;risk-determinism
Task,EDAM-T004,Hash-chain link helper,EDAM-S1,P1,1,canonical;risk-scope-leak
Task,EDAM-T005,Exact-decimal / float-rejection,EDAM-S1,P0,1,canonical;risk-financial-accuracy
Story,EDAM-S2,Frozen schema validation,EDAM-E1,P0,5,contracts
Task,EDAM-T006,Vendor frozen JSON Schemas,EDAM-S2,P0,2,contracts;risk-contract-drift
Task,EDAM-T007,Validator API,EDAM-S2,P0,1,contracts
Task,EDAM-T008,Stateful rule checks,EDAM-S2,P0,1,contracts;risk-integrity
Task,EDAM-T009,Invalid-fixture suite + version gate,EDAM-S2,P0,1,contracts;risk-contract-drift
Epic,EDAM-E2,Source Ingestion (CDC),,P0,,phase-1;epic;cdc
Story,EDAM-S3,Read-only CDC streaming with durable offsets,EDAM-E2,P0,13,cdc
Task,EDAM-T010,Provision read-only CDC credential,EDAM-S3,P0,2,cdc;risk-security;inv-no-write
Task,EDAM-T011,Configure Debezium ROW+FULL+GTID,EDAM-S3,P0,3,cdc;risk-source-config
Task,EDAM-T012,Offset/GTID tracking,EDAM-S3,P0,3,cdc;risk-completeness
Task,EDAM-T013,Snapshot to stream handoff,EDAM-S3,P0,2,cdc;risk-completeness
Task,EDAM-T014,Emit CAPTURED records to bus,EDAM-S3,P0,1,cdc
Task,EDAM-T015,Backoff/reconnect + lag alarm,EDAM-S3,P1,1,cdc;risk-reliability
Task,EDAM-T016,MySQL vs MariaDB distinct adapters,EDAM-S3,P1,1,cdc;risk-vendor
Epic,EDAM-E3,Fidelity & Completeness Integrity,,P1,,phase-1;epic;integrity
Story,EDAM-S4,Source-configuration attestation,EDAM-E3,P1,4,attestation
Task,EDAM-T017,Config sampler,EDAM-S4,P1,1,attestation;risk-source-config
Task,EDAM-T018,Emit config_snapshot,EDAM-S4,P1,1,attestation
Task,EDAM-T019,Downgrade detection + CRITICAL alarm,EDAM-S4,P0,1,attestation;risk-integrity;inv-honesty
Task,EDAM-T020,Audit-plugin state watch,EDAM-S4,P1,1,attestation;risk-attribution
Story,EDAM-S5,Completeness proof,EDAM-E3,P1,4,completeness
Task,EDAM-T021,Consumed-GTID tracking + gap compute,EDAM-S5,P0,2,completeness;risk-completeness;inv-honesty
Task,EDAM-T022,Heartbeat watermark,EDAM-S5,P1,1,completeness;risk-reliability
Task,EDAM-T023,Gap to degraded + alarm,EDAM-S5,P0,1,completeness;risk-integrity;inv-honesty
Task,EDAM-T024,Snapshot-phase computation,EDAM-S5,P2,0,completeness
Epic,EDAM-E4,Normalization & CCE Build,,P0,,phase-1;epic;cce
Story,EDAM-S6,Native to partial CCE,EDAM-E4,P1,7,normalization
Task,EDAM-T025,Native to CCE skeleton,EDAM-S6,P1,2,normalization
Task,EDAM-T026,Attach fidelity & completeness,EDAM-S6,P0,2,normalization;inv-honesty
Task,EDAM-T027,Operation mapping + nullity,EDAM-S6,P1,2,normalization;risk-contract-drift
Task,EDAM-T028,Poison record to DLQ,EDAM-S6,P1,1,normalization;risk-completeness;inv-honesty
Story,EDAM-S7,Complete CCE assembly,EDAM-E4,P0,14,cce-builder
Task,EDAM-T029,Field-level diff engine,EDAM-S7,P0,3,cce-builder;risk-contract-drift
Task,EDAM-T030,Sensitive-field masking,EDAM-S7,P0,2,cce-builder;risk-privacy;inv-honesty
Task,EDAM-T031,Transaction grouping + seq,EDAM-S7,P0,2,cce-builder;risk-integrity
Task,EDAM-T032,Deterministic ordering,EDAM-S7,P0,2,cce-builder;risk-determinism
Task,EDAM-T033,Deterministic envelope_id,EDAM-S7,P0,1,cce-builder;risk-determinism
Task,EDAM-T034,Attribution correlation,EDAM-S7,P1,2,cce-builder;risk-attribution;inv-honesty
Task,EDAM-T035,Compute event_hash,EDAM-S7,P0,1,cce-builder;risk-scope-leak
Task,EDAM-T036,Validate + idempotency + dup detection,EDAM-S7,P0,1,cce-builder;risk-integrity
Epic,EDAM-E5,Resilience (Dead Letter Queue),,P1,,phase-1;epic;dlq
Story,EDAM-S8,Poison-record quarantine,EDAM-E5,P1,5,dlq
Task,EDAM-T037,DLQ store schema,EDAM-S8,P1,2,dlq;risk-privacy
Task,EDAM-T038,Quarantine API + alarm,EDAM-S8,P1,1,dlq;risk-completeness
Task,EDAM-T039,Inspection/replay tooling,EDAM-S8,P2,1,dlq
Task,EDAM-T040,DLQ depth metric + alert,EDAM-S8,P1,1,dlq;risk-completeness
Epic,EDAM-E6,Test Conformance & Determinism,,P0,,phase-1;epic;qa
Story,EDAM-S9,Determinism rig & conformance harness,EDAM-E6,P0,13,qa;conformance
Task,EDAM-T041,Two-target determinism rig,EDAM-S9,P0,3,qa;risk-determinism
Task,EDAM-T042,Conformance C-3,EDAM-S9,P0,2,qa;risk-contract-drift
Task,EDAM-T043,Conformance C-4 & C-5,EDAM-S9,P0,2,qa;risk-integrity
Task,EDAM-T044,Conformance C-6,EDAM-S9,P0,2,qa;risk-integrity
Task,EDAM-T045,Conformance C-7 & C-8,EDAM-S9,P0,2,qa;risk-integrity;inv-honesty
Task,EDAM-T046,Conformance C-10,EDAM-S9,P1,1,qa;risk-attribution
Task,EDAM-T047,Integration & unit coverage gate,EDAM-S9,P1,1,qa;risk-reliability
Epic,EDAM-E7,Dev Environment & Enablement,,P0,,phase-1;epic;devenv
Story,EDAM-S10,Local dev stack & fixtures,EDAM-E7,P0,8,devenv
Task,EDAM-T048,Compose stack,EDAM-S10,P0,3,devenv;risk-source-config
Task,EDAM-T049,Seeded schema + traffic generator,EDAM-S10,P0,2,devenv
Task,EDAM-T050,Pinned fixtures,EDAM-S10,P0,2,devenv;risk-determinism
Task,EDAM-T051,CI two-target setup,EDAM-S10,P0,1,devenv;risk-determinism
Epic,EDAM-E8,Security & Invariant Verification,,P1,,phase-1;epic;security
Story,EDAM-S11,Invariant & security gates,EDAM-E8,P1,5,security
Task,EDAM-T052,No-write-path proof,EDAM-S11,P0,2,security;inv-no-write
Task,EDAM-T053,Masking & log-hygiene audit,EDAM-S11,P1,1,security;risk-privacy
Task,EDAM-T054,Honesty-path verification,EDAM-S11,P1,1,security;inv-honesty
Task,EDAM-T055,Sprint security review sign-off,EDAM-S11,P1,1,security
```

---

## 10. GitHub Issue Labels

| Label | Color (suggested) | Meaning |
|---|---|---|
| `epic` | purple | Epic-level issue |
| `story` | blue | User story |
| `task` | gray | Development task |
| `phase-1` | green | Sprint 1 / Phase 1 scope |
| `priority:P0` | red | Blocker / critical path |
| `priority:P1` | orange | Sprint-critical |
| `priority:P2` | yellow | Parallelizable / optional |
| `area:canonical` | teal | canonical package |
| `area:contracts` | teal | contracts package |
| `area:cdc` | teal | CDC Collector |
| `area:attestation` | teal | Attestation Monitor |
| `area:completeness` | teal | Completeness Watcher |
| `area:normalization` | teal | Normalization Service |
| `area:cce-builder` | teal | CCE Builder |
| `area:dlq` | teal | Dead Letter Queue |
| `area:qa` | teal | Test/conformance |
| `area:devenv` | teal | Dev environment |
| `area:security` | teal | Security/invariants |
| `risk:determinism` | dark-red | Determinism risk |
| `risk:completeness` | dark-red | Missed-event risk |
| `risk:integrity` | dark-red | Tamper/ordering risk |
| `risk:privacy` | dark-red | Sensitive-data risk |
| `risk:security` | dark-red | Trust-boundary risk |
| `risk:source-config` | dark-red | Replica config risk |
| `risk:attribution` | dark-red | Actor-attribution risk |
| `risk:vendor` | dark-red | MySQL/MariaDB quirks |
| `risk:contract-drift` | dark-red | Schema divergence |
| `risk:scope-leak` | dark-red | Phase-2 creep |
| `inv:no-write` | black | Invariant: no DB write path |
| `inv:honesty` | black | Invariant: no fabrication |
| `conformance` | green | Tied to a CCE conformance test |
| `blocked` | light-gray | Waiting on a dependency |
| `good-first-task` | light-green | Low-coupling starter task |

---

## 11. Definition of Ready (DoR)

A task may enter a sprint only when:

1. **Traceable:** links to the Sprint 1 plan task (S1-*) and any CCE clause / conformance test it implements.
2. **Acceptance criteria** are written, objective, and testable.
3. **Dependencies** are identified and either Done or scheduled earlier.
4. **Estimate** assigned (SP) and priority set.
5. **No frozen-spec change required** — if a task seems to need a contract change, it is escalated, not silently scoped in.
6. **Test approach known** (which unit/integration/conformance test will prove it).
7. **Owner role** identified (BE/DE/QA/Sec/DevOps).
8. **Risk tags** applied; any `inv:*` task has an explicit verification method.

---

## 12. Definition of Done (DoD)

A task is Done when (inheriting Sprint 1 plan §17):

1. Code + tests merged to monorepo main with required reviews (CODEOWNERS on `canonical`/`contracts`).
2. Unit + integration tests green; relevant conformance case green through the live pipeline.
3. For determinism-tagged tasks: identical canonical bytes / `event_hash` / `envelope_id` on **two OS/arch targets** in CI.
4. Invariants verified where applicable: `inv:no-write` (no Kafel write credential), `inv:honesty` (DEGRADED/gap/unattributed produced on negative fixtures).
5. Honesty/resilience paths demonstrated (downgrade→alarm, gap→alarm, poison→DLQ).
6. Every emitted CCE validates against frozen `contracts`; invalid fixtures fail with expected rule ids.
7. No scope leakage into Phase 2 (no WORM sealing/anchoring/projection-query/risk/alert/reversal logic).
8. Observability present for the task's signals (lag, gap, fidelity state, DLQ depth as applicable).
9. Docs/runbook updated; frozen specs untouched.

**Sprint DoD:** all Epics' P0/P1 stories Done, acceptance criteria **A1–A11** pass, **M1–M5** milestones reached, and critical-path conformance (C-6) + determinism rig green.

---

## 13. Implementation Order (execution sequence)

1. **Start immediately, in parallel (day 1):**
   - `EDAM-T048` (compose stack) + `EDAM-T051` (CI two-target) — unblocks everything.
   - `EDAM-T001 → T002` (canonical) — the determinism keystone.
   - `EDAM-T010 → T011 → T012` (CDC creds → connector → offsets).
2. **Next:**
   - `EDAM-T003, T005` (canonical helpers) and `EDAM-T006 → T007 → T009` (contracts).
   - `EDAM-T013` (handoff), `EDAM-T037` (DLQ store), `EDAM-T017→T019` (attestation), `EDAM-T021→T023` (completeness).
   - `EDAM-T041` (determinism rig) as soon as T002 lands.
3. **Then (normalization → build):**
   - `EDAM-T025 → T026 → T027` (normalize + honesty stamp + op mapping); `EDAM-T028` (poison path, needs T037).
   - `EDAM-T029 → T030 → T031 → T032 → T033` then `T034`, then `T035 → T036` (the convergence chain).
4. **Then (prove it):**
   - `EDAM-T042 → T043 → T044 → T045 → T046` conformance; `EDAM-T050` pinned fixtures; `EDAM-T047` CI gate.
5. **Close-out:**
   - `EDAM-T052` (started early) finalized; `EDAM-T053 → T054 → T055` security sign-off.
   - Verify acceptance A1–A11 and milestones M1–M5.

> Sequencing rationale (from the plan §16): canonical first (determinism gates all), attestation/completeness before normalization (CCEs must carry truthful fidelity from the first event), and the build chain is intentionally sequential through to `event_hash` + validation.

---

*End of Sprint 1 Backlog. Tracking artifact only — no production code; no existing documents modified. Derived solely from the frozen Sprint 1 Implementation Plan.*
