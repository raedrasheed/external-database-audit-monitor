// WORM no-mutate proof (Sprint-2 / EDAM-T105).
//
// Statically proves INV-EV-1: Domain B (the append-only evidence writer) holds a
// WORM *append-only* capability and never mutates evidence. Two prongs:
//   (1) Domain-B caller scan — services/evidence-writer/src/** must contain NO
//       delete / overwrite / retention-shorten / legal-hold-admin / signing-key
//       read path (it may only call writer().putImmutable). The dir is absent
//       until EDAM-T106; the scan handles that and auto-covers it once it lands.
//   (2) WORM writer-policy scan — the WormWriter interface (infra/worm) must
//       expose ONLY putImmutable, so the type-level separation of duties (W-8)
//       is CI-enforced.
// Mirrors the Sprint-1 no-write-proof gate (--check / --report). The WORM
// LIBRARY itself (which legitimately defines the admin/delete role) is NOT in
// scope — the gate enforces that Domain B never *calls* those operations.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Domain-B append-only writer source roots (append-only capability only). */
const DOMAIN_B_DIRS = ['services/evidence-writer/src'];
/** The WORM writer-policy declaration to assert against. */
const WRITER_POLICY_FILE = 'infra/worm/src/types.ts';

/** WORM-mutation / admin / key-read paths forbidden in Domain-B source. */
const FORBIDDEN_CALL = [
  // retention-admin role + its operations (Domain B must never hold/call these)
  /\bretentionAdmin\s*\(/,
  /\b(deleteExpired|extendRetention|placeLegalHold|liftLegalHold|setRetention|shortenRetention)\s*\(/,
  // object-store delete / overwrite / retention / legal-hold SDK calls
  /\b(DeleteObjects?Command|deleteObjects?|removeObjects?|PutObjectRetentionCommand|putObjectRetention|PutObjectLegalHoldCommand|putObjectLegalHold)\b/,
  /\bBypassGovernanceRetention\b/,
  // signing-private-key read/extraction (INV-EV-4; writer holds no signing key)
  /\b(getPrivateKey|exportPrivateKey|extractPrivateKey|privateKeyMaterial|signingPrivateKey)\b/,
];
/** Governance-mode retention weakens W-2 (compliance-mode required). */
const GOVERNANCE_RETENTION = /(retentionMode|ObjectLockMode|mode)\s*[:=]\s*['"]?governance['"]?/i;

const LINE_COMMENT = /\/\/.*$/gm;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

function stripComments(src: string): string {
  return src.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, ' ');
}

function walk(dir: string, acc: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue;
      walk(p, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
}

function domainBFiles(): string[] {
  const acc: string[] = [];
  for (const d of DOMAIN_B_DIRS) walk(join(ROOT, d), acc);
  return acc;
}

/** Pure per-file scanner (exported for the positive-control test). */
export function findWormMutations(rel: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const code = stripComments(source); // comments never constitute a real call path
  for (const re of FORBIDDEN_CALL) {
    const m = re.exec(code);
    if (m) violations.push({ rule: 'WORM_MUTATION', file: rel, detail: `forbidden WORM-mutation/admin/key path: ${m[0]}` });
  }
  // governance-mode retention outside string-literal context (config strings are flagged too)
  if (GOVERNANCE_RETENTION.test(code)) {
    violations.push({ rule: 'GOVERNANCE_RETENTION', file: rel, detail: 'governance-mode retention weakens compliance-mode immutability (W-2)' });
  }
  return violations;
}

/** Pure WormWriter-policy checker (exported for the positive-control test). */
export function checkWriterPolicyText(rel: string, typesSource: string): Violation[] {
  const m = /export interface WormWriter\s*\{([\s\S]*?)\n\}/.exec(typesSource);
  if (!m) {
    return [{ rule: 'WRITER_POLICY_MISSING', file: rel, detail: 'WormWriter interface not found' }];
  }
  const body = stripComments(m[1] ?? '');
  if (!/\bputImmutable\s*\(/.test(body)) {
    return [{ rule: 'WRITER_POLICY', file: rel, detail: 'WormWriter must expose putImmutable' }];
  }
  const forbidden = /\b(delete\w*|remove\w*|overwrite\w*|extendRetention|placeLegalHold|liftLegalHold|setRetention|shortenRetention|retentionAdmin)\b/i.exec(body);
  if (forbidden) {
    return [{ rule: 'WRITER_POLICY', file: rel, detail: `WormWriter exposes a forbidden mutating member: ${forbidden[0]}` }];
  }
  return [];
}

/** (1) Scan Domain-B writer source for forbidden mutation paths. */
export function scanDomainBSource(): Violation[] {
  const violations: Violation[] = [];
  for (const file of domainBFiles()) {
    const rel = relative(ROOT, file);
    violations.push(...findWormMutations(rel, readFileSync(file, 'utf8')));
  }
  return violations;
}

/** (2) Assert the WORM writer-policy declaration. */
export function scanWriterPolicy(): Violation[] {
  const abs = join(ROOT, WRITER_POLICY_FILE);
  if (!existsSync(abs)) return [{ rule: 'WRITER_POLICY_MISSING', file: WRITER_POLICY_FILE, detail: 'writer-policy file not found' }];
  return checkWriterPolicyText(WRITER_POLICY_FILE, readFileSync(abs, 'utf8'));
}

export interface NoMutateProof {
  proof: 'worm-no-mutate';
  generated_at: string;
  ok: boolean;
  scanned: { domain_b_source: number; writer_policy: number };
  violations: Violation[];
}

export function verifyNoWormMutate(): NoMutateProof {
  const violations = [...scanDomainBSource(), ...scanWriterPolicy()];
  return {
    proof: 'worm-no-mutate',
    generated_at: new Date().toISOString(),
    ok: violations.length === 0,
    scanned: { domain_b_source: domainBFiles().length, writer_policy: existsSync(join(ROOT, WRITER_POLICY_FILE)) ? 1 : 0 },
    violations,
  };
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const report = process.argv.includes('--report');
  const proof = verifyNoWormMutate();

  if (report) writeFileSync('worm-no-mutate-proof.json', JSON.stringify(proof, null, 2) + '\n', 'utf8');

  if (proof.ok) {
    process.stdout.write(
      `[worm-no-mutate-proof] OK (INV-EV-1): scanned ${proof.scanned.domain_b_source} Domain-B source + ` +
        `${proof.scanned.writer_policy} writer-policy file; no WORM-mutation path.\n`,
    );
    return;
  }
  for (const v of proof.violations) process.stderr.write(`[worm-no-mutate-proof] ${v.rule} ${v.file}: ${v.detail}\n`);
  process.stderr.write(`[worm-no-mutate-proof] ${proof.violations.length} violation(s) — INV-EV-1 at risk.\n`);
  if (checkOnly) process.exitCode = 1;
}

// Run only when invoked as a script (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('worm-no-mutate-proof.ts')) main();
