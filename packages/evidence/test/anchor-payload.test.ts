// @edam/evidence anchor-payload assembly tests (EDAM-T110).
//
// Focused tests for the canonical anchor-payload assembly now hosted here, plus a
// HASH-DRIFT GOLDEN: the canonical serialization + anchorPayloadHash for a fixed
// chain head must equal the byte-for-byte value captured from the pre-move code.
// Any drift in the shared serializer would break every HSM signature + the chain.
import { describe, it, expect } from 'vitest';
import {
  buildAnchorPayload,
  serializeAnchorPayload,
  anchorPayloadHash,
  anchorSigningMessage,
  assertValidAnchorPayload,
  ANCHOR_PAYLOAD_DOMAIN,
  type ChainHead,
} from '../src/index.js';

const head: ChainHead = {
  db_id: 'kafel-dev-mysql',
  segment_id: 'seg-000000',
  segment_sequence: 0,
  segment_hash: 'sha256:' + 'a'.repeat(64),
  last_row_hash: 'sha256:' + 'b'.repeat(64),
};

// Golden values captured from the pre-move @edam/signing implementation.
const GOLDEN_SERIALIZE =
  '{"db_id":"kafel-dev-mysql","head_count":1,"last_row_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","segment_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","segment_id":"seg-000000","segment_sequence":0,"signed_at":"2026-06-01T10:05:01.000Z"}';
const GOLDEN_HASH = 'sha256:e2226478e6cba7006dc87dd7fcadbf5ad8413a51e1605ebb2f8cc712d0dde446';

describe('@edam/evidence anchor-payload (T110 — no hash drift)', () => {
  it('serializes + hashes a fixed head to the captured golden values (zero drift)', () => {
    const p = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
    expect(serializeAnchorPayload(p)).toBe(GOLDEN_SERIALIZE);
    expect(anchorPayloadHash(p)).toBe(GOLDEN_HASH);
  });

  it('domain-tags the signing message', () => {
    const p = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
    const msg = new TextDecoder().decode(anchorSigningMessage(p));
    expect(msg).toBe(`${ANCHOR_PAYLOAD_DOMAIN}:${GOLDEN_SERIALIZE}`);
  });

  it('rejects an unknown field and a non-RFC3339 instant', () => {
    expect(() => assertValidAnchorPayload({ ...buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' }), extra: 'x' } as never)).toThrow();
    expect(() => buildAnchorPayload(head, { headCount: 1, signedAt: 'nope' })).toThrow();
  });
});
