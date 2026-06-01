// CAPTURED record (Epic E2 / EDAM-T014).
//
// This is the collector's output boundary (Sprint plan interface I1,
// Collector -> Normalization). It is PRE-CCE: it carries the raw native event
// plus minimal source/offset metadata. It deliberately contains NO CCE fields
// (no diff, fidelity, completeness, attribution, hashes) — building those is
// the Normalization Service (E4)'s job. No CCEs are created here.

import type { EngineAdapter, OffsetMeta, RawSourceEvent, SourceMeta } from './adapters/types.js';

export interface CapturedRecord {
  /** The raw native Debezium event value, preserved losslessly. */
  raw_native: unknown;
  source: SourceMeta;
  offset: OffsetMeta;
  /** Trusted collector receive time (RFC 3339). */
  captured_at: string;
}

export function buildCapturedRecord(
  adapter: EngineAdapter,
  ev: RawSourceEvent,
  dbId: string,
  capturedAt: string,
): CapturedRecord {
  return {
    raw_native: ev.value,
    source: adapter.extractSource(ev, dbId),
    offset: adapter.extractOffset(ev),
    captured_at: capturedAt,
  };
}
