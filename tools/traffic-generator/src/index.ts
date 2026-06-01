// Traffic-generator CLI (Epic E7 / EDAM-T049).
//
//   npm run traffic -- --seed 42 --count 8 --dry-run
//   npm run traffic -- --seed 42 --host 127.0.0.1 --port 3306 \
//       --user root --password rootpw --database kafel
//
// --dry-run prints the deterministic plan without touching a database.

import { planTransactions } from './plan.js';
import { executePlans, type DbConfig } from './execute.js';

interface Args {
  seed: number;
  count: number;
  dryRun: boolean;
  db: DbConfig;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : fallback;
  };
  return {
    seed: Number(get('seed', '42')),
    count: Number(get('count', '8')),
    dryRun: argv.includes('--dry-run'),
    db: {
      host: get('host', '127.0.0.1'),
      port: Number(get('port', '3306')),
      user: get('user', 'root'),
      password: get('password', 'rootpw'),
      database: get('database', 'kafel'),
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plans = planTransactions(args.seed, args.count);

  if (args.dryRun) {
    for (const plan of plans) {
      for (const op of plan.ops) {
        process.stdout.write(`#${plan.seq} [${plan.label}] (${op.op}) ${op.sql}\n`);
      }
    }
    process.stdout.write(`\nPlanned ${plans.length} transactions (seed=${args.seed}).\n`);
    return;
  }

  process.stdout.write(`Applying ${plans.length} transactions (seed=${args.seed}) to ` +
    `${args.db.host}:${args.db.port}/${args.db.database}...\n`);
  await executePlans(plans, args.db);
  process.stdout.write('Done.\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
