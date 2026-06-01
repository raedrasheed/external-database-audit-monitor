// Driver test: every invalid fixture fails with its expected rule (EDAM-T009).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateCceFull, CceStreamValidator, type RuleId } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures/invalid');

const EXPECTED: Record<string, RuleId> = {
  'V01.json': 'V1',
  'V02.json': 'V2',
  'V03.json': 'V3',
  'V04.json': 'V4',
  'V05.json': 'V5',
  'V06.json': 'V6',
  'V07.json': 'V7',
  'V08.json': 'V8',
  'V09.json': 'V9',
  'V10.json': 'V10',
  'V11.json': 'V11',
  'V12.json': 'V12',
  'V13.json': 'V13',
  'V14.json': 'V14',
  'V15.json': 'V15',
};

function load(file: string): unknown {
  return JSON.parse(readFileSync(join(DIR, file), 'utf8'));
}

describe('invalid fixtures V1..V15', () => {
  for (const [file, expectedRule] of Object.entries(EXPECTED)) {
    it(`${file} fails with ${expectedRule}`, () => {
      const data = load(file);
      let rules: RuleId[];
      if (Array.isArray(data)) {
        // Stream rule (V14/V15): feed both events in order.
        const stream = new CceStreamValidator();
        rules = data.flatMap((cce) => stream.check(cce as Record<string, unknown>).map((e) => e.rule));
      } else {
        const result = validateCceFull(data);
        expect(result.valid).toBe(false);
        rules = result.errors.map((e) => e.rule);
      }
      expect(rules).toContain(expectedRule);
    });
  }
});
