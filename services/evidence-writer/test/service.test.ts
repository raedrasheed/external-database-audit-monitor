// Evidence-writer SERVICE composition smoke test (R-11b). Proves the runnable pipeline
// composition (CCE -> accumulate -> seal -> sign -> anchor -> WORM) end-to-end IN MEMORY
// with the injected fakes (InMemoryWormStore + dev signer + dev RFC-3161). Full live
// integration (Redis CCE bus + MinIO + real Kafel data) is the Priority-2 pilot.
import { describe, it, expect } from 'vitest';
import { InMemoryWormStore } from '@edam/worm';
import { DevEd25519Signer } from '@edam/signing';
import { DevRfc3161Provider } from '@edam/anchoring';
import { DlqService, InMemoryDlqStore, InMemoryDlqAlarmSink } from '@edam/dlq';
import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import { EvidenceWriterService } from '../src/service.js';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };

function tx(seq: number): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-04T10:00:00.000Z', ingest_ts: '2026-06-04T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: HEALTHY,
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: seq } }, before: { id: seq, amount: '1.00' }, after: { id: seq, amount: '2.00' } }],
  };
}

function service(store: InMemoryWormStore): EvidenceWriterService {
  return new EvidenceWriterService({
    store,
    signer: new DevEd25519Signer({ createdAt: '2026-06-04T00:00:00.000Z' }),
    anchor: new DevRfc3161Provider({}),
    dlq: new DlqService({ store: new InMemoryDlqStore(), alarms: new InMemoryDlqAlarmSink() }),
    caps: { maxEvents: 2, maxAgeMs: 60_000 },
    dbId: 'kafel-dev-mysql',
    now: () => '2026-06-04T10:00:00.000Z',
  });
}

describe('EvidenceWriterService composition (R-11b)', () => {
  it('CCEs -> sealed segment -> signed + anchored -> born-locked objects + manifest + anchor record in WORM', async () => {
    const store = new InMemoryWormStore({ defaultRetainUntil: '2030-01-01T00:00:00.000Z' }); // models the bucket default
    const svc = service(store);
    const c0 = buildCce(tx(0));
    const c1: Cce = buildCce(tx(1), { prevRowHash: c0.evidence.row_hash });

    await svc.ingest(c0); // buffered
    await svc.ingest(c1); // hits maxEvents=2 -> seals -> signs -> anchors

    expect(svc.stats.sealed).toBe(1);
    expect(svc.stats.anchored).toBe(1);
    expect(svc.stats.failed).toBe(0);

    const keys = await store.reader().list('kafel-dev-mysql/');
    // 2 CCE objects + 1 manifest + 1 anchor record.
    expect(keys.some((k) => k.endsWith('/anchor.json'))).toBe(true);
    expect(keys.some((k) => k.includes('manifest'))).toBe(true);
    expect(keys.filter((k) => k.endsWith('.cce.json')).length).toBe(2);
    // every written object is born locked (COMPLIANCE retention via the store default).
    for (const k of keys) expect((await store.reader().headObjectLock(k)).retainUntil).not.toBeNull();

    // the committed anchor record is a valid anchor-record-1.0 with an hsm_signature.
    const rec = JSON.parse(new TextDecoder().decode(await store.reader().get(keys.find((k) => k.endsWith('/anchor.json'))!)));
    expect(rec.anchor_version).toBe('anchor-record-1.0');
    expect(rec.hsm_signature.algorithm).toBe('ed25519');
  });

  it('chains across segments: two sealed+anchored segments (cross-segment continuity)', async () => {
    const store = new InMemoryWormStore({ defaultRetainUntil: '2030-01-01T00:00:00.000Z' });
    const svc = service(store);
    const c0 = buildCce(tx(0));
    const c1: Cce = buildCce(tx(1), { prevRowHash: c0.evidence.row_hash });
    const c2: Cce = buildCce(tx(2), { prevRowHash: c1.evidence.row_hash });
    const c3: Cce = buildCce(tx(3), { prevRowHash: c2.evidence.row_hash });
    for (const c of [c0, c1, c2, c3]) await svc.ingest(c); // 2 segments of 2 events each

    expect(svc.stats.sealed).toBe(2);   // cross-segment continuity verified by the sealer (#previous)
    expect(svc.stats.anchored).toBe(2);
    expect(svc.stats.failed).toBe(0);
    const anchorRecs = (await store.reader().list('kafel-dev-mysql/')).filter((k) => k.endsWith('/anchor.json'));
    expect(anchorRecs.length).toBe(2);
  });
});
