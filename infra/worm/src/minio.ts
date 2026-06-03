// MinIO Object-Lock WORM adapter (Sprint-2 / EDAM-T104; hardened in Sprint-3).
//
// Implements WormStore over MinIO / S3 Object Lock:
//   - bucket created with Object Lock + versioning (W-1/W-2/W-4); the lock config
//     is ASSERTED, not trusted, and a non-lock bucket is refused (T104-H3);
//   - writes apply COMPLIANCE-mode retention (and optional legal hold, W-3);
//   - PER-ROLE credentials (T104-H1/W-8): the writer / reader / retention-admin
//     identities are backed by PHYSICALLY DISTINCT MinIO clients so role
//     separation is enforced by credentials, not convention. A single-credential
//     fallback exists for DEVELOPMENT ONLY (role separation NOT enforced).
// Config is dependency-injected (endpoint/keys/bucket); no ambient secrets, no
// ambient clock (deleteExpired takes `now`). IAM policy content + store-level 403
// proofs are later Sprint-3 tasks (S3-SoD / H5).

import { Client, RETENTION_MODES, LEGAL_HOLD_STATUS, type BucketItem } from 'minio';
import {
  WormError,
  type ObjectLock,
  type PutOptions,
  type WormBytes,
  type WormObjectKey,
  type WormReader,
  type WormRetentionAdmin,
  type WormStore,
  type WormWriter,
} from './types.js';

/** A single MinIO role credential (access key + secret). PUBLIC config only — no ambient secrets. */
export interface MinioRoleCredential {
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface MinioWormConfig {
  endPoint: string;
  port?: number;
  useSSL?: boolean;
  bucket: string;
  region?: string;
  /**
   * DEVELOPMENT ONLY — a single credential reused for ALL roles. Role separation
   * is **NOT enforced** in this mode (the writer / reader / retention-admin
   * clients share one identity). Use `credentials` in production (H1/W-8).
   */
  accessKey?: string;
  secretKey?: string;
  /**
   * Per-role credentials (recommended): physically distinct MinIO identities for
   * writer / reader / retention-admin (H1/W-8). When present, role separation is
   * enforced by the credential, not by convention. All three are required when
   * this field is set (fail-closed).
   */
  credentials?: {
    writer: MinioRoleCredential;
    reader: MinioRoleCredential;
    retentionAdmin: MinioRoleCredential;
  };
}

function ms(instant: string): number {
  const t = Date.parse(instant);
  if (Number.isNaN(t)) throw new WormError(`invalid RFC3339 instant: ${instant}`);
  return t;
}

async function streamToBytes(stream: NodeJS.ReadableStream): Promise<WormBytes> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export class MinioWormStore implements WormStore {
  // PHYSICALLY DISTINCT clients per role (H1). In dev fallback they reference one
  // shared client (role separation NOT enforced).
  private readonly writerClient: Client;
  private readonly readerClient: Client;
  private readonly retentionAdminClient: Client;
  /** Whether per-role credentials were supplied (role separation enforced by credential). */
  readonly roleSeparationEnforced: boolean;
  private readonly bucket: string;
  private readonly region: string;

  constructor(cfg: MinioWormConfig) {
    const base = { endPoint: cfg.endPoint, port: cfg.port, useSSL: cfg.useSSL ?? false } as const;
    const mk = (c: MinioRoleCredential): Client => new Client({ ...base, accessKey: c.accessKey, secretKey: c.secretKey });

    if (cfg.credentials) {
      // Per-role mode: all three role credentials are required (fail-closed, H1).
      const roles: ReadonlyArray<readonly [string, MinioRoleCredential | undefined]> = [
        ['writer', cfg.credentials.writer],
        ['reader', cfg.credentials.reader],
        ['retentionAdmin', cfg.credentials.retentionAdmin],
      ];
      for (const [role, cred] of roles) {
        if (!cred || typeof cred.accessKey !== 'string' || typeof cred.secretKey !== 'string' || cred.accessKey.length === 0 || cred.secretKey.length === 0) {
          throw new WormError(`MinioWormConfig.credentials.${role} is missing/invalid: per-role mode requires all three role credentials (fail-closed, H1)`);
        }
      }
      this.writerClient = mk(cfg.credentials.writer);
      this.readerClient = mk(cfg.credentials.reader);
      this.retentionAdminClient = mk(cfg.credentials.retentionAdmin);
      this.roleSeparationEnforced = true;
    } else if (typeof cfg.accessKey === 'string' && cfg.accessKey.length > 0 && typeof cfg.secretKey === 'string' && cfg.secretKey.length > 0) {
      // DEVELOPMENT-ONLY fallback: one identity for all roles; role separation NOT enforced.
      process.emitWarning(
        'MinioWormStore: single-credential mode — role separation NOT enforced (development only). Provide config.credentials.{writer,reader,retentionAdmin} for production (H1).',
        { code: 'EDAM_WORM_SINGLE_CREDENTIAL' },
      );
      const shared = mk({ accessKey: cfg.accessKey, secretKey: cfg.secretKey });
      this.writerClient = shared;
      this.readerClient = shared;
      this.retentionAdminClient = shared;
      this.roleSeparationEnforced = false;
    } else {
      throw new WormError('MinioWormConfig requires either `credentials.{writer,reader,retentionAdmin}` or `accessKey`+`secretKey` (fail-closed, H1)');
    }

    this.bucket = cfg.bucket;
    this.region = cfg.region ?? 'us-east-1';
  }

  // --- bucket bootstrap / config (retention-admin identity) ---

  /**
   * Create the bucket with Object Lock enabled + versioning, then ASSERT the lock
   * config is actually Enabled (H3) — refusing a non-lock bucket (fail-fast).
   * Bootstrap uses the retention-admin identity. Idempotent.
   */
  async ensureBucket(): Promise<void> {
    const exists = await this.retentionAdminClient.bucketExists(this.bucket);
    if (!exists) {
      await this.retentionAdminClient.makeBucket(this.bucket, this.region, { ObjectLocking: true });
    }
    await this.retentionAdminClient.setBucketVersioning(this.bucket, { Status: 'Enabled' });
    await this.assertObjectLockEnabled();
  }

  /** Assert (against the store) that Object Lock is Enabled (H3). Throws on anything but `Enabled`. */
  private async assertObjectLockEnabled(): Promise<void> {
    let enabled: string | undefined;
    try {
      // The minio d.ts overloads getObjectLockConfig as void|Promise; normalize at runtime.
      const cfg = (await (this.retentionAdminClient.getObjectLockConfig(this.bucket) as unknown as Promise<{ objectLockEnabled?: string }>));
      enabled = cfg?.objectLockEnabled;
    } catch (err) {
      throw new WormError(
        `bucket "${this.bucket}" Object-Lock config is unreadable; refusing to operate on a non-lock bucket (W-1/H3): ${(err as Error).message}`,
      );
    }
    if (enabled !== 'Enabled') {
      throw new WormError(
        `bucket "${this.bucket}" does not have Object Lock Enabled (got ${JSON.stringify(enabled)}); Object Lock can only be set at bucket creation — refusing to operate (W-1/H3)`,
      );
    }
  }

  /** Whether the bucket has S3 Object Lock Enabled (H3) — asserted, not trusted. */
  async objectLockEnabled(): Promise<boolean> {
    try {
      const cfg = (await (this.retentionAdminClient.getObjectLockConfig(this.bucket) as unknown as Promise<{ objectLockEnabled?: string }>));
      return cfg?.objectLockEnabled === 'Enabled';
    } catch {
      return false;
    }
  }

  /** Whether bucket versioning is enabled (W-4) — used by integration checks. */
  async versioningEnabled(): Promise<boolean> {
    const v = await this.retentionAdminClient.getBucketVersioning(this.bucket);
    return v?.Status === 'Enabled';
  }

  // --- data plane (private; each takes the role client; exposed only through role handles) ---

  private async exists(client: Client, key: WormObjectKey): Promise<{ versionId?: string | null } | null> {
    try {
      const stat = await client.statObject(this.bucket, key);
      return { versionId: stat.versionId };
    } catch {
      return null; // NoSuchKey
    }
  }

  private async latestVersionId(client: Client, key: WormObjectKey): Promise<string> {
    const stat = await this.exists(client, key);
    if (!stat) throw new WormError(`no object at "${key}"`);
    if (!stat.versionId) throw new WormError(`object at "${key}" has no versionId (versioning not enabled?)`);
    return stat.versionId;
  }

  private async putImmutable(client: Client, key: WormObjectKey, bytes: WormBytes, opts: PutOptions): Promise<void> {
    if (await this.exists(client, key)) {
      throw new WormError(`object already exists at "${key}"; WORM is append-only (no overwrite)`);
    }
    const buf = Buffer.from(bytes);
    const info = await client.putObject(this.bucket, key, buf, buf.length);
    const versionId = info.versionId ?? (await this.latestVersionId(client, key));
    // Apply COMPLIANCE retention at write time (strengthening; never shortenable later).
    if (opts.retainUntil) {
      await client.putObjectRetention(this.bucket, key, {
        mode: RETENTION_MODES.COMPLIANCE,
        retainUntilDate: opts.retainUntil,
        versionId,
      });
    }
    if (opts.legalHold) {
      await this.setLegalHold(client, key, true, versionId);
    }
  }

  private async get(client: Client, key: WormObjectKey): Promise<WormBytes> {
    if (!(await this.exists(client, key))) throw new WormError(`no object at "${key}"`);
    const stream = await client.getObject(this.bucket, key);
    return streamToBytes(stream);
  }

  private list(client: Client, prefix: string): Promise<WormObjectKey[]> {
    return new Promise<WormObjectKey[]>((resolve, reject) => {
      const keys: WormObjectKey[] = [];
      const stream = client.listObjectsV2(this.bucket, prefix, true);
      stream.on('data', (item: BucketItem) => {
        if (item.name) keys.push(item.name);
      });
      stream.on('error', (err: Error) => reject(new WormError(`list failed: ${err.message}`)));
      stream.on('end', () => resolve(keys.sort())); // deterministic
    });
  }

  private async headObjectLock(client: Client, key: WormObjectKey): Promise<ObjectLock> {
    if (!(await this.exists(client, key))) throw new WormError(`no object at "${key}"`);
    let retainUntil: string | null = null;
    const retention = await client.getObjectRetention(this.bucket, key);
    if (retention && retention.mode) {
      if (retention.mode !== RETENTION_MODES.COMPLIANCE) {
        throw new WormError(`object at "${key}" has non-compliance retention mode ${retention.mode} (W-2)`);
      }
      retainUntil = retention.retainUntilDate;
    }
    // The minio runtime returns either the status string or `{ Status: 'ON'|'OFF' }`
    // (the d.ts only describes the former); normalize both.
    const holdRaw: unknown = await client.getObjectLegalHold(this.bucket, key).catch(() => LEGAL_HOLD_STATUS.DISABLED);
    const holdStatus =
      typeof holdRaw === 'string' ? holdRaw : (holdRaw as { Status?: string } | null)?.Status;
    return { retentionMode: 'compliance', retainUntil, legalHold: holdStatus === LEGAL_HOLD_STATUS.ENABLED };
  }

  private async setLegalHold(client: Client, key: WormObjectKey, on: boolean, versionId?: string): Promise<void> {
    // The minio d.ts types setObjectLegalHold as returning void; at runtime it
    // returns a Promise when no callback is supplied.
    await (client.setObjectLegalHold(this.bucket, key, {
      status: on ? LEGAL_HOLD_STATUS.ENABLED : LEGAL_HOLD_STATUS.DISABLED,
      ...(versionId ? { versionId } : {}),
    }) as unknown as Promise<void>);
  }

  private async extendRetention(client: Client, key: WormObjectKey, retainUntil: string): Promise<void> {
    const lock = await this.headObjectLock(client, key);
    if (lock.retainUntil !== null && ms(retainUntil) < ms(lock.retainUntil)) {
      throw new WormError(`retention can only be extended, never shortened (compliance mode) at "${key}"`);
    }
    const versionId = await this.latestVersionId(client, key);
    // S3/MinIO COMPLIANCE mode is the final authority and also rejects shortening.
    await client.putObjectRetention(this.bucket, key, {
      mode: RETENTION_MODES.COMPLIANCE,
      retainUntilDate: retainUntil,
      versionId,
    });
  }

  private async deleteExpired(client: Client, key: WormObjectKey, now: string): Promise<void> {
    // Defense-in-depth pre-checks (fast, clear errors). They are NOT the authority:
    // the STORE — S3 Object Lock in COMPLIANCE mode — is the final authority (the
    // version-scoped delete below is rejected by MinIO while the version is locked).
    const lock = await this.headObjectLock(client, key);
    if (lock.legalHold) {
      throw new WormError(`object at "${key}" is under legal hold; deletion denied (W-3)`);
    }
    if (lock.retainUntil !== null && ms(now) < ms(lock.retainUntil)) {
      throw new WormError(`object at "${key}" is within its retention window; deletion denied (W-7)`);
    }
    // VERSION-SCOPED delete (H2): target the explicit object VERSION, never the bare
    // key. A bare-key delete in a versioned bucket creates a DELETE MARKER that hides
    // the object from the read path WITHOUT removing the locked version — a hide path.
    // Targeting the versionId keeps the STORE authoritative: COMPLIANCE rejects (403)
    // a version-scoped delete of a still-locked version, so this can only succeed on a
    // genuinely-expired/unlocked version (lawful expiry) — and it removes that version
    // outright, leaving no delete marker.
    const versionId = await this.latestVersionId(client, key);
    await client.removeObject(this.bucket, key, { versionId });
  }

  // --- role-scoped identities (W-8) — each backed by its own physical client (H1) ---

  writer(): WormWriter {
    return { putImmutable: (key, bytes, opts) => this.putImmutable(this.writerClient, key, bytes, opts) };
  }

  reader(): WormReader {
    return {
      get: (key) => this.get(this.readerClient, key),
      list: (prefix) => this.list(this.readerClient, prefix),
      headObjectLock: (key) => this.headObjectLock(this.readerClient, key),
    };
  }

  retentionAdmin(): WormRetentionAdmin {
    return {
      extendRetention: (key, retainUntil) => this.extendRetention(this.retentionAdminClient, key, retainUntil),
      placeLegalHold: (key) => this.setLegalHold(this.retentionAdminClient, key, true),
      liftLegalHold: (key) => this.setLegalHold(this.retentionAdminClient, key, false),
      deleteExpired: (key, now) => this.deleteExpired(this.retentionAdminClient, key, now),
    };
  }
}

/** Construct a MinIO-backed WORM store (does not create the bucket; call ensureBucket()). */
export function createMinioWormStore(config: MinioWormConfig): MinioWormStore {
  return new MinioWormStore(config);
}
