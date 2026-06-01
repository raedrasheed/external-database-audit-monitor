// Tests for durable offset tracking (Epic E2 / EDAM-T012).
import { describe, it, expect } from 'vitest';
import { InMemoryOffsetStore, PgOffsetStore, type OffsetState, type PgLike } from '../src/offset-store.js';

const sample: OffsetState = {
  streamKey: 'kafel-dev-mysql',
  gtid: '3E11FA47-71CA-11E1-9E33-C80AA9429562:152',
  binlogFile: 'mysql-bin.000042',
  binlogPos: 99812,
  phase: 'streaming',
  sourceStreamId: '1700000000000-0',
  updatedAt: '2026-06-01T10:22:31.480Z',
};

describe('InMemoryOffsetStore', () => {
  it('returns null before any commit and resumes the last committed offset', async () => {
    const store = new InMemoryOffsetStore();
    expect(await store.load('kafel-dev-mysql')).toBeNull();
    await store.commit(sample);
    expect(await store.load('kafel-dev-mysql')).toEqual(sample);
  });

  it('overwrites on a later commit (monotonic advance)', async () => {
    const store = new InMemoryOffsetStore();
    await store.commit(sample);
    const next = { ...sample, gtid: '3E11FA47-71CA-11E1-9E33-C80AA9429562:153', binlogPos: 101244 };
    await store.commit(next);
    expect((await store.load('kafel-dev-mysql'))?.gtid).toBe(
      '3E11FA47-71CA-11E1-9E33-C80AA9429562:153',
    );
  });
});

describe('PgOffsetStore', () => {
  it('issues an upsert on commit and reads state back', async () => {
    const calls: { text: string; values?: unknown[] }[] = [];
    let stored: any[] = [];
    const fakeDb: PgLike = {
      async query(text, values) {
        calls.push({ text, values });
        if (text.trim().startsWith('INSERT')) {
          stored = [
            {
              stream_key: values![0],
              gtid: values![1],
              binlog_file: values![2],
              binlog_pos: values![3],
              phase: values![4],
              source_stream_id: values![5],
              updated_at: values![6],
            },
          ];
          return { rows: [] };
        }
        if (text.trim().startsWith('SELECT')) return { rows: stored };
        return { rows: [] };
      },
    };

    const store = new PgOffsetStore(fakeDb);
    await store.ensureSchema();
    await store.commit(sample);
    const loaded = await store.load('kafel-dev-mysql');

    expect(calls.some((c) => /INSERT INTO edam_state\.cdc_offsets/.test(c.text))).toBe(true);
    expect(calls.some((c) => /ON CONFLICT \(stream_key\) DO UPDATE/.test(c.text))).toBe(true);
    expect(loaded).toEqual(sample);
    // INV-1: state DB is edam_state, never the monitored DB.
    expect(calls.every((c) => !/kafel\./.test(c.text))).toBe(true);
  });
});
