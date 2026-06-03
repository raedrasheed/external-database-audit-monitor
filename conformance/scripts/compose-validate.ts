// compose-validate gate (EDAM-T160). Asserts the M-Live dev stack is structurally
// complete: `docker compose config` renders (so the compose file is valid), the
// required services exist, long-running services declare healthchecks, the MinIO
// Object-Lock bootstrap (minio-init) is present, and the dev-signer / dev-tsa-log
// stand-ins are present. Does NOT run `docker compose up` (heavy / live-IO).
//
//   npx tsx conformance/scripts/compose-validate.ts [--check] [--report]

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE_FILE = 'deploy/compose/docker-compose.yml';

/** Long-running services that MUST declare a healthcheck. */
const HEALTHCHECK_REQUIRED = ['mysql', 'mariadb', 'redis', 'postgres', 'vault', 'minio', 'dev-signer', 'dev-tsa-log'];
/** All services that MUST be present in the rendered config. */
const REQUIRED_SERVICES = [...HEALTHCHECK_REQUIRED, 'debezium', 'minio-init'];

export interface Violation {
  rule: string;
  detail: string;
}

interface RenderedService {
  healthcheck?: unknown;
}
interface RenderedConfig {
  services?: Record<string, RenderedService>;
}

/** Render the merged compose config via docker (also proves `docker compose config` passes). */
export function renderComposeConfig(): RenderedConfig {
  const json = execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], { cwd: ROOT, encoding: 'utf8' });
  return JSON.parse(json) as RenderedConfig;
}

/** Pure structural checker over a rendered config (exported for testing). */
export function checkComposeConfig(config: RenderedConfig): Violation[] {
  const violations: Violation[] = [];
  const services = config.services ?? {};

  for (const name of REQUIRED_SERVICES) {
    if (!(name in services)) violations.push({ rule: 'MISSING_SERVICE', detail: `required service "${name}" is absent` });
  }
  for (const name of HEALTHCHECK_REQUIRED) {
    const svc = services[name];
    if (svc && svc.healthcheck === undefined) violations.push({ rule: 'MISSING_HEALTHCHECK', detail: `service "${name}" has no healthcheck` });
  }
  // The Object-Lock bootstrap + the two dev stand-ins are the T160 additions.
  if (!('minio-init' in services)) violations.push({ rule: 'MISSING_BOOTSTRAP', detail: 'minio-init (Object-Lock bucket bootstrap) is absent' });
  if (!('dev-signer' in services)) violations.push({ rule: 'MISSING_DEV_SIGNER', detail: 'dev-signer stand-in is absent' });
  if (!('dev-tsa-log' in services)) violations.push({ rule: 'MISSING_DEV_TSA_LOG', detail: 'dev-tsa-log stand-in is absent' });

  return violations;
}

export interface ComposeProof {
  proof: 'compose-validate';
  generated_at: string;
  ok: boolean;
  services: string[];
  violations: Violation[];
}

export function verifyCompose(): ComposeProof {
  let config: RenderedConfig;
  try {
    config = renderComposeConfig();
  } catch (err) {
    return { proof: 'compose-validate', generated_at: new Date().toISOString(), ok: false, services: [], violations: [{ rule: 'CONFIG_INVALID', detail: `docker compose config failed: ${(err as Error).message}` }] };
  }
  const violations = checkComposeConfig(config);
  return {
    proof: 'compose-validate',
    generated_at: new Date().toISOString(),
    ok: violations.length === 0,
    services: Object.keys(config.services ?? {}).sort(),
    violations,
  };
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const report = process.argv.includes('--report');
  const proof = verifyCompose();
  if (report) writeFileSync('compose-validate-proof.json', JSON.stringify(proof, null, 2) + '\n', 'utf8');

  if (proof.ok) {
    process.stdout.write(`[compose-validate] OK: ${proof.services.length} services render; required services + healthchecks + minio-init + dev-signer + dev-tsa-log present.\n`);
    return;
  }
  for (const v of proof.violations) process.stderr.write(`[compose-validate] ${v.rule}: ${v.detail}\n`);
  process.stderr.write(`[compose-validate] ${proof.violations.length} violation(s).\n`);
  if (checkOnly) process.exitCode = 1;
}

main();
