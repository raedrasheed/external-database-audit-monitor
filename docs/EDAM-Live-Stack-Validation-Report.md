# EDAM Live Stack Validation Report
### Phase: Live Stack Validation (pre-Sprint-2)

> **Objective:** validate the real runtime behavior of the complete Sprint-1 pipeline on the actual Docker Compose stack, using the Sprint-1 implementation exactly as-is.
> **Constraints honored:** no WORM, no anchoring, no projection DB, no Sprint-2 implementation; no architecture/contract/semantic change. Sprint-1 code unchanged (validation used a temporary, since-deleted harness that imported the real modules).
> **Date:** 2026-06-01.

---

## 1. Method & Environment

- Docker Engine 29.3.1 + Compose v5.1.1; daemon started locally; all 6 images pulled (Docker Hub anonymous, one transient rate-limit on the Debezium image, retried).
- Brought up `deploy/compose/docker-compose.yml` (unchanged).
- A temporary harness imported the **real** `@edam/normalization` (Normalizer, CCE builder, DLQ), `@edam/cdc-collector/attestation` (`assessFidelity`), and `@edam/cdc-collector/completeness` (`CompletenessWatcher`) and drove them against the live Redis sink + MySQL. The harness reconstructed `CapturedRecord`s from real Debezium payloads exactly as the collector does; all normalization/diff/masking/build/validation/DLQ is the unmodified Sprint-1 code. The harness was deleted after the run (not committed).

---

## 2. Stack Validation

| Service | Result |
|---|---|
| MySQL 8.0 | ✅ healthy; `binlog_format=ROW`, `binlog_row_image=FULL`, `gtid_mode=ON`, `log_bin=1`; seed loaded (donations id 90211 = `100.00`/approved); `server_uuid=386be27f-…` |
| MariaDB 11.4 | ✅ healthy |
| Debezium Server 2.7.3 | ✅ UP; **snapshot completed → streaming** from GTID `386be27f-…:1-41`; sinks to per-table Redis streams |
| Redis 7 | ✅ healthy; streams `kafel.kafel.<table>` (×9) + `__debezium-heartbeat.kafel` |
| PostgreSQL 16 | ✅ healthy (`edam_state`) |
| Vault 1.17 (dev) | ✅ healthy |

**CDC credential grants (live):** `GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT` — **read-only, no write** (INV-1).

---

## 3. End-to-End Flow (Database → CDC → Attestation → Completeness → Normalization → CCE Builder → DLQ)

| Stage | Result |
|---|---|
| **Real Debezium payload shape** | ✅ Matches the implemented mapping: `{op, before, after, source:{gtid,file,pos,snapshot,ts_ms,table}}`; Redis "key-as-field-name" layout — handled by `decodeRedisEntry`. |
| **GTID handling** | ✅ Streaming events carry GTID `386be27f-…:N`; `server_uuid` derived from the GTID prefix. |
| **Snapshot phase** | ✅ Observed (`op=r`, `snapshot=first`). |
| **Handoff phase** | ✅ Observed (`snapshot=last`). |
| **Streaming phase** | ✅ Observed (`op=c/u/d`). |
| **Row-image handling** | ✅ FULL before/after present; field-level diffs produced for streaming UPDATE/DELETE/INSERT. |
| **Decimal-string handling** | ✅ `amount`/`balance`/`total_raised` arrive and are emitted as **exact strings** (e.g. `"100000.00"`); `decimal.handling.mode=string` confirmed live. |
| **CCE generation** | ✅ Streaming changes produced **valid, contract-passing CCEs** (envelope_id/event_hash/row_hash; validated by `validateCceFull`). |
| **Attestation (real DB)** | ✅ `assessFidelity` over the live `SHOW GLOBAL VARIABLES` → **HEALTHY**. |
| **Completeness (real GTIDs)** | ✅ `computeGap()` over the consumed streaming GTIDs → **gap_detected=false** (contiguous). |
| **DLQ** | ✅ Malformed records → DLQ (see §6). |

---

## 4. Security Results

- **INV-1 (no monitored-DB write) — live-verified.** Using the read-only CDC credential, every write attempt was **rejected** by MySQL:

  | Attempt | Result |
  |---|---|
  | `INSERT INTO kafel.donations …` | rejected (`ER_TABLEACCESS_DENIED_ERROR`) |
  | `UPDATE kafel.donations …` | rejected (`ER_TABLEACCESS_DENIED_ERROR`) |
  | `DELETE FROM kafel.donations …` | rejected (`ER_TABLEACCESS_DENIED_ERROR`) |
  | `CREATE TABLE kafel.x …` | rejected (`ER_TABLEACCESS_DENIED_ERROR`) |

  *Note:* the attestation and completeness paths reuse the **same** read-only CDC credential (the integrity entrypoint constructs one read-only mysql2 connection), so this rejection covers all three credential roles named in the validation scope.
- **INV-2 (no fabrication) — upheld live.** Events that could not form a contract-valid CCE were routed to the DLQ rather than emitted (see §7 finding); no HEALTHY/ATTRIBUTED state was fabricated.
- **Secret hygiene:** credential logged only via redaction; no password/PII observed in output.

---

## 5. Performance Results (A11)

Measured on streaming events (Debezium `source.ts_ms` → CCE built), single host, **small sample (n=6)**:

| Latency | p50 | p95 | p99 | max |
|---|---|---|---|---|
| Capture (commit → in-EDAM) | 128 ms | 138 ms | 138 ms | 138 ms |
| Build (captured → CCE built) | 3 ms | 1085 ms* | 1085 ms* | 1085 ms* |
| **End-to-end (commit → CCE)** | **138 ms** | **1205 ms*** | **1205 ms*** | **1205 ms*** |

`*` The p95/p99 build/e2e figures are dominated by a **first-event warm-up outlier** (JIT + ajv schema compile on the first `buildCce`) in a 6-sample run; the steady-state p50 is ~138 ms end-to-end.

**Acceptance Criterion A11 (p95 < 5 s): PASS** — e2e p95 = 1205 ms (≈ 138 ms steady-state). *Caveat:* small sample + warm-up; a higher-volume re-measurement is recommended in Sprint-2 (with warm-up excluded).

---

## 6. No-Event-Loss & DLQ Behavior

**No event loss — confirmed (every event accounted).** 31 source data events:
- **8** became CCE change-items (6 streaming CCEs; one mass-update CCE carried multiple changes);
- **23** were routed to the DLQ (snapshot reads — see §7), `SCHEMA_VALIDATION_FAILURE`;
- `8 + 23 = 31` → fully accounted, nothing dropped.

**DLQ with malformed records:** 2 deliberately malformed records (non-JSON; shapeless object) → **2/2 routed to the DLQ**, pipeline did not crash, nothing emitted.

> Accounting note: the harness's initial "loss" flag used the wrong invariant (`change_items ≥ events`); the correct invariant is `change_items + dlq == events`, which holds. This was a harness bug, not a product defect.

---

## 7. Findings & Defects

### Positive findings
- F1 — Full stack boots healthy; Debezium snapshots then streams; real payloads match the implemented mapping.
- F2 — INV-1 live-verified (all writes rejected by the read-only credential).
- F3 — Attestation against the live DB → HEALTHY; completeness over live GTIDs → no gap.
- F4 — Decimals are exact strings end-to-end; streaming CCEs are contract-valid and deterministic.
- F5 — No event loss; malformed records → DLQ; no fabrication (INV-2 upheld live).
- F6 — A11 p95 < 5 s (steady-state ~138 ms).

### Defects / Design gaps
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **D-LIVE-1** | **High (design gap)** | **MySQL snapshot-phase events cannot form a contract-valid CCE.** Snapshot reads (`op=r`) carry **no GTID** and **no `server_uuid`**; the CCE contract requires `source.server_uuid` (minLength 1) and an `offset` `anyOf` of `gtid/lsn/scn/resume_token` (binlog file+pos alone is not accepted). These events therefore fail `validateCceFull` and are routed to the DLQ (`SCHEMA_VALIDATION_FAILURE`). **Consequence:** initial baseline (snapshot) rows are **not** captured as CCEs; only streaming changes are. **Behavior is honest** (DLQ, no loss, no fabrication) but the baseline is uncaptured. | **Defer to Sprint-2 (contract/design decision).** Not fixed here (no contract change permitted). |
| **D-LIVE-2** | Low | Build-latency p95 outlier from first-build warm-up in a small sample. | Re-measure at volume in Sprint-2, excluding warm-up. |

**D-LIVE-1 remediation options for Sprint-2 (decision required, not implemented now):**
1. Acquire `server_uuid` once via `SELECT @@server_uuid` (read-only) and stamp snapshot CCEs with it; and
2. Reconcile the snapshot offset: either accept `binlog_file:binlog_pos` as a valid offset key for snapshot events, or synthesize a deterministic, contract-valid offset (CCE §6.6 / §4.2), or formally define snapshot-read representation. This is a **frozen-contract reconciliation** item (relates to the existing E2 implementation note and ERRATA-CCE-001 review).

---

## 8. Go / No-Go Recommendation for Sprint-2

## ✅ **GO — proceed to Sprint-2.**

**Justification.** The live stack confirms the Sprint-1 pipeline works end-to-end on real services: real Debezium payloads are normalized into valid, deterministic CCEs; decimals are exact strings; fidelity attestation and completeness behave correctly against the live DB; INV-1 (no monitored-DB write) is **live-verified** (all writes rejected); INV-2 is upheld (unconvertible events → DLQ, no fabrication, no loss); malformed records are quarantined; and A11 (p95 < 5 s) passes (~138 ms steady-state). The two largest pre-validation risks (RR2 live behavior, RR7 tx-boundary) are substantially retired for the streaming path.

**Mandatory Sprint-2 entry condition (carry-forward):** **D-LIVE-1 (snapshot-phase capture)** must be the **first Sprint-2 work item**, resolved via a documented contract/design decision (server_uuid acquisition + snapshot offset model). Until then, the initial baseline snapshot is not captured as CCEs (only streaming changes are) — acceptable for proceeding, but it must be closed before any evidence/WORM work treats the capture as complete.

**Secondary:** re-run the latency measurement at higher volume (D-LIVE-2); proceed with the planned Sprint-2 scope (live-smoke retained in CI, then WORM evidence + anchoring, DB-Audit Event producer, projection).

---

*Live validation complete. Sprint-1 code unchanged; stack torn down; only this report added.*
