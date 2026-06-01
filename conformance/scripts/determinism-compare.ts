// Determinism comparator (Epic E6 / EDAM-T041, audit mandate A).
//
// Byte-compares the deterministic portion (`results` + `probe`) of two rig
// artifacts produced on different OS/arch targets. ANY mismatch fails CI.
//
//   npx tsx conformance/scripts/determinism-compare.ts a.json b.json

import { readFileSync } from 'node:fs';

interface Artifact {
  results: Record<string, { envelope_id: string; event_hash: string; row_hash: string }>;
  probe: { canonical: string; sha256: string };
  meta?: { os?: string; arch?: string; node?: string };
}

function deterministicPart(a: Artifact): string {
  // Stable serialization of the parts that MUST match across targets (excludes meta).
  const keys = Object.keys(a.results).sort();
  const results = keys.map((k) => ({ fixture: k, ...a.results[k]! }));
  return JSON.stringify({ results, probe: a.probe });
}

function main(): void {
  const [pathA, pathB] = process.argv.slice(2);
  if (!pathA || !pathB) {
    process.stderr.write('usage: determinism-compare <artifactA> <artifactB>\n');
    process.exitCode = 2;
    return;
  }
  const a = JSON.parse(readFileSync(pathA, 'utf8')) as Artifact;
  const b = JSON.parse(readFileSync(pathB, 'utf8')) as Artifact;

  const da = deterministicPart(a);
  const db = deterministicPart(b);

  if (da === db) {
    process.stdout.write(
      `[determinism] MATCH across targets (${a.meta?.os}/${a.meta?.arch} vs ${b.meta?.os}/${b.meta?.arch}); ` +
        `${Object.keys(a.results).length} fixtures, probe ${a.probe.sha256}\n`,
    );
    return;
  }

  process.stderr.write('[determinism] MISMATCH across targets — CI must fail.\n');
  // Report the first differing fixture for diagnosis.
  for (const k of Object.keys(a.results)) {
    const ra = JSON.stringify(a.results[k]);
    const rb = JSON.stringify(b.results[k]);
    if (ra !== rb) process.stderr.write(`  ${k}:\n    A ${ra}\n    B ${rb}\n`);
  }
  if (a.probe.sha256 !== b.probe.sha256) {
    process.stderr.write(`  probe: A ${a.probe.sha256} B ${b.probe.sha256}\n`);
  }
  process.exitCode = 1;
}

main();
