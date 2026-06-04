# EDAM Monitoring & Observability Checklist (Pilot)

Signals to monitor + alarm thresholds for the pilot. Pair with the
[runbook](./EDAM-Operator-Runbook.md).

## Source / CDC
- [ ] Debezium connector state = **RUNNING** (alarm on STOPPED/FAILED).
- [ ] **CDC lag** (source commit → captured) within target (alarm on sustained growth).
- [ ] Offsets **advancing**; source binlog retention headroom (alarm when low).
- [ ] **Fidelity flags** ROW/FULL/GTID present — **alarm on any downgrade** (S-fidelity).

## Pipeline
- [ ] **DLQ depth** — target **0**; alarm on `> 0` sustained.
- [ ] CCE build rate tracks change volume.
- [ ] Segment **seal / sign / anchor** success counts (alarm on failures).
- [ ] **Anchor PENDING** backlog (dev-TSA) — alarm on growth; re-drive (never fabricate).

## WORM store
- [ ] MinIO `GET /minio/health/live` = 200.
- [ ] WORM **write success** rate (alarm on failures).
- [ ] **Born-locked spot-check:** sampled `getObjectRetention == COMPLIANCE`.
- [ ] SoD **403s only where expected** (per the H5 matrix) — unexpected 403 ⇒ investigate
      credentials/policy drift.

## Verification (integrity)
- [ ] Scheduled offline verifier run = **PASS** (alarm on FAIL).
- [ ] **`VERIFICATION_FAILED`** ⇒ **CRITICAL, terminal** — freeze + escalate (do not repair).
- [ ] Periodic determinism rig check (alarm on drift).

## Platform
- [ ] Service health / restart counts; resource saturation (CPU/mem/disk).
- [ ] **Clock sync** (anchor/timestamp correctness depends on it).
- [ ] Secret store (Vault, if used) availability.
- [ ] Volume durability / free space for WORM + state.

## Audit / ops KPIs
- [ ] Evidence object count vs expected for the window.
- [ ] **Segment continuity** — no gaps (no missing `segment_sequence`).
- [ ] Export-package verifiability sampled daily (verifier PASS).

## Alarm severity guide
| Signal | Severity |
|---|---|
| `VERIFICATION_FAILED` | Critical (terminal) |
| Fidelity downgrade (ROW/FULL/GTID) | Critical |
| WORM write failures / MinIO down | High |
| Sustained DLQ growth / CDC stall | High |
| Anchor PENDING backlog | Medium |
| Resource saturation / clock skew | Medium |
