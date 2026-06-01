// Snapshot Epoch Manifest builder tests (CCE-AMD-001 Rev 4 §3/§9).
import { describe, it, expect } from 'vitest';
import { buildSnapshotEpochManifest, SnapshotEpochManifestError, type SnapshotEpochManifestInput } from '../src/index.js';
import { validateSnapshotEpochManifest } from '@edam/contracts';

const input: SnapshotEpochManifestInput = {
  epoch_id: 'snap-062d9337d88ad3c6',
  db_id: 'kafel-dev-mysql',
  server_uuid: '386be27f-0000-0000-0000-000000000001',
  snapshot_start_watermark: { binlog_file: 'mysql-bin.000003', binlog_pos: 4096 },
  snapshot_start_ts: '2026-06-01T10:00:00.000Z',
  handoff_gtid: '386be27f-0000-0000-0000-000000000001:42',
  tables: [{ table: 'kafel.donations', expected_rows: 1000, expected_is_estimate: false, emitted_rows: 1000, status: 'complete' }],
  supersedes: null,
};

describe('buildSnapshotEpochManifest', () => {
  it('builds a valid companion manifest (kind != transaction)', () => {
    const m = buildSnapshotEpochManifest(input);
    expect(m.kind).toBe('snapshot_epoch_manifest');
    expect(m.schema_version).toBe('edam-companion-1.0');
    expect(validateSnapshotEpochManifest(m).valid).toBe(true);
    expect(m.evidence.manifest_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(m.evidence.row_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic (same input => byte-identical hashes)', () => {
    const a = buildSnapshotEpochManifest(input);
    const b = buildSnapshotEpochManifest(input);
    expect(a.evidence.manifest_hash).toBe(b.evidence.manifest_hash);
    expect(a.evidence.row_hash).toBe(b.evidence.row_hash);
  });

  it('chains via supersedes across epochs', () => {
    const m = buildSnapshotEpochManifest({ ...input, epoch_id: 'snap-0000000000000002', supersedes: 'snap-062d9337d88ad3c6' });
    expect(m.supersedes).toBe('snap-062d9337d88ad3c6');
    expect(validateSnapshotEpochManifest(m).valid).toBe(true);
  });

  it('a CCE-shaped object is NOT a valid manifest (companion isolation)', () => {
    expect(validateSnapshotEpochManifest({ kind: 'transaction' }).valid).toBe(false);
  });

  it('throws SnapshotEpochManifestError on an invalid epoch_id', () => {
    expect(() => buildSnapshotEpochManifest({ ...input, epoch_id: 'not-an-epoch' })).toThrow(SnapshotEpochManifestError);
  });
});
