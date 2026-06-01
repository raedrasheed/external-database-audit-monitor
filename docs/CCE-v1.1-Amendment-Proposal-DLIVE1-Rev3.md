# CCE Contract Amendment Proposal — `cce-1.1` (D-LIVE-1) — **Revision 3**
### Snapshot-phase capture for MySQL/MariaDB — epoch identity, positive guards, deterministic sealing

| Field | Value |
|---|---|
| **Amendment ID** | CCE-AMD-001 (D-LIVE-1) |
| **Revision** | **Rev 3** (supersedes Rev 1 & Rev 2; both retained as history) |
| **Target contract** | `CCE-v1-Specification.md` (currently `cce-1.0`) |
| **Proposed version** | `cce-1.1` |
| **Classification** | **MINOR** — additive; new fields are optional or conditionally-required; no existing valid event is invalidated (see §10.7, §10.8) |
| **Status** | **Proposed — ratification-ready** (not applied; no schema/code modified) |
| **Authoritative input** | Final adversarial ratification review of Rev 2 (findings F1/C1, F2/H1, F3/H2, F4, F5, F6, F7) |
| **Author role** | Contract amendment / verification |

> Proposal only. No schema, contract text, or code has been modified. Ratification by the contract owner is required before any change is applied.

---

## 0. What Changed in Revision 3

Rev 2 was **rejected** because its C1 remedy was built on `config_snapshot_id`, which the code proves is a **content-addressed fidelity-sampling fingerprint** (`attestation/snapshot.ts:49–70`, hashing `sampled_at = clock.now()` from `monitor.ts:45`) — **not** a snapshot epoch. Rev 3 replaces that foundation and closes every blocking finding with **machine-enforceable, capture-deterministic** mechanisms.

| Finding (Rev 2 review) | Root cause | Rev 3 resolution | § |
|---|---|---|---|
| **F1 / C1 (Critical)** | snapshot identity reused a sampling fingerprint | **New `snapshot_epoch_id`**, derived from the Debezium snapshot **watermark**; independent of `config_snapshot_id` and `sampled_at` | §1–§2, §4 |
| **F2 / H1 (High)** | offset guards were negatively framed; optional `snapshot_phase` bypassed them | **Single positive guard (V16)**: a binlog-only offset is valid *iff* `cce-1.1` ∧ mysql/mariadb ∧ `snapshot_phase ∈ {snapshot,handoff}` | §5 |
| **F3 / H2 (High)** | snapshot rows share `commit_ts`+coordinate ⇒ ordering ties ⇒ non-deterministic chain | **Total-order tie-break** ending in `envelope_id` ⇒ deterministic `row_hash`/WORM seal | §6 |
| **F4 (Medium)** | colon-joined `tx_id` could alias on data-influenced PKs | **`tx_id` row component is a canonical-tuple hash** ⇒ collision-free | §3 |
| **F5 (Medium)** | `ingest_ts`/`commit_ts` could be build-time clock ⇒ replay divergence | **Capture-sourced timestamps**, build-time clock barred from the core | §7 |
| **F6 (Medium)** | snapshot coverage unattested ⇒ silent partial baseline | **Snapshot coverage attestation** (expected vs emitted, status) surfaced in completeness | §8 |
| **F7 (Medium)** | re-snapshots accumulate baselines with no current/superseded semantics | **WORM baseline supersession** via epoch manifest + projection-time current pointer | §9 |
| M1/M2 (resolved in Rev 2) | — | Subsumed by the single positive guard V16 (version + engine + phase) | §5 |

The change is larger than Rev 2 (it adds fields), but every addition is **optional or conditionally-required only in the new snapshot phase**, so **no existing `cce-1.0` event becomes invalid** and **no existing hash is recomputed** — it remains a textbook additive MINOR (§10.7).

---

## 1. `snapshot_epoch_id` — Definition (resolves F1/C1)

A new value carried on snapshot-phase CCEs that uniquely and stably identifies **one snapshot run**. It MUST satisfy:

| Requirement | How Rev 3 satisfies it |
|---|---|
| Assigned **once at snapshot start** | Derived from the snapshot **low-watermark** binlog coordinate captured at the `snapshot=first` marker |
| **Constant** for every row of the same snapshot | The low-watermark is held constant for the whole snapshot and stamped onto every snapshot record |
| **Distinct** across re-snapshots | A later snapshot starts at a later binlog coordinate (and/or different content) ⇒ different watermark ⇒ different id |
| **Deterministic** within replay of the same captured snapshot | The watermark is part of the *captured* data; replay of identical bytes reproduces the identical id (no wall-clock, no runtime nonce) |
| **Independent** of `config_snapshot_id` | Derived from the binlog watermark + source identity, never from config |
| **Not derived from attestation `sampled_at`** | `sampled_at` is excluded entirely; the input is the source binlog position |

---

## 2. `snapshot_epoch_id` — Generation (decision)

### 2.1 Options evaluated

| Option | Once-at-start? | Constant per snapshot? | Distinct per re-snapshot? | Replay-deterministic? | Independent of `sampled_at`? | Verdict |
|---|---|---|---|---|---|---|
| **(a) Debezium snapshot watermark** (snapshot-start binlog coordinate, content-addressed with `db_id`+`server_uuid`) | **Yes** (low-watermark fixed at `snapshot=first`) | **Yes** (held constant across the snapshot) | **Yes** (advances with the binlog) | **Yes** (captured data) | **Yes** | **RECOMMENDED** |
| (b) connector-run nonce / ULID | Yes | Yes | Yes | **No** — a connector restart/replay yields a different nonce ⇒ same row re-emits under a new epoch (duplicate baseline) | Yes | Rejected |
| (c) snapshot-start record (synthetic marker) | Yes | Yes | Only if the marker carries the watermark | Yes if watermark-based | Yes | Folded into (a) — it *is* the carrier of the watermark |
| (d) source binlog coordinate **+ connector instance id** | Yes | Yes | Yes | **No** — instance id is runtime-volatile ⇒ breaks replay | Yes | Rejected |
| (e) persisted EDAM snapshot epoch registry (monotonic ordinal per `db_id`) | Yes | Yes | Yes (even idle DB) | Yes **iff** allocation is idempotent on a captured key | Yes | **Fallback** (see §2.3) |

### 2.2 Recommendation — **Option (a): content-addressed snapshot watermark**

```
snapshot_epoch_id = "snap-" + sha256Hex( serializeCanonical({
    db_id:            <source.db_id>,
    server_uuid:      <source.server_uuid>,          // acquired read-only (Rev-1 prereq A)
    snapshot_start_binlog_file: <low-watermark file>, // from the snapshot=first marker
    snapshot_start_binlog_pos:  <low-watermark pos>
}) ).slice(0, 16)
```

- **Carrier:** the low-watermark (`SHOW MASTER STATUS` at snapshot begin) is captured at the `snapshot=first` marker and propagated onto every snapshot record of the run. Robustness note: if a given connector advances `source.pos` per chunk instead of holding the low-watermark, EDAM MUST stamp the epoch from the **first** marker's coordinate, not per-row `source.pos`.
- **Idle-DB edge (the residual C1 trap):** if the DB is idle between two snapshots the watermark can repeat. This is **safe by construction in Rev 3** because (§7) `commit_ts`/`ingest_ts` are **capture-sourced**: a byte-identical re-snapshot of an unchanged row yields an identical `envelope_id` **and** identical `event_hash` ⇒ dedup classifies it **DUPLICATE** (skip) — *not* a V15 violation. A re-snapshot in which *anything* changed (coordinate advanced, row content changed, or source snapshot time differs) changes `snapshot_epoch_id` and/or `event_hash`, producing a distinct baseline. There is **no** combination that yields "same `envelope_id`, different `event_hash`" for a legitimate snapshot. (Proof obligation discharged by the conformance tests in §12.1–§12.2.)

### 2.3 Fallback

If an operator runs an engine/connector where the low-watermark cannot be guaranteed constant per run, adopt **(e)** the persisted EDAM epoch registry: a durable `(db_id, captured snapshot-start key) → monotonic ordinal` map with **idempotent** allocation (replay of the same captured key reuses the recorded ordinal). `snapshot_epoch_id = "snap-" + sha256Hex(db_id ‖ server_uuid ‖ ordinal).slice(0,16)`. (a) is preferred because it is stateless and purely capture-derived; (e) is the stateful safety net.

---

## 3. Snapshot `tx_id` — Collision-free encoding (resolves F4)

The Rev-2 colon-join could alias on data-influenced PK values. Rev 3 makes the row-identity component a **canonical-tuple hash**, joining only fixed-format hex tokens:

```
rowKeyHash = sha256Hex( serializeCanonical({
    schema:      <changes[0].object.schema>,
    name:        <changes[0].object.name>,
    primary_key: <changes[0].object.primary_key>     // canonicalized per §12.7 (NFC, code-point sort, exact-decimal-as-string)
}) )

transaction.tx_id = "snapshot:" + snapshot_epoch_id + ":" + rowKeyHash
```

- Every joined component (`snapshot:` literal, `snap-<16hex>`, `<64hex>`) is a fixed, delimiter-free token ⇒ **no two distinct (epoch, schema, table, PK) tuples can map to one `tx_id`.** PK string values containing `:` are absorbed inside the canonical JSON before hashing.
- `tx_id` stays a free-form `string, minLength ≥ 1` — **schema type unchanged**.
- `envelope_id = UUIDv5(db_id ‖ tx_id ‖ server_uuid)` (V3) is unchanged in derivation; uniqueness now holds because `tx_id` is unique per baseline row per epoch. (Chosen over bare length-prefixing because the canonical-hash also gives a fixed-width, audit-stable key; structured-JSON-canonicalization is exactly what `serializeCanonical` performs internally.)

---

## 4. `consumed_offset_key` for snapshot events (resolves F1's M3 leg)

`completeness.consumed_offset_key` is required, `minLength 1`, and in the hashed core. For snapshot events define it **on the epoch, not the sampling id and not the volatile binlog pos**:

```
completeness.consumed_offset_key = "snapshot-epoch:" + snapshot_epoch_id
completeness.snapshot_phase      = "snapshot"   (or "handoff" at the boundary)
completeness.gap_detected        = false
completeness.consumed_gtid_set   = (omitted — no GTID consumed yet)
```

Epoch-stable, deterministic, identical for all rows of a run, distinct across re-snapshots, free of wall-clock and of `config_snapshot_id`. Excluded from GTID-gap analysis (§6.5); continuity resumes at the first streaming GTID after handoff.

---

## 5. Positive offset guard (resolves F2/H1, subsumes M1/M2)

Replace Rev 2's three **negative** guards with **one positive guard**. Keep the binlog branch in `offset.anyOf` (so a binlog-only offset can satisfy the base `anyOf`), and add a top-level `allOf` clause that constrains **the binlog-only case** — defined as *"`offset` matches none of the four real engine keys."*

```json
{
  "if": {
    "properties": {
      "offset": { "not": { "anyOf": [
        { "required": ["gtid"],         "properties": { "gtid":         { "type": "string" } } },
        { "required": ["lsn"],          "properties": { "lsn":          { "type": "string" } } },
        { "required": ["scn"],          "properties": { "scn":          { "type": "string" } } },
        { "required": ["resume_token"], "properties": { "resume_token": { "type": "string" } } }
      ] } }
    }
  },
  "then": {
    "allOf": [
      { "properties": { "schema_version": { "const": "cce-1.1" } }, "required": ["schema_version"] },
      { "properties": { "source": { "properties": { "engine": { "enum": ["mysql", "mariadb"] } }, "required": ["engine"] } }, "required": ["source"] },
      { "properties": { "completeness": { "properties": { "snapshot_phase": { "enum": ["snapshot", "handoff"] } }, "required": ["snapshot_phase"] } }, "required": ["completeness"] },
      { "properties": { "offset": { "required": ["binlog_file", "binlog_pos"],
          "properties": { "binlog_file": { "type": "string", "minLength": 1 }, "binlog_pos": { "type": "integer", "minimum": 0 } } } } }
    ]
  }
}
```

**Truth table (the cases the Rev-2 review broke):**

| Event | `if` (binlog-only?) | `then` outcome | Result |
|---|---|---|---|
| Streaming mysql, has `gtid` | false (matches gtid) | n/a | **valid** (via base anyOf) |
| Streaming mysql, `gtid=null`, binlog present, `snapshot_phase=streaming` | true | requires `snapshot_phase ∈ {snapshot,handoff}` ⇒ **fails** | **rejected → DLQ** (closes F2) |
| Streaming mysql, `gtid=null`, binlog present, **`snapshot_phase` absent** | true | requires `completeness.snapshot_phase` present ∈ {snapshot,handoff} ⇒ **fails** | **rejected → DLQ** (closes the F2 bypass) |
| Snapshot mysql, `cce-1.1`, binlog present, `snapshot_phase=snapshot` | true | all four sub-clauses hold ⇒ **passes** | **valid** |
| Snapshot **postgres**, binlog fields stuffed, no LSN | true | engine ∈ {mysql,mariadb} ⇒ **fails** | **rejected** (M2) |
| Event labelled **`cce-1.0`**, binlog-only | true | `schema_version=cce-1.1` ⇒ **fails** | **rejected** (M1) |

**Restated V11:** *At least one `offset` real engine key (`gtid`/`lsn`/`scn`/`resume_token`) is non-null; or a binlog-only offset that satisfies the positive guard V16 (§5).* Streaming events (and all non-MySQL engines, and all `cce-1.0`-labelled events) therefore **still require a real engine key — a streaming dropped-GTID event always fails closed.**

---

## 6. Deterministic snapshot ordering (resolves F3/H2)

`order.ts:compareCce` currently returns `0` for snapshot rows (equal `commit_ts`, identical snapshot binlog coordinate, no GTID), so the chain order depends on arrival order. Rev 3 makes the global order a **deterministic total order** by appending a stable tie-break chain, terminating in the unique deterministic `envelope_id`:

```
ORDER BY
  transaction.commit_ts ASC,
  offset_monotonic ASC,                       // GTID seq / lsn / scn / binlog_pos
  completeness.snapshot_epoch_id ASC NULLS LAST,
  changes[0].object.schema ASC,
  changes[0].object.name ASC,
  rowKeyHash ASC,                             // canonical PK identity (§3)
  envelope_id ASC                             // FINAL total-order tie-break (unique, deterministic UUIDv5)
```

**Impact on `row_hash`/WORM sealing:** the chain `row_hash = H(prev_row_hash ‖ event_hash)` is built strictly in this total order, so the sealed baseline is **byte-reproducible** regardless of the order in which snapshot rows arrived or were reprocessed. **Existing streaming chains are unaffected**: streaming events already differ on `(commit_ts, gtid)`, so the new tie-break keys never engage for them, and the pinned golden vectors FX-001..005 do not change. This refines the §4.2 ordering by **specifying a previously-undefined tie-break** (ties were undefined, not defined-and-now-changed) — see §10.8 for the §13.3 assessment.

---

## 7. Capture-sourced timestamps (resolves F5)

For snapshot-phase events:

- **`ingest_ts`** MUST be set **at capture time** and carried on the `CapturedRecord` (the field `captured.ts:captured_at` already exists). Its contribution to the core MUST be deterministic across replay — i.e. for snapshot reads it is sourced from the connector event (`source.ts_ms` of the snapshot consistent point), **never** from `clock.now()` at build.
- **`commit_ts`** is **explicitly defined** for a snapshot read (which has no transaction commit) as the **source snapshot consistent-point timestamp** (`source.ts_ms`), identical for every row of the epoch. The Rev-2 fallback `commit_ts: group.commit_ts ?? group.ingest_ts` (`context.ts:86`) MUST NOT introduce a build-time clock on the snapshot path.
- **Invariant:** the `event_hash` core (`schema_version, envelope_id, kind, source, transaction, offset, fidelity, completeness, actor, changes`) contains **only capture-sourced values** for snapshot events. The build-time clock contributes to nothing inside the core.
- **Guarantee:** replay of byte-identical captured snapshot records reproduces a **byte-identical `event_hash`** (and therefore identical `envelope_id` and `row_hash` link). This is what makes the idle-DB edge (§2.2) resolve to a dedup DUPLICATE rather than a V15 violation.

---

## 8. Snapshot coverage attestation (resolves F6)

Add an **optional** coverage structure so an incomplete snapshot is **detectable** instead of silently partial. Honest by INV-2: unknown expected count ⇒ `UNKNOWN` (never `COMPLETE`).

```
completeness.snapshot_coverage = {
  epoch_id:        <snapshot_epoch_id>,
  table:           "<schema>.<name>",
  expected_rows:   <integer | null>,     // read-only count/estimate at snapshot start; null ⇒ UNKNOWN
  expected_is_estimate: <boolean>,       // true if from information_schema statistics
  emitted_rows:    <integer>,            // rows emitted for this table this epoch
  status:          "in_progress" | "complete" | "interrupted" | "incomplete"
}
```

Derived **table-level** rule:
- `complete` ⇒ `emitted_rows == expected_rows` (or `expected_is_estimate` with a reconciliation note).
- `emitted_rows < expected_rows` at handoff ⇒ `incomplete`.
- snapshot aborted before handoff ⇒ `interrupted`.
- `expected_rows == null` ⇒ coverage `UNKNOWN`.

Surfacing in completeness metadata / fidelity:
- An epoch whose any table is `incomplete`/`interrupted`/`UNKNOWN` MUST drive **`fidelity.state = DEGRADED`** with a `degraded_reason` (INV-2 — never HEALTHY under unconfirmed baseline coverage).
- A handoff manifest (§9) records per-table `expected/emitted/status` for the epoch, so the WORM chain self-describes baseline completeness.

This makes "the snapshot silently skipped rows" a **first-class, attestable** condition (new rule V18, §11).

---

## 9. WORM baseline supersession semantics (resolves F7)

WORM is append-only (INV-3): epochs are **never** deleted or rewritten. Supersession is a **read-model** concept layered over the immutable log, never a mutation.

**Epoch manifest (emitted once per epoch, at `handoff`):**
```
kind: "snapshot_epoch_manifest"  (companion record; not a change CCE)
{
  epoch_id:        <snapshot_epoch_id>,
  db_id, server_uuid,
  snapshot_start_watermark: { binlog_file, binlog_pos },
  handoff_gtid:    <first streaming GTID after the snapshot>,
  tables:          [ { table, expected_rows, emitted_rows, status } ... ],
  supersedes:      <prior epoch_id | null>      // the previous baseline this one replaces
}
```

**Auditor distinctions:**

| Concept | How it is determined (read-model, from immutable data) |
|---|---|
| **Baseline epoch 1 / epoch 2** | distinct `snapshot_epoch_id`; ordered by `snapshot_start_watermark` (then `handoff_gtid`) |
| **Current baseline** | the epoch with the greatest `snapshot_start_watermark` whose `handoff_gtid` connects to the live stream (the projection maintains a `current_epoch` pointer) |
| **Historical baseline** | any epoch that is not current |
| **Superseded baseline** | a historical epoch named by a later manifest's `supersedes` (or any epoch with a strictly smaller watermark than `current_epoch`) |

The projection/dashboard reads `current_epoch`; WORM retains **all** epochs immutably for audit. No baseline is ever overwritten; "current vs superseded" is always derivable and reversible.

---

## 10. Re-evaluation

| Dimension | Rev 3 status | Why |
|---|---|---|
| **10.1 Determinism** | **Sound** | Snapshot `event_hash` uses only capture-sourced values (§7); the chain uses a total order ending in `envelope_id` (§6) ⇒ byte-reproducible seal cross-architecture and cross-replay. |
| **10.2 Replay idempotency** | **Correct** | Byte-identical captured snapshot ⇒ identical `envelope_id` + `event_hash` ⇒ dedup DUPLICATE-skip. Genuine re-snapshot ⇒ distinct `snapshot_epoch_id` (or distinct content) ⇒ distinct baseline. |
| **10.3 V15 behavior** | **Preserved (no false positives, no exemption)** | The "same `envelope_id`, different `event_hash`" trap is structurally unreachable for legitimate snapshots (§2.2, §7). V15 stays fully active for true integrity violations; **no V15 exemption** is introduced. |
| **10.4 Completeness** | **Strengthened** | Streaming dropped-GTID events fail closed (§5); snapshot coverage is attestable (§8); snapshot offsets excluded from GTID-gap analysis; continuity resumes at handoff GTID. |
| **10.5 Fidelity** | **Tightened** | Unconfirmed/incomplete baseline coverage ⇒ DEGRADED (§8); HEALTHY requires confirmed coverage (INV-2). |
| **10.6 WORM evidence** | **Defined** | Append-only retained; epoch manifest + projection pointer give current/historical/superseded semantics without mutation (§9). |
| **10.7 Compatibility** | **Backward-compatible** | New fields are optional or required **only** in the new snapshot phase; no existing `cce-1.0` event is invalidated; no existing hash recomputed (INV-3). The positive guard only constrains binlog-only offsets, which were **never** valid under `cce-1.0`. |
| **10.8 Migration** | **No data migration** | Sprint-1 persists no CCEs. Going forward, `cce-1.0` events remain valid and are never rewritten. **Owner confirmation required** that the §6 ordering tie-break is a **clarification of previously-undefined ties** (additive) and not a §13.3 reordering — existing fully-ordered sequences are provably unchanged, supporting MINOR. |

**MINOR re-confirmation (§13 checklist):** does not change canonical serialization/hashing (§13.1), `envelope_id` derivation for existing events (§13.2), or the **defined** global order (§13.3 — only undefined ties are now defined); does not remove/rename/retype a required field (§13.4 — additions only) or change before/after nullity (§13.5); does not change the chain construction (§13.7), repurpose an enum (§13.8), fabricate a value from an honest unknown (§13.9 — coverage unknown ⇒ DEGRADED, honest), or change decimals (§13.10). **Additive MINOR** — larger than Rev 2 but within the MINOR envelope, pending the §10.8 owner confirmation.

---

## 11. Exact Proposed Contract Additions

Target: `CCE-v1-Specification.md` Appendix B + §4.2/§6.5/§6.6/§10; vendored schema re-issued as `cce-1.1.schema.json`. **All additive; `additionalProperties:false` preserved by naming each new property.**

### 11.1 New fields

| Path | Type | Required? | Notes |
|---|---|---|---|
| `completeness.snapshot_epoch_id` | `string, minLength 1` | **Conditionally required** — required iff `snapshot_phase ∈ {snapshot,handoff}`; absent otherwise | §1–§2 |
| `completeness.snapshot_coverage` | `object` (see §8) | optional | per-table coverage; presence expected during snapshot/handoff |
| `completeness.snapshot_coverage.status` | enum `in_progress\|complete\|interrupted\|incomplete` | required within the object | §8 |
| `offset` (binlog branch) | existing `binlog_file`/`binlog_pos` | — | one additive `anyOf` branch (Rev-1 §5), now gated by V16 |
| companion `snapshot_epoch_manifest` | new companion record kind | optional companion | §9; not a change CCE |

`source.server_uuid` and `transaction.tx_id` types are **unchanged** (server_uuid acquired read-only = Rev-1 prereq A; tx_id is the §3 string).

### 11.2 JSON Schema direction

1. Add the fifth `offset.anyOf` branch (`binlog_file`+`binlog_pos`).
2. Add the **positive guard** `if/then` (§5) to the top-level `allOf`.
3. Add a top-level `if/then`: `snapshot_phase ∈ {snapshot,handoff} ⇒ require completeness.snapshot_epoch_id (non-empty)`.
4. Add `completeness.snapshot_epoch_id` and `completeness.snapshot_coverage` to `completeness.properties` (keeps `additionalProperties:false` valid).
5. No change to `offset.properties`, `offset.additionalProperties:false`, `schema_version` pattern, hashing, or chain fields.

### 11.3 Validation rules

| Rule | Statement | Enforcement |
|---|---|---|
| **V11 (restated)** | offset has a real engine key, **or** a binlog-only offset satisfying V16 | schema `anyOf` + V16 |
| **V16 (new)** | binlog-only offset ⇒ `schema_version=cce-1.1` ∧ `engine ∈ {mysql,mariadb}` ∧ `snapshot_phase ∈ {snapshot,handoff}` | schema `if/then` (§5); classified `/offset → V11/V16` |
| **V17 (new)** | `snapshot_phase ∈ {snapshot,handoff}` ⇒ `snapshot_epoch_id` present & non-empty; `tx_id == "snapshot:"+epoch+":"+rowKeyHash`; `consumed_offset_key == "snapshot-epoch:"+epoch` | schema (presence) + stateful (form) |
| **V18 (new)** | coverage honesty: an epoch with any table `incomplete\|interrupted` or `expected_rows=null` ⇒ `fidelity.state ≠ HEALTHY` | stateful |
| **Ordering (refined §4.2)** | global order is a **total** order ending in `envelope_id` (§6) | comparator + a chain-determinism conformance check |

### 11.4 Conformance tests — see §12.

---

## 12. New Conformance Tests (minimum set)

### 12.1 `C-SNAP-EPOCH-NEWRUN` — re-snapshot with a new epoch must **not** trigger V15
Two snapshots of the same row at different watermarks ⇒ different `snapshot_epoch_id` ⇒ different `envelope_id` ⇒ two distinct baselines, **no V15**.

### 12.2 `C-SNAP-REPLAY-IDENTICAL` — replay of the same epoch is byte-identical
Re-feed byte-identical captured snapshot records ⇒ identical `envelope_id`, `event_hash`, `row_hash` ⇒ dedup DUPLICATE; **byte-for-byte** equality asserted.

### 12.3 `C-STREAM-NOGTID-FAIL` — dropped-GTID streaming event must fail
mysql, `gtid=null`, binlog present, `snapshot_phase=streaming` **and** `snapshot_phase` absent ⇒ **both reject** (V16) → DLQ.

### 12.4 `C-NONMYSQL-BINLOG-FAIL` — non-MySQL binlog offset must fail
postgres with binlog fields stuffed, no LSN ⇒ **reject** (V16/engine).

### 12.5 `C-SNAP-CHAIN-ORDER` — deterministic chain order
N snapshot rows with identical `commit_ts` + coordinate, fed in two different arrival orders ⇒ identical ordered sequence and identical sealed `head_hash` (§6).

### 12.6 `C-SNAP-COVERAGE` — incomplete snapshot is detectable
`emitted_rows < expected_rows` at handoff ⇒ `status=incomplete` ∧ `fidelity=DEGRADED` (V18).

### 12.7 `C-TXID-NOCOLLISION` — `tx_id` collision is impossible
Adversarial PKs containing `:` and tuples that would alias under naive joining ⇒ distinct `rowKeyHash` ⇒ distinct `tx_id`/`envelope_id` (§3).

### 12.8 (regression) `C-1.0-BINLOG-FAIL` — `cce-1.0`-labelled binlog-only offset must fail (V16/version); existing FX-001..005 streaming vectors **unchanged**; a new **snapshot golden vector** + **multi-row snapshot chain** vector pinned cross-architecture.

---

## 13. Final Decision

> ## APPROVE WITH CHANGES
> Ratify the **design** of CCE-AMD-001 Rev 3 as `cce-1.1` (additive MINOR), subject to the prerequisites below. The contract additions are sound, machine-enforceable, and capture-deterministic; every blocking Rev-2 finding (F1–F7, and M1/M2) is closed at the contract level with no V15 exemption and no invalidation of existing events.

**Conditions of approval (must complete before snapshot-capture coding begins):**

1. **Owner confirmation (§10.8):** ratify that the §6 ordering tie-break is an additive clarification of previously-undefined ties (not a §13.3 reordering). If the owner deems it §13.3, re-scope ordering to MAJOR while keeping the rest MINOR.
2. **Implement `snapshot_epoch_id` per §2(a)** (watermark, content-addressed); verify the low-watermark is constant per run for the target Debezium connector config, else adopt the §2.3 registry fallback.
3. **Implement the positive guard V16 (§5)** verbatim; verify ajv classifies `/offset` failures and that tests §12.3–§12.4 reject.
4. **Implement capture-sourced `ingest_ts`/`commit_ts` (§7)** on the snapshot path; prove no build-time clock enters the core (test §12.2).
5. **Implement the §6 total-order tie-break**; pin the multi-row snapshot chain golden vector (test §12.5).
6. **Implement `tx_id` canonical-tuple hashing (§3)** (test §12.7) and the §4 `consumed_offset_key`.
7. **Implement coverage attestation (§8)** + the epoch manifest (§9); wire V18 to fidelity (test §12.6).
8. **Add all §12 conformance tests** to the suite and the two-target determinism rig; re-run live validation to confirm snapshot reads produce valid CCEs and a re-snapshot raises **no** false V15.

Upon ratification (condition 1) and completion of conditions 2–8, **D-LIVE-1 is CLOSED** and Sprint-2 may implement snapshot-phase capture as its first deliverable. No WORM/evidence work may treat the baseline as captured until conditions 2–8 land. The streaming pipeline is unaffected and remains GO.

---

*Amendment proposal, Revision 3. No schema, contract, or code modified. Ratification + the §13 conditions are required before application.*
