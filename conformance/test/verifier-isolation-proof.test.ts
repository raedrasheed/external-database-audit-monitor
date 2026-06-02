// verifier-isolation-proof gate (Sprint-2 / EDAM-T147). Asserts WV-12 / INV-EV-5
// holds for packages/verifier AND that the detector actually flags planted
// forbidden imports (positive controls), so a green result is meaningful.
import { describe, it, expect } from 'vitest';
import {
  scanVerifierSource,
  scanVerifierManifest,
  verifyVerifierIsolation,
  scanVerifierFile,
  scanManifestText,
  extractImports,
  isRelative,
  ALLOWED_SPECIFIERS,
} from '../security/verifier-isolation.js';

describe('verifier-isolation proof (WV-12 / INV-EV-5)', () => {
  it('verifier source imports stay within the allow-list', () => {
    expect(scanVerifierSource(), JSON.stringify(scanVerifierSource(), null, 2)).toEqual([]);
  });

  it('verifier manifest dependencies are a subset of the allowed floor', () => {
    expect(scanVerifierManifest(), JSON.stringify(scanVerifierManifest(), null, 2)).toEqual([]);
  });

  it('produces a machine-verifiable proof: ok=true, non-vacuous, manifest in scope', () => {
    const proof = verifyVerifierIsolation();
    expect(proof.ok, JSON.stringify(proof.violations, null, 2)).toBe(true);
    expect(proof.violations).toEqual([]);
    expect(proof.scanned.source_files).toBeGreaterThan(0); // non-vacuous
    expect(proof.scanned.manifest).toBe(1);
  });

  it('positive control: a planted forbidden import is flagged', () => {
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { sign } from '@edam/signing';").length).toBeGreaterThan(0);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { WormReader } from '@edam/worm';").length).toBeGreaterThan(0);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import x from 'services/anchoring/src/provider.js';").length).toBeGreaterThan(0);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { readFileSync } from 'node:fs';").length).toBeGreaterThan(0);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { Client } from 'pg';").length).toBeGreaterThan(0);
    // dynamic + side-effect + export-from forms are all caught
    expect(scanVerifierFile('packages/verifier/src/x.ts', "await import('node:child_process');").length).toBeGreaterThan(0);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "export { x } from '@edam/export';").length).toBeGreaterThan(0);
  });

  it('positive control: allow-listed + relative imports are NOT flagged', () => {
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { eventHash } from '@edam/canonical';")).toEqual([]);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { verifyRfc3161Token } from '@edam/anchor-proof';")).toEqual([]);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { verify } from 'node:crypto';")).toEqual([]);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { foo } from './report.js';")).toEqual([]);
    expect(scanVerifierFile('packages/verifier/src/x.ts', "import { bar } from '../trust.js';")).toEqual([]);
  });

  it('comment-safety: import-like text inside comments is ignored', () => {
    const commented = [
      "// import { x } from '@edam/signing'; (only a comment)",
      "/* re-derived locally; no import from '@edam/export' */",
      "import { eventHash } from '@edam/canonical';",
    ].join('\n');
    expect(scanVerifierFile('packages/verifier/src/x.ts', commented)).toEqual([]);
  });

  it('does not false-positive on Array.from with a string literal', () => {
    expect(extractImports("const a = Array.from('abc');")).toEqual([]);
  });

  it('manifest subset: a forbidden dependency is flagged; the real allowed set is not', () => {
    const bad = JSON.stringify({ dependencies: { '@edam/canonical': '*', '@edam/worm': '*' } });
    expect(scanManifestText('packages/verifier/package.json', bad).length).toBeGreaterThan(0);
    const ok = JSON.stringify({ dependencies: { '@edam/canonical': '*', '@edam/anchor-proof': '*' } });
    expect(scanManifestText('packages/verifier/package.json', ok)).toEqual([]);
  });

  it('allow-list is exactly the approved floor', () => {
    expect([...ALLOWED_SPECIFIERS].sort()).toEqual(
      ['@edam/anchor-proof', '@edam/canonical', '@edam/cce-model', '@edam/contracts', '@edam/evidence', 'node:crypto'].sort(),
    );
  });

  it('isRelative classifies intra-package imports', () => {
    expect(isRelative('./x.js')).toBe(true);
    expect(isRelative('../y.js')).toBe(true);
    expect(isRelative('@edam/canonical')).toBe(false);
    expect(isRelative('node:crypto')).toBe(false);
  });
});
