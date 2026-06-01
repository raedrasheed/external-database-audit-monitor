# Canonical Change Event (CCE) v1 — Definitive Specification
### The foundational data contract for External Database Audit Monitor (EDAM) v2

> **Document class:** Frozen contract. Once ratified, changes follow the versioning/deprecation policy in §9 and the Breaking-Changes rules in §13.
> **Authoritative inputs:** `docs/External-Database-Audit-Monitor-Plan.md` (v1), `docs/EDAM-Architecture-Review.md`, `docs/EDAM-v2-Architecture.md`.
> **Status:** Contract design only — no implementation code.
> **Schema id:** `cce-1.0` · **Spec date:** 2026-06-01.

---

## 0. Scope & purpose

The **Canonical Change Event (CCE)** is the single normalized representation of "something changed in a monitored database." Every EDAM subsystem — CDC collectors, ingest worker, field-level diff engine, risk engine, hash-chain/evidence writer, PostgreSQL projection, dashboard, alerting, and the (separate) Change Execution Service — **reads and writes only CCEs**. No subsystem may depend on engine-native event formats.

**Design rules that govern this contract:**
1. **Engine-agnostic.** A CCE must represent MySQL/MariaDB today and PostgreSQL/SQL Server/Oracle/MongoDB later without structural change.
2. **Transaction-first.** The unit of record is a **transaction envelope** containing ordered change items — not a bare row event.
3. **Evidence-bearing.** Every CCE carries the fields needed to chain, sign, anchor, and independently verify it (per EDAM v2 §2).
4. **Honest about fidelity & attribution.** Every CCE states the capture conditions (fidelity) and the confidence of who-did-it (attribution). The contract never *implies* a guarantee it cannot prove.
5. **Deterministic.** Two collectors replaying the same source range MUST produce byte-identical canonical serializations and therefore identical hashes.

---

## 1. Top-level structure

A CCE is a **transaction envelope**. There is exactly one `kind` in v1: `transaction`.

```
CCE (transaction envelope)
├── schema_version
├── envelope_id
├── kind
├── source            { db/engine/topology metadata }      §6.1
├── transaction       { tx id, commit/ingest time, counts } §4
├── offset            { GTID / binlog pos / LSN / SCN / token } §1.4
├── fidelity          { capture-condition attestation }      §6.4
├── completeness      { gap/continuity proof context }       §6.5
├── actor             { correlated attribution }             §6.3 / §7
├── changes[]         { ordered change items }               §5 / §6
│     └── change item { seq, operation, object, before, after, field_changes[] }
└── evidence          { hashes, chain links, WORM ref, signature, TSA ref } §6.2 / §8
```

A CCE is **immutable once sealed** (see lifecycle §2). All fields below describe a *sealed* CCE unless explicitly marked as populated during an earlier lifecycle state.

---

## 2. Event lifecycle & states

A CCE passes through a **monotonic, append-only lifecycle**. State is a property of the *processing pipeline*, not a mutable field stored inside the sealed evidence object (the sealed object records only its terminal evidence). Pipeline state is tracked in the PostgreSQL projection for operational visibility.

```
 CAPTURED ──► NORMALIZED ──► DIFFED ──► ATTRIBUTED ──► SCORED ──► SEALED ──► ANCHORED
     │            │             │            │            │          │           │
  raw native   CCE struct   field_changes  actor{}     risk fields  hashes +   chain head
  event from   built,        computed       correlated  computed     WORM       signed +
  collector    fidelity +    (§5/§6)        (§7)        (risk score, write       externally
               offset set                              triggered)   (immutable) timestamped
```

| State | Meaning | Who sets it | Reversible? |
|---|---|---|---|
| **CAPTURED** | Raw native event received by a collector; offset/fidelity context attached. | CDC / audit collector | n/a (pre-CCE) |
| **NORMALIZED** | Mapped into CCE structure (`source`, `transaction`, `offset`, `changes` skeleton). | Ingest worker | No (forward-only) |
| **DIFFED** | `field_changes[]`, `before`/`after`, masking applied. | Diff engine | No |
| **ATTRIBUTED** | `actor{}` populated via CDC + native-audit correlation. | Attribution correlator | No |
| **SCORED** | Risk fields (`risk_score`, `triggered_rules`) added. | Risk engine | No |
| **SEALED** | `event_hash` + `row_hash` computed; CCE written **once** to WORM. Now immutable. | Evidence writer | **No — terminal for the object** |
| **ANCHORED** | The chain head covering this CCE is HSM-signed + externally timestamped. | Anchoring service | No |

**Rules:**
- The lifecycle is **strictly forward**. There is no `EDIT`. A correction is a *new* CCE (e.g., a reversal is captured as its own transaction), never a mutation.
- **SEALED is the immutability boundary.** After sealing, the canonical bytes that produced `event_hash` MUST NOT change.
- A CCE may be `SEALED` before it is `ANCHORED` (anchoring is batched). Verification status distinguishes "sealed but not yet anchored" from "anchored".
- **Failure handling:** a CCE that cannot be normalized/diffed (poison event) is quarantined to a dead-letter record with its raw payload and offset, and raises a fidelity alarm — it is **never silently dropped**, because dropping breaks completeness (§6.5).

---

## 3. Identity model

| Identifier | Scope | Stability | Purpose |
|---|---|---|---|
| `envelope_id` | One transaction envelope (CCE) | Deterministically derived (see below) | Primary key of a CCE |
| `transaction.tx_id` | Source transaction | As reported by source (GTID/LSN/SCN/txnNumber) | Correlate to source, dedupe |
| `change[].seq` | Position within a transaction | 0-based, contiguous | Intra-transaction ordering |
| `event_hash` | Canonical content of the CCE | Content-addressed | Integrity, dedupe |
| `row_hash` | Position in the global hash chain | Order-dependent | Tamper-evidence (§8) |

**`envelope_id` derivation (deterministic, not random):**
```
envelope_id = UUIDv5( namespace = EDAM_CCE_NAMESPACE,
                      name = db_id ‖ "|" ‖ tx_id ‖ "|" ‖ server_uuid )
```
This guarantees **idempotency**: re-capturing the same source transaction yields the same `envelope_id`, so replays and at-least-once delivery deduplicate naturally. (If a single source transaction must be split across multiple envelopes due to size limits, a `part` index is appended to `name`; see Implementation Constraints §12.)

---

## 4. Transaction semantics

### 4.1 Grouping model
- The unit is the **source transaction**. All row/document changes committed atomically in the source belong to **one** CCE envelope, in `changes[]`.
- A transaction that changes 1 row and a transaction that changes 10,000 rows are both **one CCE** (subject to the size-split rule in §12).
- DDL is represented as a change item too (§5.4); a DDL transaction is still one envelope.

### 4.2 Ordering guarantees
- **Within a transaction:** `changes[]` is ordered by `seq` (0,1,2,…), reflecting the source's intra-transaction statement/row order where the engine exposes it. `seq` MUST be contiguous and start at 0.
- **Across transactions (the global chain order):** defined as the total order
  ```
  ORDER BY (transaction.commit_ts ASC, tie-break = offset monotonic key ASC)
  ```
  The **offset monotonic key** is engine-specific but monotonic within a source: GTID sequence (MySQL/MariaDB), LSN (Postgres/SQL Server), SCN (Oracle), resume-token order (Mongo). The tie-break makes ordering deterministic even when two commits share a millisecond timestamp.
- **The hash chain (§8) links CCEs in exactly this global order.** Reprocessing the same source range MUST reproduce the same order and therefore the same chain.

### 4.3 Commit ordering
- A CCE is emitted **only for committed transactions.** Uncommitted/in-flight changes are never represented.
- `transaction.commit_ts` is the source-reported commit time; `transaction.ingest_ts` is EDAM's trusted monotonic receive time. Off-hours and timeline analysis MUST be able to use either; evidentiary timeline uses `ingest_ts` plus the anchored timestamp (§8), never the source clock alone (the source clock is attacker-influenceable — review M2).

### 4.4 Rollback handling
- **Rolled-back transactions produce no CCE.** Log-based CDC only surfaces committed work, so a rollback is simply absent. This is correct and intended.
- A transaction that was *committed and later logically undone by a separate transaction* produces **two** CCEs (the original and the undo) — never an in-place removal. This preserves the append-only forensic record.

### 4.5 Replay behavior
- Replays are **idempotent** via deterministic `envelope_id` (§3) and content-addressed `event_hash`.
- A consumer that receives a CCE whose `(envelope_id, event_hash)` it has already sealed MUST treat it as a duplicate and not re-seal.
- A replay that yields the **same `envelope_id` but a different `event_hash`** is a **CRITICAL integrity violation** (non-determinism or tampering) and MUST raise an alarm — it must never silently overwrite.

---

## 5. Supported operations

`operation` is an enum on each change item: `INSERT | UPDATE | DELETE | DDL | TRUNCATE`.

| Operation | `before` | `after` | `field_changes[]` | Notes |
|---|---|---|---|---|
| **INSERT** | `null` | full new image | one entry per column with `old=null, new=value, changed=true` | New row/document created. |
| **UPDATE** | full old image* | full new image* | one entry per column where `old != new` (changed=true); unchanged columns MAY be included with `changed=false` | *Requires FULL row image (fidelity §6.4). If fidelity is DEGRADED, `before` may be partial — flagged. |
| **DELETE** | full old image* | `null` | one entry per column with `old=value, new=null, changed=true` | *Requires FULL row image to capture the deleted values; without it only PK is present and `fidelity.state` ≠ HEALTHY. |
| **DDL** | optional prior DDL text/schema | new DDL text/schema | not applicable (schema-level) | `object` identifies the affected table/schema; payload carried in `ddl` sub-object (statement text + parsed effect where available). No row-level diff. |
| **TRUNCATE** | `null` | `null` | not applicable | Represents bulk removal of all rows; `object` identifies the table. Row-level before-images are **not** available from a TRUNCATE in most engines — this MUST be flagged (`fidelity.notes`) and treated by risk rules as high-severity (data destruction without per-row evidence). |

**Critical contract point:** the *availability* of `before` for UPDATE/DELETE is **conditional on source fidelity**. The CCE never fabricates a before-image; if it is unavailable, `before` is `null`/partial and `fidelity.state` reflects DEGRADED with a reason. This honesty is mandatory (review C4).

---

## 6. Field definitions (normative)

Notation: **R** = required, **O** = optional, **C** = conditionally required (condition stated). Types use JSON types; `timestamp` = RFC 3339 / ISO 8601 UTC string with millisecond precision; `hash` = lowercase `algo:hex` string (e.g., `sha256:ab12…`).

### 6.0 Envelope (top level)

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `schema_version` | string | R | Contract version. | MUST equal `"cce-1.0"` for this spec; pattern `^cce-\d+\.\d+$`. Consumers MUST reject unknown **major**. | `"cce-1.0"` |
| `envelope_id` | string(uuid) | R | Deterministic UUIDv5 identity (§3). | Valid UUID; MUST be reproducible from derivation inputs. | `"7b9c…-v5"` |
| `kind` | string(enum) | R | Envelope kind. | MUST be `"transaction"` in v1. | `"transaction"` |
| `source` | object | R | Source DB metadata (§6.1). | All R subfields present. | — |
| `transaction` | object | R | Transaction metadata (§6 below). | — | — |
| `offset` | object | R | Resume/continuity offset (§1.4 / §6.5). | At least one engine offset key non-null. | — |
| `fidelity` | object | R | Capture-condition attestation (§6.4). | `state` present. | — |
| `completeness` | object | R | Continuity proof context (§6.5). | `consumed_gtid_set` or engine equivalent present. | — |
| `actor` | object | R | Attribution (§6.3 / §7). | `attribution_confidence` present (may be `unattributed`). | — |
| `changes` | array<object> | R | Ordered change items (≥1). | Non-empty; `seq` contiguous from 0. | — |
| `evidence` | object | R (post-seal) | Integrity metadata (§6.2 / §8). | Present once SEALED; absent/partial allowed pre-seal. | — |

### 6.1 `source`

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `db_id` | string | R | EDAM logical id of the monitored DB. | Matches a `monitored_databases.name`. | `"kafel-prod-mysql"` |
| `engine` | string(enum) | R | DB engine. | `mysql\|mariadb\|postgres\|sqlserver\|oracle\|mongodb`. | `"mysql"` |
| `engine_version` | string | O | Source server version. | free text. | `"8.0.36"` |
| `server_uuid` | string | R | Stable source server/topology id. | non-empty. | `"3E11FA47-…"` |
| `schema` | string | R | Default schema/database name. | non-empty. | `"kafel"` |

### 6.2 `transaction`

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `tx_id` | string | R | Source transaction id. | GTID/LSN-range/SCN/txnNumber; non-empty. | `"3E11FA47-…:152"` |
| `commit_ts` | timestamp | R | Source-reported commit time (untrusted). | valid RFC3339 UTC. | `"2026-06-01T10:22:31.114Z"` |
| `ingest_ts` | timestamp | R | EDAM monotonic receive time (trusted). | ≥ collector start; monotonic per stream. | `"2026-06-01T10:22:31.480Z"` |
| `statement_count` | integer | R | Number of change items. | == `changes.length`; ≥1. | `1` |

### 6.3 `actor` (attribution — see §7 for model)

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `db_user` | string | O | DB account that performed the change. | null if unattributed. | `"app_user"` |
| `client_host` | string | O | Origin host/IP. | IP or hostname. | `"10.0.0.5"` |
| `connection_id` | string | O | Source connection/session id. | engine-specific. | `"338217"` |
| `application_name` | string | O | App/program name if exposed. | — | `"kafel-api"` |
| `attribution_confidence` | string(enum) | R | Confidence of who-did-it. | `exact\|probable\|unattributed`. | `"probable"` |
| `audit_event_ref` | string | C | Reference to correlated native-audit record. | required when confidence ≠ `unattributed`. | `"dbaudit:2026-06-01/…#4471"` |
| `correlation_basis` | array<string> | O | What linked CDC↔audit. | subset of `connection_id,time_window,table,thread_id,gtid`. | `["connection_id","time_window"]` |

### 6.4 `fidelity`

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `state` | string(enum) | R | Capture fidelity at the moment of this event. | `HEALTHY\|DEGRADED\|COMPROMISED`. | `"HEALTHY"` |
| `source_config` | object | R | Snapshot of audit-critical settings. | see below. | — |
| `source_config.binlog_format` | string | C | (MySQL/MariaDB) | SHOULD be `ROW`; otherwise state ≠ HEALTHY. | `"ROW"` |
| `source_config.binlog_row_image` | string | C | (MySQL/MariaDB) | SHOULD be `FULL`; otherwise before-image partial. | `"FULL"` |
| `source_config.gtid_mode` | string | C | (MySQL/MariaDB) | SHOULD be `ON`. | `"ON"` |
| `source_config.replica_identity` | string | C | (Postgres) | SHOULD be `FULL`. | `"FULL"` |
| `source_config.config_snapshot_id` | string | R | Id of the attestation snapshot used. | references attestation log. | `"cfg-2026-06-01T10:00Z"` |
| `notes` | array<string> | O | Human-readable fidelity caveats. | e.g., TRUNCATE no per-row image. | `["truncate:no-row-image"]` |
| `degraded_reason` | string | C | Required when state ≠ HEALTHY. | non-empty. | `"binlog_row_image=MINIMAL"` |

### 6.5 `completeness`

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `consumed_offset_key` | string | R | Monotonic key consumed up to this event. | engine offset (GTID seq/LSN/SCN/token). | `"…:152"` |
| `consumed_gtid_set` | string | C | (MySQL/MariaDB) executed-GTID-set consumed so far. | valid GTID set syntax. | `"3E11FA47-…:1-152"` |
| `heartbeat_ts` | timestamp | O | Latest caught-up watermark. | ≥ prior heartbeat. | `"2026-06-01T10:22:30.900Z"` |
| `gap_detected` | boolean | R | Whether a continuity gap was detected at/before this event. | default `false`; `true` ⇒ alarm + fidelity ≠ HEALTHY. | `false` |
| `snapshot_phase` | string(enum) | O | Snapshot/stream phase. | `snapshot\|handoff\|streaming`. | `"streaming"` |

### 6.6 `offset`

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `gtid` | string | C | (MySQL/MariaDB) | one of the offset keys must be non-null. | `"3E11FA47-…:152"` |
| `binlog_file` | string | O | (MySQL/MariaDB) | — | `"mysql-bin.000042"` |
| `binlog_pos` | integer | O | (MySQL/MariaDB) | ≥0. | `99812` |
| `lsn` | string | C | (Postgres/SQL Server) | — | `null` |
| `scn` | string | C | (Oracle) | — | `null` |
| `resume_token` | string | C | (MongoDB) | — | `null` |

### 6.7 `changes[]` change item

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `seq` | integer | R | Order within transaction. | contiguous from 0. | `0` |
| `operation` | string(enum) | R | Operation type. | `INSERT\|UPDATE\|DELETE\|DDL\|TRUNCATE`. | `"UPDATE"` |
| `object` | object | R | Target table/collection + PK. | see below. | — |
| `object.schema` | string | R | Schema/db name. | non-empty. | `"kafel"` |
| `object.name` | string | R | Table/collection name. | non-empty. | `"donations"` |
| `object.primary_key` | object | C | PK values. | required for row ops (INSERT/UPDATE/DELETE). | `{"id":90211}` |
| `before` | object\|null | C | Old image. | null for INSERT; conditional for UPDATE/DELETE per fidelity. | `{"amount":100.00,…}` |
| `after` | object\|null | C | New image. | null for DELETE. | `{"amount":100000.00,…}` |
| `field_changes` | array<object> | C | Field-level diff (§6.8). | required for INSERT/UPDATE/DELETE; absent for DDL/TRUNCATE. | — |
| `ddl` | object | C | DDL payload. | required when operation=DDL. | `{"statement":"ALTER TABLE …"}` |

### 6.8 `field_changes[]` entry (diff representation)

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `path` | array<string> | R | Field address. Single element = relational column; multi-element = nested document path (Mongo-ready). | non-empty; elements non-empty. | `["amount"]` / `["beneficiary","contact","iban"]` |
| `old` | any\|null | C | Old value (masked if sensitive). | null per operation rules. | `100.00` |
| `new` | any\|null | C | New value (masked if sensitive). | null per operation rules. | `100000.00` |
| `data_type` | string | R | Logical type. | engine-mapped (`decimal`,`string`,`int`,`bool`,`json`,`timestamp`,…). | `"decimal"` |
| `changed` | boolean | R | Whether the value changed. | INSERT/DELETE entries are `true`. | `true` |
| `sensitive` | boolean | R | Classified sensitive (drives masking). | default `false`. | `false` |
| `masked` | boolean | C | Whether `old`/`new` are masked placeholders. | required `true` when sensitive value not revealed. | `true` |
| `array_op` | string(enum) | O | For document arrays. | `add\|remove\|replace`. | `"replace"` |

### 6.9 `evidence` (see §8)

| Field | Type | Req | Description | Validation | Example |
|---|---|---|---|---|---|
| `event_hash` | hash | C (post-seal) | Hash of canonical serialization of CCE **core** (everything except `evidence`). | `sha256:` + 64 hex. | `"sha256:9f2c…"` |
| `prev_row_hash` | hash\|null | C (post-seal) | Previous chain link (null only for genesis). | hash or null. | `"sha256:00…"` |
| `row_hash` | hash | C (post-seal) | `SHA256(prev_row_hash ‖ event_hash)`. | recomputable. | `"sha256:ab12…"` |
| `worm_object_key` | string | C (post-seal) | Immutable object location. | non-empty after seal. | `"evidence/2026/06/01/seg-000142/7b9c.json"` |
| `segment_id` | string | C (post-seal) | Evidence segment grouping. | — | `"seg-000142"` |
| `anchor_ref` | object\|null | C (post-anchor) | Signature + TSA reference (§8). | present once ANCHORED. | — |
| `anchor_ref.head_hash` | hash | C | Chain head covered by the anchor. | — | `"sha256:cd34…"` |
| `anchor_ref.hsm_signature` | string | C | HSM signature over head+manifest. | base64. | `"MEUCIQ…"` |
| `anchor_ref.tsa_token` | string | C | RFC 3161 timestamp token (or equivalent). | base64/DER. | `"MIIFx…"` |
| `anchor_ref.anchor_provider` | string(enum) | C | Anchor type. | `rfc3161\|transparency_log\|dual_custodian`. | `"rfc3161"` |

---

## 7. Attribution model (normative)

Attribution answers *who/where/how* — separate from CDC's *what*.

1. **CDC attribution (weak):** binlog/WAL/redo may carry `db_user`, `client_host`, `connection_id`, thread id — engine-dependent and often partial. Used as the base.
2. **Native DB audit attribution (authoritative for SQL layer):** a parallel feed (MariaDB Audit Plugin / MySQL Enterprise Audit / Percona / cloud audit logs) provides session→user→host→statement. The **Attribution correlator** joins CDC and audit on a subset of `{connection_id, transaction time window, table, thread_id, gtid}`.
3. **Confidence scoring:**
   - `exact` — deterministic join (e.g., matching connection_id + gtid/thread within window) with a single candidate.
   - `probable` — time-window + table correlation with a single most-likely candidate but no hard key.
   - `unattributed` — no usable native-audit record (audit disabled, OS-level/out-of-band change, or correlation ambiguous).
4. **Honest limits (MUST be representable, never hidden):**
   - Binlog alone cannot attribute a human; `unattributed` is a valid, expected outcome.
   - An actor who disables/clears native audit degrades attribution — detected by the Attestation Monitor (EDAM v2 §4) but not recoverable for affected events; such events carry `unattributed` + a fidelity note.
   - Out-of-band edits (datafile-level) may be unattributed *and* may bypass CDC entirely; this is outside CCE's guarantee and stated as a residual risk.

---

## 8. Evidence model (normative)

The evidence model implements EDAM v2 §2 (WORM + HSM + external timestamp) at the event level.

1. **Canonical serialization:** the CCE **core** (the envelope minus the `evidence` object) is serialized with a **deterministic canonical form** (sorted keys, fixed number formatting, UTF-8 NFC, no insignificant whitespace). The serialization algorithm is part of this contract (see §12.7) — it MUST be stable forever for v1.
2. **`event_hash` = SHA-256(canonical_core)`** — content address; identical content ⇒ identical hash (enables dedupe + replay verification).
3. **Hash chain:** CCEs are linked in the global order of §4.2: `row_hash[n] = SHA-256(row_hash[n-1] ‖ event_hash[n])`. Genesis uses an all-zero `prev_row_hash`.
4. **WORM write:** at SEAL, the full CCE (core + evidence) is written **once** to immutable object storage (`worm_object_key`). This is the system of record; PostgreSQL is a rebuildable projection.
5. **Anchoring:** periodically (every N events or T minutes) the current chain head is **HSM-signed** (non-exportable key, separate custody) and **externally timestamped** (RFC 3161 TSA, or `transparency_log`/`dual_custodian` provider). The `anchor_ref` is recorded against covered CCEs.
6. **Independent verification:** an auditor with only {WORM read, HSM public key, TSA/anchor public cert} can recompute every `event_hash`, re-link the chain, and validate each anchor — **without trusting EDAM software or operators.** This is the contract's strongest forensic property.

---

## 9. Versioning strategy

- **`schema_version` = `cce-MAJOR.MINOR`.** This document defines `cce-1.0`.
- **Backward compatibility (consumer reading older events):** consumers MUST read any `cce-1.x` event. Older events simply lack fields added in later minors.
- **Forward compatibility (consumer reading newer minor):** consumers MUST ignore unknown **optional** fields within the same major (`cce-1.y`, y>own). They MUST NOT fail on additive minors.
- **Major mismatch:** a consumer encountering an unknown **major** (`cce-2.x`) MUST reject and alarm — never best-effort parse. (This is why `schema_version` is mandatory and validated first.)
- **Minor bump (`1.x → 1.(x+1)`) is allowed only for additive, optional, non-semantic-changing fields.** Anything else is a major bump (see §13).
- **Deprecation policy:** a field may be marked deprecated in a minor; it MUST remain present and populated for at least **two minor versions** before removal, and removal itself requires a **major** bump. Deprecations are listed in a `DEPRECATED.md` changelog with the minor that introduced the deprecation.
- **Hash stability:** because `event_hash` depends on canonical serialization, **adding a field changes the hash of new events but never re-hashes old ones** (old events were sealed under their then-current serialization, which is recorded by `schema_version`). Verification always uses the serialization rules of the event's own `schema_version`.

---

## 10. Validation rules (consolidated)

A CCE is **valid** iff all of the following hold:

- **V1** `schema_version` matches `^cce-\d+\.\d+$`; major == 1 for this spec.
- **V2** `kind == "transaction"`.
- **V3** `envelope_id` is a valid UUID and reproduces from `(db_id, tx_id, server_uuid[, part])`.
- **V4** `changes` non-empty; `seq` values are `0..n-1` contiguous and unique; `transaction.statement_count == changes.length`.
- **V5** For each change item, `operation` ∈ enum; `before`/`after` nullity matches the operation table (§5); `field_changes` present iff operation ∈ {INSERT,UPDATE,DELETE}.
- **V6** Row operations (INSERT/UPDATE/DELETE) have `object.primary_key`.
- **V7** Every `field_changes[].path` is a non-empty array of non-empty strings; `changed` boolean present; `sensitive` present; if `sensitive==true` and not revealed, `masked==true` and `old/new` are placeholders.
- **V8** `fidelity.state` ∈ enum; if ≠ HEALTHY then `degraded_reason` present.
- **V9** `completeness.gap_detected` present; if `true`, `fidelity.state` MUST be DEGRADED or COMPROMISED.
- **V10** `actor.attribution_confidence` ∈ enum; if ≠ `unattributed` then `audit_event_ref` present.
- **V11** At least one `offset` engine key is non-null.
- **V12** (post-seal) `evidence.event_hash` recomputes from canonical core; `row_hash == SHA256(prev_row_hash ‖ event_hash)`.
- **V13** (post-anchor) `anchor_ref` present with `hsm_signature` and `tsa_token`/equivalent; signature verifies against the registered HSM public key.
- **V14** Timestamps are RFC 3339 UTC with millisecond precision; `ingest_ts` monotonic per stream.
- **V15** A duplicate `envelope_id` with a differing `event_hash` is **invalid** and is a critical integrity event (per §4.5).

---

## 11. Conformance test requirements

Any collector/adapter or consumer claiming CCE v1 conformance MUST pass a shared **conformance suite** covering:

**Structural**
- C-1 Round-trip: native event → CCE → canonical serialization → hash is **byte-stable across two independent runs and two machines**.
- C-2 Schema validation: valid fixtures pass JSON-Schema (§B); each invalid fixture (one per V1–V15) fails with the expected rule id.

**Operations**
- C-3 INSERT/UPDATE/DELETE/DDL/TRUNCATE each produce the representation in §5, including correct `before`/`after` nullity and `field_changes`.
- C-4 Multi-row transaction: N row changes → one envelope, `seq` 0..N-1, `statement_count==N`.

**Ordering & determinism**
- C-5 Two transactions with equal `commit_ts` are ordered deterministically by offset tie-break; chain `row_hash` identical across reruns.
- C-6 Replay of the same source range yields identical `envelope_id` and `event_hash` (idempotency); a deliberately perturbed replay yields a *different* `event_hash` and is flagged (V15).

**Fidelity & completeness**
- C-7 Simulated `binlog_row_image=MINIMAL` ⇒ UPDATE/DELETE `before` partial/null AND `fidelity.state != HEALTHY` with `degraded_reason`.
- C-8 Injected GTID gap ⇒ `completeness.gap_detected==true` and fidelity degraded; gap surfaced, not swallowed.
- C-9 TRUNCATE ⇒ no per-row before-image, `fidelity.notes` records it, risk treats as high-severity.

**Attribution**
- C-10 With native audit present → `exact`/`probable` + `audit_event_ref`; with audit disabled → `unattributed` (and no fabricated identity).

**Evidence**
- C-11 Chain: tamper one sealed event's bytes ⇒ `event_hash` mismatch and chain break detected by the independent verifier.
- C-12 Anchor: HSM signature + TSA token validate with only public keys; a forged signature is rejected.
- C-13 Independent verifier reconstructs and validates the chain using **only** WORM + HSM pubkey + TSA cert (no EDAM code/secrets).

**Versioning**
- C-14 Consumer ignores an unknown optional field in `cce-1.(x+1)`; rejects+alarms on `cce-2.0`.

---

## 12. Implementation Constraints (developers MUST obey)

These are binding rules for everyone building against CCE v1.

1. **No subsystem may parse engine-native events.** Collectors normalize to CCE; everything else consumes CCE only. New engine = new collector emitting CCE, nothing downstream changes.
2. **Never fabricate data.** If a before-image, attribution, or value is unavailable, represent it as `null`/`unattributed`/`DEGRADED` — never guess, never fill from a later read as if it were the captured value.
3. **Sealed CCEs are immutable.** No `UPDATE` to a sealed object anywhere. Corrections are new CCEs. PostgreSQL projection rows are derived, disposable, and rebuildable from WORM — code MUST treat WORM as the source of truth on any disagreement.
4. **Deterministic everything.** `envelope_id`, ordering, canonical serialization, and hashing MUST be deterministic and identical across languages/runtimes/machines. No map iteration order, locale, float formatting, or timezone may leak into the hash.
5. **`envelope_id` derivation is fixed** (§3). Do not switch to random UUIDs; idempotency depends on it. Size-split parts append a `part` index to the derivation name and set a `part`/`part_total` pair (reserved fields) — a single transaction's parts share `tx_id`.
6. **Validate `schema_version` first.** Reject unknown majors before any other processing.
7. **Canonical serialization is frozen for v1:** UTF-8 NFC; object keys sorted lexicographically by Unicode code point; arrays in natural order; integers as plain decimal; decimals/money as exact string (never IEEE float); booleans `true/false`; `null` explicit; timestamps as RFC3339 UTC millisecond strings; no insignificant whitespace. `event_hash` is computed over this form of the **core** (excluding `evidence`). This algorithm MUST NOT change within v1.
8. **Money/decimal as exact strings or scaled integers — never floats.** Financial fidelity forbids binary floating point in `old`/`new`/images.
9. **Sensitive masking happens before WORM write.** Raw sensitive values MUST NOT be written to PostgreSQL; if retained, only in WORM under stricter access with crypto-shred capability for erasure reconciliation. Notifications MUST use masked values.
10. **Fidelity & completeness are mandatory on every event.** A CCE without a truthful `fidelity.state` and `completeness.gap_detected` is invalid. Do not default these to HEALTHY/false without the attestation evidence to back them.
11. **Poison events are quarantined, not dropped.** A non-parseable native event becomes a dead-letter record retaining raw payload + offset and raises an alarm — because silent drops violate completeness.
12. **Clock discipline.** Use `ingest_ts` (trusted monotonic) and anchored timestamps for evidentiary timelines; `commit_ts` (source) is informational and treated as untrusted.
13. **No write path may be derived from a CCE inside EDAM.** A CCE may *justify* a reversal request, but execution is the separate Change Execution Service's job (EDAM v2 §3). Nothing that consumes CCEs may hold a monitored-DB write credential.

---

## 13. Breaking Changes (require CCE v2)

The following changes are **not** permitted within `cce-1.x` and force a **major** bump to `cce-2.0`:

1. **Changing the canonical serialization or hashing algorithm** (§12.7) — alters `event_hash` semantics and breaks chain verification.
2. **Changing `envelope_id` derivation** or its inputs — breaks idempotency/dedupe.
3. **Changing the global ordering definition** (§4.2) — breaks chain reproducibility.
4. **Removing or renaming any required field**, or changing a required field's type/meaning.
5. **Changing the nullity rules** for `before`/`after` per operation (§5).
6. **Adding a new top-level `kind`** beyond `transaction` *if* it changes how existing consumers must group/chain events (e.g., a non-transactional `kind`).
7. **Changing the hash chain construction** (e.g., from linear chain to Merkle tree) or the anchor verification contract.
8. **Altering enum semantics** of `operation`, `fidelity.state`, or `attribution_confidence` (repurposing an existing value).
9. **Making a previously honest "unknown" representable as a fabricated value** (would violate the no-fabrication invariant).
10. **Changing decimal/money encoding** (§12.8) — affects financial value integrity and hashes.

Additive, optional, non-semantic fields are **minor** (`1.x`) and explicitly NOT breaking.

---

## Appendix A — Human-readable summary (one screen)

> A **CCE** is one committed source transaction, normalized engine-agnostically. It carries: *what changed* (`changes[]` with per-field `old→new` over relational columns or nested document paths), *under what capture conditions* (`fidelity` — honestly DEGRADED if before-images or settings can't be trusted), *with what completeness guarantee* (`completeness` — gaps surfaced, never hidden), *by whom* (`actor` with `exact/probable/unattributed` confidence), and *with what proof* (`evidence` — content hash, hash-chain link, immutable WORM location, and an HSM-signed, externally-timestamped anchor verifiable by an outsider). It is built through a forward-only lifecycle (CAPTURED→…→SEALED→ANCHORED), is immutable once sealed, deterministic on replay, and never grants any write path back to the monitored database.

---

## Appendix B — JSON Schema (Draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/cce-1.0.schema.json",
  "title": "Canonical Change Event v1",
  "type": "object",
  "required": ["schema_version","envelope_id","kind","source","transaction","offset","fidelity","completeness","actor","changes"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "pattern": "^cce-\\d+\\.\\d+$" },
    "envelope_id": { "type": "string", "format": "uuid" },
    "kind": { "type": "string", "const": "transaction" },
    "source": {
      "type": "object",
      "required": ["db_id","engine","server_uuid","schema"],
      "additionalProperties": false,
      "properties": {
        "db_id": { "type": "string", "minLength": 1 },
        "engine": { "type": "string", "enum": ["mysql","mariadb","postgres","sqlserver","oracle","mongodb"] },
        "engine_version": { "type": "string" },
        "server_uuid": { "type": "string", "minLength": 1 },
        "schema": { "type": "string", "minLength": 1 }
      }
    },
    "transaction": {
      "type": "object",
      "required": ["tx_id","commit_ts","ingest_ts","statement_count"],
      "additionalProperties": false,
      "properties": {
        "tx_id": { "type": "string", "minLength": 1 },
        "commit_ts": { "type": "string", "format": "date-time" },
        "ingest_ts": { "type": "string", "format": "date-time" },
        "statement_count": { "type": "integer", "minimum": 1 }
      }
    },
    "offset": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "gtid": { "type": ["string","null"] },
        "binlog_file": { "type": ["string","null"] },
        "binlog_pos": { "type": ["integer","null"], "minimum": 0 },
        "lsn": { "type": ["string","null"] },
        "scn": { "type": ["string","null"] },
        "resume_token": { "type": ["string","null"] }
      },
      "anyOf": [
        { "required": ["gtid"], "properties": { "gtid": { "type": "string" } } },
        { "required": ["lsn"], "properties": { "lsn": { "type": "string" } } },
        { "required": ["scn"], "properties": { "scn": { "type": "string" } } },
        { "required": ["resume_token"], "properties": { "resume_token": { "type": "string" } } }
      ]
    },
    "fidelity": {
      "type": "object",
      "required": ["state","source_config"],
      "additionalProperties": false,
      "properties": {
        "state": { "type": "string", "enum": ["HEALTHY","DEGRADED","COMPROMISED"] },
        "source_config": {
          "type": "object",
          "required": ["config_snapshot_id"],
          "properties": {
            "binlog_format": { "type": "string" },
            "binlog_row_image": { "type": "string" },
            "gtid_mode": { "type": "string" },
            "replica_identity": { "type": "string" },
            "log_bin": { "type": "string" },
            "config_snapshot_id": { "type": "string", "minLength": 1 }
          }
        },
        "notes": { "type": "array", "items": { "type": "string" } },
        "degraded_reason": { "type": "string" }
      },
      "allOf": [
        { "if": { "properties": { "state": { "not": { "const": "HEALTHY" } } } },
          "then": { "required": ["degraded_reason"] } }
      ]
    },
    "completeness": {
      "type": "object",
      "required": ["consumed_offset_key","gap_detected"],
      "additionalProperties": false,
      "properties": {
        "consumed_offset_key": { "type": "string", "minLength": 1 },
        "consumed_gtid_set": { "type": "string" },
        "heartbeat_ts": { "type": "string", "format": "date-time" },
        "gap_detected": { "type": "boolean" },
        "snapshot_phase": { "type": "string", "enum": ["snapshot","handoff","streaming"] }
      }
    },
    "actor": {
      "type": "object",
      "required": ["attribution_confidence"],
      "additionalProperties": false,
      "properties": {
        "db_user": { "type": ["string","null"] },
        "client_host": { "type": ["string","null"] },
        "connection_id": { "type": ["string","null"] },
        "application_name": { "type": ["string","null"] },
        "attribution_confidence": { "type": "string", "enum": ["exact","probable","unattributed"] },
        "audit_event_ref": { "type": "string" },
        "correlation_basis": { "type": "array", "items": { "type": "string" } }
      },
      "allOf": [
        { "if": { "properties": { "attribution_confidence": { "not": { "const": "unattributed" } } } },
          "then": { "required": ["audit_event_ref"] } }
      ]
    },
    "changes": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["seq","operation","object"],
        "additionalProperties": false,
        "properties": {
          "seq": { "type": "integer", "minimum": 0 },
          "operation": { "type": "string", "enum": ["INSERT","UPDATE","DELETE","DDL","TRUNCATE"] },
          "object": {
            "type": "object",
            "required": ["schema","name"],
            "additionalProperties": false,
            "properties": {
              "schema": { "type": "string", "minLength": 1 },
              "name": { "type": "string", "minLength": 1 },
              "primary_key": { "type": "object" }
            }
          },
          "before": { "type": ["object","null"] },
          "after": { "type": ["object","null"] },
          "field_changes": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["path","data_type","changed","sensitive"],
              "additionalProperties": false,
              "properties": {
                "path": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
                "old": {},
                "new": {},
                "data_type": { "type": "string" },
                "changed": { "type": "boolean" },
                "sensitive": { "type": "boolean" },
                "masked": { "type": "boolean" },
                "array_op": { "type": "string", "enum": ["add","remove","replace"] }
              }
            }
          },
          "ddl": {
            "type": "object",
            "properties": {
              "statement": { "type": "string" },
              "effect": { "type": "string" }
            }
          }
        },
        "allOf": [
          { "if": { "properties": { "operation": { "enum": ["INSERT","UPDATE","DELETE"] } } },
            "then": { "required": ["field_changes","primary_key"] } },
          { "if": { "properties": { "operation": { "const": "DDL" } } },
            "then": { "required": ["ddl"] } },
          { "if": { "properties": { "operation": { "const": "INSERT" } } },
            "then": { "properties": { "before": { "const": null } } } },
          { "if": { "properties": { "operation": { "const": "DELETE" } } },
            "then": { "properties": { "after": { "const": null } } } }
        ]
      }
    },
    "evidence": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "event_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "prev_row_hash": { "type": ["string","null"], "pattern": "^sha256:[0-9a-f]{64}$" },
        "row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "worm_object_key": { "type": "string" },
        "segment_id": { "type": "string" },
        "anchor_ref": {
          "type": ["object","null"],
          "properties": {
            "head_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
            "hsm_signature": { "type": "string" },
            "tsa_token": { "type": "string" },
            "anchor_provider": { "type": "string", "enum": ["rfc3161","transparency_log","dual_custodian"] }
          }
        }
      }
    }
  }
}
```

> Note: rules V3 (envelope_id derivation), V4 (`statement_count == changes.length` and seq contiguity), V12/V13 (hash recomputation, signature verification), V14 (monotonic ingest), and V15 (duplicate-id/differing-hash) are **cross-field/stateful** and are enforced by the conformance suite (§11), not by JSON Schema alone.

---

## Appendix C — Example events

### C.1 Donation amount changed after approval (UPDATE — risk rule #1)
```json
{
  "schema_version": "cce-1.0",
  "envelope_id": "8b1f5c7a-2d44-5f0e-9a3b-1c2d3e4f5a6b",
  "kind": "transaction",
  "source": { "db_id": "kafel-prod-mysql", "engine": "mysql", "engine_version": "8.0.36",
              "server_uuid": "3E11FA47-71CA-11E1-9E33-C80AA9429562", "schema": "kafel" },
  "transaction": { "tx_id": "3E11FA47-71CA-11E1-9E33-C80AA9429562:152",
                   "commit_ts": "2026-06-01T10:22:31.114Z",
                   "ingest_ts": "2026-06-01T10:22:31.480Z", "statement_count": 1 },
  "offset": { "gtid": "3E11FA47-71CA-11E1-9E33-C80AA9429562:152",
              "binlog_file": "mysql-bin.000042", "binlog_pos": 99812,
              "lsn": null, "scn": null, "resume_token": null },
  "fidelity": { "state": "HEALTHY",
                "source_config": { "binlog_format": "ROW", "binlog_row_image": "FULL",
                                   "gtid_mode": "ON", "log_bin": "ON",
                                   "config_snapshot_id": "cfg-2026-06-01T10:00Z" } },
  "completeness": { "consumed_offset_key": "3E11FA47-71CA-11E1-9E33-C80AA9429562:152",
                    "consumed_gtid_set": "3E11FA47-71CA-11E1-9E33-C80AA9429562:1-152",
                    "heartbeat_ts": "2026-06-01T10:22:30.900Z",
                    "gap_detected": false, "snapshot_phase": "streaming" },
  "actor": { "db_user": "ops_admin", "client_host": "10.0.7.21", "connection_id": "338217",
             "application_name": null, "attribution_confidence": "exact",
             "audit_event_ref": "dbaudit:2026-06-01/10/#44711",
             "correlation_basis": ["connection_id","gtid","time_window"] },
  "changes": [
    { "seq": 0, "operation": "UPDATE",
      "object": { "schema": "kafel", "name": "donations", "primary_key": { "id": 90211 } },
      "before": { "id": 90211, "amount": "100.00", "status": "approved", "approved_at": "2026-05-30T09:00:00.000Z" },
      "after":  { "id": 90211, "amount": "100000.00", "status": "approved", "approved_at": "2026-05-30T09:00:00.000Z" },
      "field_changes": [
        { "path": ["amount"], "old": "100.00", "new": "100000.00", "data_type": "decimal", "changed": true, "sensitive": false }
      ] }
  ],
  "evidence": {
    "event_hash": "sha256:9f2c4e1a7b6d3c8f0e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70",
    "prev_row_hash": "sha256:00000000000000000000000000000000000000000000000000000000000000aa",
    "row_hash": "sha256:ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
    "worm_object_key": "evidence/2026/06/01/seg-000142/8b1f5c7a.json",
    "segment_id": "seg-000142",
    "anchor_ref": { "head_hash": "sha256:cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34",
                    "hsm_signature": "MEUCIQ…base64…", "tsa_token": "MIIFx…base64…",
                    "anchor_provider": "rfc3161" } }
}
```

### C.2 Wallet balance manually updated (UPDATE — risk rule #2)
```json
{
  "schema_version": "cce-1.0",
  "envelope_id": "1c2d3e4f-5a6b-5c7d-8e9f-0a1b2c3d4e5f",
  "kind": "transaction",
  "source": { "db_id": "kafel-prod-mysql", "engine": "mysql", "server_uuid": "3E11FA47-71CA-11E1-9E33-C80AA9429562", "schema": "kafel" },
  "transaction": { "tx_id": "…:153", "commit_ts": "2026-06-01T22:14:03.001Z", "ingest_ts": "2026-06-01T22:14:03.300Z", "statement_count": 1 },
  "offset": { "gtid": "…:153", "binlog_file": "mysql-bin.000042", "binlog_pos": 101244, "lsn": null, "scn": null, "resume_token": null },
  "fidelity": { "state": "HEALTHY", "source_config": { "binlog_format": "ROW", "binlog_row_image": "FULL", "gtid_mode": "ON", "log_bin": "ON", "config_snapshot_id": "cfg-2026-06-01T22:00Z" }, "notes": ["off-hours"] },
  "completeness": { "consumed_offset_key": "…:153", "consumed_gtid_set": "…:1-153", "gap_detected": false, "snapshot_phase": "streaming" },
  "actor": { "db_user": "dba_root", "client_host": "10.0.7.99", "connection_id": "990001", "attribution_confidence": "probable", "audit_event_ref": "dbaudit:2026-06-01/22/#5510", "correlation_basis": ["time_window","table"] },
  "changes": [
    { "seq": 0, "operation": "UPDATE",
      "object": { "schema": "kafel", "name": "wallets", "primary_key": { "id": 4412 } },
      "before": { "id": 4412, "user_id": 778, "balance": "250.00" },
      "after":  { "id": 4412, "user_id": 778, "balance": "9250.00" },
      "field_changes": [ { "path": ["balance"], "old": "250.00", "new": "9250.00", "data_type": "decimal", "changed": true, "sensitive": false } ] }
  ]
}
```

### C.3 Beneficiary deletion with active balance (DELETE — risk rule #3)
```json
{
  "schema_version": "cce-1.0",
  "envelope_id": "2d3e4f5a-6b7c-5d8e-9f0a-1b2c3d4e5f60",
  "kind": "transaction",
  "source": { "db_id": "kafel-prod-mysql", "engine": "mysql", "server_uuid": "3E11FA47-71CA-11E1-9E33-C80AA9429562", "schema": "kafel" },
  "transaction": { "tx_id": "…:154", "commit_ts": "2026-06-01T11:05:10.500Z", "ingest_ts": "2026-06-01T11:05:10.800Z", "statement_count": 1 },
  "offset": { "gtid": "…:154", "binlog_file": "mysql-bin.000042", "binlog_pos": 103880, "lsn": null, "scn": null, "resume_token": null },
  "fidelity": { "state": "HEALTHY", "source_config": { "binlog_format": "ROW", "binlog_row_image": "FULL", "gtid_mode": "ON", "log_bin": "ON", "config_snapshot_id": "cfg-2026-06-01T11:00Z" } },
  "completeness": { "consumed_offset_key": "…:154", "consumed_gtid_set": "…:1-154", "gap_detected": false, "snapshot_phase": "streaming" },
  "actor": { "db_user": "app_user", "client_host": "10.0.0.5", "connection_id": "338990", "attribution_confidence": "exact", "audit_event_ref": "dbaudit:2026-06-01/11/#4490", "correlation_basis": ["connection_id","gtid"] },
  "changes": [
    { "seq": 0, "operation": "DELETE",
      "object": { "schema": "kafel", "name": "beneficiaries", "primary_key": { "id": 5567 } },
      "before": { "id": 5567, "name": "***", "national_id": "***", "balance": "1320.00", "status": "active" },
      "after": null,
      "field_changes": [
        { "path": ["name"], "old": "***", "new": null, "data_type": "string", "changed": true, "sensitive": true, "masked": true },
        { "path": ["national_id"], "old": "***", "new": null, "data_type": "string", "changed": true, "sensitive": true, "masked": true },
        { "path": ["balance"], "old": "1320.00", "new": null, "data_type": "decimal", "changed": true, "sensitive": false },
        { "path": ["status"], "old": "active", "new": null, "data_type": "string", "changed": true, "sensitive": false }
      ] }
  ]
}
```

### C.4 Campaign deletion with donations (DELETE — risk rule #4)
```json
{
  "schema_version": "cce-1.0",
  "envelope_id": "3e4f5a6b-7c8d-5e9f-0a1b-2c3d4e5f6071",
  "kind": "transaction",
  "source": { "db_id": "kafel-prod-mysql", "engine": "mysql", "server_uuid": "3E11FA47-71CA-11E1-9E33-C80AA9429562", "schema": "kafel" },
  "transaction": { "tx_id": "…:155", "commit_ts": "2026-06-01T03:41:00.220Z", "ingest_ts": "2026-06-01T03:41:00.500Z", "statement_count": 1 },
  "offset": { "gtid": "…:155", "binlog_file": "mysql-bin.000042", "binlog_pos": 106001, "lsn": null, "scn": null, "resume_token": null },
  "fidelity": { "state": "HEALTHY", "source_config": { "binlog_format": "ROW", "binlog_row_image": "FULL", "gtid_mode": "ON", "log_bin": "ON", "config_snapshot_id": "cfg-2026-06-01T03:00Z" }, "notes": ["off-hours"] },
  "completeness": { "consumed_offset_key": "…:155", "consumed_gtid_set": "…:1-155", "gap_detected": false, "snapshot_phase": "streaming" },
  "actor": { "db_user": "dba_root", "client_host": "10.0.7.99", "connection_id": "990050", "attribution_confidence": "probable", "audit_event_ref": "dbaudit:2026-06-01/03/#5599", "correlation_basis": ["time_window","table"] },
  "changes": [
    { "seq": 0, "operation": "DELETE",
      "object": { "schema": "kafel", "name": "campaigns", "primary_key": { "id": 88 } },
      "before": { "id": 88, "title": "Winter Relief", "status": "active", "total_raised": "45200.00" },
      "after": null,
      "field_changes": [
        { "path": ["title"], "old": "Winter Relief", "new": null, "data_type": "string", "changed": true, "sensitive": false },
        { "path": ["status"], "old": "active", "new": null, "data_type": "string", "changed": true, "sensitive": false },
        { "path": ["total_raised"], "old": "45200.00", "new": null, "data_type": "decimal", "changed": true, "sensitive": false }
      ] }
  ]
}
```

### C.5 Permission change (UPDATE — risk rule #5)
```json
{
  "schema_version": "cce-1.0",
  "envelope_id": "4f5a6b7c-8d9e-5f0a-1b2c-3d4e5f607182",
  "kind": "transaction",
  "source": { "db_id": "kafel-prod-mysql", "engine": "mysql", "server_uuid": "3E11FA47-71CA-11E1-9E33-C80AA9429562", "schema": "kafel" },
  "transaction": { "tx_id": "…:156", "commit_ts": "2026-06-01T12:00:00.000Z", "ingest_ts": "2026-06-01T12:00:00.260Z", "statement_count": 1 },
  "offset": { "gtid": "…:156", "binlog_file": "mysql-bin.000042", "binlog_pos": 108220, "lsn": null, "scn": null, "resume_token": null },
  "fidelity": { "state": "HEALTHY", "source_config": { "binlog_format": "ROW", "binlog_row_image": "FULL", "gtid_mode": "ON", "log_bin": "ON", "config_snapshot_id": "cfg-2026-06-01T12:00Z" } },
  "completeness": { "consumed_offset_key": "…:156", "consumed_gtid_set": "…:1-156", "gap_detected": false, "snapshot_phase": "streaming" },
  "actor": { "db_user": "app_user", "client_host": "10.0.0.5", "connection_id": "339100", "attribution_confidence": "exact", "audit_event_ref": "dbaudit:2026-06-01/12/#4602", "correlation_basis": ["connection_id","gtid"] },
  "changes": [
    { "seq": 0, "operation": "UPDATE",
      "object": { "schema": "kafel", "name": "user_roles", "primary_key": { "user_id": 778, "role_id": 2 } },
      "before": { "user_id": 778, "role_id": 2 },
      "after":  { "user_id": 778, "role_id": 1 },
      "field_changes": [ { "path": ["role_id"], "old": 2, "new": 1, "data_type": "int", "changed": true, "sensitive": false } ] }
  ]
}
```

---

*End of CCE v1 specification. Contract design only — no implementation code. v1 plan, the architecture review, and the v2 architecture remain unmodified.*
