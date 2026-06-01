# EDAM Architecture Review — Adversarial Enterprise Assessment
### Reviewer panel: CISO · Principal DB Architect · Principal Software Architect · Senior SOC Architect · Digital Forensics Expert · Enterprise Product Architect

> **Mandate:** Find weaknesses before implementation. This is a critique of `docs/External-Database-Audit-Monitor-Plan.md`, not a rewrite.
> **Threat horizon assumed:** financial / donation / banking-like / high-value transaction platforms.
> **Tone:** brutal and direct, by request.

---

## 1. Executive Assessment

| Dimension | Score | One-line justification |
|---|---|---|
| **Architecture** | **72/100** | Sound pattern (CDC → CCE → append-only store), but the canonical event model is under-specified for transactions, ordering, and schema evolution, and the reversal path quietly couples EDAM back into production. |
| **Security** | **64/100** | Good instincts (separation, append-only, hash chain) undermined by a hand-rolled hash chain with no external anchoring, a write path back into the monitored DB, and no answer for the #1 adversary it claims to defeat: the privileged DBA who can edit the source logs and the data simultaneously. |
| **Scalability** | **66/100** | Kafka/OpenSearch/PG partitioning is the right shape, but there is no capacity model, no per-table volume estimate, no snapshot-vs-stream strategy, and OpenSearch is treated as a search index while implicitly becoming a system of record. |
| **Maintainability** | **58/100** | Six CDC adapters, six reversal generators, a rule DSL, i18n/RTL, and a full RBAC/MFA stack is a very large surface for what is pitched as a focused audit tool. The "one adapter at a time" story hides enormous per-engine cost. |
| **Operational Complexity** | **40/100** *(lower = simpler; this is HIGH complexity)* | Debezium + Kafka Connect + Redpanda + PostgreSQL + OpenSearch + Redis + Vault + Keycloak + K8s is a 9-system distributed platform requiring a dedicated platform team. Wildly heavy for an MVP. |
| **Enterprise Readiness** | **55/100** | Missing chain-of-custody, legal hold, WORM/immutable storage as a hard requirement, SIEM/SOC egress, compliance mapping, and UEBA. It is a strong "v1 internal tool," not yet an "evidence-grade enterprise platform." |

**Overall:** a well-above-average plan that knows the right words, but it is **scored as a design document, not as a system that has survived contact with adversaries.** The gap between "we hash-chain events" and "this evidence survives a hostile DBA and a courtroom" is where most of the points are lost.

---

## 2. Critical Design Flaws

### CRITICAL

**C1 — The hash chain is self-anchored and therefore worthless against the primary adversary.**
The plan stores `prev_hash`/`row_hash` in the same PostgreSQL the app writes to, and "stores chain head separately" without saying *where* or *under whose control*. If the EDAM operator (or anyone who compromises EDAM's DB) can recompute the chain, they can rewrite history and re-hash. A hash chain with no **external, independent anchor** (public notarization, third-party timestamping authority, WORM object-lock, or append-only ledger in a different trust domain) detects accidental corruption, not deliberate tampering. **This defeats the entire stated value proposition** ("evidence independent of the people being audited").

**C2 — The reversal "execution user" reintroduces a write path from the audit system into production.**
The document spends pages arguing EDAM must be *independent* and *read-only*, then gives EDAM a credentialed write user into the Kafel financial database. That is a single, high-value credential that can `UPDATE wallets`, `INSERT beneficiaries`, etc. If EDAM is compromised, the attacker now has *exactly* the write primitive the whole system exists to detect — and it's pre-approved as "reversal." The audit monitor becomes the most attractive attack target in the estate. **The reversal executor should not live inside the monitor.**

**C3 — At-least-once + "idempotent on offset" does not guarantee no missed events.**
"No lost events" is asserted, but the only thing protecting against gaps is offset/GTID continuity checking. Binlog rotation, Debezium snapshot/streaming handoff, slot recreation, connector re-deploys, and retention expiry can all silently drop ranges. There is **no defined gap-detection contract at the source** (e.g., expected-GTID-set reconciliation, heartbeat watermarks, or a "completeness proof"). For a financial audit log, "probably no gaps" is a failing grade.

**C4 — Before/after fidelity is assumed, not enforced — and degrades silently.**
The whole field-level diff depends on `binlog_row_image=FULL` (MySQL) and `REPLICA IDENTITY FULL` (Postgres). Nothing in the design *detects* if someone flips these back to `MINIMAL`/default on the source. An attacker who wants to tamper invisibly just downgrades row image first, then edits. EDAM keeps showing green while capturing only primary keys. **There is no source-configuration attestation/guardrail.**

### HIGH

**H1 — DBA/SYSADMIN attribution gap is acknowledged then waved away.** Binlog/WAL do not reliably carry the human identity. "Correlate with app logs" is hand-waving — the privileged insider bypasses the app entirely (that's the point). Without native DB audit (MySQL Enterprise Audit / pgAudit / SQL Server Audit / Unified Auditing) the "high-risk users" view is fiction for the most dangerous actor.

**H2 — OpenSearch silently becomes a system of record.** The live feed, "top tables," and "high-risk users" read from OpenSearch. If PG is the source of truth but the UI trusts OpenSearch, divergence (reindex bugs, ILM deletion) produces *wrong* forensic answers with full confidence. Trust boundary undefined.

**H3 — Reversal "drift detection" is a TOCTOU race.** Re-read current row → compare → execute is not atomic. Between approval and execution the row can change again. Needs optimistic concurrency (version/`WHERE` matches full captured after-image) inside the txn, or it can clobber a legitimate later change.

**H4 — No transaction-level grouping.** CCE is per-row. A single financial operation spans many rows in one transaction. Without txn boundaries and intra-txn ordering, the diff/forensics view cannot reconstruct "what this one operation did," and mass-update rules will both false-positive and false-negative.

**H5 — PII/financial data is duplicated into a second datastore + search index + backups.** EDAM copies the entire before/after of sensitive tables out of the regulated DB into PG, OpenSearch, Kafka, and backups. Masking "at the diff engine" still leaves `raw_before/raw_after JSONB` in `audit_events`. This **expands the regulated data perimeter and the breach blast radius**, and likely triggers its own GDPR/PCI scope. Under-addressed.

**H6 — No backpressure / poison-event / DLQ strategy.** One malformed event or a slow OpenSearch can stall consumers; Kafka retention then expires un-consumed source data → permanent audit gap. No dead-letter queue, no replay-from-snapshot story.

### MEDIUM

- **M1 — Schema evolution undefined.** DDL on a monitored table changes the shape of `before/after`. How does the diff engine, OpenSearch mapping, and reversal generator handle a renamed/dropped/typed-changed column mid-stream? Mapping explosions and reversal SQL referencing dead columns.
- **M2 — Clock trust.** `commit_ts` from the source DB drives off-hours rules and timeline forensics, but source clocks are attacker-influenceable and unsynced. No trusted-time / monotonic ingest watermark requirement.
- **M3 — Rule DSL is a build-a-language trap.** A JSONB "declarative rule engine" with windows/time-of-day/thresholds is a mini rules platform that will sprawl. Underestimated cost and a frequent source of false positives.
- **M4 — Backfill/snapshot impact on prod.** Initial Debezium snapshot of large financial tables can hammer the primary or replica. No throttling/incremental-snapshot plan.
- **M5 — No tenancy/segregation model** for monitoring multiple DBs of different sensitivity in one platform.

### LOW

- **L1 — i18n/RTL/dark mode prioritized alongside core integrity.** UX polish in MVP scope dilutes focus.
- **L2 — No event versioning in CCE** (`schema_version`), guaranteeing pain later.
- **L3 — Notification channels (Telegram/Slack) can leak sensitive diffs** to third-party SaaS; needs content-redaction policy.

---

## 3. Security Review (item-by-item)

| Component | Strengths | Weaknesses | Recommendations |
|---|---|---|---|
| **CDC architecture** | Log-based, out-of-band, read-only intent; replica-offload acknowledged | Fidelity downgrade undetected (C4); snapshot impact (M4); no source-config attestation; gap proof missing (C3) | Add a **source guardrail monitor** that alarms on `binlog_row_image`/`REPLICA IDENTITY`/supplemental-logging changes; implement GTID-set completeness reconciliation; pin retention > max outage. |
| **Debezium** | Mature, normalizes before/after, offset mgmt | Kafka Connect is itself a heavy, stateful, security-sensitive service holding DB creds; connector restarts can re-snapshot | Run Connect isolated, creds via Vault, disable REST config endpoints / lock them behind mTLS+RBAC; monitor connector lag/offset as a first-class SLO. |
| **Kafka/Redpanda** | Durable, replayable, ordered per partition | Holds plaintext financial before/after at rest in topics; partition-level ordering ≠ transaction ordering (H4); retention expiry = audit gap (H6) | Encrypt topics at rest + TLS in transit; per-topic ACLs; tune retention to outage budget; DLQ; consider tombstoning PII after sink-confirmed. |
| **Audit database** | Append-only intent, partitioning, JSONB | "Append-only" via revoked grants is **not immutability** — a DBA/superuser re-grants and edits; `raw_before/after` duplicates PII (H5) | Enforce immutability **outside** PG: write canonical evidence to **WORM object storage (S3 Object Lock / immutable)**; treat PG as a queryable *projection*, not the evidence of record. |
| **Reversal workflow** | Four-eyes, preview, MFA re-auth, append-only exec log | Write path into prod (C2); TOCTOU (H3); EDAM holds prod write creds | **Remove the executor from EDAM.** EDAM emits an *approved change request*; a separate, independently-governed change-execution service (or Kafel's own controlled API/runbook) performs the write. Separation of duties must be infrastructural, not just role-based. |
| **Hash chain** | Cheap tamper-evidence for accidental corruption | Self-anchored (C1); no external notarization; reorg on reprocessing breaks chain | Anchor periodically to an **independent trust domain**: RFC 3161 timestamping authority, public transparency log, or cross-signed WORM manifest. Sign chain heads with an HSM-held key EDAM operators can't extract. |
| **Authentication** | OIDC/Keycloak, JWT, refresh rotation | Keycloak is another HA-critical system; no mention of service-to-service auth (mTLS), no break-glass | Add mTLS between services; define break-glass with dual-control; short-lived tokens. |
| **RBAC** | Reasonable matrix, least privilege intent | `execute_reversal` for Admin (⚙️) violates SoD — admins shouldn't both configure and execute financial reversals | Hard-separate "platform admin" from "reversal executor"; no role should both define rules and approve reversals. |
| **MFA** | TOTP, re-auth before execution | TOTP is phishable; no FIDO2/WebAuthn for high-value actions | Require **phishing-resistant WebAuthn** for approve/execute on financial reversals. |
| **Secret management** | Vault, stores references not secrets | Vault becomes single point of compromise; no dynamic-cred / rotation cadence stated | Dynamic DB credentials with short TTL; auto-rotation; Vault audit device on. |
| **Backup strategy** | Encrypted, object-lock mentioned, tiered | Object-lock is "ideal," not mandatory; no integrity verification of backups; restore drills under-specified | Make **immutable, object-locked backups mandatory**; verify backup hash chains; scheduled, audited restore drills with sign-off. |
| **Disaster recovery** | RPO 15m / RTO 1h stated | No multi-region story for the *evidence*; losing EDAM during an incident loses the forensic record exactly when needed | Geo-replicate the WORM evidence store; DR specifically for the audit ledger, decoupled from the analytics tier. |

---

## 4. Database Architecture Review

**Verdict: it can support all six — but only MySQL/MariaDB and PostgreSQL are realistic for the first 12–18 months. The plan understates Oracle, SQL Server, and Mongo cost by an order of magnitude.**

| Engine | Realistic? | Hidden risks / unsupported assumptions / vendor challenges |
|---|---|---|
| **MySQL** | ✅ Strong | Assumes ROW+FULL (downgrade-able, C4); binlog lacks user identity (H1); snapshot impact (M4). Real but manageable. |
| **MariaDB** | ✅ Strong | GTID semantics diverge from MySQL; Debezium MariaDB support historically trails MySQL — treat as a *separate* adapter, not "same as MySQL." The plan's "same as MySQL" is an **unsupported assumption.** |
| **PostgreSQL** | ✅ Strong, with a loaded gun | Logical slot left unconsumed **fills WAL and can take down the primary** — this is an availability risk to the *monitored production system itself*. `REPLICA IDENTITY FULL` inflates WAL significantly on high-write financial tables. Needs hard slot-lag alarming and possibly a dedicated decoding replica. |
| **SQL Server** | ⚠️ Costly | CDC capture/cleanup jobs add prod load and ops; feature/edition variance; temporal tables are query-based, not streaming; identity capture needs SQL Server Audit. Underestimated. |
| **Oracle** | ❌ Hard / expensive | LogMiner is heavy and version-fragile; **Debezium-Oracle is the least stable connector**; GoldenGate is **separately licensed and expensive**. Supplemental logging must be enabled (config attestation problem again). This is a multi-quarter effort with licensing implications, not "one more adapter." |
| **MongoDB** | ⚠️ Different paradigm | Change streams need a replica set/sharded cluster; **before-image requires pre/post images enabled** (storage cost + must be on *before* the event, so retroactive forensics impossible); no transactions-as-rows model; "field-level diff" becomes JSON-path diff with array/embedded-doc ambiguity; **reversal of a document delete/update is semantically harder** (no clean compensating "UPDATE"). The canonical model (relational PK-centric) leaks here. |

**Cross-cutting unsupported assumptions:**
1. That one **Canonical Change Event** cleanly spans relational *and* document *and* multi-statement transactional semantics. It does not without a richer model (txn id, statement order, nested-path addressing).
2. That **reversal generation** is uniform across engines. Generating safe compensating writes for Oracle/Mongo/SQL Server is bespoke and dangerous per engine.
3. That enabling CDC is permission-only. On managed/cloud DBs (RDS, Aurora, Azure SQL, Cloud SQL, Atlas) the *available* CDC mechanisms and privileges differ sharply and may be unavailable.

---

## 5. Missing Enterprise Features

The plan is missing the following — several are mandatory, not "nice to have," for financial/banking-grade:

**Forensic / evidentiary (mandatory):**
- **Chain-of-custody** records (who accessed which evidence, when, why) — currently absent.
- **Immutable WORM object storage** as the *system of record* (currently optional).
- **External notarization / trusted timestamping** of hash-chain heads.
- **Legal hold** (freeze retention/deletion on specified records during litigation).
- **Audit evidence export packages** (signed, verifiable, court-presentable bundles).
- **Forensic replay** (reconstruct table/row state at an arbitrary past timestamp).

**Detection / SOC (high value):**
- **SIEM integration** (CEF/LEEF/OCSF export to Splunk/Sentinel/QRadar) — a SOC won't adopt a tool that doesn't feed the SIEM.
- **SOC workflow integration** (ticketing: ServiceNow/Jira, case management).
- **UEBA / behavioral baselining** beyond static rules.
- **AI/ML anomaly detection** (the plan is 100% static rules; high false-positive, easy to evade by staying under thresholds).
- **Insider-threat program hooks** (peer-group analytics, privilege-use baselining).

**Governance / compliance (mandatory for the stated domain):**
- **Data classification** taxonomy driving masking/retention/access.
- **Compliance reporting packs** (SOX, PCI-DSS, GDPR, SOC 2, ISO 27001 control mapping).
- **Retention policy engine** with regulatory presets and legal-hold override.
- **Segregation-of-duties attestation** reporting.
- **Privacy: right-to-erasure vs immutable-audit conflict resolution** (a genuine legal tension the plan ignores — you cannot both "never delete" and honor GDPR erasure without a documented reconciliation/crypto-shredding strategy).

**Platform:**
- **Multi-tenancy / data-domain isolation.**
- **High-availability design for the evidence tier** (not just RPO/RTO numbers).
- **Source-configuration attestation & drift alerting** (the C4 guardrail).
- **Self-monitoring / "who watches the watcher"** — EDAM's own tamper detection and health attestation to an external party.

---

## 6. Operational Review

**Deployment complexity:** Very high. The reference stack is **9 distributed systems** (Debezium/Connect, Redpanda/Kafka, PostgreSQL, OpenSearch, Redis, Vault, Keycloak, the app tier, K8s). Each is HA-critical, security-sensitive, and individually a specialist domain.

**DevOps burden:** Continuous. Kafka/Connect tuning, OpenSearch ILM/cluster health, slot-lag monitoring, connector lifecycle, Vault unseal/rotation, K8s upgrades. This is a platform-engineering commitment, not a deploy-and-forget tool.

**Infrastructure cost:** The streaming + search + secrets + identity stack is expensive to run HA. OpenSearch and Kafka alone dominate cost. Oracle/GoldenGate adds licensing.

**Maintenance:** Six adapters + six reversal generators + a rule DSL + i18n + RBAC/MFA = large, perpetual surface.

**Team-size estimates (realistic):**

| Stage | Team | Composition |
|---|---|---|
| **MVP (MySQL, read-only, no exec)** | **3–4** | 1 backend/CDC, 1 full-stack/frontend, 1 DB/data engineer, 0.5 security, 0.5 DevOps. |
| **Production (MySQL+Postgres, reversal, integrity)** | **7–10** | +dedicated SRE/platform, +security engineer, +SOC/detection engineer, +PM, +QA. |
| **Enterprise (6 DBs, SIEM, forensics, compliance)** | **15–25+** | Platform team (3–4), per-engine adapter owners, detection/UEBA team, forensics/compliance specialist, frontend team, 24/7 on-call SRE, security lead, product. |

The plan's implicit "a small team builds this" assumption is **unrealistic** past MVP.

---

## 7. Threat Model Review

| Threat | Attack path | Likelihood | Impact | Plan's mitigation? | Verdict / required mitigation |
|---|---|---|---|---|---|
| **Malicious DBA / admin** | Has superuser on Kafel DB → downgrades row image → edits ledger → (if also touches EDAM) re-grants on append-only tables, recomputes self-anchored hash chain | **High** (this is *the* threat) | **Catastrophic** | Partial — append-only grants + hash chain, both defeatable by this actor | **Insufficient.** Needs source-config attestation, external WORM evidence, externally-anchored/HSM-signed chain, native DB audit, and EDAM operated in a *different trust domain* than the DBA. |
| **Compromised application** | App creds used to write ledger via normal path | Medium | High | Good — EDAM observes out-of-band, captures the change | Adequate, *if* fidelity guardrail (C4) and gap-proof (C3) hold. |
| **Compromised DB user** | Stolen read/write creds make changes | Medium | High | Good for detection | Adequate; add attribution via native audit. |
| **Insider threat (analyst/approver)** | Approver colludes; or analyst abuses `reveal_sensitive`; admin self-grants `execute_reversal` | Medium | High | Partial — four-eyes, audited reveals | RBAC SoD gap (Admin can execute). Enforce hard SoD, WebAuthn, peer review of reveals, UEBA. |
| **Ransomware** | Encrypts EDAM PG/OpenSearch/backups | Medium | High | Weak — object-lock only "ideal" | **Mandatory** immutable/object-locked, geo-replicated evidence; offline copy. |
| **Deleted logs (source)** | Attacker purges binlog/WAL/redo before EDAM consumes | Medium | High | Weak — relies on retention | Pin retention > outage budget; alarm on log purge; stream to EDAM with minimal lag; completeness reconciliation. |
| **Database tampering (silent)** | Row-image downgrade then edit (C4); or direct datafile edit bypassing logs | High / Low | Catastrophic | None for downgrade; none for datafile | Source-config attestation; periodic full-table hash reconciliation vs EDAM state to catch out-of-band edits. |
| **Privilege escalation** | Gains rights to EDAM exec user or Vault | Low–Med | Catastrophic (C2) | None — exec user is a standing prod-write cred | **Remove standing write cred (C2);** dynamic short-TTL creds; HSM. |
| **Stolen credentials (EDAM)** | Phish analyst/approver TOTP | Medium | High | Partial — TOTP | WebAuthn for high-value actions; IP allowlist; anomaly on session. |

**Key finding:** the architecture is **strong against the compromised *application*** (its easy case) and **weak against the privileged *insider/DBA*** (its hard case — and the one that matters most for financial fraud). That inversion must be fixed before this is credible for banking-like systems.

---

## 8. Forensics Review

Would this stand up in an investigation, financial audit, legal dispute, or regulatory review? **Today: partially, and not in a hostile dispute.**

**Weaknesses for evidentiary use:**
1. **No chain-of-custody.** Who viewed/exported/handled evidence is not tracked. A defense attorney or regulator will challenge integrity immediately.
2. **Self-anchored hash chain (C1).** Cannot prove EDAM operators didn't alter records. Needs independent timestamping/notarization and HSM-signed heads to be defensible.
3. **No immutable system-of-record.** "Append-only via grants" is not WORM; a court expects demonstrable immutability (object-lock with retention, ideally externally witnessed).
4. **No completeness proof (C3).** Cannot affirmatively demonstrate "no events are missing" — fatal for "the ledger was/ wasn't tampered" conclusions.
5. **No point-in-time reconstruction (forensic replay).** Investigators need "show me row X as of timestamp T and every change since." Not designed.
6. **Clock trust (M2).** Timeline built on attacker-influenceable source timestamps; needs trusted/monotonic ingest time and ideally signed timestamps.
7. **Right-to-erasure vs immutability** unresolved — a regulator can fault either deleting evidence or retaining PII; needs a documented crypto-shredding/legal-hold reconciliation.
8. **Reversal as evidence contamination.** EDAM both *records* the ledger and *writes* to it (C2). A reversal performed by the audit system muddies "what was the original state" and creates an obvious challenge: the monitor altered the evidence it monitors.

**Bottom line:** good operational forensics, **inadequate evidentiary forensics** for legal/regulatory adversarial use without the changes above.

---

## 9. Recommended Architecture Changes (prioritized)

### Priority 1 — MUST do before implementation
1. **Externalize immutability & anchoring (fixes C1).** WORM object storage (Object Lock) as system-of-record; HSM-signed, externally-timestamped hash-chain heads. *Why:* without it, the platform's core promise is unprovable.
2. **Remove the reversal executor from EDAM (fixes C2).** EDAM produces approved change *requests*; a separate, independently-governed executor (or Kafel's own controlled path) applies them. *Why:* eliminates the catastrophic standing write credential and the evidence-contamination problem.
3. **Source-configuration attestation + completeness proof (fixes C3/C4).** Alarm on row-image/replica-identity/supplemental-logging/retention changes and log purges; reconcile GTID/LSN/SCN sets for gap detection. *Why:* defeats silent-downgrade and silent-gap tampering — the actual attacks.
4. **Native DB audit for attribution (fixes H1).** pgAudit / MySQL Enterprise/MariaDB Audit / SQL Server Audit / Oracle Unified Auditing feeding EDAM. *Why:* without human-user attribution the insider/DBA case fails.
5. **Define transaction-grouped CCE v1 with `schema_version`, txn id, statement order, nested-path addressing (fixes H4/M1/L2).** *Why:* the canonical contract is the foundation; getting it wrong is the most expensive future mistake.
6. **Establish trust domains & SoD infrastructurally.** EDAM operated by a different team/identity plane than the DBAs it audits; hard-split platform-admin vs reversal-approver vs executor. *Why:* the threat model demands it.

### Priority 2 — SHOULD do
7. WebAuthn (phishing-resistant) for approve/execute on financial reversals.
8. DLQ + poison-event handling + replay-from-snapshot (H6).
9. Define OpenSearch as a disposable projection; PG/WORM as truth (H2).
10. Optimistic-concurrency reversal (full after-image match) to kill TOCTOU (H3).
11. SIEM/OCSF egress + ticketing integration (SOC adoption).
12. Data-classification-driven masking/retention; resolve erasure-vs-immutability (crypto-shredding).
13. Backpressure-safe snapshotting / incremental snapshots (M4); slot-lag hard alarms (Postgres availability).
14. Forensic replay (point-in-time reconstruction) + chain-of-custody + legal hold + signed evidence export.

### Priority 3 — Future
15. UEBA / ML anomaly detection layered over the rule engine.
16. Multi-tenancy / data-domain isolation.
17. Additional engines (SQL Server → Oracle → Mongo) each behind a conformance suite, with Oracle/Mongo explicitly re-scoped as major efforts.
18. Compliance reporting packs (SOX/PCI/SOC2/ISO).

---

## 10. Simplification Review

**Overengineered / premature for MVP:**
- **Six CDC adapters & six reversal generators** — MVP needs exactly one (MySQL), read-only, *no* reversal generator.
- **Redpanda/Kafka** — for a single MySQL source at MVP volumes, a durable queue is overkill; Debezium can sink directly, or use Debezium Server / a single lightweight stream. Introduce Kafka when you have ≥2 sources or real throughput.
- **OpenSearch** — not needed for MVP; PostgreSQL (with proper indexes + partitioning) serves search/filter at MVP scale. OpenSearch is a large ops cost added too early.
- **Keycloak** — full IdP is heavy; MVP can use a single OIDC provider or a minimal auth service with TOTP; add Keycloak/SSO at enterprise stage.
- **Rule DSL (JSONB language)** — start with a handful of *hard-coded, unit-tested* rules; do not build a configurable rule engine until rules stabilize.
- **i18n/RTL/dark-mode in MVP** — defer; integrity correctness > theming.
- **The whole reversal execution path** — MVP should be **propose-only**, no write path at all (the plan even half-says this, then keeps the exec user — pick the safe option).

**Leaner MVP architecture (what I'd actually build first):**
```
Kafel MySQL (replica, ROW+FULL)
   └─ Debezium (single connector, creds in Vault/secret store)
        └─ Debezium Server / direct sink  ──►  Ingest worker (Node/NestJS)
              ├─ Field-Level Diff (canonical event v1, txn-grouped)
              ├─ Source-config + completeness watchdog  (P1 guardrail)
              ├─ 4–6 hard-coded risk rules
              └─ writers:
                   • PostgreSQL (partitioned, append-only projection)
                   • WORM object storage (Object Lock) = system of record  ← keep this even in MVP
                   • Hash-chain head signed + externally timestamped         ← keep this even in MVP
   Dashboard: React/Vite — Overview + Live Changes + Diff viewer (SSE)
   Auth: single OIDC + TOTP, IP allowlist
   NO Kafka, NO OpenSearch, NO Keycloak, NO reversal execution, NO multi-DB.
```
Two things I would **not** strip even from MVP: **immutable WORM evidence** and **externally-anchored signed hash heads** — because they are the difference between "an audit tool" and "evidence." Everything else can wait.

---

## 11. Production Architecture Recommendation (what I would approve)

### Updated diagram (text)
```
   MONITORED DBs (prod, untouched)            INDEPENDENT TRUST DOMAIN (EDAM)
   ┌───────────────────────────┐
   │ MySQL/PG (replica) +      │  log CDC   ┌───────────────────────────────────────┐
   │ NATIVE DB AUDIT (pgAudit/ │──────────► │ Collector + Source-Config Attestation  │
   │ MySQL Audit) for identity │            │ + Completeness/Gap Prover (GTID/LSN)   │
   └───────────────────────────┘            └───────────────┬───────────────────────┘
                                                            ▼
                                            ┌───────────────────────────────┐
                                            │ Durable bus (Kafka/Redpanda)  │ (prod scale only)
                                            │ encrypted, ACLs, DLQ          │
                                            └───────────────┬───────────────┘
                                                            ▼
                                  ┌──────────────────────────────────────────────┐
                                  │ Audit Processing (idempotent, txn-grouped)    │
                                  │ Diff │ Risk(rules+UEBA) │ Classification │     │
                                  └───┬─────────────┬───────────────┬────────────┘
                                      ▼             ▼               ▼
                       ┌───────────────────┐ ┌──────────────┐ ┌────────────────────────┐
                       │ WORM Object Store  │ │ PostgreSQL   │ │ OpenSearch (disposable │
                       │ = SYSTEM OF RECORD │ │ (queryable   │ │ projection / search)   │
                       │ Object-Lock, geo   │ │ projection)  │ └────────────────────────┘
                       │ HSM-signed +       │ └──────────────┘
                       │ RFC3161 timestamp  │
                       │ chain heads        │
                       └─────────┬──────────┘
                                 │ evidence export / chain-of-custody / legal hold
                                 ▼
        SIEM/SOC (OCSF) ◄── Alerting ──► Notifications     Dashboard (React) + Auth(OIDC+WebAuthn, SoD)
                                                              │ approved change REQUEST (no write)
                                                              ▼
                                 ┌───────────────────────────────────────────────┐
                                 │ SEPARATE Change-Execution Service              │
                                 │ (different trust domain & approvers; dynamic   │
                                 │  short-TTL creds from Vault/HSM; optimistic    │
                                 │  concurrency; writes approved reversals only)  │
                                 └───────────────────────────────────────────────┘
```

### Updated component list (deltas from original)
- **Added:** Source-Config Attestation & Completeness Prover; Native DB Audit ingestion; **WORM object store as system-of-record**; HSM + RFC 3161 external timestamping; **separate Change-Execution Service** (executor removed from EDAM); SIEM/OCSF egress; chain-of-custody, legal hold, evidence export, forensic replay; data classification; UEBA layer.
- **Demoted:** OpenSearch → disposable projection; PostgreSQL → queryable projection (not truth); rule DSL → start hard-coded.
- **Removed from EDAM:** standing prod write credential.

### Updated security model
Two trust domains (Audit vs Execution), each separate from the DBA/operations domain. Read-only CDC + native audit in; **no write-back from the monitor**; dynamic short-TTL creds for the separate executor; WebAuthn for high-value actions; mTLS service mesh; HSM-held signing keys; immutable, externally-anchored, geo-replicated evidence.

### Updated database model
WORM object store holds the canonical, signed, timestamped evidence (immutable, retention-locked, legal-hold capable). PostgreSQL and OpenSearch are *rebuildable projections* for query/search, explicitly not trusted as evidence. PG remains partitioned/append-only as defense-in-depth, not as the integrity guarantee.

### Updated operational model
Phase the stack: MVP runs without Kafka/OpenSearch/Keycloak. Introduce streaming/search/IdP only at production scale with a dedicated platform/SRE function. Mandatory: slot-lag and connector-lag SLOs, source-config drift alarms, audited restore drills, DR for the evidence tier specifically. Team sized per §6 (don't pretend MVP staffing scales to enterprise).

---

## 12. Final Verdict

### **APPROVE WITH CHANGES**

**Justification.** The fundamental architecture is *correct in shape*: out-of-band log-based CDC, a canonical event abstraction for multi-DB, append-only auditing with hash chaining, and a human-gated reversal workflow are the right primitives, and the document is genuinely above the quality bar for an initial design. It is not a reject — the bones are sound and the multi-DB adapter strategy is the right answer to the stated question.

But it is **emphatically not an approve as-is** for anything financial/banking-like, because it currently fails against its own headline adversary. Four issues are blocking and must be resolved before a line of production code:

1. **Self-anchored hash chain (C1)** — the integrity guarantee is unprovable against the operators it's meant to police. Without external WORM + anchoring, this is security theater for forensic purposes.
2. **Reversal executor inside EDAM (C2)** — a standing, pre-approved write credential into the financial database, sitting inside the most-attacked component, contaminating the very evidence it collects. Must be externalized.
3. **No completeness proof + silent fidelity downgrade (C3/C4)** — "no missed events" and "full field diff" are assumed, not enforced, and both are trivially defeated by a privileged insider. The platform must *attest* to source configuration and *prove* stream completeness.
4. **DBA attribution gap (H1)** — without native DB audit, the system is blind to the exact actor (privileged insider) who poses the greatest financial-fraud risk.

Fix Priority-1 (§9) and the design crosses from "good internal monitoring tool" to "defensible enterprise audit platform." Ship the leaner MVP (§10) — read-only, propose-only, but *with* WORM evidence and anchored signing from day one — and grow into the production architecture (§11). Until C1–C4 and H1 are designed-in, **I would block production deployment for any high-value transaction system.**

---

*Review complete. This document critiques the design; it does not modify the plan or any application code.*
