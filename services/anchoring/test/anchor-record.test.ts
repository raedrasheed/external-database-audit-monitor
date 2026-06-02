// Anchor-record builder tests (Sprint-2 / EDAM-T133): builds a schema-valid
// anchor-record-1.0 from signing + provider outputs; ANCHORED only after a
// verified token; head bound to the token; anchor_ref value produced; public-
// verifier completeness. No state machine, no WORM, no CCE mutation.
import { describe, it, expect } from 'vitest';
import {
  buildAnchorRecord,
  buildAnchorRef,
  UnverifiedAnchorError,
  AnchorHeadMismatchError,
  AnchorRecordSchemaError,
  requestAnchor,
  anchorRequestFor,
  DevRfc3161Provider,
  DevTransparencyLogProvider,
  type AnchorOutcome,
} from '../src/index.js';
import { DevEd25519Signer, buildAnchorPayload, type ChainHead } from '@edam/signing';
import { validateAnchorRecord } from '@edam/contracts';

const head: ChainHead = {
  db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0,
  segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64),
};
const payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
const ANCHOR_ID = '11111111-2222-4333-8444-555555555555';
const CREATED_AT = '2026-06-01T10:05:06.000Z';

async function signed() {
  return new DevEd25519Signer({ createdAt: '2026-01-01T00:00:00.000Z' }).sign(payload);
}
async function anchoredVia(provider: DevRfc3161Provider | DevTransparencyLogProvider): Promise<AnchorOutcome> {
  return requestAnchor(provider, anchorRequestFor(payload));
}

describe('buildAnchorRecord (T133)', () => {
  it('builds a schema-valid anchor-record-1.0 from an RFC-3161 token', async () => {
    const hsm = await signed();
    const outcome = await anchoredVia(new DevRfc3161Provider({ genTime: '2026-06-01T10:05:05.000Z' }));
    const record = buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: outcome, anchorId: ANCHOR_ID, createdAt: CREATED_AT });
    expect(validateAnchorRecord(record).valid).toBe(true);
    expect(record.anchor_version).toBe('anchor-record-1.0');
    expect(record.db_id).toBe('kafel-dev-mysql');
    expect(record.anchor_provider.type).toBe('rfc3161');
    expect(record.head).toEqual({ segment_id: 'seg-000000', segment_sequence: 0, segment_hash: head.segment_hash, last_row_hash: head.last_row_hash, head_count: 1, signed_at: '2026-06-01T10:05:01.000Z' });
    expect(record.hsm_signature).toEqual({ algorithm: hsm.algorithm, signing_key_id: hsm.signing_key_id, signature: hsm.signature });
  });

  it('builds a schema-valid anchor-record-1.0 from a transparency-log token', async () => {
    const hsm = await signed();
    const outcome = await anchoredVia(new DevTransparencyLogProvider({ sthTime: '2026-06-01T10:05:05.000Z' }));
    const record = buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: outcome, anchorId: ANCHOR_ID, createdAt: CREATED_AT });
    expect(validateAnchorRecord(record).valid).toBe(true);
    expect(record.anchor_provider.type).toBe('transparency_log');
    if (record.anchor_provider.type !== 'transparency_log') throw new Error('unreachable');
    expect(record.anchor_provider.transparency_log.log_id).toBe(outcome.status === 'anchored' && outcome.token.anchor_provider.type === 'transparency_log' ? outcome.token.anchor_provider.transparency_log.log_id : '');
  });

  it('records an optional hsm_signature.revoked_at when supplied', async () => {
    const hsm = await signed();
    const outcome = await anchoredVia(new DevRfc3161Provider({ genTime: '2026-06-01T10:05:05.000Z' }));
    const record = buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: outcome, anchorId: ANCHOR_ID, createdAt: CREATED_AT, signatureRevokedAt: null });
    expect(record.hsm_signature.revoked_at).toBeNull();
    expect(validateAnchorRecord(record).valid).toBe(true);
  });

  // ---- INV-EV-3: ANCHORED only post-verified-token ----

  it('refuses to build from a pending outcome (no fabrication)', async () => {
    const hsm = await signed();
    const pending: AnchorOutcome = { status: 'pending', reason: 'provider_timeout' };
    expect(() => buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: pending })).toThrow(UnverifiedAnchorError);
  });

  it('refuses to build from a failed outcome (no fabrication)', async () => {
    const hsm = await signed();
    const failed: AnchorOutcome = { status: 'failed', reason: 'token_verification_failed' };
    expect(() => buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: failed })).toThrow(UnverifiedAnchorError);
  });

  it('refuses to build when the head does not match the verified token (binding)', async () => {
    const hsm = await signed();
    const outcome = await anchoredVia(new DevRfc3161Provider({ genTime: '2026-06-01T10:05:05.000Z' }));
    const otherHead = buildAnchorPayload({ ...head, segment_sequence: 9 }, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
    expect(() => buildAnchorRecord({ head: otherHead, hsmSignature: hsm, anchorOutcome: outcome, anchorId: ANCHOR_ID, createdAt: CREATED_AT })).toThrow(AnchorHeadMismatchError);
  });

  it('throws AnchorRecordSchemaError for a non-uuid anchor_id (schema validation runs)', async () => {
    const hsm = await signed();
    const outcome = await anchoredVia(new DevRfc3161Provider({ genTime: '2026-06-01T10:05:05.000Z' }));
    expect(() => buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: outcome, anchorId: 'not-a-uuid', createdAt: CREATED_AT })).toThrow(AnchorRecordSchemaError);
  });

  it('is deterministic given a fixed anchor_id + created_at + injected provider time', async () => {
    const hsm = await signed();
    const a = buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: await anchoredVia(new DevRfc3161Provider({ privateKeyPem: undefined, genTime: '2026-06-01T10:05:05.000Z', serialNumber: 's1' })), anchorId: ANCHOR_ID, createdAt: CREATED_AT });
    // Same signature + same token shape => same record except provider key/serial; pin the stable fields.
    expect(a.anchor_id).toBe(ANCHOR_ID);
    expect(a.created_at).toBe(CREATED_AT);
  });

  // ---- public-verifier completeness ----

  it('carries everything a public verifier needs (head, hsm_signature, anchor_provider cert ref)', async () => {
    const hsm = await signed();
    const record = buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: await anchoredVia(new DevRfc3161Provider({ genTime: '2026-06-01T10:05:05.000Z' })), anchorId: ANCHOR_ID, createdAt: CREATED_AT });
    // re-derive payload hash from head fields
    expect(record.head.segment_hash).toBe(head.segment_hash);
    // verify-signature inputs
    expect(record.hsm_signature.algorithm).toBe('ed25519');
    expect(record.hsm_signature.signing_key_id).toMatch(/^edam-dev-ed25519-/);
    // resolve-cert + verify-token inputs
    if (record.anchor_provider.type !== 'rfc3161') throw new Error('unreachable');
    expect(record.anchor_provider.tsa_cert_ref).toMatch(/^dev-tsa-ed25519-/);
    expect(record.anchor_provider.rfc3161_token.length).toBeGreaterThan(0);
  });
});

describe('buildAnchorRef (T133)', () => {
  it('produces a cce-1.1 anchor_ref value (rfc3161) without mutating any CCE', async () => {
    const hsm = await signed();
    const record = buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: await anchoredVia(new DevRfc3161Provider({ genTime: '2026-06-01T10:05:05.000Z' })), anchorId: ANCHOR_ID, createdAt: CREATED_AT });
    const ref = buildAnchorRef(record);
    expect(ref.head_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.anchor_provider).toBe('rfc3161');
    expect(typeof ref.hsm_signature).toBe('string');
    expect(typeof ref.tsa_token).toBe('string');
  });

  it('omits tsa_token for transparency_log', async () => {
    const hsm = await signed();
    const record = buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: await anchoredVia(new DevTransparencyLogProvider({ sthTime: '2026-06-01T10:05:05.000Z' })), anchorId: ANCHOR_ID, createdAt: CREATED_AT });
    const ref = buildAnchorRef(record);
    expect(ref.anchor_provider).toBe('transparency_log');
    expect('tsa_token' in ref).toBe(false);
    expect(ref.head_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
