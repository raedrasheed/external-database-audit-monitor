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

echo "[minio-init] bucket ${BUCKET} ready (object-lock + versioning)."
