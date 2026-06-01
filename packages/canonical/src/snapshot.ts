// Snapshot-phase identity helpers (CCE-AMD-001 Rev 4 §2/§3/§4).
//
// Deterministic, capture-sourced identity for MySQL/MariaDB snapshot reads,
// which carry no GTID. These live in @edam/canonical alongside envelopeId so
// every service derives byte-identical identity (INV-4) and so the contracts
// validator (V17) and the CCE builder share one implementation.
//
// snapshot_epoch_id is content-addressed over the Debezium snapshot WATERMARK
// (the snapshot-start binlog coordinate) PLUS a capture-sourced snapshot-start
// timestamp. The timestamp closes the idle-DB re-snapshot collision (Rev-4
// HIGH-2): two snapshots at an identical binlog coordinate but different
// snapshot times yield distinct epochs, while a byte-identical replay of the
// same captured snapshot reproduces the identical epoch.

import { serializeCanonical } from './serialize.js';
import { sha256Hex } from './hash.js';

export interface SnapshotEpochParts {
  db_id: string;
  server_uuid: string;
  /** Snapshot low-watermark binlog file (from the snapshot=first marker). */
  snapshot_start_binlog_file: string;
  /** Snapshot low-watermark binlog position. */
  snapshot_start_binlog_pos: number;
  /**
   * Capture-sourced snapshot-start timestamp (the source snapshot consistent
   * point, e.g. Debezium `source.ts_ms` rendered RFC3339). MUST NOT be a
   * build-time clock or the attestation `sampled_at`.
   */
  snapshot_start_ts: string;
}

/** Minimal change-object identity used to derive the snapshot row key. */
export interface SnapshotObjectKey {
  schema: string;
  name: string;
  primary_key?: Record<string, unknown>;
}

/**
 * Deterministic snapshot epoch id (Rev-4 §2.1):
 *   "snap-" + sha256(canonical{db_id, server_uuid, watermark file/pos, start_ts})[:16]
 */
export function snapshotEpochId(parts: SnapshotEpochParts): string {
  const digest = sha256Hex(
    serializeCanonical({
      db_id: parts.db_id,
      server_uuid: parts.server_uuid,
      snapshot_start_binlog_file: parts.snapshot_start_binlog_file,
      snapshot_start_binlog_pos: parts.snapshot_start_binlog_pos,
      snapshot_start_ts: parts.snapshot_start_ts,
    }),
  );
  return `snap-${digest.slice(0, 16)}`;
}

/**
 * Collision-free row-identity hash (Rev-4 §3): a canonical-tuple hash of
 * {schema, name, primary_key}. Joining only fixed-format hex tokens removes the
 * delimiter-aliasing risk of naive string concatenation (F4).
 */
export function rowKeyHash(object: SnapshotObjectKey): string {
  return sha256Hex(
    serializeCanonical({
      schema: object.schema,
      name: object.name,
      primary_key: object.primary_key ?? {},
    }),
  );
}

/** Snapshot transaction id (Rev-4 §3): "snapshot:" + epoch + ":" + rowKeyHash. */
export function snapshotTxId(epochId: string, object: SnapshotObjectKey): string {
  return `snapshot:${epochId}:${rowKeyHash(object)}`;
}

/** Snapshot completeness key (Rev-4 §4): "snapshot-epoch:" + epoch. */
export function snapshotConsumedOffsetKey(epochId: string): string {
  return `snapshot-epoch:${epochId}`;
}
