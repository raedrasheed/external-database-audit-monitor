// EvidenceWriter tests (Sprint-2 / EDAM-T106).
// AC: only validated objects reach WORM; invalid -> DLQ + alarm; back-refs populated.
import { describe, it, expect, beforeEach } from 'vitest';
import { EvidenceWriter, evidenceObjectKey } from '../src/index.js';
import { InMemoryWormStore, type WormStore } from '@edam/worm';
import { DlqService, InMemoryDlqStore, InMemoryDlqAlarmSink } from '@edam/dlq';
import { buildCce, buildSnapshotEpochManifest, type NormalizedTransaction } from '@edam/cce-model';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const FIXED_NOW = '2026-06-01T10:00:00.000Z';
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

function streamingTx(seq: number): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  return {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: { state: 'HEALTHY', source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } },
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: 1 } }, before: { id: 1, amount: '1.00' }, after: { id: 1, amount: '2.00' } }],
  };
}

const manifestInput = {
  epoch_id: 'snap-062d9337d88ad3c6',
  db_id: 'kafel-dev-mysql',
  server_uuid: UUID,
  snapshot_start_watermark: { binlog_file: 'mysql-bin.000003', binlog_pos: 4096 },
  snapshot_start_ts: '2026-06-01T09:30:00.000Z',
  handoff_gtid: `${UUID}:42`,
  tables: [{ table: 'kafel.donations', expected_rows: 3, expected_is_estimate: false, emitted_rows: 3, status: 'complete' as const }],
  supersedes: null,
};

describe('EvidenceWriter.append (T106)', () => {
  let store: WormStore;
  let dlqStore: InMemoryDlqStore;
  let alarms: InMemoryDlqAlarmSink;
  let writer: EvidenceWriter;

  beforeEach(() => {
    store = new InMemoryWormStore();
    dlqStore = new InMemoryDlqStore();
    alarms = new InMemoryDlqAlarmSink();
    writer = new EvidenceWriter({
      worm: store.writer(),
      dlq: new DlqService({ store: dlqStore, alarms }),
      now: () => FIXED_NOW,
    });
  });

  it('writes a valid CCE and populates evidence back-refs', async () => {
    const cce = buildCce(streamingTx(1));
    const out = await writer.append(cce, { segment_id: 'seg-000000', seq: 0 });
    expect(out.status).toBe('WRITTEN');
    if (out.status !== 'WRITTEN') return;
    const key = evidenceObjectKey('kafel-dev-mysql', 'seg-000000', 0, 'cce');
    expect(out.result.worm_object_key).toBe(key);
    expect(out.result.object_id).toBe(cce.envelope_id);
    // back-refs populated (outside the hashed core)
    const written = out.object as Record<string, any>;
    expect(written.evidence.worm_object_key).toBe(key);
    expect(written.evidence.segment_id).toBe('seg-000000');
    // event_hash unchanged by back-refs (determinism preserved)
    expect(written.evidence.event_hash).toBe(cce.evidence.event_hash);
    // object is in WORM
    expect(dec(await store.reader().get(key))).toContain(cce.envelope_id);
  });

  it('writes a valid snapshot epoch manifest (no back-ref; companion record)', async () => {
    const manifest = buildSnapshotEpochManifest(manifestInput);
    const out = await writer.append(manifest, { segment_id: 'seg-000000', seq: 1 });
    expect(out.status).toBe('WRITTEN');
    if (out.status !== 'WRITTEN') return;
    expect(out.result.object_type).toBe('snapshot_epoch_manifest');
    expect(await store.reader().list('kafel-dev-mysql/seg-000000/')).toContain(out.result.worm_object_key);
  });

  it('routes an INVALID CCE to the DLQ + alarm, and does NOT write it (no-fabrication)', async () => {
    const cce = buildCce(streamingTx(2)) as Record<string, any>;
    cce.evidence.event_hash = 'sha256:' + '0'.repeat(64); // tamper -> V12 mismatch
    const out = await writer.append(cce as never, { segment_id: 'seg-000000', seq: 0 });
    expect(out.status).toBe('DLQ');
    if (out.status !== 'DLQ') return;
    expect(out.item.failure_category).toBe('SCHEMA_VALIDATION_FAILURE');
    expect(alarms.byKind('DLQ_ENQUEUE').length).toBe(1); // alarm raised
    expect(await store.reader().list('')).toEqual([]); // nothing reached WORM
  });

  it('routes an unrecognized object to the DLQ (no write)', async () => {
    const out = await writer.append({ kind: 'not-a-thing' } as never, { segment_id: 'seg-000000', seq: 0 });
    expect(out.status).toBe('DLQ');
    expect(await store.reader().list('')).toEqual([]);
  });

  it('only validated objects reach WORM (mixed batch)', async () => {
    const good = buildCce(streamingTx(3));
    const bad = buildCce(streamingTx(4)) as Record<string, any>;
    bad.changes[0].after.amount = '999.00'; // mutate after re-hash -> event_hash mismatch (V12)
    await writer.append(good, { segment_id: 'seg-000001', seq: 0 });
    await writer.append(bad as never, { segment_id: 'seg-000001', seq: 1 });
    const keys = await store.reader().list('');
    expect(keys).toEqual([evidenceObjectKey('kafel-dev-mysql', 'seg-000001', 0, 'cce')]);
  });

  it('a re-append of the same key is rejected by WORM and routed to DLQ (no silent loss / no overwrite)', async () => {
    const cce = buildCce(streamingTx(5));
    const first = await writer.append(cce, { segment_id: 'seg-000002', seq: 0 });
    expect(first.status).toBe('WRITTEN');
    const second = await writer.append(cce, { segment_id: 'seg-000002', seq: 0 }); // same key
    expect(second.status).toBe('DLQ');
    if (second.status !== 'DLQ') return;
    expect(second.item.failure_category).toBe('UNEXPECTED_EXCEPTION');
    expect(second.reason).toMatch(/append-only|no overwrite|already exists/i);
  });

  it('the writer holds only a WormWriter (no admin/delete handle)', () => {
    // Compile-time + runtime: EvidenceWriter is constructed from store.writer(),
    // which exposes only putImmutable.
    const w = store.writer();
    expect(Object.keys(w)).toEqual(['putImmutable']);
  });

  // ---- F-H1: a CCE must carry verifying integrity evidence ----

  it('F-H1: a hash-less CCE (no evidence) is rejected to the DLQ, not written', async () => {
    const cce = buildCce(streamingTx(6)) as Record<string, any>;
    delete cce.evidence; // schema-valid (evidence optional), V12 skipped -> would pass validateCceFull
    const out = await writer.append(cce as never, { segment_id: 'seg-h1a', seq: 0 });
    expect(out.status).toBe('DLQ');
    if (out.status !== 'DLQ') return;
    expect(out.item.failure_category).toBe('SCHEMA_VALIDATION_FAILURE');
    expect(out.reason).toMatch(/evidence/i);
    expect(alarms.byKind('DLQ_ENQUEUE').length).toBe(1);
    expect(await store.reader().list('')).toEqual([]); // nothing reached WORM
  });

  it('F-H1: a CCE missing evidence.row_hash is rejected (V12 does not check it)', async () => {
    const cce = buildCce(streamingTx(7)) as Record<string, any>;
    delete cce.evidence.row_hash; // event_hash kept -> passes validateCceFull/V12
    const out = await writer.append(cce as never, { segment_id: 'seg-h1b', seq: 0 });
    expect(out.status).toBe('DLQ');
    if (out.status !== 'DLQ') return;
    expect(out.item.failure_category).toBe('SCHEMA_VALIDATION_FAILURE');
    expect(out.reason).toMatch(/row_hash/i);
    expect(await store.reader().list('')).toEqual([]);
  });

  it('F-H1: a CCE missing evidence.event_hash is rejected', async () => {
    const cce = buildCce(streamingTx(8)) as Record<string, any>;
    delete cce.evidence.event_hash;
    const out = await writer.append(cce as never, { segment_id: 'seg-h1c', seq: 0 });
    expect(out.status).toBe('DLQ');
    if (out.status !== 'DLQ') return;
    expect(out.reason).toMatch(/event_hash/i);
    expect(await store.reader().list('')).toEqual([]);
  });

  // ---- F-H2: serialization failures are DLQ'd, never thrown ----

  it('F-H2: a canonical-hostile value (float) is DLQ\'d as SERIALIZATION_FAILURE, not thrown', async () => {
    const cce = buildCce(streamingTx(9)) as Record<string, any>;
    cce.changes[0].field_changes[0].old = 1.5; // float in the hashed core -> serializeCanonical throws
    let out: Awaited<ReturnType<typeof writer.append>> | undefined;
    await expect(
      (async () => {
        out = await writer.append(cce as never, { segment_id: 'seg-h2', seq: 0 });
      })(),
    ).resolves.toBeUndefined(); // append did NOT throw
    expect(out?.status).toBe('DLQ');
    if (out?.status !== 'DLQ') return;
    expect(out.item.failure_category).toBe('SERIALIZATION_FAILURE');
    expect(await store.reader().list('')).toEqual([]); // nothing reached WORM
  });
});
