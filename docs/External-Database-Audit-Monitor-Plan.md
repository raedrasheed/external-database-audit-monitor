# External Database Audit Monitor (EDAM)
### Technical & Product Plan — v1.0

> **Status:** Planning document only. No production code. No changes to the Kafel application.
> **Author role context:** Cybersecurity architect / Database engineer / Product manager / Full-stack lead.
> **Date:** 2026-06-01

---

## Assumptions (explicit)

1. **Kafel** is a donation / charity / financial-flow platform (donations, wallets, beneficiaries, campaigns). The financial-integrity rules below assume this domain. Adjust table names after Phase 0 discovery.
2. Kafel's primary datastore today is **MySQL/MariaDB** (the system must launch here first).
3. We can obtain a **read-only replication/CDC user** on the Kafel database, and (separately) a tightly-scoped **write user** used *only* for approved reversals.
4. We can enable binary logging in `ROW` format on the Kafel DB (or a replica) — required for full before/after images.
5. EDAM runs on **its own infrastructure** with **its own datastore**; it never shares credentials, schema, or runtime with Kafel.
6. "Real-time" = end-to-end p95 latency target of **< 5 seconds** from commit on Kafel to visibility on the EDAM dashboard.
7. Network path exists from EDAM collectors to the Kafel DB (or its replica) on the DB port.

---

## 1. Executive Summary

**Vision.** External Database Audit Monitor (EDAM) is an independent surveillance and forensic-integrity platform that watches the Kafel database from the *outside*, reconstructs every data mutation down to the individual field, scores it for risk, and gives human analysts a controlled, auditable way to **propose and approve** corrective reversals — never automatic ones.

**Why it exists.** In a financial/donation system, the database *is* the ledger. The most dangerous attacks and mistakes are not application crashes — they are **silent data tampering**: a donation amount edited after approval, a wallet balance nudged, a beneficiary with a live balance quietly deleted. The application's own logs are written by the same code/credentials that could be compromised, so they cannot be trusted to police themselves.

**Value.**
- **Tamper-evidence:** an append-only, hash-chained record of *what actually changed in the database*, independent of application logging.
- **Forensic clarity:** old-value → new-value for every field, attributable by time, table, row, and (where available) DB user/connection.
- **Controlled remediation:** a four-eyes reversal workflow that previews exact SQL, requires approval, and logs the outcome.
- **Detection:** rule-based risk scoring tuned to financial-integrity threats.

**Why it must be separate from Kafel.**
| Reason | Explanation |
|---|---|
| **Independence of trust** | If an attacker (or insider) compromises Kafel's app or DB credentials, an audit log living *inside* Kafel can be edited/erased. EDAM observes from outside with separate credentials and immutable storage. |
| **Blast-radius isolation** | A bug or breach in EDAM must not be able to take down or corrupt the production donation platform. |
| **Separation of duties** | The team/role that *operates* Kafel should not be the same that *audits and reverses* it. Different infra enforces this organizationally. |
| **Evidentiary value** | An independent, hash-chained record is far stronger evidence in a dispute, audit, or investigation than a self-reported app log. |
| **Performance** | Heavy analytics/search/retention workloads stay off the production OLTP database. |

---

## 2. System Goals

| Goal | Definition | How EDAM meets it |
|---|---|---|
| **Security monitoring** | Detect malicious/unauthorized DB activity in near real time | Risk Detection Engine + CDC stream + alerting |
| **Financial integrity** | Protect the donation/wallet ledger from silent tampering | Field-level diff on financial tables + integrity rules |
| **Database tamper detection** | Prove the audit trail itself wasn't altered | Append-only storage + per-event hash chaining + daily verification |
| **Full field-level audit** | Capture old/new for every changed column | Diff Engine over CDC before/after images |
| **Manual reversal workflow** | Undo bad changes *only* after human approval | Reversal proposal → review → approval → manual execute → verify |
| **Real-time dashboard** | Live operational visibility | WebSocket/SSE live stream + search-backed views |
| **Multi-database compatibility** | Support more engines later | Pluggable CDC Adapter Layer behind a canonical event model |

---

## 3. Architecture Proposal

### 3.1 Component diagram (text)

```
                          KAFEL (production — untouched)
            ┌───────────────────────────────────────────────┐
            │  MySQL/MariaDB primary  ──►  (optional) replica │
            └───────────────────────────────────────────────┘
                         │ binlog (ROW format) / CDC feed
                         ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                      EDAM (separate infrastructure)                    │
   │                                                                        │
   │  ┌─────────────────────┐    ┌──────────────────────────────────────┐  │
   │  │ Database Change      │    │  CDC ADAPTER LAYER (pluggable)       │  │
   │  │ Collector(s)         │───►│  - MySQLBinlogAdapter (Debezium)     │  │
   │  │ (Debezium Connect /  │    │  - PostgresLogicalAdapter            │  │
   │  │  native streams)     │    │  - SqlServerCdcAdapter               │  │
   │  └─────────────────────┘    │  - OracleLogMinerAdapter             │  │
   │                              │  - MongoChangeStreamAdapter          │  │
   │                              │  → emits CANONICAL CHANGE EVENT       │  │
   │                              └───────────────┬──────────────────────┘  │
   │                                              ▼                          │
   │                              ┌────────────────────────────┐            │
   │                              │  Event Bus: Kafka/Redpanda  │            │
   │                              └───────────────┬────────────┘            │
   │                                              ▼                          │
   │  ┌──────────────────────────────────────────────────────────────────┐ │
   │  │              AUDIT PROCESSING SERVICE (consumer)                   │ │
   │  │  ┌────────────────┐  ┌───────────────────┐  ┌──────────────────┐  │ │
   │  │  │ Field-Level    │─►│ Risk Detection     │─►│ Hash-Chain /      │ │ │
   │  │  │ Diff Engine    │  │ Engine (rules)     │  │ Integrity Writer  │ │ │
   │  │  └────────────────┘  └─────────┬─────────┘  └────────┬─────────┘  │ │
   │  └───────────────────────────────┼─────────────────────┼────────────┘ │
   │                                  ▼                     ▼               │
   │                          ┌──────────────┐    ┌───────────────────────┐ │
   │                          │ Alerting     │    │ AUDIT STORAGE          │ │
   │                          │ Engine       │    │ (PostgreSQL append-    │ │
   │                          └──────┬───────┘    │  only) + OpenSearch    │ │
   │                                 │            │  (search) + Redis      │ │
   │                                 ▼            └───────────┬───────────┘ │
   │                          ┌──────────────┐                │             │
   │                          │ Notification │                ▼             │
   │                          │ System       │   ┌────────────────────────┐ │
   │                          │ (email/Slack/│   │  API + Real-time Gateway│ │
   │                          │  Telegram/   │   │  (REST + WebSocket/SSE) │ │
   │                          │  webhook)    │   │  Auth + RBAC + MFA      │ │
   │                          └──────────────┘   └───────────┬────────────┘ │
   │                                                          ▼             │
   │  ┌───────────────────────┐                  ┌────────────────────────┐ │
   │  │ MANUAL REVERSAL        │◄────────────────►│ REAL-TIME DASHBOARD    │ │
   │  │ WORKFLOW SERVICE       │  (approve/exec)  │ (React + Vite)         │ │
   │  │ - proposal generator   │                  └────────────────────────┘ │
   │  │ - SQL preview          │                                            │
   │  │ - scoped EXECUTION user│──► writes ONLY approved reversals to Kafel │
   │  └───────────────────────┘                                            │
   └──────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component responsibilities

1. **Database Change Collector** — Connects to the source DB's change feed (binlog, WAL, CDC tables, redo logs, change streams). Runs as Debezium connectors where supported; otherwise native clients. Stateless re-startable with offset tracking.
2. **CDC Adapter Layer** — Normalizes each engine's native event into one **Canonical Change Event** (CCE). This is the keystone of multi-DB support. (Schema in §4.3.)
3. **Event Bus (Kafka/Redpanda)** — Durable, ordered, replayable transport. Decouples collection from processing; enables backpressure and reprocessing.
4. **Audit Processing Service** — Consumes CCEs and orchestrates the pipeline below. Idempotent (keyed on source offset/LSN/GTID).
5. **Field-Level Diff Engine** — Compares `before`/`after` images, produces per-field `{field, old_value, new_value, changed: bool}`. Applies sensitive-field masking. Handles INSERT (no old), DELETE (no new), UPDATE (both), and schema/DDL events.
6. **Risk Detection Engine** — Evaluates configurable rules (§10) against each event and against short windows of events (mass-update, off-hours). Produces a risk score + triggered-rule list.
7. **Alerting Engine** — Deduplicates, thresholds, and routes alerts; manages alert lifecycle (open/ack/resolved).
8. **Manual Reversal Workflow** — Generates a *proposed* compensating statement from the captured before-image, renders SQL preview, enforces approval (and four-eyes for critical), then executes via the **separate scoped write user**. Never auto-executes.
9. **Audit Storage Database** — Append-only PostgreSQL (events, field changes, hash chain) + OpenSearch (fast search/aggregation) + Redis (live counters, dedupe, sessions).
10. **Real-Time Dashboard** — React/Vite SPA; live feed over WebSocket/SSE; search/filter via API; reversal/approval UIs.
11. **Authentication & RBAC** — OIDC-compatible auth, MFA, role/permission model, session policy, IP allowlist.
12. **Notification System** — Channel adapters (email, Slack, Telegram, generic webhook, SMS optional) driven by the Alerting Engine.

---

## 4. Multi-Database Strategy

### 4.1 The core idea

Universal support is achieved **not** by a single magic connector but by an **Adapter pattern**: each engine has a dedicated collector that emits the **Canonical Change Event (CCE)**. Everything downstream (diff, risk, storage, dashboard, reversal) is engine-agnostic and consumes only CCEs. Debezium is the preferred collector wherever it has a mature connector, because it already normalizes a lot of this; native methods fill the gaps.

### 4.2 Per-database evaluation

| Capability | **MySQL** (binlog/Debezium/triggers) | **PostgreSQL** (logical decoding/WAL/Debezium) | **MariaDB** (binlog/Debezium) | **SQL Server** (CDC/temporal/Debezium) | **Oracle** (LogMiner/GoldenGate/Debezium) | **MongoDB** (change streams) |
|---|---|---|---|---|---|---|
| **Real-time** | ✅ binlog streaming, sub-sec | ✅ logical replication slot | ✅ binlog | ✅ CDC capture job (slight lag); temporal=query-based | ✅ LogMiner/GoldenGate; ⚠️ LogMiner heavier | ✅ change streams (oplog) |
| **Old value** | ✅ in ROW binlog (full before-image with `binlog_row_image=FULL`) | ✅ but **only if `REPLICA IDENTITY FULL`** (else PK only) | ✅ same as MySQL | ✅ CDC stores old+new; temporal stores history | ✅ LogMiner/GoldenGate give before image | ⚠️ `fullDocumentBeforeChange` needs **pre/post images enabled** (Mongo 6.0+); otherwise only delta |
| **New value** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (`fullDocument`) |
| **DELETE capture** | ✅ before-image present | ✅ if `REPLICA IDENTITY FULL` (else only key) | ✅ | ✅ | ✅ | ✅ (key; full doc needs pre-image) |
| **Field-level diff** | ✅ excellent | ✅ excellent (with full replica identity) | ✅ | ✅ | ✅ | ⚠️ document-level; diff computed on JSON paths |
| **Limitations** | Requires `ROW` format + `FULL` image; binlog retention; no DB-user attribution in binlog by default | Slot must be consumed or WAL bloats and can fill disk; full replica identity increases WAL size | Same as MySQL; some MariaDB-specific GTID quirks | CDC adds capture/cleanup jobs; Enterprise/Standard feature availability varies by version | LogMiner is resource-heavy and version-sensitive; GoldenGate is **licensed/costly**; Debezium-Oracle is the trickiest connector | Need replica set/sharded (change streams require it); pre-images storage cost; no relational FKs |
| **Required permissions** | `REPLICATION SLAVE`, `REPLICATION CLIENT`, `SELECT` (for snapshot) | `REPLICATION` attr, `CREATE`/use of publication+slot, `SELECT` | same as MySQL | `sysadmin`/`db_owner` to enable CDC; reader needs CDC role | `LOGMINING`/`SELECT_CATALOG_ROLE`, supplemental logging privileges; GoldenGate-specific grants | read on `oplog`/db; `changeStream` privilege; admin to enable pre/post images |
| **Production risks** | Binlog disk growth; replica lag if reading primary | **Unconsumed slot can crash the primary by filling disk** (highest-severity risk) | as MySQL | capture job CPU; cleanup tuning | LogMiner CPU/IO impact on prod; licensing | oplog window too small ⇒ missed events; pre-image storage growth |

**Rule of thumb on attribution:** native logs identify *the change*, not always *the human DB user*. Where DB-user/connection attribution is weak (binlog), enrich via correlation with Kafel app logs or DB audit plugins (e.g., MySQL Enterprise Audit / MariaDB Audit Plugin) as a secondary source.

### 4.3 Canonical Change Event (CCE) — the contract

```jsonc
{
  "event_id": "uuid",
  "source": {
    "db_id": "kafel-prod-mysql",
    "engine": "mysql",            // mysql|postgres|mariadb|sqlserver|oracle|mongodb
    "schema": "kafel",
    "table": "donations",
    "primary_key": { "id": 90211 }
  },
  "operation": "UPDATE",          // INSERT|UPDATE|DELETE|DDL|TRUNCATE
  "tx": { "id": "gtid/lsn/scn", "commit_ts": "2026-06-01T10:22:31.114Z" },
  "offset": { "gtid": "...", "lsn": "...", "scn": "...", "resume_token": "..." },
  "before": { "amount": 100.00, "status": "approved" },   // null for INSERT
  "after":  { "amount": 100000.00, "status": "approved" },// null for DELETE
  "actor":  { "db_user": "app_user", "client_host": "10.0.0.5", "connection_id": "..." },
  "ingest_ts": "2026-06-01T10:22:31.480Z"
}
```

> The diff engine, risk engine, storage, dashboard, and reversal generator only ever read CCEs. **Adding a new database = writing one adapter that emits CCEs.** That is the entire multi-DB extensibility story.

### 4.4 Trigger-based fallback

Where log-based CDC is impossible (locked-down managed DB, no log access), an **engine-specific trigger pack** can write change rows to a shadow audit table inside the source DB, which a collector then drains. This is a *fallback only* because it: (a) runs inside the monitored DB (couples blast radius), (b) adds write overhead to production transactions, and (c) can be disabled/bypassed by the same privileged actor we're trying to detect. Log-based CDC is always preferred.

---

## 5. Recommended Technical Stack

| Layer | Recommendation | Rationale / alternatives |
|---|---|---|
| **CDC collectors** | **Debezium** (on Kafka Connect) for MySQL/Postgres/SQLServer/Oracle/Mongo; native fallbacks | Mature, normalizes before/after, offset management. |
| **Event bus** | **Redpanda** (Kafka API, simpler ops) or **Kafka** | Durable, ordered, replayable. RabbitMQ only if streaming volume is low. |
| **Backend** | **NestJS (Node.js, TypeScript)** | Strong module/DI structure for adapter pattern, first-class WebSocket/SSE, fast delivery. *Alt:* Spring Boot if team is Java-heavy and Oracle/GoldenGate integration dominates. |
| **Diff/Risk workers** | NestJS microservice consumers (or standalone Node workers) | Same language as API; share canonical models. |
| **Frontend** | **React + Vite + TypeScript**, TanStack Query, a component lib (e.g., shadcn/ui or MUI), i18n (Arabic/English, RTL/LTR) | Per requirements. |
| **Real-time** | **WebSocket (Socket.IO)** for the live feed; **SSE** as a lightweight fallback for read-only dashboards | |
| **Audit storage** | **PostgreSQL** (append-only audit + hash chain + workflow state) | Strong constraints, JSONB for before/after, partitioning by month. |
| **Search/analytics** | **OpenSearch** | Fast filtering/aggregation for the live feed and "top changed tables/high-risk users". |
| **Cache / counters / sessions** | **Redis** | Live overview counters, dedupe, rate limits, sessions. |
| **Secrets** | **HashiCorp Vault** (or cloud KMS/Secrets Manager) | Encrypted DB credentials, dynamic secrets ideal. |
| **Auth** | **Keycloak** (OIDC) or self-managed JWT + TOTP MFA | RBAC, MFA, SSO-ready. |
| **Containerization** | **Docker Compose** (dev/single-node) → **Kubernetes** (prod scale) | |
| **Deployment** | Start on a hardened **VPS / DigitalOcean droplet**; grow to **K8s on AWS** (EKS) | |
| **Observability** | Prometheus + Grafana + Loki; OpenTelemetry tracing | NFR §13. |

---

## 6. Database Schema Design (EDAM's own store — PostgreSQL)

> Append-only tables use `INSERT`-only access for the app role; `UPDATE/DELETE` revoked at the DB level. Large tables partitioned by month on `commit_ts`.

```sql
-- 6.1 monitored_databases
monitored_databases(
  id PK, name, engine ENUM(mysql,postgres,mariadb,sqlserver,oracle,mongodb),
  host, port, default_schema, connection_secret_ref,   -- ref to Vault, not the secret
  cdc_method ENUM(debezium,binlog,wal,cdc,logminer,goldengate,changestream,trigger),
  status ENUM(active,paused,error), last_offset JSONB, last_heartbeat_at,
  created_at, updated_at
)

-- 6.2 monitored_tables
monitored_tables(
  id PK, database_id FK->monitored_databases, schema_name, table_name,
  is_financial BOOL, capture_enabled BOOL,
  sensitive_fields JSONB,        -- ["national_id","iban"] → masked
  pk_columns JSONB,
  created_at, updated_at,
  UNIQUE(database_id, schema_name, table_name)
)

-- 6.3 audit_events   (APPEND-ONLY, partitioned by commit_ts)
audit_events(
  id BIGINT PK,                  -- monotonic, used in hash chain order
  event_uuid UUID UNIQUE,
  database_id FK, table_id FK,
  operation ENUM(INSERT,UPDATE,DELETE,DDL,TRUNCATE),
  pk_values JSONB,
  tx_id TEXT, source_offset JSONB,  -- gtid/lsn/scn/resume_token
  db_user TEXT, client_host TEXT, connection_id TEXT,
  commit_ts TIMESTAMPTZ, ingest_ts TIMESTAMPTZ,
  risk_score INT, triggered_rules JSONB,
  prev_hash BYTEA, row_hash BYTEA,   -- hash chain (see §9)
  raw_before JSONB, raw_after JSONB  -- masked copies retained per retention policy
)

-- 6.4 audit_field_changes
audit_field_changes(
  id BIGINT PK, event_id FK->audit_events,
  field_name TEXT, old_value TEXT, new_value TEXT,
  old_value_masked BOOL, new_value_masked BOOL, data_type TEXT,
  is_sensitive BOOL
)

-- 6.5 risk_rules
risk_rules(
  id PK, code UNIQUE, name, description,
  engine_scope JSONB,            -- which DBs/tables it applies to
  rule_type ENUM(field_change,operation,threshold,window,time_of_day,schema_change),
  definition JSONB,              -- declarative condition
  severity ENUM(low,medium,high,critical),
  score INT, is_enabled BOOL, created_by FK->users, created_at, updated_at
)

-- 6.6 alerts
alerts(
  id PK, event_id FK->audit_events, rule_id FK->risk_rules,
  severity, status ENUM(open,acknowledged,resolved,dismissed),
  assigned_to FK->users, acknowledged_at, resolved_at, note,
  created_at
)

-- 6.7 reversal_requests
reversal_requests(
  id PK, event_id FK->audit_events, requested_by FK->users,
  status ENUM(draft,pending_approval,approved,rejected,executed,failed,verified),
  reason TEXT,
  proposed_sql TEXT,             -- generated compensating statement (preview)
  proposed_payload JSONB,        -- for non-SQL engines (Mongo)
  target_pk JSONB, snapshot_before JSONB, current_value JSONB,
  requires_four_eyes BOOL,
  created_at, updated_at
)

-- 6.8 reversal_approvals
reversal_approvals(
  id PK, request_id FK->reversal_requests, approver FK->users,
  decision ENUM(approve,reject), comment TEXT, decided_at,
  UNIQUE(request_id, approver)   -- one decision per approver (enforces four-eyes)
)

-- 6.9 reversal_execution_logs  (APPEND-ONLY)
reversal_execution_logs(
  id PK, request_id FK->reversal_requests, executed_by FK->users,
  executed_sql TEXT, execution_started_at, execution_finished_at,
  result ENUM(success,failure), affected_rows INT, error_text TEXT,
  verification_status ENUM(pending,passed,failed),
  post_state JSONB, execution_hash BYTEA
)

-- 6.10 users
users(
  id PK, email UNIQUE, display_name, password_hash, status,
  mfa_enabled BOOL, mfa_secret_ref, last_login_at, failed_attempts,
  created_at, updated_at
)

-- 6.11 roles
roles(id PK, code UNIQUE, name, description)

-- 6.12 permissions
permissions(id PK, code UNIQUE, description)
role_permissions(role_id FK, permission_id FK, PK(role_id,permission_id))
user_roles(user_id FK, role_id FK, PK(user_id,role_id))

-- 6.13 system_settings
system_settings(
  id PK, key UNIQUE, value JSONB, category,
  updated_by FK->users, updated_at
)

-- audit of EDAM itself (admin actions) — append-only
admin_audit_log(
  id PK, actor FK->users, action, target_type, target_id,
  ip_address, before JSONB, after JSONB, created_at, row_hash BYTEA
)
```

**Key relationships:** `monitored_databases 1—* monitored_tables 1—* audit_events 1—* audit_field_changes`. `audit_events 1—* alerts`. `audit_events 1—* reversal_requests 1—* reversal_approvals` and `1—* reversal_execution_logs`. `users *—* roles *—* permissions`.

---

## 7. Real-Time Dashboard UI Plan

**Global shell:** left nav (collapsible), top bar (DB selector, global search, severity legend, user menu, language + theme toggles), live connection indicator. Persistent "live/paused" toggle for the stream.

### A. Overview Dashboard
- KPI cards: **Total events today**, **Critical alerts**, **Suspicious operations**, **Pending reversals**.
- **Monitored databases status** grid (engine icon, connected/lagging/error, last heartbeat, offset lag).
- **Live change stream** (compact, last ~50, auto-scroll, pausable).
- **Top changed tables** (bar) and **High-risk users** (list with score).
- Mini timeline of events-per-minute with severity bands.

### B. Live Database Changes
- Real-time virtualized feed; each row: time, db.table, operation badge, PK, db_user, severity dot.
- **Filters:** database, table, db_user, operation, severity, date range, free-text (OpenSearch).
- Click → **Event detail drawer** with **field-level diff viewer**: two-column old vs new, changed fields highlighted, sensitive values masked with reveal-on-permission, data types, tx id, offset.

### C. Suspicious Activity Center
- Queue of alerts sorted by risk score; columns: rule, severity, table/record, time, status.
- Detail: **risk score breakdown**, **rule(s) triggered**, **affected table/record**, **timeline of related events** for the same PK/user, **recommended action**, and a one-click **"Create reversal proposal"**.

### D. Manual Reversal Center
- **Pending reversal requests** queue.
- Detail view: **generated reversal plan**, **SQL preview** (syntax-highlighted, read-only), **old value / current value comparison** (warns if the row changed again since capture — drift detection), **approval workflow** (single or four-eyes status), **execute** button (gated by approval + permission), **execution confirmation modal** (re-auth/MFA), and **post-execution rollback verification** panel.

### E. Integrity Verification
- **Hash chain status** (last verified id, chain head hash, OK/broken).
- **Missing event detection** (gaps in source offset/GTID continuity).
- **Audit log tampering check** result.
- **Daily verification report** with downloadable PDF/CSV and history.

### F. Configuration
- Add database connection (engine picker → method-specific fields → test connection → store secret ref in Vault).
- Select monitored tables (with discovery), mark **financial** and **sensitive fields**.
- Define **risk rules** (visual builder over the declarative rule schema).
- Configure **alerts** (channels, thresholds, quiet hours).
- **RBAC settings** (users, roles, permissions matrix), MFA enforcement, IP allowlist, session policy.

---

## 8. Manual Reversal Workflow

```
[1] Suspicious event detected
      Risk Engine flags audit_event → alert created (Suspicious Activity Center).

[2] Reversal proposal generated (on analyst request — NEVER automatic)
      Reversal service reconstructs a compensating action from the BEFORE-image:
        UPDATE → UPDATE row SET <fields> = <old_values> WHERE <pk> = <pk_values>
        DELETE → INSERT the previously-deleted row (from before-image)
        INSERT → DELETE the inserted row WHERE <pk> = <pk_values>
      Renders proposed_sql (or Mongo payload) + snapshot_before + current_value.
      DRIFT CHECK: re-reads current row; if it differs from captured 'after',
      flags that the value changed again and requires explicit analyst acknowledgement.

[3] Analyst review
      Analyst inspects diff, SQL preview, drift status, writes justification.

[4] Approval required
      status: draft → pending_approval.
      Non-critical: one approver with reversal:approve permission.
      CRITICAL FINANCIAL (donations, wallets, balances): FOUR-EYES —
      two distinct approvers, neither of whom is the requester.

[5] Manual execution
      Only after approval. Executor re-authenticates (MFA). EDAM connects to Kafel
      using the SEPARATE, SCOPED EXECUTION USER (write only to whitelisted tables),
      inside a single transaction, statement-timeout enforced.

[6] Verification after reversal
      Re-read the row; compare to the intended restored state.
      verification_status: passed/failed. On failure → alert + no retry without re-approval.

[7] Reversal audit log created
      reversal_execution_logs row written (append-only, hashed): who, when,
      exact SQL, affected_rows, result, verification. This itself becomes an
      auditable, immutable record.
```

**Hard guarantees:**
- The system **never reverses automatically** — there is no code path from detection to execution without human approval.
- The exact reversal SQL/payload is **previewed and approved** before any write.
- **Four-eyes** is mandatory for critical financial operations and enforced at the data layer (`reversal_approvals` unique per approver; requester excluded).

---

## 9. Security Requirements

| Requirement | Implementation |
|---|---|
| **Separate credentials from Kafel** | EDAM holds its own DB users; Kafel app credentials never reused. |
| **Read-only monitoring user** | CDC/replication user has only replication + `SELECT` (no write). |
| **Separate execution user** | Distinct user used *only* for approved reversals; `INSERT/UPDATE/DELETE` limited to whitelisted tables; no DDL/grant. |
| **Encrypted credentials** | Stored in Vault/KMS; EDAM stores only secret *references*; TLS to all DBs. |
| **Immutable audit logs** | Audit/exec tables are append-only; `UPDATE/DELETE` privilege revoked from app role; ideally WORM/object-lock backups. |
| **Hash chaining** | `row_hash = H(prev_hash ‖ canonical(event_fields))`; chain head stored separately; daily verification recomputes and compares. |
| **Append-only design** | No in-place edits anywhere in the audit path; corrections are new events. |
| **RBAC** | Roles/permissions matrix (§14); least privilege. |
| **MFA** | TOTP required for analysts/approvers/admins; re-auth before reversal execution. |
| **IP allowlisting** | Dashboard/API reachable only from allowlisted ranges/VPN. |
| **Session timeout** | Idle + absolute session limits; refresh-token rotation; revoke on role change. |
| **Admin actions audited** | `admin_audit_log` (append-only, hashed) for every config/RBAC/secret change. |
| **Backup & retention** | Encrypted, immutable (object-lock) backups; tiered retention (hot 90d, warm 1y, cold per regulatory need); restore drills. |

---

## 10. Risk Detection Rules (default pack for Kafel)

| # | Rule | Trigger condition (declarative) | Severity |
|---|---|---|---|
| 1 | **Donation amount changed after approval** | UPDATE on `donations` where `before.status='approved'` AND `amount` changed | Critical |
| 2 | **Wallet balance manually updated** | UPDATE on `wallets.balance` not matching an expected transaction pattern / direct edit | Critical |
| 3 | **Beneficiary deleted with active balance** | DELETE on `beneficiaries` where `before.balance > 0` | Critical |
| 4 | **Campaign deleted with donations** | DELETE on `campaigns` that has related donation rows | High |
| 5 | **Role/permission changed** | INSERT/UPDATE/DELETE on `roles`/`permissions`/`user_roles` | High |
| 6 | **Mass update detected** | > N rows of same table changed by same actor within T seconds (window rule) | High |
| 7 | **Delete on financial tables** | DELETE on any `is_financial` table | High |
| 8 | **Database schema changed** | DDL/ALTER/DROP/CREATE event | High |
| 9 | **Login/security table changed** | Change to `users`, credentials, MFA, sessions tables | High |
| 10 | **Activity outside business hours** | Any change to financial tables where `commit_ts` outside configured business hours / from unusual host | Medium→High |

Each rule has tunable `score` and `severity`; scores aggregate per event and per actor (sliding window) to drive the "high-risk users" view.

---

## 11. Implementation Roadmap

| Phase | Objectives | Deliverables | Risks | Acceptance criteria |
|---|---|---|---|---|
| **0 — Discovery** | Map Kafel schema, identify financial/sensitive tables, confirm binlog/replica access | Data dictionary, sensitive-field list, access plan, threat model | Incomplete access; PII exposure | Sign-off on monitored-table list + read-only access provisioned |
| **1 — MVP (MySQL)** | Capture changes from selected MySQL tables → store with field diffs | Debezium MySQL adapter → CCE → Audit Processing → PostgreSQL store; basic API | Binlog config not FULL; perf | Old/new captured for INSERT/UPDATE/DELETE on selected tables; p95 < 5s |
| **2 — Real-time dashboard** | Live feed + event detail + diff viewer + search | React app, WebSocket gateway, OpenSearch indexing, Overview + Live Changes screens | WS scaling; search index lag | Analysts see live changes with field diff and filters |
| **3 — Risk rules & alerts** | Detection + alerting + notifications | Risk Engine, default rule pack, Alerting Engine, channels, Suspicious Activity Center | False positives | Rules 1–10 fire correctly on test cases; alerts routed |
| **4 — Manual reversal** | Proposal → approval → manual execute → verify | Reversal service, SQL preview, four-eyes, scoped exec user, Reversal Center | Wrong/destructive SQL; drift | Reversal works on staging with approval gating; never auto-executes |
| **5 — Integrity** | Tamper evidence | Hash chaining, gap detection, daily verification report, Integrity screen | Chain breaks on reprocessing | Verification detects injected tampering & offset gaps |
| **6 — Multi-DB adapters** | Add Postgres, then SQL Server, Mongo, Oracle | Additional CDC adapters emitting CCE; per-engine reversal generators | Postgres slot disk risk; Oracle complexity/licensing | Each new engine passes same conformance suite against CCE |
| **7 — Enterprise hardening** | Scale, HA, compliance | K8s, HA bus/storage, Vault, MFA/SSO, IP allowlist, DR drills, retention | Cost; ops complexity | Pen-test passed; DR restore validated; SLOs met |

---

## 12. MVP Scope (smallest safe slice)

**In scope:**
- MySQL monitoring of a **selected set of sensitive/financial tables** via Debezium (ROW binlog, FULL image).
- **Field-level change tracking** (old/new) for INSERT/UPDATE/DELETE.
- **Live dashboard** (Overview + Live Changes + diff viewer).
- **Suspicious event classification** using a starter subset of rules (e.g., #1, #2, #3, #7).
- **Manual reversal *proposal only*** — generate + preview SQL; **no execution** in MVP, or execution gated behind staging + approval if included.

**Explicitly out of scope for MVP:** automatic reversal (ever), multi-DB, full integrity hash chain (basic only), advanced RBAC/SSO, all notification channels.

**Safety stance:** MVP is read-only against Kafel. The single most important MVP guarantee is **"observe, diff, alert, propose — never write."**

---

## 13. Non-Functional Requirements

| NFR | Target |
|---|---|
| **Performance** | Sustain ≥ 2,000 change events/sec/connector; diff+store p95 < 1s within EDAM. |
| **Scalability** | Horizontal: partitioned topics, multiple consumer workers, partitioned PG tables. |
| **Reliability** | At-least-once delivery + idempotent writes (dedupe on source offset); no lost events. |
| **Latency** | End-to-end commit→dashboard p95 < 5s. |
| **Storage growth** | Estimate from event rate × avg payload; monthly partitions; tiered retention + compression; OpenSearch ILM. |
| **Privacy / data masking** | Sensitive fields masked at the diff engine; reveal requires explicit permission and is itself audited. |
| **Backup / DR** | Encrypted immutable backups; documented RPO ≤ 15 min, RTO ≤ 1h; periodic restore drills. |
| **Observability** | Metrics (lag, throughput, error rates), structured logs, traces; alert on connector lag/slot growth. |

---

## 14. Product Requirements (PRD)

### Personas
- **Security Analyst** — monitors live changes, investigates alerts, creates reversal proposals.
- **Compliance/Finance Officer** — reviews financial-integrity alerts, second approver for four-eyes, consumes reports.
- **EDAM Administrator** — configures DBs, tables, rules, RBAC, channels.
- **Auditor (read-only)** — reviews immutable history and verification reports.
- **Executor/Approver (senior)** — approves and triggers manual reversals.

### Sample user stories
- *As an analyst,* I see a live feed of DB changes with old→new values so I can spot tampering immediately.
- *As a compliance officer,* I'm alerted when a donation amount changes after approval so I can investigate.
- *As an approver,* I must approve the exact reversal SQL before it can run, with four-eyes on financial rows.
- *As an auditor,* I can verify the audit log hasn't been tampered with via the daily integrity report.
- *As an admin,* I can add a new database connection and choose its engine and monitored tables.

### Functional requirements (abridged)
FR-1 capture all INSERT/UPDATE/DELETE/DDL on monitored tables. FR-2 store old+new per field. FR-3 mask sensitive fields. FR-4 evaluate risk rules and raise alerts. FR-5 notify via configured channels. FR-6 generate reversal proposals with SQL preview. FR-7 enforce approval (+four-eyes for critical) before any write. FR-8 never auto-execute reversals. FR-9 hash-chain audit records and verify daily. FR-10 RBAC + MFA + session/IP controls. FR-11 pluggable CDC adapters per engine.

### Permissions matrix
| Permission | Auditor | Analyst | Approver | Compliance | Admin |
|---|:--:|:--:|:--:|:--:|:--:|
| view_events / diff | ✅ | ✅ | ✅ | ✅ | ✅ |
| reveal_sensitive | — | ⚙️(audited) | ⚙️ | ✅ | ✅ |
| manage_alerts | — | ✅ | ✅ | ✅ | ✅ |
| create_reversal_request | — | ✅ | ✅ | ✅ | ✅ |
| approve_reversal | — | — | ✅ | ✅ | ✅ |
| execute_reversal | — | — | ✅ | — | ⚙️ |
| manage_rules | — | — | — | ✅ | ✅ |
| manage_databases/tables | — | — | — | — | ✅ |
| manage_users/rbac | — | — | — | — | ✅ |

### Reporting requirements
Daily integrity report; per-table change volume; alerts summary; reversal activity log; high-risk user report. Exportable PDF/CSV; scheduled email.

### Success metrics
- Mean time to detect (MTTD) tampering < 1 min.
- 100% of financial-table changes captured (zero gaps in verification).
- 0 automatic reversals (by design); 100% of reversals approved & logged.
- False-positive alert rate trending down per tuning cycle.

---

## 15. UX/UI Requirements

- **Layout:** persistent left nav + top bar + content; right-side **event detail drawer** (non-blocking).
- **Navigation:** Overview, Live Changes, Suspicious Activity, Reversal Center, Integrity, Configuration.
- **Cards:** KPI cards with trend sparkline; DB status cards with health color.
- **Tables:** virtualized, sortable, column-config, sticky header, server-side pagination/search.
- **Filters:** chip-based multi-filter bar (db/table/user/operation/severity/date) + saved filters.
- **Event detail drawer:** metadata header + **diff viewer**.
- **Diff viewer:** two-column old vs new; changed fields highlighted; added=green, removed=red, modified=amber; sensitive masked with audited reveal; JSON path view for Mongo.
- **Severity colors:** Critical = red, High = orange, Medium = amber, Low = blue/gray (with non-color cues for accessibility).
- **Approval modals:** show full SQL preview + drift warning + reason field + MFA re-auth; four-eyes shows both approvers' status.
- **Empty states:** friendly guidance ("No changes captured yet — connect a database").
- **Loading states:** skeletons for cards/tables; live-stream shimmer.
- **RTL/LTR + Arabic/English:** full i18n, direction-aware layout, Arabic numerals option, localized dates/timezones.
- **Dark/light mode:** theme toggle, persisted per user, WCAG AA contrast in both.

---

## 16. Technical Decision (conclusion)

**Is universal database support possible?**
**Not via a single connector — but yes as a unified platform**, through the **CDC Adapter Layer + Canonical Change Event** pattern. Every engine exposes change data differently (binlog, WAL/logical decoding, CDC tables/temporal, LogMiner/GoldenGate, change streams) with different fidelity for **old values and DELETEs**. The platform becomes "universal" by normalizing all of them into one canonical event the rest of the system understands. The *collection edge* is engine-specific; everything above it is generic.

**Best realistic approach.** Log-based CDC via **Debezium where a mature connector exists**, native methods as fallback, all emitting CCEs onto a durable bus, processed by engine-agnostic diff/risk/storage/reversal services. Trigger-based capture only as a last resort.

**Which database first?** **MySQL/MariaDB** — it is Kafel's store, binlog ROW + FULL image gives clean before/after for all operations, and Debezium's MySQL connector is the most battle-tested. Build the MVP and prove the whole pipeline here.

**What to avoid.**
- **Any automatic reversal.** Never close the loop from detection to write without human approval.
- **Trigger-based capture inside production** as a primary method (overhead + same-actor bypass risk).
- **PostgreSQL logical slots left unconsumed** — can fill disk and crash the primary; must monitor slot lag.
- **Oracle GoldenGate as a default** — costly/licensed; prefer LogMiner/Debezium unless already owned.
- **Mongo without pre/post images enabled** — you lose before-images and DELETE fidelity.
- **Reading CDC from the primary** where a replica is available — offload to a replica to protect production.

**Architecture for the safest long-term result.**
> Independent EDAM platform · log-based CDC adapters → Canonical Change Event → durable replayable bus → idempotent processing (diff + risk) → **append-only, hash-chained** audit store · search/cache for the live dashboard · **read-only** monitoring user + **separately scoped** execution user · manual, four-eyes, preview-and-approve reversal workflow · RBAC/MFA/IP/session controls · full observability and immutable backups.

This separates trust, isolates blast radius, gives tamper-evident forensic records, and extends to new databases by writing one adapter at a time — while guaranteeing that **nothing is ever reversed without a human decision.**

---

*End of plan. No production code written; no existing project files modified.*
