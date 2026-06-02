// Structural parsing (EDAM-T146).
//
// Parses the export package, segment manifests, anchor records, and sidecar CCE
// objects into typed structures. Parsing is STRUCTURAL only (JSON well-formedness):
// a malformed-JSON input is a parse error (exit 2), but a well-formed-but-TAMPERED
// artifact is deliberately passed through to the pure verifier, which recomputes
// hashes / validates schemas and reports a located integrity FAIL (exit 1). This
// keeps "tampered export FAILs with located ids" as an integrity outcome, not a
// parse outcome.

import type { Cce } from '@edam/cce-model';
import type { SegmentManifest } from '@edam/evidence';
import type { AnchorRecord, EvidenceExportPackage } from '@edam/verifier';

/** Raised on malformed JSON / structurally-unusable input. Maps to exit code 2. */
export class CliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliParseError';
  }
}

/** JSON.parse with a labeled, fail-closed error (no silent fallback). */
export function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliParseError(`${label}: not valid JSON (${(err as Error).message})`);
  }
}

export function parseExportPackage(text: string): unknown {
  return parseJson(text, 'export package');
}

/** Parse a serialized segment manifest string (carried inline in the package). */
export function parseManifest(serialized: string, idx: number): SegmentManifest {
  return parseJson(serialized, `segment_manifests[${idx}]`) as SegmentManifest;
}

/** Parse a serialized anchor record string (carried inline in the package). */
export function parseAnchorRecord(serialized: string, idx: number): AnchorRecord {
  return parseJson(serialized, `anchor_records[${idx}]`) as AnchorRecord;
}

/** Parse a sidecar CCE object payload. */
export function parseCce(text: string, key: string): Cce {
  return parseJson(text, `object ${key}`) as Cce;
}

/** Re-export for callers building the typed input. */
export type { EvidenceExportPackage };
