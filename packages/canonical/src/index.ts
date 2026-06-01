// @edam/canonical — deterministic canonical serialization, hashing, and
// identity helpers for EDAM (Epic E1). The determinism keystone: every EDAM
// service uses this single implementation so hashes are byte-identical
// everywhere (INV-4).

export { CanonicalError } from './errors.js';
export { serializeCanonical, compareByCodePoint } from './serialize.js';
export { sha256Hex, eventHash, hashValue, assertHashToken, isHashToken } from './hash.js';
