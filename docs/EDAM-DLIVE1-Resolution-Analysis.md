# EDAM D-LIVE-1 Resolution Analysis
### Snapshot-phase capture for MySQL/MariaDB

> **Defect:** D-LIVE-1 (High, design gap) from the Live Stack Validation Report — MySQL snapshot-read events cannot form contract-valid CCEs and are routed to the DLQ.
> **Constraints honored:** no WORM, no anchoring, no projection DB, no Sprint-2 implementation. No code or contract files were modified by this analysis.
> **Date:** 2026-06-01.

---

## 1. Root Cause Analysis

During the initial Debezium snapshot (`op=r`, `source.snapshot=first|true|last`), each emitted record carries:
- `source.gtid = null` (snapshot rows are not individually transacted; no per-row GTID),
- **no `server_uuid`** (the MySQL binlog source struct exposes only `server_id`, which is `0` during snapshot; the UUID is normally recovered from the GTID prefix, which is null here),
- a **binlog coordinate** `source.file` + `source.pos` (the consistent-snapshot position, identical for all snapshot rows),
- `ts_ms`, `table`, full `after` image (decimals already strings).

The frozen CCE-v1 contract requires (verified against `packages/contracts/src/schemas/cce-1.0.schema.json`):

| Field | Constraint | Snapshot reality |
|---|---|---|
| `source.server_uuid` | `string`, **minLength 1** | absent ⇒ `""` ❌ |
| `offset` | `anyOf` of **`gtid` / `lsn` / `scn` / `resume_token`** (non-null string); `additionalProperties:false` | only `binlog_file`+`binlog_pos` present ⇒ no branch satisfied ❌ |
| `transaction.tx_id` | `string`, minLength 1 (free-form) | derivable ✅ |
| `envelope_id` (V3) | `UUIDv5(db_id ‖ tx_id ‖ server_uuid)` | needs a **unique** tx_id per snapshot row; binlog file:pos is identical for all rows ⇒ collision risk ❌ |

So a snapshot read fails **(a)** `source.server_uuid` (empty), **(b)** `offset` `anyOf` (no GTID), and **(c)** would collide on `envelope_id` if all rows shared the same synthetic tx_id. `buildCce` → `validateCceFull` rejects → the Normalizer routes to the DLQ as `SCHEMA_VALIDATION_FAILURE`.

**Behaviour is correct and honest** (no loss, no fabrication — invalid events are quarantined, not emitted), but the **initial baseline is not captured as CCEs**. CCE §5 explicitly maps a snapshot read to an INSERT, so the design intends baseline capture; therefore this is a real gap to close.

There are **three** sub-problems: **(P1) server_uuid**, **(P2) a contract-valid offset**, **(P3) a unique envelope identity per snapshot row**.

---

## 2. Alternatives Comparison

| # | Option | Solves | Contract change? | Honest? | Deterministic? | Verdict |
|---|---|---|---|---|---|---|
| A | **Acquire `@@server_uuid` read-only** and stamp it on snapshot events (MariaDB: `@@server_id`) | P1 | **No** | ✅ real value | ✅ stable | **Adopt** |
| B | **Snapshot-specific `tx_id`** = `snapshot:<schema>.<table>:<canonical-pk>` (free-form string per CCE §3) → unique, deterministic `envelope_id` | P3 | **No** (tx_id is free-form) | ✅ | ✅ | **Adopt** |
| C | **Add a binlog-coordinate branch to `offset.anyOf`** — accept `{binlog_file, binlog_pos}` as a valid MySQL/MariaDB offset (the fields already exist) | P2 | **Yes — minimal, additive** | ✅ exact per-record value | ✅ Debezium provides it per record | **Recommended** |
| D | `offset.gtid` = snapshot-point `@@gtid_executed` obtained by query | P2 | No | ⚠️ **approximation** — the collector's read time ≠ Debezium's exact snapshot point; may over/under-state coverage | ⚠️ non-deterministic across re-runs | Reject (correctness risk) |
| E | `offset.resume_token` = `binlog:<file>:<pos>` | P2 | No | ⚠️ **field misuse** — `resume_token` is the MongoDB position (CCE §6.6); repurposing it for MySQL mislabels the data | ✅ | Reject (semantic abuse) |
| F | `offset.gtid` = `"<file>:<pos>"` (binlog coord in the gtid field) | P2 | No | ❌ a non-GTID in the GTID field; breaks the completeness GTID parser | ✅ | Reject (corrupts GTID semantics) |
| G | **Skip snapshot reads** (treat baseline as "not a change") — acknowledge, never DLQ | (sidesteps) | No | ✅ | ✅ | Reject as primary (contradicts CCE §5 r→INSERT and loses baseline); viable only if baseline capture is formally descoped |

**P1/P3 are fully solvable with no contract change (A, B).** **P2 has no honest, exact, deterministic solution without a contract change** — the only correct per-record snapshot position is the binlog coordinate, which the current `offset.anyOf` does not accept. Hence the recommended solution **requires a minimal, additive contract amendment (C)**.

---

## 3. Compatibility Verification

| Dimension | Verification |
|---|---|
| **CCE-v1** | A uses existing `source.server_uuid`; B uses free-form `transaction.tx_id`; C is **additive** (adds one `offset.anyOf` branch over already-present `binlog_file`/`binlog_pos` fields). **No existing field is removed/renamed and no semantics change** ⇒ backward-compatible (a `cce-1.x` MINOR per CCE §9, not a §13 breaking change). |
| **Hashing / determinism** | Existing CCEs already carry `binlog_file`/`binlog_pos` (non-null for streaming) inside the hashed core, so **no existing `event_hash` changes** and the pinned golden vectors (FX-001..005, all streaming) are unaffected. New snapshot CCEs hash deterministically (binlog file:pos is identical per snapshot row across re-runs; `tx_id` and `server_uuid` are stable) ⇒ the two-target determinism rig continues to hold. |
| **EDAM-v2 architecture** | `snapshot_phase` (snapshot/handoff/streaming) is already first-class in CCE completeness; capturing snapshot rows as INSERT CCEs with `snapshot_phase=snapshot` matches the v2 capture model. No architecture change. |
| **Completeness** | Snapshot rows carry a **binlog** offset, not a GTID, so they are correctly **excluded from the GTID-continuity set** (the watcher only consumes GTIDs). Baseline coverage is represented by `snapshot_phase` + the existing snapshot→stream handoff marker; streaming continuity (GTID gap detection) is unchanged. No completeness regression. |
| **INV-1 / INV-2** | A acquires `server_uuid` over the **read-only** connection (no write path; INV-1 preserved). Values are real, never fabricated; if `server_uuid` or the binlog coordinate is genuinely unavailable, the event still honestly routes to the DLQ (INV-2 preserved). |

---

## 4. Recommended Solution

**Adopt A + B + C together** (the minimal complete fix):

1. **(A) server_uuid** — the collector/normalizer obtains `@@server_uuid` (MySQL) / `@@server_id` (MariaDB) via the existing **read-only** connection (the attestation sampler already reads `server_uuid`; reuse its `config_snapshot.sampled.server_uuid`) and stamps it on snapshot-phase events.
2. **(B) snapshot identity** — for snapshot-phase events (no GTID), set `transaction.tx_id = snapshot:<schema>.<table>:<canonical primary_key>` so each baseline row yields a unique, deterministic `envelope_id` (no V15 collision). Streaming is unchanged (tx_id = GTID).
3. **(C) offset** — accept the binlog coordinate as a valid offset (minimal contract amendment, §5) so snapshot events satisfy the offset rule with their **exact, honest** per-record position.

Result: snapshot reads become valid INSERT CCEs (`snapshot_phase=snapshot`), deterministically, with no loss and no fabrication; the initial baseline is captured.

---

## 5. Required Contract Amendment (minimal, additive)

**This is a CONTRACT CHANGE — proposed here, not applied.** It must be ratified before implementation (Sprint-2 task 0).

**Exact sections to amend:**
- `CCE-v1-Specification.md` **§6.6 (offset)** — document that for `engine ∈ {mysql, mariadb}` a binlog coordinate `{binlog_file, binlog_pos}` is a valid offset (used for snapshot-phase events that precede the first GTID).
- `CCE-v1-Specification.md` **Appendix B (JSON Schema), `offset.anyOf`** — add one branch:
  ```json
  { "required": ["binlog_file", "binlog_pos"],
    "properties": { "binlog_file": { "type": "string" }, "binlog_pos": { "type": "integer", "minimum": 0 } } }
  ```
  (alongside the existing `gtid`/`lsn`/`scn`/`resume_token` branches; `additionalProperties:false` is unchanged — no new fields are introduced).
- `CCE-v1-Specification.md` **§10 V11** — restate as: "at least one offset key is present — `gtid`/`lsn`/`scn`/`resume_token`, **or** a `binlog_file`+`binlog_pos` pair for MySQL/MariaDB."
- **Vendored schema** (`packages/contracts/src/schemas/cce-1.0.schema.json`) re-synced verbatim, and the contracts validator unchanged (it already validates `anyOf`).

**Impact:**
- **Additive & backward-compatible.** Every previously-valid CCE remains valid; no `event_hash`/`envelope_id`/golden vector changes (the binlog fields already exist in the hashed core). Classify as a **MINOR** amendment (`cce-1.1`), not a §13 breaking change.
- **Conformance:** add a snapshot conformance case (C-3 extension or a new C-9/“snapshot”) once implemented.
- **No impact** on WORM/anchoring/projection (deferred) or on streaming behavior.

---

## 6. Implementation Impact (Sprint-2 task 0 — not done here)

- **`services/cdc-collector` (E2 adapter):** for snapshot events, populate `offset` from `binlog_file`+`binlog_pos`; supply `server_uuid` from the attestation sample when the GTID is absent.
- **`services/normalization` (E4):** snapshot-phase `tx_id` = `snapshot:<schema>.<table>:<pk>`; ensure the accumulator emits one CCE per snapshot row (unique tx_id).
- **`packages/contracts`:** re-sync the amended vendored schema; update V11 text/comment.
- **Tests:** unit (snapshot offset + tx_id + server_uuid), a conformance case, and a re-run of the live validation confirming snapshot rows now produce valid CCEs (no DLQ for snapshot) — with refreshed determinism golden vectors that include a snapshot fixture.
- **Estimated size:** small (localized to collector/normalizer + one schema branch + tests).

---

## 7. Go / No-Go Recommendation

**Resolution status: D-LIVE-1 is FORMALLY ACCEPTED** — root cause fully understood; the minimal, additive, backward-compatible amendment (C) plus the no-contract-change parts (A, B) are specified and verified compatible with CCE-v1, EDAM-v2, determinism, and completeness. No honest no-contract-change solution exists for the offset (P2); options D/E/F/G were evaluated and rejected.

## ✅ **GO for Sprint-2 — conditional.**

Sprint-2 may begin **on the condition** that **D-LIVE-1 (A+B+C) is implemented as Sprint-2 task 0**, *before* any evidence/WORM work treats capture as complete (an uncaptured baseline must not be sealed as "complete" evidence). Until then the behavior is safe (snapshot rows → DLQ, no loss, no fabrication), so proceeding is acceptable.

**Ratification required:** the §5 amendment (`cce-1.x` MINOR) must be approved by the contract owner before the schema is changed. This document is the formal acceptance record and the implementation specification.

**Defer note:** if, alternatively, the baseline snapshot is **formally descoped** from CCE capture (option G — capture only changes), then no contract change is needed and snapshot reads should be *acknowledged/skipped* rather than DLQ'd; this is a weaker posture (no baseline) and is **not** recommended for an audit/tamper-detection product.

---

*Analysis complete. No code or contract files modified; recommended amendment proposed and formally accepted for Sprint-2 task 0.*
