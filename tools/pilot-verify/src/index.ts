// EDAM pilot offline-verification CLI (B6+B7). Operator commands:
//   keys   -> generate fixed dev key PEMs (gitignored) + publish the trust file
//   export -> read live WORM evidence -> export-package.json + objects/ + trust.json
//   verify -> run the verifier-CLI over an exported package -> PASS/FAIL (exit code)
//
//   npx tsx tools/pilot-verify/src/index.ts keys   [keysDir]
//   npx tsx tools/pilot-verify/src/index.ts export <outDir>
//   npx tsx tools/pilot-verify/src/index.ts verify <outDir>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createMinioWormStore } from '@edam/worm';
import { runExportVerification, loadTrustRoots, exitCodeFor, renderHuman } from '@edam/verifier-cli';
import { loadPilotKeys, buildPilotTrust, exportFromWorm, generatePilotPems } from './pilot-verify.js';

const env = process.env;
const DB = env.CDC_DB_ID ?? 'kafel-dev-mysql';
const KEYS_DIR = env.PILOT_KEYS_DIR ?? 'deploy/pilot/keys';
const pemPath = (n: string) => join(KEYS_DIR, `${n}.pem`);

function readKeys() {
  const read = (n: string) => (existsSync(pemPath(n)) ? readFileSync(pemPath(n), 'utf8') : undefined);
  return loadPilotKeys({ signingPem: read('signing'), tsaPem: read('tsa'), exportPem: read('export') });
}

function readerStore() {
  // Read-only export uses the root credential (single-credential dev fallback is fine for reads).
  return createMinioWormStore({
    endPoint: env.WORM_MINIO_ENDPOINT ?? '127.0.0.1',
    port: env.WORM_MINIO_PORT ? Number(env.WORM_MINIO_PORT) : 9000,
    useSSL: env.WORM_MINIO_SSL === 'true',
    bucket: env.MINIO_BUCKET ?? 'edam-evidence',
    accessKey: env.MINIO_ROOT_USER ?? 'minioadmin',
    secretKey: env.MINIO_ROOT_PASSWORD ?? 'minioadmin',
  });
}

async function cmdKeys(): Promise<void> {
  if (['signing', 'tsa', 'export'].every((n) => existsSync(pemPath(n)))) {
    process.stdout.write(`[pilot] keys already exist in ${KEYS_DIR} (not overwriting)\n`);
  } else {
    const pems = generatePilotPems();
    mkdirSync(KEYS_DIR, { recursive: true });
    writeFileSync(pemPath('signing'), pems.signingPem);
    writeFileSync(pemPath('tsa'), pems.tsaPem);
    writeFileSync(pemPath('export'), pems.exportPem);
    process.stdout.write(`[pilot] wrote dev key PEMs to ${KEYS_DIR} (gitignored, DEV-ONLY / R-01)\n`);
  }
  const trust = buildPilotTrust(readKeys());
  writeFileSync(join(KEYS_DIR, 'trust.json'), JSON.stringify(trust, null, 2) + '\n');
  process.stdout.write(`[pilot] published trust file ${join(KEYS_DIR, 'trust.json')} (signing_key_id=${trust.signing_keys![0]!.key_id})\n`);
}

async function cmdExport(outDir: string): Promise<void> {
  const keys = readKeys();
  const { pkg, objects } = await exportFromWorm(readerStore().reader(), DB, keys.exportKey, keys);
  mkdirSync(join(outDir, 'objects'), { recursive: true });
  writeFileSync(join(outDir, 'export-package.json'), JSON.stringify(pkg, null, 2) + '\n');
  for (const o of objects) { const p = join(outDir, 'objects', o.key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(o.bytes)); }
  writeFileSync(join(outDir, 'trust.json'), JSON.stringify(buildPilotTrust(keys), null, 2) + '\n');
  process.stdout.write(`[pilot] exported ${objects.length} objects + package + trust to ${outDir}\n`);
}

function cmdVerify(outDir: string): number {
  const pkg: unknown = JSON.parse(readFileSync(join(outDir, 'export-package.json'), 'utf8'));
  const trust = loadTrustRoots(JSON.parse(readFileSync(join(outDir, 'trust.json'), 'utf8')));
  const res = runExportVerification(pkg, { objectsDir: join(outDir, 'objects'), trust, reportId: '99999999-2222-4333-8444-555555555555', generatedAt: new Date().toISOString() });
  process.stdout.write(renderHuman(res) + '\n');
  return exitCodeFor(res);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'keys': await cmdKeys(); break;
    case 'export': if (!arg) throw new Error('usage: export <outDir>'); await cmdExport(arg); break;
    case 'verify': if (!arg) throw new Error('usage: verify <outDir>'); process.exitCode = cmdVerify(arg); break;
    default: process.stderr.write('usage: pilot-verify <keys|export <dir>|verify <dir>>\n'); process.exitCode = 2;
  }
}

main().catch((err) => { process.stderr.write(`[pilot] error: ${(err as Error).message}\n`); process.exitCode = 1; });
