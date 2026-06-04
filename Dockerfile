# EDAM service runtime image (R-11) — runs a PREBUILT esbuild bundle.
#
# The collector is bundled to a single self-contained CJS file on the host/CI
# (`npm run build:collector` -> dist/cdc-collector/index.cjs), then copied into a slim
# runtime image. This avoids an in-image `npm ci` of the heavy monorepo (which OOMs in
# constrained build environments) and yields a small, fast, reproducible image with no
# node_modules at runtime. Pure-JS deps (ioredis/pg/mysql2) are bundled in.
#
# Build flow:
#   npm run build:collector
#   docker build -t edam/edam-service:pilot -f Dockerfile .
FROM node:20-alpine
WORKDIR /app

# Prebuilt bundle (built on the host/CI before `docker build`).
COPY dist/cdc-collector/index.cjs ./collector.cjs

USER node
ENV NODE_ENV=production

# Default entrypoint: the CDC collector. Compose may override `command` per service.
CMD ["node", "collector.cjs"]
