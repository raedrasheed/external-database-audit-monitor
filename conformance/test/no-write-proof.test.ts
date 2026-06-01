// No-write-path proof gate (Epic E6 / mandate C). Asserts INV-1 holds and that
// the detector actually detects write grants (positive control).
import { describe, it, expect } from 'vitest';
import { scanForWritePaths, hasWriteGrant } from '../scripts/no-write-proof.js';

describe('no-write-path proof (INV-1)', () => {
  it('finds no monitored-DB write path in the runtime + provisioning', () => {
    const violations = scanForWritePaths();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('detector flags a real write grant and ignores read-only grants (positive control)', () => {
    expect(hasWriteGrant("GRANT INSERT ON kafel.* TO 'x'@'%';")).toBe(true);
    expect(hasWriteGrant("GRANT ALL PRIVILEGES ON *.* TO 'x'@'%';")).toBe(true);
    expect(hasWriteGrant('GRANT SELECT, REPLICATION SLAVE, REPLICATION CLIENT\n  ON *.* TO cdc;')).toBe(false);
    expect(hasWriteGrant('-- it has NO INSERT/UPDATE/DELETE/DDL/GRANT')).toBe(false);
  });
});
