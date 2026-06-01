// Tests for the DLQ store (Epic E5 / EDAM-T037).
import { describe, it, expect } from 'vitest';
import { InMemoryDlqStore, PgDlqStore, type DlqItem, type PgLike } from '../src/index.js';

const item: DlqItem = {
  event_id: 'dlq-abc',
  source_engine: 'mysql',
  offset: '3e11fa47:152',
  failure_category: 'MALFORMED_CDC_EVENT',
  failure_reason: 'unexpected token',
  captured_at: '2026-06-01T10:00:00.000Z',
  retry_count: 0,
  retryable: false,
  status: 'quarantined',
  original_payload: '{bad json',
  payload_hash: 'sha256:' + '0'.repeat(64),
  first_seen: '2026-06-01T10:00:00.000Z',
  last_seen: '2026-06-01T10:00:00.000Z',
};

describe('InMemoryDlqStore (append-only, no delete)', () => {
  it('upserts and reads back; has no delete method', async () => {
    const store = new InMemoryDlqStore();
    expect(await store.get('dlq-abc')).toBeNull();
    await store.upsert(item);
    expect(await store.get('dlq-abc')).toEqual(item);
    expect((store as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it('upsert by event_id replaces (no duplicate rows)', async () => {
    const store = new InMemoryDlqStore();
    await store.upsert(item);
    await store.upsert({ ...item, retry_count: 3, last_seen: '2026-06-01T10:05:00.000Z' });
    expect(await store.count()).toBe(1);
    expect((await store.get('dlq-abc'))?.retry_count).toBe(3);
  });

  it('filters by status/category/engine', async () => {
    const store = new InMemoryDlqStore();
    await store.upsert(item);
    await store.upsert({ ...item, event_id: 'dlq-xyz', status: 'retryable', failure_category: 'UNEXPECTED_EXCEPTION' });
    expect(await store.count({ status: 'quarantined' })).toBe(1);
    expect(await store.count({ category: 'UNEXPECTED_EXCEPTION' })).toBe(1);
    expect(await store.count({ engine: 'mysql' })).toBe(2);
  });
});

describe('PgDlqStore', () => {
  it('upserts with ON CONFLICT and never issues a DELETE', async () => {
    const texts: string[] = [];
    let stored: any | null = null;
    const db: PgLike = {
      async query(text, values) {
        texts.push(text);
        if (text.trim().startsWith('INSERT')) {
          stored = {
            event_id: values![0], source_engine: values![1], offset_key: values![2],
            failure_category: values![3], failure_reason: values![4], captured_at: values![5],
            retry_count: values![6], retryable: values![7], status: values![8],
            original_payload: JSON.parse(values![9] as string), payload_hash: values![10],
            first_seen: values![11], last_seen: values![12],
          };
          return { rows: [] };
        }
        if (text.includes('WHERE event_id')) return { rows: stored ? [stored] : [] };
        return { rows: [] };
      },
    };
    const store = new PgDlqStore(db);
    await store.ensureSchema();
    await store.upsert(item);
    const loaded = await store.get('dlq-abc');
    expect(loaded?.event_id).toBe('dlq-abc');
    expect(texts.some((t) => /ON CONFLICT \(event_id\) DO UPDATE/.test(t))).toBe(true);
    expect(texts.every((t) => !/DELETE/i.test(t))).toBe(true); // append-only
    expect(texts.every((t) => !/kafel\./.test(t))).toBe(true); // INV-1
  });
});
