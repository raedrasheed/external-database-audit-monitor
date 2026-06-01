// DLQ store (Epic E5 / EDAM-T037).
//
// Append-only: items are inserted or upserted by event_id (retry_count grows);
// there is NO delete API — nothing leaves the DLQ silently. State lives in
// EDAM's own PostgreSQL (edam_state), never the monitored DB (INV-1).

import type { DlqItem } from './types.js';

export interface DlqFilter {
  status?: DlqItem['status'];
  category?: DlqItem['failure_category'];
  engine?: string;
}

export interface DlqStore {
  /** Insert or replace by event_id (no deletion). */
  upsert(item: DlqItem): Promise<void>;
  get(eventId: string): Promise<DlqItem | null>;
  list(filter?: DlqFilter): Promise<DlqItem[]>;
  count(filter?: DlqFilter): Promise<number>;
}

function matches(item: DlqItem, filter?: DlqFilter): boolean {
  if (!filter) return true;
  if (filter.status && item.status !== filter.status) return false;
  if (filter.category && item.failure_category !== filter.category) return false;
  if (filter.engine && item.source_engine !== filter.engine) return false;
  return true;
}

export class InMemoryDlqStore implements DlqStore {
  private readonly map = new Map<string, DlqItem>();

  async upsert(item: DlqItem): Promise<void> {
    this.map.set(item.event_id, { ...item });
  }
  async get(eventId: string): Promise<DlqItem | null> {
    const i = this.map.get(eventId);
    return i ? { ...i } : null;
  }
  async list(filter?: DlqFilter): Promise<DlqItem[]> {
    return [...this.map.values()].filter((i) => matches(i, filter)).map((i) => ({ ...i }));
  }
  async count(filter?: DlqFilter): Promise<number> {
    return (await this.list(filter)).length;
  }
}

/** Minimal Postgres surface (satisfied by `pg`). */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const TABLE = 'edam_state.dlq';

export class PgDlqStore implements DlqStore {
  constructor(private readonly db: PgLike) {}

  async ensureSchema(): Promise<void> {
    await this.db.query('CREATE SCHEMA IF NOT EXISTS edam_state');
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         event_id         TEXT PRIMARY KEY,
         source_engine    TEXT NOT NULL,
         offset_key       TEXT,
         failure_category TEXT NOT NULL,
         failure_reason   TEXT NOT NULL,
         captured_at      TIMESTAMPTZ NOT NULL,
         retry_count      INTEGER NOT NULL,
         retryable        BOOLEAN NOT NULL,
         status           TEXT NOT NULL,
         original_payload JSONB,
         payload_hash     TEXT NOT NULL,
         first_seen       TIMESTAMPTZ NOT NULL,
         last_seen        TIMESTAMPTZ NOT NULL
       )`,
    );
  }

  private rowToItem(r: any): DlqItem {
    return {
      event_id: r.event_id,
      source_engine: r.source_engine,
      offset: r.offset_key ?? null,
      failure_category: r.failure_category,
      failure_reason: r.failure_reason,
      captured_at: typeof r.captured_at === 'string' ? r.captured_at : new Date(r.captured_at).toISOString(),
      retry_count: Number(r.retry_count),
      retryable: !!r.retryable,
      status: r.status,
      original_payload: r.original_payload,
      payload_hash: r.payload_hash,
      first_seen: typeof r.first_seen === 'string' ? r.first_seen : new Date(r.first_seen).toISOString(),
      last_seen: typeof r.last_seen === 'string' ? r.last_seen : new Date(r.last_seen).toISOString(),
    };
  }

  async upsert(item: DlqItem): Promise<void> {
    await this.db.query(
      `INSERT INTO ${TABLE}
         (event_id, source_engine, offset_key, failure_category, failure_reason, captured_at,
          retry_count, retryable, status, original_payload, payload_hash, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (event_id) DO UPDATE SET
         failure_category = EXCLUDED.failure_category,
         failure_reason = EXCLUDED.failure_reason,
         retry_count = EXCLUDED.retry_count,
         retryable = EXCLUDED.retryable,
         status = EXCLUDED.status,
         last_seen = EXCLUDED.last_seen`,
      [
        item.event_id, item.source_engine, item.offset, item.failure_category, item.failure_reason,
        item.captured_at, item.retry_count, item.retryable, item.status,
        JSON.stringify(item.original_payload ?? null), item.payload_hash, item.first_seen, item.last_seen,
      ],
    );
  }

  async get(eventId: string): Promise<DlqItem | null> {
    const { rows } = await this.db.query(`SELECT * FROM ${TABLE} WHERE event_id = $1`, [eventId]);
    return rows[0] ? this.rowToItem(rows[0]) : null;
  }

  async list(filter?: DlqFilter): Promise<DlqItem[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter?.status) { vals.push(filter.status); where.push(`status = $${vals.length}`); }
    if (filter?.category) { vals.push(filter.category); where.push(`failure_category = $${vals.length}`); }
    if (filter?.engine) { vals.push(filter.engine); where.push(`source_engine = $${vals.length}`); }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.db.query(`SELECT * FROM ${TABLE}${clause} ORDER BY last_seen DESC`, vals);
    return rows.map((r) => this.rowToItem(r));
  }

  async count(filter?: DlqFilter): Promise<number> {
    return (await this.list(filter)).length;
  }
}
