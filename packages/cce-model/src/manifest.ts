// Snapshot Epoch Manifest builder (CCE-AMD-001 Rev 4 §3 / §9).
//
// A companion record (NOT a CCE) emitted once per snapshot epoch at handoff. It
// records the epoch's watermark, capture-sourced start timestamp, per-table
// coverage, and the prior epoch it supersedes, and chains into the same WORM
// hash chain as CCEs (manifest_hash + row_hash). This module is a PURE
// constructor/validator: it does not emit, store, or anchor anything (no WORM,
// projection, or Sprint-2 wiring).

import { serializeCanonical, eventHash, rowHash, GENESIS_ROW_HASH } from '@edam/canonical';
import { validateSnapshotEpochManifest, type ValidationError } from '@edam/contracts';
import type { SnapshotCoverageStatus } from './types.js';

export interface SnapshotEpochManifestTable {
  table: string;
  expected_rows: number | null;
  expected_is_estimate?: boolean;
  emitted_rows: number;
  status: SnapshotCoverageStatus;
}

export interface SnapshotEpochManifestInput {
  epoch_id: string;
  db_id: string;
  server_uuid: string;
  snapshot_start_watermark: { binlog_file: string; binlog_pos: number };
  snapshot_start_ts: string;
  handoff_gtid?: string | null;
  tables: SnapshotEpochManifestTable[];
  supersedes?: string | null;
  prevRowHash?: string | null;
}

export interface SnapshotEpochManifest {
  kind: 'snapshot_epoch_manifest';
  schema_version: 'edam-companion-1.0';
  epoch_id: string;
  db_id: string;
  server_uuid: string;
  snapshot_start_watermark: { binlog_file: string; binlog_pos: number };
  snapshot_start_ts: string;
  handoff_gtid: string | null;
  tables: SnapshotEpochManifestTable[];
  supersedes: string | null;
  evidence: { manifest_hash: string; prev_row_hash: string | null; row_hash: string };
}

export class SnapshotEpochManifestError extends Error {
  constructor(message: string, readonly errors: ValidationError[] = []) {
    super(message);
    this.name = 'SnapshotEpochManifestError';
  }
}

/**
 * Build and validate a Snapshot Epoch Manifest. manifest_hash is computed over
 * the canonical manifest core (record minus `evidence`), mirroring the CCE
 * event_hash discipline; row_hash chains it. Throws on an invalid result so a
 * caller never persists a malformed manifest.
 */
export function buildSnapshotEpochManifest(input: SnapshotEpochManifestInput): SnapshotEpochManifest {
  const core = {
    kind: 'snapshot_epoch_manifest' as const,
    schema_version: 'edam-companion-1.0' as const,
    epoch_id: input.epoch_id,
    db_id: input.db_id,
    server_uuid: input.server_uuid,
    snapshot_start_watermark: input.snapshot_start_watermark,
    snapshot_start_ts: input.snapshot_start_ts,
    handoff_gtid: input.handoff_gtid ?? null,
    tables: input.tables,
    supersedes: input.supersedes ?? null,
  };

  const manifest_hash = eventHash(serializeCanonical(core));
  const prev_row_hash = input.prevRowHash ?? GENESIS_ROW_HASH;
  const row_hash = rowHash(prev_row_hash, manifest_hash);

  const manifest = { ...core, evidence: { manifest_hash, prev_row_hash, row_hash } } as SnapshotEpochManifest;

  const result = validateSnapshotEpochManifest(manifest);
  if (!result.valid) {
    throw new SnapshotEpochManifestError(
      `built snapshot epoch manifest failed validation: ${result.errors.map((e) => e.instancePath || e.keyword).join(', ')}`,
      result.errors,
    );
  }
  return manifest;
}
