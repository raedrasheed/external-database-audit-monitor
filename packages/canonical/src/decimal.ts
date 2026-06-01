// Exact-decimal handling and float rejection (Epic E1 / EDAM-T005).
//
// CCE §12.8: monetary/decimal values MUST be exact strings, never IEEE floats.
// This module provides the public helpers used by the CCE Builder and the
// contracts validator to enforce that and to compare money exactly (BigInt
// scaling, no floating point).

import { CanonicalError } from './errors.js';

// Optional sign, no leading zeros (except a lone 0), optional fractional part.
const EXACT_DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
// Negative-zero forms (-0, -0.0, -0.00, ...) are ambiguous and disallowed.
const NEGATIVE_ZERO_RE = /^-0(?:\.0+)?$/;

/** True iff `s` is a well-formed exact decimal string (e.g. "100.00", "-7", "0"). */
export function isExactDecimalString(s: string): boolean {
  return EXACT_DECIMAL_RE.test(s) && !NEGATIVE_ZERO_RE.test(s);
}

/** Throw unless `s` is a well-formed exact decimal string. */
export function assertExactDecimal(s: string): void {
  if (typeof s !== 'string' || !isExactDecimalString(s)) {
    throw new CanonicalError(`not an exact decimal string: ${JSON.stringify(s)}`);
  }
}

/**
 * Reject floating-point numbers where an exact value is required. A JS `number`
 * is accepted only if it is a safe integer; a non-integer (float) is rejected
 * because money/decimals must be strings (§12.8). Strings are passed through
 * here (validate them with assertExactDecimal).
 */
export function assertNotFloat(value: unknown, label = 'value'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalError(`${label} is non-finite: ${String(value)}`);
    }
    if (!Number.isInteger(value)) {
      throw new CanonicalError(
        `${label} is a floating-point number (${String(value)}); money/decimals must be ` +
          `exact strings (CCE §12.8)`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalError(`${label} is an unsafe integer (${String(value)}); use a string or bigint`);
    }
  }
}

function toScaled(s: string, scale: number): bigint {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const int = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? '' : body.slice(dot + 1);
  const v = BigInt(int + frac.padEnd(scale, '0'));
  return neg ? -v : v;
}

/**
 * Compare two exact decimal strings by value (not lexically). Returns -1, 0, 1.
 * Uses BigInt scaling — never floating point — so "100.00" === "100" and
 * "9.9" < "10".
 */
export function compareDecimal(a: string, b: string): number {
  assertExactDecimal(a);
  assertExactDecimal(b);
  const fa = a.includes('.') ? a.length - a.indexOf('.') - 1 : 0;
  const fb = b.includes('.') ? b.length - b.indexOf('.') - 1 : 0;
  const scale = Math.max(fa, fb);
  const va = toScaled(a, scale);
  const vb = toScaled(b, scale);
  return va < vb ? -1 : va > vb ? 1 : 0;
}

/** Value equality for exact decimals ("100.00" equals "100"). */
export function decimalEquals(a: string, b: string): boolean {
  return compareDecimal(a, b) === 0;
}
