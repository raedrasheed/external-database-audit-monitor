#!/usr/bin/env bash
# Load the shared Kafel seed into MariaDB on first boot (Epic E7 / EDAM-T049).
set -euo pipefail

DB="${MARIADB_DATABASE:-kafel}"
echo "[edam] loading seed schema + data into MariaDB database '${DB}'..."
mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" "${DB}" < /seed/001-schema.sql
mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" "${DB}" < /seed/002-seed.sql
echo "[edam] seed load complete."
