// Tests for config_snapshot building (Epic E3 / EDAM-T018).
import { describe, it, expect } from 'vitest';
import {
  buildConfigSnapshot,
  computeConfigSnapshotId,
  InMemoryConfigSnapshotSink,
  type FidelityAssessment,
} from '../src/attestation/snapshot.js';
import type { SourceConfig } from '../src/attestation/types.js';

const healthyConfig: SourceConfig = {
  engine: 'mysql',
  log_bin: 'ON',
  binlog_format: 'ROW',
  binlog_row_image: 'FULL',
  gtid_mode: 'ON',
  gtid_strict_mode: null,
  binlog_expire_logs_seconds: 604800,
  server_uuid: '3E11FA47-71CA-11E1-9E33-C80AA9429562',
};

const healthyAssessment: FidelityAssessment = { state: 'HEALTHY', degraded_reason: null, notes: [] };

describe('buildConfigSnapshot', () => {
  it('produces a CCE-mappable source_config with the exact §6.4 keys', () => {
    const snap = buildConfigSnapshot('kafel-dev-mysql', healthyConfig, healthyAssessment, '2026-06-01T10:00:00.000Z');
    expect(Object.keys(snap.source_config).sort()).toEqual([
      'binlog_format',
      'binlog_row_image',
      'config_snapshot_id',
      'gtid_mode',
      'log_bin',
      'replica_identity',
    ]);
    expect(snap.source_config.binlog_row_image).toBe('FULL');
    expect(snap.source_config.config_snapshot_id).toBe(snap.config_snapshot_id);
    expect(snap.state).toBe('HEALTHY');
    expect(snap.sampled.server_uuid).toBe('3E11FA47-71CA-11E1-9E33-C80AA9429562');
  });

  it('derives a deterministic content-addressed id', () => {
    const id1 = computeConfigSnapshotId('kafel-dev-mysql', 'mysql', '2026-06-01T10:00:00.000Z', healthyConfig);
    const id2 = computeConfigSnapshotId('kafel-dev-mysql', 'mysql', '2026-06-01T10:00:00.000Z', healthyConfig);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^cfg-[0-9a-f]{16}$/);
  });

  it('changes the id when config or time changes', () => {
    const base = computeConfigSnapshotId('kafel-dev-mysql', 'mysql', '2026-06-01T10:00:00.000Z', healthyConfig);
    const downgraded = computeConfigSnapshotId('kafel-dev-mysql', 'mysql', '2026-06-01T10:00:00.000Z', {
      ...healthyConfig,
      binlog_row_image: 'MINIMAL',
    });
    const laterTime = computeConfigSnapshotId('kafel-dev-mysql', 'mysql', '2026-06-01T11:00:00.000Z', healthyConfig);
    expect(downgraded).not.toBe(base);
    expect(laterTime).not.toBe(base);
  });

  it('emits to a sink', async () => {
    const sink = new InMemoryConfigSnapshotSink();
    const snap = buildConfigSnapshot('kafel-dev-mysql', healthyConfig, healthyAssessment, '2026-06-01T10:00:00.000Z');
    await sink.emit(snap);
    expect(sink.snapshots).toHaveLength(1);
  });
});
