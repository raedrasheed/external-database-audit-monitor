// @edam/evidence core pure-logic tests (EDAM-T110): manifest-hash determinism,
// segment_hash + cross-segment continuity, and row-chain fail-paths. The full
// positive manifest/chain/cross-segment behavior is exercised by the
// evidence-writer tests, which now import these functions from @edam/evidence.
import { describe, it, expect } from 'vitest';
import {
  computeManifestHash,
  computeSegmentHash,
  segmentHashOf,
  deriveSegmentHead,
  verifyCrossSegment,
  verifySegmentChain,
  GENESIS_PREVIOUS_SEGMENT_HASH,
  type SegmentManifest,
  type SegmentManifestCore,
  type SegmentChainInput,
} from '../src/index.js';
import type { Cce } from '@edam/cce-model';

const H = (c: string) => 'sha256:' + c.repeat(64);

function manifest(overrides: Partial<SegmentManifest> = {}): SegmentManifest {
  return {
    manifest_version: 'evidence-segment-manifest-1.0',
    segment_id: 'seg-000000',
    db_id: 'kafel-dev-mysql',
    engine: 'mysql',
    segment_sequence: 0,
    opened_at: '2026-06-01T10:00:00.000Z',
    sealed_at: '2026-06-01T10:00:01.000Z',
    event_count: 1,
    first_envelope_id: 'e0',
    last_envelope_id: 'e0',
    first_row_hash: H('2'),
    last_row_hash: H('2'),
    object_list: [{ seq: 0, object_id: 'e0', worm_object_key: 'k', object_type: 'cce' }],
    object_hash_list: [{ seq: 0, event_hash: H('1'), row_hash: H('2') }],
    source_offset_range: { first_offset_key: 'o0', last_offset_key: 'o0' },
    fidelity_summary: { all_healthy: true, degraded_count: 0, compromised_count: 0, reasons: [] },
    completeness_summary: { gap_detected: false, expected_continuous: true, notes: [] },
    previous_segment: null,
    manifest_hash: H('9'),
    ...overrides,
  };
}

describe('@edam/evidence manifest hash (T110)', () => {
  it('computeManifestHash is deterministic, order-independent, and content-sensitive', () => {
    const a: SegmentManifestCore = { x: 1, y: 2 } as unknown as SegmentManifestCore;
    const b: SegmentManifestCore = { y: 2, x: 1 } as unknown as SegmentManifestCore;
    expect(computeManifestHash(a)).toBe(computeManifestHash(b)); // canonical sorts keys
    const c: SegmentManifestCore = { x: 1, y: 3 } as unknown as SegmentManifestCore;
    expect(computeManifestHash(a)).not.toBe(computeManifestHash(c));
    expect(computeManifestHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('@edam/evidence segment_hash + cross-segment (T110)', () => {
  it('computeSegmentHash is deterministic and validates its tokens', () => {
    const s1 = computeSegmentHash(H('a'), H('b'), GENESIS_PREVIOUS_SEGMENT_HASH);
    const s2 = computeSegmentHash(H('a'), H('b'), GENESIS_PREVIOUS_SEGMENT_HASH);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => computeSegmentHash('not-a-token', H('b'), GENESIS_PREVIOUS_SEGMENT_HASH)).toThrow();
  });

  it('segmentHashOf a genesis manifest uses the all-zero predecessor', () => {
    const m = manifest();
    expect(segmentHashOf(m)).toBe(computeSegmentHash(m.manifest_hash, m.last_row_hash, GENESIS_PREVIOUS_SEGMENT_HASH));
    expect(deriveSegmentHead(m).segment_hash).toBe(segmentHashOf(m));
  });

  it('verifyCrossSegment: genesis passes; non-genesis missing previous fails closed', () => {
    expect(verifyCrossSegment(manifest(), H('0'), null).ok).toBe(true);
    const seq1 = manifest({ segment_sequence: 1, previous_segment: { segment_id: 'seg-000000', segment_sequence: 0, segment_hash: H('7') } });
    const r = verifyCrossSegment(seq1, H('2'), null);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.rule === 'MISSING_PREVIOUS')).toBe(true);
  });
});

describe('@edam/evidence row-chain fail-paths (T110)', () => {
  it('empty segment fails closed with EMPTY', () => {
    const input: SegmentChainInput = { object_list: [], object_hash_list: [], objects: [] };
    const v = verifySegmentChain(input);
    expect(v.ok).toBe(false);
    expect(v.failures[0]?.rule).toBe('EMPTY');
  });

  it('misaligned object_list yields an ORDER failure', () => {
    const obj = { envelope_id: 'e0', evidence: { event_hash: H('1'), row_hash: H('2'), prev_row_hash: null } } as unknown as Cce;
    const input: SegmentChainInput = {
      object_list: [{ seq: 5, object_id: 'WRONG', worm_object_key: 'k', object_type: 'cce' }],
      object_hash_list: [{ seq: 0, event_hash: H('1'), row_hash: H('2') }],
      objects: [obj],
    };
    const v = verifySegmentChain(input);
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.rule === 'ORDER')).toBe(true);
  });
});
