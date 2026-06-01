# EDAM v2 — Implementation-Ready Architecture
### External Database Audit Monitor · Revision 2.0

> **Purpose:** Resolve every Priority-1 blocker from the adversarial review (`docs/EDAM-Architecture-Review.md`) *before* any code is written. This supersedes the architecture decisions in `docs/External-Database-Audit-Monitor-Plan.md` (v1) where they conflict; v1 remains the product/UX reference.
> **Status:** Planning only — no implementation code. v1 plan and the review are unmodified.
> **Threat horizon:** financial / donation / banking-like / high-value transaction platforms.
> **Date:** 2026-06-01

---

## 0. What changed from v1 (blocker resolution map)

| Blocker (from review) | v1 behaviour | v2 resolution | Section |
|---|---|---|---|
| **C1 — self-anchored hash chain** | Chain lives in EDAM's own PostgreSQL; operators can recompute | WORM object store becomes **system of record**; chain heads **HSM-signed** and **externally timestamped (RFC 3161)**; PostgreSQL demoted to **rebuildable projection** | §2 |
| **C2 — reversal executor inside EDAM** | EDAM holds standing write credential into Kafel | EDAM emits **approved reversal *requests* only**; a **separate Change Execution Service** in a different trust domain applies them with **short-lived dynamic creds** + **optimistic concurrency** | §3 |
| **C3/C4 — completeness & fidelity** | "No missed events" asserted; row-image downgrade undetected | **Source-Configuration Attestation Monitor** + **Completeness Prover** (GTID continuity); fidelity-degradation alarms | §4 |
| **H1 — DBA attribution gap** | "Correlate with app logs" hand-wave | **Native DB Audit collector** correlated to CDC; explicit statement of attribution limits | §5 |
| **Canonical model too thin** | Per-row event only | **Canonical Change Event v1**: transaction-grouped, ordered, versioned, with evidence hashes + nested-path addressing | §6 |
| **MVP overengineered** | Kafka/OpenSearch/Keycloak/reversal-exec in MVP | Lean MVP: MySQL-only, read-only, no exec; **WORM + anchoring kept from day one** | §7 |

**Non-negotiable invariants for v2:**
1. EDAM **never writes** to the monitored (Kafel) database. Ever. There is no code path, credential, or role inside EDAM that can.
2. The **evidence of record is immutable** and its integrity is provable **without trusting EDAM's operators**.
3. The system can **prove completeness** (no silently missed events) and **attest fidelity** (before/after images are genuinely full), or it raises an integrity alarm.

---

## 1. Trust Domains (foundational)

Everything in v2 is organized around **four separate trust domains**. Separation is *infrastructural* (different identities, networks, key custodians, and ideally different operators), not merely role labels.

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ DOMAIN A — MONITORED (Kafel)            DOMAIN B — AUDIT (EDAM core)           │
 │ owned by: Kafel DBA/ops                 owned by: Security/Audit team          │
 │ Kafel MySQL primary + replica           CDC collector, attestation, audit       │
 │ Native DB audit source                  collector, ingest, diff, risk,          │
 │ (read-only egress only)                 PG projection, dashboard API            │
 │                                         CANNOT write to Domain A.               │
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ DOMAIN C — EVIDENCE (immutable)         DOMAIN D — EXECUTION (change service)   │
 │ owned by: Compliance/custodian          owned by: separate ops + dual-control   │
 │ WORM object store (Object Lock),        Change Execution Service.               │
 │ HSM signing, external timestamp         Holds NO standing creds; fetches        │
 │ authority. Write-once; EDAM core can     short-lived dynamic creds AFTER         │
 │ append but not mutate/delete.            approval to write approved reversals.   │
 └──────────────────────────────────────────────────────────────────────────────┘
```

Why four: the review's core finding was that v1 was strong against a compromised *application* but weak against a privileged *insider/DBA*. Splitting evidence custody (C) and write-execution (D) away from the audit core (B) — and all three away from the monitored estate (A) — is what makes insider tampering detectable and non-repudiable.

---

## 2. Fix C1 — Integrity Model Redesign (WORM + external anchoring)

### 2.1 Principle
**The hash chain must be verifiable by someone who does not trust EDAM.** Achieved by making the canonical evidence (a) immutable at the storage layer, (b) signed by a key EDAM operators cannot extract, and (c) timestamped by an external authority EDAM does not control.

### 2.2 Layered integrity

```
 Canonical Change Event (CCE)                         (mutable in flight only)
        │  computes event_hash = SHA-256(canonical_serialization(CCE_core))
        ▼
 Hash chain:  row_hash[n] = SHA-256( row_hash[n-1] ‖ event_hash[n] )
        │
        ├──► WORM Object Store (Domain C) = SYSTEM OF RECORD
        │       • each CCE written once as an immutable object (Object Lock,
        │         COMPLIANCE-mode retention; no delete/overwrite even by root)
        │       • objects grouped into sealed, ordered "evidence segments"
        │
        ├──► PostgreSQL projection (Domain B) = QUERYABLE COPY ONLY
        │       • rebuildable at any time by replaying the WORM segments
        │       • if PG and WORM disagree, WORM wins; PG is treated as cache
        │
        └──► Periodic CHAIN-HEAD ANCHORING (every N events or T minutes):
                 head = row_hash[latest]
                 signature = HSM_sign(head ‖ segment_manifest)      (Domain C key)
                 token     = RFC3161_timestamp(head ‖ signature)    (external TSA)
                 anchor_record = { head, segment_id, signature, tsa_token, count }
                 → written to WORM (immutable) AND optionally published to an
                   external transparency log / second custodian.
```

### 2.3 Component roles
- **Hash chaining (Ingest worker, Domain B):** computes `event_hash` and `row_hash` deterministically. Chain order is defined by **(transaction commit order, then statement order within txn)** — not by ingest arrival — so reprocessing yields the *same* chain (fixes the v1 "reorg breaks the chain" problem).
- **WORM object store (Domain C):** S3 Object Lock (or Azure Immutable Blob / equivalent) in **compliance mode**. EDAM core has an **append-only writer** identity; **no identity** (including EDAM admins) can mutate or delete within the retention window. This is the legal/forensic system of record.
- **HSM / signing service (Domain C):** signs chain-head anchors. Private key is **non-exportable**, custodied by Compliance, not by EDAM operators. Compromising EDAM does not yield the signing key.
- **External Timestamp Authority (RFC 3161):** independent TSA returns a signed timestamp token over the head+signature. This proves *when* the head existed and that it has not been back-dated. If an air-gapped/no-internet posture is required, the equivalent is a **second-custodian co-signing** or a **public blockchain/transparency-log anchor**; the design treats "external timestamp" as a pluggable **Anchor Provider** interface (RFC3161 | TransparencyLog | DualCustodian).

### 2.4 What stays in PostgreSQL (projection only)
- Query/filter/aggregation tables (`audit_events`, `audit_field_changes`, alerts, reversal workflow state, RBAC).
- **Explicitly NOT the integrity guarantee.** PG rows carry `row_hash` for convenience, but verification always recomputes from WORM. PG can be dropped and rebuilt from WORM with zero evidentiary loss.
- Append-only grants on PG remain as defense-in-depth, *not* as the integrity claim.

### 2.5 Verification (continuous + on-demand)
- **Daily verifier** replays WORM segments, recomputes the chain, checks each anchor's HSM signature and TSA token, and confirms the latest head matches. Produces a signed **Integrity Report**.
- **Independent verifier** can be run by an auditor with only: WORM read access + the HSM public key + the TSA's public cert. **No EDAM software trust required** — this is the property v1 lacked.

---

## 3. Fix C2 — Reversal Model Redesign (no write path in EDAM)

### 3.1 Principle
EDAM **produces an approved, signed reversal *request*** — a description of an intended change plus its approvals and the captured before/after images. It **never executes**. A physically and organizationally separate **Change Execution Service (CES, Domain D)** is the only thing that can write to Kafel, and only under strict preconditions.

### 3.2 Flow

```
 (Domain B — EDAM)                                  (Domain D — CES)
 Analyst opens reversal request
   │  request references audit_event (CCE), includes:
   │   - target table + PK
   │   - captured before-image + captured after-image (full)
   │   - proposed intent (restore before-image)
   │   - reason
   ▼
 Approval (RBAC + WebAuthn):
   - non-critical: 1 approver (≠ requester)
   - critical financial: FOUR-EYES, 2 distinct approvers (≠ requester)
   ▼
 EDAM emits SIGNED ReversalDirective  ───────────►  CES validates signature (EDAM pub key)
   (HSM-signed; contains before/after            │   AND approval quorum AND expiry window
    images, approver IDs, expiry, nonce)          ▼
                                          CES requests SHORT-LIVED dynamic credential
                                          from Vault (TTL minutes, scoped to the exact
                                          table; INSERT/UPDATE/DELETE only on whitelist)
                                                  ▼
                                          CES executes inside ONE transaction with
                                          OPTIMISTIC CONCURRENCY:
                                            UPDATE ... SET <before-image fields>
                                            WHERE pk = <pk>
                                              AND <every column> = <captured AFTER-image>
                                          → affected_rows = 1  → commit
                                          → affected_rows = 0  → ABORT (row drifted);
                                            return DRIFT_CONFLICT to EDAM, no write
                                                  ▼
                                          CES emits SIGNED ExecutionResult back to EDAM
                                          (success/drift/failure, affected_rows, post-state)
                                                  ▼
 EDAM records ExecutionResult as a new CCE (the reversal itself is audited),
 verifies post-state, updates reversal_execution_logs (append-only → WORM).
```

### 3.3 Key properties
- **EDAM holds no Kafel write credential.** None. Credentials are dynamic, short-TTL, issued by Vault to **CES only**, **only after** a valid signed directive with quorum is presented.
- **Optimistic concurrency on the full after-image** (not just PK, not a separate re-read) makes execution atomic and kills the v1 TOCTOU race: if the row changed at all since capture, the `WHERE` matches zero rows and the reversal safely no-ops with a `DRIFT_CONFLICT`.
- **Directives expire** (short window) and carry a **nonce** to prevent replay.
- **CES is in a different trust domain** with its own dual-control operators — so compromising EDAM does not grant Kafel write access, and the reversal can't silently contaminate evidence (every execution is itself captured as a CCE by the normal CDC path *and* recorded as a signed ExecutionResult).
- **For non-SQL engines (future Mongo):** the directive carries a structured compensating operation + a precondition document equality check instead of a SQL `WHERE`.

---

## 4. Fix C3/C4 — Completeness Proof & Source-Fidelity Attestation

### 4.1 Source-Configuration Attestation Monitor (Domain B, read-only)
Continuously samples the source DB's audit-critical settings and alarms on any change. For MySQL/MariaDB it watches:

| Setting | Required value | Why it matters | On violation |
|---|---|---|---|
| `binlog_format` | `ROW` | STATEMENT/MIXED loses field-level before/after | **CRITICAL alarm**, mark stream fidelity = DEGRADED |
| `binlog_row_image` | `FULL` | MINIMAL/NOBLOB drops unchanged columns / before-image | **CRITICAL alarm** (this is the C4 silent-downgrade attack) |
| `gtid_mode` / GTID enabled | `ON` | needed for continuity/completeness proof | **CRITICAL alarm** |
| `binlog_expire_logs_seconds` (retention) | > max tolerated outage | short retention = purged-before-read gap | **HIGH alarm** if below threshold |
| `log_bin` | `ON` | no binlog = no CDC at all | **CRITICAL alarm** |
| `server_uuid` / topology | stable / expected | replica swap can reset offsets | **HIGH alarm** |

Each sample is recorded as a **source_config snapshot** and embedded into every CCE (§6) so the fidelity context of *every* event is provable after the fact ("at the moment of this change, row_image was FULL").

### 4.2 Completeness Prover (Domain B)
Proves *no events were silently missed*:
- **GTID continuity:** EDAM tracks the executed-GTID-set it has consumed. It periodically reads the source's `gtid_executed` and computes the **gap set** = source − consumed. A non-empty, non-in-flight gap → **completeness alarm**.
- **Heartbeat watermark:** a low-rate heartbeat (Debezium heartbeat or a tiny writer table) provides a monotonic "we are caught up to T" watermark even when monitored tables are idle, distinguishing "quiet" from "stalled/disconnected."
- **Connector-lag & replica-lag SLOs:** `Seconds_Behind_Source`, connector offset lag, and ingest lag are first-class metrics with alarm thresholds.
- **Snapshot↔stream handoff proof:** initial snapshot records the GTID at snapshot start/end; streaming must resume exactly at that GTID with no gap, logged as an explicit handoff event.

### 4.3 Fidelity state machine
Every monitored stream has a fidelity state stamped onto its events and shown on the dashboard:

```
 HEALTHY ──(config drift / gap / lag breach)──► DEGRADED ──(loss confirmed)──► COMPROMISED
    ▲                                               │
    └──────────────(operator-acknowledged recovery + gap backfilled)──────────┘
```
`DEGRADED`/`COMPROMISED` raise alerts and are **recorded in the evidence chain**, so a later investigation can see exactly when fidelity was not guaranteed — far stronger than v1's silent green.

---

## 5. Fix H1 — DBA Attribution via Native DB Audit

### 5.1 Native DB Audit collector (Domain B, read-only)
CDC tells you *what changed*; native DB audit tells you *who/where/how*. v2 ingests both and correlates.

For **MySQL/MariaDB**, evaluated options:

| Source | Captures | Pros | Cons / limits |
|---|---|---|---|
| **MySQL Enterprise Audit** (plugin) | connect/query/user/host | rich, supported | Enterprise edition only (licensed) |
| **MariaDB Audit Plugin** (`server_audit`) | connect/query/user/host/object | free, MariaDB & MySQL-compatible | log parsing; performance tuning needed |
| **Percona audit log plugin** | similar to above | free, JSON output | community support |
| **Cloud provider audit logs** (RDS/Aurora/CloudSQL) | connection + query audit | managed, no plugin | format varies; may exclude some events; egress/IAM setup |

**Selection rule:** pick the one that matches Kafel's actual deployment (self-managed MariaDB → MariaDB Audit Plugin; managed → cloud audit logs). The collector normalizes all into a **DB-Audit Event** with `{db_user, client_host, connection_id, statement_digest, ts}`.

### 5.2 Correlation
CDC CCEs and DB-Audit events are joined on **connection_id + transaction time window + table** (and GTID/thread id where available) to attribute a row change to a DB session and human/service account. The correlation confidence is recorded (`exact | probable | unattributed`).

### 5.3 Honest limits (stated, not hidden)
- Binlog itself does not carry the human identity; attribution depends on the **separate** audit feed being enabled and intact.
- A privileged actor who can disable/clear the native audit log can break attribution — which is exactly why the **Attestation Monitor (§4) also watches that the audit plugin is loaded and logging**, and why audit egress is **one-way to Domain B** (the DBA in Domain A can't reach into EDAM to delete it).
- **Out-of-band edits that bypass the SQL layer entirely** (e.g., direct datafile manipulation, `mysqlbinlog`-replayed forgery) cannot be attributed and may not even appear as normal CDC — mitigated only by periodic **full-table hash reconciliation** (compare EDAM's reconstructed state vs a fresh read) flagged as a future enhancement.
- **Conclusion:** EDAM provides *strong probabilistic attribution for SQL-layer changes* and *detects* tampering of the attribution source — but cannot guarantee identity for an actor with OS/filesystem-level access to the DB host. This limit must be communicated to stakeholders.

---

## 6. Canonical Change Event (CCE) v1 — the contract

Transaction-grouped, ordered, versioned, evidence-bearing, and forward-compatible with MongoDB. **Everything downstream consumes only CCEs.**

### 6.1 Transaction envelope
```jsonc
{
  "schema_version": "cce-1.0",
  "envelope_id": "uuid",
  "kind": "transaction",
  "source": {
    "db_id": "kafel-prod-mysql",
    "engine": "mysql",                 // mysql|mariadb|postgres|sqlserver|oracle|mongodb
    "server_uuid": "…",
    "schema": "kafel"
  },
  "transaction": {
    "tx_id": "gtid:3E11FA47-…:152",    // GTID (mysql) | LSN range (pg) | SCN (oracle) | txnNumber (mongo)
    "commit_ts": "2026-06-01T10:22:31.114Z",   // source-reported
    "ingest_ts": "2026-06-01T10:22:31.480Z",   // EDAM monotonic/trusted
    "statement_count": 2
  },
  "offset": { "gtid_executed_at_commit": "…", "binlog_file": "…", "binlog_pos": 99812,
              "lsn": null, "scn": null, "resume_token": null },
  "fidelity": {                        // §4 — provable context of capture
    "state": "HEALTHY",                // HEALTHY|DEGRADED|COMPROMISED
    "source_config": { "binlog_format": "ROW", "binlog_row_image": "FULL",
                       "gtid_mode": "ON", "log_bin": "ON",
                       "config_snapshot_id": "cfg-2026-06-01T10:00Z" }
  },
  "actor": {                           // §5 — correlated attribution
    "db_user": "app_user",
    "client_host": "10.0.0.5",
    "connection_id": "338217",
    "attribution_confidence": "probable",   // exact|probable|unattributed
    "audit_event_ref": "dbaudit:…"
  },
  "changes": [ /* ordered statements/rows — see 6.2 */ ],
  "evidence": {
    "envelope_hash": "sha256:…",       // hash over canonical(envelope minus evidence)
    "prev_row_hash": "sha256:…",
    "row_hash": "sha256:…",            // chain link (§2)
    "worm_object_key": "evidence/2026/06/01/seg-000142/…"
  }
}
```

### 6.2 Ordered change items (row + nested-path ready)
```jsonc
{
  "seq": 0,                            // event order WITHIN the transaction
  "operation": "UPDATE",              // INSERT|UPDATE|DELETE|DDL|TRUNCATE
  "object": {                          // table (relational) or collection (mongo)
    "schema": "kafel", "name": "donations",
    "primary_key": { "id": 90211 }
  },
  "before": { "amount": 100.00, "status": "approved" },   // null for INSERT
  "after":  { "amount": 100000.00, "status": "approved" },// null for DELETE
  "field_changes": [
    { "path": ["amount"], "old": 100.00, "new": 100000.00,
      "data_type": "decimal", "sensitive": false, "changed": true }
    // nested-path addressing makes documents first-class for future Mongo:
    // { "path": ["beneficiary","contact","iban"], "old": "***", "new": "***",
    //   "data_type":"string", "sensitive": true, "masked": true, "changed": true }
  ]
}
```

### 6.3 Notes
- **Chain order** = (commit_ts, then `seq`) → deterministic, reprocessing-safe.
- **`schema_version`** present from day one; consumers must reject unknown major versions.
- **Masking** applied before WORM write for sensitive paths; raw sensitive values are **never** placed in PG; if regulatorily required, sensitive before/after are stored only in WORM under stricter access + crypto-shredding capability for erasure reconciliation.
- **Nested `path` arrays** mean relational (single-element path) and document (multi-element path) changes share one representation — the multi-DB seam the review demanded.

---

## 7. MVP Scope (v2 — lean but evidence-grade from day one)

### In scope
- **MySQL/MariaDB only**, monitoring a **selected set of sensitive/financial tables**.
- **Read-only** CDC (ROW + FULL) off a **replica**.
- **Source-Configuration Attestation + Completeness Prover** (§4) — *not* optional; they are the integrity backbone.
- **Native DB Audit collector** (§5) for attribution.
- **Canonical Change Event v1** (§6).
- **Field-level diff** + **WORM evidence store + HSM-signed, externally-timestamped chain heads** (§2) — **kept from day one**.
- **PostgreSQL projection** for query/filter/dashboard only.
- **Dashboard:** Overview + Live Changes + Diff viewer (SSE).
- **Risk:** 4–6 **hard-coded, unit-tested** rules (donation-amount-after-approval, wallet-balance-edit, beneficiary-delete-with-balance, delete-on-financial-table).
- **Reversal:** **request creation only** (propose + approve), **no execution** in MVP.
- Auth: single OIDC + TOTP, IP allowlist, mTLS between services.

### Explicitly OUT of MVP (deferred, with justification)
| Deferred | Why |
|---|---|
| **Kafka / Redpanda** | One MySQL source at MVP volume: Debezium-Server/direct sink suffices. Add a bus at ≥2 sources or real throughput. |
| **OpenSearch** | PostgreSQL (partitioned + indexed) covers MVP search/filter. Avoid a heavy search cluster early. |
| **Keycloak / full IdP** | Single OIDC + TOTP is enough; add SSO/Keycloak at enterprise stage. |
| **Change Execution Service** | MVP is propose-only; CES (Domain D) arrives Phase 6 — no Kafel write path exists until then. |
| **Multi-database (PG/SQL Server/Oracle/Mongo)** | Prove the model on MySQL first; PG is Phase 7. |
| **AI / UEBA** | Static rules first; behavioral layer only after baselines exist and false-positive data is collected. |

> The single most important MVP guarantee: **observe, attest, prove-complete, diff, alert, propose — never write — with immutable, externally-anchored evidence.**

---

## 8. Architecture Diagram (v2)

```
 DOMAIN A — MONITORED (Kafel, untouched)         DOMAIN B — AUDIT (EDAM core)
 ┌───────────────────────────────┐
 │ Kafel MySQL PRIMARY            │
 │        │ replicates            │
 │        ▼                       │  ROW+FULL binlog (read-only)
 │ Kafel MySQL REPLICA  ──────────┼───────────────► ┌──────────────────────────┐
 │                                │                  │ CDC Collector (Debezium)  │
 │ Native DB Audit (MariaDB/      │  audit log feed  └─────────────┬────────────┘
 │ Enterprise/Percona/cloud) ─────┼──────────────►  ┌──────────────▼───────────┐
 │                                │  (one-way egress)│ Native DB Audit Collector │
 │ live settings (read-only) ─────┼──────────────►  ┌──────────────▼───────────┐
 └───────────────────────────────┘                  │ Source-Config Attestation │
                                                     │ Monitor + Completeness    │
                                                     │ Prover (GTID/lag/heartbt) │
                                                     └──────────────┬───────────┘
                                                                    ▼
                                                     ┌──────────────────────────┐
                                                     │ INGEST WORKER             │
                                                     │  • build CCE v1 (txn-grp) │
                                                     │  • field-level diff       │
                                                     │  • attribution correlate  │
                                                     │  • risk rules (hard-coded)│
                                                     │  • hash-chain compute     │
                                                     └───┬───────────────┬───────┘
                                                         │               │
        DOMAIN C — EVIDENCE (immutable)                  │               │
        ┌────────────────────────────────┐              │               ▼
        │ WORM Object Store (Object Lock) │◄─────append──┘     ┌───────────────────────┐
        │  = SYSTEM OF RECORD             │                    │ PostgreSQL PROJECTION │
        │ HSM Signing Service (non-export)│◄─sign heads──┐     │ (query/filter only,   │
        │ External Timestamp Authority    │◄─RFC3161─┐   │     │  rebuildable from WORM)│
        │ (or DualCustodian/TransparencyLog)         │   │     └───────────┬───────────┘
        └────────────────────────────────┘           │   │                 ▼
                    ▲ independent verifier            │   │     ┌───────────────────────┐
                    │ (auditor needs only WORM +      │   │     │ API + Realtime (SSE) + │
                    │  HSM pubkey + TSA cert)         │   └─────┤ Auth(OIDC+TOTP→WebAuthn│
                                                      │         │ for critical) + RBAC   │
                                                      │         └───────────┬───────────┘
                                                      │                     ▼
                                                      │           ┌───────────────────────┐
                                                      │           │ DASHBOARD (React/Vite) │
                                                      │           │ Overview│Live│Diff│    │
                                                      │           │ Reversal REQUESTS only │
                                                      │           └───────────┬───────────┘
                                                      │            signed ReversalDirective
                                                      │            (approved, four-eyes)
                                                      │                       ▼
 DOMAIN D — EXECUTION (separate, dual-control)        │           ┌───────────────────────┐
 ┌────────────────────────────────────────────┐      └──verify──►│ Change Execution Svc   │
 │ CES: validates EDAM signature + quorum,     │                  │ (Phase 6+)             │
 │ pulls SHORT-LIVED dynamic cred from Vault,  │  approved write   └──────────┬────────────┘
 │ optimistic-concurrency UPDATE (full after-  │   (whitelist tbls)           │
 │ image match), one txn, emits ExecutionResult│──────────────────────────────┘
 └─────────────────────────────────────────────┘        writes ONLY to Kafel primary
        (NO standing credential; nothing in Domain B can write to Domain A)
```

---

## 9. Security Model (v2)

| Control | v2 specification |
|---|---|
| **Trust domains** | A (monitored), B (audit core), C (evidence/custody), D (execution) — separate identities/networks/key custodians (§1). |
| **Separation of duties** | Requester ≠ approver; approver ≠ executor; platform-admin ≠ reversal-approver ≠ evidence-custodian. No single role spans define-rule + approve + execute. CES operated by a different team than EDAM. |
| **No write path in EDAM** | EDAM holds zero Kafel write credentials. Only CES (Domain D) writes, via short-TTL dynamic creds issued post-approval. |
| **RBAC** | Roles: Auditor (read), Analyst (investigate/propose), Approver, Compliance/Custodian, Platform-Admin, CES-Operator. Least privilege; `reveal_sensitive` audited; Admin **cannot** execute reversals. |
| **WebAuthn** | Phishing-resistant WebAuthn **required** for approve/execute on critical financial reversals (TOTP acceptable for lower-risk actions). |
| **IP allowlisting** | Dashboard/API and CES reachable only from allowlisted ranges/VPN. |
| **mTLS** | Mutual TLS between all EDAM services and to CES; service identities via SPIFFE/cert. |
| **Secret rotation** | Vault dynamic secrets; CES creds TTL minutes; rotation cadence enforced; Vault audit device on; HSM keys non-exportable. |
| **Immutable backups** | WORM is primary; backups of PG projection are encrypted + object-locked; WORM geo-replicated to a second region/custodian; restore drills audited. |
| **Chain-of-custody** | Every access/export/handling of evidence is itself logged (append-only → WORM): who, when, why, what object. |
| **Legal hold** | Hold flag freezes retention/deletion on specified records/segments regardless of retention policy; lift requires dual-control. |
| **Evidence export** | Signed, verifiable export bundles (CCEs + chain + anchors + verification instructions) reproducible by an independent verifier. |
| **Erasure vs immutability** | Sensitive fields encrypted per-record; GDPR erasure satisfied by **crypto-shredding** (destroy the field key) while preserving chain integrity over ciphertext — documented reconciliation. |

---

## 10. Implementation Roadmap (v2)

Each phase: **Objective · Deliverables · Acceptance criteria · Security risks · Rollback plan.**

### Phase 0 — Kafel database discovery & threat model
- **Objective:** Know exactly what we monitor and the adversaries.
- **Deliverables:** data dictionary; financial/sensitive table + field list; confirmed replica + ROW/FULL/GTID feasibility; native-audit option chosen; documented threat model; trust-domain ownership assignments.
- **Acceptance:** sign-off on monitored-table list, read-only access provisioned, attestation targets defined.
- **Security risks:** PII exposure during discovery; over-broad access grants.
- **Rollback:** none (no system deployed); revoke any temporary access.

### Phase 1 — MySQL CDC read-only MVP
- **Objective:** Capture txn-grouped CCE v1 from selected MySQL tables, read-only.
- **Deliverables:** CDC collector (Debezium) on replica; Ingest worker building CCE v1; field-level diff; **Attestation Monitor + Completeness Prover** live; PG projection (no dashboard yet).
- **Acceptance:** INSERT/UPDATE/DELETE captured with full before/after on selected tables; GTID continuity proven; config-drift alarm fires in test; p95 commit→stored < 5s.
- **Security risks:** snapshot load on replica; collector holding read creds; binlog retention too short.
- **Rollback:** stop collector; system is read-only so no data impact; purge PG projection.

### Phase 2 — WORM evidence & external anchoring
- **Objective:** Make evidence immutable and independently verifiable.
- **Deliverables:** WORM object store (Object Lock compliance mode); hash chaining; HSM signing of heads; RFC3161/Anchor-Provider timestamping; daily verifier + **independent verifier** tool.
- **Acceptance:** auditor reproduces chain verification using only WORM + HSM pubkey + TSA cert; injected tampering and injected GTID gap both detected; anchors immutable.
- **Security risks:** HSM key custody errors; WORM misconfig (retention not enforced); TSA availability.
- **Rollback:** WORM is append-only (cannot delete within retention) — "rollback" = stop writing new anchors; never destroy written evidence.

### Phase 3 — Dashboard & field-level diff viewer
- **Objective:** Operational visibility.
- **Deliverables:** React/Vite app; Overview + Live Changes (SSE) + Event detail drawer + diff viewer with masking + fidelity-state indicator; OIDC+TOTP auth; IP allowlist; mTLS.
- **Acceptance:** analysts see live changes with old→new and masked sensitive fields; fidelity DEGRADED state visibly surfaced.
- **Security risks:** sensitive-value leakage in UI; session/auth weaknesses.
- **Rollback:** disable dashboard ingress; core capture continues unaffected.

### Phase 4 — Risk rules & alerts
- **Objective:** Detection + notification.
- **Deliverables:** hard-coded rule pack (donation-after-approval, wallet-edit, beneficiary-delete-with-balance, delete-on-financial, mass-update window, off-hours); Alerting engine; Suspicious Activity Center; email/webhook notifications with content redaction.
- **Acceptance:** each rule fires correctly on test fixtures; alerts deduped and routed; no sensitive data in external notifications.
- **Security risks:** alert fatigue/false positives; notification channel leakage.
- **Rollback:** disable rule/notifier flags; capture + evidence unaffected.

### Phase 5 — Reversal REQUEST workflow only
- **Objective:** Human-gated reversal *proposals* — still no execution.
- **Deliverables:** reversal_request + approvals model; SQL/operation **preview**; four-eyes for critical; WebAuthn on approval; signed ReversalDirective generation (stored, **not** sent anywhere yet).
- **Acceptance:** four-eyes enforced at data layer; directive is signed + verifiable; **no write path exists**; drift fields captured for later concurrency check.
- **Security risks:** approval bypass; directive forgery.
- **Rollback:** disable reversal module; nothing was ever written to Kafel.

### Phase 6 — Separate Change Execution Service (Domain D)
- **Objective:** Safely apply approved reversals from outside EDAM.
- **Deliverables:** CES in separate trust domain; signature+quorum validation; Vault short-TTL dynamic creds scoped to whitelist; optimistic-concurrency execution (full after-image match); ExecutionResult signed back; reversal captured as a CCE.
- **Acceptance:** approved reversal applies on **staging** only with valid directive; drifted row yields DRIFT_CONFLICT and **no write**; forged/expired directive rejected; every execution appears in the evidence chain.
- **Security risks:** **highest-risk phase** — introduces the only write path. Credential leakage; directive replay; over-broad whitelist.
- **Rollback:** revoke CES Vault role (instantly removes all write capability); disable CES; EDAM returns to propose-only. Any applied reversal is itself reversible via the same gated flow.

### Phase 7 — PostgreSQL support
- **Objective:** Second engine via the adapter seam.
- **Deliverables:** PG logical-decoding collector emitting CCE v1; PG-specific attestation (`REPLICA IDENTITY FULL`, **replication-slot lag** alarms, `wal_level`); pgAudit collector; PG-aware CES precondition (xmin/full-row match).
- **Acceptance:** PG passes the **same conformance suite** as MySQL against CCE v1; slot-lag alarm prevents WAL-disk exhaustion of the monitored primary.
- **Security risks:** **unconsumed slot can crash the monitored PG primary** — must alarm and auto-detach on threshold; REPLICA IDENTITY downgrade (attestation covers it).
- **Rollback:** drop replication slot/publication (releases WAL); disable PG adapter; MySQL monitoring unaffected.

### Phase 8 — Enterprise hardening
- **Objective:** Scale, compliance, forensics depth.
- **Deliverables:** introduce Kafka/OpenSearch only if volume justifies; Keycloak/SSO; UEBA layer; SIEM/OCSF egress + ticketing; forensic replay (point-in-time reconstruction); legal hold + chain-of-custody UI; compliance reporting packs (SOX/PCI/SOC2/ISO); DR for evidence tier; pen-test.
- **Acceptance:** pen-test passed; DR restore of evidence validated; forensic replay reconstructs row state at arbitrary T; SIEM receives normalized events.
- **Security risks:** added attack surface (search/IdP/bus); cost/ops complexity.
- **Rollback:** feature-flag each enterprise add-on; revert to Phase-7 baseline without evidentiary loss (WORM untouched).

---

## 11. Residual Risks & Honest Limits (carried forward)

1. **OS/filesystem-level attacker on the DB host** can edit datafiles or forge binlog outside the SQL layer — not attributable and possibly not captured. Mitigation (future): periodic full-table hash reconciliation vs reconstructed state. Stakeholders must know this boundary.
2. **Native audit tampering** by a privileged actor degrades attribution; mitigated by attestation watching the audit plugin's presence + one-way egress, but not eliminated.
3. **TSA / external anchor availability** — if the timestamp authority is unreachable, anchoring queues; design tolerates delay but prolonged outage weakens "when" proofs. DualCustodian/TransparencyLog providers reduce single-TSA dependence.
4. **MongoDB semantics** (delete/update compensation, array diffs) remain genuinely harder; CCE v1's nested-path model prepares for it but Mongo reversal is deferred and explicitly re-scoped as a major effort.
5. **Crypto-shredding vs immutability** resolves the GDPR/erasure tension but requires disciplined per-record key management; key-store compromise is a new dependency.

---

## 12. Summary

v2 keeps v1's correct shape (out-of-band log CDC → canonical event → append-only audit → human-gated reversal) and the v1 product/UX vision, but closes the four blockers that made v1 indefensible for financial systems:

- **C1 →** evidence is immutable (WORM), signed (HSM), and externally timestamped — **verifiable without trusting EDAM**.
- **C2 →** EDAM **cannot write** to Kafel; a separate, dual-controlled **Change Execution Service** applies approved, signed, optimistically-concurrent reversals with short-lived creds.
- **C3/C4 →** **attestation + completeness proof** make missed events and silent fidelity downgrades **loud failures**, not invisible ones.
- **H1 →** **native DB audit** correlation provides strong SQL-layer attribution, with limits stated plainly.

The lean MVP ships read-only and propose-only, **but evidence-grade from day one**, and the roadmap introduces the only write path (CES) in a single, isolated, fully-rollback-able phase. This is the architecture that crosses from "good monitoring tool" to "defensible enterprise audit platform."

---

*v2 planning document. No implementation code. v1 plan and the adversarial review are unchanged.*
