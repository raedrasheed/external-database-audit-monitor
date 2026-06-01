// Tests for snapshot->stream handoff tracking (Epic E2 / EDAM-T013).
import { describe, it, expect } from 'vitest';
import { HandoffTracker } from '../src/handoff.js';
import type { OffsetMeta } from '../src/adapters/types.js';

const off = (pos: number, gtid: string | null = null): OffsetMeta => ({
  gtid,
  binlog_file: 'mysql-bin.000042',
  binlog_pos: pos,
});

describe('HandoffTracker', () => {
  it('emits snapshot_start then snapshot_complete then streaming_resumed', () => {
    const t = new HandoffTracker();
    const a = t.observe('snapshot', off(4), '2026-06-01T00:00:00.000Z');
    expect(a.map((e) => e.type)).toEqual(['snapshot_start']);

    expect(t.observe('snapshot', off(8), '2026-06-01T00:00:01.000Z')).toEqual([]); // no change

    const b = t.observe('handoff', off(99, 'G:1-100'), '2026-06-01T00:00:02.000Z');
    expect(b.map((e) => e.type)).toEqual(['snapshot_complete']);

    const c = t.observe('streaming', off(120, 'G:101'), '2026-06-01T00:00:03.000Z');
    expect(c.map((e) => e.type)).toEqual(['streaming_resumed']);

    expect(t.snapshotBoundary.start?.binlog_pos).toBe(4);
    expect(t.snapshotBoundary.end?.gtid).toBe('G:1-100');
    expect(t.currentPhase).toBe('streaming');
  });

  it('records snapshot_complete at the streaming boundary when last is skipped', () => {
    const t = new HandoffTracker();
    t.observe('snapshot', off(4), '2026-06-01T00:00:00.000Z');
    const c = t.observe('streaming', off(50, 'G:1-40'), '2026-06-01T00:00:05.000Z');
    expect(c.map((e) => e.type)).toEqual(['snapshot_complete', 'streaming_resumed']);
    expect(t.snapshotBoundary.end?.gtid).toBe('G:1-40');
  });

  it('handles a cold start directly into streaming', () => {
    const t = new HandoffTracker();
    const c = t.observe('streaming', off(200, 'G:101'), '2026-06-01T00:00:00.000Z');
    expect(c.map((e) => e.type)).toEqual(['streaming_resumed']);
    expect(t.snapshotBoundary.start).toBeNull();
  });
});
