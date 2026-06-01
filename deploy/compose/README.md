# EDAM Local Development Stack

Local Docker Compose environment for EDAM Sprint 1 (Epic E7 / EDAM-T048).

## Services

| Service | Purpose | Port (host) |
|---|---|---|
| `mysql` | Monitored database (ROW+FULL+GTID); native audit stand-in via `mysql.general_log` | 3306 |
| `mariadb` | Second-engine target + MariaDB Audit Plugin reference | 3307 |
| `redis` | Internal event bus (Redis Streams) | 6379 |
| `debezium` | Debezium Server (MySQL → Redis; no Kafka) | 8083 |
| `postgres` | EDAM collector state DB (`edam_state`) | 5432 |
| `vault` | Dev secret store (read-only CDC credential reference) | 8200 |

All credentials are throwaway **dev defaults** (see `.env.example`). The CDC
user is provisioned **read-only** — INV-1: EDAM never writes to the monitored
database.

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
