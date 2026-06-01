// GTID set arithmetic + engine-aware codecs (Epic E3 / EDAM-T021).
//
// Used by the Completeness Watcher to track the consumed GTID set and detect
// continuity gaps. Two gap signals:
//   1. an INTERNAL hole in the consumed set (a skipped transaction) — reliable
//      for both engines, source-independent;
//   2. gtids the SOURCE executed at/below our consumed watermark that we never
//      consumed (requires the source executed set; precise for MySQL).
//
// Implementation note (MariaDB): MariaDB GTIDs are domain-server-sequence and
// @@gtid_binlog_pos exposes only the latest seq per domain (a watermark, not a
// full range). The safest single-primary behavior is to key the set by DOMAIN
// and rely primarily on internal-hole detection. Multi-server-per-domain
// topologies would need server-aware keying — reported as a limitation, not a
// spec change.

import type { Engine } from '../engine.js';

export interface GtidInterval {
  key: string;
  start: number;
  end: number;
}

export interface GtidCodec {
  /** Parse a single transaction GTID (e.g. "UUID:152" / "0-1-152"). */
  parseToken(token: string): GtidInterval[];
  /** Parse an executed/binlog-pos set string. */
  parseExecuted(set: string): GtidInterval[];
}

function parseRange(key: string, range: string): GtidInterval | null {
  const m = range.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  return { key, start, end };
}

/** MySQL: "UUID:1-5:7-9" / set "UUID:1-5,UUID2:1-3". */
export class MysqlGtidCodec implements GtidCodec {
  parseToken(token: string): GtidInterval[] {
    const parts = token.trim().split(':');
    if (parts.length < 2) return [];
    const key = parts[0]!.toLowerCase();
    const out: GtidInterval[] = [];
    for (const r of parts.slice(1)) {
      const iv = parseRange(key, r);
      if (iv) out.push(iv);
    }
    return out;
  }
  parseExecuted(set: string): GtidInterval[] {
    return set
      .replace(/\s+/g, '')
      .split(',')
      .filter(Boolean)
      .flatMap((t) => this.parseToken(t));
  }
}

/** MariaDB: "domain-server-seq" keyed by domain. */
export class MariaDbGtidCodec implements GtidCodec {
  parseToken(token: string): GtidInterval[] {
    const m = token.trim().match(/^(\d+)-(\d+)-(\d+)$/);
    if (!m) return [];
    const domain = m[1]!;
    const seq = Number(m[3]);
    return [{ key: domain, start: seq, end: seq }];
  }
  parseExecuted(set: string): GtidInterval[] {
    return set
      .replace(/\s+/g, '')
      .split(',')
      .filter(Boolean)
      .flatMap((t) => this.parseToken(t));
  }
}

export function getCodec(engine: Engine): GtidCodec {
  return engine === 'mariadb' ? new MariaDbGtidCodec() : new MysqlGtidCodec();
}

type Interval = [number, number];

function mergeIntervals(ivs: Interval[]): Interval[] {
  if (ivs.length === 0) return [];
  const sorted = [...ivs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]!;
    const cur = sorted[i]!;
    if (cur[0] <= last[1] + 1) last[1] = Math.max(last[1], cur[1]);
    else out.push([cur[0], cur[1]]);
  }
  return out;
}

/** Subtract covered intervals from a single range; returns uncovered parts. */
function subtractRange(range: Interval, covers: Interval[]): Interval[] {
  let segments: Interval[] = [range];
  for (const [cs, ce] of covers) {
    const next: Interval[] = [];
    for (const [s, e] of segments) {
      if (ce < s || cs > e) {
        next.push([s, e]);
        continue;
      }
      if (cs > s) next.push([s, cs - 1]);
      if (ce < e) next.push([ce + 1, e]);
    }
    segments = next;
  }
  return segments.filter(([s, e]) => s <= e);
}

export class GtidSet {
  private readonly map = new Map<string, Interval[]>();

  add(iv: GtidInterval): void {
    const cur = this.map.get(iv.key) ?? [];
    cur.push([iv.start, iv.end]);
    this.map.set(iv.key, mergeIntervals(cur));
  }

  addToken(codec: GtidCodec, token: string): void {
    for (const iv of codec.parseToken(token)) this.add(iv);
  }

  static parse(codec: GtidCodec, set: string): GtidSet {
    const s = new GtidSet();
    for (const iv of codec.parseExecuted(set)) s.add(iv);
    return s;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  intervalsFor(key: string): Interval[] {
    return (this.map.get(key) ?? []).map(([s, e]) => [s, e]);
  }

  highWatermark(key: string): number {
    const ivs = this.map.get(key);
    return ivs && ivs.length ? ivs[ivs.length - 1]![1] : Number.NEGATIVE_INFINITY;
  }

  contains(key: string, n: number): boolean {
    return (this.map.get(key) ?? []).some(([s, e]) => n >= s && n <= e);
  }

  count(): number {
    let total = 0;
    for (const ivs of this.map.values()) for (const [s, e] of ivs) total += e - s + 1;
    return total;
  }

  /** Keys whose consumed intervals are non-contiguous (an internal hole). */
  internalGapKeys(): string[] {
    return [...this.map.entries()].filter(([, ivs]) => ivs.length > 1).map(([k]) => k);
  }

  hasInternalGap(): boolean {
    return this.internalGapKeys().length > 0;
  }

  /** gtids the source executed at/below our watermark that we never consumed. */
  missingBelowWatermark(source: GtidSet): GtidInterval[] {
    const out: GtidInterval[] = [];
    for (const [key, sivs] of source.map.entries()) {
      if (!this.has(key)) continue; // no watermark for this key -> not a confirmed gap
      const hw = this.highWatermark(key);
      const covers = this.intervalsFor(key);
      for (const [s, e] of sivs) {
        const hi = Math.min(e, hw);
        if (s > hi) continue;
        for (const [ms, me] of subtractRange([s, hi], covers)) {
          out.push({ key, start: ms, end: me });
        }
      }
    }
    return out;
  }

  toString(): string {
    return [...this.map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, ivs]) => `${k}:${ivs.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(':')}`)
      .join(',');
  }
}
