// Normalizer orchestration (Epic E4 / EDAM-T028).
//
// Ties the pipeline together for each CDC CAPTURED record:
//   map (native -> event) -> group by transaction -> attach fidelity/completeness
//   + correlate attribution -> buildCce (chained) -> stream guard -> emit.
//
// NO EVENT LOSS: every record ends in exactly one outcome — EMITTED, DUPLICATE
// (idempotent skip; already emitted), or routed to the DLQ. Any mapping or build
// failure is recorded in the DLQ (which alarms); nothing is dropped, and no CCE
// is fabricated (a failed build never emits).

import { buildCce, CceBuildError, type Cce, type NormalizedActor } from '@edam/cce-model';
import type { DlqService } from '@edam/dlq';
import { mapCapturedRecord, NormalizationError, type CapturedRecord, type PrimaryKeyResolver } from './native-map.js';
import { TransactionAccumulator, type GroupedTransaction } from './accumulator.js';
import { assembleTransaction, type CompletenessProvider, type FidelityProvider } from './context.js';
import { correlateActor, type AuditEventSource } from './attribution.js';
import { CceStreamGuard } from './dedup.js';

export interface NormalizerDeps {
  pkResolver: PrimaryKeyResolver;
  fidelity: FidelityProvider;
  completeness: CompletenessProvider;
  /** Optional; without an audit source, attribution is `unattributed`. */
  audit?: AuditEventSource;
  sensitiveFields?: string[];
  dlq: DlqService;
  emit: (cce: Cce) => void | Promise<void>;
  windowMs?: number;
}

export interface NormalizerStats {
  emitted: number;
  duplicates: number;
  dlq: number;
}

export class Normalizer {
  private readonly acc = new TransactionAccumulator();
  private readonly guard = new CceStreamGuard();
  private readonly lastRowHash = new Map<string, string>();
  readonly stats: NormalizerStats = { emitted: 0, duplicates: 0, dlq: 0 };

  constructor(private readonly deps: NormalizerDeps) {}

  /** Process one CAPTURED record; flushes any completed transaction(s). */
  async process(record: CapturedRecord): Promise<void> {
    let event;
    try {
      event = mapCapturedRecord(record, this.deps.pkResolver);
    } catch (err) {
      await this.deps.dlq.record({
        engine: record.source.engine,
        offset: record.offset.gtid,
        payload: record.raw_native,
        error: err,
        category: err instanceof NormalizationError ? 'MALFORMED_CDC_EVENT' : 'UNEXPECTED_EXCEPTION',
      });
      this.stats.dlq += 1;
      return;
    }
    for (const group of this.acc.add(event)) await this.finalize(group);
  }

  /** Flush the buffered (in-progress) transaction, if any. */
  async flush(): Promise<void> {
    const group = this.acc.flush();
    if (group) await this.finalize(group);
  }

  private correlate(group: GroupedTransaction): NormalizedActor {
    if (!this.deps.audit) return { attribution_confidence: 'unattributed' };
    const tables = [...new Set(group.changes.map((c) => c.object.name))];
    const query = {
      dbId: group.source.db_id,
      commitTs: group.commit_ts ?? group.ingest_ts,
      tables,
      windowMs: this.deps.windowMs,
      gtid: group.tx_id,
    };
    return correlateActor(query, this.deps.audit.candidates(query));
  }

  private async finalize(group: GroupedTransaction): Promise<void> {
    const dbId = group.source.db_id;
    const tx = assembleTransaction(
      group,
      this.deps.fidelity.current(dbId),
      this.deps.completeness.current(dbId),
      this.correlate(group),
    );

    let cce: Cce;
    try {
      cce = buildCce(tx, {
        sensitiveFields: this.deps.sensitiveFields,
        prevRowHash: this.lastRowHash.get(dbId) ?? null,
      });
    } catch (err) {
      await this.deps.dlq.record({
        engine: group.source.engine,
        offset: group.tx_id,
        payload: group,
        error: err,
        category: err instanceof CceBuildError ? 'SCHEMA_VALIDATION_FAILURE' : 'UNEXPECTED_EXCEPTION',
      });
      this.stats.dlq += 1;
      return;
    }

    const result = this.guard.check(cce);
    if (result.action === 'INTEGRITY_VIOLATION') {
      await this.deps.dlq.record({
        engine: group.source.engine,
        offset: group.tx_id,
        payload: cce,
        category: 'UNEXPECTED_EXCEPTION',
        reason: 'duplicate envelope_id with a differing event_hash (V15 integrity violation)',
      });
      this.stats.dlq += 1;
      return;
    }
    if (result.action === 'DUPLICATE') {
      this.stats.duplicates += 1;
      return; // idempotent skip (already emitted)
    }

    this.lastRowHash.set(dbId, cce.evidence.row_hash);
    await this.deps.emit(cce);
    this.stats.emitted += 1;
  }
}
