// Tests for the field-level diff engine (Epic E4 / EDAM-T029).
import { describe, it, expect } from 'vitest';
import { diffFields, inferType } from '../src/index.js';
import type { NormalizedChange } from '../src/index.js';

const obj = (schema: string, name: string): NormalizedChange['object'] => ({ schema, name, primary_key: { id: 1 } });

describe('inferType', () => {
  it('classifies values deterministically', () => {
    expect(inferType('100.00')).toBe('decimal');
    expect(inferType('-7.5')).toBe('decimal');
    expect(inferType('1099887766')).toBe('string'); // numeric-looking id, no decimal point
    expect(inferType('approved')).toBe('string');
    expect(inferType(90211)).toBe('int');
    expect(inferType(true)).toBe('bool');
    expect(inferType({ a: 1 })).toBe('json');
    expect(inferType(null)).toBe('null');
  });
});

describe('diffFields', () => {
  it('UPDATE: only changed columns, with old/new and data_type', () => {
    const fc = diffFields({
      operation: 'UPDATE',
      object: obj('kafel', 'donations'),
      before: { id: 90211, amount: '100.00', status: 'approved' },
      after: { id: 90211, amount: '100000.00', status: 'approved' },
    });
    expect(fc).toEqual([
      { path: ['amount'], old: '100.00', new: '100000.00', data_type: 'decimal', changed: true, sensitive: false },
    ]);
  });

  it('INSERT: one entry per after column with old=null', () => {
    const fc = diffFields({ operation: 'INSERT', object: obj('kafel', 'donations'), before: null, after: { id: 1, amount: '5.00' } });
    expect(fc).toEqual([
      { path: ['amount'], old: null, new: '5.00', data_type: 'decimal', changed: true, sensitive: false },
      { path: ['id'], old: null, new: 1, data_type: 'int', changed: true, sensitive: false },
    ]);
  });

  it('DELETE: one entry per before column with new=null', () => {
    const fc = diffFields({ operation: 'DELETE', object: obj('kafel', 'beneficiaries'), before: { id: 5567, balance: '1320.00', status: 'active' }, after: null });
    expect(fc?.map((c) => c.path[0])).toEqual(['balance', 'id', 'status']); // sorted
    expect(fc?.find((c) => c.path[0] === 'balance')).toMatchObject({ old: '1320.00', new: null, data_type: 'decimal' });
  });

  it('DDL/TRUNCATE produce no field_changes', () => {
    expect(diffFields({ operation: 'DDL', object: obj('kafel', 'donations'), before: null, after: null, ddl: { statement: 'ALTER' } })).toBeUndefined();
    expect(diffFields({ operation: 'TRUNCATE', object: obj('kafel', 'audit_scratch'), before: null, after: null })).toBeUndefined();
  });

  it('output is sorted by path (deterministic across machines)', () => {
    const fc = diffFields({ operation: 'INSERT', object: obj('kafel', 't'), before: null, after: { z: 1, a: 2, m: 3 } });
    expect(fc?.map((c) => c.path[0])).toEqual(['a', 'm', 'z']);
  });

  it('treats deep-equal nested values as unchanged', () => {
    const fc = diffFields({ operation: 'UPDATE', object: obj('kafel', 't'), before: { meta: { a: 1 }, x: 1 }, after: { meta: { a: 1 }, x: 2 } });
    expect(fc?.map((c) => c.path[0])).toEqual(['x']);
  });
});
