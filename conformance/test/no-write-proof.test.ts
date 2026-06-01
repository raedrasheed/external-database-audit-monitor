// No-write-path proof gate (Epic E8 / EDAM-T052). Asserts INV-1 holds across
// source + deploy + provisioning, and that the detectors actually detect.
import { describe, it, expect } from 'vitest';
import { scanForWritePaths, scanDeployArtifacts, verifyNoWritePath, hasWriteGrant } from '../scripts/no-write-proof.js';

describe('comprehensive no-write-path proof (INV-1)', () => {
  it('finds no monitored-DB write path in source + provisioning', () => {
    expect(scanForWritePaths(), JSON.stringify(scanForWritePaths(), null, 2)).toEqual([]);
  });

  it('finds no write path in deploy/config/env/compose artifacts', () => {
    expect(scanDeployArtifacts(), JSON.stringify(scanDeployArtifacts(), null, 2)).toEqual([]);
  });

  it('produces a machine-verifiable proof: ok=true with non-trivial scan scope', () => {
    const proof = verifyNoWritePath();
    expect(proof.ok).toBe(true);
    expect(proof.violations).toEqual([]);
    expect(proof.scanned.runtime_source).toBeGreaterThan(0);
    expect(proof.scanned.deploy_artifacts).toBeGreaterThan(0);
    expect(proof.scanned.provisioning_sql).toBeGreaterThan(0);
  });

  it('detector flags a real write grant and ignores read-only grants (positive control)', () => {
    expect(hasWriteGrant("GRANT INSERT ON kafel.* TO 'x'@'%';")).toBe(true);
    expect(hasWriteGrant("GRANT ALL PRIVILEGES ON *.* TO 'x'@'%';")).toBe(true);
    expect(hasWriteGrant('GRANT SELECT, REPLICATION SLAVE, REPLICATION CLIENT\n  ON *.* TO cdc;')).toBe(false);
    expect(hasWriteGrant('-- it has NO INSERT/UPDATE/DELETE/DDL/GRANT')).toBe(false);
  });
});
