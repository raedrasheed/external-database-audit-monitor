// Tests for read-only credential handling (Epic E2 / EDAM-T010).
import { describe, it, expect } from 'vitest';
import {
  loadReadOnlyCredential,
  assertReadOnly,
  redactCredential,
  EnvSecretSource,
  CredentialError,
  type SecretSource,
} from '../src/credentials.js';
import { loadServiceConfig } from '../src/config.js';

const okSource: SecretSource = {
  async get() {
    return { username: 'cdc', password: 'cdc_pw', access: 'read-only' };
  },
};

describe('credentials (INV-1)', () => {
  it('loads a read-only credential from a secret reference', async () => {
    const cred = await loadReadOnlyCredential('edam/cdc/mysql', okSource);
    expect(cred.username).toBe('cdc');
    expect(cred.access).toBe('read-only');
    expect(cred.ref).toBe('edam/cdc/mysql');
  });

  it('rejects a credential that is not read-only (INV-1)', async () => {
    const writable: SecretSource = {
      async get() {
        return { username: 'app', password: 'x', access: 'read-write' };
      },
    };
    await expect(loadReadOnlyCredential('ref', writable)).rejects.toBeInstanceOf(CredentialError);
    expect(() => assertReadOnly('write')).toThrow(CredentialError);
    expect(() => assertReadOnly(undefined)).toThrow(CredentialError);
  });

  it('redacts the password', async () => {
    const cred = await loadReadOnlyCredential('ref', okSource);
    const s = redactCredential(cred);
    expect(s).not.toContain('cdc_pw');
    expect(s).toContain('***');
    expect(s).toContain('read-only');
  });

  it('EnvSecretSource reads env and defaults access to read-only', async () => {
    const src = new EnvSecretSource({ CDC_USER: 'cdc', CDC_PASSWORD: 'pw' } as NodeJS.ProcessEnv);
    const got = await src.get('ref');
    expect(got).toEqual({ username: 'cdc', password: 'pw', access: 'read-only' });
  });

  it('EnvSecretSource throws when credential env is missing', async () => {
    const src = new EnvSecretSource({} as NodeJS.ProcessEnv);
    await expect(src.get('ref')).rejects.toBeInstanceOf(CredentialError);
  });
});

describe('loadServiceConfig', () => {
  it('provides safe defaults and never stores a secret (only a ref)', () => {
    const cfg = loadServiceConfig({} as NodeJS.ProcessEnv);
    expect(cfg.engine).toBe('mysql');
    expect(cfg.credentialRef).toBe('edam/cdc/mysql');
    expect(cfg.busStreamKey).toBe('edam:captured');
    expect(Object.values(cfg)).not.toContain('cdc_pw');
  });

  it('rejects an unsupported engine', () => {
    expect(() => loadServiceConfig({ CDC_ENGINE: 'oracle' } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});
