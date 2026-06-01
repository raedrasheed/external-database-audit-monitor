// Honesty invariant verification suite (Epic E8 / EDAM-T054).
//
// Exercises the REAL implementations to prove the honesty invariants (INV-2):
// uncertainty is represented honestly and NEVER becomes HEALTHY or ATTRIBUTED.

import { assessFidelity, AttestationMonitor } from '@edam/cdc-collector/attestation';
import { CompletenessWatcher } from '@edam/cdc-collector/completeness';
import { combineFidelity, correlateActor, assembleTransaction, type GroupedTransaction } from '@edam/normalization';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';

export interface InvariantOutcome {
  passed: boolean;
  detail: string;
}
export interface InvariantCase {
  id: string;
  description: string;
  spec_ref: string;
  run(): Promise<InvariantOutcome>;
}
export interface InvariantResult extends InvariantOutcome {
  id: string;
  description: string;
  spec_ref: string;
}

const HEALTHY_CFG = {
  engine: 'mysql' as const, log_bin: 'ON', binlog_format: 'ROW', binlog_row_image: 'FULL',
  gtid_mode: 'ON', gtid_strict_mode: null, binlog_expire_logs_seconds: 604800, server_uuid: UUID,
};
const NULL_CFG = {
  engine: 'mysql' as const, log_bin: null, binlog_format: null, binlog_row_image: null,
  gtid_mode: null, gtid_strict_mode: null, binlog_expire_logs_seconds: null, server_uuid: null,
};
const HEALTHY_FIDELITY = {
  state: 'HEALTHY' as const,
  source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' },
};
const group: GroupedTransaction = {
  source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
  tx_id: `${UUID}:1`, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.100Z',
  offset: { gtid: `${UUID}:1`, binlog_file: 'f', binlog_pos: 1 }, snapshot_phase: 'streaming',
  changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }],
};

const ok = (detail: string): InvariantOutcome => ({ passed: true, detail });
const fail = (detail: string): InvariantOutcome => ({ passed: false, detail });

export const INVARIANTS: InvariantCase[] = [
  {
    id: 'INV-CFG-DEGRADED',
    description: 'Unreadable source config => DEGRADED (never HEALTHY)',
    spec_ref: 'CCE §6.4; EDAM-v2 §4.3; INV-2',
    async run() {
      // (a) unreadable variables (null) assess DEGRADED
      if (assessFidelity(NULL_CFG, { minBinlogRetentionSeconds: 86400 }).assessment.state !== 'DEGRADED') {
        return fail('null/unreadable config did not assess DEGRADED');
      }
      // (b) a read failure in the monitor emits DEGRADED
      const monitor = new AttestationMonitor({
        engine: 'mysql', dbId: 'db',
        reader: { async read() { throw new Error('connection refused'); } },
        sink: { async emit() {} },
        alarms: { raise() {} },
        clock: { now: () => '2026-06-01T10:00:00.000Z', nowMs: () => 0 },
        options: { minBinlogRetentionSeconds: 86400 },
      });
      const snap = await monitor.sample();
      return snap.state === 'DEGRADED' ? ok('unreadable config => DEGRADED (null vars + read failure)') : fail(`read failure assessed ${snap.state}`);
    },
  },
  {
    id: 'INV-AUDIT-UNATTRIBUTED',
    description: 'Missing audit => unattributed',
    spec_ref: 'CCE §7; INV-2',
    async run() {
      const a = correlateActor({ dbId: 'db', commitTs: '2026-06-01T10:00:00.000Z', tables: ['donations'] }, []);
      return a.attribution_confidence === 'unattributed' ? ok('no audit candidates => unattributed') : fail(`got ${a.attribution_confidence}`);
    },
  },
  {
    id: 'INV-ACTOR-UNATTRIBUTED',
    description: 'Unknown / ambiguous / tampered actor => unattributed',
    spec_ref: 'CCE §7; companion DB-Audit Event §C; INV-2',
    async run() {
      const q = { dbId: 'db', commitTs: '2026-06-01T10:00:00.000Z', tables: ['donations'], windowMs: 5000 };
      const c = { audit_event_id: 'a', connection_id: '1', event_ts: '2026-06-01T10:00:01.000Z', objects: [{ schema: 'kafel', name: 'donations' }] };
      const ambiguous = correlateActor(q, [c, { ...c, audit_event_id: 'b', connection_id: '2' }]);
      const tampered = correlateActor(q, [{ ...c, tamper_indicators: ['AUDIT_PLUGIN_DISABLED'] }]);
      if (ambiguous.attribution_confidence !== 'unattributed') return fail('ambiguous candidates not unattributed');
      if (tampered.attribution_confidence !== 'unattributed') return fail('disabled-audit not unattributed');
      return ok('ambiguous and tampered audit => unattributed');
    },
  },
  {
    id: 'INV-COMPLETENESS-DEGRADED',
    description: 'Missing completeness => DEGRADED',
    spec_ref: 'CCE §6.5; EDAM-v2 §4.3; INV-2',
    async run() {
      return combineFidelity(HEALTHY_FIDELITY, null).state === 'DEGRADED'
        ? ok('missing completeness => DEGRADED')
        : fail('missing completeness did not degrade fidelity');
    },
  },
  {
    id: 'INV-GAP-DETECTED',
    description: 'GTID gap => gap_detected',
    spec_ref: 'CCE §6.5; INV-2',
    async run() {
      const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'db' });
      for (const n of [1, 2, 4, 5]) w.observeConsumed(`${UUID}:${n}`); // skip 3
      return w.computeGap().gap_detected ? ok('skipped transaction => gap_detected') : fail('gap not detected');
    },
  },
  {
    id: 'INV-NEVER-HEALTHY',
    description: 'Uncertainty never becomes HEALTHY',
    spec_ref: 'EDAM-v2 §4.3; INV-2',
    async run() {
      const states = [
        assessFidelity(NULL_CFG, { minBinlogRetentionSeconds: 86400 }).assessment.state,
        combineFidelity(null, { consumed_offset_key: 'x', gap_detected: false }).state,
        assembleTransaction(group, null, null, { attribution_confidence: 'unattributed' }).fidelity.state,
      ];
      return states.every((s) => s !== 'HEALTHY')
        ? ok(`uncertainty states: ${states.join(', ')} — none HEALTHY`)
        : fail(`a HEALTHY state appeared under uncertainty: ${states.join(', ')}`);
    },
  },
  {
    id: 'INV-NEVER-ATTRIBUTED',
    description: 'Uncertainty never becomes ATTRIBUTED (exact/probable)',
    spec_ref: 'CCE §7; INV-2',
    async run() {
      const q = { dbId: 'db', commitTs: '2026-06-01T10:00:00.000Z', tables: ['donations'] };
      const confidences = [
        correlateActor(q, []).attribution_confidence,
        correlateActor({ ...q, windowMs: 5000 }, [
          { audit_event_id: 'a', connection_id: '1', event_ts: '2026-06-01T10:00:01.000Z', objects: [{ schema: 'kafel', name: 'donations' }] },
          { audit_event_id: 'b', connection_id: '2', event_ts: '2026-06-01T10:00:01.000Z', objects: [{ schema: 'kafel', name: 'donations' }] },
        ]).attribution_confidence,
      ];
      return confidences.every((c) => c === 'unattributed')
        ? ok('uncertainty => unattributed (never exact/probable)')
        : fail(`attributed under uncertainty: ${confidences.join(', ')}`);
    },
  },
];

export async function runInvariants(): Promise<InvariantResult[]> {
  const out: InvariantResult[] = [];
  for (const inv of INVARIANTS) {
    let outcome: InvariantOutcome;
    try {
      outcome = await inv.run();
    } catch (err) {
      outcome = { passed: false, detail: `threw: ${String((err as Error).message ?? err)}` };
    }
    out.push({ id: inv.id, description: inv.description, spec_ref: inv.spec_ref, ...outcome });
  }
  return out;
}
