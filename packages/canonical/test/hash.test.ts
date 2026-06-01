// Tests for hashing primitives + frozen golden vectors (Epic E1 / EDAM-T002).
//
// The golden hashes below were computed by SHA-256 over the canonical bytes and
// are pinned to prove determinism: the implementation must reproduce them
// exactly on every machine/run. They are REAL SHA-256 digests of known
// canonical strings — not fabricated CCE event hashes.
import { describe, it, expect } from 'vitest';
import { sha256Hex, eventHash, hashValue } from '../src/index.js';
import { serializeCanonical } from '../src/index.js';

describe('sha256Hex / eventHash golden vectors', () => {
  it('hashes the empty string (NIST vector)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes the canonical empty object', () => {
    expect(sha256Hex(serializeCanonical({}))).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('produces the pinned event_hash for a known canonical value', () => {
    const value = { id: 90211, amount: '100.00', status: 'approved' };
    expect(serializeCanonical(value)).toBe('{"amount":"100.00","id":90211,"status":"approved"}');
    expect(hashValue(value)).toBe(
      'sha256:5b253115b537a6eb9cf9ea7a68abad9b0873af07f8d7b0d6d2f436950e2f6a45',
    );
  });

  it('eventHash returns the sha256:<64hex> token form', () => {
    expect(eventHash('')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is order-independent through canonicalization (determinism)', () => {
    const a = hashValue({ a: 1, b: 2 });
    const b = hashValue({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('is stable across repeated runs', () => {
    const v = { x: ['a', 'b'], y: true, z: null };
    expect(hashValue(v)).toBe(hashValue(v));
  });
});
