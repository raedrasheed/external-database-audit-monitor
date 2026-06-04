// P2-HSM-DRYRUN — SoftHSM2 Ed25519 PKCS#11 dry-run (GATED integration test).
//
// Proves the EXISTING HSM seam works UNCHANGED against a real PKCS#11 module:
//   generate (non-exportable Ed25519) -> sign an AnchorPayload via
//   createSigner({kind:'pkcs11'}) -> verify -> build a trust file from the registry
//   (P2-TRUST-GENERATOR) -> end-to-end verify through the published trust roots ->
//   prove the private key never leaves the HSM -> fail-closed paths.
//
// Ed25519 / CKM_EDDSA only (ADR-EDAM-001). SoftHSM2 only. No production keys.
//
// Opt-in (default `npm test` is HSM-free; this is skipped without the module path):
//   SOFTHSM2_CONF=/tmp/softhsm/softhsm2.conf PKCS11_MODULE_PATH=/usr/lib/softhsm/libsofthsm2.so \
//   PKCS11_TOKEN_LABEL=edam-dryrun PKCS11_PIN=1234 \
//   npx vitest run packages/signing/test/pkcs11-softhsm.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createSigner, Pkcs11Signer, Pkcs11NotConfiguredError, AlgorithmMismatchError,
  InMemoryKeyRegistry, KeyRotationRegistry, buildTrustFile, verifyAnchorSignature,
  type PublicKey, type AnchorPayload, type Pkcs11Provider,
} from '@edam/signing';
import { buildAnchorPayload } from '@edam/evidence';
import { loadTrustRoots } from '@edam/verifier-cli';
import { SoftHsmSession } from './helpers/softhsm-ed25519.js';

const MODULE = process.env.PKCS11_MODULE_PATH;
const run = MODULE ? describe : describe.skip;
const TOKEN = process.env.PKCS11_TOKEN_LABEL ?? 'edam-dryrun';
const PIN = process.env.PKCS11_PIN ?? '1234';
const REPORT = join(process.cwd(), 'docs/evidence/p2-hsm-dryrun/dryrun-result.json');

run('P2-HSM-DRYRUN — SoftHSM2 Ed25519 via the existing PKCS#11 seam', () => {
  let hsm: SoftHsmSession;
  let evKey: { signing_key_id: string; public_key: string; privHandle: Buffer };
  let xpKey: { signing_key_id: string; public_key: string };
  let provider: Pkcs11Provider;
  const evidence: Record<string, unknown> = { artifact: 'edam-p2-hsm-dryrun-result', generated_at: new Date().toISOString(), algorithm: 'ed25519', mechanism: 'CKM_EDDSA' };

  const head = { db_id: 'kafel-dev-mysql', segment_id: 'seg-hsm-000000', segment_sequence: 0, segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64) };
  let payload: AnchorPayload;

  beforeAll(() => {
    hsm = new SoftHsmSession({ modulePath: MODULE!, tokenLabel: TOKEN, pin: PIN });
    hsm.open();
    evKey = hsm.generateEd25519('edam-hsm-evidence');
    xpKey = hsm.generateEd25519('edam-hsm-export');
    provider = hsm.provider();
    payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-04T10:05:01.000Z' });
    evidence.softhsm = hsm.moduleInfo();
    evidence.key = { signing_key_id: evKey.signing_key_id, algorithm: 'ed25519', public_key_spki_b64: evKey.public_key };
  }, 60_000);

  afterAll(() => {
    try { mkdirSync(dirname(REPORT), { recursive: true }); writeFileSync(REPORT, JSON.stringify(evidence, null, 2) + '\n'); } catch { /* best-effort */ }
    hsm?.close();
  });

  it('signs an AnchorPayload through createSigner({kind:pkcs11}) — private key stays in the HSM', async () => {
    const registry = new InMemoryKeyRegistry([{ algorithm: 'ed25519', signing_key_id: evKey.signing_key_id, public_key: evKey.public_key, revoked_at: null }]);
    const signer = createSigner({ kind: 'pkcs11', config: { provider, signingKeyId: evKey.signing_key_id, registry } });
    const sig = await signer.sign(payload);
    expect(sig.algorithm).toBe('ed25519');
    expect(sig.signing_key_id).toBe(evKey.signing_key_id);
    expect(Buffer.from(sig.signature, 'base64').length).toBe(64); // raw Ed25519 signature
    expect(verifyAnchorSignature(payload, sig, registry.getPublicKey(evKey.signing_key_id))).toBe(true);
    evidence.sign_and_verify = { signature_bytes: 64, verifies: true };
  });

  it('END-TO-END: HSM signature verifies through a trust file built by P2-TRUST-GENERATOR', async () => {
    const registry = new InMemoryKeyRegistry([{ algorithm: 'ed25519', signing_key_id: evKey.signing_key_id, public_key: evKey.public_key, revoked_at: null }]);
    const sig = await createSigner({ kind: 'pkcs11', config: { provider, signingKeyId: evKey.signing_key_id, registry } }).sign(payload);

    const evReg = new KeyRotationRegistry([{ signing_key_id: evKey.signing_key_id, algorithm: 'ed25519', public_key: evKey.public_key, created_at: '2026-01-01T00:00:00.000Z', revoked_at: null }], evKey.signing_key_id);
    const xpReg = new KeyRotationRegistry([{ signing_key_id: xpKey.signing_key_id, algorithm: 'ed25519', public_key: xpKey.public_key, created_at: '2026-01-01T00:00:00.000Z', revoked_at: null }], xpKey.signing_key_id);
    const { trust } = buildTrustFile({ evidence: evReg, export: xpReg, meta: { trust_version: 1, generated_at: '2026-06-04T00:00:00.000Z', ceremony_id: 'CER-dryrun' } });

    const roots = loadTrustRoots(trust);
    const trusted = roots.signingKeys.get(evKey.signing_key_id);
    expect(trusted).toBeDefined();
    const publishedKey: PublicKey = { algorithm: 'ed25519', signing_key_id: evKey.signing_key_id, public_key: trusted!.public_key, revoked_at: trusted!.revoked_at ?? null };
    expect(verifyAnchorSignature(payload, sig, publishedKey)).toBe(true); // HSM -> SPKI -> trust generator -> verifier
    evidence.end_to_end = { trust_published_key_verifies_hsm_signature: true };
  });

  it('proves the private key is NON-EXPORTABLE and unreadable', () => {
    const proof = hsm.proveNonExportable(evKey.privHandle);
    expect(proof.extractable).toBe(false);
    expect(proof.sensitive).toBe(true);
    expect(proof.value_read_denied).toBe(true);
    evidence.non_exportability = proof;
  });

  it('fail-closed: no provider configured => Pkcs11NotConfiguredError', async () => {
    const registry = new InMemoryKeyRegistry([{ algorithm: 'ed25519', signing_key_id: evKey.signing_key_id, public_key: evKey.public_key, revoked_at: null }]);
    const unconfigured = new Pkcs11Signer({ signingKeyId: evKey.signing_key_id, registry });
    await expect(unconfigured.sign(payload)).rejects.toBeInstanceOf(Pkcs11NotConfiguredError);
  });

  it('fail-closed: provider/published algorithm mismatch => AlgorithmMismatchError', async () => {
    const registry = new InMemoryKeyRegistry([{ algorithm: 'ed25519', signing_key_id: evKey.signing_key_id, public_key: evKey.public_key, revoked_at: null }]);
    const wrongAlg: Pkcs11Provider = { ...provider, algorithm: 'ecdsa-p384' };
    const signer = createSigner({ kind: 'pkcs11', config: { provider: wrongAlg, signingKeyId: evKey.signing_key_id, registry } });
    await expect(signer.sign(payload)).rejects.toBeInstanceOf(AlgorithmMismatchError);
    evidence.fail_closed = { no_provider: 'Pkcs11NotConfiguredError', algorithm_mismatch: 'AlgorithmMismatchError' };
  });
});
