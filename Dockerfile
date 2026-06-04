# EDAM service runtime image (R-11) — runs a PREBUILT esbuild bundle.
#
# Each service is bundled to a single self-contained CJS file on the host/CI
# (`npm run build:services` -> dist/<service>/index.cjs), then copied into a slim
# runtime image. This avoids an in-image `npm ci` of the heavy monorepo (which OOMs in
# constrained build environments) and yields a small, fast, reproducible image with no
# node_modules at runtime. Pure-JS deps (ioredis/pg/mysql2/minio) are bundled in.
#
# Build flow (per service):
#   npm run build:services
#   docker build --build-arg SERVICE=cdc-collector   -t edam/cdc-collector:pilot   -f Dockerfile .
#   docker build --build-arg SERVICE=evidence-writer -t edam/evidence-writer:pilot -f Dockerfile .
FROM node:20-alpine
WORKDIR /app

ARG SERVICE=cdc-collector
# Prebuilt bundle for the selected service (built on the host/CI before `docker build`).
COPY dist/${SERVICE}/index.cjs ./service.cjs

USER node
ENV NODE_ENV=production

CMD ["node", "service.cjs"]
