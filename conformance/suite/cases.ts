// Conformance cases (Epic E6 / EDAM-T042..T046, mandate B).
// Each case exercises the REAL frozen implementations.

import { buildCce, compareCce, type NormalizedChange, type NormalizedTransaction } from '@edam/cce-model';
import type { ConformanceCase, ConformanceOutcome } from './types.js';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';

function txWith(seq: number, changes: NormalizedChange[]): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: { state: 'HEALTHY', source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } },
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes,
  };
}

function ok(detail: string): ConformanceOutcome {
  return { passed: true, detail };
}
function fail(detail: string): ConformanceOutcome {
  return { passed: false, detail };
}

const don = (pk: number): NormalizedChange['object'] => ({ schema: 'kafel', name: 'donations', primary_key: { id: pk } });

// ---------------------------------------------------------------------------
// C-3: INSERT / UPDATE / DELETE / DDL / TRUNCATE representation + before/after
// nullity (CCE §5).
// ---------------------------------------------------------------------------
export const C3: ConformanceCase = {
  id: 'C-3',
  title: 'Operation representations + before/after nullity',
  spec_ref: 'CCE-v1-Specification.md §5; companion §6.8',
  run(): ConformanceOutcome {
    try {
      const insert = buildCce(txWith(1, [{ operation: 'INSERT', object: don(1), before: null, after: { id: 1, amount: '5.00' } }])).changes[0]!;
      if (insert.operation !== 'INSERT' || insert.before !== null || insert.after === null || !insert.field_changes) {
        return fail('INSERT must have before=null, non-null after, field_changes');
      }
      const update = buildCce(txWith(2, [{ operation: 'UPDATE', object: don(2), before: { id: 2, amount: '1.00' }, after: { id: 2, amount: '2.00' } }])).changes[0]!;
      if (update.operation !== 'UPDATE' || !update.before || !update.after || !update.field_changes) {
        return fail('UPDATE must have before+after+field_changes');
      }
      const del = buildCce(txWith(3, [{ operation: 'DELETE', object: don(3), before: { id: 3, amount: '9.00' }, after: null }])).changes[0]!;
      if (del.operation !== 'DELETE' || !del.before || del.after !== null || !del.field_changes) {
        return fail('DELETE must have before, after=null, field_changes');
      }
      const ddl = buildCce(txWith(4, [{ operation: 'DDL', object: { schema: 'kafel', name: 'donations' }, before: null, after: null, ddl: { statement: 'ALTER TABLE kafel.donations ADD COLUMN note VARCHAR(255)' } }])).changes[0]!;
      if (ddl.operation !== 'DDL' || ddl.field_changes !== undefined || !ddl.ddl) {
        return fail('DDL must have no field_changes and a ddl payload');
      }
      const trunc = buildCce(txWith(5, [{ operation: 'TRUNCATE', object: { schema: 'kafel', name: 'audit_scratch' }, before: null, after: null }])).changes[0]!;
      if (trunc.operation !== 'TRUNCATE' || trunc.field_changes !== undefined) {
        return fail('TRUNCATE must have no field_changes');
      }
      return ok('All five operations represented with correct nullity (§5).');
    } catch (err) {
      return fail(`build threw: ${String((err as Error).message ?? err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// C-4: multi-row transaction -> one envelope, contiguous seq, statement_count.
// ---------------------------------------------------------------------------
export const C4: ConformanceCase = {
  id: 'C-4',
  title: 'Multi-row transaction grouping',
  spec_ref: 'CCE-v1-Specification.md §4.1, §6.2',
  run(): ConformanceOutcome {
    const cce = buildCce(
      txWith(10, [
        { operation: 'UPDATE', object: don(1), before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } },
        { operation: 'INSERT', object: don(2), before: null, after: { id: 2, amount: '3.00' } },
        { operation: 'DELETE', object: don(3), before: { id: 3, amount: '4.00' }, after: null },
      ]),
    );
    if (cce.transaction.statement_count !== 3) return fail(`statement_count ${cce.transaction.statement_count} != 3`);
    const seqs = cce.changes.map((c) => c.seq);
    if (JSON.stringify(seqs) !== JSON.stringify([0, 1, 2])) return fail(`seq ${JSON.stringify(seqs)} not contiguous from 0`);
    return ok('Three row changes grouped into one envelope; seq 0..2; statement_count=3.');
  },
};

// ---------------------------------------------------------------------------
// C-5: deterministic global order — equal commit_ts tie-broken by offset key.
// ---------------------------------------------------------------------------
export const C5: ConformanceCase = {
  id: 'C-5',
  title: 'Deterministic ordering on equal commit_ts',
  spec_ref: 'CCE-v1-Specification.md §4.2',
  run(): ConformanceOutcome {
    const a = buildCce(txWith(5, [{ operation: 'UPDATE', object: don(1), before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }]));
    const b = buildCce(txWith(9, [{ operation: 'UPDATE', object: don(1), before: { id: 1, amount: '2.00' }, after: { id: 1, amount: '3.00' } }]));
    // Same commit_ts (from txWith); GTID seq 5 < 9 must order a before b.
    if (a.transaction.commit_ts !== b.transaction.commit_ts) return fail('commit_ts not equal — test setup wrong');
    if (!(compareCce(a, b) < 0 && compareCce(b, a) > 0 && compareCce(a, a) === 0)) {
      return fail('compareCce did not order by GTID sequence on equal commit_ts');
    }
    return ok('Equal commit_ts tie-broken deterministically by GTID sequence (5<9).');
  },
};

export const CASES: ConformanceCase[] = [C3, C4, C5];
