# EDAM Companion Contracts — ReversalDirective v1 · ExecutionResult v1 · DB-Audit Event v1
### Formal contracts that depend on, and are compatible with, Canonical Change Event (CCE) v1

> **Document class:** Frozen contracts. Changes follow the same versioning/deprecation discipline as CCE v1 (§9 of `docs/CCE-v1-Specification.md`).
> **Authoritative inputs:** `docs/External-Database-Audit-Monitor-Plan.md` (v1), `docs/EDAM-Architecture-Review.md`, `docs/EDAM-v2-Architecture.md`, `docs/CCE-v1-Specification.md`.
> **Status:** Contract design only — no implementation code.
> **Schema ids:** `reversal-directive-1.0`, `execution-result-1.0`, `db-audit-event-1.0`.
> **Spec date:** 2026-06-01.

---

## 0. Why these three contracts exist

EDAM v2 splits responsibilities across **four trust domains** (EDAM v2 §1). Two seams between those domains must be frozen as contracts before any code is written:

1. **EDAM (Domain B) → Change Execution Service (Domain D):** EDAM must be able to express "this reversal is approved and authentic" *without holding any write credential to the monitored database*. That message is the **ReversalDirective**. The CES's signed answer is the **ExecutionResult**.
2. **Native DB audit (Domain A) → EDAM (Domain B):** the *who/where/how* feed that gives CCE its attribution must be normalized engine-agnostically before correlation. That normalized record is the **DB-Audit Event**.

**Non-negotiable invariants inherited from CCE v1 and EDAM v2 (binding on all three contracts):**
- **INV-1 — EDAM never writes to the monitored database.** A ReversalDirective is a *request*, never an execution. Nothing in EDAM holds a standing monitored-DB write credential.
- **INV-2 — No fabrication.** Unknown attribution is `unattributed`; an unverifiable result is a failure — never a guess.
- **INV-3 — Append-only & WORM-compatible.** Directives, results, and audit events are immutable once sealed and are written to the same WORM evidence store and hash-chain discipline as CCEs.
- **INV-4 — Determinism.** Identity derivation, canonical serialization, and hashing follow the **same frozen rules as CCE v1 §12.7** (UTF-8 NFC, sorted keys, exact-decimal money as strings, RFC3339 UTC ms, no insignificant whitespace). All three contracts reuse that algorithm verbatim.
- **INV-5 — Optimistic concurrency, all-or-nothing.** A reversal executes only if the current row still equals the captured **after-image**; otherwise `DRIFT_CONFLICT` and **no write**. Partial reversal is forbidden.

---

# PART A — ReversalDirective v1

## A.1 Purpose
A **ReversalDirective** is an approved, four-eyes-eligible, HSM-signed, single-use instruction that authorizes the **Change Execution Service (CES)** to apply *one* compensating change to *one* row in the monitored database — restoring a captured before-image — under strict optimistic-concurrency preconditions. It is the only artifact that can cause a monitored-DB write, and it is produced **outside** the write boundary: EDAM signs it; CES validates and (maybe) executes it.

A directive is **not** SQL handed to a privileged user. It is a *declarative intent* (target + before/after images + restored image + preconditions + approvals + signature). CES is responsible for translating intent into a concrete, optimistic-concurrency statement using its own short-lived dynamic credential.

## A.2 Lifecycle & states

```
 DRAFT ──► PENDING_APPROVAL ──► APPROVED ──► SIGNED ──► DISPATCHED ──► CONSUMED
   │             │                  │           │            │            │
 analyst      awaiting          quorum met   HSM signs    sent to CES   CES has
 builds       approver(s)       (4-eyes if   directive    over mTLS     validated &
 intent       + WebAuthn        critical)    (immutable)                acted (terminal
                                                                        for the directive)
   │             │
   └─► (any pre-SIGNED state) ──► REJECTED        ──► (terminal)
   └─► (SIGNED but not consumed) ──► EXPIRED       ──► (terminal, after expires_at / nonce window)
```

| State | Meaning | Who sets it | Mutable? |
|---|---|---|---|
| `DRAFT` | Analyst constructing intent from a CCE. | Analyst (EDAM) | Yes (pre-seal) |
| `PENDING_APPROVAL` | Submitted; awaiting required approvals. | Analyst → system | Approvals append only |
| `APPROVED` | Required quorum reached (four-eyes if critical). | Approvers | No (forward) |
| `SIGNED` | HSM-signed; canonical bytes frozen. **Immutability boundary.** | Signing service | **No** |
| `DISPATCHED` | Delivered to CES over mTLS. | EDAM | No |
| `CONSUMED` | CES has validated and produced an ExecutionResult (success/drift/failure). | CES (observed by EDAM) | No |
| `REJECTED` | Rejected before signing (see A.13). | Approver/system | Terminal |
| `EXPIRED` | `expires_at` passed or nonce window closed before CONSUMED. | System | Terminal |

**Rules:**
- A directive may be `CONSUMED` **at most once** (single-use, enforced by nonce, A.7).
- A directive **cannot transition back**; a re-attempt requires a *new* directive (new id, new nonce, fresh approvals).
- Every state of a SIGNED directive is recorded append-only and is WORM-compatible (INV-3).

## A.3 Identity model
- `directive_id` — deterministic UUIDv5 over `(edam_instance_id ‖ related_cce_envelope_id ‖ nonce)`. Tying identity to the **source CCE envelope_id** binds a reversal to the exact captured change it undoes (CCE v1 §3); tying it to the `nonce` guarantees a fresh id per attempt.
- `related_cce_envelope_id` — the CCE (CCE v1) whose change this directive reverses. **Required.** Must reference a sealed CCE.
- `nonce` — single-use random 128-bit value (A.7).

## A.4 Approval model
- Approvals are **append-only** records inside the directive: `{approver_id, decision, webauthn_assertion_ref, decided_at}`.
- `decision ∈ {approve, reject}`. Any `reject` before signing moves the directive to `REJECTED`.
- Each approver may appear **once** (one decision per approver — mirrors v1 `reversal_approvals` uniqueness).
- The **requester is excluded** from approving their own directive (separation of duties, Part G).
- Critical financial approvals require **WebAuthn** assertions (phishing-resistant); the assertion reference is recorded, not the raw credential.

## A.5 Four-eyes enforcement
- `requires_four_eyes` is derived from policy: any directive targeting a **financial/sensitive table** (donations, wallets, balances, beneficiaries) or any DELETE/DDL/TRUNCATE reversal is critical.
- When `requires_four_eyes == true`: **two distinct approvers**, both `approve`, **neither equal to `requested_by`**, both with WebAuthn assertions. The signing service MUST refuse to sign unless this quorum is satisfied (validation V-A12).
- When `false`: one approver (≠ requester) suffices, WebAuthn still required for any financial table.

## A.6 Expiry
- `expires_at` is a hard wall-clock deadline (short — minutes, policy-bounded, e.g., ≤ 15 min from signing). After it, CES MUST reject with `DIRECTIVE_EXPIRED` even if all else is valid.
- Expiry shrinks the window in which a stolen/leaked directive is usable.

## A.7 Nonce & replay protection
- `nonce` is unique per directive; CES maintains a **consumed-nonce ledger** (append-only, WORM-backed). A directive whose nonce has already been consumed MUST be rejected with `REPLAY_DETECTED`.
- Combined rule: CES executes a directive **only if** signature valid **AND** quorum valid **AND** `now < expires_at` **AND** nonce not previously consumed. All four are mandatory.

## A.8 Target specification

| Concept | Field | Notes |
|---|---|---|
| Target database | `target.db_id`, `target.engine` | Must match the `source.db_id`/`engine` of the related CCE. |
| Target table | `target.schema`, `target.table` | Must be on the CES write-whitelist (Part G). |
| Primary key | `target.primary_key` | Copied from the CCE change item's `object.primary_key`. |

## A.9 Images & proposed restored image
- `captured_before_image` — the CCE change item's `before` (the value to restore). For a DELETE reversal this is the row to re-insert; for an INSERT reversal it is `null` (the restored state is "row absent").
- `captured_after_image` — the CCE change item's `after` (the *current expected* value). **This is the optimistic-concurrency precondition** (A.11). For a DELETE reversal it is `null` (the row is expected to be absent — i.e., still deleted).
- `proposed_restored_image` — the exact target state CES must produce. Normally equals `captured_before_image`. Stated explicitly so the preview/approval shows precisely what will exist after execution; CES MUST NOT compute it independently.
- All three images use the same value encoding as CCE (exact-decimal money as strings, INV-4).

## A.10 Operation type
`reversal_operation ∈ {RESTORE_UPDATE, REINSERT_DELETED, DELETE_INSERTED}`:

| `reversal_operation` | Reverses CCE op | CES action (intent) | After-image precondition |
|---|---|---|---|
| `RESTORE_UPDATE` | UPDATE | set row fields back to `captured_before_image` | row currently equals `captured_after_image` |
| `REINSERT_DELETED` | DELETE | re-insert `captured_before_image` | row currently **absent** (`captured_after_image == null`) |
| `DELETE_INSERTED` | INSERT | delete the inserted row | row currently equals `captured_after_image` (the inserted row) |

DDL/TRUNCATE reversals are **not supported** by v1 directives (too dangerous to auto-compose); such cases are handled by out-of-band manual change control and are explicitly out of scope (V-A14).

## A.11 Optimistic concurrency (normative — the core safety property)
- CES MUST execute inside **one transaction** with a precondition that the current row **fully equals** `captured_after_image` across **every column** present in the after-image — not just the primary key, not a separate prior read.
  - `RESTORE_UPDATE` / `DELETE_INSERTED`: `WHERE pk = … AND <every after-image column> = <captured value>`.
  - `REINSERT_DELETED`: conditional insert that succeeds only if no row with that PK currently exists.
- If the precondition matches **exactly one** row → apply and commit.
- If it matches **zero** rows (the row changed again since capture, or was already reverted) → **abort, write nothing**, return `DRIFT_CONFLICT` (ExecutionResult, Part B).
- **No partial reversal.** Either the full restored image is applied atomically, or nothing is. CES MUST NOT apply a subset of fields.
- This closes the v1 TOCTOU race (review H3) by making the check and the write atomic within the executing transaction.

## A.12 Risk context
- `risk_context` carries the justification snapshot: `{risk_score, triggered_rules[], reason_text, related_alert_id}`. Informational for audit and for the approval UI; CES does not act on it but records it.

## A.13 Validation rules (ReversalDirective)
- **V-A1** `schema_version == "reversal-directive-1.0"`.
- **V-A2** `directive_id` valid UUID, reproducible from `(edam_instance_id, related_cce_envelope_id, nonce)`.
- **V-A3** `related_cce_envelope_id` is a valid UUID referencing a sealed CCE.
- **V-A4** `target.engine` ∈ CCE engine enum; `target.db_id/engine` match the related CCE's source.
- **V-A5** `reversal_operation` ∈ enum; image nullity matches A.10 (e.g., `REINSERT_DELETED` ⇒ `captured_after_image == null`, `captured_before_image != null`).
- **V-A6** `target.primary_key` non-empty.
- **V-A7** `proposed_restored_image` present and consistent with `reversal_operation` (equals before-image for RESTORE/REINSERT; `null`/absent for DELETE_INSERTED).
- **V-A8** `nonce` present, 128-bit, unique.
- **V-A9** `expires_at` present, in the future at signing, and within policy max window.
- **V-A10** `requested_by` present and **not** among `approvals[].approver_id`.
- **V-A11** Each `approvals[].approver_id` unique; each has `decision`; critical approvals have `webauthn_assertion_ref`.
- **V-A12** If `requires_four_eyes`, at least two `approve` decisions from distinct approvers (≠ requester); signing MUST be refused otherwise.
- **V-A13** (SIGNED) `hsm_signature` present and verifies over canonical bytes against the registered EDAM signing public key; `signing_key_id` recorded.
- **V-A14** `reversal_operation` MUST NOT be a DDL/TRUNCATE reversal (unsupported in v1).
- **V-A15** Money/decimal values in images encoded as exact strings, never floats (INV-4).

## A.14 Rejection reasons (enum)
`REJECTED_BY_APPROVER`, `INSUFFICIENT_QUORUM`, `REQUESTER_CANNOT_APPROVE`, `POLICY_VIOLATION`, `TARGET_NOT_WHITELISTED`, `UNSUPPORTED_OPERATION`, `STALE_CCE_REFERENCE`, `IMAGE_INCONSISTENT`. (CES-side rejections of a SIGNED directive are reported as ExecutionResult statuses in Part B, not here.)

---

# PART B — ExecutionResult v1

## B.1 Purpose
An **ExecutionResult** is the **signed, append-only receipt** the Change Execution Service returns for exactly one ReversalDirective. It is the authoritative, non-repudiable record of what CES did (or refused to do), including the drift outcome and post-state verification. EDAM ingests it, records it append-only, and — because the reversal itself is a real DB change — also captures the reversal via the normal CDC path as its **own CCE**, which the ExecutionResult references for closed-loop forensic linkage.

## B.2 Lifecycle & states

```
 RECEIVED ──► VALIDATED ──► EXECUTED ──► VERIFIED ──► SEALED
    │            │             │            │           │
 CES gets    sig/quorum/   txn applied   post-state   result signed,
 directive   expiry/nonce  (or aborted)  compared     hash-chained,
             checked       per outcome   to restored  WORM-written
    │            │
    └─► VALIDATION_FAILED (terminal)   (e.g., bad sig / expired / replay)
```

| `result_status` (terminal) | Meaning |
|---|---|
| `SUCCESS` | Precondition matched exactly one row; restored image applied & committed; post-state verified. |
| `DRIFT_CONFLICT` | Current row ≠ captured after-image (or PK presence mismatch); **nothing written**. |
| `VALIDATION_FAILED` | Directive failed signature/quorum/expiry/replay/whitelist checks; **nothing written**. |
| `EXECUTION_FAILED` | Precondition matched but the write/commit failed (DB error, timeout); transaction rolled back; **nothing persisted**. |
| `VERIFICATION_FAILED` | Write committed but post-state read does **not** equal `proposed_restored_image`; flagged CRITICAL, no retry without new directive. |

**Rules:** every ExecutionResult is **single-valued** (one terminal status), append-only, and immutable once `SEALED`. CES never silently succeeds without verification; `VERIFICATION_FAILED` is a first-class outcome (no fabrication, INV-2).

## B.3 Identity model
- `result_id` — deterministic UUIDv5 over `(ces_instance_id ‖ directive_id ‖ executed_at)`.
- `directive_id` — the consumed ReversalDirective (**required**, 1:1).
- `reversal_cce_envelope_id` — the CCE that captured the reversal write itself (**conditional**: present on `SUCCESS`/`VERIFICATION_FAILED`; null when nothing was written). This is the closed loop: directive → result → the CCE proving the change happened.

## B.4 Executor identity & credential metadata
- `executor.ces_instance_id`, `executor.service_identity` (mTLS/SPIFFE id) — who executed. CES operators are a **different trust domain** than EDAM approvers (Part G).
- `credential.issued_at`, `credential.ttl_seconds`, `credential.vault_lease_id`, `credential.scope` — proof that a **short-lived dynamic credential** (not a standing one) was used, scoped to the whitelisted target. `ttl_seconds` MUST be small (policy-bounded). EDAM verifies the lease was issued *after* the directive was signed and *expired/relinquished* after execution.

## B.5 Timestamps
- `executed_at` (CES trusted monotonic), `execution_started_at`, `execution_finished_at`. Evidentiary timeline uses CES trusted time + the anchored timestamp of the SEALED result, never the monitored-DB clock (CCE v1 §4.3 discipline).

## B.6 Outcome detail
- `affected_rows` — MUST be `1` for `SUCCESS`; `0` for `DRIFT_CONFLICT`; `0` for `VALIDATION_FAILED`/`EXECUTION_FAILED`.
- `post_state` — the row as re-read after execution (masked per sensitivity). Compared to `proposed_restored_image`.
- `post_state_matches` — boolean; `true` ⇒ `SUCCESS`, `false` ⇒ `VERIFICATION_FAILED`.
- `drift` — present only on `DRIFT_CONFLICT`: `{expected_after_image, observed_current_image, differing_paths[]}` so analysts see exactly what changed since capture. Observed image masked for sensitive fields.
- `failure` — present on `VALIDATION_FAILED`/`EXECUTION_FAILED`/`VERIFICATION_FAILED`: `{code, message}` with `code` ∈ `{BAD_SIGNATURE, DIRECTIVE_EXPIRED, REPLAY_DETECTED, QUORUM_INVALID, TARGET_NOT_WHITELISTED, DB_ERROR, TIMEOUT, POSTSTATE_MISMATCH}`.

## B.7 Signed execution receipt & evidence
- `receipt.event_hash` — SHA-256 over the canonical serialization of the ExecutionResult **core** (INV-4), identical algorithm to CCE v1.
- `receipt.ces_signature`, `receipt.ces_signing_key_id` — **CES signs its own results** with a CES-held key (distinct from EDAM's signing key). EDAM validates this signature on ingest; it proves the result genuinely came from CES and was not forged inside EDAM.
- `receipt.prev_row_hash` / `receipt.row_hash` / `receipt.worm_object_key` / `receipt.anchor_ref` — results are chained, WORM-written, and externally anchored exactly like CCEs (EDAM v2 §2, INV-3). Results may share the evidence chain with CCEs or maintain a parallel chain; either way each result is independently verifiable by an outsider with only public keys.

## B.8 Linkage to the reversal CCE
- When a write occurs, CES's change appears on the normal CDC stream and is sealed as a CCE. EDAM links `ExecutionResult.reversal_cce_envelope_id` → that CCE, and the CCE's `actor.db_user` will be the CES dynamic credential identity — providing **two independent records** of the same reversal (CES receipt + CDC-captured CCE). Divergence between them is a CRITICAL integrity alarm.

## B.9 Validation rules (ExecutionResult)
- **V-B1** `schema_version == "execution-result-1.0"`.
- **V-B2** `result_id` valid UUID, reproducible from `(ces_instance_id, directive_id, executed_at)`.
- **V-B3** `directive_id` references a known SIGNED/DISPATCHED directive.
- **V-B4** `result_status` ∈ enum; exactly one terminal value.
- **V-B5** `affected_rows` consistent with status (SUCCESS⇒1; all non-SUCCESS write outcomes⇒0).
- **V-B6** `SUCCESS` ⇒ `post_state_matches == true` AND `reversal_cce_envelope_id` present (or pending-link flagged).
- **V-B7** `DRIFT_CONFLICT` ⇒ `drift` object present with `differing_paths`; no write claimed.
- **V-B8** `VERIFICATION_FAILED` ⇒ `post_state_matches == false` and `failure.code == POSTSTATE_MISMATCH`.
- **V-B9** `VALIDATION_FAILED`/`EXECUTION_FAILED` ⇒ `failure` present; `affected_rows == 0`.
- **V-B10** `credential.ttl_seconds` ≤ policy max; `credential.issued_at` ≥ directive signing time.
- **V-B11** `receipt.ces_signature` verifies over canonical core against the registered CES public key.
- **V-B12** (SEALED) `row_hash == SHA256(prev_row_hash ‖ event_hash)`.
- **V-B13** Money/decimal in `post_state`/`drift` encoded as exact strings.

---

# PART C — DB-Audit Event v1

## C.1 Purpose
A **DB-Audit Event** is the engine-agnostic normalization of a native database audit record. CDC/CCE tells EDAM *what changed*; the DB-Audit Event supplies *who/where/how* so the **Attribution correlator** (EDAM v2 §5, CCE v1 §7) can raise a CCE's `actor.attribution_confidence` from `unattributed` toward `probable`/`exact`. It is **read-only intelligence** ingested over a one-way egress from Domain A; it never authorizes any action.

## C.2 Supported sources
| Source | `audit_source.type` | Notes |
|---|---|---|
| **MySQL Enterprise Audit** | `mysql_enterprise_audit` | Licensed plugin; rich connect/query/user/host events (JSON/XML). |
| **MariaDB Audit Plugin** (`server_audit`) | `mariadb_audit_plugin` | Free; CONNECT/QUERY/TABLE event classes; line-based log. |
| **Percona Audit Log Plugin** | `percona_audit_plugin` | Free; JSON output. |
| **Cloud provider audit logs** | `cloud_audit` (+ `audit_source.provider` ∈ `aws_rds`/`aurora`/`gcp_cloudsql`/`azure_sql`) | Managed; format/coverage varies; may omit some event classes. |

A normalizer (one per source type) maps the native record into the common DB-Audit Event below. **No downstream component parses native audit formats** (mirrors CCE v1 §12.1).

## C.3 Lifecycle
```
 INGESTED ──► NORMALIZED ──► SEALED ──► (available for) CORRELATED
    │             │             │                         │
 raw native   mapped to     hashed +                  joined to a CCE
 audit line   common form   WORM-written              actor{} (advisory)
```
- DB-Audit Events are **append-only** and WORM-compatible (INV-3); they are evidence in their own right (they prove who was connected).
- `CORRELATED` is a relationship recorded on the CCE side (CCE `actor.audit_event_ref`), not a mutation of the audit event.

## C.4 Normalized fields (overview; full schema in Part D)
| Field | Meaning |
|---|---|
| `db_user` | Authenticated DB account. |
| `client_host` | Origin host/IP (and `proxy_host` if via proxy). |
| `connection_id` | Source connection/session id (the primary CDC join key). |
| `thread_id` | Engine thread id where available (secondary join key). |
| `statement_digest` | Normalized statement fingerprint (parameters stripped) — safe to store/index. |
| `statement_class` | `CONNECT`/`QUERY`/`DML`/`DDL`/`ADMIN`/`DISCONNECT`. |
| `objects[]` | Tables/objects touched (schema.name) where the source reports them. |
| `event_ts` | Source-reported audit timestamp (untrusted, like CCE `commit_ts`). |
| `ingest_ts` | EDAM trusted monotonic receive time. |
| `raw_statement_ref` | Reference/handle to the raw statement (see C.5), **not** the inline raw text by default. |

## C.5 Raw statement handling & masking (normative)
- **Default: do not store inline raw SQL** in the queryable projection. Store the **`statement_digest`** (parameters removed) for correlation and search.
- The full raw statement, if retained for forensics, is written **only to WORM** under stricter access, referenced by `raw_statement_ref`, and is subject to **crypto-shred** for erasure reconciliation (EDAM v2 §9, CCE v1 §12.9).
- **Masking:** literals that may contain PII/financial values (national_id, IBAN, amounts) are masked in `statement_digest` and any retained form; `contains_sensitive` flags when masking was applied. Notifications and the dashboard use the masked digest.

## C.6 Audit source identity & plugin state (tamper indicators)
- `audit_source.id`, `audit_source.type`, `audit_source.provider`, `audit_source.host` — which audit feed produced this.
- `plugin_state` — `{loaded: bool, logging_active: bool, last_heartbeat_ts, policy_hash}` sampled by the Attestation Monitor (EDAM v2 §4). If the audit plugin is unloaded/disabled or its policy changes, this is a **tamper indicator**:
  - `tamper_indicators[]` may include `AUDIT_PLUGIN_DISABLED`, `AUDIT_LOG_GAP`, `AUDIT_POLICY_CHANGED`, `CLOCK_SKEW`. Any present ⇒ correlation confidence is capped and a fidelity alarm is raised. This is how EDAM *detects* the very tampering that would otherwise silently destroy attribution (review H1).

## C.7 Correlation fields for CCE
The correlator joins a DB-Audit Event to a CCE change using, in priority order:
1. `connection_id` + transaction time window (CCE `transaction.commit_ts`±window) → strong.
2. `connection_id` + `thread_id` (+ GTID where the audit feed exposes it) → strongest.
3. `objects[]` table match + time window + single candidate → medium.

The result is written to the CCE's `actor.audit_event_ref` and `actor.correlation_basis` (CCE v1 §6.3).

## C.8 Attribution confidence model
Maps directly onto CCE `actor.attribution_confidence`:
| Confidence | Condition |
|---|---|
| `exact` | Deterministic key join (connection_id + thread_id/GTID within window), single candidate, no tamper indicators. |
| `probable` | Time-window + connection_id or table correlation, single most-likely candidate, no disqualifying tamper indicators. |
| `unattributed` | No usable audit record, ambiguous multi-candidate, or tamper indicators present (plugin disabled/gap). |

## C.9 Limitations (stated, never hidden — INV-2)
1. Native audit can be **disabled or cleared** by a sufficiently privileged actor; `plugin_state`/`tamper_indicators` *detect* this but cannot recover lost attribution — affected CCEs remain `unattributed`.
2. **Out-of-band changes** (datafile-level edits, replayed binlog forgery) may produce a CCE with **no** corresponding audit event and may also bypass CDC — outside this contract's guarantee.
3. **Cloud audit logs** vary by provider/tier and may omit event classes or delay delivery, lowering achievable confidence.
4. **Connection pooling / shared service accounts** mean `db_user` may be a service identity, not a human; attribution to a human then requires application-layer correlation, which is advisory only.
5. Audit `event_ts` is **untrusted** (source clock); correlation windows must tolerate skew and `CLOCK_SKEW` is a tamper indicator.

---

# PART D — JSON Schemas (Draft 2020-12)

> All three reuse CCE v1's canonical serialization and hashing (INV-4). Stateful rules (deterministic id derivation, signature verification, quorum, hash recomputation) are enforced by the conformance suites (Part F), not by JSON Schema alone.

## D.1 ReversalDirective v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/reversal-directive-1.0.schema.json",
  "title": "ReversalDirective v1",
  "type": "object",
  "required": ["schema_version","directive_id","related_cce_envelope_id","state","target",
               "reversal_operation","captured_before_image","captured_after_image",
               "proposed_restored_image","requested_by","requires_four_eyes","approvals",
               "nonce","expires_at","created_at"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "const": "reversal-directive-1.0" },
    "directive_id": { "type": "string", "format": "uuid" },
    "edam_instance_id": { "type": "string", "minLength": 1 },
    "related_cce_envelope_id": { "type": "string", "format": "uuid" },
    "related_alert_id": { "type": ["string","null"] },
    "state": { "type": "string", "enum": ["DRAFT","PENDING_APPROVAL","APPROVED","SIGNED","DISPATCHED","CONSUMED","REJECTED","EXPIRED"] },
    "target": {
      "type": "object",
      "required": ["db_id","engine","schema","table","primary_key"],
      "additionalProperties": false,
      "properties": {
        "db_id": { "type": "string", "minLength": 1 },
        "engine": { "type": "string", "enum": ["mysql","mariadb","postgres","sqlserver","oracle","mongodb"] },
        "schema": { "type": "string", "minLength": 1 },
        "table": { "type": "string", "minLength": 1 },
        "primary_key": { "type": "object", "minProperties": 1 }
      }
    },
    "reversal_operation": { "type": "string", "enum": ["RESTORE_UPDATE","REINSERT_DELETED","DELETE_INSERTED"] },
    "captured_before_image": { "type": ["object","null"] },
    "captured_after_image": { "type": ["object","null"] },
    "proposed_restored_image": { "type": ["object","null"] },
    "risk_context": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "risk_score": { "type": "integer" },
        "triggered_rules": { "type": "array", "items": { "type": "string" } },
        "reason_text": { "type": "string" }
      }
    },
    "requested_by": { "type": "string", "minLength": 1 },
    "requires_four_eyes": { "type": "boolean" },
    "approvals": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["approver_id","decision","decided_at"],
        "additionalProperties": false,
        "properties": {
          "approver_id": { "type": "string", "minLength": 1 },
          "decision": { "type": "string", "enum": ["approve","reject"] },
          "webauthn_assertion_ref": { "type": "string" },
          "decided_at": { "type": "string", "format": "date-time" },
          "comment": { "type": "string" }
        }
      }
    },
    "rejection_reason": { "type": ["string","null"],
      "enum": ["REJECTED_BY_APPROVER","INSUFFICIENT_QUORUM","REQUESTER_CANNOT_APPROVE","POLICY_VIOLATION","TARGET_NOT_WHITELISTED","UNSUPPORTED_OPERATION","STALE_CCE_REFERENCE","IMAGE_INCONSISTENT",null] },
    "nonce": { "type": "string", "pattern": "^[0-9a-f]{32}$" },
    "expires_at": { "type": "string", "format": "date-time" },
    "created_at": { "type": "string", "format": "date-time" },
    "signature": {
      "type": ["object","null"],
      "additionalProperties": false,
      "properties": {
        "hsm_signature": { "type": "string" },
        "signing_key_id": { "type": "string" },
        "signed_at": { "type": "string", "format": "date-time" },
        "canonical_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    }
  },
  "allOf": [
    { "if": { "properties": { "reversal_operation": { "const": "REINSERT_DELETED" } } },
      "then": { "properties": { "captured_after_image": { "const": null },
                                "captured_before_image": { "type": "object" } } } },
    { "if": { "properties": { "reversal_operation": { "const": "DELETE_INSERTED" } } },
      "then": { "properties": { "captured_after_image": { "type": "object" } } } },
    { "if": { "properties": { "requires_four_eyes": { "const": true } } },
      "then": { "properties": { "approvals": { "minItems": 2 } } } },
    { "if": { "properties": { "state": { "enum": ["SIGNED","DISPATCHED","CONSUMED"] } } },
      "then": { "required": ["signature"], "properties": { "signature": { "type": "object", "required": ["hsm_signature","signing_key_id","canonical_hash"] } } } }
  ]
}
```

## D.2 ExecutionResult v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/execution-result-1.0.schema.json",
  "title": "ExecutionResult v1",
  "type": "object",
  "required": ["schema_version","result_id","directive_id","result_status","executor",
               "credential","executed_at","affected_rows","receipt"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "const": "execution-result-1.0" },
    "result_id": { "type": "string", "format": "uuid" },
    "directive_id": { "type": "string", "format": "uuid" },
    "reversal_cce_envelope_id": { "type": ["string","null"], "format": "uuid" },
    "result_status": { "type": "string", "enum": ["SUCCESS","DRIFT_CONFLICT","VALIDATION_FAILED","EXECUTION_FAILED","VERIFICATION_FAILED"] },
    "executor": {
      "type": "object",
      "required": ["ces_instance_id","service_identity"],
      "additionalProperties": false,
      "properties": {
        "ces_instance_id": { "type": "string", "minLength": 1 },
        "service_identity": { "type": "string", "minLength": 1 }
      }
    },
    "credential": {
      "type": "object",
      "required": ["issued_at","ttl_seconds","scope"],
      "additionalProperties": false,
      "properties": {
        "issued_at": { "type": "string", "format": "date-time" },
        "ttl_seconds": { "type": "integer", "minimum": 1 },
        "vault_lease_id": { "type": "string" },
        "scope": { "type": "string", "minLength": 1 }
      }
    },
    "execution_started_at": { "type": "string", "format": "date-time" },
    "execution_finished_at": { "type": "string", "format": "date-time" },
    "executed_at": { "type": "string", "format": "date-time" },
    "affected_rows": { "type": "integer", "minimum": 0 },
    "post_state": { "type": ["object","null"] },
    "post_state_matches": { "type": ["boolean","null"] },
    "drift": {
      "type": ["object","null"],
      "additionalProperties": false,
      "properties": {
        "expected_after_image": { "type": ["object","null"] },
        "observed_current_image": { "type": ["object","null"] },
        "differing_paths": { "type": "array", "items": { "type": "array", "items": { "type": "string" } } }
      }
    },
    "failure": {
      "type": ["object","null"],
      "additionalProperties": false,
      "properties": {
        "code": { "type": "string", "enum": ["BAD_SIGNATURE","DIRECTIVE_EXPIRED","REPLAY_DETECTED","QUORUM_INVALID","TARGET_NOT_WHITELISTED","DB_ERROR","TIMEOUT","POSTSTATE_MISMATCH"] },
        "message": { "type": "string" }
      }
    },
    "receipt": {
      "type": "object",
      "required": ["event_hash","ces_signature","ces_signing_key_id"],
      "additionalProperties": false,
      "properties": {
        "event_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "prev_row_hash": { "type": ["string","null"], "pattern": "^sha256:[0-9a-f]{64}$" },
        "row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "ces_signature": { "type": "string" },
        "ces_signing_key_id": { "type": "string" },
        "worm_object_key": { "type": "string" },
        "anchor_ref": { "type": ["object","null"] }
      }
    }
  },
  "allOf": [
    { "if": { "properties": { "result_status": { "const": "SUCCESS" } } },
      "then": { "properties": { "affected_rows": { "const": 1 }, "post_state_matches": { "const": true } },
                "required": ["post_state"] } },
    { "if": { "properties": { "result_status": { "const": "DRIFT_CONFLICT" } } },
      "then": { "properties": { "affected_rows": { "const": 0 } }, "required": ["drift"] } },
    { "if": { "properties": { "result_status": { "enum": ["VALIDATION_FAILED","EXECUTION_FAILED","VERIFICATION_FAILED"] } } },
      "then": { "required": ["failure"], "properties": { "affected_rows": { "const": 0 } } } },
    { "if": { "properties": { "result_status": { "const": "VERIFICATION_FAILED" } } },
      "then": { "properties": { "post_state_matches": { "const": false } } } }
  ]
}
```

## D.3 DB-Audit Event v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/db-audit-event-1.0.schema.json",
  "title": "DB-Audit Event v1",
  "type": "object",
  "required": ["schema_version","audit_event_id","audit_source","statement_class","event_ts","ingest_ts","attribution_confidence"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "const": "db-audit-event-1.0" },
    "audit_event_id": { "type": "string", "format": "uuid" },
    "audit_source": {
      "type": "object",
      "required": ["id","type"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "type": { "type": "string", "enum": ["mysql_enterprise_audit","mariadb_audit_plugin","percona_audit_plugin","cloud_audit"] },
        "provider": { "type": "string", "enum": ["aws_rds","aurora","gcp_cloudsql","azure_sql"] },
        "host": { "type": "string" }
      }
    },
    "db_user": { "type": ["string","null"] },
    "client_host": { "type": ["string","null"] },
    "proxy_host": { "type": ["string","null"] },
    "connection_id": { "type": ["string","null"] },
    "thread_id": { "type": ["string","null"] },
    "statement_class": { "type": "string", "enum": ["CONNECT","QUERY","DML","DDL","ADMIN","DISCONNECT"] },
    "statement_digest": { "type": ["string","null"] },
    "objects": {
      "type": "array",
      "items": { "type": "object", "required": ["schema","name"],
                 "properties": { "schema": { "type": "string" }, "name": { "type": "string" } } }
    },
    "contains_sensitive": { "type": "boolean" },
    "raw_statement_ref": { "type": ["string","null"] },
    "event_ts": { "type": "string", "format": "date-time" },
    "ingest_ts": { "type": "string", "format": "date-time" },
    "plugin_state": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "loaded": { "type": "boolean" },
        "logging_active": { "type": "boolean" },
        "last_heartbeat_ts": { "type": "string", "format": "date-time" },
        "policy_hash": { "type": "string" }
      }
    },
    "tamper_indicators": { "type": "array", "items": { "type": "string",
       "enum": ["AUDIT_PLUGIN_DISABLED","AUDIT_LOG_GAP","AUDIT_POLICY_CHANGED","CLOCK_SKEW"] } },
    "attribution_confidence": { "type": "string", "enum": ["exact","probable","unattributed"] },
    "evidence": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "event_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "prev_row_hash": { "type": ["string","null"], "pattern": "^sha256:[0-9a-f]{64}$" },
        "row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "worm_object_key": { "type": "string" }
      }
    }
  },
  "allOf": [
    { "if": { "properties": { "attribution_confidence": { "not": { "const": "unattributed" } } } },
      "then": { "required": ["connection_id"] } },
    { "if": { "properties": { "audit_source": { "properties": { "type": { "const": "cloud_audit" } } } } },
      "then": { "properties": { "audit_source": { "required": ["provider"] } } } }
  ]
}
```

---

# PART E — Examples

### E.1 Approved donation amount reversal directive (SIGNED, four-eyes)
Reverses the CCE in `CCE-v1-Specification.md` C.1 (`amount` 100.00 → 100000.00).
```json
{
  "schema_version": "reversal-directive-1.0",
  "directive_id": "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d",
  "edam_instance_id": "edam-prod-1",
  "related_cce_envelope_id": "8b1f5c7a-2d44-5f0e-9a3b-1c2d3e4f5a6b",
  "related_alert_id": "alert-77120",
  "state": "SIGNED",
  "target": { "db_id": "kafel-prod-mysql", "engine": "mysql", "schema": "kafel",
              "table": "donations", "primary_key": { "id": 90211 } },
  "reversal_operation": "RESTORE_UPDATE",
  "captured_before_image": { "id": 90211, "amount": "100.00", "status": "approved", "approved_at": "2026-05-30T09:00:00.000Z" },
  "captured_after_image":  { "id": 90211, "amount": "100000.00", "status": "approved", "approved_at": "2026-05-30T09:00:00.000Z" },
  "proposed_restored_image": { "id": 90211, "amount": "100.00", "status": "approved", "approved_at": "2026-05-30T09:00:00.000Z" },
  "risk_context": { "risk_score": 95, "triggered_rules": ["donation_amount_changed_after_approval"],
                    "reason_text": "Amount altered post-approval by ops_admin; restore to approved value." },
  "requested_by": "analyst.sara",
  "requires_four_eyes": true,
  "approvals": [
    { "approver_id": "approver.layla", "decision": "approve", "webauthn_assertion_ref": "wa:assert:9912", "decided_at": "2026-06-01T10:40:00.000Z" },
    { "approver_id": "compliance.omar", "decision": "approve", "webauthn_assertion_ref": "wa:assert:9913", "decided_at": "2026-06-01T10:41:10.000Z" }
  ],
  "rejection_reason": null,
  "nonce": "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  "expires_at": "2026-06-01T10:56:10.000Z",
  "created_at": "2026-06-01T10:38:00.000Z",
  "signature": { "hsm_signature": "MEUCIQDk…base64…", "signing_key_id": "edam-sign-key-2026",
                 "signed_at": "2026-06-01T10:41:20.000Z",
                 "canonical_hash": "sha256:4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809112233" }
}
```

### E.2 Drift conflict execution result
The row changed again after capture; CES wrote nothing.
```json
{
  "schema_version": "execution-result-1.0",
  "result_id": "b2c3d4e5-f6a7-5b8c-9d0e-1f2a3b4c5d6e",
  "directive_id": "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d",
  "reversal_cce_envelope_id": null,
  "result_status": "DRIFT_CONFLICT",
  "executor": { "ces_instance_id": "ces-prod-1", "service_identity": "spiffe://edam/ces/prod-1" },
  "credential": { "issued_at": "2026-06-01T10:42:00.000Z", "ttl_seconds": 120,
                  "vault_lease_id": "vault:lease:abc123", "scope": "kafel.donations:write" },
  "execution_started_at": "2026-06-01T10:42:01.000Z",
  "execution_finished_at": "2026-06-01T10:42:01.140Z",
  "executed_at": "2026-06-01T10:42:01.140Z",
  "affected_rows": 0,
  "post_state": null,
  "post_state_matches": null,
  "drift": {
    "expected_after_image": { "id": 90211, "amount": "100000.00", "status": "approved" },
    "observed_current_image": { "id": 90211, "amount": "250000.00", "status": "approved" },
    "differing_paths": [ ["amount"] ]
  },
  "failure": null,
  "receipt": {
    "event_hash": "sha256:1122334455667788990011223344556677889900112233445566778899001122",
    "prev_row_hash": "sha256:aa00bb11cc22dd33ee44ff5566778899aabbccddeeff00112233445566778899",
    "row_hash": "sha256:bb11cc22dd33ee44ff5566778899aabbccddeeff001122334455667788990011",
    "ces_signature": "MEQCIF…base64…", "ces_signing_key_id": "ces-sign-key-2026",
    "worm_object_key": "evidence/results/2026/06/01/seg-000142/b2c3d4e5.json",
    "anchor_ref": null
  }
}
```

### E.3 Successful reversal execution result
```json
{
  "schema_version": "execution-result-1.0",
  "result_id": "c3d4e5f6-a7b8-5c9d-0e1f-2a3b4c5d6e7f",
  "directive_id": "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d",
  "reversal_cce_envelope_id": "5f6a7b8c-9d0e-5f1a-2b3c-4d5e6f708190",
  "result_status": "SUCCESS",
  "executor": { "ces_instance_id": "ces-prod-1", "service_identity": "spiffe://edam/ces/prod-1" },
  "credential": { "issued_at": "2026-06-01T10:42:00.000Z", "ttl_seconds": 120,
                  "vault_lease_id": "vault:lease:abc124", "scope": "kafel.donations:write" },
  "execution_started_at": "2026-06-01T10:42:02.000Z",
  "execution_finished_at": "2026-06-01T10:42:02.090Z",
  "executed_at": "2026-06-01T10:42:02.090Z",
  "affected_rows": 1,
  "post_state": { "id": 90211, "amount": "100.00", "status": "approved", "approved_at": "2026-05-30T09:00:00.000Z" },
  "post_state_matches": true,
  "drift": null,
  "failure": null,
  "receipt": {
    "event_hash": "sha256:99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa",
    "prev_row_hash": "sha256:bb11cc22dd33ee44ff5566778899aabbccddeeff001122334455667788990011",
    "row_hash": "sha256:cc22dd33ee44ff5566778899aabbccddeeff00112233445566778899aabbccdd",
    "ces_signature": "MEUCIG…base64…", "ces_signing_key_id": "ces-sign-key-2026",
    "worm_object_key": "evidence/results/2026/06/01/seg-000142/c3d4e5f6.json",
    "anchor_ref": { "head_hash": "sha256:dd33ee44ff5566778899aabbccddeeff00112233445566778899aabbccddee44",
                    "hsm_signature": "MEYCIQ…", "tsa_token": "MIIFx…", "anchor_provider": "rfc3161" }
  }
}
```

### E.4 Native audit event for a direct DBA update (attributable)
Correlates to the wallet-balance CCE (CCE C.2), raising attribution to `probable`/`exact`.
```json
{
  "schema_version": "db-audit-event-1.0",
  "audit_event_id": "d4e5f6a7-b8c9-5d0e-1f2a-3b4c5d6e7f80",
  "audit_source": { "id": "mariadb-audit-prod", "type": "mariadb_audit_plugin", "host": "db-prod-01" },
  "db_user": "dba_root",
  "client_host": "10.0.7.99",
  "connection_id": "990001",
  "thread_id": "990001",
  "statement_class": "DML",
  "statement_digest": "UPDATE kafel.wallets SET balance = ? WHERE id = ?",
  "objects": [ { "schema": "kafel", "name": "wallets" } ],
  "contains_sensitive": false,
  "raw_statement_ref": "worm:evidence/audit/2026/06/01/raw/990001-22140300",
  "event_ts": "2026-06-01T22:14:03.000Z",
  "ingest_ts": "2026-06-01T22:14:03.250Z",
  "plugin_state": { "loaded": true, "logging_active": true, "last_heartbeat_ts": "2026-06-01T22:14:00.000Z", "policy_hash": "sha256:policyA" },
  "tamper_indicators": [],
  "attribution_confidence": "probable",
  "evidence": {
    "event_hash": "sha256:0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
    "prev_row_hash": "sha256:f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f",
    "row_hash": "sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    "worm_object_key": "evidence/audit/2026/06/01/seg-000143/d4e5f6a7.json"
  }
}
```

### E.5 Native audit event where attribution is unavailable
Audit plugin was disabled during the window → tamper indicator → `unattributed`.
```json
{
  "schema_version": "db-audit-event-1.0",
  "audit_event_id": "e5f6a7b8-c9d0-5e1f-2a3b-4c5d6e7f8091",
  "audit_source": { "id": "mariadb-audit-prod", "type": "mariadb_audit_plugin", "host": "db-prod-01" },
  "db_user": null,
  "client_host": null,
  "connection_id": null,
  "thread_id": null,
  "statement_class": "DML",
  "statement_digest": null,
  "objects": [ { "schema": "kafel", "name": "donations" } ],
  "contains_sensitive": false,
  "raw_statement_ref": null,
  "event_ts": "2026-06-01T03:41:00.000Z",
  "ingest_ts": "2026-06-01T03:55:12.000Z",
  "plugin_state": { "loaded": false, "logging_active": false, "last_heartbeat_ts": "2026-06-01T03:39:00.000Z", "policy_hash": "sha256:policyA" },
  "tamper_indicators": [ "AUDIT_PLUGIN_DISABLED", "AUDIT_LOG_GAP" ],
  "attribution_confidence": "unattributed",
  "evidence": {
    "event_hash": "sha256:2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80910",
    "prev_row_hash": "sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    "row_hash": "sha256:3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091011",
    "worm_object_key": "evidence/audit/2026/06/01/seg-000130/e5f6a7b8.json"
  }
}
```

---

# PART F — Conformance Tests

## F.1 ReversalDirective (RD-*)
- **RD-1** Valid SIGNED four-eyes directive passes schema + V-A1..V-A15.
- **RD-2** `requested_by` also present in `approvals[]` ⇒ fails V-A10 (`REQUESTER_CANNOT_APPROVE`).
- **RD-3** `requires_four_eyes==true` with only one approval ⇒ fails V-A12; signing refused.
- **RD-4** SIGNED directive with `now >= expires_at` ⇒ CES rejects, ExecutionResult `VALIDATION_FAILED/DIRECTIVE_EXPIRED`.
- **RD-5** Re-submission of a previously consumed `nonce` ⇒ `VALIDATION_FAILED/REPLAY_DETECTED`.
- **RD-6** `REINSERT_DELETED` with non-null `captured_after_image` ⇒ fails V-A5 conditional.
- **RD-7** Tampered byte after signing ⇒ `canonical_hash`/signature mismatch ⇒ CES `BAD_SIGNATURE`.
- **RD-8** Target table not on CES whitelist ⇒ rejected (`TARGET_NOT_WHITELISTED`).
- **RD-9** DDL/TRUNCATE reversal ⇒ fails V-A14 (`UNSUPPORTED_OPERATION`).
- **RD-10** `directive_id` not reproducible from `(edam_instance_id, related_cce_envelope_id, nonce)` ⇒ fails V-A2.

## F.2 ExecutionResult (ER-*)
- **ER-1** SUCCESS with `affected_rows==1`, `post_state_matches==true`, `reversal_cce_envelope_id` set ⇒ passes V-B5..V-B6.
- **ER-2** SUCCESS claiming `affected_rows!=1` ⇒ fails conditional.
- **ER-3** DRIFT_CONFLICT with `affected_rows==0` and populated `drift.differing_paths` ⇒ passes; any claimed write ⇒ fails.
- **ER-4** No-partial-write: a directive whose after-image matches zero rows MUST yield DRIFT_CONFLICT, never a partial update (cross-checked against the absence of a reversal CCE).
- **ER-5** VERIFICATION_FAILED ⇒ `post_state_matches==false` + `failure.code==POSTSTATE_MISMATCH`; raises CRITICAL alarm; no auto-retry.
- **ER-6** `credential.ttl_seconds` > policy max ⇒ fails V-B10.
- **ER-7** `credential.issued_at` earlier than directive `signed_at` ⇒ fails V-B10 (cred predates authorization).
- **ER-8** Forged `ces_signature` ⇒ fails V-B11 on EDAM ingest.
- **ER-9** SUCCESS result whose linked reversal CCE diverges from `post_state` ⇒ CRITICAL integrity alarm (dual-record mismatch, §B.8).
- **ER-10** `row_hash != SHA256(prev_row_hash ‖ event_hash)` ⇒ fails V-B12.

## F.3 DB-Audit Event (AE-*)
- **AE-1** Valid MariaDB-plugin DML event with `connection_id` ⇒ `probable`/`exact` allowed; passes schema.
- **AE-2** `attribution_confidence != unattributed` without `connection_id` ⇒ fails conditional.
- **AE-3** `cloud_audit` without `provider` ⇒ fails conditional.
- **AE-4** `plugin_state.loaded==false` or `AUDIT_PLUGIN_DISABLED` present ⇒ confidence MUST be `unattributed`; raises fidelity/tamper alarm.
- **AE-5** Raw SQL never appears inline in the projection; only `statement_digest` + `raw_statement_ref` (raw lives in WORM).
- **AE-6** Sensitive literals masked; `contains_sensitive==true` when masking applied.
- **AE-7** Correlation: an event with matching `connection_id` + time window to a CCE produces an `exact`/`probable` link written to the CCE `actor.audit_event_ref`; ambiguous multi-candidate ⇒ `unattributed`.
- **AE-8** `CLOCK_SKEW` indicator present ⇒ correlation window widened and confidence capped.

## F.4 Cross-contract (XC-*)
- **XC-1** Determinism: serializing/hashing any of the three contracts twice, on two machines/languages, yields identical `event_hash` (shared algorithm with CCE v1 §12.7).
- **XC-2** Closed loop: directive → SUCCESS result → reversal CCE all resolvable by id, and the reversal CCE's `actor` reflects the CES dynamic-credential identity.
- **XC-3** WORM/anchoring: directives, results, and audit events are each independently verifiable by an outsider with only WORM read + public keys (no EDAM/CES secrets).
- **XC-4** Append-only: no contract instance is ever mutated after seal; a "correction" is a new instance with a new id.

---

# PART G — Security Constraints (binding)

| # | Constraint | Contract enforcement |
|---|---|---|
| **G-1** | **No standing write credentials in EDAM.** EDAM holds zero monitored-DB write creds; it only signs directives. | INV-1; CES is the sole writer; directive carries no credential. |
| **G-2** | **Short-lived dynamic credentials only, in CES.** CES fetches a Vault lease (TTL minutes, scoped to the whitelisted table) *after* validating a signed directive. | `ExecutionResult.credential.{ttl_seconds,issued_at,scope,vault_lease_id}`; V-B10; ER-6/ER-7. |
| **G-3** | **WebAuthn for critical approvals.** Four-eyes/financial approvals require phishing-resistant assertions. | `approvals[].webauthn_assertion_ref`; V-A11/V-A12; A.5. |
| **G-4** | **HSM signing.** Directives signed by a non-exportable EDAM key; results signed by a separate CES key; both verifiable with public keys only. | `signature.hsm_signature`+`signing_key_id`; `receipt.ces_signature`; V-A13/V-B11; XC-3. |
| **G-5** | **Replay protection.** Single-use nonce + consumed-nonce ledger. | `nonce`; A.7; RD-5. |
| **G-6** | **Directive expiry.** Hard short `expires_at`; CES rejects after it. | `expires_at`; V-A9; RD-4. |
| **G-7** | **Separation of duties.** Requester ≠ approver; approver ≠ executor; EDAM (Domain B) ≠ CES operators (Domain D). | V-A10; distinct signing keys; distinct trust domains (EDAM v2 §1). |
| **G-8** | **Full after-image optimistic concurrency; no partial reversal.** Execute only if current row equals captured after-image across all columns; else DRIFT_CONFLICT, write nothing. | A.11; INV-5; ER-3/ER-4. |
| **G-9** | **All results append-only.** ExecutionResults and DB-Audit Events are immutable once sealed; corrections are new instances. | INV-3; XC-4. |
| **G-10** | **All evidence WORM-compatible.** Directives, results, and audit events use CCE-compatible hashing, hash chaining, WORM keys, and external anchoring. | `*.evidence`/`receipt`; EDAM v2 §2; XC-3. |
| **G-11** | **mTLS between EDAM and CES.** Directive dispatch and result return over mutually-authenticated TLS. | `executor.service_identity` (SPIFFE); transport requirement. |
| **G-12** | **No fabrication of attribution or results.** Unknown ⇒ `unattributed`; unverifiable ⇒ failure status. | INV-2; AE-4; B.2. |

---

# PART H — Snapshot Epoch Manifest v1 (ratified via CCE-AMD-001 Rev 4)

## H.1 Purpose
The **Snapshot Epoch Manifest** is the companion record that bounds and self-describes one MySQL/MariaDB snapshot epoch (CCE-AMD-001 Rev 4 §3/§9). It is emitted **once per epoch at handoff** (snapshot→stream) and records the epoch's watermark, the capture-sourced snapshot-start timestamp, per-table coverage, and the prior epoch it supersedes.

It is a **companion record, NOT a CCE.** Its `kind` is `snapshot_epoch_manifest` (the CCE `kind` is fixed `transaction`), and it is versioned in the companion namespace (`edam-companion-1.0`), so the CCE major-version gate and the CCE change-event schema never apply to it. It chains into the **same WORM hash chain** as CCEs (`manifest_hash` + `row_hash`), making the epoch boundary tamper-evident and ordered relative to the change events. Schema id: `snapshot-epoch-manifest-1.0`.

## H.2 Supersession semantics (read-model)
WORM is append-only (INV-3): epochs are never deleted or rewritten. "Current vs superseded" is a **read-model** concept derived from the immutable manifests:
- **Epoch 1 / Epoch 2:** distinct `epoch_id`, ordered by `snapshot_start_watermark` then `handoff_gtid`.
- **Current baseline:** the epoch with the greatest watermark whose `handoff_gtid` connects to the live stream (the projection maintains a `current_epoch` pointer).
- **Historical:** any non-current epoch. **Superseded:** a historical epoch named by a later manifest's `supersedes` (or any epoch with a strictly smaller watermark than `current_epoch`).

## H.3 JSON Schema (`snapshot-epoch-manifest-1.0`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/snapshot-epoch-manifest-1.0.schema.json",
  "title": "Snapshot Epoch Manifest v1 (EDAM companion record)",
  "type": "object",
  "required": ["kind","schema_version","epoch_id","db_id","server_uuid","snapshot_start_watermark","snapshot_start_ts","tables","supersedes","evidence"],
  "additionalProperties": false,
  "properties": {
    "kind": { "const": "snapshot_epoch_manifest" },
    "schema_version": { "const": "edam-companion-1.0" },
    "epoch_id": { "type": "string", "pattern": "^snap-[0-9a-f]{16}$" },
    "db_id": { "type": "string", "minLength": 1 },
    "server_uuid": { "type": "string", "minLength": 1 },
    "snapshot_start_watermark": {
      "type": "object",
      "required": ["binlog_file","binlog_pos"],
      "additionalProperties": false,
      "properties": {
        "binlog_file": { "type": "string", "minLength": 1 },
        "binlog_pos": { "type": "integer", "minimum": 0 }
      }
    },
    "snapshot_start_ts": { "type": "string", "format": "date-time" },
    "handoff_gtid": { "type": ["string","null"] },
    "tables": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["table","expected_rows","emitted_rows","status"],
        "additionalProperties": false,
        "properties": {
          "table": { "type": "string", "minLength": 1 },
          "expected_rows": { "type": ["integer","null"], "minimum": 0 },
          "expected_is_estimate": { "type": "boolean" },
          "emitted_rows": { "type": "integer", "minimum": 0 },
          "status": { "type": "string", "enum": ["in_progress","complete","interrupted","incomplete"] }
        }
      }
    },
    "supersedes": { "type": ["string","null"], "pattern": "^snap-[0-9a-f]{16}$" },
    "evidence": {
      "type": "object",
      "required": ["manifest_hash","row_hash"],
      "additionalProperties": false,
      "properties": {
        "manifest_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "prev_row_hash": { "type": ["string","null"], "pattern": "^sha256:[0-9a-f]{64}$" },
        "row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    }
  }
}
```

`manifest_hash` is computed over the canonical manifest core (record minus `evidence`), mirroring the CCE `event_hash` discipline (INV-4); `row_hash = H(prev_row_hash ‖ manifest_hash)` chains it into the WORM evidence chain (INV-3).

---

*End of EDAM companion contracts. Contract design only — no implementation code. All prior documents remain unmodified; PART H was ratified via CCE-AMD-001 Rev 4. All contracts are compatible with Canonical Change Event v1.*
