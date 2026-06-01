#!/usr/bin/env bash
# Seed the dev Vault with the read-only CDC credential reference (Epic E7 / EDAM-T048).
# EDAM stores secret *references*, not secrets in code (Blueprint security model).
# Usage: run after `npm run compose:up`.
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:${VAULT_PORT:-8200}}"
VAULT_TOKEN="${VAULT_DEV_ROOT_TOKEN:-edam-dev-root}"
CDC_USER="${CDC_USER:-cdc}"
CDC_PASSWORD="${CDC_PASSWORD:-cdc_pw}"

export VAULT_ADDR VAULT_TOKEN

echo "Seeding Vault at ${VAULT_ADDR} with the read-only CDC credential..."

# Enable a KV v2 mount for EDAM secrets (idempotent).
vault secrets enable -path=edam kv-v2 2>/dev/null || true

# Store the read-only CDC credential. INV-1: this user has NO write grants.
vault kv put edam/cdc/mysql \
  username="${CDC_USER}" \
  password="${CDC_PASSWORD}" \
  access="read-only" \
  note="Replication+SELECT only; no INSERT/UPDATE/DELETE/DDL (INV-1)."

echo "Done. Reference: edam/cdc/mysql"
