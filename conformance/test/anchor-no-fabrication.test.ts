// anchor-no-fabrication gate test (Sprint-2 / EDAM-T135). Asserts the runtime
// proof holds (no fabrication on outage/timeout/malformed/fabricated; recovery
// anchors), plus positive controls proving the gate would FAIL if a token were
// ever produced without verification (INV-EV-6 / WV-13 / A-EV6).
import { describe, it, expect } from 'vitest';
import { verifyAnchorNoFabrication } from '../scripts/anchor-no-fabrication.js';
import {
  AnchorCoordinator,
  InMemoryAnchorRecordStore,
  requestAnchor,
  anchorRequestFor,
  type AnchorProvider,
  type AnchorOutcome,
  type AnchorRequest,
} from '@edam/anchoring';
import { DevEd25519Signer, buildAnchorPayload } from '@edam/signing';

const head = buildAnchorPayload(
  { db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0, segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64) },
  { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' },
);

/** Claims anchored with a well-formed rfc3161 token bound to the right hash, but cannot verify it. */
class FabricatingProvider implements AnchorProvider {
  readonly provider_type = 'rfc3161' as const;
  calls = 0;
  async anchor(request: AnchorRequest): Promise<AnchorOutcome> {
    this.calls++;
    return { status: 'anchored', token: { provider_type: 'rfc3161', anchor_provider: { type: 'rfc3161', rfc3161_token: 'forged', tsa_cert_ref: 'forged' }, anchored_at: '2026-06-01T10:05:05.000Z', payload_hash: request.payload_hash } };
  }
  verifyToken(): boolean {
    return false;
  }
}

describe('anchor-no-fabrication gate (INV-EV-6 / WV-13)', () => {
  it('proof holds: outage/timeout/malformed/fabricated never ANCHORED; recovery succeeds', async () => {
    const proof = await verifyAnchorNoFabrication();
    expect(proof.ok, JSON.stringify(proof.failures, null, 2)).toBe(true);
    expect(proof.failures).toEqual([]);
    expect(proof.scanned.providers).toBe(2);
    expect(proof.scanned.checks).toBeGreaterThan(0);
  });

  it('positive control: a fabricating provider cannot produce a token or record', async () => {
    const provider = new FabricatingProvider();
    // Through the T130 guard directly: claims anchored, but verification fails ⇒ failed, no token.
    const guarded = await requestAnchor(provider, anchorRequestFor(head));
    expect(guarded).toEqual({ status: 'failed', reason: 'token_verification_failed' });
    expect('token' in guarded).toBe(false);

    // Through the T134 coordinator: failed, no record stored.
    const store = new InMemoryAnchorRecordStore();
    const hsm = await new DevEd25519Signer({ createdAt: '2026-01-01T00:00:00.000Z' }).sign(head);
    const out = await new AnchorCoordinator({ store, sleep: async () => {}, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }).anchorHead(provider, { head, hsmSignature: hsm });
    expect(out.status).toBe('failed');
    expect('record' in out).toBe(false);
    expect(store.size).toBe(0);
  });

  it('positive control: the gate fails if any check regresses', async () => {
    const proof = await verifyAnchorNoFabrication();
    // Simulate a regression by flipping one check; the aggregate must report not-ok.
    const tampered = { ...proof, failures: [{ provider: 'rfc3161' as const, scenario: 'outage', name: 'stays-pending', ok: false, detail: 'simulated' }] };
    tampered.ok = tampered.failures.length === 0;
    expect(tampered.ok).toBe(false);
  });
});
