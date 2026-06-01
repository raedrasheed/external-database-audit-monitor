// Durable offset / GTID tracking (Epic E2 / EDAM-T012).
//
// The collector advances the persisted offset ONLY AFTER a record has been
// durably handed off to the bus (see collector.ts). On restart it resumes from
// the last committed offset, giving at-least-once delivery with no silent gaps.
// State lives in EDAM's own PostgreSQL (edam_state) — never in the monitored DB
// (INV-1). A copy of the offset/phase is what the Completeness Watcher (E3)
// later consumes.

import type { SnapshotPhase } from './adapters/types.js';

export interface OffsetState {
  /** Stream key = monitored db_id (one resume position per source stream). */
  streamKey: string;
  gtid: string | null;
  binlogFile: string | null;
  binlogPos: number | null;
  phase: SnapshotPhase;
  /** Redis source-stream entry id consumed up to (for the source reader). */
  sourceStreamId: string | null;
  updatedAt: string;
}

export interface OffsetStore {
  load(streamKey: string): Promise<OffsetState | null>;
  commit(state: OffsetState): Promise<void>;
}

/** In-memory store for tests and ephemeral runs. */
export class InMemoryOffsetStore implements OffsetStore {
  private readonly map = new Map<string, OffsetState>();

  async load(streamKey: string): Promise<OffsetState | null> {
    return this.map.get(streamKey) ?? null;
  }

  async commit(state: OffsetState): Promise<void> {
    this.map.set(state.streamKey, { ...state });
  }

  /** Test helper. */
  snapshot(streamKey: string): OffsetState | null {
    const s = this.map.get(streamKey);
    return s ? { ...s } : null;
  }
}

/** Minimal Postgres client surface (satisfied by `pg`'s Pool/Client). */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const TABLE = 'edam_state.cdc_offsets';

/** PostgreSQL-backed durable offset store (EDAM state DB). */
export class PgOffsetStore implements OffsetStore {
  constructor(private readonly db: PgLike) {}

  async ensureSchema(): Promise<void> {
    await this.db.query('CREATE SCHEMA IF NOT EXISTS edam_state');
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         stream_key       TEXT PRIMARY KEY,
         gtid             TEXT,
         binlog_file      TEXT,
         binlog_pos       BIGINT,
         phase            TEXT NOT NULL,
         source_stream_id TEXT,
         updated_at       TIMESTAMPTZ NOT NULL
       )`,
    );
  }

  async load(streamKey: string): Promise<OffsetState | null> {
    const { rows } = await this.db.query(
      `SELECT stream_key, gtid, binlog_file, binlog_pos, phase, source_stream_id, updated_at
         FROM ${TABLE} WHERE stream_key = $1`,
      [streamKey],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      streamKey: r.stream_key,
      gtid: r.gtid ?? null,
      binlogFile: r.binlog_file ?? null,
      binlogPos: r.binlog_pos === null || r.binlog_pos === undefined ? null : Number(r.binlog_pos),
      phase: r.phase as SnapshotPhase,
      sourceStreamId: r.source_stream_id ?? null,
      updatedAt: typeof r.updated_at === 'string' ? r.updated_at : new Date(r.updated_at).toISOString(),
    };
  }

  async commit(state: OffsetState): Promise<void> {
    await this.db.query(
      `INSERT INTO ${TABLE}
         (stream_key, gtid, binlog_file, binlog_pos, phase, source_stream_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (stream_key) DO UPDATE SET
         gtid = EXCLUDED.gtid,
         binlog_file = EXCLUDED.binlog_file,
         binlog_pos = EXCLUDED.binlog_pos,
         phase = EXCLUDED.phase,
         source_stream_id = EXCLUDED.source_stream_id,
         updated_at = EXCLUDED.updated_at`,
      [
        state.streamKey,
        state.gtid,
        state.binlogFile,
        state.binlogPos,
        state.phase,
        state.sourceStreamId,
        state.updatedAt,
      ],
    );
  }
}
