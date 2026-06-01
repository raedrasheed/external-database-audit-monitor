// Tests for DLQ inspection + replay-definition-only (Epic E5 / EDAM-T039).
import { describe, it, expect } from 'vitest';
import {
  StoreDlqInspector,
  UnimplementedReplayExecutor,
  ReplayNotImplementedError,
  InMemoryDlqStore,
  type DlqItem,
} from '../src/index.js';

function makeItem(overrides: Partial<DlqItem>): DlqItem {
  return {
    event_id: 'dlq-1',
    source_engine: 'mysql',
    offset: 'g:1',
    failure_category: 'MALFORMED_CDC_EVENT',
    failure_reason: 'boom',
    captured_at: '2026-06-01T10:00:00.000Z',
    retry_count: 0,
    retryable: false,
    status: 'quarantined',
    original_payload: '{bad',
    payload_hash: 'sha256:' + '0'.repeat(64),
    first_seen: '2026-06-01T10:00:00.000Z',
    last_seen: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('StoreDlqInspector (read-only)', () => {
  it('lists and gets items', async () => {
    const store = new InMemoryDlqStore();
    await store.upsert(makeItem({ event_id: 'dlq-1' }));
    await store.upsert(makeItem({ event_id: 'dlq-2', status: 'retryable', failure_category: 'UNEXPECTED_EXCEPTION' }));
    const inspector = new StoreDlqInspector(store);
    expect(await inspector.list()).toHaveLength(2);
    expect(await inspector.list({ status: 'quarantined' })).toHaveLength(1);
    expect((await inspector.get('dlq-2'))?.failure_category).toBe('UNEXPECTED_EXCEPTION');
  });
});

describe('replay execution is definition-only (not implemented in E5)', () => {
  it('throws ReplayNotImplementedError — nothing is reprocessed', async () => {
    const executor = new UnimplementedReplayExecutor();
    await expect(
      executor.replay({ event_id: 'dlq-1', reason: 'investigated', requested_by: 'analyst' }),
    ).rejects.toBeInstanceOf(ReplayNotImplementedError);
  });

  it('does not touch the store (no silent reprocess that could mask a gap)', async () => {
    const store = new InMemoryDlqStore();
    await store.upsert(makeItem({ event_id: 'dlq-1' }));
    const before = await store.count();
    const executor = new UnimplementedReplayExecutor();
    await executor.replay({ event_id: 'dlq-1', reason: 'x', requested_by: 'y' }).catch(() => {});
    expect(await store.count()).toBe(before); // unchanged
  });
});
