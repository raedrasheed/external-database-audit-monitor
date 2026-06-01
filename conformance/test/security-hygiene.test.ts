// Masking & secret-hygiene gate (Epic E8 / EDAM-T053).
import { describe, it, expect } from 'vitest';
import { scanSecretHygiene, scanText, verifyMasking, verifySecretHygiene } from '../security/secret-hygiene.js';

describe('secret hygiene (T053)', () => {
  it('runtime source logs no secrets and hardcodes no secret literals', () => {
    const v = scanSecretHygiene();
    expect(v, JSON.stringify(v, null, 2)).toEqual([]);
  });

  it('sensitive field masking removes the raw value from a built CCE', () => {
    expect(verifyMasking()).toEqual([]);
  });

  it('overall proof is ok', () => {
    expect(verifySecretHygiene().ok).toBe(true);
  });

  it('scanner flags logging a password (positive control)', () => {
    const v = scanText("console.log('user password is ' + password);", 'x.ts');
    expect(v.some((x) => x.rule === 'LOG_SENSITIVE')).toBe(true);
  });

  it('scanner flags a hardcoded secret literal (positive control)', () => {
    const v = scanText("const password = 'hunter2';", 'x.ts');
    expect(v.some((x) => x.rule === 'HARDCODED_SECRET')).toBe(true);
  });

  it('scanner ignores redacted logging and env-sourced / typed fields (no false positive)', () => {
    expect(scanText('console.log(`cred ${redactCredential(c)}`);', 'x.ts')).toEqual([]);
    expect(scanText('password: this.env.CDC_PASSWORD,', 'x.ts')).toEqual([]);
    expect(scanText('readonly password: string;', 'x.ts')).toEqual([]);
  });
});
