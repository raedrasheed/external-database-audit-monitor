// EDAM-P2-TRUST-GENERATOR — generate the out-of-band verifier trust file from a
// committed registry snapshot (PUBLIC key history of the evidence + export
// KeyRotationRegistry instances). Pure/offline; no HSM, no MinIO. The drift guard
// (conformance/test/trust-file-drift.test.ts) recomputes this and fails on drift.
//
//   npx tsx conformance/scripts/trust-file.ts            # print {trust, hash}
//   npx tsx conformance/scripts/trust-file.ts --write    # (re)write docs/trust/trust.json + trust-hash.txt
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KeyRotationRegistry, buildTrustFile, type KeyRecord, type TrustFileAnchorCert } from '@edam/signing';
import { serializeCanonical } from '@edam/canonical';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TRUST_DIR = join(ROOT, 'docs/trust');
const SNAPSHOT = join(TRUST_DIR, 'registry-snapshot.json');
const TRUST_FILE = join(TRUST_DIR, 'trust.json');
const HASH_FILE = join(TRUST_DIR, 'trust-hash.txt');

interface Snapshot {
  meta: { trust_version: number; generated_at: string; ceremony_id?: string };
  evidence: { active_key_id: string; records: KeyRecord[] };
  export: { active_key_id: string; records: KeyRecord[] };
  anchor_certs?: TrustFileAnchorCert[];
}

export function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
}

/** Build the trust file + hash from the committed snapshot (the single source of truth). */
export function generateFromSnapshot(snap: Snapshot = loadSnapshot()): { trust: unknown; hash: string } {
  const evidence = new KeyRotationRegistry(snap.evidence.records, snap.evidence.active_key_id);
  const exportReg = new KeyRotationRegistry(snap.export.records, snap.export.active_key_id);
  return buildTrustFile({ evidence, export: exportReg, anchorCerts: snap.anchor_certs ?? [], meta: snap.meta });
}

/** The committed, published trust file + hash (what the drift guard compares against). */
export function committed(): { trust: unknown; hash: string } {
  return { trust: JSON.parse(readFileSync(TRUST_FILE, 'utf8')), hash: readFileSync(HASH_FILE, 'utf8').trim() };
}

function main(): void {
  const write = process.argv.includes('--write');
  const { trust, hash } = generateFromSnapshot();
  if (write) {
    writeFileSync(TRUST_FILE, serializeCanonical(trust) + '\n');
    writeFileSync(HASH_FILE, hash + '\n');
    process.stdout.write(`[trust-file] wrote docs/trust/trust.json + trust-hash.txt (${hash})\n`);
  } else {
    process.stdout.write(JSON.stringify({ trust, hash }, null, 2) + '\n');
  }
}

if (process.argv[1] && process.argv[1].endsWith('trust-file.ts')) main();
