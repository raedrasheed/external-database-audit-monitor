#!/usr/bin/env -S npx tsx
// verifier-cli bin entry (EDAM-T146). The impure shell: reads files (node:fs),
// parses argv, runs the export-mode verification, prints the report, and exits
// with the policy code (0 PASS / 1 integrity FAIL / 2 usage/parse/schema error).
// WORM mode is minimal/deferred (Q8). No custody events are emitted (Q9).

import { readFileSync } from 'node:fs';
import { argv, exit, stdout, stderr } from 'node:process';
import { parseArgs, CliUsageError } from './args.js';
import { loadTrustRoots } from './trust.js';
import { runExportVerification } from './run-export.js';
import { renderHuman, renderJson } from './render.js';
import { exitCodeFor, EXIT_USAGE_ERROR } from './exit.js';

function readFile(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliUsageError(`cannot read ${label} at ${path}: ${(err as Error).message}`);
  }
}

function main(): void {
  const args = parseArgs(argv.slice(2));

  const trust = loadTrustRoots(JSON.parse(readFile(args.trustPath!, 'trust file')));

  if (args.mode === 'worm') {
    // Q8: WORM mode is deferred for T146 (export mode is the priority).
    stderr.write('WORM mode is not implemented in T146 (export mode only). Use --export.\n');
    exit(EXIT_USAGE_ERROR);
    return;
  }

  const rawPackage: unknown = JSON.parse(readFile(args.exportPath!, 'export package'));
  const result = runExportVerification(rawPackage, { objectsDir: args.objectsDir!, trust });

  stdout.write((args.json ? renderJson(result) : renderHuman(result)) + '\n');
  exit(exitCodeFor(result));
}

try {
  main();
} catch (err) {
  // Any parse / schema / usage / hydration error maps to exit code 2 (fail-closed:
  // a run that could not be performed is NEVER reported as PASS).
  stderr.write(`error: ${(err as Error).message}\n`);
  exit(EXIT_USAGE_ERROR);
}
