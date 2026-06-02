// Argument parsing (EDAM-T146). Pure + testable (no process/fs).
//
//   verifier-cli verify --export <pkg.json> --objects <dir> --trust <trust.json> [--json]
//   verifier-cli verify --worm <readonly> --db <id> --segments a..b --trust <trust.json>  (minimal/deferred — Q8)

export interface CliArgs {
  command: 'verify';
  mode: 'export' | 'worm';
  /** export mode */
  exportPath?: string;
  objectsDir?: string;
  /** worm mode (Q8: minimal/deferred) */
  worm?: string;
  db?: string;
  segments?: string;
  /** required for real verification (Q4) */
  trustPath?: string;
  json: boolean;
}

/** Raised on malformed/missing arguments. Maps to exit code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const USAGE = [
  'Usage:',
  '  verifier-cli verify --export <pkg.json> --objects <dir> --trust <trust.json> [--json]',
  '  verifier-cli verify --worm <readonly> --db <id> --segments a..b --trust <trust.json>   (deferred)',
].join('\n');

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new CliUsageError(`missing value for ${flag}`);
  return v;
}

/** Parse argv (without node/script prefix) into validated CliArgs. Fail-closed on anything unexpected. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args = [...argv];
  const command = args.shift();
  if (command !== 'verify') throw new CliUsageError(`unknown or missing command ${JSON.stringify(command)}\n${USAGE}`);

  const out: CliArgs = { command: 'verify', mode: 'export', json: false };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    switch (flag) {
      case '--export': out.exportPath = takeValue(args, i++, flag); break;
      case '--objects': out.objectsDir = takeValue(args, i++, flag); break;
      case '--worm': out.worm = takeValue(args, i++, flag); out.mode = 'worm'; break;
      case '--db': out.db = takeValue(args, i++, flag); break;
      case '--segments': out.segments = takeValue(args, i++, flag); break;
      case '--trust': out.trustPath = takeValue(args, i++, flag); break;
      case '--json': out.json = true; break;
      default: throw new CliUsageError(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    }
  }

  if (out.worm !== undefined && out.exportPath !== undefined) throw new CliUsageError('choose either --export or --worm, not both');
  if (out.worm !== undefined) out.mode = 'worm';

  // Trust is mandatory for real verification (Q4).
  if (out.trustPath === undefined) throw new CliUsageError(`--trust <trust.json> is required for verification\n${USAGE}`);

  if (out.mode === 'export') {
    if (out.exportPath === undefined) throw new CliUsageError(`--export <pkg.json> is required\n${USAGE}`);
    if (out.objectsDir === undefined) throw new CliUsageError(`--objects <dir> is required (sidecar object bundle)\n${USAGE}`);
  }

  return out;
}
