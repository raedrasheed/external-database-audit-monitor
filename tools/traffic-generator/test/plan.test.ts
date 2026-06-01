// Tests for the deterministic transaction planner (Epic E7 / EDAM-T049).
import { describe, it, expect } from 'vitest';
import { planTransactions } from '../src/plan.js';
import type { Operation } from '../src/types.js';

describe('planTransactions', () => {
  it('is deterministic for a given seed', () => {
    const a = planTransactions(42);
    const b = planTransactions(42);
    expect(a).toEqual(b);
  });

  it('produces different randomized tails for different seeds', () => {
    const a = planTransactions(42);
    const b = planTransactions(43);
    // Fixed scenarios are identical; the randomized inserts differ.
    expect(a).not.toEqual(b);
  });

  it('covers every operation type', () => {
    const ops = new Set<Operation>();
    for (const plan of planTransactions(1)) {
      for (const op of plan.ops) ops.add(op.op);
    }
    expect(ops).toEqual(new Set<Operation>(['INSERT', 'UPDATE', 'DELETE', 'DDL', 'TRUNCATE']));
  });

  it('always emits the fixed scenario transactions first, in order', () => {
    const plans = planTransactions(7);
    expect(plans[0]?.label).toBe('donation-amount-changed-after-approval');
    expect(plans[1]?.label).toBe('wallet-balance-manually-updated');
    expect(plans[2]?.label).toBe('beneficiary-deleted-with-active-balance');
    expect(plans[3]?.label).toBe('campaign-deleted-with-donations');
    expect(plans[4]?.label).toBe('permission-change');
  });

  it('honors the random transaction count', () => {
    const scenarios = 8;
    expect(planTransactions(5, 0)).toHaveLength(scenarios);
    expect(planTransactions(5, 12)).toHaveLength(scenarios + 12);
  });

  it('emits monetary values with exact 2-decimal formatting (never float)', () => {
    for (const plan of planTransactions(99)) {
      for (const op of plan.ops) {
        if (op.op === 'INSERT' && op.table === 'donations') {
          expect(op.sql).toMatch(/, \d+\.\d{2}, 'pending'/);
        }
      }
    }
  });
});
