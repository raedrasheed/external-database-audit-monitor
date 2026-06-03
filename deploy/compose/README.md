# EDAM Local Development Stack

Local Docker Compose environment for EDAM. Sprint 1 (Epic E7 / EDAM-T048) provides
the CDC + state services; Sprint 2 (Epic E2F / EDAM-T104, EDAM-T160) adds the WORM
evidence store and the live-stack (M-Live) topology used by the live evidence
harness (T161) and the offline verifier drills (T162).

## Services

| Service | Purpose | Port (host) |
|---|---|---|
| `mysql` | Monitored database (ROW+FULL+GTID); native audit stand-in via `mysql.general_log` | 3306 |
| `mariadb` | Second-engine target + MariaDB Audit Plugin reference | 3307 |
| `redis` | Internal event bus (Redis Streams) | 6379 |
| `debezium` | Debezium Server (MySQL → Redis; no Kafka) | 8083 |
| `postgres` | EDAM collector state DB (`edam_state`) | 5432 |
| `vault` | Dev secret store (read-only CDC credential reference) | 8200 |
| `minio` | WORM evidence store — MinIO with S3 Object Lock + versioning (T104) | 9000 (console 9001) |
| `minio-init` | One-shot: pre-creates the Object-Lock evidence bucket + versioning + default compliance retention (T160) | — (run-once) |
| `dev-signer` | **Dev stand-in** for the HSM signing service (S-4) — health/topology only (T160) | 8090 |
| `dev-tsa-log` | **Dev stand-in** for the RFC-3161 TSA + RFC-6962 transparency log (S-4) — health/topology only (T160) | 8091 |

All credentials are throwaway **dev defaults** (see `.env.example`). The CDC
user is provisioned **read-only** — INV-1: EDAM never writes to the monitored
database.

> **Dev stand-ins (not the real crypto path).** `dev-signer` and `dev-tsa-log`
> are minimal zero-dependency Node HTTP stubs that exist so the M-Live stack has
> reachable, healthy "signer" and "anchor authority" endpoints. They are **not**
> on the real signing/anchoring path: the live evidence harness (T161) performs
> the **actual** anchor-payload signing and anchoring **in-process** via
> `@edam/signing` and `@edam/anchoring` (canonical bytes from `@edam/evidence` /
> `@edam/anchor-proof`, so there is no builder↔verifier drift). They are plain
> HTTP; production uses mTLS + a real HSM/TSA (spec §15 S-4). Validate the stack's
> structural completeness with `npm run compose-validate`.

## Usage

```bash
# from repo root
npm run compose:up        # start the stack (uses ${VAR:-default} fallbacks)
npm run compose:config    # validate the compose configuration
npm run compose:logs      # tail logs
npm run compose:down      # stop and remove volumes

# seed Vault with the read-only CDC credential reference (after up)
bash deploy/compose/vault/seed-vault.sh
```

The seed schema and data (`db/seed/`) are loaded into MySQL and MariaDB on
first boot by the per-engine `init/01-load-seed.sh` loaders (added in
EDAM-T049). Generate change traffic with `npm run traffic` (EDAM-T049).

## Fidelity guarantees enforced by this stack

- `binlog_format=ROW`, `binlog_row_image=FULL` → complete before/after images.
- `gtid_mode=ON` (MySQL) / `gtid_strict_mode=ON` (MariaDB) → completeness proof.
- File-backed Debezium offsets + schema history → exact resume across restarts.
