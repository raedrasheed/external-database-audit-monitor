// @edam/cce-model — Canonical Change Event builder (Epic E4).
export * from './types.js';
export { inferType, diffFields } from './diff.js';
export { MASK, isSensitiveColumn, maskImage, maskFieldChanges } from './mask.js';
