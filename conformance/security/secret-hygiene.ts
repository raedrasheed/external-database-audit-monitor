// Masking & secret-hygiene verification (Epic E8 / EDAM-T053).
//
// Verifies, by static scan + a masking round-trip, that EDAM does not leak
// secrets or PII:
//   - no logging of password/secret values (credential leakage / log PII);
//   - no hardcoded password/secret literals in runtime source;
//   - sensitive field masking actually removes the raw value from a built CCE.
// (Credential redaction is additionally covered by the cdc-collector unit
// tests.) Produces a machine-verifiable proof.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { buildCce, type NormalizedTransaction } from '@edam/cce-model';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

const LOG_CALL = /(console\.\w+|process\.(?:stdout|stderr)\.write)\b/;
const SENSITIVE_TOKEN = /\b(password|passwd|pwd|secret)\b/i;
const SAFE_CONTEXT = /redact|MASK|\*\*\*|masked|: ?string|isSensitive|sensitive_fields/i;
const HARDCODED_SECRET = /\b(password|passwd|pwd|secret)\b\s*[:=]\s*(['"])(?!\s*\$\{)(?:(?!\2).)+\2/i;

/** Scan one file's text for hygiene violations. Exported for positive-control tests. */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, ''); // drop line comments (prose mentions are fine)
    if (LOG_CALL.test(line) && SENSITIVE_TOKEN.test(line) && !SAFE_CONTEXT.test(line)) {
      out.push({ rule: 'LOG_SENSITIVE', file, detail: `line ${i + 1}: logging a sensitive value: ${line.trim().slice(0, 80)}` });
    }
    if (HARDCODED_SECRET.test(line) && !SAFE_CONTEXT.test(line)) {
      out.push({ rule: 'HARDCODED_SECRET', file, detail: `line ${i + 1}: hardcoded secret literal: ${line.trim().slice(0, 80)}` });
    }
  });
  return out;
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
    for (const pkg of readdirSync(root)) walk(join(root, pkg, 'src'), acc);
  }
  return acc;
}

export function scanSecretHygiene(): Violation[] {
  const out: Violation[] = [];
  for (const file of runtimeFiles()) {
    out.push(...scanText(readFileSync(file, 'utf8'), relative(ROOT, file)));
  }
  return out;
}

const SECRET_VALUE = 'TOP-SECRET-NATIONAL-ID-9988';

/** Build a CCE carrying a sensitive value and confirm masking removed the raw value. */
export function verifyMasking(): Violation[] {
  const tx: NormalizedTransaction = {
    source: { db_id: 'kafel-dev-mysql', engine: 'mysql', server_uuid: '3e11fa47-71ca-11e1-9e33-c80aa9429562', schema: 'kafel' },
    transaction: { tx_id: 'm:1', commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: 'm:1', binlog_file: 'f', binlog_pos: 1, lsn: null, scn: null, resume_token: null },
    fidelity: { state: 'HEALTHY', source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } },
    completeness: { consumed_offset_key: 'm:1', gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'DELETE', object: { schema: 'kafel', name: 'beneficiaries', primary_key: { id: 1 } }, before: { id: 1, national_id: SECRET_VALUE, balance: '1.00' }, after: null }],
  };
  const cce = buildCce(tx, { sensitiveFields: ['kafel.beneficiaries.national_id'] });
  if (JSON.stringify(cce).includes(SECRET_VALUE)) {
    return [{ rule: 'MASK_LEAK', file: '<built CCE>', detail: 'raw sensitive value present in a masked CCE' }];
  }
  return [];
}

export interface HygieneProof {
  proof: 'secret-hygiene';
  generated_at: string;
  ok: boolean;
  scanned: { runtime_source: number };
  violations: Violation[];
}

export function verifySecretHygiene(): HygieneProof {
  const violations = [...scanSecretHygiene(), ...verifyMasking()];
  return {
    proof: 'secret-hygiene',
    generated_at: new Date().toISOString(),
    ok: violations.length === 0,
    scanned: { runtime_source: runtimeFiles().length },
    violations,
  };
}

export function writeProofFile(): void {
  writeFileSync('secret-hygiene-proof.json', JSON.stringify(verifySecretHygiene(), null, 2) + '\n', 'utf8');
}
