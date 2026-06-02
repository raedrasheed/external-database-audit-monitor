// @edam/verifier-cli — offline evidence verifier CLI (EDAM-T146).
//
// The impure boundary (node:fs/path/process + @edam/worm) around the pure
// @edam/verifier. Export mode (`verify --export <pkg> --objects <dir> --trust
// <trust.json>`) is the priority; WORM mode is minimal/deferred (Q8). This module
// re-exports the testable orchestration surface; `main.ts` is the bin entry.

export { runExportVerification, type RunExportOptions, type ExportVerificationResult } from './run-export.js';
export { loadTrustRoots, TrustFileError, type TrustFile, type TrustRoots } from './trust.js';
export { renderHuman, renderJson } from './render.js';
export { exitCodeFor, EXIT_PASS, EXIT_INTEGRITY_FAIL, EXIT_USAGE_ERROR } from './exit.js';
export { CliParseError } from './parse.js';
export { HydrationError } from './hydrate.js';
export { parseArgs, type CliArgs } from './args.js';
