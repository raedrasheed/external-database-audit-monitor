# EDAM Risk Rule Definition Specification — v1
### The declarative detection language for the Risk Engine, Suspicious Activity Center, Alerting, ReversalDirective risk_context, and dashboard severity

> **Document class:** Frozen foundational contract. Changes follow the versioning/deprecation discipline of CCE v1 (§9 of `docs/CCE-v1-Specification.md`) and the Breaking-Changes rules in §24 here.
> **Authoritative inputs:** `docs/External-Database-Audit-Monitor-Plan.md` (v1), `docs/EDAM-Architecture-Review.md`, `docs/EDAM-v2-Architecture.md`, `docs/CCE-v1-Specification.md`, `docs/EDAM-Companion-Contracts.md`, `docs/EDAM-WORM-Evidence-Anchoring-Spec.md`.
> **Status:** Contract/spec design only — no implementation code.
> **Schema ids:** `risk-rule-1.0`, `rule-evaluation-result-1.0`, `alert-1.0`.
> **Spec date:** 2026-06-01.

---

## 0. Purpose & scope

This specification defines the **declarative rule language** that EDAM evaluates against **Canonical Change Events (CCEs)** (and correlated DB-Audit Events) to detect suspicious database activity. It is the single contract behind:

- **Risk Engine** — evaluates rules over CCEs, produces scores and triggered-rule lists (written into `audit_events.risk_score` / `triggered_rules`, CCE v1 §6).
- **Suspicious Activity Center** — renders triggered rules, score breakdowns, and recommended actions (v1 plan §7C).
- **Alerting Engine** — turns rule outcomes into deduplicated, routed alerts.
- **ReversalDirective `risk_context`** — the `{risk_score, triggered_rules[], reason_text}` block of a directive (Companion Contracts §A.12).
- **Dashboard severity calculations** — severity colors and high-risk-user/table rollups.

### 0.1 Design principles (binding)
1. **Declarative, not code.** A rule is data (JSON), not a script. No rule may embed executable code, shell, SQL, or arbitrary expressions — this prevents the rule store from becoming a remote-code-execution surface (review concern M3 — "build-a-language trap"). The grammar here is a *bounded* condition language, deliberately not Turing-complete.
2. **CCE-native.** Conditions address CCE fields by **JSON path arrays** (the same `path` model as CCE `field_changes`, §6.8), so rules are engine-agnostic and work identically for relational and document changes.
3. **Deterministic & explainable.** Given the same CCE(s) and rule version, evaluation MUST produce the same result, and the result MUST record *why* it fired (which conditions matched, with values). No black-box scoring.
4. **Detection only — never action.** A rule outcome can raise an alert and *propose* a reversal; it can **never** execute a reversal or write to any database. This preserves invariant INV-1 (EDAM never writes to the monitored DB).
5. **Honest about fidelity.** A rule MUST be able to condition on `fidelity`/`completeness`; detection over `DEGRADED` data is flagged, not silently trusted (review C3/C4).
6. **Evidence-grade.** Rule definitions, their versions, and evaluation results are append-only and WORM-compatible (they can be sealed as evidence alongside the CCEs they scored).

### 0.2 Relationship to MVP
The MVP uses a **small set of hard-coded, unit-tested rules** (EDAM v2 §7). This spec defines the *target* declarative format those rules conform to, so the MVP rules are authored as data from day one and the configurable engine arrives without re-authoring. The MVP need not ship the full evaluation engine — only the subset its rules use.

---

## 1. Rule Model

A **Risk Rule** is a declarative object: identity + scope + a **condition tree** + severity/scoring + output metadata.

```
RiskRule
├── identity        { rule_id, code, rule_version, name, description }
├── status          ENABLED | DISABLED | DRAFT | DEPRECATED
├── category         (§4)
├── scope           { engines[], db_ids[], schemas[], tables[], applies_to_operations[] }
├── evaluation_mode  PER_EVENT | WINDOW | CROSS_TABLE | COMPOUND   (§7,§11,§17)
├── condition        <ConditionNode>            (boolean tree of leaf conditions)
├── severity         LOW | MEDIUM | HIGH | CRITICAL                (§5)
├── score            integer 0..100 + scoring metadata             (§6)
├── window           { ... }  (required iff evaluation_mode involves windows) (§7)
├── recommended_action  text + optional proposed reversal hint
├── suppression      { dedupe_key, cooldown }                      (§19)
└── provenance       { created_by, created_at, signed_hash }
```

A rule's `condition` is a **boolean tree** of `AND`/`OR`/`NOT` nodes whose leaves are typed **condition predicates** (§9–§16). The leaf set is closed (enumerated); authors cannot invent new predicate types without a spec change.

### 1.1 Condition node grammar (bounded)
```
ConditionNode :=
    { "all": [ ConditionNode, ... ] }      // AND
  | { "any": [ ConditionNode, ... ] }      // OR
  | { "not": ConditionNode }               // NOT
  | LeafCondition                          // one typed predicate (§9–§16)
```
- Maximum nesting depth and maximum leaf count are bounded (Implementation Constraints §23) to guarantee bounded evaluation cost.
- Leaves reference CCE data via `path` arrays and a closed set of **operators** (§8.2).

---

## 2. Rule Lifecycle

```
 DRAFT ──► ENABLED ──► DISABLED ──► (ENABLED again)            DEPRECATED ──► (removed in a later spec/minor)
   │           │           │
 authored   active in   temporarily
 + tested   evaluation  paused
```

| State | Meaning | Evaluated? | Transitions | Controls |
|---|---|---|---|---|
| `DRAFT` | Authored, under test (may run in **shadow mode** — evaluated, results recorded, no alerts). | Shadow only | → ENABLED, → (delete while DRAFT) | Author role; requires passing the rule's own test fixtures (§22). |
| `ENABLED` | Live; contributes to scores/alerts/severity. | Yes | → DISABLED, → DEPRECATED | Enabling a rule is an **admin-audited** change (append-only). |
| `DISABLED` | Paused; retained for history. | No | → ENABLED, → DEPRECATED | Audited. |
| `DEPRECATED` | Superseded; retained for reproducibility of past evaluations. | No (new), but historical results remain valid under its `rule_version`. | (removed only per deprecation policy) | Audited. |

**Rules:**
- Every state change is recorded append-only (admin_audit_log, v1 plan §6) and is WORM-compatible.
- A rule is **never edited in place**. A change produces a **new `rule_version`** (immutability mirrors CCE/evidence discipline). Past evaluation results forever reference the exact `rule_version` that produced them, so historical detections are reproducible.
- Enabling/disabling rules that affect financial detection SHOULD require dual-control in high-value deployments (consistent with EDAM v2 SoD).

---

## 3. Rule Versioning

- `rule_version` is a monotonically increasing integer per `code` (the stable rule identifier). `rule_id` is the unique id of a specific version: deterministic UUIDv5 over `(code ‖ rule_version)`.
- A rule's `signed_hash` = SHA-256 over the canonical serialization of the rule (CCE v1 §12.7 rules), so the exact ruleset version that scored an event is provable and can be sealed into evidence.
- **Evaluation results embed `rule_id` + `rule_version` + `signed_hash`** so an auditor can reproduce *why an event was flagged* against the exact rule text in force at that time (forensic reproducibility).
- The **spec** itself is versioned (`risk-rule-1.0`); changing the grammar/operators/result shape follows §24. A rule's `rule_version` (content) is independent of the spec version (grammar).

---

## 4. Rule Categories

`category` is a closed enum; it drives grouping in the Suspicious Activity Center and default routing.

| Category | Meaning | Example default rules (v1 plan §10) |
|---|---|---|
| `FINANCIAL_FRAUD` | Tampering with monetary/ledger data. | donation amount changed after approval; wallet balance manually updated |
| `DATA_INTEGRITY` | Destruction/inconsistency of records. | beneficiary deleted with active balance; campaign deleted with donations |
| `PRIVILEGE_ESCALATION` | Authz/role/permission changes. | role/permission changed; login/security table changed |
| `SCHEMA_TAMPER` | DDL / structural change. | database schema changed (ALTER/DROP/CREATE) |
| `MASS_OPERATION` | Bulk change anomalies. | mass update / bulk delete detected |
| `USER_BEHAVIOR` | Anomalous actor behavior/timing. | activity outside business hours; unusual host |
| `FIDELITY_INTEGRITY` | Audit-pipeline trust degradation. | row-image downgrade; GTID gap; audit plugin disabled |
| `DESTRUCTION` | Irreversible data loss ops. | DELETE/TRUNCATE on financial tables |

---

## 5. Rule Severity Model

`severity ∈ {LOW, MEDIUM, HIGH, CRITICAL}` — the *qualitative* classification, distinct from the numeric `score` (§6).

| Severity | Meaning | Dashboard color (v1 plan §15) | Default handling |
|---|---|---|---|
| `LOW` | Noteworthy, low concern. | blue/gray | logged; no notification by default |
| `MEDIUM` | Investigate when convenient. | amber | queued in Suspicious Activity Center |
| `HIGH` | Investigate promptly. | orange | alert + notification |
| `CRITICAL` | Immediate attention; likely fraud/destruction. | red | alert + escalated notification; eligible for four-eyes reversal proposal |

- Severity MAY be **fixed** by the rule, or **derived** from score bands (§6.3). If both are present, the higher of (fixed, score-derived) wins, and the result records which.
- Accessibility: severity MUST be conveyed by non-color cues too (icon/label), per v1 UX requirements.

---

## 6. Rule Scoring Model

### 6.1 Per-rule score
Each rule contributes an integer `score` in `0..100` when it fires. Scoring metadata:
```jsonc
"score": 95,
"scoring": {
  "base": 80,                       // base contribution when the rule fires
  "modifiers": [                    // optional, bounded, declarative adjustments
    { "when_path": ["fidelity","state"], "equals": "DEGRADED", "add": 10 },
    { "when_actor_confidence": "unattributed", "add": 5 }
  ],
  "max": 100
}
```
- Modifiers are a **closed, declarative** set (no expressions). Final per-rule score = `clamp(base + Σ applicable modifiers, 0, max)`.

### 6.2 Event aggregate score
When multiple rules fire on one CCE, the **event aggregate** is computed by a fixed, documented function (not author-defined code):
- Default: `event_score = min(100, max(rule_scores) + saturating_sum(other_rule_scores))` where `saturating_sum` adds remaining rule scores with diminishing returns (each additional rule contributes a fraction), bounded at 100. The exact function is fixed by this spec so results are reproducible. Triggered rules are listed individually regardless.

### 6.3 Actor/window rollup score
For windowed/behavioral rules, a per-actor sliding score drives the **high-risk users** view (v1 plan §7A): the actor score is the bounded aggregate of recent event scores attributed (CCE `actor`) to that principal within a rolling window, with time decay. Decay parameters are configuration, not code.

### 6.4 Score→severity bands (when severity is derived)
| Score band | Derived severity |
|---|---|
| 0–24 | LOW |
| 25–49 | MEDIUM |
| 50–79 | HIGH |
| 80–100 | CRITICAL |

---

## 7. Time Window Model

Windowed rules evaluate over a set of CCEs, not a single event.

```jsonc
"window": {
  "type": "sliding",                 // sliding | tumbling
  "duration_seconds": 300,
  "group_by": [ ["actor","db_user"], ["object","name"] ],   // CCE path arrays
  "time_basis": "ingest_ts"          // ingest_ts (trusted) | commit_ts (source, untrusted)
}
```

- **`time_basis` defaults to `ingest_ts`** (EDAM trusted monotonic clock). `commit_ts` MAY be used for business-hours semantics but is flagged untrusted (CCE v1 §4.3 discipline); a rule using `commit_ts` for security decisions SHOULD also assert `fidelity.state == HEALTHY`.
- `group_by` partitions events into evaluation buckets (e.g., per db_user, per table).
- Window state is bounded and reproducible: replaying the same CCE stream yields the same window outcomes (determinism).
- Late/out-of-order events: windows tolerate a bounded lateness; events arriving after a tumbling window closes are evaluated against the next window and noted.

---

## 8. Threshold Model

### 8.1 Threshold predicates
Used inside windowed rules to express "N events / amount / distinct values within the window".

```jsonc
{ "type": "threshold",
  "metric": "event_count",          // event_count | distinct_count | sum | rate
  "path": ["object","name"],        // required for distinct_count / sum
  "operator": ">=",
  "value": 50,
  "within_window": true }
```

| `metric` | Meaning |
|---|---|
| `event_count` | number of matching events in the window/bucket |
| `distinct_count` | number of distinct values at `path` |
| `sum` | numeric sum at `path` (exact-decimal, never float — CCE §12.8) |
| `rate` | events per second over the window |

### 8.2 Comparison operators (closed set)
`==`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `not_in`, `changed`, `changed_to`, `changed_from`, `matches` (anchored, bounded regex — see §23), `exists`, `is_null`.

- Numeric comparisons on money/decimals use exact decimal semantics; values are strings (CCE encoding). The engine compares as decimals, never as floats.

---

## 9. Field Change Conditions

Address a specific changed field via its `path` (relational column = single element; nested document path = multi-element — same as CCE `field_changes`).

```jsonc
{ "type": "field_change",
  "path": ["amount"],
  "operator": "changed",            // changed | changed_to | changed_from | ==,>,< ...
  "old_operator": ">",  "old_value": "0",          // optional: constrain old value
  "new_operator": ">=", "new_value": "10000",       // optional: constrain new value
  "sensitive_ok": true }            // evaluate even on masked fields (compares allowed metadata)
```

- `changed_to`/`changed_from` compare the field's `new`/`old` to a literal.
- For **sensitive/masked** fields, value-equality on the masked placeholder is meaningless; rules SHOULD condition on `changed` (boolean) or on non-sensitive companion fields. The engine MUST NOT require revealing a masked value to evaluate a rule.
- Example: donation amount changed after approval → `field_change(amount, changed)` AND `field_value(status == "approved")`.

---

## 10. Transaction Conditions

Operate on the CCE transaction envelope / change items.

```jsonc
{ "type": "transaction",
  "predicate": "statement_count", "operator": ">=", "value": 100 }       // mass change in one txn
```
Supported `predicate`s: `statement_count`, `contains_operation` (e.g., any change item is `DELETE`), `all_operations_are` (e.g., all `DELETE`), `touches_table` (any change item targets a table), `distinct_tables_count`.

- Enables "single transaction deleted N financial rows" and "transaction mixes schema change with data change" detections.

---

## 11. Cross-Table Conditions

Relate the changed object to the state/existence of related data (the "deleted with active balance / with donations" rules). Because EDAM observes changes, not full DB state, cross-table conditions are evaluated against **captured CCE state** and, where necessary, a **bounded, read-only reference lookup** against the projection (never the monitored DB write path).

```jsonc
{ "type": "cross_table",
  "subject": { "table": "beneficiaries", "operation": "DELETE" },
  "related": {
    "lookup": "has_related_rows",         // has_related_rows | related_field_compare
    "table": "wallets",
    "join": [ { "subject_path": ["primary_key","id"], "related_path": ["beneficiary_id"] } ],
    "having": { "path": ["balance"], "operator": ">", "value": "0" }
  } }
```

- `has_related_rows` / `related_field_compare` are the only closed lookup types in v1.
- Lookups are **read-only** against the EDAM PostgreSQL projection (or a derived materialized view), never against the monitored database, and are bounded (timeout, row cap). A lookup that cannot complete deterministically marks the rule result `INDETERMINATE` (§18) rather than guessing.
- Example: beneficiary deleted with active balance → `cross_table(DELETE beneficiaries, has_related_rows wallets where balance>0)`.

---

## 12. User Behavior Conditions

Condition on the correlated actor (CCE `actor`, DB-Audit Event correlation).

```jsonc
{ "type": "user_behavior",
  "predicate": "outside_business_hours",   // outside_business_hours | unusual_host |
                                           // new_actor | actor_in_list | confidence_below
  "business_hours": { "tz": "Asia/Riyadh", "days": ["SUN","MON","TUE","WED","THU"],
                      "from": "08:00", "to": "18:00" },
  "time_basis": "ingest_ts" }
```
Supported predicates: `outside_business_hours`, `unusual_host` (client_host not in known set / new for actor), `new_actor` (first seen within lookback), `actor_in_list` / `actor_not_in_list`, `confidence_below` (e.g., attribution_confidence == unattributed for a sensitive change), `privilege_role_in` (actor's DB role).

- Behavioral baselines (known hosts, typical hours) are **configuration/state**, not embedded code. Advanced UEBA/ML is explicitly **out of v1** (review §5 deferral) — these are deterministic, explainable predicates.

---

## 13. Privilege Escalation Conditions

Specialized conditions for authz changes.

```jsonc
{ "type": "privilege_change",
  "predicate": "role_assignment_changed",   // role_assignment_changed | permission_granted |
                                            // privilege_table_modified | self_privilege_change
  "tables": ["user_roles","roles","permissions"],
  "direction": "elevation" }                // elevation | any
```
- `self_privilege_change` flags when the correlated actor modifies their own roles/permissions (high-signal insider indicator).
- `elevation` detects grants toward higher privilege (requires a configured role-rank map — configuration, not code).

---

## 14. Financial Fraud Conditions

Composable building blocks for monetary integrity (the highest-value category for the assumed domain).

```jsonc
{ "type": "financial",
  "predicate": "amount_changed_after_state",   // amount_changed_after_state |
                                               // balance_direct_edit | amount_delta_exceeds |
                                               // negative_to_positive | rounding_anomaly
  "amount_path": ["amount"],
  "state_path": ["status"], "locked_states": ["approved","settled","paid"],
  "delta_operator": ">", "delta_value": "0" }
```

| `predicate` | Detects |
|---|---|
| `amount_changed_after_state` | amount/value changed while record is in a locked state (e.g., approved donation) |
| `balance_direct_edit` | a balance/ledger field changed by a direct UPDATE not matching an expected transaction pattern |
| `amount_delta_exceeds` | change magnitude beyond a threshold |
| `negative_to_positive` / sign flips | suspicious sign changes |
| `rounding_anomaly` | values changed to suspicious round figures or sub-cent manipulation |

- All amounts compared as **exact decimals** (strings), never floats.

---

## 15. Data Integrity Conditions

Detect destruction/inconsistency.

```jsonc
{ "type": "data_integrity",
  "predicate": "delete_on_financial_table",   // delete_on_financial_table | truncate_detected |
                                              // orphan_creation | required_field_nulled |
                                              // hard_delete_vs_soft_delete
  "tables": ["donations","wallets","ledger_entries"] }
```
- `truncate_detected` is always treated as high-severity because TRUNCATE yields no per-row before-image (CCE §5; WORM fidelity note) — irreversible by the directive model (Companion Contracts §A.10), so it demands manual change-control.
- `hard_delete_vs_soft_delete` flags physical deletes on tables that policy expects to be soft-deleted.

---

## 16. Completeness / Fidelity Conditions

First-class conditions on the audit pipeline's own trustworthiness (CCE `fidelity`/`completeness`; WORM/attestation specs). These let the ruleset *raise alarms about EDAM's own blind spots* — directly serving review blockers C3/C4/H1.

```jsonc
{ "type": "fidelity",
  "predicate": "state_not_healthy" }          // state_not_healthy | gap_detected |
                                              // row_image_downgraded | audit_plugin_disabled |
                                              // attribution_unavailable_on_sensitive
```

| `predicate` | Fires when |
|---|---|
| `state_not_healthy` | CCE `fidelity.state ∈ {DEGRADED, COMPROMISED}` |
| `gap_detected` | CCE `completeness.gap_detected == true` |
| `row_image_downgraded` | `source_config.binlog_row_image != FULL` (or PG `replica_identity != FULL`) |
| `audit_plugin_disabled` | correlated DB-Audit Event has `AUDIT_PLUGIN_DISABLED` / `plugin_state.loaded == false` |
| `attribution_unavailable_on_sensitive` | sensitive/financial change with `attribution_confidence == unattributed` |

- These rules are typically `HIGH`/`CRITICAL` and `FIDELITY_INTEGRITY` category — a degraded pipeline during a change to financial data is itself a strong suspicion signal.

---

## 17. Compound Rules

A rule with `evaluation_mode: COMPOUND` combines multiple sub-conditions across event/window/cross-table scopes into one decision, with explicit semantics.

```jsonc
{ "evaluation_mode": "COMPOUND",
  "condition": {
    "all": [
      { "type": "financial", "predicate": "amount_changed_after_state", "...": "..." },
      { "type": "user_behavior", "predicate": "outside_business_hours", "...": "..." },
      { "any": [
          { "type": "user_behavior", "predicate": "confidence_below", "value": "exact" },
          { "type": "fidelity", "predicate": "state_not_healthy" }
      ] }
    ] }
}
```
- Compound rules may reference window/threshold leaves; the rule's `window` applies to those leaves.
- Compound semantics are pure boolean over leaf truth values; no procedural ordering or side effects. Short-circuit is allowed only as an optimization and MUST NOT change the recorded matched-leaf set (for explainability, all contributing leaves are recorded).

---

## 18. Rule Evaluation Results

Every evaluation of a rule against an event (or window bucket) yields a **RuleEvaluationResult** — append-only, WORM-compatible, and explainable.

| Field | Type | Req | Description |
|---|---|---|---|
| `result_version` | string | R | `"rule-evaluation-result-1.0"`. |
| `result_id` | string(uuid) | R | Deterministic UUIDv5 over `(rule_id ‖ subject_ref ‖ window_key?)`. |
| `rule_id` / `code` / `rule_version` / `rule_signed_hash` | — | R | Exact rule version that produced this result (reproducibility, §3). |
| `subject` | object | R | What was evaluated: `{type: cce|window, envelope_ids[], group_by_values?, window_bounds?}`. |
| `outcome` | enum | R | `FIRED \| NOT_FIRED \| INDETERMINATE`. |
| `score` | integer | C | 0..100 when `FIRED`. |
| `severity` | enum | C | when `FIRED`. |
| `matched_conditions` | array | C | The leaf predicates that matched, each with `{path, operator, observed_value(masked), expected}` — the *why*. |
| `fidelity_context` | object | R | Snapshot of `fidelity.state`/`completeness.gap_detected` of the subject (so a detection over degraded data is self-documenting). |
| `evaluated_at` | timestamp | R | Trusted ingest/eval time. |
| `evidence` | object | C | `event_hash`/`row_hash`/`worm_object_key` when sealed as evidence. |

- `INDETERMINATE` is mandatory and first-class: e.g., a cross-table lookup that timed out, or a rule needing data unavailable due to `DEGRADED` fidelity. The engine **never fabricates** a FIRED/NOT_FIRED it cannot justify (INV-2 from companion contracts). `INDETERMINATE` on a sensitive subject SHOULD itself raise a low/medium operational alert.

---

## 19. Alert Generation

A `FIRED` result may generate an **Alert**. Alert generation is deduplicated and rate-limited via rule `suppression`.

```jsonc
"suppression": { "dedupe_key": ["rule.code", ["actor","db_user"], ["object","name"]],
                 "cooldown_seconds": 600 }
```

| Alert field | Description |
|---|---|
| `alert_version` | `"alert-1.0"`. |
| `alert_id` | UUID. |
| `rule_id`/`code`/`rule_version` | Source rule. |
| `severity` / `score` | From the result. |
| `status` | `open \| acknowledged \| resolved \| dismissed` (v1 plan §6 alerts). |
| `subject` | envelope_ids / window bounds / affected table+PK. |
| `triggered_rules` | full list when an event fired multiple rules (feeds CCE `triggered_rules` and directive `risk_context`). |
| `recommended_action` | from the rule; MAY include a *proposed reversal hint* (which CES-bound directive could be created) — **never** an executed action. |
| `dedupe_key` / `first_seen` / `last_seen` / `occurrence_count` | suppression bookkeeping. |
| `routing` | channels selected by severity/category (Notification System). |

**Rules:**
- Alerts are **append-only**; status changes are recorded as appended state transitions (admin-audited), never destructive edits.
- An alert's `recommended_action` referencing a reversal is a *suggestion only*; creating a ReversalDirective remains a human, four-eyes-gated act (Companion Contracts §A) — the rule engine cannot originate a directive autonomously.
- Notification content uses **masked** values (no sensitive data egress to external channels).

---

## 20. JSON Schema (Draft 2020-12)

> Reuses CCE v1 canonical serialization/hashing for `signed_hash`/evidence. Bounded-grammar limits (depth, leaf count, regex safety) are enforced by the conformance suite (§22) and Implementation Constraints (§23), not by JSON Schema alone.

### 20.1 RiskRule v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/risk-rule-1.0.schema.json",
  "title": "Risk Rule v1",
  "type": "object",
  "required": ["schema_version","rule_id","code","rule_version","name","status","category",
               "scope","evaluation_mode","condition","severity","score","provenance"],
  "additionalProperties": false,
  "$defs": {
    "path": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
    "operator": { "type": "string", "enum": ["==","!=",">",">=","<","<=","in","not_in",
                  "changed","changed_to","changed_from","matches","exists","is_null"] },
    "condition": {
      "oneOf": [
        { "type": "object", "required": ["all"], "additionalProperties": false,
          "properties": { "all": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/condition" } } } },
        { "type": "object", "required": ["any"], "additionalProperties": false,
          "properties": { "any": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/condition" } } } },
        { "type": "object", "required": ["not"], "additionalProperties": false,
          "properties": { "not": { "$ref": "#/$defs/condition" } } },
        { "$ref": "#/$defs/leaf" }
      ]
    },
    "leaf": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "type": "string", "enum": ["field_change","field_value","transaction","cross_table",
                   "user_behavior","privilege_change","financial","data_integrity","fidelity","threshold"] },
        "path": { "$ref": "#/$defs/path" },
        "operator": { "$ref": "#/$defs/operator" },
        "value": {},
        "predicate": { "type": "string" },
        "metric": { "type": "string", "enum": ["event_count","distinct_count","sum","rate"] }
      }
    }
  },
  "properties": {
    "schema_version": { "type": "string", "const": "risk-rule-1.0" },
    "rule_id": { "type": "string", "format": "uuid" },
    "code": { "type": "string", "pattern": "^[A-Z0-9_]+$" },
    "rule_version": { "type": "integer", "minimum": 1 },
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },
    "status": { "type": "string", "enum": ["DRAFT","ENABLED","DISABLED","DEPRECATED"] },
    "category": { "type": "string", "enum": ["FINANCIAL_FRAUD","DATA_INTEGRITY","PRIVILEGE_ESCALATION",
                   "SCHEMA_TAMPER","MASS_OPERATION","USER_BEHAVIOR","FIDELITY_INTEGRITY","DESTRUCTION"] },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "engines": { "type": "array", "items": { "type": "string", "enum": ["mysql","mariadb","postgres","sqlserver","oracle","mongodb"] } },
        "db_ids": { "type": "array", "items": { "type": "string" } },
        "schemas": { "type": "array", "items": { "type": "string" } },
        "tables": { "type": "array", "items": { "type": "string" } },
        "applies_to_operations": { "type": "array", "items": { "type": "string", "enum": ["INSERT","UPDATE","DELETE","DDL","TRUNCATE"] } }
      }
    },
    "evaluation_mode": { "type": "string", "enum": ["PER_EVENT","WINDOW","CROSS_TABLE","COMPOUND"] },
    "condition": { "$ref": "#/$defs/condition" },
    "severity": { "type": "string", "enum": ["LOW","MEDIUM","HIGH","CRITICAL"] },
    "score": { "type": "integer", "minimum": 0, "maximum": 100 },
    "scoring": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "base": { "type": "integer", "minimum": 0, "maximum": 100 },
        "max": { "type": "integer", "minimum": 0, "maximum": 100 },
        "modifiers": { "type": "array", "items": {
          "type": "object", "additionalProperties": true,
          "properties": { "add": { "type": "integer" } }, "required": ["add"] } }
      }
    },
    "window": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "enum": ["sliding","tumbling"] },
        "duration_seconds": { "type": "integer", "minimum": 1 },
        "group_by": { "type": "array", "items": { "$ref": "#/$defs/path" } },
        "time_basis": { "type": "string", "enum": ["ingest_ts","commit_ts"] }
      },
      "required": ["type","duration_seconds"]
    },
    "recommended_action": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "text": { "type": "string" },
        "propose_reversal": { "type": "boolean" }
      }
    },
    "suppression": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "dedupe_key": { "type": "array", "items": {} },
        "cooldown_seconds": { "type": "integer", "minimum": 0 }
      }
    },
    "provenance": {
      "type": "object",
      "required": ["created_by","created_at","signed_hash"],
      "additionalProperties": false,
      "properties": {
        "created_by": { "type": "string" },
        "created_at": { "type": "string", "format": "date-time" },
        "signed_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    }
  },
  "allOf": [
    { "if": { "properties": { "evaluation_mode": { "enum": ["WINDOW","COMPOUND"] } } },
      "then": { "required": ["window"] } }
  ]
}
```

### 20.2 RuleEvaluationResult v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/rule-evaluation-result-1.0.schema.json",
  "title": "Rule Evaluation Result v1",
  "type": "object",
  "required": ["result_version","result_id","rule_id","code","rule_version","rule_signed_hash",
               "subject","outcome","fidelity_context","evaluated_at"],
  "additionalProperties": false,
  "properties": {
    "result_version": { "type": "string", "const": "rule-evaluation-result-1.0" },
    "result_id": { "type": "string", "format": "uuid" },
    "rule_id": { "type": "string", "format": "uuid" },
    "code": { "type": "string" },
    "rule_version": { "type": "integer", "minimum": 1 },
    "rule_signed_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
    "subject": {
      "type": "object",
      "required": ["type","envelope_ids"],
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "enum": ["cce","window"] },
        "envelope_ids": { "type": "array", "items": { "type": "string", "format": "uuid" } },
        "group_by_values": { "type": "object" },
        "window_bounds": { "type": "object",
          "properties": { "from": { "type": "string", "format": "date-time" }, "to": { "type": "string", "format": "date-time" } } }
      }
    },
    "outcome": { "type": "string", "enum": ["FIRED","NOT_FIRED","INDETERMINATE"] },
    "score": { "type": "integer", "minimum": 0, "maximum": 100 },
    "severity": { "type": "string", "enum": ["LOW","MEDIUM","HIGH","CRITICAL"] },
    "matched_conditions": {
      "type": "array",
      "items": { "type": "object", "additionalProperties": true,
        "properties": { "path": { "type": "array", "items": { "type": "string" } },
                        "operator": { "type": "string" }, "observed": {}, "expected": {} } }
    },
    "fidelity_context": {
      "type": "object",
      "required": ["state","gap_detected"],
      "additionalProperties": false,
      "properties": {
        "state": { "type": "string", "enum": ["HEALTHY","DEGRADED","COMPROMISED"] },
        "gap_detected": { "type": "boolean" }
      }
    },
    "evaluated_at": { "type": "string", "format": "date-time" },
    "indeterminate_reason": { "type": "string" },
    "evidence": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "event_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "worm_object_key": { "type": "string" }
      }
    }
  },
  "allOf": [
    { "if": { "properties": { "outcome": { "const": "FIRED" } } },
      "then": { "required": ["score","severity","matched_conditions"] } },
    { "if": { "properties": { "outcome": { "const": "INDETERMINATE" } } },
      "then": { "required": ["indeterminate_reason"] } }
  ]
}
```

### 20.3 Alert v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/alert-1.0.schema.json",
  "title": "Alert v1",
  "type": "object",
  "required": ["alert_version","alert_id","rule_id","code","rule_version","severity","score",
               "status","subject","triggered_rules","first_seen","last_seen","occurrence_count"],
  "additionalProperties": false,
  "properties": {
    "alert_version": { "type": "string", "const": "alert-1.0" },
    "alert_id": { "type": "string", "format": "uuid" },
    "rule_id": { "type": "string", "format": "uuid" },
    "code": { "type": "string" },
    "rule_version": { "type": "integer", "minimum": 1 },
    "severity": { "type": "string", "enum": ["LOW","MEDIUM","HIGH","CRITICAL"] },
    "score": { "type": "integer", "minimum": 0, "maximum": 100 },
    "status": { "type": "string", "enum": ["open","acknowledged","resolved","dismissed"] },
    "subject": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "envelope_ids": { "type": "array", "items": { "type": "string", "format": "uuid" } },
        "db_id": { "type": "string" }, "schema": { "type": "string" },
        "table": { "type": "string" }, "primary_key": { "type": "object" },
        "actor": { "type": "object" }, "window_bounds": { "type": "object" }
      }
    },
    "triggered_rules": { "type": "array", "items": { "type": "object",
      "properties": { "code": { "type": "string" }, "rule_version": { "type": "integer" },
                      "score": { "type": "integer" }, "severity": { "type": "string" } } } },
    "recommended_action": { "type": "object",
      "properties": { "text": { "type": "string" }, "propose_reversal": { "type": "boolean" } } },
    "dedupe_key": { "type": "string" },
    "first_seen": { "type": "string", "format": "date-time" },
    "last_seen": { "type": "string", "format": "date-time" },
    "occurrence_count": { "type": "integer", "minimum": 1 },
    "routing": { "type": "array", "items": { "type": "string" } }
  }
}
```

---

## 21. Examples

### 21.1 R-FIN-001 — Donation amount changed after approval (CRITICAL, financial)
```json
{
  "schema_version": "risk-rule-1.0",
  "rule_id": "d1e2f3a4-b5c6-5d7e-8f90-1a2b3c4d5e6f",
  "code": "DONATION_AMOUNT_CHANGED_AFTER_APPROVAL",
  "rule_version": 1,
  "name": "Donation amount changed after approval",
  "description": "Amount altered on a donation already in an approved/locked state.",
  "status": "ENABLED",
  "category": "FINANCIAL_FRAUD",
  "scope": { "engines": ["mysql","mariadb"], "tables": ["donations"], "applies_to_operations": ["UPDATE"] },
  "evaluation_mode": "PER_EVENT",
  "condition": {
    "all": [
      { "type": "field_change", "path": ["amount"], "operator": "changed" },
      { "type": "field_value", "path": ["status"], "operator": "in", "value": ["approved","settled","paid"] }
    ]
  },
  "severity": "CRITICAL",
  "score": 95,
  "scoring": { "base": 90, "max": 100,
    "modifiers": [ { "when_path": ["fidelity","state"], "equals": "DEGRADED", "add": 5 },
                   { "when_actor_confidence": "unattributed", "add": 5 } ] },
  "recommended_action": { "text": "Propose reversal restoring the approved amount; require four-eyes.", "propose_reversal": true },
  "suppression": { "dedupe_key": ["rule.code", ["object","primary_key","id"]], "cooldown_seconds": 0 },
  "provenance": { "created_by": "secops.lead", "created_at": "2026-06-01T08:00:00.000Z",
                  "signed_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111" }
}
```

### 21.2 R-MASS-002 — Mass update detected (window + threshold, HIGH)
```json
{
  "schema_version": "risk-rule-1.0",
  "rule_id": "e2f3a4b5-c6d7-5e8f-9012-2b3c4d5e6f70",
  "code": "MASS_UPDATE_DETECTED",
  "rule_version": 1,
  "name": "Mass update by single actor",
  "status": "ENABLED",
  "category": "MASS_OPERATION",
  "scope": { "applies_to_operations": ["UPDATE","DELETE"] },
  "evaluation_mode": "WINDOW",
  "window": { "type": "sliding", "duration_seconds": 60,
              "group_by": [ ["actor","db_user"], ["object","name"] ], "time_basis": "ingest_ts" },
  "condition": {
    "all": [
      { "type": "threshold", "metric": "event_count", "operator": ">=", "value": 100, "within_window": true }
    ]
  },
  "severity": "HIGH",
  "score": 70,
  "scoring": { "base": 70, "max": 100,
    "modifiers": [ { "when_table_is_financial": true, "add": 20 } ] },
  "recommended_action": { "text": "Investigate bulk operation; verify change ticket.", "propose_reversal": false },
  "suppression": { "dedupe_key": ["rule.code", ["actor","db_user"], ["object","name"]], "cooldown_seconds": 300 },
  "provenance": { "created_by": "secops.lead", "created_at": "2026-06-01T08:05:00.000Z",
                  "signed_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222" }
}
```

### 21.3 R-INTEG-003 — Beneficiary deleted with active balance (cross-table, CRITICAL)
```json
{
  "schema_version": "risk-rule-1.0",
  "rule_id": "f3a4b5c6-d7e8-5f90-1234-3c4d5e6f7081",
  "code": "BENEFICIARY_DELETED_WITH_ACTIVE_BALANCE",
  "rule_version": 1,
  "name": "Beneficiary deleted while holding a positive balance",
  "status": "ENABLED",
  "category": "DATA_INTEGRITY",
  "scope": { "tables": ["beneficiaries"], "applies_to_operations": ["DELETE"] },
  "evaluation_mode": "CROSS_TABLE",
  "condition": {
    "all": [
      { "type": "data_integrity", "predicate": "delete_on_financial_table", "tables": ["beneficiaries"] },
      { "type": "cross_table",
        "subject": { "table": "beneficiaries", "operation": "DELETE" },
        "related": { "lookup": "has_related_rows", "table": "wallets",
                     "join": [ { "subject_path": ["primary_key","id"], "related_path": ["beneficiary_id"] } ],
                     "having": { "path": ["balance"], "operator": ">", "value": "0" } } }
    ]
  },
  "severity": "CRITICAL",
  "score": 92,
  "recommended_action": { "text": "Propose REINSERT_DELETED reversal; require four-eyes.", "propose_reversal": true },
  "provenance": { "created_by": "secops.lead", "created_at": "2026-06-01T08:10:00.000Z",
                  "signed_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333" }
}
```

### 21.4 R-FID-004 — Row-image downgrade on financial data (fidelity, CRITICAL)
```json
{
  "schema_version": "risk-rule-1.0",
  "rule_id": "a4b5c6d7-e8f9-5012-3456-4d5e6f708192",
  "code": "ROW_IMAGE_DOWNGRADE_FINANCIAL",
  "rule_version": 1,
  "name": "Capture fidelity degraded during financial change",
  "status": "ENABLED",
  "category": "FIDELITY_INTEGRITY",
  "scope": { "tables": ["donations","wallets","ledger_entries"] },
  "evaluation_mode": "PER_EVENT",
  "condition": {
    "any": [
      { "type": "fidelity", "predicate": "row_image_downgraded" },
      { "type": "fidelity", "predicate": "state_not_healthy" },
      { "type": "fidelity", "predicate": "gap_detected" }
    ]
  },
  "severity": "CRITICAL",
  "score": 88,
  "recommended_action": { "text": "Treat as potential evasion; verify source config & investigate concurrent changes.", "propose_reversal": false },
  "provenance": { "created_by": "secops.lead", "created_at": "2026-06-01T08:15:00.000Z",
                  "signed_hash": "sha256:4444444444444444444444444444444444444444444444444444444444444444" }
}
```

### 21.5 R-PRIV-005 — Self privilege change outside business hours (compound, CRITICAL)
```json
{
  "schema_version": "risk-rule-1.0",
  "rule_id": "b5c6d7e8-f901-5234-5678-5e6f70819203",
  "code": "SELF_PRIVILEGE_CHANGE_OFFHOURS",
  "rule_version": 1,
  "name": "Actor elevated own privileges outside business hours",
  "status": "ENABLED",
  "category": "PRIVILEGE_ESCALATION",
  "scope": { "tables": ["user_roles","roles","permissions"], "applies_to_operations": ["INSERT","UPDATE","DELETE"] },
  "evaluation_mode": "COMPOUND",
  "window": { "type": "sliding", "duration_seconds": 1, "time_basis": "ingest_ts" },
  "condition": {
    "all": [
      { "type": "privilege_change", "predicate": "self_privilege_change", "tables": ["user_roles","roles","permissions"], "direction": "elevation" },
      { "type": "user_behavior", "predicate": "outside_business_hours",
        "business_hours": { "tz": "Asia/Riyadh", "days": ["SUN","MON","TUE","WED","THU"], "from": "08:00", "to": "18:00" },
        "time_basis": "ingest_ts" }
    ]
  },
  "severity": "CRITICAL",
  "score": 90,
  "recommended_action": { "text": "Freeze account pending review; correlate with audit events.", "propose_reversal": false },
  "provenance": { "created_by": "secops.lead", "created_at": "2026-06-01T08:20:00.000Z",
                  "signed_hash": "sha256:5555555555555555555555555555555555555555555555555555555555555555" }
}
```

### 21.6 Example evaluation result (R-FIN-001 FIRED on CCE C.1)
```json
{
  "result_version": "rule-evaluation-result-1.0",
  "result_id": "c6d7e8f9-0123-5456-789a-6f7081920314",
  "rule_id": "d1e2f3a4-b5c6-5d7e-8f90-1a2b3c4d5e6f",
  "code": "DONATION_AMOUNT_CHANGED_AFTER_APPROVAL",
  "rule_version": 1,
  "rule_signed_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "subject": { "type": "cce", "envelope_ids": ["8b1f5c7a-2d44-5f0e-9a3b-1c2d3e4f5a6b"] },
  "outcome": "FIRED",
  "score": 95,
  "severity": "CRITICAL",
  "matched_conditions": [
    { "path": ["amount"], "operator": "changed", "observed": { "old": "100.00", "new": "100000.00" } },
    { "path": ["status"], "operator": "in", "observed": "approved", "expected": ["approved","settled","paid"] }
  ],
  "fidelity_context": { "state": "HEALTHY", "gap_detected": false },
  "evaluated_at": "2026-06-01T10:22:31.600Z",
  "evidence": { "event_hash": "sha256:7777777777777777777777777777777777777777777777777777777777777777",
                "row_hash": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
                "worm_object_key": "evidence/results/2026/06/01/seg-000142/c6d7e8f9.json" }
}
```

---

## 22. Conformance Tests

| # | Test | Expectation |
|---|---|---|
| **RR-1** | **Schema validity** | Each example (§21) validates against `risk-rule-1.0`; window-mode rules without `window` fail. |
| **RR-2** | **Deterministic rule hashing** | `signed_hash` recomputes identically on two machines (CCE §12.7 canonical form). |
| **RR-3** | **PER_EVENT firing** | R-FIN-001 FIRES on CCE C.1 (amount changed, status approved); NOT_FIRED if status not locked or amount unchanged. |
| **RR-4** | **Explainability** | A FIRED result MUST list `matched_conditions` with observed/expected; masked fields show masked placeholders, never revealed values. |
| **RR-5** | **Window/threshold** | R-MASS-002 FIRES when ≥100 matching events occur within 60s for one (db_user, table) bucket; NOT_FIRED at 99; deterministic across replay. |
| **RR-6** | **Cross-table INDETERMINATE** | R-INTEG-003 returns INDETERMINATE (not FIRED/NOT_FIRED) if the related lookup times out or projection data is unavailable; sets `indeterminate_reason`. |
| **RR-7** | **Cross-table FIRED** | R-INTEG-003 FIRES when a deleted beneficiary has a related wallet with balance>0. |
| **RR-8** | **Fidelity rule** | R-FID-004 FIRES when `fidelity.state != HEALTHY` or `row_image_downgraded`; demonstrates detection of pipeline degradation (C3/C4). |
| **RR-9** | **Compound boolean** | R-PRIV-005 FIRES only when BOTH self-privilege-elevation AND off-hours hold; all contributing leaves recorded. |
| **RR-10** | **Scoring & severity bands** | Aggregate event score is computed by the fixed function (§6.2); derived severity matches bands (§6.4); fixed-vs-derived takes the higher. |
| **RR-11** | **Suppression/dedupe** | Repeated identical firings within `cooldown_seconds` increment `occurrence_count` on one alert rather than spawning duplicates. |
| **RR-12** | **No-action guarantee** | A FIRED rule with `propose_reversal:true` produces only a recommended action / alert; it MUST NOT create a ReversalDirective or any DB write. |
| **RR-13** | **Determinism vs rule_version** | Re-evaluating an archived CCE with the same `rule_version` reproduces the historical result exactly. |
| **RR-14** | **Bounded grammar enforcement** | A rule exceeding max nesting depth/leaf count, or containing an unanchored/catastrophic regex, is rejected at authoring time. |
| **RR-15** | **No-code guarantee** | A rule attempting to embed code/SQL/expression in any field is rejected (only the closed predicate/operator set is accepted). |
| **RR-16** | **Decimal correctness** | `sum`/numeric comparisons on money use exact decimals; a float-encoded value is rejected. |

---

## 23. Implementation Constraints (binding)

1. **Rules are data, never code.** The engine executes only the closed predicate (§9–§16) and operator (§8.2) set over CCE paths. No `eval`, no SQL strings, no scripting, no author-supplied expressions. Violations are rejected at authoring.
2. **Bounded grammar.** Enforce maximum condition-tree depth (e.g., ≤ 8), maximum leaves per rule (e.g., ≤ 64), and **safe regex only** (anchored, linear-time / RE2-style; no catastrophic backtracking). This keeps evaluation cost bounded and prevents ReDoS — guarding against the review's "rule-DSL sprawl" risk.
3. **Deterministic & explainable.** Same CCE(s) + same `rule_version` ⇒ same result. Every FIRED result records the matched leaves with observed/expected values. Short-circuit optimizations must not change the recorded matched set.
4. **CCE paths only; engine-agnostic.** Conditions address CCE fields via `path` arrays (relational = single element, document = nested), so one rule works across engines.
5. **Detection never acts.** A rule outcome may raise an alert and *recommend/propose* a reversal; it can never create a ReversalDirective autonomously or write to any database (preserves INV-1). Directive creation remains human + four-eyes (Companion Contracts §A).
6. **Trusted clock for security decisions.** Window/time predicates default to `ingest_ts`; `commit_ts` is permitted only with an explicit acknowledgement and SHOULD be paired with a `fidelity HEALTHY` assertion.
7. **Masked-safe evaluation.** Rules must be evaluable without revealing sensitive values; condition on `changed`/metadata, not on masked plaintext. Notifications carry masked values only.
8. **Cross-table lookups are read-only and bounded.** Only against the EDAM projection (never the monitored DB), with timeout + row caps; non-deterministic/incomplete lookups yield `INDETERMINATE`, never a guess.
9. **No fabrication.** When data needed by a rule is unavailable or degraded, the result is `INDETERMINATE` (with reason), not a forced FIRED/NOT_FIRED.
10. **Immutability & versioning.** Rules are never edited in place; changes mint a new `rule_version`. Results embed the exact `rule_id`/`rule_version`/`signed_hash`. Rule defs, results, and alerts are append-only and WORM-compatible.
11. **Exact decimals for money.** All numeric comparisons/sums on monetary fields use exact decimal arithmetic on string-encoded values (CCE §12.8); float encodings are rejected.
12. **Fixed aggregate scoring function.** The event-aggregate and actor-rollup scoring functions are defined by this spec (§6.2/§6.3); authors tune parameters (base/modifiers/decay), not the function.
13. **Lifecycle changes are audited (and dual-controlled for financial rules).** Enabling/disabling/deprecating rules is recorded append-only; high-value deployments require dual-control for FINANCIAL_FRAUD/DESTRUCTION rules.

---

## 24. Breaking Changes (require a v2 of this spec)

A **major** bump (`risk-rule-2.0` / `rule-evaluation-result-2.0` / `alert-2.0`) is required to:

1. Add/repurpose a **condition node type** (`all/any/not`) or change boolean semantics.
2. Add/repurpose a **leaf predicate type** or **operator** in a way that changes how existing rules evaluate. (Adding a *new, optional* predicate that older engines can ignore safely may be minor — but if existing stored rules would evaluate differently, it is breaking.)
3. Change the **canonical serialization or `signed_hash`** computation (alters rule identity/provenance).
4. Change the **`rule_id` derivation** (`UUIDv5(code ‖ rule_version)`).
5. Change the **aggregate scoring function**, the **score→severity bands**, or the **severity enum**.
6. Change the **RuleEvaluationResult outcome enum** (`FIRED/NOT_FIRED/INDETERMINATE`) or remove `matched_conditions`/`fidelity_context`/`rule_signed_hash` (loss of explainability/reproducibility).
7. Change **window semantics** (time_basis default, sliding/tumbling meaning) such that historical results no longer reproduce.
8. Allow **executable expressions/code** in rules (would violate the no-code invariant — the single most serious possible breakage, as it converts the rule store into an RCE surface).
9. Permit detection outcomes to **originate actions/writes** (would violate INV-1).
10. Change the **category enum** semantics or remove a category in use.

Additive, optional, non-semantic fields and **new optional predicates that existing engines can safely ignore without changing prior results** are **minor** (`risk-rule-1.x`), not breaking.

---

*End of Risk Rule Definition Specification v1. Spec/contract design only — no implementation code. All prior specifications remain unmodified; this spec is compatible with CCE v1, the EDAM companion contracts, and the WORM evidence/anchoring spec.*
