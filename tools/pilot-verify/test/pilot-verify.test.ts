// B6+B7 acceptance test: produce pilot evidence (EvidenceWriterService + FIXED dev keys
// + InMemoryWormStore) -> export it -> verify against the published trust file -> PASS;
// tampered evidence -> FAIL. Proves validation-plan step 5 is executable end-to-end.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { InMemoryWormStore } from '@edam/worm';
import { DlqService, InMemoryDlqStore, InMemoryDlqAlarmSink } from '@edam/dlq';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { EvidenceWriterService } from '@edam/evidence-writer';
import { runExportVerification, loadTrustRoots, exitCodeFor, EXIT_PASS } from '@edam/verifier-cli';
import { loadPilotKeys, buildPilotTrust, exportFromWorm, generatePilotPems, type PilotKeys } from '../src/pilot-verify.js';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const DB = 'kafel-dev-mysql';

function tx(seq: number): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  return {
    source: { db_id: DB, engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-04T10:00:00.000Z', ingest_ts: '2026-06-04T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: HEALTHY,
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: seq } }, before: { id: seq, amount: '1.00' }, after: { id: seq, amount: '2.00' } }],
  };
}

async function produce(store: InMemoryWormStore, keys: PilotKeys): Promise<void> {
  const svc = new EvidenceWriterService({
    store, signer: keys.signer, anchor: keys.tsa,
    dlq: new DlqService({ store: new InMemoryDlqStore(), alarms: new InMemoryDlqAlarmSink() }),
    caps: { maxEvents: 2, maxAgeMs: 60_000 }, dbId: DB, now: () => '2026-06-04T10:00:00.000Z',
  });
  const c0 = buildCce(tx(0));
  const c1: Cce = buildCce(tx(1), { prevRowHash: c0.evidence.row_hash });
  await svc.ingest(c0);
  await svc.ingest(c1); // seals + signs + anchors one segment
}

function writeObjects(dir: string, objects: Array<{ key: string; bytes: Uint8Array }>): void {
  for (const o of objects) { const p = join(dir, o.key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(o.bytes)); }
}

describe('pilot offline verification (B6 + B7)', () => {
  it('B6/B7: fixed dev keys load from PEMs; trust publishes stable signing_key_id', () => {
    const pems = generatePilotPems();
    const a = loadPilotKeys(pems);
    const b = loadPilotKeys(pems); // same PEMs => same ids (stable)
    expect(a.signer.keyId).toBe(b.signer.keyId);
    const trust = buildPilotTrust(a);
    expect(trust.signing_keys![0]!.key_id).toBe(a.signer.keyId);
    expect(trust.anchor_certs!.length).toBe(1);
    expect(trust.export_keys![0]!.key_id).toBe(a.exportKey.key_id);
  });

  it('exports pilot WORM evidence and the verifier PASSes against the published trust', async () => {
    const keys = loadPilotKeys(generatePilotPems());
    const store = new InMemoryWormStore({ defaultRetainUntil: '2030-01-01T00:00:00.000Z' });
    await produce(store, keys);

    const { pkg, objects } = await exportFromWorm(store.reader(), DB, keys.exportKey, keys);
    const dir = mkdtempSync(join(tmpdir(), 'edam-pilot-'));
    const objectsDir = join(dir, 'objects');
    writeObjects(objectsDir, objects);

    const trust = loadTrustRoots(buildPilotTrust(keys));
    const res = runExportVerification(pkg, { objectsDir, trust, reportId: '99999999-2222-4333-8444-555555555555', generatedAt: '2026-06-04T00:00:00.000Z' });
    expect(res.export_signature.result, JSON.stringify(res.export_signature)).toBe('PASS');
    expect(res.report.overall_result, JSON.stringify(res.report.checks)).toBe('PASS');
    expect(exitCodeFor(res)).toBe(EXIT_PASS);
  });

  it('TAMPERED evidence FAILs verification (byte-flip in an object)', async () => {
    const keys = loadPilotKeys(generatePilotPems());
    const store = new InMemoryWormStore({ defaultRetainUntil: '2030-01-01T00:00:00.000Z' });
    await produce(store, keys);

    const { pkg, objects } = await exportFromWorm(store.reader(), DB, keys.exportKey, keys);
    const dir = mkdtempSync(join(tmpdir(), 'edam-pilot-tamper-'));
    const objectsDir = join(dir, 'objects');
    writeObjects(objectsDir, objects);
    // tamper one CCE object on disk
    const victim = join(objectsDir, objects[0]!.key);
    const b = Buffer.from(readFileSync(victim)); b[20] = b[20]! ^ 0x01; writeFileSync(victim, b);

    const trust = loadTrustRoots(buildPilotTrust(keys));
    const res = runExportVerification(pkg, { objectsDir, trust, reportId: '99999999-2222-4333-8444-555555555555', generatedAt: '2026-06-04T00:00:00.000Z' });
    expect(res.report.overall_result).toBe('FAIL');
    expect(exitCodeFor(res)).not.toBe(EXIT_PASS);
  });
});
