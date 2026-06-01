// Tests for deterministic envelope_id (Epic E4 / EDAM-T033).
import { describe, it, expect } from 'vitest';
import { buildCce, deriveEnvelopeId } from '../src/index.js';
import { makeTx } from './build.test.js';

describe('deriveEnvelopeId', () => {
  it('matches the id the builder embeds (CCE §3)', () => {
    const tx = makeTx();
    expect(buildCce(tx).envelope_id).toBe(deriveEnvelopeId(tx));
  });

  it('is deterministic and a valid UUID', () => {
    const tx = makeTx();
    expect(deriveEnvelopeId(tx)).toBe(deriveEnvelopeId(tx));
    expect(deriveEnvelopeId(tx)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('changes when any derivation input changes', () => {
    const base = makeTx();
    const id = deriveEnvelopeId(base);
    expect(deriveEnvelopeId({ ...base, transaction: { ...base.transaction, tx_id: 'other:1' } })).not.toBe(id);
    expect(deriveEnvelopeId({ ...base, source: { ...base.source, db_id: 'other-db' } })).not.toBe(id);
    expect(deriveEnvelopeId({ ...base, source: { ...base.source, server_uuid: 'other-srv' } })).not.toBe(id);
  });

  it('distinguishes size-split parts (helper level; part-split full build is out of MVP scope)', () => {
    const tx = makeTx();
    expect(deriveEnvelopeId(tx, 0)).not.toBe(deriveEnvelopeId(tx, 1));
    expect(deriveEnvelopeId(tx)).not.toBe(deriveEnvelopeId(tx, 0));
  });
});
