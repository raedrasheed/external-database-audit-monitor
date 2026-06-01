// Tests for sensitive-field masking (Epic E4 / EDAM-T030).
import { describe, it, expect } from 'vitest';
import { maskImage, maskFieldChanges, isSensitiveColumn, MASK, diffFields } from '../src/index.js';

const sens = new Set(['kafel.beneficiaries.national_id', 'beneficiaries.name']);

describe('isSensitiveColumn', () => {
  it('matches by schema.table.col, table.col, and bare col', () => {
    expect(isSensitiveColumn('national_id', 'kafel', 'beneficiaries', sens)).toBe(true);
    expect(isSensitiveColumn('name', 'kafel', 'beneficiaries', sens)).toBe(true);
    expect(isSensitiveColumn('balance', 'kafel', 'beneficiaries', sens)).toBe(false);
    expect(isSensitiveColumn('national_id', 'kafel', 'users', sens)).toBe(false); // table-scoped
  });
});

describe('maskImage', () => {
  it('masks sensitive non-null values, leaves others and nulls', () => {
    const masked = maskImage(
      { id: 5567, name: 'Aid Recipient A', national_id: '2011223344', balance: '1320.00' },
      'kafel', 'beneficiaries', sens,
    );
    expect(masked).toEqual({ id: 5567, name: MASK, national_id: MASK, balance: '1320.00' });
  });

  it('returns null for a null image and copies when no sensitive fields', () => {
    expect(maskImage(null, 'kafel', 'beneficiaries', sens)).toBeNull();
    expect(maskImage({ a: 1 }, 'kafel', 'x', new Set())).toEqual({ a: 1 });
  });
});

describe('maskFieldChanges', () => {
  it('masks sensitive field_changes (value -> ***), preserving data_type', () => {
    const fc = diffFields({
      operation: 'DELETE',
      object: { schema: 'kafel', name: 'beneficiaries', primary_key: { id: 5567 } },
      before: { id: 5567, name: 'Aid Recipient A', national_id: '2011223344', balance: '1320.00', status: 'active' },
      after: null,
    });
    const masked = maskFieldChanges(fc, 'kafel', 'beneficiaries', sens)!;
    const name = masked.find((c) => c.path[0] === 'name')!;
    expect(name).toMatchObject({ old: MASK, new: null, sensitive: true, masked: true, data_type: 'string' });
    const nid = masked.find((c) => c.path[0] === 'national_id')!;
    expect(nid).toMatchObject({ old: MASK, sensitive: true, masked: true });
    const balance = masked.find((c) => c.path[0] === 'balance')!;
    expect(balance).toMatchObject({ old: '1320.00', sensitive: false, data_type: 'decimal' });
  });

  it('never emits the raw sensitive value', () => {
    const fc = diffFields({ operation: 'INSERT', object: { schema: 'kafel', name: 'beneficiaries' }, before: null, after: { name: 'Secret Person' } });
    const masked = maskFieldChanges(fc, 'kafel', 'beneficiaries', sens)!;
    expect(JSON.stringify(masked)).not.toContain('Secret Person');
  });
});
