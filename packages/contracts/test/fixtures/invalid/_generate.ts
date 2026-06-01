// Generator for the V1..V15 invalid-fixture set (Epic E1 / EDAM-T009).
// Run with: npx tsx packages/contracts/test/fixtures/invalid/_generate.ts
//
// Each fixture is derived from the valid CCE and mutated to violate exactly one
// rule. Hash-bearing fixtures (V12/V13) use the REAL canonical/contracts
// functions so values are correct, never fabricated.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { envelopeId } from '@edam/canonical';
import { computeEventHash } from '@edam/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(HERE, '../valid/cce-donation-update.json'), 'utf8'));
const clone = <T>(v: T): T => structuredClone(v);

function derive(cce: any): any {
  cce.envelope_id = envelopeId({
    db_id: cce.source.db_id,
    tx_id: cce.transaction.tx_id,
    server_uuid: cce.source.server_uuid,
  });
  return cce;
}

const good = derive(clone(base));
const write = (name: string, obj: unknown) =>
  writeFileSync(join(HERE, name), JSON.stringify(obj, null, 2) + '\n', 'utf8');

// V1 — schema_version pattern fail
{ const c = clone(good); c.schema_version = 'ccv-1.0'; write('V01.json', c); }
// V2 — bad kind
{ const c = clone(good); c.kind = 'row'; write('V02.json', c); }
// V3 — envelope_id not derived
{ const c = clone(good); c.envelope_id = '00000000-0000-0000-0000-000000000000'; write('V03.json', c); }
// V4 — statement_count mismatch
{ const c = clone(good); c.transaction.statement_count = 99; write('V04.json', c); }
// V5 — INSERT with non-null before
{ const c = clone(good); c.changes[0].operation = 'INSERT'; write('V05.json', c); }
// V6 — row op missing object.primary_key
{ const c = clone(good); delete c.changes[0].object.primary_key; write('V06.json', c); }
// V7 — field_changes entry missing 'changed'
{ const c = clone(good); delete c.changes[0].field_changes[0].changed; write('V07.json', c); }
// V8 — bad fidelity.state
{ const c = clone(good); c.fidelity.state = 'GREEN'; write('V08.json', c); }
// V9 — completeness missing gap_detected
{ const c = clone(good); delete c.completeness.gap_detected; write('V09.json', c); }
// V10 — attribution_confidence != unattributed but no audit_event_ref
{ const c = clone(good); delete c.actor.audit_event_ref; write('V10.json', c); }
// V11 — offset with no engine key
{ const c = clone(good); c.offset = { gtid: null, binlog_file: null, binlog_pos: null, lsn: null, scn: null, resume_token: null }; write('V11.json', c); }
// V12 — tampered event_hash
{ const c = clone(good); c.evidence = { event_hash: 'sha256:' + '0'.repeat(64) }; write('V12.json', c); }
// V13 — anchor_ref missing hsm_signature/tsa_token (event_hash correct so only V13 fires)
{ const c = clone(good); c.evidence = { event_hash: computeEventHash(c), anchor_ref: { head_hash: 'sha256:' + '1'.repeat(64), anchor_provider: 'rfc3161' } }; write('V13.json', c); }
// V14 — stream pair with non-monotonic ingest_ts
{ const a = clone(good); a.transaction.ingest_ts = '2026-06-01T10:00:00.000Z'; const b = clone(a); b.transaction.ingest_ts = '2026-06-01T09:00:00.000Z'; write('V14.json', [a, b]); }
// V15 — stream pair, same envelope_id, differing content
{ const a = clone(good); const b = clone(a); b.changes[0].after.amount = '123456.00'; write('V15.json', [a, b]); }

console.log('wrote V01..V15 invalid fixtures');
