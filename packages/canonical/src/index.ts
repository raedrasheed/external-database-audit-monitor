// @edam/canonical — deterministic canonical serialization, hashing, and
// identity helpers for EDAM (Epic E1). The determinism keystone: every EDAM
// service uses this single implementation so hashes are byte-identical
// everywhere (INV-4).

export { CanonicalError } from './errors.js';
export { serializeCanonical, compareByCodePoint } from './serialize.js';
export { sha256Hex, eventHash, hashValue, assertHashToken, isHashToken } from './hash.js';
export { uuidv5, envelopeId, EDAM_CCE_NAMESPACE, type EnvelopeIdParts } from './uuid.js';
export {
  snapshotEpochId,
  rowKeyHash,
  snapshotTxId,
  snapshotConsumedOffsetKey,
  type SnapshotEpochParts,
  type SnapshotObjectKey,
} from './snapshot.js';
export { rowHash, GENESIS_ROW_HASH } from './chain.js';
export {
  isExactDecimalString,
  assertExactDecimal,
  assertNotFloat,
  compareDecimal,
  decimalEquals,
} from './decimal.js';
