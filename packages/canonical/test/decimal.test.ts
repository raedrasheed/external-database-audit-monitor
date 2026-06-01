// Tests for exact-decimal handling & float rejection (Epic E1 / EDAM-T005).
import { describe, it, expect } from 'vitest';
import {
  isExactDecimalString,
  assertExactDecimal,
  assertNotFloat,
  compareDecimal,
  decimalEquals,
  CanonicalError,
} from '../src/index.js';

describe('isExactDecimalString', () => {
  it('accepts well-formed exact decimals', () => {
    for (const s of ['0', '100.00', '-7', '9250.00', '45200.00', '0.5', '-0.01']) {
      expect(isExactDecimalString(s)).toBe(true);
    }
  });

  it('rejects malformed / float-ish strings', () => {
    for (const s of ['', '1.', '.5', '01', '1e3', '1,000.00', 'NaN', '+1', '-0']) {
      expect(isExactDecimalString(s)).toBe(false);
    }
  });
});

describe('assertExactDecimal', () => {
  it('throws on invalid decimals', () => {
    expect(() => assertExactDecimal('1e3')).toThrow(CanonicalError);
    expect(() => assertExactDecimal('abc')).toThrow(CanonicalError);
  });
});

describe('assertNotFloat', () => {
  it('accepts safe integers', () => {
    expect(() => assertNotFloat(90211)).not.toThrow();
    expect(() => assertNotFloat(0)).not.toThrow();
  });

  it('rejects floats, non-finite, and unsafe integers', () => {
    expect(() => assertNotFloat(100.5, 'amount')).toThrow(CanonicalError);
    expect(() => assertNotFloat(0.1 + 0.2)).toThrow(CanonicalError);
    expect(() => assertNotFloat(NaN)).toThrow(CanonicalError);
    expect(() => assertNotFloat(Number.MAX_SAFE_INTEGER + 1)).toThrow(CanonicalError);
  });

  it('passes through non-number values (validate strings separately)', () => {
    expect(() => assertNotFloat('100.00')).not.toThrow();
  });
});

describe('compareDecimal / decimalEquals', () => {
  it('compares by value, not lexically', () => {
    expect(compareDecimal('9.9', '10')).toBe(-1);
    expect(compareDecimal('10', '9.9')).toBe(1);
    expect(compareDecimal('100.00', '100')).toBe(0);
  });

  it('handles negatives and differing scales exactly (no float error)', () => {
    expect(compareDecimal('-0.01', '0')).toBe(-1);
    expect(compareDecimal('0.10', '0.1')).toBe(0);
    expect(decimalEquals('45200.00', '45200')).toBe(true);
    expect(decimalEquals('100.00', '100000.00')).toBe(false);
  });
});
