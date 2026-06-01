// Evidence-schema provenance gate (Sprint-2 / EDAM-T102).
//
// Proves the four Sprint-2 evidence schemas vendored into @edam/contracts match
// the frozen WORM Evidence Segment & Anchoring Specification v1 §16 ```json
// blocks (parse-equal provenance, same semantics as the existing schemas.test
// CCE/companion check). Reads the ON-DISK vendored files (the committed
// artifacts), extracts the doc blocks by $id, and fails CI (--check) on ANY
// drift. Emits a machine-verifiable proof (--report).
//
//   npm run evidence-schemas-verbatim -- --check --report

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC = join(ROOT, 'docs/EDAM-WORM-Evidence-Anchoring-Spec.md');
const SCHEMA_DIR = join(ROOT, 'packages/contracts/src/schemas');

/** The four evidence schemas this gate guards (id -> vendored file name). */
export const EVIDENCE_SCHEMAS: Record<string, string> = {
  'evidence-segment-manifest-1.0': 'evidence-segment-manifest-1.0.schema.json',
  'anchor-record-1.0': 'anchor-record-1.0.schema.json',
  'verification-report-1.0': 'verification-report-1.0.schema.json',
  'evidence-export-package-1.0': 'evidence-export-package-1.0.schema.json',
};

/** Extract every fenced ```json block from a markdown document. */
export function extractJsonBlocks(md: string): string[] {
  const lines = md.split('\n');
  const blocks: string[] = [];
  let inBlock = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (!inBlock && line.trim() === '```json') {
      inBlock = true;
      buf = [];
      continue;
    }
    if (inBlock && line.trim() === '```') {
      blocks.push(buf.join('\n'));
      inBlock = false;
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return blocks;
}

/** Stable, key-sorted JSON for order-independent structural comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

export interface SchemaProvenance {
  schema_id: string;
  file: string;
  match: boolean;
  detail: string;
}

/** Compare each vendored evidence schema against its frozen spec doc block. */
export function checkEvidenceSchemasVerbatim(): SchemaProvenance[] {
  const md = readFileSync(SPEC, 'utf8');
  const blocks = extractJsonBlocks(md);
  const out: SchemaProvenance[] = [];

  for (const [id, file] of Object.entries(EVIDENCE_SCHEMAS)) {
    const $id = `https://edam.spec/${id}.schema.json`;
    const rec: SchemaProvenance = { schema_id: id, file, match: false, detail: '' };

    const block = blocks.find((b) => b.includes($id));
    if (!block) {
      rec.detail = `no spec JSON block contains ${$id}`;
      out.push(rec);
      continue;
    }

    let specParsed: unknown;
    let vendoredParsed: unknown;
    try {
      specParsed = JSON.parse(block);
    } catch (err) {
      rec.detail = `spec block is not valid JSON: ${(err as Error).message}`;
      out.push(rec);
      continue;
    }
    try {
      vendoredParsed = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8'));
    } catch (err) {
      rec.detail = `vendored file unreadable/invalid: ${(err as Error).message}`;
      out.push(rec);
      continue;
    }

    if (canonical(specParsed) === canonical(vendoredParsed)) {
      rec.match = true;
      rec.detail = 'vendored schema matches the frozen spec block';
    } else {
      rec.detail = 'DRIFT: vendored schema differs from the frozen spec block';
    }
    out.push(rec);
  }
  return out;
}

export interface VerbatimProof {
  proof: 'evidence-schemas-verbatim';
  generated_at: string;
  ok: boolean;
  spec: string;
  results: SchemaProvenance[];
}

export function verifyEvidenceSchemasVerbatim(): VerbatimProof {
  const results = checkEvidenceSchemasVerbatim();
  return {
    proof: 'evidence-schemas-verbatim',
    generated_at: new Date().toISOString(),
    ok: results.length === Object.keys(EVIDENCE_SCHEMAS).length && results.every((r) => r.match),
    spec: 'docs/EDAM-WORM-Evidence-Anchoring-Spec.md §16',
    results,
  };
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const report = process.argv.includes('--report');
  const proof = verifyEvidenceSchemasVerbatim();

  if (report) writeFileSync('evidence-schemas-verbatim-proof.json', JSON.stringify(proof, null, 2) + '\n', 'utf8');

  if (proof.ok) {
    process.stdout.write(`[evidence-schemas-verbatim] OK: ${proof.results.length}/4 evidence schemas match WORM spec §16 verbatim.\n`);
    return;
  }
  for (const r of proof.results.filter((x) => !x.match)) {
    process.stderr.write(`[evidence-schemas-verbatim] ${r.schema_id} (${r.file}): ${r.detail}\n`);
  }
  process.stderr.write('[evidence-schemas-verbatim] provenance drift detected — vendored evidence schema(s) diverged from the spec.\n');
  if (checkOnly) process.exitCode = 1;
}

// Run only when invoked as a script (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('evidence-schemas-verbatim.ts')) main();
