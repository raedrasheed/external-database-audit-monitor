// Tests for the hash-chain link helper (Epic E1 / EDAM-T004).
import { describe, it, expect } from 'vitest';
import { rowHash, GENESIS_ROW_HASH, CanonicalError } from '../src/index.js';

const EV = 'sha256:5b253115b537a6eb9cf9ea7a68abad9b0873af07f8d7b0d6d2f436950e2f6a45';

describe('rowHash', () => {
  it('GENESIS_ROW_HASH is all-zero', () => {
    expect(GENESIS_ROW_HASH).toBe('sha256:' + '0'.repeat(64));
  });

  it('reproduces the pinned genesis link (determinism)', () => {
    expect(rowHash(GENESIS_ROW_HASH, EV)).toBe(
      'sha256:daa90e3f92243ac1fa33611d9b9e1f6a38dc88976e45590d2d222c5eb5e11f43',
    );
  });

  it('is order-sensitive (prev ‖ event, not event ‖ prev)', () => {
    expect(rowHash(GENESIS_ROW_HASH, EV)).not.toBe(rowHash(EV, GENESIS_ROW_HASH));
  });

  it('chains deterministically across links', () => {
    const h1 = rowHash(GENESIS_ROW_HASH, EV);
    const h2a = rowHash(h1, EV);
    const h2b = rowHash(h1, EV);
    expect(h2a).toBe(h2b);
    expect(h2a).not.toBe(h1);
  });

  it('rejects malformed hash tokens', () => {
    expect(() => rowHash('not-a-hash', EV)).toThrow(CanonicalError);
    expect(() => rowHash(GENESIS_ROW_HASH, 'sha256:zz')).toThrow(CanonicalError);
  });
});
