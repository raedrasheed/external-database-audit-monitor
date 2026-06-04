# EDAM Pilot Runtime

Minimal **production-oriented** runtime for the pilot: CDC + collector-state + WORM
evidence store, against an **EXTERNAL Kafel MySQL**. Read
[`docs/ops/`](../../docs/ops/README.md) (runbook, monitoring, rollback, validation).

> **Pilot boundary:** evidence is **DEV-anchored** (in-process dev signer + dev RFC-3161,
> R-01); **no mTLS / dual-control / DR** (run on a PRIVATE/ISOLATED network). This is **not**
> a §15 Production Security Sign-Off.

## What this compose runs
- `redis` (bus), `postgres` (collector state), `minio` + `minio-init` (WORM Object Lock +
  versioning + default COMPLIANCE retention + the 3 SoD identities — reuses the committed
  `deploy/compose/minio/{init-bucket.sh,policies}`), and `debezium` (CDC → Redis).
- It does **NOT** bundle the monitored DB (Kafel is external, read-only — INV-1) and does
  **NOT** run dev-signer/dev-tsa stubs (the evidence path anchors in-process).

## Containerized (R-11a) and pending (R-11b)
- **Collector — CONTAINERIZED (R-11a).** Built as a self-contained esbuild bundle into a
  slim image (no in-image `npm ci`). The image **enforces INV-1** (rejects a non-read-only
  CDC credential). Build + run:
  ```bash
  npm run build:collector            # esbuild -> dist/cdc-collector/index.cjs (run on host/CI)
  docker compose --env-file deploy/pilot/.env.pilot -f deploy/pilot/docker-compose.pilot.yml build collector
  docker compose --env-file deploy/pilot/.env.pilot -f deploy/pilot/docker-compose.pilot.yml up -d
  ```
- **Evidence-writer — NOT YET A SERVICE (R-11b).** `@edam/evidence-writer` is a library
  (no runnable entrypoint). Containerizing it requires authoring a **service composition
  root** (bus consumer → accumulator → sealer → dev signer → dev RFC-3161 anchoring → WORM
  writer + DLQ). Until R-11b lands, the collector publishes to the bus but **no evidence is
  written to WORM**. The proven wiring exists (S3-REVAL harness) and will be made a permanent
  service with an in-memory smoke test + pilot integration.

## Setup
1. `cp deploy/pilot/.env.pilot.example deploy/pilot/.env.pilot` and replace **all
   `CHANGE_ME`** values.
2. Provide a Debezium connector config for your Kafel source under
   `deploy/pilot/debezium-conf/` (MySQL host/port + the **READ-ONLY** CDC user; ROW+FULL+GTID).
3. Validate: `docker compose --env-file deploy/pilot/.env.pilot -f deploy/pilot/docker-compose.pilot.yml config`.
4. Bring up infra: `... up -d` (order handled by healthchecks/depends_on).
5. Run the collector process with the pilot env (see runbook §2).
6. Schedule the offline verifier over produced export packages with the generated trust
   file (`docs/trust/trust.json`).

## Pre-flight (must pass)
- Kafel: `binlog_format=ROW`, `binlog_row_image=FULL`, `gtid_mode=ON`; read-only CDC user
  (no write grants — INV-1).
- WORM bucket has Object Lock COMPLIANCE + versioning + default retention + the 3 SoD
  identities (minio-init).
- All `CHANGE_ME` replaced; private/isolated network.

## Teardown / rollback
See [rollback plan](../../docs/ops/EDAM-Rollback-Plan.md). WORM evidence is immutable and
retained; stopping the stack cannot delete it and cannot affect Kafel (INV-1).
