// Tests for deterministic UUIDv5 / envelope_id (Epic E1 / EDAM-T003).
import { describe, it, expect } from 'vitest';
import { uuidv5, envelopeId, EDAM_CCE_NAMESPACE } from '../src/index.js';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidv5', () => {
  it('matches the RFC 4122 v5 reference vector', () => {
    // Well-known: v5("www.example.com", DNS namespace).
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is deterministic and sets version 5 + RFC 4122 variant', () => {
    const u = uuidv5('edam', DNS_NAMESPACE);
    expect(u).toBe(uuidv5('edam', DNS_NAMESPACE));
    expect(u.charAt(14)).toBe('5'); // version nibble
    expect(['8', '9', 'a', 'b']).toContain(u.charAt(19).toLowerCase()); // variant nibble
  });
});

describe('EDAM_CCE_NAMESPACE', () => {
  it('is the pinned, reproducibly-derived namespace', () => {
    expect(EDAM_CCE_NAMESPACE).toBe('03d76635-7b81-5e2a-94a4-fd03abda111f');
  });
});

describe('envelopeId', () => {
  it('derives the pinned envelope_id for known parts (CCE §3)', () => {
    const id = envelopeId({
      db_id: 'kafel-dev-mysql',
      tx_id: '00000000-0000-0000-0000-0000000000aa:1',
      server_uuid: '00000000-0000-0000-0000-0000000000aa',
    });
    expect(id).toBe('a82d6b80-0543-51e9-b526-03fe8485faad');
  });

  it('is idempotent for identical inputs (replay dedupe)', () => {
    const parts = { db_id: 'd', tx_id: 't', server_uuid: 's' };
    expect(envelopeId(parts)).toBe(envelopeId(parts));
  });

  it('differs when any derivation input differs', () => {
    const base = { db_id: 'd', tx_id: 't', server_uuid: 's' };
    expect(envelopeId(base)).not.toBe(envelopeId({ ...base, tx_id: 't2' }));
    expect(envelopeId(base)).not.toBe(envelopeId({ ...base, db_id: 'd2' }));
    expect(envelopeId(base)).not.toBe(envelopeId({ ...base, server_uuid: 's2' }));
  });

  it('distinguishes size-split parts', () => {
    const base = { db_id: 'd', tx_id: 't', server_uuid: 's' };
    expect(envelopeId({ ...base, part: 0 })).not.toBe(envelopeId({ ...base, part: 1 }));
    expect(envelopeId(base)).not.toBe(envelopeId({ ...base, part: 0 }));
  });
});
