# EDAM Rollback Plan (Pilot)

## Safety properties that make rollback low-risk
- **INV-1:** EDAM **never writes the monitored DB** ⇒ stopping/rolling back EDAM
  **cannot affect Kafel** (no source corruption possible).
- **WORM immutability:** collected evidence is **append-only, born-locked COMPLIANCE**
  ⇒ rollback **cannot delete** already-collected evidence (by design). "Rollback" never
  destroys evidence.
- **Deterministic resume:** Debezium **file-backed offsets + schema history** ⇒ restart
  resumes **exactly** (GTID/offset-keyed; no gap, no duplicate).

## Rollback procedure
1. **Pause collection:** stop `debezium` + the collector
   (`docker compose -f deploy/pilot/docker-compose.pilot.yml stop debezium`; stop the
   collector process). Offsets persist.
2. **Preserve evidence:** leave MinIO/WORM **running and intact** (or stop it cleanly —
   the volume + Object Lock retain all objects). Do **not** delete the bucket/volume.
3. **Revert config/version:** roll the collector / evidence-writer config (and, if a new
   version was deployed, the image/checkout) back to the prior known-good.
4. **Record:** write a short rollback note (time, reason, offsets, version) for audit.
5. **Resume (forward):** restart from persisted offsets → exact continuation.

## What is intentionally NOT rolled back
- Committed **WORM objects** (immutable) and **DEV-anchored records** — these persist and
  are **reconciled/re-anchored later** (R-01), never deleted.
- Postgres collector **state/offsets** — retained so resume is exact (deleting them would
  force a re-snapshot, not a rollback).

## Failure-during-rollback
- If the collector won't stop cleanly: kill the process; offsets are file-backed and safe.
- If MinIO is mid-write: the WORM write is atomic per object (born-locked on success);
  partial/failed writes leave no committed object — resume re-produces from offsets.

## Decision guide
| Situation | Action |
|---|---|
| Bad config / version regression | Steps 1–5 (revert + forward-resume) |
| Suspected integrity issue (`VERIFICATION_FAILED`) | Pause (step 1) + **preserve** + escalate; do **not** revert/delete evidence |
| Store/infra outage | Pause; restore store; resume from offsets |
| Need to fully decommission the pilot | Stop services; **export + retain** the WORM evidence per policy; do not delete locked objects |
