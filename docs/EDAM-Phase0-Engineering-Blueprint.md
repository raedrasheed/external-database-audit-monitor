# EDAM Phase 0 — Engineering Blueprint
### Translating the frozen architecture & contracts into an implementation-ready plan

> **Document class:** Engineering plan (not a specification). It introduces **no** new contracts, schemas, DSLs, or architecture; it decomposes the frozen baseline into services, repos, APIs, infra, milestones, and acceptance criteria.
> **Authoritative (frozen) baseline:**
> `External-Database-Audit-Monitor-Plan.md`, `EDAM-Architecture-Review.md`, `EDAM-v2-Architecture.md`, `CCE-v1-Specification.md`, `EDAM-Companion-Contracts.md`, `EDAM-WORM-Evidence-Anchoring-Spec.md`, `EDAM-Risk-Rule-Definition-Spec.md`.
> **Status:** Planning only — no production code, no implementation.
> **Date:** 2026-06-01.

---

## 1. Executive Summary

This blueprint converts the approved EDAM v2 architecture into a buildable engineering plan for the **lean, evidence-grade MVP**: read-only monitoring of **MySQL/MariaDB**, field-level change capture as **Canonical Change Events (CCE v1)**, immutable **WORM evidence with externally-anchored, HSM-signed chain heads from day one**, a declarative **risk rule** layer, alerting, and a **real-time dashboard** — with **no write path to the monitored database** (no Change Execution Service in MVP; reversals are *proposal-only*).

The engineering north star is the set of frozen invariants, carried verbatim from the specs:

- **INV-1 — EDAM never writes to the monitored database.** No service in MVP holds a Kafel write credential.
- **INV-2 — No fabrication.** Unknown attribution → `unattributed`; degraded data → `INDETERMINATE`/`DEGRADED`; unverifiable → failure. Never guess.
- **INV-3 — Append-only + WORM.** Evidence is immutable and externally verifiable; PostgreSQL is a rebuildable projection.
- **INV-4 — Determinism.** Shared canonical serialization/hashing (CCE §12.7) across every service.

The MVP must be *provably complete and tamper-evident* before it is feature-rich. Anything that cannot be delivered with those invariants intact is deferred.

**Build sequencing (high level):** ingestion + CCE first → evidence/anchoring second (must exist at MVP) → projection + dashboard → risk/alerts → reversal *proposals*. This mirrors EDAM v2's roadmap phases 1–5 (phases 6–8 — CES, PostgreSQL source, enterprise hardening — are explicitly post-MVP).

---

## 2. System Context Diagram

```
                          ┌──────────────────────────────────────────────┐
                          │ DOMAIN A — MONITORED (Kafel; untouched)        │
                          │  MySQL/MariaDB primary ──► replica (ROW+FULL)  │
                          │  Native DB audit feed (MariaDB Audit Plugin)   │
                          │  live source-config (read-only)                │
                          └───────────┬───────────────────┬───────────────┘
                       binlog (RO)    │    audit log (RO)  │  config sample (RO)
                                      ▼                    ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │ DOMAIN B — EDAM AUDIT CORE                                                       │
   │                                                                                 │
   │  CDC Collector ─► Normalization ─► CCE Builder ─┬─► Risk Engine ─► Alert Service │
   │       │ (+ Attestation/Completeness)            │                      │        │
   │       │                                         ├─► Evidence Service ──┼──┐      │
   │       │                                         └─► Projection Service │  │      │
   │  (internal bus)                                          │            │  │      │
   │                                              ┌───────────▼──┐   ┌─────▼──▼────┐  │
   │                                              │ PostgreSQL    │   │ Dashboard   │  │
   │                                              │ projection    │◄──┤ Backend(API │  │
   │                                              └───────────────┘   │ +WebSocket) │  │
   │                                                                  └──────┬──────┘  │
   └─────────────────────────────────────────────────────────────────────── │ ───────┘
                                                                              ▼
                                                                   Dashboard Frontend (SPA)
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │ DOMAIN C — EVIDENCE (custody)        EXTERNAL ANCHOR            INDEPENDENT      │
   │  WORM object store (Object Lock)     RFC 3161 TSA /             VERIFIER         │
   │  HSM signing (non-exportable) ◄──── transparency log / ───►    (auditor: WORM   │
   │  Anchoring Service requests          dual-custodian             read + pubkeys   │
   │  signatures + external tokens                                   + spec only)     │
   └───────────────────────────────────────────────────────────────────────────────┘

   (DOMAIN D — Change Execution Service: DESIGNED, NOT BUILT IN MVP. No write path exists.)
```

---

## 3. Service Decomposition (MVP)

Each service below is independently deployable, owns its failure handling, and communicates over the internal bus or typed HTTP/gRPC. All consume/produce the frozen contracts.

### 3.1 CDC Collector
- **Responsibility:** Stream committed row changes from the MySQL/MariaDB **replica** (Debezium connector). Also runs the **Source-Configuration Attestation** sampler and **Completeness/heartbeat** watcher (EDAM v2 §4). Tracks offset (GTID).
- **Inputs:** binlog (ROW+FULL) via replication; periodic source-config reads; native audit feed handle.
- **Outputs:** raw native change records + offset + fidelity/attestation context onto the internal bus (`CAPTURED` stage, CCE §2).
- **Dependencies:** replica connectivity; secret store for read-only creds; bus.
- **Failure modes:** connector lag/stall (alarm; do not advance offset); binlog retention expiry before consumption (completeness alarm); config downgrade detected (CRITICAL fidelity alarm); replica unreachable (reconnect w/ backoff; offset preserved).

### 3.2 Normalization Service
- **Responsibility:** Map engine-native records into the **CCE skeleton** (`NORMALIZED` stage); attach `source`, `transaction`, `offset`, `fidelity`, `completeness`. One normalizer per engine (MySQL/MariaDB share the family but are treated as distinct adapters per the review).
- **Inputs:** raw `CAPTURED` records.
- **Outputs:** partial CCE (no diff/attribution/evidence yet).
- **Dependencies:** CDC Collector; CCE v1 contract.
- **Failure modes:** unmappable/poison record → **quarantine to dead-letter** with raw payload + offset + alarm (never drop — completeness, CCE §12.11).

### 3.3 CCE Builder
- **Responsibility:** Complete the CCE: **field-level diff** (`DIFFED`), sensitive-field **masking**, **attribution correlation** with DB-Audit Events (`ATTRIBUTED`), transaction grouping, deterministic ordering, deterministic `envelope_id`. Hands sealed-ready CCE to Risk + Evidence + Projection.
- **Inputs:** partial CCE; correlated DB-Audit Events.
- **Outputs:** complete CCE (pre-seal) with `actor.attribution_confidence`; emits to Risk Engine, Evidence Service, Projection Service.
- **Dependencies:** Normalization; native-audit correlation data; CCE v1 + DB-Audit Event contracts.
- **Failure modes:** missing before-image under degraded fidelity → emit with `DEGRADED` + null before (no fabrication); no audit match → `unattributed`; non-deterministic serialization bug → caught by determinism conformance (must fail CI, not prod).

### 3.4 Projection Service
- **Responsibility:** Maintain the **PostgreSQL projection** (rebuildable, WORM-authoritative). Write audit_events / audit_field_changes / indices; serve nothing authoritative — query convenience only. Runs drift detection vs WORM.
- **Inputs:** complete CCEs; (rebuild) WORM segments.
- **Outputs:** queryable rows for Dashboard Backend.
- **Dependencies:** PostgreSQL; Evidence Service (for hashes/rebuild).
- **Failure modes:** projection drift vs WORM → degrade banner + rebuild; PG outage → dashboard read-degraded, ingestion/evidence continue (PG is not on the evidence critical path).

### 3.5 Risk Engine
- **Responsibility:** Evaluate **Risk Rules** (frozen DSL) over CCEs and window buckets; produce `RuleEvaluationResult`s and per-event/actor scores (`SCORED`). MVP uses the small hard-coded-as-data starter rule set.
- **Inputs:** complete CCEs; enabled rules; bounded read-only projection lookups for cross-table rules.
- **Outputs:** evaluation results (FIRED/NOT_FIRED/INDETERMINATE) → Alert Service + projection; `triggered_rules`/`risk_score` onto CCE.
- **Dependencies:** Risk Rule spec; Projection (read-only, bounded) for cross-table.
- **Failure modes:** lookup timeout → `INDETERMINATE` (no guess); rule grammar/regex safety violations rejected at load; never originates a reversal or write (INV-1).

### 3.6 Alert Service
- **Responsibility:** Convert FIRED results into deduplicated, rate-limited **Alerts**; manage alert lifecycle (open/ack/resolved/dismissed); route notifications (email/webhook in MVP) with **masked** content.
- **Inputs:** rule evaluation results.
- **Outputs:** alerts (projection + WORM-compatible); notifications.
- **Dependencies:** Risk Engine; notification channels.
- **Failure modes:** notification channel down → retry/queue; dedupe key collision → increment occurrence (no duplicate storms); never send unmasked sensitive data.

### 3.7 Evidence Service
- **Responsibility:** Seal CCEs (and later results/audit events) into the **hash chain** and **WORM** objects; group into **segments**; build **segment manifests**; compute `event_hash`/`row_hash`/`segment_hash` (`SEALED`). Owns the WORM append-only writer identity (Domain C boundary). Runs the **daily verifier**.
- **Inputs:** complete CCEs (sealed-ready).
- **Outputs:** WORM objects + manifests; chain heads for anchoring; verification reports.
- **Dependencies:** WORM object store; canonical serialization (shared lib); Anchoring Service.
- **Failure modes:** WORM write failure → halt sealing for that segment, retry, do not lose offset (CRITICAL if persistent); manifest/hash mismatch on verify → `VERIFICATION_FAILED` (terminal, incident).

### 3.8 Anchoring Service
- **Responsibility:** Take sealed chain heads → request **HSM signature** → obtain **external anchor** (RFC 3161 TSA primary; transparency-log/dual-custodian as configured) → write immutable **Anchor Records** (`ANCHORED`). Enforces bounded un-anchored window.
- **Inputs:** chain heads from Evidence Service.
- **Outputs:** anchor records in WORM.
- **Dependencies:** HSM (Domain C key custody); external anchor provider; WORM.
- **Failure modes:** HSM failure → stay `ANCHOR_PENDING` + alarm (never ANCHORED without verified token); TSA outage → queue + escalating alarm + optional failover; never fabricate a token.

### 3.9 Dashboard Backend
- **Responsibility:** REST + WebSocket/SSE API for the SPA: live change feed, event detail + diff, alerts, evidence search, risk results, verification reports. Enforces **Auth + RBAC + MFA**, IP allowlist, masked-by-default reads with audited reveal.
- **Inputs:** projection reads; live events; auth tokens.
- **Outputs:** API responses; live stream.
- **Dependencies:** Projection Service; Auth; Evidence Service (verification/export reads).
- **Failure modes:** PG degraded → serve degraded banner; auth provider down → deny (fail closed); reveal without permission → denied + logged.

### 3.10 Dashboard Frontend
- **Responsibility:** React/Vite SPA: Overview, Live Changes + diff viewer, Suspicious Activity Center, Integrity Verification, Reversal *proposal* center (propose-only), Configuration. i18n (Arabic/English, RTL/LTR), dark/light (per v1 UX; can be staged).
- **Inputs:** Dashboard Backend API + live stream.
- **Outputs:** operator UI.
- **Dependencies:** Dashboard Backend.
- **Failure modes:** stream disconnect → reconnect + "live/paused" indicator; empty/loading/degraded states per UX spec.

---

## 4. Repository Strategy

### 4.1 Monorepo vs Polyrepo

| Factor | Monorepo | Polyrepo |
|---|---|---|
| Shared contracts (CCE, directive, evidence, rules) | ✅ single source of truth, atomic changes | ❌ version-skew risk across repos |
| Determinism (shared canonical serializer must be byte-identical everywhere) | ✅ one shared library, one test suite | ❌ drift across copies — fatal for hashing |
| MVP team size (3–5) | ✅ low coordination overhead | ❌ overhead heavy for small team |
| Independent deploy cadence | ⚠️ achievable with CI path filters | ✅ native |
| Blast radius / access control | ⚠️ needs CODEOWNERS discipline | ✅ per-repo |

### 4.2 Recommendation: **Monorepo**
The decisive factor is **INV-4 determinism**: the canonical serialization + hashing library MUST be byte-identical across CDC/CCE/Risk/Evidence. A monorepo makes that one package with one conformance suite, with atomic cross-service changes when a contract evolves. Independent deploys are handled via CI path filters and per-service pipelines. Keep the (separate, eventual) **Change Execution Service in its own repository** when it is built — it lives in a different trust domain (Domain D) and must not share build/deploy identity with the audit core.

### 4.3 Proposed structure (illustrative, not prescriptive of code)
```
edam/                      (monorepo — Domains B + C tooling)
├── packages/
│   ├── contracts/         JSON Schemas (frozen specs) + validators, versioned
│   ├── canonical/         shared deterministic serialization + hashing (the keystone)
│   ├── cce-model/         CCE types/builders (no engine code)
│   └── evidence-model/    manifest/anchor/report/export types
├── services/
│   ├── cdc-collector/
│   ├── normalization/
│   ├── cce-builder/
│   ├── projection/
│   ├── risk-engine/
│   ├── alert-service/
│   ├── evidence-service/
│   ├── anchoring-service/
│   └── dashboard-backend/
├── apps/
│   └── dashboard-frontend/
├── deploy/                docker-compose (dev), k8s manifests (later), env config
├── conformance/           C-* / RD-ER-AE-XC-* / WV-* / RR-* fixtures + runners
└── docs/                  (the frozen specs live here)
```

---

## 5. Technology Decisions

| Layer | Recommendation | Why (tied to baseline) |
|---|---|---|
| **Backend framework** | **NestJS (Node.js/TypeScript)** | Strong module/DI for the adapter pattern; first-class WebSocket/SSE for the live feed; one language shared with the frontend and the determinism-critical canonical library (single implementation reduces hash-drift risk). EDAM v2 §5 already selected it. |
| **Frontend framework** | **React + Vite + TypeScript** | Per v1/v2; i18n + RTL + dark/light; TanStack Query for API state. |
| **Database (projection)** | **PostgreSQL** | Rebuildable projection; JSONB for before/after; partitioning by month; strong constraints for append-only grants. *Not* the system of record. |
| **CDC tooling** | **Debezium (MySQL/MariaDB connector)** on the replica | Mature, normalizes before/after, offset/GTID management. Native fallback only if needed. |
| **Queue / event bus (MVP)** | **Lightweight internal bus** — Debezium Server / direct sink → in-process or **Redis Streams** between services; **defer Kafka/Redpanda** to ≥2 sources or real throughput (review/v2 simplification). | Avoids running a heavy distributed log for one source at MVP volume; keeps ops small. Bus interface abstracted so Kafka can drop in later. |
| **Authentication** | **OIDC provider + TOTP MFA**; WebAuthn for high-value actions (reversal *proposal approval* path); **defer Keycloak/full SSO** | v2 §7: single OIDC + TOTP is enough for MVP; WebAuthn where the contracts demand phishing-resistance. |
| **Secret management** | **Vault** (or cloud KMS/Secrets Manager) — store *references*, not secrets | Read-only CDC creds + (future) dynamic creds; HSM-signing keys are separate (Domain C). |
| **Object storage (WORM)** | **S3 Object Lock (compliance mode)** or Azure Immutable Blob / GCS Bucket Lock | Evidence system of record; immutability enforced by the backend, not app logic (WORM spec §4). |
| **Signing / anchoring** | **HSM/KMS for non-exportable keys** + **RFC 3161 TSA** (primary), transparency-log/dual-custodian as alternates | WORM spec §8–9; keys custodied by Domain C, not EDAM operators. |
| **Logging** | **Structured JSON logs → Loki** (or equivalent) | Correlatable, queryable; no sensitive values in logs. |
| **Monitoring** | **Prometheus + Grafana**; **OpenTelemetry** traces | NFR §13; first-class lag/anchor/slot metrics. |

---

## 6. MVP Scope

### 6.1 Included
- MySQL/MariaDB **read-only** monitoring of a **selected set of sensitive/financial tables**, off a **replica** (ROW + FULL).
- **Source-config attestation + completeness/heartbeat** watchers (non-optional — integrity backbone).
- **Native DB audit** ingestion (MariaDB Audit Plugin or equivalent) + CCE attribution correlation.
- **CCE v1** build pipeline (diff, masking, ordering, deterministic ids).
- **WORM evidence + hash chain + HSM-signed, externally-anchored heads** + daily verifier + **independent-verifier** capability (kept from day one).
- **PostgreSQL projection** (query/filter only).
- **Risk Engine** with a starter rule set (data-authored): donation-amount-after-approval, wallet-balance-edit, beneficiary-delete-with-balance, delete-on-financial-table, plus the fidelity rules (downgrade/gap).
- **Alert Service** (dedupe, email/webhook, masked content).
- **Dashboard:** Overview + Live Changes + diff viewer + Suspicious Activity Center + Integrity Verification; **reversal proposal creation + approval workflow (propose-only, no execution)**.
- Auth: OIDC + TOTP, RBAC, IP allowlist, mTLS between services.

### 6.2 Excluded (deferred, with reason)
| Excluded | Why |
|---|---|
| **Change Execution Service / any DB write path** | MVP is propose-only; CES is Domain D, post-MVP (v2 Phase 6). **No Kafel write credential exists in MVP.** |
| **Kafka/Redpanda, OpenSearch, Keycloak** | Overkill at one-source MVP volume; introduce at scale (v2 §7). |
| **PostgreSQL/SQL Server/Oracle/Mongo as sources** | MySQL/MariaDB first; other engines post-MVP (v2 Phase 7). |
| **AI/UEBA** | Static, explainable rules first. |
| **Full compliance reporting packs, SIEM egress, forensic replay** | Enterprise hardening (v2 Phase 8). |

---

## 7. Database Design (high-level, projection only)

> PostgreSQL is the **rebuildable projection**; WORM is authoritative. Append-only tables have `UPDATE/DELETE` revoked from the app role; partition large tables by month on `commit_ts`. Schemas below are high-level; exact columns follow the frozen contracts.

- **Audit tables**
  - `audit_events` — one row per CCE change item / envelope projection: ids, db/table, operation, pk, tx/offset, actor + attribution_confidence, fidelity state, risk_score, triggered_rules, row_hash (convenience), worm_object_key.
  - `audit_field_changes` — per-field diff: event_id, path, old, new (masked), data_type, sensitive flags.
- **Evidence metadata tables**
  - `evidence_segments` — segment_id, sequence, opened/sealed_at, event_count, first/last row_hash, manifest_hash, segment_hash, state.
  - `anchor_records` — anchor_id, head, hsm signature metadata (key id/algorithm), provider type, created_at.
  - `verification_reports` — report runs, scope, overall_result, per-check results.
- **Alert tables**
  - `alerts` — alert_id, rule code/version, severity, score, status, subject, dedupe_key, first/last_seen, occurrence_count, routing.
- **Rule tables**
  - `risk_rules` — rule_id, code, rule_version, status, category, definition (frozen DSL), severity, score, signed_hash, provenance.
  - `rule_evaluation_results` — result_id, rule ref + signed_hash, subject, outcome, score/severity, matched_conditions, fidelity_context, evaluated_at.
- **Identity/config**
  - `monitored_databases`, `monitored_tables` (sensitive_fields, is_financial), `users/roles/permissions`, `system_settings`, `admin_audit_log` (append-only), `chain_of_custody` (append-only access/export log).

---

## 8. API Design (endpoint inventory only)

> All endpoints behind Auth + RBAC + IP allowlist; reads masked by default; reveal is permissioned + custody-logged. No endpoint can trigger a monitored-DB write.

**Dashboard / live**
- `GET /api/overview` — KPI counters, DB status, top tables, high-risk users.
- `WS /api/stream/changes` — live CCE feed (filterable).
- `GET /api/events` — list/filter (db/table/user/operation/severity/date).
- `GET /api/events/{envelope_id}` — event detail + field diff.

**Alerts**
- `GET /api/alerts` — list/filter by status/severity/category.
- `GET /api/alerts/{id}` — detail (triggered rules, recommended action).
- `POST /api/alerts/{id}/acknowledge` · `POST /api/alerts/{id}/resolve` · `POST /api/alerts/{id}/dismiss`.

**Evidence search**
- `GET /api/evidence/segments` · `GET /api/evidence/segments/{segment_id}` (manifest).
- `GET /api/evidence/objects/{envelope_id}` — WORM object reference + hashes.
- `POST /api/evidence/export` — build an Evidence Export Package (custody-logged).

**Risk results**
- `GET /api/risk/results` — evaluation results (filter by rule/outcome/subject).
- `GET /api/risk/rules` — rule inventory (versions, status).

**Verification reports**
- `GET /api/verification/reports` · `GET /api/verification/reports/{id}`.
- `POST /api/verification/run` — trigger an on-demand verification (admin).

**Reversal proposals (propose-only; NO execution endpoint in MVP)**
- `POST /api/reversal-proposals` — create a *proposal* from an event.
- `GET /api/reversal-proposals/{id}` — preview (SQL/operation preview, drift fields).
- `POST /api/reversal-proposals/{id}/approve` — record approval (four-eyes), WebAuthn.
- *(No `/execute` endpoint exists in MVP — there is no write path.)*

**Auth/admin**
- `POST /api/auth/login` (OIDC) · `POST /api/auth/mfa` · `GET /api/me`.
- `GET/POST /api/admin/databases|tables|rules|users` (RBAC-gated, audited).

---

## 9. Event Flow (MySQL → Dashboard)

```
1. MySQL/MariaDB commit on a monitored table (replica receives via replication).
2. CDC Collector reads the ROW+FULL binlog event (GTID offset advances only after durable handoff).
   ├─ Attestation sampler confirms binlog_format=ROW, row_image=FULL, gtid_mode=ON
   │  → stamps fidelity context; any downgrade ⇒ DEGRADED + CRITICAL alarm.
   └─ Completeness watcher updates consumed-GTID set + heartbeat.
3. Normalization Service maps native → partial CCE (source/transaction/offset/fidelity/completeness).
4. CCE Builder:
   ├─ computes field-level diff (old→new), applies sensitive masking,
   ├─ correlates with DB-Audit Event(s) → actor + attribution_confidence,
   ├─ groups by transaction, assigns deterministic seq + envelope_id (UUIDv5).
5. Fan-out of the complete CCE:
   ├─ Risk Engine evaluates rules (+bounded projection lookups) → RuleEvaluationResults
   │     → FIRED results → Alert Service (dedupe → alert + masked notification).
   ├─ Evidence Service seals CCE: event_hash → row_hash chain → WORM object → segment;
   │     on segment cap/time → SEALED manifest → chain head → Anchoring Service
   │     (HSM sign → RFC3161 token → ANCHORED anchor record).
   └─ Projection Service writes audit_events/field_changes + indices (rebuildable copy).
6. Dashboard Backend pushes the event over WS to the live feed; serves detail/diff/alerts
   from the projection; Integrity screen reflects chain/anchor/verification status.
   p95 target commit → dashboard visibility < 5s.
```

---

## 10. Security Boundaries

### 10.1 Trust domains (from EDAM v2 §1)
- **A — Monitored (Kafel):** owned by Kafel DBA/ops. Read-only egress only (binlog, audit feed, config). EDAM cannot write here.
- **B — EDAM Audit Core:** all MVP services. Holds **read-only** source credentials and an **append-only WORM writer** identity. **No Kafel write credential.**
- **C — Evidence/Custody:** WORM bucket + HSM signing key (non-exportable) + anchoring. Retention/legal-hold changes dual-controlled. Separate identity from B operators.
- **D — Execution:** **not built in MVP.** When built, separate repo + trust domain + operators; only it ever holds (short-lived, dynamic) Kafel write creds.

### 10.2 Service-to-service authentication
- **mTLS** between all B services and to WORM/HSM/anchor (SPIFFE-style service identities).
- Internal bus access scoped per service; least privilege.
- Dashboard Backend ↔ Frontend over TLS; user auth via OIDC + TOTP (WebAuthn for proposal approval).
- Fail-closed: if auth/identity infra is unavailable, deny.

### 10.3 Credential ownership
| Credential | Owner | Scope |
|---|---|---|
| MySQL read-only replication/SELECT | Domain B (CDC Collector) via Vault | replica, read-only |
| Native audit feed read | Domain B | read-only |
| WORM append-only writer | Domain B (Evidence Service) | PutObject only; no delete/overwrite/retention |
| WORM retention/legal-hold admin | Domain C (dual-control) | retention/hold only |
| HSM signing key | Domain C (non-exportable) | sign heads; B can request, not extract |
| **Kafel write credential** | **none in MVP** | — |

---

## 11. Infrastructure Topology

### 11.1 Development
- **Docker Compose:** MySQL (with seeded sample Kafel-like schema + binlog ROW/FULL), Debezium, internal bus (Redis), PostgreSQL, MinIO with object-lock (WORM stand-in), a software HSM/KMS emulator + test TSA, all B services, dashboard.
- Single host; ephemeral; seed + fixture data for conformance suites.

### 11.2 Staging
- Kubernetes (or Compose-on-VM) mirroring prod topology at smaller scale; **real** WORM (cloud Object Lock), real HSM/KMS, real TSA. This is where reversal-*proposal* flows and four-eyes are validated end-to-end (no execution).
- Synthetic load for lag/throughput SLO validation; chaos tests for failure scenarios (§13).

### 11.3 Production
- **Containers:** each B service horizontally scalable; Evidence/Anchoring carefully sized (sealing/anchoring throughput); Dashboard Backend behind a gateway.
- **Storage:** PostgreSQL (HA, partitioned, encrypted, object-locked backups) as projection; **WORM object store (compliance mode), geo-replicated** as system of record; Redis for cache/counters/sessions.
- **Networking:** B in a private network; egress to Kafel replica restricted/allowlisted; dashboard/API behind IP allowlist + WAF; mTLS internally; no inbound path from Kafel into B beyond the read feeds.
- **Backups:** projection backups encrypted + object-locked; WORM is primary and geo-replicated with hash-verified replicas; documented retention; restore drills include a full §10 (WORM spec) verification at the DR site.

---

## 12. Observability

- **Logs:** structured JSON, correlation ids per CCE/segment; **never** log sensitive values; admin/auth/reveal actions to append-only audit.
- **Metrics (first-class):** CDC connector lag, replica lag, consumed-GTID gap, ingest p95, **un-anchored window age**, sealing throughput, WORM write success rate, HSM sign latency/errors, TSA success/latency, projection drift count, rule eval latency, alert volume by severity, WS connections.
- **Traces:** OpenTelemetry across collector → normalization → CCE builder → fan-out → evidence/anchor.
- **Health checks:** per-service `liveness`/`readiness`; pipeline health = (collector connected) ∧ (fidelity HEALTHY) ∧ (un-anchored window < threshold) ∧ (no VERIFICATION_FAILED).
- **Alerts (operational, distinct from risk alerts):** fidelity DEGRADED/COMPROMISED, GTID gap, anchor outage, WORM write failure, HSM failure, projection drift, connector stall, retention misconfiguration.

---

## 13. Failure Scenarios & Recovery

| Scenario | Detection | Recovery plan |
|---|---|---|
| **CDC failure** (connector stall/replica down) | lag/heartbeat alarm | Reconnect with backoff; **offset/GTID preserved**, resume exactly; if binlog purged past offset → completeness CRITICAL + gap recorded (no silent skip); investigate retention. |
| **PostgreSQL failure** | health/read errors | Projection is non-authoritative: ingestion + evidence continue. Dashboard serves degraded banner. On recovery, resume writes; if corruption suspected, **rebuild projection from WORM**. |
| **WORM failure** (write/durability) | write error / durability check | Halt sealing for affected segment; retry with backoff; **do not advance as ANCHORED**; if persistent, CRITICAL + pause offset advancement to avoid evidence loss; never drop events. |
| **HSM failure** (signing) | sign error | Heads remain `ANCHOR_PENDING`; retry; alarm; **never mark ANCHORED without a verified signature+token**. Sealing/WORM writes continue (anchoring is decoupled & bounded). |
| **Timestamp authority outage** | TSA timeout/error | Queue anchors; backoff retry; optional failover to alternate provider/type (transparency-log/dual-custodian); escalating alarm on prolonged outage; the "when" proof is delayed, never fabricated. |
| **Queue/bus failure** | consumer/connection errors | Bounded buffering at collector; backpressure upstream; on recovery, resume from durable offset; idempotent processing (deterministic envelope_id) dedupes replays; poison events → dead-letter, never dropped. |

---

## 14. Development Roadmap (implementation phases)

> Mirrors EDAM v2 roadmap; CES/PostgreSQL-source/enterprise are post-MVP.

### Phase 1 — Ingestion + CCE foundation
- **Deliverables:** shared `canonical` + `contracts` packages; CDC Collector (MySQL/MariaDB) on replica; Attestation + Completeness watchers; Normalization; CCE Builder (diff/masking/attribution/ordering/ids); dead-letter handling.
- **Dependencies:** replica access (ROW+FULL+GTID); native audit feed; secret store.
- **Acceptance:** INSERT/UPDATE/DELETE captured with full before/after on selected tables; deterministic `envelope_id`/`event_hash` byte-stable across two machines (conformance C-1/C-6); fidelity degrades loudly on simulated row-image downgrade (C-7); GTID gap surfaced (C-8); p95 commit→CCE < 5s.

### Phase 2 — Evidence + anchoring (must exist at MVP)
- **Deliverables:** Evidence Service (hash chain, segments, manifests, WORM writer); Anchoring Service (HSM sign + RFC3161); daily verifier + **independent-verifier** tool.
- **Dependencies:** WORM (Object Lock), HSM/KMS, TSA.
- **Acceptance:** tampered object detected (WV-2); broken chain/missing object/missing segment detected (WV-3/4/9); independent verifier passes using only WORM + public keys + TSA cert + spec (WV-12); anchor outage leaves ANCHOR_PENDING, never fabricated (WV-13).

### Phase 3 — Projection + dashboard
- **Deliverables:** Projection Service + drift detection; Dashboard Backend (REST + WS, Auth/RBAC/MFA, IP allowlist, mTLS); Frontend Overview + Live Changes + diff viewer + Integrity screen.
- **Dependencies:** Phases 1–2.
- **Acceptance:** analysts see live changes with masked diff and fidelity state; projection rebuildable from WORM; drift detected and banner shown (WV-7); reveal permissioned + custody-logged.

### Phase 4 — Risk + alerts
- **Deliverables:** Risk Engine (frozen DSL subset), starter rule set as data, Alert Service (dedupe/lifecycle/notifications), Suspicious Activity Center UI.
- **Dependencies:** Phase 1 (CCEs), Phase 3 (projection for cross-table lookups + UI).
- **Acceptance:** starter rules FIRE/NOT_FIRE/INDETERMINATE correctly on fixtures (RR-3/5/6/7/8); explainable `matched_conditions`; no rule can originate a write (RR-12); masked notifications.

### Phase 5 — Reversal proposals (propose-only)
- **Deliverables:** reversal *proposal* creation + preview (SQL/operation preview + drift fields per Companion Contracts §A, but **no execution**); four-eyes approval workflow + WebAuthn; signed-proposal generation stored (not dispatched anywhere).
- **Dependencies:** Phases 1–4.
- **Acceptance:** four-eyes enforced at data layer; requester cannot approve; **no execution endpoint or write path exists**; proposals append-only and WORM-compatible.

*(Post-MVP, separate effort: Phase 6 Change Execution Service in its own repo/domain; Phase 7 PostgreSQL source; Phase 8 enterprise hardening — Kafka/OpenSearch/SSO/SIEM/forensic replay.)*

---

## 15. Team Structure (MVP → production)

| Role | MVP (build) | Production (run+grow) | Focus |
|---|---|---|---|
| **Backend engineers** | 2 | 3–4 | CDC/normalization/CCE, evidence/anchoring, risk, APIs |
| **Frontend engineer** | 1 | 1–2 | dashboard, diff viewer, i18n/RTL |
| **Security engineer** | 0.5–1 | 1 | trust domains, key custody, RBAC/MFA, threat review, conformance for security invariants |
| **DevOps/SRE** | 0.5–1 | 1–2 | infra, WORM/HSM/TSA wiring, observability, DR drills, SLOs |
| **QA engineer** | 0.5–1 | 1 | conformance suites (C-/WV-/RR-/RD-ER-AE-XC-), determinism tests, chaos/failure tests |
| **(shared) Product/Tech lead** | 0.5 | 0.5–1 | scope, acceptance, stakeholder/compliance liaison |
| **Total** | **~4–5** | **~7–10** | matches review §6 sizing |

The eventual **Change Execution Service** (post-MVP) adds a separate, dual-control ops owner in a different trust domain.

---

## 16. MVP Acceptance Criteria (objective)

MVP is **complete** when all hold on **staging with real WORM/HSM/TSA**:

1. **Capture completeness:** for the selected tables, 100% of INSERT/UPDATE/DELETE captured with full before/after; GTID continuity proven; injected gap is detected and surfaced (not swallowed).
2. **Fidelity honesty:** simulated `row_image` downgrade flips fidelity to DEGRADED with reason and raises a CRITICAL alarm; no silent green.
3. **Determinism:** `envelope_id`/`event_hash`/`manifest_hash` are byte-identical across two independent runs/machines (CCE C-1/C-6, WORM WV-1).
4. **Evidence integrity:** independent verifier validates the full chain using only WORM read + public keys + TSA cert + spec; tamper/missing-object/missing-segment all detected (WV-2/3/9/12).
5. **Anchoring discipline:** anchors are HSM-signed + externally timestamped; un-anchored window stays under threshold; TSA outage never fabricates a token (WV-13).
6. **Attribution honesty:** changes correlate to DB-audit (exact/probable) where available; `unattributed` is produced (never faked) when audit is missing/disabled, and audit-disable raises a tamper indicator (AE-4).
7. **Detection:** starter rules fire correctly with explainable matched conditions; cross-table lookups yield INDETERMINATE rather than guessing when data is unavailable; alerts dedupe and notify with masked content.
8. **No write path:** automated and manual confirmation that **no service holds a Kafel write credential** and **no execution endpoint exists**; reversal flow is proposal + approval only.
9. **Security controls:** OIDC + TOTP + RBAC + IP allowlist + mTLS enforced; reveal of sensitive data is permissioned and custody-logged; admin actions audited.
10. **Latency/SLO:** p95 commit→dashboard < 5s under target load; projection rebuildable from WORM.

---

## 17. Go / No-Go Checklist (before production)

**Integrity & evidence**
- [ ] Independent verifier passes on production-config WORM using only public inputs (WV-12).
- [ ] WORM bucket confirmed **compliance-mode** Object Lock, geo-replicated, hashes verified at replica.
- [ ] HSM keys confirmed **non-exportable**, custodied by Domain C, usage audited; rotation/revocation runbook exists.
- [ ] Daily verifier scheduled; VERIFICATION_FAILED triggers incident response (tested).

**Completeness & fidelity**
- [ ] GTID continuity + heartbeat watchers alarmed and tested (gap injection detected).
- [ ] Source-config attestation alarms on row-image/format/gtid/retention changes (tested).
- [ ] Connector/replica lag SLOs + alarms in place.

**Security boundaries**
- [ ] Confirmed: **zero Kafel write credentials** anywhere in Domains B/C; no execution endpoint deployed.
- [ ] mTLS enforced between all services; OIDC + TOTP + RBAC + IP allowlist active; fail-closed verified.
- [ ] Reveal-sensitive permissioned + custody-logged; notifications masked; no sensitive data in logs.
- [ ] Secrets in Vault/KMS (references only); read-only CDC cred scope verified.

**Operational**
- [ ] Dashboards/alerts for lag, anchor window, WORM/HSM/TSA health, projection drift live.
- [ ] Failure-scenario runbooks (§13) exercised in staging (CDC/PG/WORM/HSM/TSA/queue).
- [ ] Backups encrypted + object-locked; **DR restore drill executed including full evidence verification**; RPO/RTO met.
- [ ] Projection rebuild-from-WORM executed successfully.

**Quality & compliance**
- [ ] Conformance suites green: CCE C-*, WORM WV-*, Risk RR-*, and contract RD/ER/AE/XC-* (for the propose-only subset).
- [ ] Determinism tests green across two machines/languages.
- [ ] Data-classification + masking review signed off; retention/legal-hold + erasure (crypto-shred) policy documented.
- [ ] Security review / threat-model sign-off; (recommended) external pen-test scheduled or passed.
- [ ] Stakeholder/compliance sign-off that MVP scope (read-only, propose-only, evidence-grade) is accepted.

**Verdict gate:** Production deployment proceeds only when **all integrity, completeness, security-boundary, and no-write-path items are checked**. Any unresolved item in those four groups is an automatic **No-Go**.

---

*End of Phase 0 Engineering Blueprint. Planning only — no production code, no implementation. All frozen specifications remain unmodified; this blueprint conforms to the approved baseline and preserves its invariants (no EDAM write path, no fabrication, append-only/WORM evidence, determinism).*
