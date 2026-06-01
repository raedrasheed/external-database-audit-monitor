// Integration: Attestation + Completeness over a simulated event sequence
// including a downgrade and a GTID gap (Epic E3 / EDAM-T024).
import { describe, it, expect } from 'vitest';
import { AttestationMonitor } from '../src/attestation/monitor.js';
import { InMemoryConfigSnapshotSink } from '../src/attestation/snapshot.js';
import {
  CompletenessWatcher,
  InMemoryCompletenessUpdateSink,
} from '../src/completeness/watcher.js';
import { InMemoryAlarmSink } from '../src/alarms.js';
import { FakeClock } from '../src/clock.js';
import { mysqlAdapter } from '../src/adapters/mysql.js';
import type { SourceConfig, SourceConfigReader } from '../src/attestation/types.js';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const iso = (ms: number) => new Date(ms).toISOString();

const healthy: SourceConfig = {
  engine: 'mysql', log_bin: 'ON', binlog_format: 'ROW', binlog_row_image: 'FULL',
  gtid_mode: 'ON', gtid_strict_mode: null, binlog_expire_logs_seconds: 604800, server_uuid: UUID,
};
const reader = (cfg: SourceConfig): SourceConfigReader => ({ async read() { return cfg; } });

// A streaming Debezium event with a given gtid (snapshot phase = streaming).
function streamEvent(seq: number) {
  return {
    value: {
      op: 'u',
      ts_ms: 1748773351000,
      after: { id: 90211, amount: '100000.00' },
      source: { connector: 'mysql', db: 'kafel', table: 'donations', snapshot: 'false', gtid: `${UUID}:${seq}`, file: 'mysql-bin.000042', pos: 1000 + seq },
    },
  };
}

describe('integrity integration', () => {
  it('builds a healthy completeness update over a contiguous stream', async () => {
    const alarms = new InMemoryAlarmSink();
    const updates = new InMemoryCompletenessUpdateSink();
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });

    let t = 1000;
    for (let seq = 1; seq <= 5; seq++) {
      const ev = streamEvent(seq);
      w.observeEvent({ gtid: mysqlAdapter.extractOffset(ev).gtid, phase: mysqlAdapter.snapshotPhase(ev), at: iso((t += 1000)) });
      await updates.emit(w.buildUpdate({ sourceExecuted: `${UUID}:1-10`, alarms, atIso: iso(t), nowMs: t }));
    }

    const last = updates.updates.at(-1)!;
    expect(last.gap_detected).toBe(false);
    expect(last.snapshot_phase).toBe('streaming');
    expect(last.consumed_gtid_set).toBe(`${UUID}:1-5`);
    expect(last.consumed_offset_key).toBe(`${UUID}:5`);
    expect(alarms.byKind('COMPLETENESS_GAP')).toHaveLength(0);
  });

  it('raises a gap alarm and sets gap_detected when a transaction is skipped', async () => {
    const alarms = new InMemoryAlarmSink();
    const updates = new InMemoryCompletenessUpdateSink();
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });

    let t = 1000;
    for (const seq of [1, 2, 4, 5]) {
      // 3 is missed
      const ev = streamEvent(seq);
      w.observeEvent({ gtid: mysqlAdapter.extractOffset(ev).gtid, phase: 'streaming', at: iso((t += 1000)) });
    }
    const update = w.buildUpdate({ sourceExecuted: `${UUID}:1-10`, alarms, atIso: iso(t), nowMs: t });
    expect(update.gap_detected).toBe(true);
    expect(alarms.byKind('COMPLETENESS_GAP').some((a) => a.severity === 'critical')).toBe(true);
  });

  it('attestation: HEALTHY then DEGRADED+CRITICAL on a row-image downgrade', async () => {
    const alarms = new InMemoryAlarmSink();
    const sink = new InMemoryConfigSnapshotSink();
    const clock = new FakeClock(0);
    const monHealthy = new AttestationMonitor({
      engine: 'mysql', dbId: 'kafel-dev-mysql', reader: reader(healthy), sink, alarms, clock, options: { minBinlogRetentionSeconds: 86400 },
    });
    expect((await monHealthy.sample()).state).toBe('HEALTHY');
    expect(alarms.alarms).toHaveLength(0);

    const monDowngraded = new AttestationMonitor({
      engine: 'mysql', dbId: 'kafel-dev-mysql', reader: reader({ ...healthy, binlog_row_image: 'MINIMAL' }),
      sink, alarms, clock, options: { minBinlogRetentionSeconds: 86400 },
    });
    const snap = await monDowngraded.sample();
    expect(snap.state).toBe('DEGRADED');
    expect(alarms.byKind('CONFIG_DOWNGRADE').some((a) => a.severity === 'critical')).toBe(true);
  });

  it('heartbeats keep a quiet stream idle (not stalled) in the update', async () => {
    const alarms = new InMemoryAlarmSink();
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql', stallTimeoutMs: 60000, idleThresholdMs: 20000 });
    w.observeEvent({ gtid: `${UUID}:1`, phase: 'streaming', at: iso(100000) });
    w.observeHeartbeat(iso(130000));
    const update = w.buildUpdate({ alarms, atIso: iso(131000), nowMs: 131000 });
    expect(update.liveness).toBe('idle');
    expect(update.heartbeat_ts).toBe(iso(130000));
    expect(update.gap_detected).toBe(false);
  });
});
