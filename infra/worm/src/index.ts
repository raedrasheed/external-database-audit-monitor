// @edam/worm — WORM evidence store abstraction (Sprint-2 / EDAM-T103).
// Role-scoped identities (append-only writer / reader / retention-admin) +
// an in-memory fake. The MinIO Object-Lock dev adapter lands in EDAM-T104.

export {
  WormError,
  type WormObjectKey,
  type WormBytes,
  type RetentionMode,
  type PutOptions,
  type ObjectLock,
  type WormWriter,
  type WormReader,
  type WormRetentionAdmin,
  type WormStore,
} from './types.js';
export { InMemoryWormStore } from './memory.js';
export { MinioWormStore, createMinioWormStore, type MinioWormConfig } from './minio.js';
