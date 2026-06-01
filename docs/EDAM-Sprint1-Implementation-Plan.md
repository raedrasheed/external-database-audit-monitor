# EDAM Sprint 1 — Implementation Plan
### Phase 1: Ingestion + CCE Foundation

> **Document class:** Sprint/implementation plan (actionable tasks). It introduces **no** new specifications or architecture; it operationalizes **Phase 1** of `docs/EDAM-Phase0-Engineering-Blueprint.md`.
> **Implementation baseline:** `EDAM-Phase0-Engineering-Blueprint.md` (§3 services, §4 repo, §5 tech, §14 Phase 1).
> **Contract baseline (frozen, do not change):** `CCE-v1-Specification.md`, `EDAM-Companion-Contracts.md`, `EDAM-WORM-Evidence-Anchoring-Spec.md`, `EDAM-Risk-Rule-Definition-Spec.md`.
> **Status:** Planning only — no production code in this document.
> **Date:** 2026-06-01.

---

## 1. Sprint Goal

Stand up the **ingestion + CCE foundation**: stream committed row changes from a MySQL/MariaDB **replica**, normalize them into deterministic **Canonical Change Events (CCE v1)** with full field-level diffs, masking, and honest fidelity/completeness/attribution metadata — and prove the result is **byte-deterministic** and **fidelity-honest**.

> **Out of this sprint:** evidence sealing/WORM, anchoring, projection DB queries, dashboard, risk rules, alerts, reversal proposals. Those are Phases 2–5. This sprint produces *complete, validated CCEs in memory / on the internal bus*, not sealed evidence.

The single hardest requirement that gates everything downstream: **two independent runs, on two machines, over the same source range, must produce byte-identical `envelope_id` and `event_hash`** (CCE §12.7, blueprint §16.3). If determinism isn't proven, the sprint is not done.

**Invariants enforced this sprint (from the baseline):**
- **INV-1** — no Kafel write credential anywhere; collector uses a **read-only** replication/SELECT user only.
- **INV-2** — no fabrication: missing before-image → `null` + `DEGRADED`; no audit match → `unattributed`.
- **INV-4** — determinism: one shared canonical serializer, identical everywhere.

---

## 2. Deliverables

| # | Deliverable | Definition of "delivered" |
|---|---|---|
| D1 | **`canonical` package** | Deterministic canonical serialization + SHA-256 hashing per CCE §12.7; passes cross-machine determinism tests. |
| D2 | **`contracts` package** | Frozen JSON Schemas (CCE v1 + companions) + validators; rejects every invalid fixture with the expected rule id. |
| D3 | **CDC Collector service** | Streams ROW+FULL binlog from replica via Debezium; tracks GTID offset; emits `CAPTURED` records to the bus. |
| D4 | **Attestation Monitor** | Samples source config (`binlog_format`, `binlog_row_image`, `gtid_mode`, `log_bin`, retention); emits config snapshots + CRITICAL alarms on downgrade. |
| D5 | **Completeness Watcher** | Tracks consumed-GTID set + heartbeat watermark; emits `gap_detected` + alarm on continuity break. |
| D6 | **Normalization Service** | Maps native records → partial CCE (`source`/`transaction`/`offset`/`fidelity`/`completeness`); quarantines poison records. |
| D7 | **CCE Builder** | Field-level diff + masking + attribution correlation + transaction grouping + deterministic `seq`/`envelope_id`; emits complete (pre-seal) CCE. |
| D8 | **Dead Letter Queue (DLQ)** | Poison/unmappable records retained with raw payload + offset + reason; never silently dropped. |
| D9 | **Conformance harness (Phase-1 subset)** | Runs CCE `C-1, C-3, C-4, C-5, C-6, C-7, C-8, C-10` against the pipeline. |
| D10 | **Local dev environment** | Docker Compose: MySQL (ROW+FULL, seeded), Debezium, internal bus, MariaDB audit feed, fixtures. |

---

## 3. Work Breakdown Structure

> Task IDs: `S1-<area>-<n>`. Effort in ideal engineer-days (see §15). "DoD" references §17.

### 3.1 `canonical` package (S1-CAN)
- **S1-CAN-1** Define the canonical serialization algorithm as executable rules: UTF-8 NFC, lexicographic key sort by code point, exact-decimal money as strings, integers as plain decimal, explicit nulls, RFC3339 UTC ms timestamps, no insignificant whitespace (CCE §12.7).
- **S1-CAN-2** Implement SHA-256 hashing over canonical bytes → `event_hash` form (`sha256:<64hex>`).
- **S1-CAN-3** Implement deterministic `UUIDv5` helper with the fixed EDAM namespace (for `envelope_id` derivation, CCE §3).
- **S1-CAN-4** Implement the hash-chain link helper `row_hash = H(prev_row_hash ‖ event_hash)` (used in later phases but defined now to freeze semantics).
- **S1-CAN-5** Cross-language/cross-machine determinism test rig (run the same fixtures on two OS/arch targets, diff bytes + hashes).
- **S1-CAN-6** Decimal/money handling: reject float inputs; exact decimal compare/format (CCE §12.8).

### 3.2 `contracts` package (S1-CON)
- **S1-CON-1** Vendor the frozen JSON Schemas (CCE v1 Appendix B; companion schemas) verbatim into the package; pin `schema_version`.
- **S1-CON-2** Build a validator API (validate object → {valid, errors[] with rule ids}).
- **S1-CON-3** Encode the **stateful** rules that JSON Schema can't (V3 envelope_id derivation, V4 seq contiguity / statement_count, V14 monotonic ingest, V15 duplicate-id/differing-hash) as validator extensions.
- **S1-CON-4** Build the invalid-fixture set (one per V1–V15) and assert each fails with the expected rule.
- **S1-CON-5** Schema-version gate: reject unknown **major**, ignore unknown optional minor fields (CCE §9).

### 3.3 CDC Collector (S1-CDC)
- **S1-CDC-1** Provision/define a **read-only** replication+SELECT user (no writes — INV-1) and replica connectivity config.
- **S1-CDC-2** Configure Debezium MySQL/MariaDB connector for ROW+FULL+GTID; snapshot mode for initial selected tables.
- **S1-CDC-3** Offset/GTID tracking: advance offset **only after durable handoff**; persist resume position.
- **S1-CDC-4** Snapshot↔stream handoff: record GTID at snapshot start/end; resume streaming with no gap (log explicit handoff event).
- **S1-CDC-5** Emit `CAPTURED` records (raw native + offset + table identity) to the internal bus.
- **S1-CDC-6** Backoff/reconnect on replica/connector errors; preserve offset; alarm on stall/lag.
- **S1-CDC-7** Treat MySQL and MariaDB as **distinct adapters** behind one interface (review caution — not "same as MySQL").

### 3.4 Attestation Monitor (S1-ATT)
- **S1-ATT-1** Periodic read-only sampler for `binlog_format`, `binlog_row_image`, `gtid_mode`, `log_bin`, `binlog_expire_logs_seconds`, `server_uuid`.
- **S1-ATT-2** Produce a `config_snapshot` (id + values) consumed by Normalization to stamp every CCE's `fidelity.source_config`.
- **S1-ATT-3** Downgrade detection → CRITICAL alarm + set stream fidelity to DEGRADED (row_image≠FULL, format≠ROW, gtid≠ON, retention below threshold).
- **S1-ATT-4** Also watch the **native audit plugin state** (loaded/logging) for attribution tamper indicators (feeds DB-Audit Event correlation).

### 3.5 Completeness Watcher (S1-CMP)
- **S1-CMP-1** Maintain consumed-GTID set; periodically read source `gtid_executed`; compute gap = source − consumed (excluding in-flight).
- **S1-CMP-2** Heartbeat watermark (Debezium heartbeat or low-rate writer table) to distinguish "idle" from "stalled."
- **S1-CMP-3** On non-empty/non-in-flight gap → set `completeness.gap_detected=true`, fidelity DEGRADED, raise alarm.
- **S1-CMP-4** Compute `snapshot_phase` (snapshot/handoff/streaming) for CCE `completeness`.

### 3.6 Normalization Service (S1-NRM)
- **S1-NRM-1** Map native Debezium event → partial CCE skeleton (`source`, `transaction`, `offset`).
- **S1-NRM-2** Attach `fidelity` (from Attestation) and `completeness` (from Watcher) to each event.
- **S1-NRM-3** Map operation types per CCE §5 (INSERT/UPDATE/DELETE/DDL/TRUNCATE) with correct before/after nullity.
- **S1-NRM-4** Poison-record path → DLQ (raw payload + offset + reason + alarm); never drop (CCE §12.11).
- **S1-NRM-5** Emit partial CCE to CCE Builder over the bus.

### 3.7 CCE Builder (S1-BLD)
- **S1-BLD-1** Field-level diff engine: per-column/path `{old,new,data_type,changed,sensitive}`; nested `path` arrays (document-ready).
- **S1-BLD-2** Sensitive-field masking from `monitored_tables.sensitive_fields` config; never emit raw sensitive values; set `masked=true`.
- **S1-BLD-3** Transaction grouping: collect change items of one source transaction into one envelope; assign contiguous `seq` from 0; set `statement_count`.
- **S1-BLD-4** Deterministic ordering: order change items by source intra-txn order; global order key `(commit_ts, offset tie-break)`.
- **S1-BLD-5** Deterministic `envelope_id` = UUIDv5(`db_id|tx_id|server_uuid`) (+`part` if size-split).
- **S1-BLD-6** Attribution correlation: join with DB-Audit Events on `connection_id`/time-window/thread/gtid → set `actor` + `attribution_confidence` (exact/probable/unattributed); `unattributed` when no match (INV-2).
- **S1-BLD-7** Compute `event_hash` over canonical core (via `canonical` package); leave chain/seal for Phase 2 but expose the value.
- **S1-BLD-8** Validate every emitted CCE against `contracts` before publishing; reject/flag on failure.
- **S1-BLD-9** Idempotency: duplicate `envelope_id` with same `event_hash` → dedupe; with **different** `event_hash` → CRITICAL integrity alarm (V15).

### 3.8 Dead Letter Queue (S1-DLQ)
- **S1-DLQ-1** DLQ store schema: raw payload, offset, source, reason, first_seen, count.
- **S1-DLQ-2** Quarantine API used by Normalization/Builder; alarm on enqueue.
- **S1-DLQ-3** Replay/inspection tooling (manual, read-only) — no auto-reprocess that could mask a gap.
- **S1-DLQ-4** Metric + alert: DLQ depth > 0 is a visible operational signal (completeness implication).

---

## 4. Repository Layout (this sprint's footprint)

Monorepo (blueprint §4). Sprint 1 touches:
```
edam/
├── packages/
│   ├── canonical/         # S1-CAN  (the determinism keystone)
│   ├── contracts/         # S1-CON  (frozen schemas + validators)
│   └── cce-model/         # CCE types/builders consumed by Normalization + Builder
├── services/
│   ├── cdc-collector/     # S1-CDC + S1-ATT + S1-CMP (collector hosts attestation+completeness)
│   ├── normalization/     # S1-NRM
│   └── cce-builder/       # S1-BLD
├── infra/dlq/             # S1-DLQ store + tooling
├── deploy/compose/        # S1 local dev environment
├── conformance/           # Phase-1 subset runners + fixtures
└── docs/                  # frozen specs (unchanged) + this plan
```
Not created this sprint: `projection/`, `risk-engine/`, `alert-service/`, `evidence-service/`, `anchoring-service/`, `dashboard-backend/`, `apps/dashboard-frontend/`.

---

## 5. Package Layout (responsibilities, not code)

| Package | Owns | Depends on | Notes |
|---|---|---|---|
| `canonical` | serialization, hashing, UUIDv5, chain-link helper, decimal handling | none | **No business logic.** Must be import-only and side-effect free for determinism. |
| `contracts` | JSON Schemas + validators + stateful-rule checks | `canonical` (for V3/V12 checks) | Schemas are copied verbatim from frozen specs; version-pinned. |
| `cce-model` | typed CCE envelope/change-item builders | `canonical`, `contracts` | Pure model; no I/O. |

Services depend on these packages but packages **never** depend on services.

---

## 6. Service Boundaries

| Service | In-scope responsibility (Sprint 1) | Explicitly NOT responsible for |
|---|---|---|
| **CDC Collector** (+Attestation +Completeness co-located) | read replica binlog, offsets, config attestation, gap/heartbeat, emit CAPTURED | normalization, diff, sealing |
| **Normalization** | native→partial CCE, attach fidelity/completeness, poison→DLQ | diff, masking, attribution, hashing |
| **CCE Builder** | diff, masking, grouping, ordering, ids, attribution, event_hash, schema validation | WORM sealing, chaining into segments, risk, projection |

Attestation + Completeness are **co-located within the Collector deployment** in Sprint 1 (they share the source connection and offset state) but are logically separate modules behind their own interfaces, so they can be split out later.

---

## 7. Interfaces Between Services

> Interfaces are defined as **message contracts on the internal bus** (blueprint §5 lightweight bus). Payloads use the frozen CCE field names; nothing here adds new contract fields.

- **I1 — `CapturedRecord`** (Collector → Normalization): `{raw_native, source{db_id,engine,server_uuid,schema,table}, offset{gtid,binlog_file,binlog_pos}, captured_at}`.
- **I2 — `ConfigSnapshot`** (Attestation → Normalization): CCE `fidelity.source_config` shape + `state` + `degraded_reason?`.
- **I3 — `CompletenessUpdate`** (Completeness → Normalization): `{consumed_offset_key, consumed_gtid_set, heartbeat_ts, gap_detected, snapshot_phase}`.
- **I4 — `PartialCCE`** (Normalization → Builder): CCE envelope with `source/transaction/offset/fidelity/completeness` + change-item skeletons (operation, object, raw before/after), no diff/attribution/evidence.
- **I5 — `DBAuditEvent`** (audit collector → Builder): `db-audit-event-1.0` records for attribution correlation (the audit collector is a thin reader this sprint; full normalization per the companion contract).
- **I6 — `CompleteCCE`** (Builder → bus / next phase): a validated, complete pre-seal CCE (`DIFFED`+`ATTRIBUTED`+`SCORED-pending`), carrying `event_hash`.
- **I7 — `DeadLetter`** (Normalization/Builder → DLQ): `{raw_payload, offset, source, reason, ts}`.

All interfaces are versioned by `schema_version` where they carry CCE/audit data; consumers reject unknown majors.

---

## 8. Database Requirements

> Sprint 1 does **not** build the queryable projection (Phase 3) and does **not** write WORM (Phase 2). It needs only the minimum persistence to track offsets and quarantine.

- **Offset/state store** — durable storage for collector resume position (GTID/binlog), snapshot-handoff markers, consumed-GTID set, heartbeat watermark. Small; can be a dedicated PostgreSQL schema or the connector's own offset backing — but EDAM owns a copy for the Completeness Watcher.
- **DLQ store** — table(s) for dead-letter records (S1-DLQ-1): raw payload (bytea/jsonb), offset, source, reason, first_seen, count. Append-only semantics; retained for investigation.
- **Config-snapshot log** — append-only record of attestation snapshots (id, values, sampled_at) so each CCE's `config_snapshot_id` resolves to real evidence later.
- **No `audit_events`/`audit_field_changes` projection tables yet** (Phase 3). CCEs this sprint live on the bus / in test sinks.
- All stores: encrypted at rest; **no monitored-DB write credentials**; least-privilege EDAM-owned credentials only.

---

## 9. Infrastructure Requirements

- **MySQL/MariaDB replica** with `binlog_format=ROW`, `binlog_row_image=FULL`, `gtid_mode=ON`, sufficient `binlog_expire_logs_seconds` (> sprint test outage budget). In dev this is a seeded container.
- **Native DB audit feed** (MariaDB Audit Plugin or equivalent) emitting to a readable location for the thin audit reader.
- **Debezium** runtime (Debezium Server or embedded) configured for the connector.
- **Internal bus** (Redis Streams or equivalent lightweight) — abstracted behind an interface so Kafka can replace it later.
- **PostgreSQL** instance for offset/DLQ/config-snapshot state (small).
- **Secret store** (Vault/KMS or dev equivalent) holding the read-only CDC credential reference.
- **CI runners** capable of running the determinism rig on **two distinct OS/arch targets** (for S1-CAN-5 / C-1 / C-6).
- No WORM/HSM/TSA needed this sprint (Phase 2).

---

## 10. Local Development Environment

Docker Compose (blueprint §11.1), Sprint-1 subset:
- `mysql` — seeded Kafel-like schema (donations, wallets, beneficiaries, campaigns, user_roles) with ROW+FULL+GTID; a script to generate INSERT/UPDATE/DELETE/DDL/TRUNCATE traffic.
- `mariadb-audit` (or the MySQL container's audit plugin) producing audit records.
- `debezium` — connector against the seeded DB.
- `bus` — Redis (Streams).
- `postgres` — offset/DLQ/config-snapshot state.
- `vault-dev` (or env-injected secret) — read-only CDC credential.
- Services run locally (watch mode) against the compose stack.
- **Fixture generator** — deterministic scripts that produce known transactions used by both integration and conformance tests (so expected `envelope_id`/`event_hash` are pinned).

---

## 11. Testing Strategy

### 11.1 Unit tests
- `canonical`: serialization stability for tricky inputs (unicode normalization, key ordering, decimals/money, nulls, timestamps); hashing determinism; UUIDv5 reproducibility; float-rejection (S1-CAN-1/2/3/6).
- `contracts`: each invalid fixture fails with the expected rule id; unknown major rejected; unknown minor optional ignored (S1-CON-3/4/5).
- `cce-builder`: diff correctness per operation; masking; seq contiguity; ordering; envelope_id derivation; attribution mapping incl. `unattributed`; V15 duplicate-id detection (S1-BLD-1..9).
- Normalization: operation/nullity mapping; poison→DLQ (S1-NRM-3/4).
- Attestation/Completeness: downgrade detection; gap computation; heartbeat vs idle (S1-ATT/CMP).

### 11.2 Integration tests (against compose stack)
- End-to-end: generate a known transaction on MySQL → assert a complete, schema-valid CCE emerges with correct diff, fidelity HEALTHY, completeness continuous, attribution from the audit feed.
- Multi-row transaction → one envelope, contiguous seq, `statement_count == changes.length` (C-4).
- Snapshot→stream handoff produces no gap; offset resumes correctly after collector restart.
- DLQ path: inject a malformed/unmappable event → lands in DLQ with raw payload + offset + alarm; pipeline does not stall or drop.

### 11.3 Conformance tests (CCE suite — Phase-1 subset)
Wire the pipeline to the frozen CCE conformance cases:
- **C-1** byte-stable serialization/hash across two machines.
- **C-3** INSERT/UPDATE/DELETE/DDL/TRUNCATE representations + before/after nullity.
- **C-4** multi-row transaction grouping.
- **C-5** deterministic ordering on equal `commit_ts` (offset tie-break).
- **C-6** replay idempotency (same ids/hashes) + perturbed replay flagged (V15).
- **C-7** simulated `binlog_row_image=MINIMAL` → partial/null before-image + fidelity DEGRADED + `degraded_reason`.
- **C-8** injected GTID gap → `completeness.gap_detected=true` + fidelity degraded.
- **C-10** attribution: audit present → exact/probable + `audit_event_ref`; audit disabled → `unattributed` (no fabricated identity).

> C-9 (TRUNCATE no-row-image) is covered as part of C-3's TRUNCATE case. C-11/12/13 (evidence/anchor/independent verifier) are **Phase 2** and out of this sprint.

---

## 12. Acceptance Criteria (mapped)

| # | Sprint-1 acceptance criterion | Maps to |
|---|---|---|
| A1 | INSERT/UPDATE/DELETE captured with **full before/after** on selected tables. | Blueprint §14 Phase-1; CCE C-3 |
| A2 | **Deterministic** `envelope_id`/`event_hash` byte-identical across two machines. | Blueprint §16.3; CCE C-1, C-6 |
| A3 | Multi-row transactions grouped into one envelope, seq 0..n-1, `statement_count` matches. | CCE C-4 |
| A4 | Deterministic global ordering on equal commit timestamps. | CCE C-5 |
| A5 | Simulated row-image downgrade → fidelity **DEGRADED** + reason + CRITICAL alarm (no silent green). | Blueprint §14/§16; CCE C-7 |
| A6 | Injected GTID gap → `gap_detected` surfaced + alarm. | Blueprint §14/§16; CCE C-8 |
| A7 | Attribution **honest**: exact/probable when audit present; `unattributed` when absent/disabled (never faked). | CCE C-10; INV-2 |
| A8 | Poison record → DLQ with raw payload + offset; **never dropped**; alarm raised. | Blueprint §3.2 failure mode; CCE §12.11 |
| A9 | Every emitted CCE validates against frozen `contracts`; invalid fixtures fail with expected rule ids. | CCE Appendix B; V1–V15 |
| A10 | **No Kafel write credential** exists in any Sprint-1 service or config; collector is read-only. | INV-1; Blueprint §10.3 |
| A11 | p95 commit→complete-CCE < 5s on dev load. | Blueprint §14 Phase-1 acceptance |

Sprint is **accepted** only when A1–A11 all pass on the compose stack and the determinism rig passes on two targets.

---

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Non-deterministic serialization** (map ordering, float/locale/timezone leakage) | Medium | **Critical** (breaks all later hashing/evidence) | Single `canonical` package; two-target determinism rig in CI from day one; ban floats for money; pin timestamp format. |
| Replica not actually ROW+FULL/GTID in target env | Medium | High | Attestation Monitor (S1-ATT) is built early; dev seeds enforce it; Go check before integration. |
| Binlog retention too short → snapshot/stream gap | Medium | High | Configure retention > outage budget; Completeness Watcher proves continuity; alarm. |
| MariaDB ≠ MySQL connector quirks (GTID semantics) | Medium | Medium | Distinct adapters (S1-CDC-7); test both engines separately. |
| Attribution correlation ambiguous (pooled connections) | Medium | Medium | Confidence model: ambiguous → `unattributed`; document limit; don't force a match. |
| Sensitive data leaking into logs/DLQ raw payloads | Medium | High | Masking before emit; DLQ access-controlled + encrypted; no sensitive values in logs; treat DLQ raw as sensitive. |
| Scope creep into Phase 2 (sealing/WORM) | Medium | Medium | Hard boundary: Sprint 1 ends at validated complete CCE on the bus; `row_hash` helper defined but no segments/WORM. |

---

## 14. Dependencies

**External / environment**
- Read-only replica access with ROW+FULL+GTID (provisioned by Kafel DBA — Phase 0 sign-off).
- Native DB audit feed enabled and readable.
- Secret store with the read-only CDC credential reference.
- CI with two OS/arch targets for determinism.

**Internal (ordering)**
- `canonical` (D1) blocks `contracts` stateful checks, `cce-model`, and CCE Builder hashing.
- `contracts` (D2) blocks CCE Builder validation (S1-BLD-8) and the conformance harness.
- CDC Collector (D3) blocks Normalization; Attestation/Completeness (D4/D5) block Normalization's fidelity/completeness stamping.
- Normalization (D6) blocks CCE Builder.
- DLQ (D8) is needed by Normalization + Builder failure paths.

**Frozen inputs (no work, must be honored)**
- CCE v1 §3/§4/§5/§6/§12 (identity, ordering, operations, fields, constraints); DB-Audit Event contract; conformance suite definitions.

---

## 15. Task Estimates

> Effort in **ideal engineer-days** (excludes meetings/review latency). Priority: P0 (blocker), P1 (sprint-critical), P2 (needed, parallelizable). Roles: BE=backend, DE=data/DB, Sec=security, QA.

| Task group | Tasks | Effort (d) | Priority | Depends on | Role |
|---|---|---|---|---|---|
| `canonical` | S1-CAN-1..6 | 6 | **P0** | — | BE |
| `contracts` | S1-CON-1..5 | 5 | **P0** | canonical | BE/QA |
| CDC Collector | S1-CDC-1..7 | 8 | **P0** | env access | BE/DE |
| Attestation Monitor | S1-ATT-1..4 | 4 | P1 | collector conn | BE/Sec |
| Completeness Watcher | S1-CMP-1..4 | 4 | P1 | collector offsets | BE/DE |
| Normalization | S1-NRM-1..5 | 5 | P1 | collector, att, cmp, contracts | BE |
| CCE Builder | S1-BLD-1..9 | 9 | **P0** | canonical, contracts, normalization, audit feed | BE |
| DLQ | S1-DLQ-1..4 | 3 | P1 | postgres state | BE/DE |
| Conformance harness | D9 (C-1,3,4,5,6,7,8,10) | 5 | **P0** | builder, contracts, fixtures | QA |
| Local dev env | D10 compose + fixtures | 4 | **P0** | — | DE/DevOps |
| Security review (read-only creds, masking, DLQ sensitivity, no-write proof) | — | 2 | P1 | most services | Sec |
| **Total** | | **~55 ideal-days** | | | |

For a ~4–5 person team (blueprint §15) this is roughly a **2–3 week sprint** with parallelization (see §16). Estimates are planning figures, not commitments.

**Dependency chain (critical path):** `canonical` → `contracts` → (CDC Collector ‖ fixtures/dev-env) → Normalization (needs Attestation+Completeness) → CCE Builder → Conformance harness → Acceptance (A1–A11).

---

## 16. Recommended Development Order

1. **Week 1 (foundations, parallel):**
   - Track A (P0): `canonical` (S1-CAN) → start determinism rig immediately.
   - Track B (P0): local dev env + fixtures (D10) and CDC Collector connector config (S1-CDC-1..3).
   - Track C (P0): begin `contracts` schema vendoring (S1-CON-1/2) once `canonical` stubs exist.
2. **Week 1–2:**
   - Attestation Monitor (S1-ATT) and Completeness Watcher (S1-CMP) on top of the collector.
   - Finish `contracts` stateful checks + invalid-fixture suite (S1-CON-3/4/5).
   - Normalization (S1-NRM) consuming collector + attestation + completeness; DLQ (S1-DLQ) in parallel.
3. **Week 2–3:**
   - CCE Builder (S1-BLD): diff → masking → grouping/ordering/ids → attribution → event_hash → validation.
   - Wire conformance harness (D9) case by case (C-3 → C-4/C-5 → C-1/C-6 → C-7/C-8 → C-10).
   - Security review; finalize acceptance (A1–A11) on two-target determinism.

Rationale: `canonical` first because determinism gates everything; Attestation/Completeness before Normalization because CCEs must carry truthful fidelity/completeness from the first emitted event (no retrofitting honesty).

---

## 17. Definition of Done

A task/deliverable is **Done** when:

1. **Code + tests merged** to the monorepo main line with required reviews (CODEOWNERS for `canonical`/`contracts`).
2. **Unit tests** green; **integration tests** green against the compose stack.
3. **Conformance subset** (C-1, C-3, C-4, C-5, C-6, C-7, C-8, C-10) green through the live pipeline.
4. **Determinism proven**: identical `envelope_id`/`event_hash`/canonical bytes on **two OS/arch targets** in CI.
5. **Invariants verified**: automated check that **no Kafel write credential** is present in any Sprint-1 service/config (INV-1); no fabricated attribution/fidelity (INV-2) — `unattributed`/`DEGRADED` produced on the negative fixtures; single shared `canonical` used everywhere (INV-4).
6. **Honesty paths demonstrated**: row-image downgrade → DEGRADED+alarm; GTID gap → gap_detected+alarm; poison → DLQ (not dropped).
7. **Schema validation**: every emitted CCE validates against frozen `contracts`; invalid fixtures fail with expected rule ids.
8. **No scope leakage**: no WORM sealing, no anchoring, no projection queries, no risk/alert/reversal logic introduced.
9. **Observability**: collector lag, GTID gap, fidelity state, DLQ depth exposed as metrics with alarms.
10. **Docs**: README/runbook for the dev env and the Sprint-1 services; the frozen specs remain unmodified.

**Sprint-level DoD:** all of D1–D10 Done, acceptance criteria **A1–A11** pass, and the critical-path conformance + determinism gates are green — leaving a foundation on which Phase 2 (evidence + anchoring) can seal CCEs without revisiting identity, ordering, or hashing.

---

*End of Sprint 1 Implementation Plan. Planning only — no production code. All prior specifications and the Engineering Blueprint remain unmodified; this plan operationalizes Phase 1 and preserves the frozen invariants.*
