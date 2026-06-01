// Comprehensive no-write-path verification (Epic E8 / EDAM-T052; pulled forward
// in E6).
//
// Statically proves INV-1: EDAM never writes to the monitored database. Scans:
//   (1) DB provisioning (init SQL) for write GRANTs to monitored-DB users;
//   (2) runtime source string literals for write SQL referencing the monitored
//       schema (`kafel`), and ANY write verb in the read-only monitored reader;
//   (3) config / environment / compose / deployment artifacts for write GRANTs
//       or write SQL referencing the monitored schema;
//   (4) the CDC connector's source DB user — must be the READ-ONLY `cdc` user.
// Produces a machine-verifiable proof (--report) and fails CI (--check) on any
// finding.
//
// Scope = the EDAM RUNTIME (packages/*/src, services/*/src, infra/*/src) plus
// deploy/compose artifacts, excluding tests, scripts, conformance, and tools.
// tools/traffic-generator is a DEV traffic simulator (it intentionally writes to
// the monitored DB to generate change events) — NOT the audit monitor; excluded.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MONITORED_SCHEMA = 'kafel';
/** The only monitored-DB user EDAM may use is the read-only CDC user. */
const READ_ONLY_DB_USERS = new Set(['cdc']);

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

function walk(dir: string, exts: string[], acc: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'test' || entry === 'data') continue;
      walk(p, exts, acc);
    } else if (exts.some((e) => entry.endsWith(e)) && !entry.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
}

function runtimeFiles(): string[] {
  const acc: string[] = [];
  for (const base of ['packages', 'services', 'infra']) {
    const root = join(ROOT, base);
    if (!existsSync(root)) continue;
    for (const pkg of readdirSync(root)) walk(join(root, pkg, 'src'), ['.ts'], acc);
  }
  return acc;
}

function deployFiles(): string[] {
  const acc: string[] = [];
  walk(join(ROOT, 'deploy'), ['.yml', '.yaml', '.properties', '.cnf', '.sh', '.env', '.example'], acc);
  return acc;
}

function literals(src: string): string[] {
  return (src.match(STRING_LITERAL) ?? []).map((s) => s.slice(1, -1));
}

/** (1)+(2): provisioning grants + runtime source write SQL. */
export function scanForWritePaths(): Violation[] {
  const violations: Violation[] = [];

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

  for (const file of runtimeFiles()) {
    const rel = relative(ROOT, file);
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

/** (3)+(4): config/env/compose/deploy + CDC connector source user. */
export function scanDeployArtifacts(): Violation[] {
  const violations: Violation[] = [];
  for (const file of deployFiles()) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');

    if (hasWriteGrant(text)) {
      violations.push({ rule: 'CONFIG_WRITE_GRANT', file: rel, detail: 'write GRANT in a deployment/config artifact' });
    }
    if (WRITE_VERB.test(text) && new RegExp(`\\b${MONITORED_SCHEMA}\\b`).test(text)) {
      // Allow read-only DDL prerequisites? No — any write verb + monitored schema is a finding.
      const offending = text.split('\n').find((l) => WRITE_VERB.test(l) && new RegExp(`\\b${MONITORED_SCHEMA}\\b`).test(l));
      violations.push({ rule: 'CONFIG_WRITE_TO_MONITORED', file: rel, detail: `write SQL referencing ${MONITORED_SCHEMA}: ${(offending ?? '').trim().slice(0, 80)}` });
    }

    // CDC connector source DB user must be the read-only user.
    const userMatch = text.match(/(?:database\.user|source\.database\.user)\s*=\s*([A-Za-z0-9_]+)/i);
    if (userMatch && !READ_ONLY_DB_USERS.has(userMatch[1]!.toLowerCase())) {
      violations.push({ rule: 'CDC_SOURCE_USER_NOT_READONLY', file: rel, detail: `CDC source DB user "${userMatch[1]}" is not the read-only cdc user` });
    }
  }
  return violations;
}

export interface NoWriteProof {
  proof: 'no-write-path';
  generated_at: string;
  ok: boolean;
  scanned: { runtime_source: number; deploy_artifacts: number; provisioning_sql: number };
  violations: Violation[];
}

export function verifyNoWritePath(): NoWriteProof {
  const violations = [...scanForWritePaths(), ...scanDeployArtifacts()];
  const provisioning = ['deploy/compose/mysql/init', 'deploy/compose/mariadb/init']
    .map((d) => join(ROOT, d))
    .filter(existsSync)
    .flatMap((d) => readdirSync(d).filter((x) => x.endsWith('.sql'))).length;
  return {
    proof: 'no-write-path',
    generated_at: new Date().toISOString(),
    ok: violations.length === 0,
    scanned: { runtime_source: runtimeFiles().length, deploy_artifacts: deployFiles().length, provisioning_sql: provisioning },
    violations,
  };
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const report = process.argv.includes('--report');
  const proof = verifyNoWritePath();

  if (report) writeFileSync('no-write-path-proof.json', JSON.stringify(proof, null, 2) + '\n', 'utf8');

  if (proof.ok) {
    process.stdout.write(
      `[no-write-proof] OK (INV-1): scanned ${proof.scanned.runtime_source} source + ` +
        `${proof.scanned.deploy_artifacts} deploy + ${proof.scanned.provisioning_sql} provisioning files; no write path.\n`,
    );
    return;
  }
  for (const v of proof.violations) process.stderr.write(`[no-write-proof] ${v.rule} ${v.file}: ${v.detail}\n`);
  process.stderr.write(`[no-write-proof] ${proof.violations.length} violation(s) — INV-1 broken.\n`);
  if (checkOnly) process.exitCode = 1;
}

// Run only when invoked as a script (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('no-write-proof.ts')) main();

