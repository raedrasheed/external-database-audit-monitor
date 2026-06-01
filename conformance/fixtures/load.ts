// Fixture loader (Epic E7 / EDAM-T050). Reads + validates all fixture files.
// Shared by integration tests and the CCE conformance harness (Epic E6).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateFixture, type Fixture } from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TRANSACTIONS_DIR = join(HERE, 'transactions');

/** Load and validate every fixture, sorted by file name for stable ordering. */
export function loadFixtures(dir: string = TRANSACTIONS_DIR): Fixture[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.map((file) => {
    const raw = readFileSync(join(dir, file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Fixture ${file} is not valid JSON: ${(err as Error).message}`);
    }
    return validateFixture(parsed, file);
  });
}
