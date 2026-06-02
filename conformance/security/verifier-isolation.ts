// Verifier-isolation proof (Sprint-2 / EDAM-T147).
//
// Statically proves WV-12 / INV-EV-5 / A-EV7: the independent verifier
// (`packages/verifier`) re-proves evidence from PUBLIC inputs only and imports
// ONLY a small, pure, allow-listed floor — never an EDAM service, writer,
// anchoring service, signing-private key, DB driver, network, or filesystem.
//
// Default-DENY allow-list (fail-closed): every import specifier in
// packages/verifier/src/** must be either a relative intra-package import or a
// member of ALLOWED_SPECIFIERS; anything else is a violation. Two prongs:
//   (1) source-import scan  — packages/verifier/src/**/*.ts (excluding tests);
//   (2) manifest-subset scan — packages/verifier/package.json `dependencies`
//       must be a SUBSET of the allowed @edam/* floor (no service/secret/DB dep).
// Comments are stripped before extraction, so import-like text inside comments
// (e.g. verify-export.ts mentioning `@edam/export`) never trips the gate.
//
// This gate is a STATIC OBSERVER: it reads source + the manifest, asserts, and
// emits a proof artifact. It executes none of the verifier and modifies nothing.
// Scope is strictly packages/verifier — apps/verifier-cli (the impure boundary)
// is intentionally NOT scanned.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The verifier source root to scan (strictly this package; NOT apps/verifier-cli). */
export const VERIFIER_SRC_DIR = 'packages/verifier/src';
/** The verifier manifest whose `dependencies` must be a subset of the allowed floor. */
export const VERIFIER_MANIFEST = 'packages/verifier/package.json';

/**
 * The ONLY bare specifiers the verifier may import (Q2, approved). Pure,
 * public-inputs-only floor + `node:crypto` (the sole permitted node builtin, for
 * public-key/cert parsing + signature verification). Anything else is forbidden.
 */
export const ALLOWED_SPECIFIERS: ReadonlySet<string> = new Set([
  '@edam/canonical',
  '@edam/contracts',
  '@edam/evidence',
  '@edam/cce-model',
  '@edam/anchor-proof',
  'node:crypto',
]);

/** The allowed @edam/* manifest dependencies (subset check; node:crypto is a builtin, not a dep). */
export const ALLOWED_MANIFEST_DEPS: ReadonlySet<string> = new Set([
  '@edam/canonical',
  '@edam/contracts',
  '@edam/evidence',
  '@edam/cce-model',
  '@edam/anchor-proof',
]);

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

const LINE_COMMENT = /\/\/.*$/gm;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/** Strip line + block comments so import-like text inside comments never matches. */
function stripComments(src: string): string {
  return src.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, ' ');
}

/** A relative (intra-package) import — always allowed. */
export function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Extract every import/export-from/dynamic-import/require specifier from source.
 * Comments are stripped first. Matches only import-statement shapes (a quote
 * directly following the keyword), so `Array.from('x')` and similar are ignored.
 */
export function extractImports(source: string): string[] {
  const code = stripComments(source);
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import ... from '...'  /  export ... from '...'
    /\bimport\s*['"]([^'"]+)['"]/g, // import '...'  (side-effect)
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('...')  (dynamic)
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('...')
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) specifiers.add(m[1]!);
  }
  return [...specifiers];
}

/** Pure per-file scanner (exported for the positive-control test). Default-deny. */
export function scanVerifierFile(rel: string, source: string): Violation[] {
  const violations: Violation[] = [];
  for (const spec of extractImports(source)) {
    if (isRelative(spec)) continue;
    if (ALLOWED_SPECIFIERS.has(spec)) continue;
    violations.push({ rule: 'FORBIDDEN_IMPORT', file: rel, detail: `import "${spec}" is not on the verifier allow-list (WV-12 / INV-EV-5)` });
  }
  return violations;
}

/** Pure manifest-subset checker (exported for the positive-control test). */
export function scanManifestText(rel: string, manifestSource: string): Violation[] {
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(manifestSource) as { dependencies?: Record<string, string> };
  } catch (err) {
    return [{ rule: 'MANIFEST_PARSE', file: rel, detail: `cannot parse manifest: ${(err as Error).message}` }];
  }
  const violations: Violation[] = [];
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!ALLOWED_MANIFEST_DEPS.has(dep)) {
      violations.push({ rule: 'MANIFEST_DEP', file: rel, detail: `dependency "${dep}" is not on the verifier allow-list (WV-12 / INV-EV-5)` });
    }
  }
  return violations;
}

/** Recursively collect verifier source .ts files (excluding tests / node_modules / dist). */
function verifierSourceFiles(): string[] {
  const acc: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue;
        walk(p);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        acc.push(p);
      }
    }
  };
  walk(join(ROOT, VERIFIER_SRC_DIR));
  return acc;
}

/** (1) Source-import scan over packages/verifier/src/**. */
export function scanVerifierSource(): Violation[] {
  const violations: Violation[] = [];
  for (const file of verifierSourceFiles()) {
    violations.push(...scanVerifierFile(relative(ROOT, file), readFileSync(file, 'utf8')));
  }
  return violations;
}

/** (2) Manifest-subset scan over packages/verifier/package.json. */
export function scanVerifierManifest(): Violation[] {
  const abs = join(ROOT, VERIFIER_MANIFEST);
  if (!existsSync(abs)) return [{ rule: 'MANIFEST_MISSING', file: VERIFIER_MANIFEST, detail: 'verifier manifest not found' }];
  return scanManifestText(VERIFIER_MANIFEST, readFileSync(abs, 'utf8'));
}

export interface IsolationProof {
  proof: 'verifier-isolation';
  generated_at: string;
  ok: boolean;
  scanned: { source_files: number; manifest: number };
  allow_list: string[];
  violations: Violation[];
}

/**
 * Run both prongs and produce a machine-verifiable proof. Fail-closed and
 * NON-VACUOUS: an empty/missing verifier source tree is itself a violation (the
 * gate must never green a scan of zero files).
 */
export function verifyVerifierIsolation(): IsolationProof {
  const files = verifierSourceFiles();
  const violations = [...scanVerifierSource(), ...scanVerifierManifest()];
  if (files.length === 0) {
    violations.push({ rule: 'NO_SOURCE', file: VERIFIER_SRC_DIR, detail: 'no verifier source files scanned (non-vacuous guard tripped)' });
  }
  return {
    proof: 'verifier-isolation',
    generated_at: new Date().toISOString(),
    ok: violations.length === 0,
    scanned: { source_files: files.length, manifest: existsSync(join(ROOT, VERIFIER_MANIFEST)) ? 1 : 0 },
    allow_list: [...ALLOWED_SPECIFIERS],
    violations,
  };
}

/** Write the proof artifact (CI evidence). */
export function writeProofFile(path = 'verifier-isolation-proof.json'): IsolationProof {
  const proof = verifyVerifierIsolation();
  writeFileSync(path, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  return proof;
}
