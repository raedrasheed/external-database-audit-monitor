// Conformance cases (Epic E6 / EDAM-T042..T046, mandate B).
// Each case exercises the REAL frozen implementations.

import {
  buildCce,
  compareCce,
  orderCces,
  CceBuildError,
  type NormalizedChange,
  type NormalizedChangeEvent,
  type NormalizedTransaction,
} from '@edam/cce-model';
import { serializeCanonical } from '@edam/canonical';
import { CceStreamGuard, TransactionAccumulator, assembleTransaction, correlateActor } from '@edam/normalization';
import { validateCceFull } from '@edam/contracts';
import { assessFidelity } from '@edam/cdc-collector/attestation';
import { CompletenessWatcher } from '@edam/cdc-collector/completeness';
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

// ---------------------------------------------------------------------------
// C-6: replay idempotency + perturbed replay flagged (V15).
// ---------------------------------------------------------------------------
export const C6: ConformanceCase = {
  id: 'C-6',
  title: 'Replay idempotency; perturbed replay flagged (V15)',
  spec_ref: 'CCE-v1-Specification.md §4.5, §10 V15',
  run(): ConformanceOutcome {
    const guard = new CceStreamGuard();
    const a = buildCce(txWith(20, [{ operation: 'UPDATE', object: don(1), before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }]));
    if (guard.check(a).action !== 'EMIT') return fail('first delivery should EMIT');
    if (guard.check(a).action !== 'DUPLICATE') return fail('identical replay should be DUPLICATE (idempotent)');

    // Same tx_id (-> same envelope_id) but different content -> different event_hash.
    const b = buildCce(txWith(20, [{ operation: 'UPDATE', object: don(1), before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '999.00' } }]));
    if (a.envelope_id !== b.envelope_id) return fail('test setup: envelope_id should match');
    const r = guard.check(b);
    if (r.action !== 'INTEGRITY_VIOLATION' || !r.violations.some((v) => v.rule === 'V15')) {
      return fail('duplicate envelope_id with differing event_hash must be V15 INTEGRITY_VIOLATION');
    }
    return ok('Idempotent duplicate skipped; perturbed replay flagged V15.');
  },
};

// ---------------------------------------------------------------------------
// C-7: source row-image downgrade -> DEGRADED + CRITICAL alarm (the C4 attack).
// ---------------------------------------------------------------------------
export const C7: ConformanceCase = {
  id: 'C-7',
  title: 'Row-image downgrade => DEGRADED fidelity + CRITICAL alarm',
  spec_ref: 'CCE-v1-Specification.md §6.4; EDAM-v2-Architecture.md §4 (review C4)',
  run(): ConformanceOutcome {
    const healthy = {
      engine: 'mysql' as const, log_bin: 'ON', binlog_format: 'ROW', binlog_row_image: 'FULL',
      gtid_mode: 'ON', gtid_strict_mode: null, binlog_expire_logs_seconds: 604800, server_uuid: UUID,
    };
    const okRes = assessFidelity(healthy, { minBinlogRetentionSeconds: 86400 });
    if (okRes.assessment.state !== 'HEALTHY') return fail('healthy config should assess HEALTHY');

    const downgraded = assessFidelity({ ...healthy, binlog_row_image: 'MINIMAL' }, { minBinlogRetentionSeconds: 86400 });
    if (downgraded.assessment.state !== 'DEGRADED') return fail(`row_image=MINIMAL should be DEGRADED, got ${downgraded.assessment.state}`);
    if (!downgraded.alarms.some((a) => a.kind === 'CONFIG_DOWNGRADE' && a.severity === 'critical')) {
      return fail('row-image downgrade should raise a CRITICAL CONFIG_DOWNGRADE alarm');
    }
    if (!/binlog_row_image/.test(downgraded.assessment.degraded_reason ?? '')) return fail('degraded_reason should cite binlog_row_image');
    return ok('binlog_row_image=MINIMAL => DEGRADED + CRITICAL alarm; HEALTHY otherwise.');
  },
};

// ---------------------------------------------------------------------------
// C-8: injected GTID gap -> gap_detected.
// ---------------------------------------------------------------------------
export const C8: ConformanceCase = {
  id: 'C-8',
  title: 'Injected GTID gap => gap_detected',
  spec_ref: 'CCE-v1-Specification.md §6.5; EDAM-v2-Architecture.md §4',
  run(): ConformanceOutcome {
    const contiguous = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    for (let n = 1; n <= 5; n++) contiguous.observeConsumed(`${UUID}:${n}`);
    if (contiguous.computeGap(`${UUID}:1-10`).gap_detected) return fail('contiguous consume should not report a gap');

    const holed = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    for (const n of [1, 2, 4, 5]) holed.observeConsumed(`${UUID}:${n}`); // skip 3
    if (!holed.computeGap().gap_detected) return fail('skipped transaction (hole) must report gap_detected');
    return ok('Skipped transaction surfaces gap_detected; contiguous stream does not.');
  },
};

// ---------------------------------------------------------------------------
// C-1: deterministic canonical serialization + hashing (byte-stable).
// ---------------------------------------------------------------------------
export const C1: ConformanceCase = {
  id: 'C-1',
  title: 'Deterministic serialization + hashing (byte-stable)',
  spec_ref: 'CCE-v1-Specification.md §12.7, §8',
  run(): ConformanceOutcome {
    const input = txWith(30, [{ operation: 'UPDATE', object: don(1), before: { id: 1, amount: '1.00', status: 'approved' }, after: { id: 1, amount: '2.00', status: 'approved' } }]);
    const a = buildCce(input);
    const b = buildCce(input);
    if (a.envelope_id !== b.envelope_id || a.evidence.event_hash !== b.evidence.event_hash) {
      return fail('repeated build produced different ids/hashes');
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) return fail('repeated build produced different CCEs');
    // Canonical serialization is order-independent and stable.
    if (serializeCanonical({ a: 1, b: 2 }) !== serializeCanonical({ b: 2, a: 1 })) {
      return fail('canonical serialization is not order-independent');
    }
    return ok('Repeated builds byte-identical; canonical serialization order-independent (cross-target proof in the determinism rig).');
  },
};

// ---------------------------------------------------------------------------
// C-10: attribution exact / probable / unattributed.
// ---------------------------------------------------------------------------
export const C10: ConformanceCase = {
  id: 'C-10',
  title: 'Attribution confidence: exact / probable / unattributed',
  spec_ref: 'CCE-v1-Specification.md §7; companion DB-Audit Event §C',
  run(): ConformanceOutcome {
    const query = { dbId: 'kafel-dev-mysql', commitTs: '2026-06-01T10:00:00.000Z', tables: ['donations'], windowMs: 5000 };
    const cand = { audit_event_id: 'dbaudit:1', db_user: 'ops_admin', connection_id: '338217', event_ts: '2026-06-01T10:00:01.000Z', objects: [{ schema: 'kafel', name: 'donations' }] };

    if (correlateActor(query, []).attribution_confidence !== 'unattributed') return fail('no candidates must be unattributed');
    if (correlateActor(query, [cand]).attribution_confidence !== 'probable') return fail('single window+table candidate must be probable');
    if (correlateActor({ ...query, connectionId: '338217' }, [cand]).attribution_confidence !== 'exact') return fail('hard connection_id match must be exact');
    if (correlateActor(query, [cand, { ...cand, audit_event_id: 'b', connection_id: '999' }]).attribution_confidence !== 'unattributed') {
      return fail('ambiguous candidates must be unattributed');
    }
    return ok('exact (key match) / probable (window+table) / unattributed (none or ambiguous).');
  },
};

// ===========================================================================
// CCE-AMD-001 Rev 4 — snapshot-phase capture conformance (Rev 4 §7).
// Each case exercises the REAL frozen implementations (builder, validator,
// stream guard, ordering).
// ===========================================================================

const HEALTHY_FID = {
  state: 'HEALTHY' as const,
  source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' },
};

function snapshotEvent(pk: number, opts: { ts?: string; file?: string; pos?: number; ref?: unknown } = {}): NormalizedChangeEvent {
  const primary_key = opts.ref !== undefined ? (opts.ref as Record<string, unknown>) : { id: pk };
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    tx_id: null,
    commit_ts: opts.ts ?? '2026-06-01T10:00:00.000Z',
    ingest_ts: '2026-06-01T10:00:00.100Z',
    offset: { gtid: null, binlog_file: opts.file ?? 'mysql-bin.000003', binlog_pos: opts.pos ?? 4096, lsn: null, scn: null, resume_token: null },
    snapshot_phase: 'snapshot',
    change: { operation: 'INSERT', object: { schema: 'kafel', name: 'donations', primary_key }, before: null, after: { id: pk, amount: '1.00' } },
  };
}

function buildSnapshot(ev: NormalizedChangeEvent): NormalizedTransaction {
  return assembleTransaction(new TransactionAccumulator().add(ev)[0]!, HEALTHY_FID, null, { attribution_confidence: 'unattributed' });
}

/** A built, valid cce-1.0 streaming CCE, with evidence removed for mutation. */
function streamingCore(): Record<string, any> {
  const cce = buildCce(txWith(70, [{ operation: 'UPDATE', object: don(1), before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }])) as any;
  const core = structuredClone(cce);
  delete core.evidence; // avoid V12 noise — we test offset/guard rejection
  return core;
}

function rejectsWith(cce: unknown, rule: string): boolean {
  const r = validateCceFull(cce);
  return !r.valid && r.errors.some((e) => e.rule === rule);
}

// C-OFFSET-EMPTY-{GTID,LSN,SCN,RESUME}: empty real keys are rejected (HIGH-1).
export const C_OFFSET_EMPTY: ConformanceCase = {
  id: 'C-OFFSET-EMPTY',
  title: 'Empty real offset keys are rejected (HIGH-1)',
  spec_ref: 'CCE-AMD-001 Rev 4 §1; V11',
  run(): ConformanceOutcome {
    for (const key of ['gtid', 'lsn', 'scn', 'resume_token'] as const) {
      const core = streamingCore();
      core.offset = { gtid: null, binlog_file: null, binlog_pos: null, lsn: null, scn: null, resume_token: null };
      core.offset[key] = ''; // empty real key
      if (!rejectsWith(core, 'V11')) return fail(`empty ${key} was not rejected with V11`);
    }
    return ok('Empty gtid/lsn/scn/resume_token each rejected (V11) — no real-key match.');
  },
};

// C-STREAM-EMPTY-GTID-NO-BYPASS: empty gtid + binlog cannot bypass V16.
export const C_STREAM_EMPTY_GTID: ConformanceCase = {
  id: 'C-STREAM-EMPTY-GTID-NO-BYPASS',
  title: 'Empty gtid + binlog on a streaming event cannot bypass V16',
  spec_ref: 'CCE-AMD-001 Rev 4 §1/§5; V16',
  run(): ConformanceOutcome {
    const core = streamingCore();
    core.offset = { gtid: '', binlog_file: 'mysql-bin.000003', binlog_pos: 4096, lsn: null, scn: null, resume_token: null };
    // schema_version stays cce-1.0, snapshot_phase streaming
    return rejectsWith(core, 'V16')
      ? ok('Streaming gtid:"" + binlog rejected (V16) — empty key is not a real key.')
      : fail('empty-gtid streaming event bypassed V16');
  },
};

// C-STREAM-NOGTID-FAIL: streaming with no GTID fails (phase=streaming AND absent).
export const C_STREAM_NOGTID: ConformanceCase = {
  id: 'C-STREAM-NOGTID-FAIL',
  title: 'Dropped-GTID streaming event fails closed',
  spec_ref: 'CCE-AMD-001 Rev 4 §5; V16',
  run(): ConformanceOutcome {
    const withPhase = streamingCore();
    withPhase.offset = { gtid: null, binlog_file: 'mysql-bin.000003', binlog_pos: 4096, lsn: null, scn: null, resume_token: null };
    withPhase.completeness.snapshot_phase = 'streaming';
    if (!rejectsWith(withPhase, 'V16')) return fail('streaming(phase) dropped-GTID not rejected');

    const noPhase = streamingCore();
    noPhase.offset = { gtid: null, binlog_file: 'mysql-bin.000003', binlog_pos: 4096, lsn: null, scn: null, resume_token: null };
    delete noPhase.completeness.snapshot_phase;
    if (!rejectsWith(noPhase, 'V16')) return fail('streaming(no phase) dropped-GTID not rejected — bypass!');
    return ok('Dropped-GTID streaming event rejected with and without snapshot_phase (V16).');
  },
};

// C-NONMYSQL-BINLOG-FAIL: non-MySQL engine cannot use the binlog branch.
export const C_NONMYSQL_BINLOG: ConformanceCase = {
  id: 'C-NONMYSQL-BINLOG-FAIL',
  title: 'Non-MySQL/MariaDB binlog-only offset is rejected',
  spec_ref: 'CCE-AMD-001 Rev 4 §5; V16 (M2)',
  run(): ConformanceOutcome {
    const core = streamingCore();
    core.schema_version = 'cce-1.1';
    core.source.engine = 'postgres';
    core.offset = { gtid: null, binlog_file: 'mysql-bin.000003', binlog_pos: 4096, lsn: null, scn: null, resume_token: null };
    core.completeness.snapshot_phase = 'snapshot';
    core.completeness.snapshot_epoch_id = 'snap-0123456789abcdef';
    return rejectsWith(core, 'V16')
      ? ok('postgres binlog-only offset rejected (V16 engine clause).')
      : fail('non-MySQL engine accepted a binlog-only offset');
  },
};

// C-1.0-BINLOG-FAIL: a cce-1.0-labelled event cannot use the binlog branch.
export const C_10_BINLOG: ConformanceCase = {
  id: 'C-1.0-BINLOG-FAIL',
  title: 'cce-1.0-labelled binlog-only offset is rejected (M1)',
  spec_ref: 'CCE-AMD-001 Rev 4 §5; V16 (M1)',
  run(): ConformanceOutcome {
    const core = streamingCore(); // schema_version: cce-1.0
    core.offset = { gtid: null, binlog_file: 'mysql-bin.000003', binlog_pos: 4096, lsn: null, scn: null, resume_token: null };
    core.completeness.snapshot_phase = 'snapshot';
    core.completeness.snapshot_epoch_id = 'snap-0123456789abcdef';
    return rejectsWith(core, 'V16')
      ? ok('cce-1.0 binlog-only offset rejected (V16 version clause).')
      : fail('cce-1.0-labelled event accepted a binlog-only offset');
  },
};

// C-SNAP-EPOCH-IDLE-RERUN: same watermark, different snapshot ts => distinct epoch, no V15 (HIGH-2).
export const C_SNAP_IDLE_RERUN: ConformanceCase = {
  id: 'C-SNAP-EPOCH-IDLE-RERUN',
  title: 'Idle-DB re-snapshot (same watermark, new ts) => distinct epoch, no V15',
  spec_ref: 'CCE-AMD-001 Rev 4 §2; HIGH-2',
  run(): ConformanceOutcome {
    const a = buildCce(buildSnapshot(snapshotEvent(90211, { ts: '2026-06-01T10:00:00.000Z' })));
    const b = buildCce(buildSnapshot(snapshotEvent(90211, { ts: '2026-06-01T12:00:00.000Z' }))); // same file/pos, later snapshot
    if (a.envelope_id === b.envelope_id) return fail('idle re-snapshot produced the same envelope_id');
    const guard = new CceStreamGuard();
    if (guard.check(a).action !== 'EMIT') return fail('epoch 1 should EMIT');
    if (guard.check(b).action !== 'EMIT') return fail('epoch 2 should EMIT (distinct envelope) — false V15!');
    return ok('Same watermark + different snapshot ts => distinct epoch/envelope; no false V15.');
  },
};

// C-SNAP-EPOCH-NEWRUN: advanced watermark => distinct epoch, no V15.
export const C_SNAP_NEWRUN: ConformanceCase = {
  id: 'C-SNAP-EPOCH-NEWRUN',
  title: 'Re-snapshot at an advanced watermark => distinct epoch, no V15',
  spec_ref: 'CCE-AMD-001 Rev 4 §2',
  run(): ConformanceOutcome {
    const a = buildCce(buildSnapshot(snapshotEvent(90211, { pos: 4096 })));
    const b = buildCce(buildSnapshot(snapshotEvent(90211, { pos: 8192 })));
    if (a.envelope_id === b.envelope_id) return fail('advanced watermark produced the same envelope_id');
    const guard = new CceStreamGuard();
    return guard.check(a).action === 'EMIT' && guard.check(b).action === 'EMIT'
      ? ok('Advanced watermark => distinct epoch; both EMIT, no V15.')
      : fail('advanced-watermark re-snapshot raised a false V15');
  },
};

// C-SNAP-REPLAY-IDENTICAL: byte-identical replay => same id/hash => DUPLICATE.
export const C_SNAP_REPLAY: ConformanceCase = {
  id: 'C-SNAP-REPLAY-IDENTICAL',
  title: 'Replay of the same captured snapshot is byte-identical (DUPLICATE)',
  spec_ref: 'CCE-AMD-001 Rev 4 §2/§5',
  run(): ConformanceOutcome {
    const a = buildCce(buildSnapshot(snapshotEvent(90211)));
    const b = buildCce(buildSnapshot(snapshotEvent(90211)));
    if (a.envelope_id !== b.envelope_id || a.evidence.event_hash !== b.evidence.event_hash) {
      return fail('replay produced different envelope_id/event_hash');
    }
    const guard = new CceStreamGuard();
    if (guard.check(a).action !== 'EMIT') return fail('first delivery should EMIT');
    if (guard.check(b).action !== 'DUPLICATE') return fail('identical replay should be DUPLICATE');
    return ok('Identical captured snapshot replays byte-identical; second delivery DUPLICATE-skipped.');
  },
};

// C-SNAP-CHAIN-ORDER: deterministic chain order independent of arrival order.
export const C_SNAP_CHAIN_ORDER: ConformanceCase = {
  id: 'C-SNAP-CHAIN-ORDER',
  title: 'Snapshot rows seal in a deterministic total order',
  spec_ref: 'CCE-AMD-001 Rev 4 §6; F3',
  run(): ConformanceOutcome {
    const ids = [5, 2, 9, 1, 7];
    const order1 = orderCces(ids.map((i) => buildCce(buildSnapshot(snapshotEvent(i))))).map((c) => c.envelope_id);
    const order2 = orderCces([...ids].reverse().map((i) => buildCce(buildSnapshot(snapshotEvent(i))))).map((c) => c.envelope_id);
    return JSON.stringify(order1) === JSON.stringify(order2)
      ? ok('Two arrival orders produce an identical sealed sequence (deterministic total order).')
      : fail('snapshot chain order depends on arrival order');
  },
};

// C-TXID-NOCOLLISION: delimiter-bearing PKs cannot alias (F4).
export const C_TXID_NOCOLLISION: ConformanceCase = {
  id: 'C-TXID-NOCOLLISION',
  title: 'Adversarial primary keys cannot alias the snapshot tx_id',
  spec_ref: 'CCE-AMD-001 Rev 4 §3; F4',
  run(): ConformanceOutcome {
    const a = buildCce(buildSnapshot(snapshotEvent(1, { ref: { ref: 'a:b' } })));
    const b = buildCce(buildSnapshot(snapshotEvent(1, { ref: { ref: 'a', x: 'b' } })));
    if (a.transaction.tx_id === b.transaction.tx_id || a.envelope_id === b.envelope_id) {
      return fail('delimiter-bearing PKs aliased to the same tx_id/envelope_id');
    }
    return ok('Canonical-tuple row key keeps delimiter-bearing PKs distinct.');
  },
};

// C-SNAP-COVERAGE: incomplete/unknown coverage cannot be HEALTHY; complete can (V18, MED-2).
export const C_SNAP_COVERAGE: ConformanceCase = {
  id: 'C-SNAP-COVERAGE',
  title: 'Snapshot coverage honesty composes with fidelity (V18)',
  spec_ref: 'CCE-AMD-001 Rev 4 §8; V18 (MED-2)',
  run(): ConformanceOutcome {
    // incomplete + HEALTHY => build must reject (V18).
    const inc = buildSnapshot(snapshotEvent(90211)) as any;
    inc.completeness.snapshot_coverage = { table: 'kafel.donations', expected_rows: 1000, emitted_rows: 990, status: 'incomplete' };
    try {
      buildCce(inc);
      return fail('incomplete coverage reported HEALTHY was accepted');
    } catch (err) {
      if (!(err instanceof CceBuildError) || !err.errors.some((e) => e.rule === 'V18')) {
        return fail(`incomplete+HEALTHY rejected for the wrong reason: ${String((err as Error).message)}`);
      }
    }
    // unknown (expected null) + HEALTHY => reject.
    const unk = buildSnapshot(snapshotEvent(90212)) as any;
    unk.completeness.snapshot_coverage = { table: 'kafel.donations', expected_rows: null, emitted_rows: 5, status: 'in_progress' };
    try {
      buildCce(unk);
      return fail('unknown coverage reported HEALTHY was accepted');
    } catch (err) {
      if (!(err instanceof CceBuildError) || !err.errors.some((e) => e.rule === 'V18')) return fail('unknown+HEALTHY rejected for the wrong reason');
    }
    // incomplete + DEGRADED + reason => valid (composition); complete + HEALTHY => valid.
    const deg = buildSnapshot(snapshotEvent(90213)) as any;
    deg.fidelity = { state: 'DEGRADED', degraded_reason: 'snapshot coverage incomplete: donations 990/1000', source_config: HEALTHY_FID.source_config };
    deg.completeness.snapshot_coverage = { table: 'kafel.donations', expected_rows: 1000, emitted_rows: 990, status: 'incomplete' };
    buildCce(deg); // throws if invalid
    const comp = buildSnapshot(snapshotEvent(90214)) as any;
    comp.completeness.snapshot_coverage = { table: 'kafel.donations', expected_rows: 1000, emitted_rows: 1000, status: 'complete' };
    buildCce(comp); // HEALTHY permitted
    return ok('incomplete/unknown coverage rejects HEALTHY (V18); DEGRADED+reason and complete+HEALTHY accepted.');
  },
};

export const CASES: ConformanceCase[] = [
  C1, C3, C4, C5, C6, C7, C8, C10,
  C_OFFSET_EMPTY, C_STREAM_EMPTY_GTID, C_STREAM_NOGTID, C_NONMYSQL_BINLOG, C_10_BINLOG,
  C_SNAP_IDLE_RERUN, C_SNAP_NEWRUN, C_SNAP_REPLAY, C_SNAP_CHAIN_ORDER, C_TXID_NOCOLLISION, C_SNAP_COVERAGE,
];
