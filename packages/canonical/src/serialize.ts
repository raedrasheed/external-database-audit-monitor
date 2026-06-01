// Canonical serialization (Epic E1 / EDAM-T001).
//
// Implements the FROZEN canonical form of CCE v1 §12.7. This serialization is
// the foundation of every hash in EDAM and MUST NOT change within cce-1.0:
//
//   - UTF-8 NFC for all strings and object keys
//   - object keys sorted lexicographically by Unicode CODE POINT
//   - arrays in natural order
//   - integers as plain decimal (no exponent, no leading zeros, no -0)
//   - decimals / money are exact STRINGS, never IEEE floats (§12.8) -> a
//     non-integer JS number is rejected
//   - booleans `true` / `false`
//   - `null` explicit
//   - no insignificant whitespace
//
// The output is deterministic: identical input values produce byte-identical
// output across machines, runtimes, and runs.

import { CanonicalError } from './errors.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Compare two strings by Unicode code point (not UTF-16 code unit). For BMP
 * characters this matches the `<` operator, but it differs for astral
 * characters (surrogate pairs); the frozen spec mandates code-point order.
 */
export function compareByCodePoint(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const pa = ca[i]!.codePointAt(0)!;
    const pb = cb[i]!.codePointAt(0)!;
    if (pa !== pb) return pa - pb;
  }
  return ca.length - cb.length;
}

function serializeString(s: string): string {
  // NFC-normalize, then emit a JSON string token (deterministic escaping).
  return JSON.stringify(s.normalize('NFC'));
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalError(`non-finite number is not representable: ${String(n)}`);
  }
  if (!Number.isInteger(n)) {
    throw new CanonicalError(
      `non-integer number ${String(n)} is not allowed: money/decimals must be exact ` +
        `strings, never floating point (CCE §12.8)`,
    );
  }
  if (!Number.isSafeInteger(n)) {
    throw new CanonicalError(
      `unsafe integer ${String(n)} would lose precision; use a string or bigint`,
    );
  }
  // Number.isInteger excludes -0 issues; String(-0) === '0'.
  return String(n);
}

function write(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'bigint':
      return value.toString(10);
    case 'string':
      return serializeString(value);
    case 'object':
      break;
    default:
      throw new CanonicalError(`unsupported value type: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((v) => write(v)).join(',') + ']';
  }

  if (isPlainObject(value)) {
    const map = new Map<string, unknown>();
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue; // JSON has no `undefined`; drop the member.
      const nk = k.normalize('NFC');
      if (map.has(nk)) {
        throw new CanonicalError(`duplicate object key after NFC normalization: ${nk}`);
      }
      map.set(nk, v);
    }
    const keys = [...map.keys()].sort(compareByCodePoint);
    const parts = keys.map((k) => serializeString(k) + ':' + write(map.get(k)));
    return '{' + parts.join(',') + '}';
  }

  throw new CanonicalError('unsupported object value (not a plain object or array)');
}

/** Serialize a value to its frozen canonical string form (CCE §12.7). */
export function serializeCanonical(value: unknown): string {
  return write(value);
}
