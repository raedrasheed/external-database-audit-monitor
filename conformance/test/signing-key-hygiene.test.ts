// Signing-key-hygiene gate (Epic E2C-S2 / EDAM-T124): proof no signing private
// key leaks — static scan + adversarial runtime extraction + positive controls.
import { describe, it, expect } from 'vitest';
import {
  scanText,
  scanSigningKeyHygiene,
  verifyNoPrivateExport,
  verifySigningKeyHygiene,
  surfacesOf,
} from '../security/signing-key-hygiene.js';
import { DevEd25519Signer } from '@edam/signing';
import { generateKeyPairSync } from 'node:crypto';

describe('signing-key-hygiene (T124)', () => {
  it('repo/env/compose embed no private key material, export no private key, log no private key', () => {
    const v = scanSigningKeyHygiene();
    expect(v, JSON.stringify(v, null, 2)).toEqual([]);
  });

  it('no signer/registry leaks private material via serialization/reflection/spread/inspection/errors', async () => {
    const proof = await verifyNoPrivateExport();
    expect(proof.violations, JSON.stringify(proof.violations, null, 2)).toEqual([]);
    expect(proof.probed).toBeGreaterThanOrEqual(15);
  });

  it('overall proof is ok and both positive controls fire (fail-closed detector works)', async () => {
    const proof = await verifySigningKeyHygiene();
    expect(proof.ok).toBe(true);
    expect(proof.positive_control.static_detected).toBe(true);
    expect(proof.positive_control.runtime_detected).toBe(true);
  });

  // ---- positive controls (the detector MUST catch a real leak) ----

  it('static scanner flags an embedded PEM private key block (positive control)', () => {
    const text = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2Vw\n-----END PRIVATE KEY-----';
    expect(scanText(text, 'x.ts').some((v) => v.rule === 'EMBEDDED_PRIVATE_KEY')).toBe(true);
  });

  it('static scanner flags exporting a private key from runtime code (positive control)', () => {
    expect(scanText("const pem = key.export({ format: 'pem', type: 'pkcs8' });", 'x.ts').some((v) => v.rule === 'PRIVATE_KEY_EXPORT')).toBe(true);
  });

  it('static scanner flags logging a private key (positive control)', () => {
    expect(scanText('console.log("privateKey=" + privateKey);', 'x.ts').some((v) => v.rule === 'LOG_PRIVATE_KEY')).toBe(true);
  });

  it('static scanner does NOT flag the public SPKI export or prose mentions (no false positive)', () => {
    expect(scanText("return pub.export({ format: 'der', type: 'spki' }).toString('base64');", 'dev-signer.ts')).toEqual([]);
    expect(scanText('// the private key is never surfaced; only the public key is published', 'dev-signer.ts')).toEqual([]);
    expect(scanText('readonly #privateKey: KeyObject;', 'dev-signer.ts')).toEqual([]);
  });

  it('surfacesOf does not reach an ES #private field (the custody guarantee)', () => {
    const kp = generateKeyPairSync('ed25519');
    const privBodyB64 = (kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string).replace(/-----[^\n]+-----/g, '').replace(/\s+/g, '');
    const signer = new DevEd25519Signer({ privateKeyPem: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
    const surfaces = surfacesOf(signer);
    expect(surfaces.join('\n')).not.toContain(privBodyB64);
    expect(surfaces.join('\n')).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(signer)).toBe('{}');
  });
});
