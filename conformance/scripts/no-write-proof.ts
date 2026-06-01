// No-write-path proof (Epic E6 / mandate C; pulls forward EDAM-T052).
//
// Statically proves INV-1: EDAM never writes to the monitored database. Scans
//   (1) DB provisioning for write GRANTs to monitored-DB users;
//   (2) runtime source string literals for write SQL referencing the monitored
//       schema (`kafel`);
//   (3) the read-only monitored-DB reader (attestation) for ANY write verb.
// Any finding is a violation. `--check` exits non-zero.
//
// Scope = the EDAM RUNTIME (packages/*/src, services/*/src, infra/*/src),
// excluding tests, scripts, conformance, and tools. tools/traffic-generator is
// a DEV traffic simulator (it intentionally writes to the monitored DB to
// generate change events) — it is NOT part of the audit monitor and is excluded.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MONITORED_SCHEMA = 'kafel';

const WRITE_VERB =
  /\b(INSERT\s+INTO|UPDATE\b|DELETE\s+FROM|REPLACE\s+INTO|MERGE\s+INTO|TRUNCATE\b|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/i;
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g;
const WRITE_GRANT_LINE = /\bGRANT\b[^;]*\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|ALL PRIVILEGES)\b/i;

/** A monitored-DB user is granted a write privilege (line-based; comments stripped). */
export function hasWriteGrant(sql: string): boolean {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '')) // drop SQL line comments (avoid matching prose)
    .some((line) => WRITE_GRANT_LINE.test(line));
}

export interface Violation {
  rule: string;
  file: string;
  detail: string;
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

function runtimeFiles(): string[] {
  const acc: string[] = [];
  for (const base of ['packages', 'services', 'infra']) {
    const root = join(ROOT, base);
    if (!existsSync(root)) continue;
    for (const pkg of readdirSync(root)) {
      walk(join(root, pkg, 'src'), acc);
    }
  }
  return acc;
}

function literals(src: string): string[] {
  return (src.match(STRING_LITERAL) ?? []).map((s) => s.slice(1, -1));
}

export function scanForWritePaths(): Violation[] {
  const violations: Violation[] = [];

  // (1) Provisioning grants.
  for (const init of ['deploy/compose/mysql/init', 'deploy/compose/mariadb/init']) {
    const dir = join(ROOT, init);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, f), 'utf8');
      if (hasWriteGrant(sql)) {
        violations.push({ rule: 'GRANT', file: join(init, f), detail: 'monitored-DB user granted write privilege' });
      }
    }
  }

  // (2)/(3) Runtime source literals.
  for (const file of runtimeFiles()) {
    const rel = file.slice(ROOT.length + 1);
    const isMonitoredReader = rel.includes('/attestation/'); // talks to the monitored DB (read-only)
    for (const lit of literals(readFileSync(file, 'utf8'))) {
      if (!WRITE_VERB.test(lit)) continue;
      if (new RegExp(`\\b${MONITORED_SCHEMA}\\b`).test(lit)) {
        violations.push({ rule: 'WRITE_TO_MONITORED_SCHEMA', file: rel, detail: `write SQL references ${MONITORED_SCHEMA}: ${lit.slice(0, 80)}` });
      } else if (isMonitoredReader) {
        violations.push({ rule: 'WRITE_ON_MONITORED_READER', file: rel, detail: `write verb in the read-only monitored reader: ${lit.slice(0, 80)}` });
      }
    }
  }

  return violations;
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const violations = scanForWritePaths();
  if (violations.length === 0) {
    process.stdout.write('[no-write-proof] OK: no monitored-DB write path found (INV-1).\n');
    return;
  }
  for (const v of violations) process.stderr.write(`[no-write-proof] ${v.rule} ${v.file}: ${v.detail}\n`);
  process.stderr.write(`[no-write-proof] ${violations.length} violation(s) — INV-1 broken.\n`);
  if (checkOnly) process.exitCode = 1;
}

// Run only when invoked as a script (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('no-write-proof.ts')) main();
