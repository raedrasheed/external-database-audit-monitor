// Tests for fidelity assessment + Attestation Monitor (Epic E3 / EDAM-T019).
import { describe, it, expect } from 'vitest';
import { assessFidelity } from '../src/attestation/assess.js';
import { AttestationMonitor } from '../src/attestation/monitor.js';
import { InMemoryConfigSnapshotSink } from '../src/attestation/snapshot.js';
import { InMemoryAlarmSink } from '../src/alarms.js';
import { FakeClock } from '../src/clock.js';
import type { SourceConfig, SourceConfigReader } from '../src/attestation/types.js';

const OPTS = { minBinlogRetentionSeconds: 86400 };

const healthy: SourceConfig = {
  engine: 'mysql',
  log_bin: 'ON',
  binlog_format: 'ROW',
  binlog_row_image: 'FULL',
  gtid_mode: 'ON',
  gtid_strict_mode: null,
  binlog_expire_logs_seconds: 604800,
  server_uuid: '3E11FA47-71CA-11E1-9E33-C80AA9429562',
};

function reader(cfg: SourceConfig): SourceConfigReader {
  return { async read() { return cfg; } };
}

describe('assessFidelity', () => {
  it('returns HEALTHY only when all settings are read and correct', () => {
    const r = assessFidelity(healthy, OPTS);
    expect(r.assessment.state).toBe('HEALTHY');
    expect(r.assessment.degraded_reason).toBeNull();
    expect(r.alarms).toHaveLength(0);
  });

  it('flags binlog_row_image != FULL as DEGRADED + CRITICAL downgrade (C4)', () => {
    const r = assessFidelity({ ...healthy, binlog_row_image: 'MINIMAL' }, OPTS);
    expect(r.assessment.state).toBe('DEGRADED');
    expect(r.alarms.some((a) => a.kind === 'CONFIG_DOWNGRADE' && a.severity === 'critical')).toBe(true);
    expect(r.assessment.degraded_reason).toMatch(/binlog_row_image/);
  });

  it('flags binlog_format != ROW as DEGRADED + CRITICAL', () => {
    const r = assessFidelity({ ...healthy, binlog_format: 'STATEMENT' }, OPTS);
    expect(r.assessment.state).toBe('DEGRADED');
    expect(r.alarms.some((a) => a.severity === 'critical')).toBe(true);
  });

  it('flags gtid_mode != ON (MySQL) as DEGRADED + CRITICAL', () => {
    const r = assessFidelity({ ...healthy, gtid_mode: 'OFF' }, OPTS);
    expect(r.assessment.state).toBe('DEGRADED');
    expect(r.assessment.degraded_reason).toMatch(/gtid_mode/);
  });

  it('flags log_bin OFF as COMPROMISED (no capture)', () => {
    const r = assessFidelity({ ...healthy, log_bin: 'OFF' }, OPTS);
    expect(r.assessment.state).toBe('COMPROMISED');
    expect(r.alarms.some((a) => a.kind === 'CONFIG_DOWNGRADE' && a.severity === 'critical')).toBe(true);
  });

  it('flags retention below threshold as DEGRADED', () => {
    const r = assessFidelity({ ...healthy, binlog_expire_logs_seconds: 3600 }, OPTS);
    expect(r.assessment.state).toBe('DEGRADED');
    expect(r.assessment.degraded_reason).toMatch(/retention/);
  });

  it('does not fabricate HEALTHY when a critical var is unreadable (null)', () => {
    const r = assessFidelity({ ...healthy, binlog_row_image: null }, OPTS);
    expect(r.assessment.state).toBe('DEGRADED');
  });

  it('MariaDB: HEALTHY without gtid_mode; notes weak gtid_strict_mode', () => {
    const mariadb: SourceConfig = {
      engine: 'mariadb',
      log_bin: 'ON',
      binlog_format: 'ROW',
      binlog_row_image: 'FULL',
      gtid_mode: null,
      gtid_strict_mode: 'OFF',
      binlog_expire_logs_seconds: 604800,
      server_uuid: '223355',
    };
    const r = assessFidelity(mariadb, OPTS);
    expect(r.assessment.state).toBe('HEALTHY');
    expect(r.assessment.notes.join(' ')).toMatch(/gtid_strict_mode/);
  });
});

describe('AttestationMonitor', () => {
  it('emits a HEALTHY snapshot and no alarms for healthy config', async () => {
    const sink = new InMemoryConfigSnapshotSink();
    const alarms = new InMemoryAlarmSink();
    const m = new AttestationMonitor({
      engine: 'mysql', dbId: 'kafel-dev-mysql', reader: reader(healthy), sink, alarms,
      clock: new FakeClock(0), options: OPTS,
    });
    const snap = await m.sample();
    expect(snap.state).toBe('HEALTHY');
    expect(sink.snapshots).toHaveLength(1);
    expect(alarms.alarms).toHaveLength(0);
  });

  it('emits DEGRADED + CRITICAL alarm on a downgrade', async () => {
    const sink = new InMemoryConfigSnapshotSink();
    const alarms = new InMemoryAlarmSink();
    const m = new AttestationMonitor({
      engine: 'mysql', dbId: 'kafel-dev-mysql', reader: reader({ ...healthy, binlog_row_image: 'MINIMAL' }),
      sink, alarms, clock: new FakeClock(0), options: OPTS,
    });
    const snap = await m.sample();
    expect(snap.state).toBe('DEGRADED');
    expect(snap.degraded_reason).toMatch(/binlog_row_image/);
    expect(alarms.byKind('CONFIG_DOWNGRADE').some((a) => a.severity === 'critical')).toBe(true);
  });

  it('emits DEGRADED (never HEALTHY) when config cannot be read (INV-2)', async () => {
    const sink = new InMemoryConfigSnapshotSink();
    const alarms = new InMemoryAlarmSink();
    const failing: SourceConfigReader = { async read() { throw new Error('connection refused'); } };
    const m = new AttestationMonitor({
      engine: 'mysql', dbId: 'kafel-dev-mysql', reader: failing, sink, alarms,
      clock: new FakeClock(0), options: OPTS,
    });
    const snap = await m.sample();
    expect(snap.state).toBe('DEGRADED');
    expect(snap.source_config.binlog_row_image).toBeNull();
    expect(alarms.byKind('FIDELITY_DEGRADED')).toHaveLength(1);
  });
});
