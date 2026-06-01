// Evidence-writer types (Sprint-2 / EDAM-T106).

import type { Cce, SnapshotEpochManifest } from '@edam/cce-model';
import type { DlqItem } from '@edam/dlq';

/** Evidence object types that may be appended to WORM (WORM §3). */
export type EvidenceObjectType = 'cce' | 'snapshot_epoch_manifest';

/** An object the writer can append (a validated CCE or a snapshot epoch manifest). */
export type AppendableObject = Cce | SnapshotEpochManifest;

/**
 * Where an object sits in its segment. The segment lifecycle / global ordering /
 * caps are owned by the segment accumulator (EDAM-T107); the writer only places
 * an object at a given (segment_id, seq).
 */
export interface EvidencePlacement {
  segment_id: string;
  seq: number;
}

/** Successful placement metadata (feeds the segment manifest object_list later). */
export interface AppendResult {
  worm_object_key: string;
  segment_id: string;
  object_id: string;
  object_type: EvidenceObjectType;
}

/**
 * Outcome of an append. Either the object was WRITTEN to WORM (with back-refs on
 * a CCE), or it was routed to the DLQ (validation or write failure) — never lost,
 * never silently dropped (INV-2 / no-fabrication).
 */
export type AppendOutcome =
  | { status: 'WRITTEN'; result: AppendResult; object: AppendableObject }
  | { status: 'DLQ'; item: DlqItem; reason: string };
