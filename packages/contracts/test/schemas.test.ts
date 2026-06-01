// Tests that the vendored schemas load and match the frozen specs (Epic E1 / EDAM-T006).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SCHEMAS, SCHEMA_IDS } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../docs');

function extractJsonBlocks(md: string): string[] {
  const lines = md.split('\n');
  const blocks: string[] = [];
  let inBlock = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (!inBlock && line.trim() === '```json') {
      inBlock = true;
      buf = [];
      continue;
    }
    if (inBlock && line.trim() === '```') {
      blocks.push(buf.join('\n'));
      inBlock = false;
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return blocks;
}

function frozenSchema(mdFile: string, $id: string): unknown {
  const md = readFileSync(join(DOCS, mdFile), 'utf8');
  const block = extractJsonBlocks(md).find((b) => b.includes($id));
  if (!block) throw new Error(`no schema block with ${$id} in ${mdFile}`);
  return JSON.parse(block);
}

describe('vendored schemas', () => {
  it('exposes the registered schema ids (incl. cce-1.1 + snapshot-epoch-manifest-1.0)', () => {
    expect(SCHEMA_IDS.sort()).toEqual([
      'cce-1.0',
      'cce-1.1',
      'db-audit-event-1.0',
      'execution-result-1.0',
      'reversal-directive-1.0',
      'snapshot-epoch-manifest-1.0',
    ]);
  });

  it('all schemas are objects with the expected $id', () => {
    expect((SCHEMAS['cce-1.0'] as any).$id).toBe('https://edam.spec/cce-1.0.schema.json');
    expect((SCHEMAS['cce-1.1'] as any).$id).toBe('https://edam.spec/cce-1.1.schema.json');
    expect((SCHEMAS['reversal-directive-1.0'] as any).$id).toBe(
      'https://edam.spec/reversal-directive-1.0.schema.json',
    );
  });

  it('matches the frozen spec text verbatim', () => {
    expect(SCHEMAS['cce-1.0']).toEqual(
      frozenSchema('CCE-v1-Specification.md', 'https://edam.spec/cce-1.0.schema.json'),
    );
    expect(SCHEMAS['reversal-directive-1.0']).toEqual(
      frozenSchema('EDAM-Companion-Contracts.md', 'https://edam.spec/reversal-directive-1.0.schema.json'),
    );
    expect(SCHEMAS['execution-result-1.0']).toEqual(
      frozenSchema('EDAM-Companion-Contracts.md', 'https://edam.spec/execution-result-1.0.schema.json'),
    );
    expect(SCHEMAS['db-audit-event-1.0']).toEqual(
      frozenSchema('EDAM-Companion-Contracts.md', 'https://edam.spec/db-audit-event-1.0.schema.json'),
    );
    expect(SCHEMAS['snapshot-epoch-manifest-1.0']).toEqual(
      frozenSchema('EDAM-Companion-Contracts.md', 'https://edam.spec/snapshot-epoch-manifest-1.0.schema.json'),
    );
  });
});
