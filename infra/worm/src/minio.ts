// MinIO Object-Lock WORM adapter (Sprint-2 / EDAM-T104).
//
// Implements WormStore over MinIO / S3 Object Lock:
//   - bucket created with Object Lock + versioning (W-1/W-2/W-4);
//   - writes apply COMPLIANCE-mode retention (and optional legal hold, W-3) so
//     not even an admin/root can shorten retention or delete within the window;
//   - the writer identity still exposes ONLY putImmutable (role separation is
//     the same as the in-memory fake; the worm-no-mutate-proof gate scans the
//     Domain-B CALLER, not this library, which legitimately holds the admin role).
// Config is dependency-injected (endpoint/keys/bucket); no ambient secrets, no
// ambient clock (deleteExpired takes `now`).

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

export interface MinioWormConfig {
  endPoint: string;
  port?: number;
  useSSL?: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
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
  private readonly client: Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(cfg: MinioWormConfig) {
    this.client = new Client({
      endPoint: cfg.endPoint,
      port: cfg.port,
      useSSL: cfg.useSSL ?? false,
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
    });
    this.bucket = cfg.bucket;
    this.region = cfg.region ?? 'us-east-1';
  }

  /**
   * Create the bucket with Object Lock enabled + versioning, then ASSERT the lock
   * config is actually Enabled (EDAM-T104-H3). Object Lock can only be enabled at
   * bucket creation, so the adapter REFUSES to operate on a pre-existing non-lock
   * bucket (fail-fast) — lock is asserted against the store, never trusted.
   * Idempotent.
   */
  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket, this.region, { ObjectLocking: true });
    }
    await this.client.setBucketVersioning(this.bucket, { Status: 'Enabled' });
    await this.assertObjectLockEnabled();
  }

  /**
   * Assert (against the store) that the bucket has S3 Object Lock Enabled (H3).
   * A non-lock bucket — or one whose lock config cannot be read — is a hard
   * refusal: lock cannot be enabled after creation, so operating would mean
   * silently-mutable evidence. Throws `WormError` on anything but `Enabled`.
   */
  private async assertObjectLockEnabled(): Promise<void> {
    let enabled: string | undefined;
    try {
      // The minio d.ts overloads getObjectLockConfig as void|Promise; normalize at runtime.
      const cfg = (await (this.client.getObjectLockConfig(this.bucket) as unknown as Promise<{ objectLockEnabled?: string }>));
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

  /** Whether the bucket has S3 Object Lock Enabled (H3) — asserted, not trusted. Used by integration checks. */
  async objectLockEnabled(): Promise<boolean> {
    try {
      const cfg = (await (this.client.getObjectLockConfig(this.bucket) as unknown as Promise<{ objectLockEnabled?: string }>));
      return cfg?.objectLockEnabled === 'Enabled';
    } catch {
      return false;
    }
  }

  /** Whether bucket versioning is enabled (W-4) — used by integration checks. */
  async versioningEnabled(): Promise<boolean> {
    const v = await this.client.getBucketVersioning(this.bucket);
    return v?.Status === 'Enabled';
  }

  // --- data plane (private; exposed only through role-scoped handles) ---

  private async exists(key: WormObjectKey): Promise<{ versionId?: string | null } | null> {
    try {
      const stat = await this.client.statObject(this.bucket, key);
      return { versionId: stat.versionId };
    } catch {
      return null; // NoSuchKey
    }
  }

  private async latestVersionId(key: WormObjectKey): Promise<string> {
    const stat = await this.exists(key);
    if (!stat) throw new WormError(`no object at "${key}"`);
    if (!stat.versionId) throw new WormError(`object at "${key}" has no versionId (versioning not enabled?)`);
    return stat.versionId;
  }

  private async putImmutable(key: WormObjectKey, bytes: WormBytes, opts: PutOptions): Promise<void> {
    if (await this.exists(key)) {
      throw new WormError(`object already exists at "${key}"; WORM is append-only (no overwrite)`);
    }
    const buf = Buffer.from(bytes);
    const info = await this.client.putObject(this.bucket, key, buf, buf.length);
    const versionId = info.versionId ?? (await this.latestVersionId(key));
    // Apply COMPLIANCE retention at write time (strengthening; never shortenable later).
    if (opts.retainUntil) {
      await this.client.putObjectRetention(this.bucket, key, {
        mode: RETENTION_MODES.COMPLIANCE,
        retainUntilDate: opts.retainUntil,
        versionId,
      });
    }
    if (opts.legalHold) {
      await this.setLegalHold(key, true, versionId);
    }
  }

  private async get(key: WormObjectKey): Promise<WormBytes> {
    if (!(await this.exists(key))) throw new WormError(`no object at "${key}"`);
    const stream = await this.client.getObject(this.bucket, key);
    return streamToBytes(stream);
  }

  private list(prefix: string): Promise<WormObjectKey[]> {
    return new Promise<WormObjectKey[]>((resolve, reject) => {
      const keys: WormObjectKey[] = [];
      const stream = this.client.listObjectsV2(this.bucket, prefix, true);
      stream.on('data', (item: BucketItem) => {
        if (item.name) keys.push(item.name);
      });
      stream.on('error', (err: Error) => reject(new WormError(`list failed: ${err.message}`)));
      stream.on('end', () => resolve(keys.sort())); // deterministic
    });
  }

  private async headObjectLock(key: WormObjectKey): Promise<ObjectLock> {
    if (!(await this.exists(key))) throw new WormError(`no object at "${key}"`);
    let retainUntil: string | null = null;
    const retention = await this.client.getObjectRetention(this.bucket, key);
    if (retention && retention.mode) {
      if (retention.mode !== RETENTION_MODES.COMPLIANCE) {
        throw new WormError(`object at "${key}" has non-compliance retention mode ${retention.mode} (W-2)`);
      }
      retainUntil = retention.retainUntilDate;
    }
    // The minio runtime returns either the status string or `{ Status: 'ON'|'OFF' }`
    // (the d.ts only describes the former); normalize both.
    const holdRaw: unknown = await this.client.getObjectLegalHold(this.bucket, key).catch(() => LEGAL_HOLD_STATUS.DISABLED);
    const holdStatus =
      typeof holdRaw === 'string' ? holdRaw : (holdRaw as { Status?: string } | null)?.Status;
    return { retentionMode: 'compliance', retainUntil, legalHold: holdStatus === LEGAL_HOLD_STATUS.ENABLED };
  }

  private async setLegalHold(key: WormObjectKey, on: boolean, versionId?: string): Promise<void> {
    // The minio d.ts types setObjectLegalHold as returning void; at runtime it
    // returns a Promise when no callback is supplied.
    await (this.client.setObjectLegalHold(this.bucket, key, {
      status: on ? LEGAL_HOLD_STATUS.ENABLED : LEGAL_HOLD_STATUS.DISABLED,
      ...(versionId ? { versionId } : {}),
    }) as unknown as Promise<void>);
  }

  private async extendRetention(key: WormObjectKey, retainUntil: string): Promise<void> {
    const lock = await this.headObjectLock(key);
    if (lock.retainUntil !== null && ms(retainUntil) < ms(lock.retainUntil)) {
      throw new WormError(`retention can only be extended, never shortened (compliance mode) at "${key}"`);
    }
    const versionId = await this.latestVersionId(key);
    // S3/MinIO COMPLIANCE mode is the final authority and also rejects shortening.
    await this.client.putObjectRetention(this.bucket, key, {
      mode: RETENTION_MODES.COMPLIANCE,
      retainUntilDate: retainUntil,
      versionId,
    });
  }

  private async deleteExpired(key: WormObjectKey, now: string): Promise<void> {
    const lock = await this.headObjectLock(key);
    if (lock.legalHold) {
      throw new WormError(`object at "${key}" is under legal hold; deletion denied (W-3)`);
    }
    if (lock.retainUntil !== null && ms(now) < ms(lock.retainUntil)) {
      throw new WormError(`object at "${key}" is within its retention window; deletion denied (W-7)`);
    }
    // MinIO Object Lock is the final authority; this only succeeds if truly unlocked.
    await this.client.removeObject(this.bucket, key);
  }

  // --- role-scoped identities (W-8) ---

  writer(): WormWriter {
    return { putImmutable: (key, bytes, opts) => this.putImmutable(key, bytes, opts) };
  }

  reader(): WormReader {
    return {
      get: (key) => this.get(key),
      list: (prefix) => this.list(prefix),
      headObjectLock: (key) => this.headObjectLock(key),
    };
  }

  retentionAdmin(): WormRetentionAdmin {
    return {
      extendRetention: (key, retainUntil) => this.extendRetention(key, retainUntil),
      placeLegalHold: (key) => this.setLegalHold(key, true),
      liftLegalHold: (key) => this.setLegalHold(key, false),
      deleteExpired: (key, now) => this.deleteExpired(key, now),
    };
  }
}

/** Construct a MinIO-backed WORM store (does not create the bucket; call ensureBucket()). */
export function createMinioWormStore(config: MinioWormConfig): MinioWormStore {
  return new MinioWormStore(config);
}
