# EDAM Operator Runbook (Pilot)

Operational procedures for running EDAM as a **pilot monitoring + WORM evidence
collection** platform against a real Kafel MySQL. Pairs with the
[pilot runtime config](../../deploy/pilot) and the
[monitoring checklist](./EDAM-Monitoring-Checklist.md).

> **Boundaries (must be understood by operators):** `dev-signer`/`dev-tsa-log` are
> **not** the real crypto path; the evidence path signs/anchors **in-process via dev
> providers** ⇒ evidence is **DEV-anchored** (R-01). There is **no mTLS / dual-control
> / DR** in the pilot — run on a **private/isolated network**.

## 1. Pre-flight checklist
- [ ] Kafel MySQL has `binlog_format=ROW`, `binlog_row_image=FULL`, `gtid_mode=ON`.
- [ ] **Read-only** CDC user provisioned on Kafel (no write grants — INV-1); grants audited.
- [ ] Source binlog retention ≥ the intended recovery window.
- [ ] Secrets supplied via `deploy/pilot/.env.pilot` (copied from `.env.pilot.example`);
      **all `CHANGE_ME` values replaced**.
- [ ] WORM store: bucket created with **Object Lock COMPLIANCE + versioning + default
      retention**, and the **3 SoD identities** provisioned (minio-init).
- [ ] `docker compose -f deploy/pilot/docker-compose.pilot.yml config` validates.

## 2. Bring-up order
1. `redis` (bus) → `postgres` (collector state) → `minio` + `minio-init` (WORM + SoD).
2. `debezium` configured for the **external Kafel** source (operator-supplied connector
   config) → Redis sink.
3. **Collector** (`services/cdc-collector`, `npm start` / `tsx src/index.ts`) with the
   pilot env (read-only credential ref, `PG`/bus/WORM endpoints).
4. Evidence-writer / sealer / anchoring run in the collector/evidence process
   (in-process dev signer + dev RFC-3161 — DEV-anchored).
5. Schedule the **offline verifier** (verifier-cli) over produced export packages with the
   generated trust file.

## 3. Health checks
- Service `/health` (where exposed); MinIO `GET /minio/health/live` → 200.
- Debezium connector state = RUNNING; offsets advancing.
- WORM born-locked spot-check: `getObjectRetention(<key>) == COMPLIANCE`.

## 4. Routine operations
- Watch **CDC lag**, **DLQ depth** (target 0), seal/sign/anchor success counts,
  **anchor PENDING** backlog, scheduled verifier **PASS**.
- Daily: confirm evidence object counts vs expected; sample an export package and run the
  verifier; confirm segment continuity (no gaps).

## 5. Common failures & responses
| Symptom | Likely cause | Action |
|---|---|---|
| CDC stalled / lag rising | connector down / source binlog expired / network | restart connector; check offsets + binlog retention; if expired → gap, record + re-snapshot per policy |
| DLQ growing | downstream failure (bus/state/WORM) | inspect failure category; fix dependency; replay from DLQ |
| Anchor PENDING backlog | dev-TSA hiccup | re-drive anchoring; **never** fabricate a token (fail-closed by design) |
| WORM write `AccessDenied` (403) | wrong SoD credential / policy drift | verify per-role creds + policies (H5 matrix); do **not** widen policies ad hoc |
| `VERIFICATION_FAILED` | integrity failure (tamper/bug) | **TERMINAL** — freeze the affected scope, preserve evidence, **escalate**; do not "repair" evidence |
| MinIO unavailable | store/infra outage | halt collection (evidence pauses, not lost); restore store; resume from offsets |

## 6. Escalation
Escalate immediately on: `VERIFICATION_FAILED`; sustained DLQ growth; WORM write
failures; MinIO unavailability; suspected **source-fidelity downgrade** (ROW/FULL/GTID).
Capture: timestamps, offsets, affected segment/object keys, logs.

## 7. Shutdown / pause
`docker compose -f deploy/pilot/docker-compose.pilot.yml stop` (offsets persist → exact
resume). WORM evidence is immutable and retained. See the
[rollback plan](./EDAM-Rollback-Plan.md).
