// Read-only CDC credential handling (Epic E2 / EDAM-T010).
//
// INV-1: EDAM never writes to the monitored database. The collector loads the
// CDC credential from a secret store *reference* (never embeds it) and refuses
// to proceed unless the credential is declared read-only. The actual database
// grants are enforced read-only by the dev/prod provisioning (E7); this is the
// service-side guard.

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface ReadOnlyCredential {
  readonly username: string;
  readonly password: string;
  readonly access: 'read-only';
  readonly ref: string;
}

/** A secret store that resolves a reference to credential material. */
export interface SecretSource {
  get(ref: string): Promise<{ username: string; password: string; access?: string }>;
}

/**
 * Dev secret source backed by environment variables (CDC_USER / CDC_PASSWORD /
 * CDC_ACCESS). A Vault-backed SecretSource plugs in unchanged in production.
 */
export class EnvSecretSource implements SecretSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(ref: string): Promise<{ username: string; password: string; access?: string }> {
    const username = this.env.CDC_USER;
    const password = this.env.CDC_PASSWORD;
    const access = this.env.CDC_ACCESS ?? 'read-only';
    if (!username || !password) {
      throw new CredentialError(`missing CDC credential for ref "${ref}" (set CDC_USER/CDC_PASSWORD)`);
    }
    return { username, password, access };
  }
}

/** Assert a credential is declared read-only (INV-1). */
export function assertReadOnly(access: string | undefined): asserts access is 'read-only' {
  if (access !== 'read-only') {
    throw new CredentialError(
      `CDC credential must be read-only (INV-1: EDAM never writes to the monitored DB); got: ${String(access)}`,
    );
  }
}

/** Resolve a read-only credential from a secret reference, enforcing INV-1. */
export async function loadReadOnlyCredential(ref: string, source: SecretSource): Promise<ReadOnlyCredential> {
  const s = await source.get(ref);
  assertReadOnly(s.access);
  return { username: s.username, password: s.password, access: 'read-only', ref };
}

/** Safe representation that never exposes the password. */
export function redactCredential(cred: ReadOnlyCredential): string {
  return `${cred.username}:***@(${cred.ref}) [read-only]`;
}
