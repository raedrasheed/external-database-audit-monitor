# CCE Contract Amendment Proposal — `cce-1.1` (D-LIVE-1) — **Revision 2**
### Snapshot-phase offset for MySQL/MariaDB

| Field | Value |
|---|---|
| **Amendment ID** | CCE-AMD-001 (D-LIVE-1) |
| **Revision** | **Rev 2** (supersedes Rev 1; Rev 1 retained as history) |
| **Target contract** | `CCE-v1-Specification.md` (currently `cce-1.0`) |
| **Proposed version** | `cce-1.1` |
| **Classification** | **MINOR** — additive, backward-compatible, machine-scoped |
| **Status** | **Proposed — ratification-ready** (not applied; no schema/code modified) |
| **Depends on** | D-LIVE-1; `EDAM-DLIVE1-Resolution-Analysis.md`; Rev-1 adversarial review (findings C1, H1, H2, M1, M2, M3, L1, L2) |
| **Author role** | Contract amendment / verification |

> Proposal only. No schema, contract text, or code has been modified. Ratification by the contract owner is required before any change is applied.

---

## 0. What Changed in Revision 2

Rev 1 proposed a single additive `offset.anyOf` branch accepting `{binlog_file, binlog_pos}` plus prerequisites A (`@@server_uuid`) and B (snapshot `tx_id`). The adversarial review found that the branch and the snapshot identity were **prose-scoped, not machine-scoped**, producing one **Critical** and two **High** defects. Rev 2 closes every finding by moving all scoping into the schema/rules and by repairing the snapshot identity.

| Finding | Rev-1 gap | Rev-2 resolution | §|
|---|---|---|---|
| **C1 (Critical)** | PK-only snapshot `tx_id` ⇒ epoch-stable `envelope_id` + epoch-variable `event_hash` ⇒ false **V15** integrity violation on re-snapshot | **Snapshot-epoch identity**: `config_snapshot_id` is folded into `tx_id`; `ingest_ts`/offset must be capture-sourced; **V15 kept active** | §1 |
| **H1 (High)** | binlog branch not tied to `snapshot_phase` ⇒ a streaming event with a dropped GTID would pass V11 | **Machine guard G1**: streaming ⇒ offset must satisfy a real engine key (GTID/LSN/SCN/resume_token) | §2 |
| **H2 (High)** | "deterministic across re-runs" conflated arch-determinism with epoch-idempotency | Determinism guarantee restated precisely; **idempotency test** added; capture-sourced inputs required | §5 |
| **M1 (Medium)** | single vendored schema + major-only gate ⇒ a `cce-1.0`-labelled event could use the binlog branch | **Machine guard G3**: `schema_version == "cce-1.0"` ⇒ binlog branch forbidden, in-schema | §3 |
| **M2 (Medium)** | branch "engine-scoped by usage" only | **Machine guard G2**: `engine ∉ {mysql,mariadb}` ⇒ binlog branch forbidden, in-schema | §3 |
| **M3 (Medium)** | `completeness.consumed_offset_key` undefined for no-GTID snapshot rows (required, in hashed core) | Defined as the **epoch-stable** token `snapshot:<config_snapshot_id>` | §4 |
| **L1/L2 (Low)** | synthetic `tx_id`; §13.9 not explicitly ticked | Honest-disclosure note (`snapshot_phase`) + explicit §13.9 check | §6 |

The schema edit remains **additive**: one new `anyOf` branch plus three `if/then` guards in the top-level `allOf`. No existing field, type, enum, or rule is removed or retyped.

---

## 1. Resolution for C1 — Snapshot Identity (Critical)

**Defect.** With `tx_id = snapshot:<schema>.<table>:<pk>`, `envelope_id = UUIDv5(db_id‖tx_id‖server_uuid)` is identical for the same row across snapshot epochs, while `event_hash` (over a core containing `commit_ts`, `ingest_ts`, `offset.binlog_pos`) differs across epochs. `dedup.ts` / **V15** then read *same `envelope_id` + different `event_hash`* as a **CRITICAL integrity violation** on any legitimate re-snapshot.

### 1.1 Options evaluated

| Option | Identity key folded into `tx_id` | Distinct per epoch? | Idempotent within an epoch (replay-safe)? | Cross-arch deterministic? | Verdict |
|---|---|---|---|---|---|
| **(a) Snapshot epoch identity** | `config_snapshot_id` (the per-snapshot config fingerprint, already a required, hashed field in `fidelity.source_config`) | **Yes** — a new snapshot run = new config snapshot = new id ⇒ a re-snapshot is a *new, distinct* baseline envelope (no V15 clash) | **Yes** — within one epoch the id is constant; the same captured row replays to the same `envelope_id` + same `event_hash` ⇒ dedup DUPLICATE-skip | **Yes** — `config_snapshot_id` is assigned once per epoch and carried; no wall-clock in the key | **RECOMMENDED** |
| (b) Snapshot session identity | Debezium connector run/session id | Yes (per process) | **No** — a connector restart *mid-snapshot* changes the session id ⇒ resumed rows get a *different* envelope ⇒ duplicate baseline rows under two identities; not replay-safe | Depends on a volatile runtime id | Rejected |
| (c) Snapshot batch identity | snapshot chunk/batch id | Partially (batch granularity) | No — batch ids are not stable across re-chunking; does **not** by itself separate epochs | Fragile | Rejected (orthogonal at best) |
| (d) V15 exemption | — (exclude `snapshot_phase=snapshot` from V15/dedup) | N/A | N/A | N/A | **Rejected** — removes duplicate-detection from the *baseline*, the most security-sensitive rows; trades a false positive for a real blind spot; contradicts INV-2/INV-3 intent |

### 1.2 Recommendation — **Option (a): snapshot epoch identity**

```
transaction.tx_id = "snapshot:<config_snapshot_id>:<schema>.<table>:<canonical_primary_key>"
```

- `config_snapshot_id` is **epoch-stable**: constant for every row of one snapshot, distinct for a later snapshot. It is **already** a required, non-empty, hashed field (`fidelity.source_config.config_snapshot_id`, schema L68), so it is reused, not invented.
- A genuine re-snapshot (connector reset, `snapshot.mode` re-run, schema change) yields a **new** `config_snapshot_id` ⇒ a **distinct** `envelope_id` ⇒ it is appended as a fresh baseline event. **No false V15.** **V15 stays fully active** for true integrity violations (same epoch, same envelope, divergent hash) — option (d) is explicitly rejected.
- A replay of the *same* captured snapshot record (same epoch) reproduces the same `envelope_id` **and** the same `event_hash` ⇒ `dedup.ts` classifies it as DUPLICATE and skips it (replay-safe).
- `<canonical_primary_key>` is serialized with the **same** canonicalization as the rest of CCE (§12.7: UTF-8 NFC, code-point key sort, exact-decimal-as-string, no float), guaranteeing a deterministic key for composite/scalar PKs.

**Precondition (verification gate, not a contract change):** `transaction.ingest_ts` and `offset.{binlog_file,binlog_pos}` MUST be **capture-sourced** — assigned once when the record is captured and carried with it — never recomputed from wall-clock at build time. This is what makes a *same-epoch replay* reproduce an identical `event_hash`. This must be asserted by an idempotency test (§5) before ratification is treated as discharged.

This is a **prerequisite (no contract change)** like Rev-1's A/B, but it materially changes envelope-identity semantics, so it is documented here for contract-owner review rather than applied silently.

---

## 2. Resolution for H1 — Streaming Events Must Still Require a GTID (High)

**Defect.** Rev 1's binlog branch was unconditioned, so a *streaming* event arriving with `gtid = null` (a genuine gap/tamper signal that `cce-1.0` correctly DLQ's) would satisfy V11 via the binlog coordinate.

**Resolution — machine guard G1 (in-schema `if/then`).** Keep the binlog branch in `offset.anyOf`, but add a top-level `allOf` clause that **tightens the offset back to the four real engine keys whenever the event is in the streaming phase** (or has no declared snapshot phase):

```json
{
  "if": {
    "properties": { "completeness": { "properties": { "snapshot_phase": { "const": "streaming" } }, "required": ["snapshot_phase"] } },
    "required": ["completeness"]
  },
  "then": {
    "properties": { "offset": { "anyOf": [
      { "required": ["gtid"], "properties": { "gtid": { "type": "string" } } },
      { "required": ["lsn"], "properties": { "lsn": { "type": "string" } } },
      { "required": ["scn"], "properties": { "scn": { "type": "string" } } },
      { "required": ["resume_token"], "properties": { "resume_token": { "type": "string" } } }
    ] } }
  }
}
```

A streaming MySQL/MariaDB event therefore **must** carry a non-null `gtid`. A streaming event with `gtid = null` no longer validates and is DLQ'd exactly as under `cce-1.0` — the completeness/tamper signal is preserved. Restated **V11** now reads:

> **V11** At least one `offset` engine key is present and non-null (`gtid`/`lsn`/`scn`/`resume_token`); **or**, *only when `engine ∈ {mysql,mariadb}` and `completeness.snapshot_phase ∈ {snapshot,handoff}`*, a `binlog_file` (non-empty string) + `binlog_pos` (integer ≥ 0) pair. **Streaming-phase events (and all non-MySQL/MariaDB engines) always require a real engine key.**

The defaulting note: if `snapshot_phase` is absent, the event is treated as streaming for offset purposes (G1's `if` matches "streaming" explicitly; the binlog branch is additionally fenced by G2/G3 below, so an offset with no GTID and no snapshot phase cannot slip through).

---

## 3. Resolution for M1 + M2 — Machine-Enforceable Scoping (Medium)

EDAM validates against **one** vendored schema and `checkVersionGate` (`full.ts:12`) gates the **major** version only. So scoping cannot rely on "which schema was selected" or on prose. Rev 2 puts both scopes **inside the single `cce-1.1` schema** as `if/then` guards, so the one schema self-enforces correct behavior for `cce-1.0`- and `cce-1.1`-labelled events alike.

**M2 — engine scope (guard G2).** The binlog branch is valid only for MySQL/MariaDB:

```json
{
  "if": { "properties": { "source": { "properties": { "engine": { "not": { "enum": ["mysql", "mariadb"] } } } } } },
  "then": { "properties": { "offset": { "anyOf": [ /* the four real-key branches only */ ] } } }
}
```

A Postgres/Oracle/SQL-Server/Mongo event can no longer satisfy V11 by populating `binlog_file`/`binlog_pos` without its proper offset key.

**M1 — version scope (guard G3).** The binlog branch is valid only for events that declare the feature:

```json
{
  "if": { "properties": { "schema_version": { "const": "cce-1.0" } } },
  "then": { "properties": { "offset": { "anyOf": [ /* the four real-key branches only */ ] } } }
}
```

Within the single `cce-1.1` schema, an event **labelled** `cce-1.0` is held to the original four-branch offset rule even after the vendored schema is re-synced — the binlog branch is reachable only by events that honestly declare `schema_version = "cce-1.1"`. This makes Rev-1 §7's backward-compatibility claim **true inside EDAM**, not merely for an external strict validator. (`checkVersionGate` continues to gate the major version; no code change is required, because the schema now encodes the minor-feature coupling.)

**Combined effect (G1 ∧ G2 ∧ G3).** The binlog-only offset is accepted **iff** `engine ∈ {mysql,mariadb}` **and** `snapshot_phase ∈ {snapshot,handoff}` **and** `schema_version = "cce-1.1"`. In every other case the offset must carry a real engine key. All three guards are pure JSON-Schema `if/then` over already-existing fields — additive, declarative, and machine-checked by ajv with **no validator logic change**; `/offset` failures still classify as **V11** (`rules.ts:22`).

---

## 4. Resolution for M3 — `consumed_offset_key` for Snapshot Events (Medium)

`completeness.consumed_offset_key` is **required**, `minLength 1`, and part of the **hashed core** (`build.ts` includes `completeness`). For a no-GTID snapshot event it was undefined; if naively set to the binlog coordinate it would re-import C1's epoch instability into the hash.

**Resolution.** For snapshot-phase events define:

```
completeness.consumed_offset_key = "snapshot:<config_snapshot_id>"
completeness.snapshot_phase      = "snapshot"   (or "handoff" at the boundary)
completeness.gap_detected        = false
completeness.consumed_gtid_set   = (omitted — no GTID consumed yet)
```

- **Epoch-stable & deterministic:** keyed on `config_snapshot_id`, identical for all rows of one snapshot, distinct across epochs — consistent with the §1 identity and safe inside the hashed core.
- **No GTID-continuity contamination:** the snapshot key is excluded from GTID-gap analysis (§6.5); baseline coverage is represented by `snapshot_phase` + the snapshot→stream handoff, and the first streaming GTID resumes continuity. (Schema unchanged here — `snapshot_phase` already enumerates `snapshot/handoff/streaming`, schema L88.)

---

## 5. Re-Evaluation (determinism · replay · idempotency · completeness · compatibility)

| Dimension | Rev-1 status | Rev-2 status | Why |
|---|---|---|---|
| **Determinism** | overstated (H2) | **Sound, precisely stated** | Guarantee is *same captured record → byte-identical `envelope_id`/`event_hash` across architectures*. With capture-sourced `ingest_ts`/offset and an epoch-stable `tx_id`/`consumed_offset_key`, snapshot hashes are reproducible for a fixed capture. The two-target rig is unaffected; a snapshot golden vector is pinned at implementation. |
| **Replay** | unsafe (C1) | **Safe** | Re-delivery of the same captured snapshot record (same epoch) reproduces the same `envelope_id` **and** `event_hash` ⇒ `dedup.ts` DUPLICATE-skip. No false V15. |
| **Idempotency** | broken (C1) | **Correct** | A genuine re-snapshot is a new epoch (new `config_snapshot_id`) ⇒ a distinct, appended baseline envelope — not a contradiction of an existing one. V15 remains active for true violations. |
| **Completeness** | blind spot (H1) | **Preserved** | G1 forces streaming events to carry a GTID; dropped-GTID streaming events still DLQ. Snapshot offsets excluded from gap analysis; `consumed_offset_key` well-defined (M3). |
| **Compatibility** | unenforced (M1/M2) | **Machine-enforced** | One `cce-1.1` schema; G3 holds `cce-1.0`-labelled events to the original offset rule; G2 fences non-MySQL engines; existing `cce-1.0` events remain valid and byte-unchanged; their hashes are never recomputed (INV-3). A `cce-1.x` consumer accepts both versions; a strict `cce-1.0` consumer rejects binlog-only offsets — now true internally too. |

**Hashing impact (unchanged from intent, now safe):** no rehash of any existing event; canonical serialization (§12.7) and the hash/`row_hash` chain are untouched. The previously dangerous coupling (stable identity + unstable hash) is removed by folding the epoch into the identity so identity and hash move together across epochs.

**MINOR classification re-confirmed (L2 / §13.9):** the amendment accepts a **real, previously-unrepresentable position** (the binlog coordinate) and a **disclosed** synthetic snapshot identity (`snapshot_phase = "snapshot"` makes the non-transactional origin explicit) — it does **not** convert an honest unknown into a fabricated value (§13.9 satisfied), nor does it touch serialization/hashing (§13.1), `envelope_id` derivation for existing events (§13.2), ordering (§13.3), required-field shape (§13.4/§13.5), the chain (§13.7), enums (§13.8), or decimals (§13.10). It adds one permissive `anyOf` branch fenced by three `if/then` guards over existing fields. **Textbook additive MINOR.**

---

## 6. Updated Schema & Rule Change Set (consolidated)

Target: `CCE-v1-Specification.md` Appendix B + §6.5/§6.6/§10; vendored `packages/contracts/src/schemas/cce-1.0.schema.json` re-issued as `cce-1.1.schema.json`.

1. **`offset.anyOf`** — add the fifth (binlog) branch:
   ```json
   { "required": ["binlog_file", "binlog_pos"],
     "properties": { "binlog_file": { "type": "string", "minLength": 1 },
                     "binlog_pos":  { "type": "integer", "minimum": 0 } } }
   ```
   `offset.properties` and `offset.additionalProperties: false` unchanged.
2. **Top-level `allOf`** — add guards **G1** (streaming ⇒ real key, §2), **G2** (non-MySQL ⇒ real key, §3), **G3** (`cce-1.0` label ⇒ real key, §3).
3. **§10 V11** — restated text (§2 above).
4. **§6.6** — snapshot-offset note: binlog coordinate is the snapshot offset; excluded from GTID-gap analysis.
5. **§6.5 / completeness** — snapshot `consumed_offset_key = snapshot:<config_snapshot_id>` (§4). No schema change (`snapshot_phase` enum already present).
6. **Identity (prerequisite, no contract change)** — `tx_id = snapshot:<config_snapshot_id>:<schema>.<table>:<canonical_pk>` (§1); `ingest_ts`/offset capture-sourced.

No existing field/type/enum/rule removed or retyped. The code validator requires **no logic change**; only the vendored schema (one branch + three guards) and the spec text change.

---

## 7. Conditions of Approval

1. Implement the §1 snapshot **epoch identity** (option a); keep **V15 active** (reject the exemption).
2. Implement guards **G1/G2/G3** verbatim in the vendored `cce-1.1` schema; verify ajv classifies failures as **V11**.
3. Define snapshot `consumed_offset_key` per §4.
4. Verify the **capture-sourced** precondition (§1.2) and add a **re-snapshot idempotency test** plus a **dropped-GTID-streaming negative test** (must DLQ) and a **non-MySQL binlog-offset negative test** (must reject), alongside the snapshot conformance case and snapshot determinism golden vector.
5. Re-run live validation to confirm well-formed snapshot rows produce valid CCEs and that a second snapshot epoch does **not** raise a false V15.

These are implementation/verification tasks; none requires a *further* contract change beyond §6.

---

## 8. Final Ratification Recommendation

> ## APPROVE
> Ratify as **`cce-1.1` (MINOR)**, subject to the §7 conditions of approval.

Revision 2 closes every Rev-1 finding at the contract level: the Critical re-snapshot integrity collision (C1) is removed by epoch-folded identity with V15 retained; the High completeness blind spot (H1) and determinism overstatement (H2) are fixed by guard G1 and capture-sourced inputs; the Medium scoping gaps (M1/M2) are now machine-enforced by guards G3/G2 inside the single shipped schema; and the Medium `consumed_offset_key` gap (M3) is given an epoch-stable definition. Determinism, replay, idempotency, completeness, and compatibility all re-evaluate to sound. The change remains additive and backward-compatible — a textbook MINOR.

Upon ratification and satisfaction of §7, **D-LIVE-1 is closed** and Sprint-2 may proceed with snapshot-phase capture as its first deliverable. No WORM/evidence work should treat capture as complete until §7 lands.

---

*Amendment proposal, Revision 2. No schema, contract, or code modified. Ratification required before application.*
