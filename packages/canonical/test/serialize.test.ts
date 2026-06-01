// Tests for canonical serialization (Epic E1 / EDAM-T001).
import { describe, it, expect } from 'vitest';
import { serializeCanonical, compareByCodePoint, CanonicalError } from '../src/index.js';

describe('serializeCanonical', () => {
  it('sorts object keys by code point and emits no whitespace', () => {
    expect(serializeCanonical({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('is order-independent for object inputs (deterministic)', () => {
    const a = serializeCanonical({ amount: '100.00', id: 90211, status: 'approved' });
    const b = serializeCanonical({ status: 'approved', id: 90211, amount: '100.00' });
    expect(a).toBe(b);
    expect(a).toBe('{"amount":"100.00","id":90211,"status":"approved"}');
  });

  it('preserves array order', () => {
    expect(serializeCanonical([3, 1, 2])).toBe('[3,1,2]');
    expect(serializeCanonical(['amount'])).toBe('["amount"]');
  });

  it('serializes nulls and booleans explicitly', () => {
    expect(serializeCanonical({ a: null, b: true, c: false })).toBe('{"a":null,"b":true,"c":false}');
  });

  it('serializes integers as plain decimal, including bigint', () => {
    expect(serializeCanonical(90211)).toBe('90211');
    expect(serializeCanonical(-7)).toBe('-7');
    expect(serializeCanonical(0)).toBe('0');
    expect(serializeCanonical(-0)).toBe('0');
    expect(serializeCanonical(9007199254740993n)).toBe('9007199254740993');
  });

  it('rejects non-integer (float) numbers — money must be exact strings', () => {
    expect(() => serializeCanonical(100.5)).toThrow(CanonicalError);
    expect(() => serializeCanonical({ amount: 100.0 + 0.1 })).toThrow(CanonicalError);
  });

  it('rejects non-finite and unsafe integers', () => {
    expect(() => serializeCanonical(NaN)).toThrow(CanonicalError);
    expect(() => serializeCanonical(Infinity)).toThrow(CanonicalError);
    expect(() => serializeCanonical(Number.MAX_SAFE_INTEGER + 1)).toThrow(CanonicalError);
  });

  it('NFC-normalizes strings and keys so equivalent forms collapse', () => {
    // "é" composed (U+00E9) vs decomposed (e + U+0301) must serialize identically.
    const composed = serializeCanonical({ name: 'é' });
    const decomposed = serializeCanonical({ name: 'é' });
    expect(composed).toBe(decomposed);
  });

  it('rejects duplicate keys that collide after NFC normalization', () => {
    expect(() => serializeCanonical({ 'é': 1, 'é': 2 })).toThrow(CanonicalError);
  });

  it('drops undefined object members (JSON has no undefined)', () => {
    expect(serializeCanonical({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('escapes strings deterministically', () => {
    expect(serializeCanonical('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });
});

describe('compareByCodePoint', () => {
  it('orders by code point, not UTF-16 code unit', () => {
    // U+FFFF (BMP) has a smaller code point than U+10000 (astral). UTF-16 code
    // unit order would mis-rank the astral char (lead surrogate 0xD800).
    const bmp = '￿';
    const astral = '\u{10000}';
    expect(compareByCodePoint(bmp, astral)).toBeLessThan(0);
    expect(compareByCodePoint('a', 'b')).toBeLessThan(0);
    expect(compareByCodePoint('a', 'a')).toBe(0);
  });
});
