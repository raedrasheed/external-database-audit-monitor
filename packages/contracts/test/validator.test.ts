// Tests for the validator API (Epic E1 / EDAM-T007).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate, validateCce } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const validCce = JSON.parse(
  readFileSync(join(HERE, 'fixtures/valid/cce-donation-update.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return structuredClone(v);
}

describe('validate', () => {
  it('accepts a valid CCE (CCE Appendix C.1)', () => {
    const r = validateCce(validCce);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects an unknown schema_version (V1)', () => {
    const bad = clone(validCce);
    bad.schema_version = 'ccv-1.0';
    const r = validateCce(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.rule === 'V1')).toBe(true);
  });

  it('rejects a bad kind (V2)', () => {
    const bad = clone(validCce);
    bad.kind = 'row';
    expect(validateCce(bad).errors.some((e) => e.rule === 'V2')).toBe(true);
  });

  it('rejects an INSERT whose before is non-null (V5)', () => {
    const bad = clone(validCce);
    bad.changes[0].operation = 'INSERT';
    bad.changes[0].before = { id: 1 };
    expect(validateCce(bad).errors.some((e) => e.rule === 'V5')).toBe(true);
  });

  it('rejects a bad fidelity.state (V8)', () => {
    const bad = clone(validCce);
    bad.fidelity.state = 'GREEN';
    expect(validateCce(bad).errors.some((e) => e.rule === 'V8')).toBe(true);
  });

  it('rejects an offset with no engine key (V11)', () => {
    const bad = clone(validCce);
    bad.offset = { gtid: null, binlog_file: null, binlog_pos: null, lsn: null, scn: null, resume_token: null };
    expect(validateCce(bad).errors.some((e) => e.rule === 'V11')).toBe(true);
  });

  it('validates companion schemas structurally', () => {
    const r = validate('db-audit-event-1.0', { not: 'an audit event' });
    expect(r.valid).toBe(false);
  });
});
