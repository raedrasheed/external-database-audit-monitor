#!/usr/bin/env bash
# Load the shared Kafel seed into MySQL on first boot (Epic E7 / EDAM-T049).
# The authoritative seed lives in db/seed (mounted at /seed) so MySQL and
# MariaDB load identical schema + data.
set -euo pipefail

DB="${MYSQL_DATABASE:-kafel}"
echo "[edam] loading seed schema + data into MySQL database '${DB}'..."
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" "${DB}" < /seed/001-schema.sql
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" "${DB}" < /seed/002-seed.sql
echo "[edam] seed load complete."
