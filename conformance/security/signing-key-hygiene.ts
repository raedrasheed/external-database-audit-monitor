// Signing-key-hygiene verification (Epic E2C-S2 / EDAM-T124).
//
// Proves — by static scan + an adversarial runtime extraction — that no signing
// PRIVATE key material can cross the public API boundary of the signing layer
// (INV-EV-4: keys are non-exportable; the Signer interface exposes no private
// material; only PUBLIC keys are published). Extends the secret-hygiene model.
//
// Two halves:
//   1) Static scan of runtime source + env/compose for embedded private keys,
//      private-key exports in runtime code, and logging of private keys.
//   2) Runtime custody proof: build every signer/registry holding (or handling)
//      a KNOWN private key and attempt to extract it via serialization, object
//      spreading, reflection, inspection, method outputs, and error messages.
//
// A positive control (a deliberately-leaky object + an embedded-PEM string) must
// be detected, so a green result is meaningful. Fails closed on any leakage OR
// if a positive control is missed.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { generateKeyPairSync, createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import {
  DevEd25519Signer,
  Pkcs11Signer,
  InMemoryKeyRegistry,
  KeyRotationRegistry,
  createSigner,
  buildAnchorPayload,
  type AnchorPayload,
  type Pkcs11Provider,
  type KeyRecord,
} from '@edam/signing';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

// A PEM PRIVATE-key block header (PKCS#8 / PKCS#1 / SEC1 / encrypted). PUBLIC keys
// use "PUBLIC KEY" and are intentionally not matched.
const PEM_PRIVATE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const LOG_CALL = /(console\.\w+|process\.(?:stdout|stderr)\.write)\b/;
const PRIVATE_KEY_TOKEN = /private[_\s]?key|privatekey/i;
// Exporting a private key from runtime code (PKCS#8/#1/SEC1 or an explicit
// private type). The public SPKI export (`type: 'spki'`) is intentionally allowed.
const PRIVATE_EXPORT = /\.export\s*\([^)]*(?:\bpkcs8\b|\bpkcs1\b|\bsec1\b|type\s*:\s*['"]private)/i;

/** Scan one file's text for embedded/exported/logged private-key material. Exported for positive-control tests. */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  if (PEM_PRIVATE.test(text)) {
    const idx = text.split('\n').findIndex((l) => PEM_PRIVATE.test(l));
    out.push({ rule: 'EMBEDDED_PRIVATE_KEY', file, detail: `embedded PEM private key block (line ${idx + 1})` });
  }
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, ''); // drop line comments (prose mentions are fine)
    if (PRIVATE_EXPORT.test(line)) {
      out.push({ rule: 'PRIVATE_KEY_EXPORT', file, detail: `line ${i + 1}: exports private key material: ${line.trim().slice(0, 80)}` });
    }
    if (LOG_CALL.test(line) && PRIVATE_KEY_TOKEN.test(line)) {
      out.push({ rule: 'LOG_PRIVATE_KEY', file, detail: `line ${i + 1}: logs private key material: ${line.trim().slice(0, 80)}` });
    }
  });
  return out;
}

function walkSource(dir: string, acc: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue;
      walkSource(p, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
}

/** Runtime TypeScript source (packages/services/infra), excluding tests. */
export function runtimeSourceFiles(): string[] {
  const acc: string[] = [];
  for (const base of ['packages', 'services', 'infra']) {
    const root = join(ROOT, base);
    if (!existsSync(root)) continue;
    for (const pkg of readdirSync(root)) walkSource(join(root, pkg, 'src'), acc);
  }
  return acc;
}

function walkDeploy(dir: string, acc: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      walkDeploy(p, acc);
    } else {
      acc.push(p);
    }
  }
}

/** Env / compose / deploy config files (where embedded keys would hide). */
export function envComposeFiles(): string[] {
  const acc: string[] = [];
  walkDeploy(join(ROOT, 'deploy'), acc);
  for (const f of ['.env', '.env.local', '.env.example']) {
    const p = join(ROOT, f);
    if (existsSync(p)) acc.push(p);
  }
  return acc;
}

/** Static scan: no private key material embedded/exported/logged in repo/env/compose. */
export function scanSigningKeyHygiene(): Violation[] {
  const out: Violation[] = [];
  for (const file of runtimeSourceFiles()) {
    out.push(...scanText(readFileSync(file, 'utf8'), relative(ROOT, file)));
  }
  for (const file of envComposeFiles()) {
    const text = readFileSync(file, 'utf8');
    if (PEM_PRIVATE.test(text)) {
      out.push({ rule: 'EMBEDDED_PRIVATE_KEY', file: relative(ROOT, file), detail: 'embedded PEM private key block in env/compose' });
    }
  }
  return out;
}

// ---- Runtime custody proof ------------------------------------------------

/** Every observable string surface of an object an adversary could read. */
export function surfacesOf(obj: unknown): string[] {
  const s: (string | undefined)[] = [];
  const guard = (fn: () => string): void => {
    try { s.push(fn()); } catch { /* unreadable surface is not a leak */ }
  };
  guard(() => JSON.stringify(obj) ?? '');
  guard(() => JSON.stringify({ ...(obj as object) }));
  guard(() => inspect(obj, { showHidden: true, depth: 8, getters: true, customInspect: true }));
  guard(() => Object.getOwnPropertyNames(obj as object).join(','));
  guard(() => Reflect.ownKeys(obj as object).map(String).join(','));
  guard(() => String(obj));
  guard(() => Object.values(obj as Record<string, unknown>).map((v) => {
    try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
  }).join(','));
  return s.filter((x): x is string => typeof x === 'string');
}

/** Flag any surface that exposes a known private needle or a PEM private block. */
function detectLeakageInStrings(label: string, surfaces: readonly string[], needles: readonly string[]): Violation[] {
  const out: Violation[] = [];
  for (const surface of surfaces) {
    if (PEM_PRIVATE.test(surface)) {
      out.push({ rule: 'PRIVATE_KEY_LEAK', file: label, detail: 'PEM private key block observable via a public surface' });
      return out;
    }
    for (const needle of needles) {
      if (needle.length >= 16 && surface.includes(needle)) {
        out.push({ rule: 'PRIVATE_KEY_LEAK', file: label, detail: `private key material observable via a public surface (needle ${needle.length}B)` });
        return out;
      }
    }
  }
  return out;
}

function detectLeakage(label: string, obj: unknown, needles: readonly string[]): Violation[] {
  return detectLeakageInStrings(label, surfacesOf(obj), needles);
}

function spkiB64(pub: KeyObject): string {
  return pub.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** A probe HSM provider holding a private key in a #field (never surfaced). */
function makeProbeProvider(privateKey: KeyObject, keyId: string): Pkcs11Provider {
  class ProbeProvider implements Pkcs11Provider {
    readonly algorithm = 'ed25519' as const;
    readonly #key: KeyObject = privateKey;
    hasKey(id: string): boolean { return id === keyId; }
    async sign(id: string, message: Uint8Array): Promise<Uint8Array> {
      if (id !== keyId) throw new Error('probe provider: unknown key');
      return edSign(null, Buffer.from(message), this.#key);
    }
  }
  return new ProbeProvider();
}

const PROBE_PAYLOAD: AnchorPayload = ((): AnchorPayload =>
  buildAnchorPayload(
    { db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0, segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64) },
    { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' },
  ))();

async function collectErrorStrings(dev: DevEd25519Signer, hsm: Pkcs11Signer, rot: KeyRotationRegistry, privPem: string): Promise<string[]> {
  const out: string[] = [];
  const cap = async (fn: () => unknown | Promise<unknown>): Promise<void> => {
    try { await fn(); } catch (e) {
      const err = e as Error;
      out.push(err.message ?? '', err.stack ?? '', inspect(err, { depth: 6 }));
    }
  };
  await cap(() => dev.sign({ ...PROBE_PAYLOAD, segment_hash: 'not-a-hash' }));
  await cap(() => dev.sign({ ...PROBE_PAYLOAD, leaked: privPem } as unknown as AnchorPayload));
  await cap(() => hsm.sign({ ...PROBE_PAYLOAD, db_id: '' }));
  await cap(() => new Pkcs11Signer({ signingKeyId: 'x', registry: new InMemoryKeyRegistry() }).sign(PROBE_PAYLOAD));
  await cap(() => new DevEd25519Signer({ privateKeyPem: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }));
  await cap(() => rot.revoke('unknown', { requestedBy: 'a', approvedBy: 'b' }, '2026-02-01T00:00:00Z'));
  await cap(() => rot.assertSignableActiveKey('garbage'));
  return out;
}

export interface PrivateExportProof {
  violations: Violation[];
  probed: number;
  runtime_control_detected: boolean;
}

/** Build every signer/registry holding a KNOWN private key and prove it never leaks. */
export async function verifyNoPrivateExport(): Promise<PrivateExportProof> {
  const out: Violation[] = [];
  const kp = generateKeyPairSync('ed25519');
  const privPem = (kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string).trim();
  const privDerB64 = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const privBodyB64 = privPem.replace(/-----[^\n]+-----/g, '').replace(/\s+/g, '');
  const needles = [privPem, privDerB64, privBodyB64];

  const keyId = 'edam-hsm-ed25519-probe';
  const pub = spkiB64(createPublicKey(kp.privateKey));
  const provider = makeProbeProvider(kp.privateKey, keyId);
  const reg = new InMemoryKeyRegistry([{ algorithm: 'ed25519', signing_key_id: keyId, public_key: pub, revoked_at: null }]);
  const devKeyRec: KeyRecord = { algorithm: 'ed25519', signing_key_id: 'k-active', public_key: pub, created_at: '2026-01-01T00:00:00Z', revoked_at: null };

  const dev = new DevEd25519Signer({ privateKeyPem: privPem, createdAt: '2026-01-01T00:00:00.000Z' });
  const hsm = new Pkcs11Signer({ provider, signingKeyId: keyId, registry: reg });
  const rot = new KeyRotationRegistry([devKeyRec], 'k-active');
  const devViaFactory = createSigner({ kind: 'dev', options: { privateKeyPem: privPem } });
  const hsmViaFactory = createSigner({ kind: 'pkcs11', config: { provider, signingKeyId: keyId, registry: reg } });

  const probes: { label: string; obj: unknown }[] = [
    { label: 'DevEd25519Signer', obj: dev },
    { label: 'DevEd25519Signer.keyRegistration()', obj: dev.keyRegistration() },
    { label: 'DevEd25519Signer.getPublicKey()', obj: dev.getPublicKey(dev.keyId) },
    { label: 'DevEd25519Signer.sign()', obj: await dev.sign(PROBE_PAYLOAD) },
    { label: 'Pkcs11Signer', obj: hsm },
    { label: 'Pkcs11Signer.getPublicKey()', obj: hsm.getPublicKey(keyId) },
    { label: 'Pkcs11Signer.sign()', obj: await hsm.sign(PROBE_PAYLOAD) },
    { label: 'Pkcs11Provider(probe)', obj: provider },
    { label: 'InMemoryKeyRegistry.getPublicKey()', obj: reg.getPublicKey(keyId) },
    { label: 'KeyRotationRegistry', obj: rot },
    { label: 'KeyRotationRegistry.getPublicKey()', obj: rot.getPublicKey('k-active') },
    { label: 'KeyRotationRegistry.history()', obj: rot.history() },
    { label: 'createSigner(dev)', obj: devViaFactory },
    { label: 'createSigner(dev).sign()', obj: await devViaFactory.sign(PROBE_PAYLOAD) },
    { label: 'createSigner(pkcs11)', obj: hsmViaFactory },
    { label: 'createSigner(pkcs11).sign()', obj: await hsmViaFactory.sign(PROBE_PAYLOAD) },
  ];
  for (const p of probes) out.push(...detectLeakage(p.label, p.obj, needles));

  const errStrings = await collectErrorStrings(dev, hsm, rot, privPem);
  out.push(...detectLeakageInStrings('error-messages', errStrings, needles));

  // Positive control: a deliberately-leaky object MUST be detected.
  const leaky = { harmless: 1, exported_private_key: privPem };
  const runtimeControlDetected = detectLeakage('positive-control', leaky, needles).length > 0;

  return { violations: out, probed: probes.length, runtime_control_detected: runtimeControlDetected };
}

export interface SigningKeyHygieneProof {
  proof: 'signing-key-hygiene';
  generated_at: string;
  ok: boolean;
  scanned: { runtime_source: number; env_compose: number; signers_probed: number };
  positive_control: { static_detected: boolean; runtime_detected: boolean };
  violations: Violation[];
}

// A synthetic embedded-private-key string the static scanner MUST flag.
const STATIC_CONTROL = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI...\n-----END PRIVATE KEY-----';

export async function verifySigningKeyHygiene(): Promise<SigningKeyHygieneProof> {
  const staticViolations = scanSigningKeyHygiene();
  const runtime = await verifyNoPrivateExport();
  const staticDetected = scanText(STATIC_CONTROL, '<positive-control>').some((v) => v.rule === 'EMBEDDED_PRIVATE_KEY');
  const violations = [...staticViolations, ...runtime.violations];
  // Fail closed: any leakage OR a missed positive control => not ok.
  const ok = violations.length === 0 && staticDetected && runtime.runtime_control_detected;
  return {
    proof: 'signing-key-hygiene',
    generated_at: new Date().toISOString(),
    ok,
    scanned: { runtime_source: runtimeSourceFiles().length, env_compose: envComposeFiles().length, signers_probed: runtime.probed },
    positive_control: { static_detected: staticDetected, runtime_detected: runtime.runtime_control_detected },
    violations,
  };
}

export async function writeProofFile(): Promise<void> {
  writeFileSync('signing-key-hygiene-proof.json', JSON.stringify(await verifySigningKeyHygiene(), null, 2) + '\n', 'utf8');
}
