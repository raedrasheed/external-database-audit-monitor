// Tests for GTID set arithmetic + completeness gap compute (Epic E3 / EDAM-T021).
import { describe, it, expect } from 'vitest';
import { GtidSet, MysqlGtidCodec, MariaDbGtidCodec, getCodec } from '../src/completeness/gtid.js';
import { CompletenessWatcher } from '../src/completeness/watcher.js';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';

describe('MysqlGtidCodec / GtidSet', () => {
  it('parses tokens and merges contiguous intervals (no internal gap)', () => {
    const codec = new MysqlGtidCodec();
    const s = new GtidSet();
    for (let n = 1; n <= 5; n++) s.addToken(codec, `${UUID}:${n}`);
    expect(s.hasInternalGap()).toBe(false);
    expect(s.toString()).toBe(`${UUID}:1-5`);
    expect(s.count()).toBe(5);
    expect(s.highWatermark(UUID)).toBe(5);
  });

  it('detects an internal hole (skipped transaction)', () => {
    const codec = new MysqlGtidCodec();
    const s = new GtidSet();
    for (const n of [1, 2, 4, 5]) s.addToken(codec, `${UUID}:${n}`); // missing 3
    expect(s.hasInternalGap()).toBe(true);
    expect(s.internalGapKeys()).toEqual([UUID]);
    expect(s.toString()).toBe(`${UUID}:1-2:4-5`);
  });

  it('parses executed-set ranges', () => {
    const s = GtidSet.parse(new MysqlGtidCodec(), `${UUID}:1-152`);
    expect(s.count()).toBe(152);
    expect(s.contains(UUID, 100)).toBe(true);
    expect(s.contains(UUID, 153)).toBe(false);
  });

  it('missingBelowWatermark finds source gtids we skipped below our watermark', () => {
    const codec = new MysqlGtidCodec();
    const consumed = new GtidSet();
    for (const n of [1, 2, 4, 5]) consumed.addToken(codec, `${UUID}:${n}`); // watermark 5, missing 3
    const source = GtidSet.parse(codec, `${UUID}:1-10`);
    const missing = consumed.missingBelowWatermark(source);
    expect(missing).toEqual([{ key: UUID, start: 3, end: 3 }]); // 6-10 are lag, not gap
  });

  it('treats above-watermark source gtids as lag (not a gap)', () => {
    const codec = new MysqlGtidCodec();
    const consumed = GtidSet.parse(codec, `${UUID}:1-5`);
    const source = GtidSet.parse(codec, `${UUID}:1-10`);
    expect(consumed.missingBelowWatermark(source)).toEqual([]);
  });
});

describe('MariaDbGtidCodec', () => {
  it('keys by domain and parses domain-server-seq', () => {
    const s = new GtidSet();
    const codec = new MariaDbGtidCodec();
    s.addToken(codec, '0-223355-100');
    s.addToken(codec, '0-223355-101');
    expect(s.toString()).toBe('0:100-101');
    expect(s.hasInternalGap()).toBe(false);
    s.addToken(codec, '0-223355-103'); // missing 102
    expect(s.hasInternalGap()).toBe(true);
  });
});

describe('CompletenessWatcher.computeGap', () => {
  it('reports no gap for a contiguous consumed set', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    for (let n = 1; n <= 5; n++) w.observeConsumed(`${UUID}:${n}`);
    const r = w.computeGap(`${UUID}:1-10`); // source ahead = lag
    expect(r.gap_detected).toBe(false);
    expect(w.consumedSetString()).toBe(`${UUID}:1-5`);
  });

  it('reports a gap on an internal hole', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    for (const n of [1, 2, 4, 5]) w.observeConsumed(`${UUID}:${n}`);
    expect(w.computeGap().gap_detected).toBe(true);
    expect(w.computeGap(`${UUID}:1-10`).gap_detected).toBe(true);
  });

  it('ignores null gtids (e.g. snapshot reads)', () => {
    const w = new CompletenessWatcher({ engine: 'mysql', dbId: 'kafel-dev-mysql' });
    w.observeConsumed(null);
    w.observeConsumed(`${UUID}:1`);
    expect(w.computeGap().gap_detected).toBe(false);
  });

  it('selects the right codec per engine', () => {
    expect(getCodec('mysql')).toBeInstanceOf(MysqlGtidCodec);
    expect(getCodec('mariadb')).toBeInstanceOf(MariaDbGtidCodec);
  });
});
