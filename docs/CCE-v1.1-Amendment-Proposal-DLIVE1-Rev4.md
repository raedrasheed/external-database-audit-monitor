# CCE Contract Amendment Proposal — `cce-1.1` (D-LIVE-1) — **Revision 4 (FINAL)**
### Snapshot-phase capture for MySQL/MariaDB — ratification-ready

| Field | Value |
|---|---|
| **Amendment ID** | CCE-AMD-001 (D-LIVE-1) |
| **Revision** | **Rev 4 — FINAL** (supersedes Rev 1/2/3; all retained as history) |
| **Target contract** | `CCE-v1-Specification.md` (`cce-1.0`) + `EDAM-Companion-Contracts.md` |
| **Proposed version** | `cce-1.1` |
| **Classification** | **MINOR** — additive; new fields optional/conditionally-required; no existing valid event invalidated; no rehash |
| **Status** | **Proposed — ratification-ready** (no schema/code modified) |
| **Authoritative input** | Formal contract-owner ratification report of Rev 3 (rulings + HIGH-1, HIGH-2, MED-1, MED-2; §6 ordering ruling) |
| **Author role** | Contract amendment / verification |

> Proposal only. No schema, contract text, or code has been modified. Ratification by the contract owner is required before any change is applied.

---

## 0. What Changed in Revision 4

Rev 3 was **APPROVED WITH CHANGES**; D-LIVE-1 **remained OPEN** pending two blocking High findings and two Medium clarifications. Rev 4 closes all four and carries forward every prior ruling unchanged.

| Finding (Rev-3 owner report) | Rev-4 resolution | § |
|---|---|---|
| **HIGH-1** — V16 bypassable via empty-string real offset key (real-key `anyOf` branches lack `minLength`) | Add `minLength:1` to `gtid`/`lsn`/`scn`/`resume_token` branches **and** a stateful non-empty assertion; empty keys can no longer match a real-key branch, so V16's preconditions always engage | §1 |
| **HIGH-2** — idle-DB re-snapshot at identical watermark ⇒ same `envelope_id`, different `event_hash` ⇒ false V15 | Fold a **capture-sourced** snapshot-start timestamp (`source.ts_ms`) into `snapshot_epoch_id`; distinct runs ⇒ distinct epoch even at an identical binlog coordinate | §2 |
| **MED-1** — `snapshot_epoch_manifest` is not a CCE | Define it formally as a **companion record** in `EDAM-Companion-Contracts.md`; explicitly **out** of the CCE change-event schema | §3 |
| **MED-2** — V18 must compose with the existing `state≠HEALTHY ⇒ degraded_reason` rule | Define V18 precisely and show it composes with the fidelity `allOf` (it only *forces* a non-HEALTHY state, after which the existing rule supplies `degraded_reason`) | §4 |
| §6 ordering ruling | Reconfirmed: tie-break keys are **strictly subordinate** to §4.2 keys ⇒ **MINOR clarification, not §13.3** | §5 |

Carried forward from Rev 3 unchanged: `snapshot_epoch_id` concept (§2), the single positive offset guard **V16** (§1.3), canonical-tuple `tx_id` (collision-free), `consumed_offset_key = "snapshot-epoch:" + epoch`, capture-sourced `ingest_ts`/`commit_ts`, snapshot coverage attestation, and the deterministic total-order tie-break.

---

## 1. HIGH-1 — Non-bypassable Real Offset Keys

**Defect (verified):** the four real-key `anyOf` branches are `{ "required": ["gtid"], "properties": { "gtid": { "type": "string" } } }` with **no `minLength`**, so `offset.gtid = ""` matches the real-key branch. V16's `if` ("offset matches none of the four real keys") then evaluates **false**, V16 is skipped, and a streaming event validates **without a genuine GTID** — defeating V16's purpose.

### 1.1 Schema change (additive tightening of an existing branch)

**Before (`cce-1.0`):**
```json
"anyOf": [
  { "required": ["gtid"],         "properties": { "gtid":         { "type": "string" } } },
  { "required": ["lsn"],          "properties": { "lsn":          { "type": "string" } } },
  { "required": ["scn"],          "properties": { "scn":          { "type": "string" } } },
  { "required": ["resume_token"], "properties": { "resume_token": { "type": "string" } } }
]
```

**After (`cce-1.1`):**
```json
"anyOf": [
  { "required": ["gtid"],         "properties": { "gtid":         { "type": "string", "minLength": 1 } } },
  { "required": ["lsn"],          "properties": { "lsn":          { "type": "string", "minLength": 1 } } },
  { "required": ["scn"],          "properties": { "scn":          { "type": "string", "minLength": 1 } } },
  { "required": ["resume_token"], "properties": { "resume_token": { "type": "string", "minLength": 1 } } },
  { "required": ["binlog_file", "binlog_pos"],
    "properties": { "binlog_file": { "type": "string", "minLength": 1 },
                    "binlog_pos":  { "type": "integer", "minimum": 0 } } }
]
```

> **Backward-compatibility note (MINOR preserved):** adding `minLength:1` *tightens* the real-key branches. Any real, honest engine key (a GTID, LSN, SCN, resume token) is a non-empty string, so **no legitimate `cce-1.0` event is invalidated** — only the empty-string degenerate case (which was never a valid offset in intent, and which V11's text already called "non-null") is now rejected by schema as well as by intent. The pinned golden vectors FX-001..005 carry non-empty GTIDs and are unaffected.

### 1.2 Stateful reinforcement (defense in depth)

**V11 (restated):** *At least one real `offset` engine key (`gtid`/`lsn`/`scn`/`resume_token`) is present and a **non-empty** string; or a binlog-only offset satisfying V16. Empty-string keys are not honored.* The stateful validator asserts non-empty independently of the schema, so the guarantee survives any future schema re-vendor error.

### 1.3 V16 (carried forward, now non-bypassable)

The positive guard is unchanged from Rev 3 §5; with §1.1 in place its `if` correctly fires for every offset lacking a non-empty real key:

```json
{ "if": { "properties": { "offset": { "not": { "anyOf": [
      { "required": ["gtid"],         "properties": { "gtid":         { "type": "string", "minLength": 1 } } },
      { "required": ["lsn"],          "properties": { "lsn":          { "type": "string", "minLength": 1 } } },
      { "required": ["scn"],          "properties": { "scn":          { "type": "string", "minLength": 1 } } },
      { "required": ["resume_token"], "properties": { "resume_token": { "type": "string", "minLength": 1 } } } ] } } } },
  "then": { "allOf": [
      { "properties": { "schema_version": { "const": "cce-1.1" } }, "required": ["schema_version"] },
      { "properties": { "source": { "properties": { "engine": { "enum": ["mysql","mariadb"] } }, "required": ["engine"] } }, "required": ["source"] },
      { "properties": { "completeness": { "properties": { "snapshot_phase": { "enum": ["snapshot","handoff"] } }, "required": ["snapshot_phase"] } }, "required": ["completeness"] },
      { "properties": { "offset": { "required": ["binlog_file","binlog_pos"],
          "properties": { "binlog_file": { "type": "string", "minLength": 1 }, "binlog_pos": { "type": "integer", "minimum": 0 } } } } } ] } }
```

**Bypass table (post-fix):**

| Attempt | Outcome |
|---|---|
| `gtid = ""` (empty) | real-key branch no longer matches ⇒ `if` true ⇒ V16 requires snapshot phase etc. ⇒ a streaming event **fails** → DLQ |
| empty `lsn`/`scn`/`resume_token` | identical — empty key does not match its branch ⇒ V16 engages ⇒ **fails** unless a legitimate mysql/mariadb `cce-1.1` snapshot |
| streaming, `gtid=null`, binlog present, phase absent | `if` true; V16 requires `snapshot_phase ∈ {snapshot,handoff}` ⇒ **fails** |
| postgres, binlog stuffed | V16 engine clause ⇒ **fails** |
| `cce-1.0` label, binlog-only | V16 version clause ⇒ **fails** |
| mysql `cce-1.1` snapshot, binlog, phase=snapshot | all clauses hold ⇒ **valid** |

**HIGH-1 resolved:** there is no empty-string escape; V16 is non-bypassable across all enumerated vectors.

### 1.4 Conformance tests (HIGH-1)

- `C-OFFSET-EMPTY-GTID` — `gtid:""` ⇒ **reject** (schema `minLength` + V11), cannot reach the gtid branch, cannot bypass V16.
- `C-OFFSET-EMPTY-LSN` / `C-OFFSET-EMPTY-SCN` / `C-OFFSET-EMPTY-RESUME` — each empty real key ⇒ **reject**.
- `C-STREAM-EMPTY-GTID-NO-BYPASS` — streaming mysql with `gtid:""` + binlog present ⇒ **reject → DLQ** (proves no V16 bypass).
- Regression: FX-001..005 (non-empty GTIDs) still **valid**.

---

## 2. HIGH-2 — Time-Augmented `snapshot_epoch_id`

**Defect (verified by case analysis):** with `snapshot_epoch_id` derived from the binlog watermark alone, an **idle-DB re-snapshot** shares the same coordinate but carries a different `source.ts_ms`; since `commit_ts = source.ts_ms` is in the hashed core, the result is **same `envelope_id`, different `event_hash` ⇒ false V15**.

### 2.1 Updated derivation

```
snapshot_epoch_id = "snap-" + sha256Hex( serializeCanonical({
    db_id:                      <source.db_id>,
    server_uuid:                <source.server_uuid>,           // read-only acquisition (prereq A)
    snapshot_start_binlog_file: <low-watermark file @ snapshot=first>,
    snapshot_start_binlog_pos:  <low-watermark pos  @ snapshot=first>,
    snapshot_start_ts_ms:       <source.ts_ms of the snapshot consistent point>  // capture-sourced
}) ).slice(0, 16)
```

### 2.2 Requirement compliance

| Requirement | Compliance |
|---|---|
| timestamp **capture-sourced** | `snapshot_start_ts_ms = source.ts_ms` from the Debezium snapshot record — part of the captured payload, stamped at the `snapshot=first` marker and held constant for the run |
| **not** build-time | `clock.now()` is never an input; build-time clock contributes to nothing in the epoch |
| **not** attestation `sampled_at` | the attestation fingerprint (`config_snapshot_id`) is excluded entirely; the input is the *source* snapshot timestamp, a different and capture-sourced value |
| replay ⇒ identical `snapshot_epoch_id` | all inputs are captured bytes; re-feeding identical records reproduces the identical id |
| idle-DB re-snapshot (same coordinate, different snapshot time) ⇒ **different** id | `snapshot_start_ts_ms` differs ⇒ digest differs ⇒ different epoch ⇒ different `tx_id` ⇒ **different `envelope_id`** ⇒ distinct baseline, **no false V15** |

### 2.3 Consistency proof (closes the Rev-3 fourth case)

| Case | `envelope_id` | `event_hash` | Outcome |
|---|---|---|---|
| Replay, identical bytes | identical | identical | **DUPLICATE-skip** (dedup) |
| Re-snapshot, content changed | differs (`rowKeyHash`) | differs | distinct baseline |
| Re-snapshot, watermark advanced | differs (epoch) | differs | distinct baseline |
| **Re-snapshot, idle DB, same coordinate, different time** | **differs (epoch: `ts_ms`)** | differs | **distinct baseline — no V15** |

There is now **no combination** in which a legitimate snapshot yields "same `envelope_id`, different `event_hash`." V15 stays fully active for genuine integrity violations; **no V15 exemption** is introduced. **HIGH-2 resolved.**

### 2.4 Conformance tests (HIGH-2)

- `C-SNAP-EPOCH-IDLE-RERUN` — two snapshots, identical binlog coordinate, **different** `snapshot_start_ts_ms` ⇒ **different** `snapshot_epoch_id`/`envelope_id`; **no V15**.
- `C-SNAP-REPLAY-IDENTICAL` — byte-identical captured snapshot ⇒ identical `snapshot_epoch_id`, `envelope_id`, `event_hash` ⇒ DUPLICATE-skip (byte-for-byte equality asserted).
- `C-SNAP-EPOCH-NEWRUN` — advanced watermark ⇒ distinct epoch, no V15.

---

## 3. MED-1 — `snapshot_epoch_manifest` as a Companion Record

**Ruling applied:** the manifest's `kind` is **not** `"transaction"`, so it is **not** a CCE and MUST NOT be validated by the CCE change-event schema. It is defined as a **companion contract record**.

### 3.1 Location

> **Belongs in `EDAM-Companion-Contracts.md`** as a new companion record type. **Explicitly excluded** from `CCE-v1-Specification.md` Appendix B (the CCE change-event schema) and from `packages/contracts/src/schemas/cce-1.1.schema.json`. It is sealed into the WORM chain as a companion artifact, not as a change event.

### 3.2 Record definition

```
snapshot_epoch_manifest (companion record)
{
  kind:           "snapshot_epoch_manifest",          // distinct from CCE kind "transaction"
  schema_version: "edam-companion-1.0",                // companion contract versioning (NOT cce-*)
  epoch_id:       "<snapshot_epoch_id>",               // = §2 derivation
  db_id:          "<source.db_id>",
  server_uuid:    "<source.server_uuid>",
  snapshot_start_watermark: { binlog_file: "<string>", binlog_pos: <integer ≥ 0> },
  snapshot_start_ts:        "<RFC3339; from source.ts_ms of the snapshot consistent point>",
  handoff_gtid:   "<first streaming GTID after the snapshot | null until handoff>",
  tables: [ { table: "<schema>.<name>", expected_rows: <int|null>, expected_is_estimate: <bool>,
              emitted_rows: <int>, status: "in_progress"|"complete"|"interrupted"|"incomplete" } ],
  supersedes:     "<prior epoch_id | null>",
  evidence: { manifest_hash: "sha256:<hex>",           // H(canonical manifest core minus evidence)
              prev_row_hash: "sha256:<hex>|null",
              row_hash:      "sha256:<hex>" }           // chains into the same WORM hash chain
}
```

### 3.3 Properties

- **Versioning** uses the companion namespace (`edam-companion-1.0`), independent of `cce-*`, so the CCE major-version gate and the CCE schema never apply to it.
- **Evidence linkage:** the manifest carries its own `event_hash`-equivalent (`manifest_hash`) and chains via `row_hash` into the **same** WORM hash chain as CCEs, so an auditor can verify the epoch boundary is tamper-evident and ordered relative to the change events (emitted at `handoff`, ordered by the §5 total order with companion records sorted by `snapshot_start_ts`/`epoch_id`).
- **Emission:** exactly one manifest per epoch, at handoff (`snapshot=last` → first streaming GTID). It is the authoritative source of the §6 (Rev-3 §9) supersession read-model.

**MED-1 resolved:** the manifest is a ratified companion record with a defined home, kind, versioning, and evidence linkage — never a CCE.

---

## 4. MED-2 — V18 Precise Definition & Composition

**Goal:** make snapshot coverage honesty (INV-2) a hard rule that **composes** with the existing fidelity schema, which already requires `degraded_reason` whenever the state is not HEALTHY:

```json
"allOf": [ { "if": { "properties": { "state": { "not": { "const": "HEALTHY" } } } },
            "then": { "required": ["degraded_reason"] } } ]
```

### 4.1 V18 (new stateful rule)

> **V18 (snapshot coverage honesty).** For any CCE in `snapshot_phase ∈ {snapshot,handoff}` whose associated coverage `status ∈ {incomplete, interrupted}` **or** whose coverage is `unknown` (`expected_rows = null`):
> 1. `fidelity.state` **MUST NOT** be `HEALTHY` (it MUST be `DEGRADED`, or `COMPROMISED` if capture loss is confirmed), and
> 2. `fidelity.degraded_reason` MUST be **present and non-empty**, citing the coverage condition (e.g. `"snapshot coverage incomplete: donations 990/1000"`).

### 4.2 Composition with the existing rule (no conflict)

V18 and the existing `allOf` are **complementary, not competing**:
- **V18 clause 1** *forces* the state away from HEALTHY (a precondition V18 owns).
- Once the state is non-HEALTHY, the **existing schema `allOf`** already *requires* `degraded_reason` — V18 clause 2 strengthens that to **non-empty** and content-bearing (the schema requires presence; V18 adds non-emptiness + semantic citation, enforced statefully).
- No rule is removed or relaxed; V18 only *narrows the admissible state* under an additional condition the schema cannot express (coverage status lives in `completeness.snapshot_coverage`, a cross-object relationship). Schema enforces structure; V18 enforces the cross-field honesty invariant. They are jointly satisfiable and never contradictory.

### 4.3 Conformance tests (MED-2)

- `C-SNAP-COVERAGE-INCOMPLETE` — `emitted < expected` at handoff ⇒ `status=incomplete` ∧ `state=DEGRADED` ∧ non-empty `degraded_reason` (else V18 fails).
- `C-SNAP-COVERAGE-UNKNOWN` — `expected_rows=null` ⇒ `state≠HEALTHY` (never fabricate HEALTHY).
- `C-SNAP-COVERAGE-HEALTHY` — `status=complete` ∧ `emitted==expected` ⇒ `HEALTHY` permitted, `degraded_reason` absent (existing rule satisfied).

**MED-2 resolved:** V18 is precise and provably composes with the existing fidelity schema rule.

---

## 5. §6 Ordering — Reconfirmation (MINOR, not §13.3)

**Reconfirmed per the owner ruling.** The global order is:

```
ORDER BY
  transaction.commit_ts ASC,                  -- §4.2 key 1 (unchanged)
  offset_monotonic ASC,                        -- §4.2 key 2 (unchanged)
  -- the following keys are STRICTLY SUBORDINATE tie-breaks, engaged only when the §4.2 keys are equal:
  completeness.snapshot_epoch_id ASC NULLS LAST,
  changes[0].object.schema ASC,
  changes[0].object.name ASC,
  rowKeyHash ASC,
  envelope_id ASC                              -- final, total-order tie-break (unique deterministic UUIDv5)
```

- The new keys are **appended below** the existing §4.2 keys and engage **only** when `commit_ts` *and* the monotonic offset key are equal. For any pair §4.2 already ordered (distinct `commit_ts` or distinct offset key), the tie-break keys are never reached, so **no previously-defined order changes** (verified: `compareCce` for distinct GTID transactions never returns 0; FX-001..005 order is byte-identical before/after).
- §13.3 is triggered only by **changing a defined** global order; specifying previously-**undefined** ties is an additive clarification.

> **RULING (reconfirmed): the §6 ordering change is a MINOR clarification of previously-undefined ties. It does NOT trigger §13.3.** Binding condition (satisfied by the wording above): the new keys are documented as strictly subordinate/append-only to §4.2's keys.

Impact on WORM: the chain `row_hash = H(prev_row_hash ‖ event_hash)` is built in this total order ⇒ **byte-reproducible seal** across reprocessing/architecture; existing streaming chains unaffected.

---

## 6. Exact Contract Additions (consolidated)

Target: `CCE-v1-Specification.md` Appendix B + §4.2/§6.5/§6.6/§10; vendored schema re-issued as `cce-1.1.schema.json`; **and** `EDAM-Companion-Contracts.md` (manifest). All additive; `additionalProperties:false` preserved by naming each new property.

| # | Addition | Required? | Rule |
|---|---|---|---|
| 1 | `minLength:1` on `gtid`/`lsn`/`scn`/`resume_token` real-key branches | — (tightening) | V11 |
| 2 | fifth `offset.anyOf` branch (`binlog_file`+`binlog_pos`) | — | V11/V16 |
| 3 | positive guard `if/then` (§1.3) | — | **V16** |
| 4 | `completeness.snapshot_epoch_id` (`string,minLength 1`) | **required iff `snapshot_phase ∈ {snapshot,handoff}`** | **V17** |
| 5 | `completeness.snapshot_coverage` (object; per-table `expected/emitted/status`) | optional | **V18** |
| 6 | top-level `if/then`: snapshot phase ⇒ require `snapshot_epoch_id`; `tx_id`/`consumed_offset_key` forms | — | V17 |
| 7 | total-order tie-break ending in `envelope_id` (§5) | — | §4.2 (refined) |
| 8 | `snapshot_epoch_manifest` companion record | — | `EDAM-Companion-Contracts.md` (not CCE) |

`source.server_uuid` and `transaction.tx_id` **types unchanged** (server_uuid acquired read-only; `tx_id` = `"snapshot:" + epoch + ":" + rowKeyHash`, `rowKeyHash = sha256(serializeCanonical({schema,name,primary_key}))`).

---

## 7. Full Conformance Set (minimum)

| Test | Asserts |
|---|---|
| `C-OFFSET-EMPTY-{GTID,LSN,SCN,RESUME}` | empty real key ⇒ reject (HIGH-1) |
| `C-STREAM-EMPTY-GTID-NO-BYPASS` | streaming `gtid:""`+binlog ⇒ reject → DLQ (HIGH-1) |
| `C-STREAM-NOGTID-FAIL` | streaming `gtid=null` (phase=streaming **and** absent) ⇒ reject (V16) |
| `C-NONMYSQL-BINLOG-FAIL` | non-MySQL binlog offset ⇒ reject (V16) |
| `C-1.0-BINLOG-FAIL` | `cce-1.0`-labelled binlog-only ⇒ reject (V16) |
| `C-SNAP-EPOCH-IDLE-RERUN` | idle-DB re-snapshot, same coord, diff `ts_ms` ⇒ distinct epoch, **no V15** (HIGH-2) |
| `C-SNAP-EPOCH-NEWRUN` | advanced watermark ⇒ distinct epoch, no V15 |
| `C-SNAP-REPLAY-IDENTICAL` | byte-identical replay ⇒ identical id/hash ⇒ DUPLICATE |
| `C-SNAP-CHAIN-ORDER` | identical `commit_ts`+coord, two arrival orders ⇒ identical sealed `head_hash` (§5) |
| `C-TXID-NOCOLLISION` | adversarial PKs with `:` ⇒ distinct `tx_id`/`envelope_id` |
| `C-SNAP-COVERAGE-{INCOMPLETE,UNKNOWN,HEALTHY}` | coverage honesty + composition (V18, MED-2) |
| Regression FX-001..005 | unchanged, valid, identical order/hashes |

Plus a pinned **snapshot golden vector** and a **multi-row snapshot chain** vector on the two-target determinism rig.

---

## 8. Final Re-evaluation (all dimensions)

| Dimension | Status |
|---|---|
| Determinism | **Sound** — snapshot core fully capture-sourced; total-order seal reproducible |
| Replay idempotency | **Correct** — identical bytes ⇒ DUPLICATE; genuine re-run ⇒ distinct epoch |
| V15 | **No false positives, no exemption** — "same id/different hash" path eliminated (§2.3) |
| Completeness | **Strengthened** — streaming GTID mandatory (non-bypassable); coverage attestable |
| Fidelity | **Honest** — incomplete/unknown coverage ⇒ non-HEALTHY + reason (V18) |
| WORM evidence | **Defined** — append-only; companion manifest + supersession read-model |
| Compatibility | **Backward-compatible** — additive; FX-001..005 unaffected; `minLength` rejects only the degenerate empty key |
| Migration | **None** — no persisted CCEs; existing events never rewritten (INV-3) |
| Multi-engine | **Fenced** — V16 engine clause; companion namespace isolates the manifest |

**MINOR re-confirmed (§13 checklist):** no change to serialization/hashing (§13.1), `envelope_id` derivation for existing events (§13.2), or the *defined* global order (§13.3 — only undefined ties now defined, §5); no required-field removal/retype (§13.4 — additions only); no nullity change (§13.5); no chain change (§13.7); no enum repurpose (§13.8); no honest-unknown→fabrication (§13.9 — unknown coverage ⇒ DEGRADED); no decimal change (§13.10). The `minLength:1` tightening rejects only the empty-string degenerate, which was never a valid honest offset. **Additive MINOR.**

---

## 9. Final Decision

> ## APPROVE

All blocking findings are resolved. **No Critical and no High findings remain.** HIGH-1 (empty-key bypass) is closed by `minLength:1` + stateful V11; HIGH-2 (idle-DB false V15) is closed by the time-augmented `snapshot_epoch_id` with a complete consistency proof (§2.3); MED-1 (manifest) is ratified as a companion record in `EDAM-Companion-Contracts.md`, explicitly outside the CCE schema; MED-2 (V18) is precisely defined and shown to compose with the existing fidelity `allOf`; and the §5 ordering tie-break is reconfirmed as a MINOR clarification (strictly subordinate to §4.2), not a §13.3 change.

> ## D-LIVE-1 CLOSED — upon publication

D-LIVE-1 is resolved by ratification of CCE-AMD-001 Rev 4 as `cce-1.1`. It is **CLOSED** the moment the contract owner publishes `cce-1.1` (the schema additions §6 items 1–7 + the companion manifest §3) and the §7 conformance set is green on the two-target rig. These are now **implementation/publication steps, not design decisions** — there is no remaining ambiguity or open design question.

### Implementation prerequisites before Sprint-2 snapshot coding (mechanical, non-blocking for ratification)

1. Publish `cce-1.1.schema.json` with §6 items 1–7 (verbatim) and the §5 ordering wording (tie-break keys documented as strictly subordinate/append-only).
2. Publish the `snapshot_epoch_manifest` companion record in `EDAM-Companion-Contracts.md` (§3).
3. Implement: time-augmented `snapshot_epoch_id` (§2.1), canonical-tuple `tx_id`, `consumed_offset_key`, capture-sourced `ingest_ts`/`commit_ts`, the `order.ts` total-order tie-break, and V16/V17/V18.
4. Land the full §7 conformance set + snapshot golden vector + multi-row chain vector on the determinism rig; re-run live validation confirming valid snapshot CCEs and **no** false V15 (including the idle-DB case).

The streaming pipeline is unaffected and remains **GO**. On completion of items 1–4, Sprint-2 snapshot-phase capture proceeds as its first deliverable.

---

*Amendment proposal, Revision 4 (FINAL). No schema, contract, or code modified. Ratification publishes `cce-1.1`; the prerequisites above are mechanical implementation/publication steps.*
