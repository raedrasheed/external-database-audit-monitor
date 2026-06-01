// Build the conformance fixtures as REAL CCEs with pinned golden values
// (Epic E4 / EDAM-T036, EDAM-T011). Replaces the PENDING_CANONICAL fixtures.
//
//   npx tsx conformance/scripts/build-fixtures.ts
//
// Each fixture stores its complete NormalizedTransaction input plus the
// deterministic golden envelope_id / event_hash / row_hash produced by the
// frozen builder. The fixtures test rebuilds from input and asserts the golden
// matches (determinism) and the CCE validates.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCce, type NormalizedTransaction } from '@edam/cce-model';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '../fixtures/transactions');
const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';

interface FixtureSpec {
  fixture_id: string;
  description: string;
  conformance_refs: string[];
  sensitive_fields?: string[];
  input: NormalizedTransaction;
}

function base(seq: number, commit: string): Pick<NormalizedTransaction, 'source' | 'transaction' | 'offset' | 'fidelity' | 'completeness'> {
  const tx = `${UUID}:${seq}`;
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: tx, commit_ts: commit, ingest_ts: commit },
    offset: { gtid: tx, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: { state: 'HEALTHY', source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg-fixture' } },
    completeness: { consumed_offset_key: tx, gap_detected: false, snapshot_phase: 'streaming' },
  };
}

const specs: FixtureSpec[] = [
  {
    fixture_id: 'FX-001-donation-amount-after-approval',
    description: 'UPDATE raises a donation amount while status is approved (CCE Appendix C.1).',
    conformance_refs: ['C-3', 'C-10'],
    input: {
      ...base(152, '2026-06-01T10:22:31.000Z'),
      actor: { db_user: 'ops_admin', client_host: '10.0.7.21', connection_id: '338217', attribution_confidence: 'exact', audit_event_ref: 'dbaudit:2026-06-01/10/#44711', correlation_basis: ['connection_id', 'gtid', 'time_window'] },
      changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 90211 } }, before: { id: 90211, amount: '100.00', status: 'approved' }, after: { id: 90211, amount: '100000.00', status: 'approved' } }],
    },
  },
  {
    fixture_id: 'FX-002-wallet-balance-update',
    description: 'UPDATE directly edits a wallet balance (CCE Appendix C.2).',
    conformance_refs: ['C-3'],
    input: {
      ...base(153, '2026-06-01T22:14:03.000Z'),
      actor: { attribution_confidence: 'unattributed' },
      changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'wallets', primary_key: { id: 4412 } }, before: { id: 4412, user_id: 778, balance: '250.00' }, after: { id: 4412, user_id: 778, balance: '9250.00' } }],
    },
  },
  {
    fixture_id: 'FX-003-beneficiary-deletion',
    description: 'DELETE removes a beneficiary holding a balance; sensitive fields masked (CCE Appendix C.3).',
    conformance_refs: ['C-3'],
    sensitive_fields: ['kafel.beneficiaries.name', 'kafel.beneficiaries.national_id'],
    input: {
      ...base(154, '2026-06-01T11:05:10.000Z'),
      actor: { attribution_confidence: 'unattributed' },
      changes: [{ operation: 'DELETE', object: { schema: 'kafel', name: 'beneficiaries', primary_key: { id: 5567 } }, before: { id: 5567, name: 'Aid Recipient A', national_id: '2011223344', balance: '1320.00', status: 'active' }, after: null }],
    },
  },
  {
    fixture_id: 'FX-004-campaign-deletion',
    description: 'DELETE removes a campaign that has donations (CCE Appendix C.4).',
    conformance_refs: ['C-3'],
    input: {
      ...base(155, '2026-06-01T03:41:00.000Z'),
      actor: { attribution_confidence: 'unattributed' },
      changes: [{ operation: 'DELETE', object: { schema: 'kafel', name: 'campaigns', primary_key: { id: 88 } }, before: { id: 88, title: 'Winter Relief', status: 'active', total_raised: '45200.00' }, after: null }],
    },
  },
  {
    fixture_id: 'FX-005-permission-change',
    description: 'UPDATE changes a user role assignment (CCE Appendix C.5).',
    conformance_refs: ['C-3'],
    input: {
      ...base(156, '2026-06-01T12:00:00.000Z'),
      actor: { attribution_confidence: 'unattributed' },
      changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'user_roles', primary_key: { user_id: 778, role_id: 2 } }, before: { user_id: 778, role_id: 2 }, after: { user_id: 778, role_id: 1 } }],
    },
  },
];

for (const spec of specs) {
  const cce = buildCce(spec.input, { sensitiveFields: spec.sensitive_fields });
  const fixture = {
    fixture_id: spec.fixture_id,
    description: spec.description,
    conformance_refs: spec.conformance_refs,
    ...(spec.sensitive_fields ? { sensitive_fields: spec.sensitive_fields } : {}),
    input: spec.input,
    golden: {
      status: 'PINNED' as const,
      schema_version: 'cce-1.0',
      envelope_id: cce.envelope_id,
      event_hash: cce.evidence.event_hash,
      row_hash: cce.evidence.row_hash,
    },
  };
  writeFileSync(join(DIR, `${spec.fixture_id}.json`), JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  process.stdout.write(`pinned ${spec.fixture_id}: ${cce.envelope_id} ${cce.evidence.event_hash}\n`);
}
