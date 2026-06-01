// Deterministic transaction planner (Epic E7 / EDAM-T049).
//
// `planTransactions(seed)` is a PURE function: the same seed always produces
// the identical plan. This determinism is what lets the same generated traffic
// back both integration tests and the pinned conformance fixtures (EDAM-T050).
// It performs NO I/O and depends on nothing from Epic E1 (canonical) — it only
// emits SQL to apply against the dev database.

import type { SqlOp, TxPlan } from './types.js';

/** mulberry32 — a small, deterministic 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fixed scenario transactions that exercise every operation type and mirror
 * the conformance fixtures (donation amount after approval, wallet balance
 * edit, beneficiary delete with balance, campaign delete, permission change,
 * mass update, DDL, truncate). These are always present and identical.
 */
function scenarioTransactions(): TxPlan[] {
  const scenarios: ReadonlyArray<{ label: string; ops: SqlOp[] }> = [
    {
      label: 'donation-amount-changed-after-approval',
      ops: [
        {
          op: 'UPDATE',
          table: 'donations',
          description: 'Tamper: raise an approved donation amount',
          sql: "UPDATE kafel.donations SET amount = 100000.00 WHERE id = 90211;",
        },
      ],
    },
    {
      label: 'wallet-balance-manually-updated',
      ops: [
        {
          op: 'UPDATE',
          table: 'wallets',
          description: 'Direct wallet balance edit',
          sql: "UPDATE kafel.wallets SET balance = 9250.00 WHERE id = 4412;",
        },
      ],
    },
    {
      label: 'beneficiary-deleted-with-active-balance',
      ops: [
        {
          op: 'DELETE',
          table: 'beneficiaries',
          description: 'Delete a beneficiary that still holds a balance',
          sql: "DELETE FROM kafel.beneficiaries WHERE id = 5567;",
        },
      ],
    },
    {
      label: 'campaign-deleted-with-donations',
      ops: [
        {
          op: 'DELETE',
          table: 'campaigns',
          description: 'Delete a campaign that has donations',
          sql: "DELETE FROM kafel.campaigns WHERE id = 88;",
        },
      ],
    },
    {
      label: 'permission-change',
      ops: [
        {
          op: 'UPDATE',
          table: 'user_roles',
          description: 'Elevate a user role',
          sql: "UPDATE kafel.user_roles SET role_id = 1 WHERE user_id = 778 AND role_id = 2;",
        },
      ],
    },
    {
      label: 'mass-update',
      ops: [
        {
          op: 'UPDATE',
          table: 'donations',
          description: 'Bulk status change across donations',
          sql: "UPDATE kafel.donations SET status = 'settled' WHERE status = 'approved';",
        },
      ],
    },
    {
      label: 'schema-change-ddl',
      ops: [
        {
          op: 'DDL',
          table: 'donations',
          description: 'Add a column (schema tamper scenario)',
          sql: "ALTER TABLE kafel.donations ADD COLUMN IF NOT EXISTS note VARCHAR(255) NULL;",
        },
      ],
    },
    {
      label: 'truncate-scratch',
      ops: [
        {
          op: 'TRUNCATE',
          table: 'audit_scratch',
          description: 'Truncate a table (no per-row before-image)',
          sql: "TRUNCATE TABLE kafel.audit_scratch;",
        },
      ],
    },
  ];

  return scenarios.map((s, i) => ({ seq: i, label: s.label, ops: s.ops }));
}

/**
 * Build a deterministic plan: the fixed scenarios followed by `randomCount`
 * pseudo-random INSERT transactions derived from `seed`.
 */
export function planTransactions(seed: number, randomCount = 8): TxPlan[] {
  const rand = mulberry32(seed);
  const plans: TxPlan[] = scenarioTransactions();

  let nextDonationId = 900000 + (Math.floor(rand() * 1000) | 0);
  for (let i = 0; i < randomCount; i++) {
    const id = nextDonationId++;
    const campaignId = rand() < 0.5 ? 88 : 89;
    const userId = 778 + (Math.floor(rand() * 3) | 0);
    const amount = (5 + Math.floor(rand() * 495)).toFixed(2);
    const op: SqlOp = {
      op: 'INSERT',
      table: 'donations',
      description: 'Randomized donation insert',
      sql:
        `INSERT INTO kafel.donations (id, campaign_id, user_id, amount, status) ` +
        `VALUES (${id}, ${campaignId}, ${userId}, ${amount}, 'pending');`,
    };
    plans.push({ seq: plans.length, label: `random-insert-${i}`, ops: [op] });
  }

  return plans;
}
