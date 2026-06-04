#!/bin/sh
# EDAM minio-init — one-shot Object-Lock bucket bootstrap (EDAM-T160).
#
# Pre-creates the WORM evidence bucket with S3 Object Lock + versioning so the
# live stack is "ready" before the evidence harness (T161) runs. Object Lock MUST
# be enabled at bucket creation; versioning + a default compliance retention are
# set best-effort. The writer's runtime `ensureBucket()` remains the final
# idempotent guard (T104/T161). Idempotent: safe to re-run.
set -e

BUCKET="${MINIO_BUCKET:-edam-evidence}"

# depends_on waits for minio health, but mc alias can still race the listener.
until mc alias set local "http://minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  echo "[minio-init] waiting for minio..."
  sleep 2
done

# Create the bucket WITH Object Lock (compliance-mode immutability, W-1/W-2/W-4).
if mc mb --with-lock "local/${BUCKET}" >/dev/null 2>&1; then
  echo "[minio-init] created object-locked bucket ${BUCKET}"
else
  echo "[minio-init] bucket ${BUCKET} already exists (continuing)"
fi

mc version enable "local/${BUCKET}" >/dev/null 2>&1 || echo "[minio-init] versioning already enabled"
mc retention set --default COMPLIANCE 365d "local/${BUCKET}" >/dev/null 2>&1 \
  && echo "[minio-init] default COMPLIANCE retention set (365d)" \
  || echo "[minio-init] default retention not set (writer enforces per-object retention; continuing)"

# --- Separation of Duties (EDAM-S3-SoD): provision three least-privilege IAM
#     identities (writer / reader / retention-admin) with distinct policies, so
#     role separation is enforced by the STORE, not by convention (S-6/S-7).
#     The bucket name in the committed policies is `edam-evidence`; a non-default
#     MINIO_BUCKET is patched in below. Idempotent. ---
provision_role() {
  role="$1"; user="$2"; secret="$3"; policy_file="/policies/edam-${role}-policy.json"
  if [ -z "$user" ] || [ -z "$secret" ]; then
    echo "[minio-init] SoD ${role}: no credentials provided (skipping — set the *_KEY/*_SECRET env)"; return 0
  fi
  # Patch the bucket name if a non-default bucket is configured.
  pf="/tmp/edam-${role}-policy.json"
  sed "s/edam-evidence/${BUCKET}/g" "$policy_file" > "$pf"
  mc admin policy create local "edam-${role}" "$pf" >/dev/null 2>&1 \
    && echo "[minio-init] SoD policy edam-${role} created" \
    || echo "[minio-init] SoD policy edam-${role} already exists"
  mc admin user add local "$user" "$secret" >/dev/null 2>&1 \
    && echo "[minio-init] SoD user ${user} created" \
    || echo "[minio-init] SoD user ${user} already exists"
  mc admin policy attach local "edam-${role}" --user "$user" >/dev/null 2>&1 || true
}

if [ -f /policies/edam-writer-policy.json ]; then
  provision_role writer          "${WORM_WRITER_USER:-}"          "${WORM_WRITER_SECRET:-}"
  provision_role reader          "${WORM_READER_USER:-}"          "${WORM_READER_SECRET:-}"
  provision_role retention-admin "${WORM_RETENTION_ADMIN_USER:-}" "${WORM_RETENTION_ADMIN_SECRET:-}"
else
  echo "[minio-init] SoD policies not mounted; skipping per-role provisioning"
fi

echo "[minio-init] bucket ${BUCKET} ready (object-lock + versioning + SoD roles)."
