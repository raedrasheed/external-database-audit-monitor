// EDAM-S3-POLICY-AUDIT — static audit of the committed MinIO IAM policies
// (deploy/compose/minio/policies/edam-{writer,reader,retention-admin}-policy.json).
//
// This is an OFFLINE, deterministic audit of the policy DOCUMENTS: it parses the
// three committed least-privilege policies, builds a role/action effect matrix
// (explicit Deny overrides Allow), and asserts the separation-of-duties model the
// WORM spec §15 (S-6 least privilege, S-7 separation of duties) and the EDAM-S3-SoD
// + EDAM-S3-SOD-F1 (Option B2) tasks require. It is NOT a live store-level 403 suite
// (that is H5) — it audits that the committed policy definitions remain compliant,
// so a future policy edit cannot silently weaken the guarantees.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY_DIR = join(ROOT, 'deploy/compose/minio/policies');
const BUCKET = 'edam-evidence';
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;
const OBJECT_ARN = `arn:aws:s3:::${BUCKET}/*`;

export type Effect = 'Allow' | 'Deny';
export type ActionEffect = 'Allow' | 'Deny' | 'ImplicitDeny';

interface Statement {
  Sid?: string;
  Effect: Effect;
  Action: string[];
  Resource: string | string[];
}
interface PolicyDoc {
  Version: string;
  Statement: Statement[];
}

export type Role = 'writer' | 'reader' | 'retention-admin';
export const ROLES: readonly Role[] = ['writer', 'reader', 'retention-admin'] as const;

/** The S3 actions the audit reasons about (the WORM-relevant surface). */
export const AUDITED_ACTIONS = [
  's3:PutObject',
  's3:GetObject',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:PutObjectRetention',
  's3:GetObjectRetention',
  's3:PutObjectLegalHold',
  's3:GetObjectLegalHold',
  's3:BypassGovernanceRetention',
  's3:ListBucket',
  's3:GetBucketVersioning',
  's3:PutBucketVersioning',
  's3:GetBucketObjectLockConfiguration',
  's3:PutBucketObjectLockConfiguration',
  's3:PutBucketPolicy',
] as const;

export function loadPolicy(role: Role): PolicyDoc {
  return JSON.parse(readFileSync(join(POLICY_DIR, `edam-${role}-policy.json`), 'utf8')) as PolicyDoc;
}

const asArray = (r: string | string[]): string[] => (Array.isArray(r) ? r : [r]);

/**
 * Effective effect of `action` under `policy`, applying IAM precedence: an explicit
 * Deny always overrides Allow; an action granted by no statement is ImplicitDeny.
 */
export function evaluate(policy: PolicyDoc, action: string): ActionEffect {
  let allowed = false;
  for (const st of policy.Statement) {
    if (!st.Action.includes(action)) continue;
    if (st.Effect === 'Deny') return 'Deny'; // explicit deny wins outright
    if (st.Effect === 'Allow') allowed = true;
  }
  return allowed ? 'Allow' : 'ImplicitDeny';
}

/** True if the action cannot be performed (explicit Deny OR not granted). */
export function isBlocked(policy: PolicyDoc, action: string): boolean {
  return evaluate(policy, action) !== 'Allow';
}

export interface RoleAudit {
  role: Role;
  allowed: string[];
  explicitDeny: string[];
  /** Resources referenced anywhere in the policy. */
  resources: string[];
  /** Resources OUTSIDE the edam-evidence bucket (must be empty). */
  outOfScopeResources: string[];
  /** Non-s3 / administrative actions (must be empty — no IAM/admin management). */
  adminActions: string[];
}

export function auditRole(role: Role): RoleAudit {
  const p = loadPolicy(role);
  const allowed = new Set<string>();
  const deny = new Set<string>();
  const resources = new Set<string>();
  const adminActions = new Set<string>();
  for (const st of p.Statement) {
    for (const r of asArray(st.Resource)) resources.add(r);
    for (const a of st.Action) {
      if (!a.startsWith('s3:')) adminActions.add(a);
      if (st.Effect === 'Allow') allowed.add(a);
      else deny.add(a);
    }
  }
  const inScope = new Set([BUCKET_ARN, OBJECT_ARN]);
  const outOfScope = [...resources].filter((r) => !inScope.has(r));
  return {
    role,
    allowed: [...allowed].sort(),
    explicitDeny: [...deny].sort(),
    resources: [...resources].sort(),
    outOfScopeResources: outOfScope.sort(),
    adminActions: [...adminActions].sort(),
  };
}

export interface AuditViolation {
  role: Role | 'all';
  rule: string;
  detail: string;
}

/**
 * The required SoD model (S-6/S-7 + B2). Each rule is asserted against the EFFECTIVE
 * effect (explicit Deny or not-granted both satisfy a "blocked" requirement).
 */
export function auditAll(): { ok: boolean; roles: RoleAudit[]; violations: AuditViolation[] } {
  const violations: AuditViolation[] = [];
  const policies: Record<Role, PolicyDoc> = {
    writer: loadPolicy('writer'),
    reader: loadPolicy('reader'),
    'retention-admin': loadPolicy('retention-admin'),
  };
  const roles = ROLES.map(auditRole);

  const mustAllow = (role: Role, action: string): void => {
    if (evaluate(policies[role], action) !== 'Allow') {
      violations.push({ role, rule: 'must-allow', detail: `${role} should ALLOW ${action} but got ${evaluate(policies[role], action)}` });
    }
  };
  const mustBlock = (role: Role, action: string): void => {
    if (!isBlocked(policies[role], action)) {
      violations.push({ role, rule: 'must-block', detail: `${role} must NOT be able to ${action} (got Allow)` });
    }
  };

  // --- writer (Domain B): may ONLY put + read-back; everything mutating is blocked.
  mustAllow('writer', 's3:PutObject');
  mustAllow('writer', 's3:GetObject'); // statObject/HeadObject no-overwrite pre-check (B2)
  for (const a of [
    's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectRetention', 's3:PutObjectLegalHold',
    's3:BypassGovernanceRetention', 's3:PutBucketPolicy', 's3:PutBucketObjectLockConfiguration', 's3:PutBucketVersioning',
  ]) mustBlock('writer', a);
  // B2: the writer must be unable to set retention OR legal hold (it never calls them).
  for (const a of ['s3:PutObjectRetention', 's3:PutObjectLegalHold']) {
    if (evaluate(policies.writer, a) !== 'Deny') {
      violations.push({ role: 'writer', rule: 'b2-explicit-deny', detail: `writer must EXPLICITLY Deny ${a} (B2), got ${evaluate(policies.writer, a)}` });
    }
  }

  // --- reader: read-only. No content/lock mutation, no bucket config writes.
  mustAllow('reader', 's3:GetObject');
  for (const a of [
    's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectRetention', 's3:PutObjectLegalHold',
    's3:BypassGovernanceRetention', 's3:PutBucketPolicy', 's3:PutBucketObjectLockConfiguration', 's3:PutBucketVersioning',
  ]) mustBlock('reader', a);
  // reader's allowed set must be read-only (no Put/Delete granted).
  for (const a of auditRole('reader').allowed) {
    if (/Put|Delete|Bypass/.test(a)) {
      violations.push({ role: 'reader', rule: 'read-only', detail: `reader Allow set contains a mutating action: ${a}` });
    }
  }

  // --- retention-admin (Domain C): manages retention + legal hold; NO content write/delete.
  mustAllow('retention-admin', 's3:PutObjectRetention');
  mustAllow('retention-admin', 's3:PutObjectLegalHold');
  for (const a of ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:BypassGovernanceRetention']) {
    mustBlock('retention-admin', a);
  }

  // --- governance bypass denied EVERYWHERE.
  for (const role of ROLES) {
    if (!isBlocked(policies[role], 's3:BypassGovernanceRetention')) {
      violations.push({ role, rule: 'no-governance-bypass', detail: `${role} must not be able to BypassGovernanceRetention` });
    }
  }

  // --- scope: every resource is the edam-evidence bucket/objects; no admin actions.
  for (const r of roles) {
    if (r.outOfScopeResources.length > 0) {
      violations.push({ role: r.role, rule: 'bucket-scope', detail: `out-of-scope resources: ${r.outOfScopeResources.join(', ')}` });
    }
    if (r.adminActions.length > 0) {
      violations.push({ role: r.role, rule: 'no-admin', detail: `non-s3/admin actions present: ${r.adminActions.join(', ')}` });
    }
  }

  return { ok: violations.length === 0, roles, violations };
}

/** A compact role/action effect matrix over the audited action surface. */
export function effectMatrix(): Record<Role, Record<string, ActionEffect>> {
  const out = {} as Record<Role, Record<string, ActionEffect>>;
  for (const role of ROLES) {
    const p = loadPolicy(role);
    out[role] = {};
    for (const a of AUDITED_ACTIONS) out[role][a] = evaluate(p, a);
  }
  return out;
}

function main(): void {
  const res = auditAll();
  process.stdout.write(JSON.stringify({ ok: res.ok, violations: res.violations, matrix: effectMatrix() }, null, 2) + '\n');
  if (!res.ok) {
    for (const v of res.violations) process.stderr.write(`[s3-policy-audit] VIOLATION ${v.role}/${v.rule}: ${v.detail}\n`);
    process.exitCode = 1;
  }
}

// Run only when invoked as a script (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('s3-policy-audit.ts')) main();
