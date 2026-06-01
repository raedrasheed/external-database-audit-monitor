// Fidelity & completeness attachment (Epic E4 / EDAM-T026).
//
// Assembles a NormalizedTransaction from a grouped transaction plus the latest
// fidelity (E3 config_snapshot) and completeness (E3 CompletenessUpdate). The
// final fidelity is the worst of the attestation state and the completeness
// signal (EDAM v2 §4.3). INV-2: never assume HEALTHY — missing attestation or
// missing completeness yields DEGRADED with an honest reason; gap_detected is
// taken as analyzed (false means "no gap detected", paired with DEGRADED when
// completeness was not attested).

import type {
  GroupedTransaction,
} from './accumulator.js';
import { snapshotConsumedOffsetKey } from '@edam/canonical';
import type {
  FidelityState,
  NormalizedActor,
  NormalizedCompleteness,
  NormalizedFidelity,
  NormalizedTransaction,
} from '@edam/cce-model';

export interface FidelityProvider {
  current(dbId: string): NormalizedFidelity | null;
}
export interface CompletenessProvider {
  current(dbId: string): NormalizedCompleteness | null;
}

export const UNATTESTED_FIDELITY: NormalizedFidelity = {
  state: 'DEGRADED',
  degraded_reason: 'no fidelity attestation available',
  source_config: {
    binlog_format: null,
    binlog_row_image: null,
    gtid_mode: null,
    replica_identity: null,
    log_bin: null,
    config_snapshot_id: 'unattested',
  },
};

const RANK: Record<FidelityState, number> = { HEALTHY: 0, DEGRADED: 1, COMPROMISED: 2 };
function worst(a: FidelityState, b: FidelityState): FidelityState {
  return RANK[b] > RANK[a] ? b : a;
}

export function combineFidelity(
  fidelity: NormalizedFidelity | null,
  completeness: NormalizedCompleteness | null,
): NormalizedFidelity {
  const base = fidelity ?? UNATTESTED_FIDELITY;
  const notes = [...(base.notes ?? [])];
  let state = base.state;
  let reason = base.degraded_reason ?? null;

  if (!completeness) {
    state = worst(state, 'DEGRADED');
    notes.push('completeness not attested');
    reason = reason ?? 'completeness not attested';
  } else if (completeness.gap_detected) {
    state = worst(state, 'DEGRADED');
    notes.push('completeness gap detected');
    reason = reason ?? 'completeness gap detected';
  }

  return {
    state,
    source_config: base.source_config,
    degraded_reason: state === 'HEALTHY' ? null : reason,
    ...(notes.length ? { notes } : {}),
  };
}

export function assembleTransaction(
  group: GroupedTransaction,
  fidelity: NormalizedFidelity | null,
  completeness: NormalizedCompleteness | null,
  actor: NormalizedActor,
): NormalizedTransaction {
  // Snapshot reads always carry the epoch-based completeness (snapshot offsets
  // are excluded from GTID-gap analysis; their coverage is the epoch + handoff),
  // so a streaming completeness provider never strips the snapshot_epoch_id.
  const effectiveCompleteness = group.snapshot_epoch_id
    ? defaultCompleteness(group)
    : (completeness ?? defaultCompleteness(group));
  // Fidelity worst-cases against the SAME completeness the event carries, so a
  // healthy snapshot (no gap) is not spuriously degraded; streaming is unchanged.
  const fidelityCompleteness = group.snapshot_epoch_id ? effectiveCompleteness : completeness;
  return {
    source: group.source,
    transaction: {
      tx_id: group.tx_id,
      // commit_ts is capture-sourced (source snapshot ts_ms for snapshot reads);
      // fall back to the trusted ingest time when the source did not provide it.
      commit_ts: group.commit_ts ?? group.ingest_ts,
      ingest_ts: group.ingest_ts,
    },
    offset: group.offset,
    fidelity: combineFidelity(fidelity, fidelityCompleteness),
    completeness: effectiveCompleteness,
    actor,
    changes: group.changes,
  };
}

/**
 * Completeness when no attested record is available. For a snapshot read the
 * key is the epoch (CCE-AMD-001 Rev 4 §4) and the snapshot_epoch_id is carried;
 * for streaming the tx_id stands in (unchanged behavior).
 */
function defaultCompleteness(group: GroupedTransaction): NormalizedCompleteness {
  if (group.snapshot_epoch_id) {
    return {
      consumed_offset_key: snapshotConsumedOffsetKey(group.snapshot_epoch_id),
      gap_detected: false,
      snapshot_phase: group.snapshot_phase,
      snapshot_epoch_id: group.snapshot_epoch_id,
    };
  }
  return {
    consumed_offset_key: group.tx_id,
    gap_detected: false,
    snapshot_phase: group.snapshot_phase,
  };
}
