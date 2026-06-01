# CCE Contract Amendment Proposal — `cce-1.1` (D-LIVE-1)
### Snapshot-phase offset for MySQL/MariaDB

| Field | Value |
|---|---|
| **Amendment ID** | CCE-AMD-001 (D-LIVE-1) |
| **Target contract** | `CCE-v1-Specification.md` (currently `cce-1.0`) |
| **Proposed version** | `cce-1.1` |
| **Classification** | **MINOR** — additive, backward-compatible |
| **Status** | **Proposed — ratification-ready** (not applied; no schema/code modified) |
| **Depends on** | Live Stack Validation finding **D-LIVE-1**; `EDAM-DLIVE1-Resolution-Analysis.md` |
| **Author role** | Contract amendment / verification |

> This document is a proposal only. No schema, contract text, or code has been modified. Ratification by the contract owner is required before any change is applied.

---

## 1. Problem Statement

During the initial Debezium snapshot, MySQL/MariaDB snapshot-read events (`op=r`) **cannot be expressed as valid Canonical Change Events**. They are therefore rejected by `validateCceFull` and honestly routed to the Dead Letter Queue (`SCHEMA_VALIDATION_FAILURE`). Consequently the **initial database baseline is not captured as CCEs**, even though CCE §5 maps a snapshot read to an INSERT. Streaming changes (post-snapshot, GTID-bearing) are unaffected.

This was observed live (`EDAM-Live-Stack-Validation-Report.md`, defect D-LIVE-1): of 31 data events, 23 snapshot reads went to the DLQ; 8 streaming change-items produced valid CCEs.

---

## 2. Root Cause

A Debezium MySQL/MariaDB **snapshot** record carries:
- `source.gtid = null` (snapshot rows are not individually transacted),
- **no server UUID** (the binlog source struct exposes only `server_id`, which is `0` during snapshot; the UUID is normally recovered from the GTID prefix, which is null here),
- a **binlog coordinate** `source.file` + `source.pos` (the consistent-snapshot position),
- `ts_ms`, `table`, full `after` image.

Three sub-problems arise against `cce-1.0`:

| # | Sub-problem | Frozen constraint |
|---|---|---|
| P1 | `source.server_uuid` is empty | schema: `string`, `minLength: 1` |
| P2 | the offset has **only** `binlog_file`+`binlog_pos`, which satisfies **no** `offset.anyOf` branch | schema: `offset.anyOf = [gtid, lsn, scn, resume_token]`; `additionalProperties: false` |
| P3 | a unique `envelope_id` per snapshot row | V3: `UUIDv5(db_id ‖ tx_id ‖ server_uuid)` — binlog file:pos is identical for all snapshot rows |

**P1 and P3 are solvable without any contract change** (acquire `@@server_uuid` read-only; use a snapshot-specific free-form `transaction.tx_id`). **P2 is the contract limitation this amendment addresses.**

---

## 3. Current Contract Limitation

`cce-1.0` models the change-stream **offset** as one of four engine keys — `gtid` (MySQL/MariaDB), `lsn` (Postgres/SQL Server), `scn` (Oracle), `resume_token` (MongoDB) — and validation rule **V11** requires at least one of these to be a non-null string.

The `offset` object **already contains** `binlog_file` (`string|null`) and `binlog_pos` (`integer|null, minimum 0`), but **no `anyOf` branch accepts them**, and `offset.additionalProperties` is `false`. Therefore the **exact, honest, per-record position of a MySQL/MariaDB snapshot read — the binlog coordinate — cannot satisfy the offset rule.** There is no honest, deterministic `cce-1.0`-valid offset for a snapshot read (see §12).

---

## 4. Proposed Amendment

Add the binlog coordinate as a **valid offset** for `engine ∈ {mysql, mariadb}`. Specifically: introduce one additional `offset.anyOf` branch accepting `{binlog_file, binlog_pos}`, and restate V11 to recognize it. **No new field is introduced** (the fields already exist); **`additionalProperties: false` is unchanged**; **no existing field, type, enum, or rule is removed or altered**.

Events that rely on this new branch (i.e. snapshot-phase events with a binlog-only offset) declare `schema_version = "cce-1.1"`. Events with a GTID/LSN/SCN/resume_token offset remain `"cce-1.0"` and are byte-unchanged.

---

## 5. Exact JSON Schema Changes

Target: `CCE-v1-Specification.md` Appendix B, `properties.offset.anyOf`, and the vendored copy `packages/contracts/src/schemas/cce-1.0.schema.json` (to be re-issued as `cce-1.1.schema.json`).

**Before (`cce-1.0`):**
```json
"anyOf": [
  { "required": ["gtid"], "properties": { "gtid": { "type": "string" } } },
  { "required": ["lsn"], "properties": { "lsn": { "type": "string" } } },
  { "required": ["scn"], "properties": { "scn": { "type": "string" } } },
  { "required": ["resume_token"], "properties": { "resume_token": { "type": "string" } } }
]
```

**After (`cce-1.1`) — one additive branch (highlighted):**
```json
"anyOf": [
  { "required": ["gtid"], "properties": { "gtid": { "type": "string" } } },
  { "required": ["lsn"], "properties": { "lsn": { "type": "string" } } },
  { "required": ["scn"], "properties": { "scn": { "type": "string" } } },
  { "required": ["resume_token"], "properties": { "resume_token": { "type": "string" } } },
  { "required": ["binlog_file", "binlog_pos"],
    "properties": {
      "binlog_file": { "type": "string", "minLength": 1 },
      "binlog_pos": { "type": "integer", "minimum": 0 }
    } }
]
```

No other schema change. `offset.properties` and `offset.additionalProperties: false` are unchanged. The `schema_version` pattern (`^cce-\d+\.\d+$`) already accepts `"cce-1.1"`.

---

## 6. Exact Validation Rule Changes

Target: `CCE-v1-Specification.md` §10 (V11) and §6.6.

**§10 V11 — Before:**
> **V11** At least one `offset` engine key is non-null.

**§10 V11 — After:**
> **V11** At least one `offset` key is present and non-null: `gtid`, `lsn`, `scn`, or `resume_token`; **or, for `engine ∈ {mysql, mariadb}`, a `binlog_file` (non-empty string) + `binlog_pos` (integer ≥ 0) pair** (used for snapshot-phase events that precede the first GTID).

**§6.6 (offset) — add a clarifying note:**
> For MySQL/MariaDB, the offset is the GTID during streaming; during the initial snapshot (no GTID yet) the offset is the binlog coordinate `binlog_file:binlog_pos`. Snapshot offsets are **excluded from GTID-continuity (gap) analysis** (§6.5) because they are not part of the GTID stream; baseline coverage is represented by `completeness.snapshot_phase` and the snapshot→stream handoff.

The code validator (`@edam/contracts`) requires **no logic change** — it already evaluates `offset.anyOf` and classifies failures as V11; only the vendored schema (one branch) and the V11 spec text change.

---

## 7. Compatibility Analysis

| Concern | Outcome |
|---|---|
| **Existing `cce-1.0` events** | Remain valid under `cce-1.1` (the new branch is additive; GTID/LSN/SCN/resume_token branches are unchanged). |
| **Strict `cce-1.0`-only consumer** | Correctly rejects a binlog-only offset (it predates the feature); a `cce-1.x` consumer accepts both — consistent with the §9 version gate (reject unknown **major**, accept additive minors). |
| **`additionalProperties: false`** | Preserved — no new property is introduced; `binlog_file`/`binlog_pos` already exist. |
| **Other engines (Postgres/SQL Server/Oracle/Mongo)** | Unaffected — their branches are unchanged; the binlog branch is engine-scoped by usage. |
| **WORM / anchoring / projection** | Not implemented; no impact. |

---

## 8. Impact Analysis

| Artifact | Impact |
|---|---|
| **`envelope_id`** | **No change to existing events** (derivation `UUIDv5(db_id‖tx_id‖server_uuid)` and its inputs are unchanged). New snapshot events derive a unique id from a snapshot-specific free-form `tx_id` (= `snapshot:<schema>.<table>:<pk>`) — no collision (P3 closed by the no-contract-change part). |
| **`event_hash`** | **No rehash of any existing event.** `event_hash` is computed over the canonical CCE core; existing events keep `schema_version = "cce-1.0"` and their already-present `binlog_file`/`binlog_pos` values — their bytes are unchanged. New snapshot events declare `"cce-1.1"` and hash deterministically. The canonical serialization (§12.7) and hashing algorithm are **untouched**. |
| **`row_hash`** | Chain construction `H(prev_row_hash ‖ event_hash)` is unchanged. Existing chains are unaffected; snapshot events chain normally. |
| **Determinism** | The two-target rig is unaffected — the pinned golden vectors (FX-001..005) are all streaming (GTID) and do not change. Snapshot offsets (`binlog_file:binlog_pos`) are deterministic per record (Debezium emits the same consistent-snapshot coordinate across re-runs); `tx_id` and `server_uuid` are stable ⇒ snapshot `event_hash`/`envelope_id` are reproducible cross-architecture. A snapshot golden vector is added at implementation. |
| **Completeness** | No regression. Snapshot offsets are **not** added to the consumed GTID set (they carry no GTID), so GTID-gap detection is unchanged. Baseline coverage is represented by `completeness.snapshot_phase` + the existing snapshot→stream handoff marker; the first streaming GTID continues continuity from the snapshot point. |
| **Fidelity** | No impact. A snapshot taken under a healthy source still assesses `HEALTHY`; degradation rules (§6.4) are unchanged. |
| **Conformance suite** | All current cases (C1, C3, C4, C5, C6, C7, C8, C10) are unaffected. A new **snapshot conformance case** is added at implementation (snapshot read ⇒ valid INSERT CCE with `snapshot_phase=snapshot`, binlog offset, unique `envelope_id`). |

---

## 9. Migration Strategy

1. **Ratify** this amendment (contract owner sign-off).
2. **Publish `cce-1.1`** — the `cce-1.0` schema plus the single additive `offset.anyOf` branch; retain `cce-1.0` as historical. Update §6.6 / §10 V11 text.
3. **Re-sync** the vendored schema in `packages/contracts` (verbatim) and update the V11 comment; validator logic unchanged.
4. **Implement** the no-contract-change parts (A: `@@server_uuid` acquisition read-only; B: snapshot `tx_id`) and emit snapshot CCEs with `schema_version = "cce-1.1"` and a binlog offset.
5. **Add** a snapshot conformance case + a snapshot determinism golden vector; re-run the live validation to confirm snapshot reads now produce valid CCEs (no DLQ for well-formed snapshot rows).
6. **No data migration** — Sprint-1 produces no persisted CCEs (WORM/projection deferred); existing `cce-1.0` events (if any later) remain valid and are never rewritten (append-only invariant INV-3).

**Backward path:** a `cce-1.x` validator accepts both versions; a strict `cce-1.0` validator rejects binlog-only offsets (correct, version-gated). No downgrade is required or supported.

---

## 10. Why This Is a MINOR Version Change

Per CCE §9 (versioning) and §13 (breaking-change triggers), this amendment is a **MINOR** (`cce-1.0 → cce-1.1`):

- It is **additive and optional**: it adds one permissive `anyOf` branch over **already-existing** fields; nothing is removed or renamed.
- It matches **none** of the §13 breaking-change triggers — it does **not** change the canonical serialization or hashing (§13.1), the `envelope_id` derivation (§13.2), the global ordering (§13.3); it does **not** remove/rename/retype a required field (§13.4) or change before/after nullity (§13.5); it does **not** change the hash-chain construction (§13.7), repurpose an enum (§13.8), turn an honest unknown into a fabricated value (§13.9), or change decimal encoding (§13.10).
- **Existing events remain valid and their hashes are unchanged**, satisfying the §9 forward/backward-compatibility rules (additive minors must be ignorable/acceptable by `1.x` consumers).

It is therefore a textbook additive MINOR, not a breaking change.

---

## 11. Alternatives Considered (adopted, no contract change)

- **A — `@@server_uuid` acquisition (read-only):** closes P1. The server UUID is obtained over the existing read-only connection (the attestation sampler already reads `server_uuid`). No contract change; honest; deterministic; preserves INV-1.
- **B — Snapshot-specific `tx_id`:** closes P3. `transaction.tx_id = snapshot:<schema>.<table>:<canonical primary_key>` (the schema types `tx_id` as a free-form `string`, `minLength 1`). Yields a unique, deterministic `envelope_id` per baseline row; no collision; no contract change.

A and B are **prerequisites** to the amendment; together with C they fully close D-LIVE-1.

---

## 12. Rejected Alternatives

| Option | Mechanism | Reason rejected |
|---|---|---|
| **D** | `offset.gtid` = `@@gtid_executed` obtained by query at consume time | **Approximation** — the collector's read time ≠ Debezium's exact snapshot point; it may over/under-state coverage and is **non-deterministic** across re-runs. |
| **E** | `offset.resume_token` = `binlog:<file>:<pos>` | **Field misuse** — `resume_token` is defined as the MongoDB position (§6.6); repurposing it for MySQL mislabels the data and degrades auditability. |
| **F** | `offset.gtid` = `"<file>:<pos>"` | **Corrupts GTID semantics** — places a non-GTID in the GTID field and breaks the completeness GTID parser. |
| **G** | Skip snapshot reads (treat baseline as "not a change") | **Loses the baseline** and contradicts CCE §5 (`r` → INSERT); unacceptable for a tamper-detection product. Viable only if baseline capture is formally descoped (not recommended). |

None of D–G is both honest and deterministic; only the additive binlog-coordinate branch (C) is.

---

## 13. Auditor Recommendation

**Recommend APPROVAL.** The amendment is the minimal, exact, and honest resolution to D-LIVE-1: it accepts the genuine per-record snapshot position (the binlog coordinate) that the contract already records but does not yet validate. It is additive and backward-compatible, leaves every existing event and hash unchanged, preserves determinism, completeness, fidelity, and the full invariant set (INV-1 read-only acquisition; INV-2 honest values / DLQ fallback), and requires **no validator logic change** — only one schema branch and a V11 text restatement. The rejected alternatives are demonstrably either dishonest, non-deterministic, or scope-reducing.

**Conditions of approval:** (i) adopt prerequisites A and B in the same change; (ii) snapshot events declare `schema_version = "cce-1.1"`; (iii) add a snapshot conformance case and determinism golden vector; (iv) re-run live validation to confirm snapshot capture.

---

## 14. Final Ratification Recommendation

> **RATIFY as `cce-1.1` (MINOR).**

This is the first amendment since the contract freeze and should be processed through the normal MINOR change path: ratify → publish `cce-1.1` → re-sync the vendored schema → implement A+B+C as **Sprint-2 task 0** → extend the conformance + determinism suites → re-validate on the live stack. Upon ratification, **D-LIVE-1 is closed** and Sprint-2 may proceed with snapshot-phase capture as its first deliverable; no WORM/evidence work should treat capture as complete until this lands.

---

*Amendment proposal only. No schema, contract, or code modified. Ratification required before application.*
