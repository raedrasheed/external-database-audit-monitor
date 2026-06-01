// Tests for stateful validation rules (Epic E1 / EDAM-T008).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateCceFull,
  validateCceStateful,
  computeEventHash,
  CceStreamValidator,
} from '../src/index.js';
import { envelopeId } from '@edam/canonical';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(HERE, 'fixtures/valid/cce-donation-update.json'), 'utf8'));
const clone = <T>(v: T): T => structuredClone(v);

// The Appendix C.1 fixture uses a placeholder envelope_id; derive the correct
// one so the positive cases pass V3.
function withDerivedId(cce: Record<string, any>): Record<string, any> {
  const c = clone(cce);
  c.envelope_id = envelopeId({
    db_id: c.source.db_id,
    tx_id: c.transaction.tx_id,
    server_uuid: c.source.server_uuid,
  });
  return c;
}

describe('validateCceFull', () => {
  it('accepts a fully valid CCE (schema + version + stateful)', () => {
    const r = validateCceFull(withDerivedId(base));
    expect(r).toEqual({ valid: true, errors: [] });
  });

  it('V3: rejects a non-derived envelope_id', () => {
    const bad = withDerivedId(base);
    bad.envelope_id = '00000000-0000-0000-0000-000000000000';
    expect(validateCceFull(bad).errors.some((e) => e.rule === 'V3')).toBe(true);
  });

  it('V4: rejects non-contiguous seq', () => {
    const bad = withDerivedId(base);
    bad.changes[0].seq = 1;
    expect(validateCceStateful(bad).some((e) => e.rule === 'V4')).toBe(true);
  });

  it('V11: rejects an empty real offset key (HIGH-1, no V16 bypass)', () => {
    const bad = withDerivedId(base);
    bad.offset.gtid = '';
    const rules = validateCceStateful(bad).map((e) => e.rule);
    expect(rules).toContain('V11'); // empty gtid flagged
    expect(rules).toContain('V16'); // and treated as binlog-only -> guard fires (streaming phase)
  });

  it('V16: binlog-only offset on a cce-1.0 streaming event is rejected', () => {
    const bad = withDerivedId(base);
    bad.offset = { gtid: null, binlog_file: 'mysql-bin.000003', binlog_pos: 4096, lsn: null, scn: null, resume_token: null };
    expect(validateCceStateful(bad).some((e) => e.rule === 'V16')).toBe(true);
  });

  it('V16: accepts a well-formed cce-1.1 snapshot binlog-only offset', () => {
    const ok = withDerivedId(base);
    ok.schema_version = 'cce-1.1';
    ok.offset = { gtid: null, binlog_file: 'mysql-bin.000003', binlog_pos: 4096, lsn: null, scn: null, resume_token: null };
    ok.completeness.snapshot_phase = 'snapshot';
    ok.completeness.snapshot_epoch_id = 'snap-0123456789abcdef';
    expect(validateCceStateful(ok).some((e) => e.rule === 'V16')).toBe(false);
  });

  it('V17: rejects a snapshot event whose snapshot_epoch_id does not derive', () => {
    const bad = withDerivedId(base);
    bad.completeness.snapshot_phase = 'snapshot';
    bad.completeness.snapshot_epoch_id = 'snap-deadbeefdeadbeef'; // not derived from the watermark
    expect(validateCceStateful(bad).some((e) => e.rule === 'V17')).toBe(true);
  });

  it('V17: streaming events are not subject to the snapshot identity rule', () => {
    const ok = withDerivedId(base); // snapshot_phase: 'streaming'
    expect(validateCceStateful(ok).some((e) => e.rule === 'V17')).toBe(false);
  });

  it('V4: rejects statement_count != changes.length', () => {
    const bad = withDerivedId(base);
    bad.transaction.statement_count = 2;
    expect(validateCceStateful(bad).some((e) => e.rule === 'V4')).toBe(true);
  });

  it('V6: rejects a row op without object.primary_key', () => {
    const bad = withDerivedId(base);
    delete bad.changes[0].object.primary_key;
    expect(validateCceStateful(bad).some((e) => e.rule === 'V6')).toBe(true);
  });

  it('V12: accepts correct evidence and rejects a tampered event_hash', () => {
    const withEv = withDerivedId(base);
    withEv.evidence = { event_hash: computeEventHash(withEv) };
    expect(validateCceStateful(withEv).some((e) => e.rule === 'V12')).toBe(false);

    const tampered = withDerivedId(base);
    tampered.evidence = { event_hash: 'sha256:' + '0'.repeat(64) };
    expect(validateCceStateful(tampered).some((e) => e.rule === 'V12')).toBe(true);
  });

  it('version gate: rejects an unknown major (cce-2.0)', () => {
    const bad = withDerivedId(base);
    bad.schema_version = 'cce-2.0';
    expect(validateCceFull(bad).errors.some((e) => e.rule === 'VERSION_MAJOR')).toBe(true);
  });
});

describe('CceStreamValidator', () => {
  it('V14: flags a non-monotonic ingest_ts on a stream', () => {
    const v = new CceStreamValidator();
    const a = withDerivedId(base);
    a.transaction.ingest_ts = '2026-06-01T10:00:00.000Z';
    const b = clone(a);
    b.transaction.ingest_ts = '2026-06-01T09:59:00.000Z'; // earlier
    expect(v.check(a)).toEqual([]);
    expect(v.check(b).some((e) => e.rule === 'V14')).toBe(true);
  });

  it('V15: flags a duplicate envelope_id with a differing event_hash', () => {
    const v = new CceStreamValidator();
    const a = withDerivedId(base);
    const b = clone(a); // same envelope_id
    b.changes[0].after.amount = '123456.00'; // changes the content hash
    expect(v.check(a)).toEqual([]);
    expect(v.check(b).some((e) => e.rule === 'V15')).toBe(true);
  });

  it('V15: does not flag a genuine duplicate (same id, same hash)', () => {
    const v = new CceStreamValidator();
    const a = withDerivedId(base);
    expect(v.check(a)).toEqual([]);
    expect(v.check(clone(a))).toEqual([]);
  });
});
