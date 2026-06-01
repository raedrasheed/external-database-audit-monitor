# EDAM Live Stack Validation Report — `cce-1.1` (D-LIVE-1 closure)
### Phase: Live re-validation after the CCE-AMD-001 Rev 4 implementation

> **Objective:** confirm, on the real Docker Compose stack, that the implemented `cce-1.1` snapshot-phase capture closes D-LIVE-1 — MySQL snapshot reads now form valid CCEs instead of being DLQ'd — with no new integrity hazards and no regression to streaming or the security invariants.
> **Constraints honored:** no WORM, no anchoring, no projection DB, no dashboard, no risk engine, no Sprint-2 scope expansion. Sprint-1/Rev-4 code used exactly as committed (a temporary, since-deleted harness imported the real modules; no product code changed for the run).
> **Date:** 2026-06-01.

---

## 1. Method & Environment

- Docker Engine (Ubuntu 24.04 host); `deploy/compose/docker-compose.yml` brought up unchanged (mysql, redis, debezium).
- MySQL 8.0 seeded; Debezium Server 2.7.3 completed snapshot → streaming, sinking per-table Redis streams `kafel.kafel.<table>`.
- A temporary harness imported the **real** modules — `mapCapturedRecord`, `TransactionAccumulator`, `assembleTransaction` (`@edam/normalization`), `buildCce` (`@edam/cce-model`), `validateCceFull` + `CceStreamValidator` (`@edam/contracts`) — and drove them against the live snapshot envelopes. `server_uuid` was acquired read-only via `SELECT @@server_uuid` (Rev-1 prereq A). The harness was deleted after the run (not committed).

---

## 2. Real Snapshot Payload (the D-LIVE-1 case, live)

A live donations snapshot read (verbatim shape):

```json
{"before":null,"after":{"id":90211,"amount":"100.00","status":"approved", ...},
 "source":{"connector":"mysql","name":"kafel","ts_ms":1780333875000,"snapshot":"first",
           "db":"kafel","table":"donations","server_id":0,"gtid":null,
           "file":"mysql-bin.000003","pos":197},
 "op":"r"}
```

Confirms the root cause exactly: snapshot reads carry **`op=r`, `gtid=null`, `server_id=0`**, and only a **binlog coordinate** (`file`/`pos`) + `ts_ms`. Under `cce-1.0` these were rejected (`SCHEMA_VALIDATION_FAILURE`) and DLQ'd.

---

## 3. D-LIVE-1 Closure — Results

| Check | Result |
|---|---|
| Live snapshot reads processed (donations + wallets) | **5** |
| Valid **`cce-1.1`** CCEs built | **5 / 5** |
| Routed to DLQ | **0** (was 100% under `cce-1.0`) |
| All declare `schema_version = cce-1.1` | ✅ |
| All carry `completeness.snapshot_epoch_id` | ✅ |
| All pass `validateCceFull` (schema + V16 + V17 + V18) | ✅ |
| Distinct epochs (single snapshot) | **1** (epoch constant across the run, as designed) |
| Snapshot `tx_id` form | `snapshot:snap-a7852e10897392c4:<rowKeyHash>` ✅ |

**The initial baseline is now captured as CCEs.** D-LIVE-1's defining symptom — "snapshot rows uncaptured / DLQ'd" — is gone.

---

## 4. Integrity Re-validation (the Rev-4 findings, live)

| Property | Result |
|---|---|
| **Replay idempotency** (HIGH-2 / F5) — re-feed the identical captured snapshot | **Byte-identical** envelope_id + event_hash on re-build |
| **No false V15** (C1/HIGH-2) — original pass + replay through `CceStreamValidator` | **0 V15 violations** |
| **Epoch identity** is capture-sourced (watermark + `source.ts_ms`), independent of `config_snapshot_id` | ✅ (offline `C-SNAP-EPOCH-IDLE-RERUN` proves a same-watermark/different-ts re-snapshot yields a distinct epoch) |
| **V16 positive guard** — streaming dropped-GTID / non-MySQL / `cce-1.0` binlog | rejected (conformance `C-STREAM-NOGTID-FAIL`, `C-NONMYSQL-BINLOG-FAIL`, `C-1.0-BINLOG-FAIL`) |

---

## 5. Security Results

- **INV-1 (no monitored-DB write) — live-verified.** With the read-only CDC credential (`GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT`), every write attempt was rejected:

  | Attempt | Result |
  |---|---|
  | `INSERT INTO kafel.donations …` | rejected (`command denied to user 'cdc'`) |
  | `UPDATE kafel.donations …` | rejected (`command denied to user 'cdc'`) |
  | `DELETE FROM kafel.donations …` | rejected (`command denied to user 'cdc'`) |

- **INV-2 (no fabrication) — upheld.** `server_uuid` acquired read-only (never invented); snapshot fidelity HEALTHY only because the live config attested ROW/FULL/GTID-ON; unconvertible events would still DLQ (none did).
- **Streaming path unaffected** — streaming events remain `cce-1.0` and byte-identical (golden vectors FX-001..005 unchanged; determinism rig MATCH).

---

## 6. Findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| F-LIVE-1.1 | Positive | MySQL snapshot reads now form valid `cce-1.1` CCEs with capture-sourced epoch identity; **0 DLQ**. | **D-LIVE-1 CLOSED** |
| F-LIVE-1.2 | Positive | Replay byte-identical; **0 false V15** across original + replay. | Closed (HIGH-2 verified live) |
| F-LIVE-1.3 | Positive | INV-1 live-verified (all writes rejected); streaming unchanged. | Maintained |

No High/Critical findings. No new integrity hazards observed.

---

## 7. Conclusion

> ## ✅ D-LIVE-1 CLOSED — verified on the live stack.

The `cce-1.1` implementation (CCE-AMD-001 Rev 4) captures the initial MySQL baseline as valid, deterministic, replay-idempotent CCEs with a capture-sourced snapshot epoch identity, raises no false V15 on replay, and preserves INV-1/INV-2 and all existing streaming behavior. Combined with the green conformance suite (19/19, incl. the Rev-4 cases), the cross-target determinism MATCH (6 fixtures incl. the FX-006 snapshot golden), and the coverage gate, the snapshot-phase capture deliverable is complete.

*Live validation complete. Stack torn down; only this report and the implementation commits were added. No WORM/anchoring/projection/dashboard/risk-engine work was performed.*
