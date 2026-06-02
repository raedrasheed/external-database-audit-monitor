// Object hydration from the sidecar bundle (EDAM-T146, Q1 — Option A).
//
// The export package (T145, Option A) carries object REFERENCES, not blobs. §10
// steps 1-2 (per_object_hash / object_chain) need the actual CCE content, so the
// auditor supplies it out-of-band via `--objects <dir>`: a sidecar bundle laid
// out by `worm_object_key`. This module reads each object's bytes by key, with a
// path-traversal guard (keys are untrusted package input). A missing/unreadable
// sidecar object is a usage error (exit 2) — the bundle is incomplete, so §10
// cannot be run (it is NOT silently treated as PASS).

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Cce } from '@edam/cce-model';
import { parseCce } from './parse.js';

/** Raised when a sidecar object cannot be read (incomplete bundle). Maps to exit code 2. */
export class HydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HydrationError';
  }
}

/** Resolve `worm_object_key` under the sidecar root, refusing path traversal outside it. */
export function resolveObjectPath(objectsDir: string, wormKey: string): string {
  const root = resolve(objectsDir);
  const full = resolve(root, wormKey);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new HydrationError(`object key escapes the sidecar directory: ${wormKey}`);
  }
  return full;
}

/** Read + parse a single sidecar CCE object by its `worm_object_key`. */
export function readSidecarObject(objectsDir: string, wormKey: string): Cce {
  const path = resolveObjectPath(objectsDir, wormKey);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new HydrationError(`cannot read sidecar object for key ${wormKey} at ${path}: ${(err as Error).message}`);
  }
  return parseCce(text, wormKey);
}

/**
 * Hydrate the ordered CCE objects for a segment from its manifest's `object_list`
 * (the full covered set — steps 1-2 verify the WHOLE chain, not just selected
 * refs). Objects are returned in manifest order so they are index-aligned with
 * `object_list` / `object_hash_list`.
 */
export function hydrateSegmentObjects(objectsDir: string, objectList: readonly { worm_object_key: string }[]): Cce[] {
  return objectList.map((entry) => readSidecarObject(objectsDir, entry.worm_object_key));
}
