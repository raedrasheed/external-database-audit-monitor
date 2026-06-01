// Stateful / cross-field validation rules (Epic E1 / EDAM-T008).
//
// JSON Schema cannot express these CCE §10 rules; they are enforced in code
// using the deterministic primitives from @edam/canonical:
//   V3  envelope_id derivation        (single object)
//   V4  seq contiguity + statement_count (single object)
//   V6  row ops have object.primary_key  (single object; ERRATA-CCE-001)
//   V11 non-empty real offset key        (single object; CCE-AMD-001 Rev 4 HIGH-1)
//   V12 event_hash / row_hash recomputation (single object, when evidence present)
//   V13 anchor_ref structural completeness  (single object, when anchored)
//   V16 binlog-only offset positive guard (single object; Rev 4 §5)
//   V14 ingest_ts monotonic per stream   (stream — see CceStreamValidator)
//   V15 duplicate envelope_id w/ differing event_hash (stream)

import {
  envelopeId,
  serializeCanonical,
  eventHash,
  rowHash,
  snapshotEpochId,
  snapshotTxId,
  snapshotConsumedOffsetKey,
} from '@edam/canonical';
import type { RuleId } from './rules.js';
import type { ValidationError } from './validator.js';

const ROW_OPS = new Set(['INSERT', 'UPDATE', 'DELETE']);

function err(rule: RuleId, instancePath: string, message: string): ValidationError {
  return { rule, instancePath, keyword: 'stateful', message };
}

type Cce = Record<string, any>;

/** event_hash over the canonical CCE core (envelope minus `evidence`). */
export function computeEventHash(cce: Cce): string {
  const core: Cce = { ...cce };
  delete core.evidence;
  return eventHash(serializeCanonical(core));
}

/** Single-object stateful rules: V3, V4, V6, V12, V13. */
export function validateCceStateful(cce: Cce): ValidationError[] {
  const errors: ValidationError[] = [];

  // V3 — envelope_id derivation (CCE §3). Only checked when the inputs exist
  // and no size-split `part` is involved (parts are not represented here).
  const dbId = cce.source?.db_id;
  const txId = cce.transaction?.tx_id;
  const serverUuid = cce.source?.server_uuid;
  if (typeof dbId === 'string' && typeof txId === 'string' && typeof serverUuid === 'string' &&
      typeof cce.envelope_id === 'string') {
    const expected = envelopeId({ db_id: dbId, tx_id: txId, server_uuid: serverUuid });
    if (expected !== cce.envelope_id) {
      errors.push(err('V3', '/envelope_id',
        `envelope_id does not derive from (db_id|tx_id|server_uuid); expected ${expected}`));
    }
  }

  // V4 — seq contiguous from 0 and statement_count === changes.length.
  const changes = Array.isArray(cce.changes) ? cce.changes : [];
  if (changes.length > 0) {
    for (let i = 0; i < changes.length; i++) {
      if (changes[i]?.seq !== i) {
        errors.push(err('V4', `/changes/${i}/seq`, `seq must be contiguous from 0; expected ${i}`));
        break;
      }
    }
  }
  if (typeof cce.transaction?.statement_count === 'number' &&
      cce.transaction.statement_count !== changes.length) {
    errors.push(err('V4', '/transaction/statement_count',
      `statement_count (${cce.transaction.statement_count}) !== changes.length (${changes.length})`));
  }

  // V6 — row operations carry object.primary_key (ERRATA-CCE-001; CCE §10 V6).
  changes.forEach((c: Cce, i: number) => {
    if (ROW_OPS.has(c?.operation)) {
      const pk = c?.object?.primary_key;
      if (typeof pk !== 'object' || pk === null || Array.isArray(pk) || Object.keys(pk).length === 0) {
        errors.push(err('V6', `/changes/${i}/object/primary_key`,
          'row operation requires a non-empty object.primary_key'));
      }
    }
  });

  // V11 / V16 — offset validity (CCE-AMD-001 Rev 4). Defense-in-depth for the
  // cce-1.1 schema: re-enforced in code so the guarantee survives any schema
  // re-vendor error and gets a precise rule id.
  const offset = (cce.offset ?? {}) as Record<string, unknown>;
  const REAL_KEYS = ['gtid', 'lsn', 'scn', 'resume_token'] as const;
  // V11 — a present real engine key must be a non-empty string (HIGH-1).
  for (const k of REAL_KEYS) {
    if (typeof offset[k] === 'string' && (offset[k] as string).length === 0) {
      errors.push(err('V11', `/offset/${k}`, `${k} must be a non-empty string`));
    }
  }
  const hasRealKey = REAL_KEYS.some((k) => typeof offset[k] === 'string' && (offset[k] as string).length > 0);
  if (!hasRealKey) {
    // Binlog-only offset (or none): the V16 positive guard must hold.
    const reasons: string[] = [];
    if (cce.schema_version !== 'cce-1.1') reasons.push('schema_version must be cce-1.1');
    const engine = cce.source?.engine;
    if (engine !== 'mysql' && engine !== 'mariadb') reasons.push('engine must be mysql or mariadb');
    const phase = cce.completeness?.snapshot_phase;
    if (phase !== 'snapshot' && phase !== 'handoff') reasons.push('snapshot_phase must be snapshot or handoff');
    const file = offset.binlog_file;
    const pos = offset.binlog_pos;
    if (!(typeof file === 'string' && file.length > 0 && Number.isInteger(pos) && (pos as number) >= 0)) {
      reasons.push('offset must carry a binlog_file + binlog_pos pair');
    }
    if (reasons.length > 0) {
      errors.push(err('V16', '/offset', `binlog-only offset not permitted: ${reasons.join('; ')}`));
    }
  }

  // V17 — snapshot identity (CCE-AMD-001 Rev 4 §1/§3/§4/§11). For snapshot-phase
  // events, snapshot_epoch_id must re-derive from the captured watermark + the
  // capture-sourced snapshot-start timestamp (commit_ts), and tx_id /
  // consumed_offset_key must be the canonical snapshot forms.
  const snapPhase = cce.completeness?.snapshot_phase;
  if (snapPhase === 'snapshot' || snapPhase === 'handoff') {
    const epochId = cce.completeness?.snapshot_epoch_id;
    if (typeof epochId !== 'string' || epochId.length === 0) {
      errors.push(err('V17', '/completeness/snapshot_epoch_id',
        'snapshot-phase event must carry a non-empty snapshot_epoch_id'));
    } else {
      const expectedEpoch = snapshotEpochId({
        db_id: String(cce.source?.db_id ?? ''),
        server_uuid: String(cce.source?.server_uuid ?? ''),
        snapshot_start_binlog_file: String(cce.offset?.binlog_file ?? ''),
        snapshot_start_binlog_pos: Number(cce.offset?.binlog_pos ?? 0),
        snapshot_start_ts: String(cce.transaction?.commit_ts ?? ''),
      });
      if (expectedEpoch !== epochId) {
        errors.push(err('V17', '/completeness/snapshot_epoch_id',
          `snapshot_epoch_id does not derive from the watermark + snapshot-start ts; expected ${expectedEpoch}`));
      }
      const obj = Array.isArray(cce.changes) ? cce.changes[0]?.object : undefined;
      if (obj && typeof obj.schema === 'string' && typeof obj.name === 'string') {
        const expectedTx = snapshotTxId(epochId, { schema: obj.schema, name: obj.name, primary_key: obj.primary_key });
        if (cce.transaction?.tx_id !== expectedTx) {
          errors.push(err('V17', '/transaction/tx_id', `snapshot tx_id must be ${expectedTx}`));
        }
      }
      const expectedKey = snapshotConsumedOffsetKey(epochId);
      if (cce.completeness?.consumed_offset_key !== expectedKey) {
        errors.push(err('V17', '/completeness/consumed_offset_key',
          `snapshot consumed_offset_key must be ${expectedKey}`));
      }
    }
  }

  // V12 — event_hash / row_hash recomputation (only when evidence is present).
  const ev = cce.evidence;
  if (ev && typeof ev.event_hash === 'string') {
    const computed = computeEventHash(cce);
    if (computed !== ev.event_hash) {
      errors.push(err('V12', '/evidence/event_hash',
        `event_hash mismatch: recomputed ${computed}`));
    } else if (typeof ev.prev_row_hash === 'string' && typeof ev.row_hash === 'string') {
      const expectedRow = rowHash(ev.prev_row_hash, ev.event_hash);
      if (expectedRow !== ev.row_hash) {
        errors.push(err('V12', '/evidence/row_hash', `row_hash mismatch: expected ${expectedRow}`));
      }
    }
  }

  // V13 — anchor_ref structural completeness (full crypto verification is at the
  // evidence/anchoring layer, which needs public keys).
  const anchor = ev?.anchor_ref;
  if (anchor && typeof anchor === 'object') {
    if (typeof anchor.hsm_signature !== 'string' || typeof anchor.tsa_token !== 'string') {
      errors.push(err('V13', '/evidence/anchor_ref',
        'anchor_ref must carry hsm_signature and tsa_token'));
    }
  }

  return errors;
}

/**
 * Stream-scoped stateful rules: V14 (monotonic ingest per stream) and V15
 * (duplicate envelope_id with a differing event_hash). Construct one per
 * source stream and feed sealed/complete CCEs in order.
 */
export class CceStreamValidator {
  private readonly lastIngest = new Map<string, string>();
  private readonly hashById = new Map<string, string>();

  check(cce: Cce): ValidationError[] {
    const errors: ValidationError[] = [];

    // V14 — ingest_ts monotonic per stream (stream keyed by source.db_id).
    const stream = String(cce.source?.db_id ?? '');
    const ingest = cce.transaction?.ingest_ts;
    if (typeof ingest === 'string') {
      const last = this.lastIngest.get(stream);
      if (last !== undefined && ingest < last) {
        errors.push(err('V14', '/transaction/ingest_ts',
          `ingest_ts ${ingest} is earlier than a prior event (${last}) on this stream`));
      }
      this.lastIngest.set(stream, last !== undefined && last > ingest ? last : ingest);
    }

    // V15 — duplicate envelope_id with a differing event_hash (critical).
    const id = cce.envelope_id;
    if (typeof id === 'string') {
      const hash = typeof cce.evidence?.event_hash === 'string'
        ? cce.evidence.event_hash
        : computeEventHash(cce);
      const seen = this.hashById.get(id);
      if (seen !== undefined && seen !== hash) {
        errors.push(err('V15', '/envelope_id',
          `duplicate envelope_id ${id} with a differing event_hash (integrity violation)`));
      } else if (seen === undefined) {
        this.hashById.set(id, hash);
      }
    }

    return errors;
  }
}
