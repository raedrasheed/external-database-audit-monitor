// Tests for deterministic DLQ hashing (Epic E5 / EDAM-T037).
import { describe, it, expect } from 'vitest';
import { payloadHash, deterministicEventId, stableStringify } from '../src/index.js';

describe('payloadHash (deterministic)', () => {
  it('is order-independent for objects', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('matches the sha256:<hex> shape and is stable across calls', () => {
    const h = payloadHash({ op: 'u', source: { table: 'donations' } });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payloadHash({ op: 'u', source: { table: 'donations' } })).toBe(h);
  });

  it('hashes raw string payloads (e.g. malformed JSON text)', () => {
    expect(payloadHash('{not valid json')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payloadHash('x')).toBe(payloadHash('x'));
    expect(payloadHash('x')).not.toBe(payloadHash('y'));
  });

  it('never throws on floats or unusual payloads (a failing payload must hash)', () => {
    expect(() => payloadHash({ amount: 100.5 })).not.toThrow();
    expect(() => payloadHash(null)).not.toThrow();
    expect(() => payloadHash(undefined)).not.toThrow();
    expect(() => payloadHash(123n)).not.toThrow(); // bigint -> String() fallback
  });
});

describe('deterministicEventId', () => {
  it('is deterministic for the same (engine, offset, hash)', () => {
    const h = payloadHash({ a: 1 });
    expect(deterministicEventId('mysql', 'g:1', h)).toBe(deterministicEventId('mysql', 'g:1', h));
    expect(deterministicEventId('mysql', 'g:1', h)).toMatch(/^dlq-[0-9a-f]{32}$/);
  });

  it('differs when payload, offset, or engine differ', () => {
    const h1 = payloadHash({ a: 1 });
    const h2 = payloadHash({ a: 2 });
    expect(deterministicEventId('mysql', 'g:1', h1)).not.toBe(deterministicEventId('mysql', 'g:1', h2));
    expect(deterministicEventId('mysql', 'g:1', h1)).not.toBe(deterministicEventId('mysql', 'g:2', h1));
    expect(deterministicEventId('mysql', 'g:1', h1)).not.toBe(deterministicEventId('mariadb', 'g:1', h1));
  });
});

describe('stableStringify', () => {
  it('sorts keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
