// Evidence/WORM schema vendoring + validators (Sprint-2 / EDAM-T101).
//
// Asserts the four WORM §16 schemas load, are registered, validate positive
// sample fixtures, and reject negative fixtures. Stateful evidence checks
// (hash/chain/signature/anchor) are NOT in scope here — they arrive in later
// Sprint-2 tasks + the WV conformance suite.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SCHEMAS,
  SCHEMA_IDS,
  validate,
  validateEvidenceSegmentManifest,
  validateAnchorRecord,
  validateVerificationReport,
  validateEvidenceExportPackage,
  type SchemaId,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (rel: string): unknown => JSON.parse(readFileSync(join(HERE, 'fixtures/evidence', rel), 'utf8'));

const EVIDENCE_IDS: SchemaId[] = [
  'evidence-segment-manifest-1.0',
  'anchor-record-1.0',
  'verification-report-1.0',
  'evidence-export-package-1.0',
];

describe('evidence schemas — registry', () => {
  it('registers all four WORM §16 schema ids', () => {
    for (const id of EVIDENCE_IDS) expect(SCHEMA_IDS).toContain(id);
  });

  it('each schema is an object with the expected $id', () => {
    for (const id of EVIDENCE_IDS) {
      expect((SCHEMAS[id] as { $id?: string }).$id).toBe(`https://edam.spec/${id}.schema.json`);
    }
  });
});

describe('evidence schemas — positive fixtures validate', () => {
  it('evidence-segment-manifest (genesis, sequence 0, previous_segment null)', () => {
    expect(validateEvidenceSegmentManifest(load('valid/segment-manifest-genesis.json'))).toEqual({ valid: true, errors: [] });
  });

  it('evidence-segment-manifest (linked, sequence 1, previous_segment object)', () => {
    expect(validateEvidenceSegmentManifest(load('valid/segment-manifest-linked.json'))).toEqual({ valid: true, errors: [] });
  });

  it('anchor-record (rfc3161)', () => {
    expect(validateAnchorRecord(load('valid/anchor-record-rfc3161.json'))).toEqual({ valid: true, errors: [] });
  });

  it('verification-report', () => {
    expect(validateVerificationReport(load('valid/verification-report.json'))).toEqual({ valid: true, errors: [] });
  });

  it('evidence-export-package', () => {
    expect(validateEvidenceExportPackage(load('valid/export-package.json'))).toEqual({ valid: true, errors: [] });
  });
});

describe('evidence schemas — negative fixtures are rejected', () => {
  it('segment-manifest missing manifest_hash => invalid', () => {
    const r = validateEvidenceSegmentManifest(load('invalid/segment-manifest-missing-hash.json'));
    expect(r.valid).toBe(false);
  });

  it('rfc3161 anchor missing token/cert (allOf) => invalid', () => {
    const r = validateAnchorRecord(load('invalid/anchor-record-rfc3161-missing-token.json'));
    expect(r.valid).toBe(false);
  });

  it('genesis manifest with a non-null previous_segment => invalid (allOf)', () => {
    const bad = load('valid/segment-manifest-genesis.json') as Record<string, unknown>;
    bad.previous_segment = { segment_id: 's', segment_sequence: 0, segment_hash: 'sha256:' + '0'.repeat(64) };
    expect(validateEvidenceSegmentManifest(bad).valid).toBe(false);
  });
});

describe('evidence schemas — addressable via generic validate()', () => {
  it('validate() routes by schema id', () => {
    expect(validate('evidence-segment-manifest-1.0', load('valid/segment-manifest-genesis.json')).valid).toBe(true);
  });
});
