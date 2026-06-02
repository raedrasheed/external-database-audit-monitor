// Retry / backoff / cadence tests (Sprint-2 / EDAM-T134): idempotent re-request
// over the same hash (deterministic anchor_id, captured-once created_at, dedup),
// exponential backoff retry on outage/timeout, cadence (N events / T minutes),
// escalating un-anchored-window alarm, and no fabrication on pending/failed.
import { describe, it, expect } from 'vitest';
import {
  AnchorCoordinator,
  InMemoryAnchorRecordStore,
  AnchorIdCollisionError,
  CadencePolicy,
  UnanchoredWindowMonitor,
  anchorIdFor,
  nextBackoffMs,
  DevRfc3161Provider,
  DevTransparencyLogProvider,
  AnchorOutageError,
  AnchorTimeoutError,
  type AnchorProvider,
  type AnchorRequest,
  type AnchorOutcome,
  type Clock,
  type CoordinatorOutcome,
  type WindowAlarm,
} from '../src/index.js';
import { DevEd25519Signer, buildAnchorPayload, anchorPayloadHash, type ChainHead } from '@edam/signing';

const head: ChainHead = {
  db_id: 'kafel-dev-mysql', segment_id: 'seg-000000', segment_sequence: 0,
  segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64),
};
const payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
const FIXED_MS = Date.parse('2026-06-01T10:05:06.000Z');
const fixedClock: Clock = { now: () => FIXED_MS };

function headForSeq(seq: number) {
  return buildAnchorPayload({ ...head, segment_sequence: seq }, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
}
async function hsmFor(p = payload) {
  return new DevEd25519Signer({ createdAt: '2026-01-01T00:00:00.000Z' }).sign(p);
}
function noSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}

/** Wraps a real provider; throws a retryable error for the first `failFirst` calls. */
class FlakyProvider implements AnchorProvider {
  readonly provider_type: AnchorProvider['provider_type'];
  calls = 0;
  constructor(private readonly inner: AnchorProvider, private readonly failFirst: number, private readonly makeError: () => Error) {
    this.provider_type = inner.provider_type;
  }
  async anchor(request: AnchorRequest): Promise<AnchorOutcome> {
    this.calls++;
    if (this.calls <= this.failFirst) throw this.makeError();
    return this.inner.anchor(request);
  }
  verifyToken(token: Parameters<AnchorProvider['verifyToken']>[0], request: AnchorRequest): boolean {
    return this.inner.verifyToken(token, request);
  }
}

/** Returns an anchored outcome whose token commits to the WRONG hash ⇒ requestAnchor fails (terminal). */
class BadHashProvider implements AnchorProvider {
  readonly provider_type = 'rfc3161' as const;
  calls = 0;
  async anchor(): Promise<AnchorOutcome> {
    this.calls++;
    return { status: 'anchored', token: { provider_type: 'rfc3161', anchor_provider: { type: 'rfc3161', rfc3161_token: 'x', tsa_cert_ref: 'y' }, anchored_at: '2026-06-01T10:05:05.000Z', payload_hash: 'sha256:' + '0'.repeat(64) } };
  }
  verifyToken(): boolean { return true; }
}

function rfcProvider() { return new DevRfc3161Provider({ genTime: '2026-06-01T10:05:05.000Z' }); }
function coordinator(extra: Partial<ConstructorParameters<typeof AnchorCoordinator>[0]> = {}) {
  return new AnchorCoordinator({ clock: fixedClock, sleep: async () => {}, retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 }, ...extra });
}

describe('AnchorCoordinator — idempotent retry (T134)', () => {
  it('anchors a head once and builds a deterministic, schema-valid record', async () => {
    const store = new InMemoryAnchorRecordStore();
    const out = await coordinator({ store }).anchorHead(rfcProvider(), { head: payload, hsmSignature: await hsmFor() });
    expect(out.status).toBe('anchored');
    if (out.status !== 'anchored') throw new Error('unreachable');
    expect(out.anchor_id).toBe(anchorIdFor(anchorPayloadHash(payload), 'rfc3161'));
    expect(out.record.anchor_id).toBe(out.anchor_id);
    expect(out.record.created_at).toBe(new Date(FIXED_MS).toISOString());
    expect(out.deduplicated).toBe(false);
    expect(store.size).toBe(1);
  });

  it('re-request of the same head returns the stored record without re-anchoring (idempotent replay)', async () => {
    const store = new InMemoryAnchorRecordStore();
    const provider = new FlakyProvider(rfcProvider(), 0, () => new Error('unused'));
    const coord = coordinator({ store });
    const a = await coord.anchorHead(provider, { head: payload, hsmSignature: await hsmFor() });
    const b = await coord.anchorHead(provider, { head: payload, hsmSignature: await hsmFor() });
    if (a.status !== 'anchored' || b.status !== 'anchored') throw new Error('unreachable');
    expect(b.deduplicated).toBe(true);
    expect(b.record).toEqual(a.record); // same anchor_id + same created_at
    expect(provider.calls).toBe(1); // did NOT re-anchor
    expect(store.size).toBe(1);
  });

  it('does not re-anchor a transparency log on replay (one leaf only)', async () => {
    const log = new DevTransparencyLogProvider({ sthTime: '2026-06-01T10:05:05.000Z' });
    const coord = coordinator();
    await coord.anchorHead(log, { head: payload, hsmSignature: await hsmFor() });
    await coord.anchorHead(log, { head: payload, hsmSignature: await hsmFor() });
    expect(log.treeSize).toBe(1); // second call deduped before requesting ⇒ no new leaf
  });

  it('retries after provider outage, then anchors (exponential backoff)', async () => {
    const provider = new FlakyProvider(rfcProvider(), 2, () => new AnchorOutageError());
    const { delays, sleep } = noSleep();
    const coord = new AnchorCoordinator({ clock: fixedClock, sleep, retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, factor: 2 } });
    const out = await coord.anchorHead(provider, { head: payload, hsmSignature: await hsmFor() });
    expect(out.status).toBe('anchored');
    expect(provider.calls).toBe(3); // 2 outages + 1 success
    expect(delays).toEqual([10, 20]); // backoff before attempts 2 and 3
  });

  it('retries after provider timeout, then anchors', async () => {
    const provider = new FlakyProvider(rfcProvider(), 1, () => new AnchorTimeoutError(5));
    const coord = coordinator();
    const out = await coord.anchorHead(provider, { head: payload, hsmSignature: await hsmFor() });
    expect(out.status).toBe('anchored');
    expect(provider.calls).toBe(2);
  });

  it('exhausts retries on persistent outage: pending, no record, no fabrication', async () => {
    const store = new InMemoryAnchorRecordStore();
    const provider = new FlakyProvider(rfcProvider(), Number.MAX_SAFE_INTEGER, () => new AnchorOutageError());
    const out: CoordinatorOutcome = await coordinator({ store }).anchorHead(provider, { head: payload, hsmSignature: await hsmFor() });
    expect(out).toEqual({ status: 'pending', reason: 'provider_outage', attempts: 5 });
    expect('record' in out).toBe(false);
    expect(store.size).toBe(0);
  });

  it('fails closed (terminal, no retry) on a hash-mismatched token — no fabrication', async () => {
    const store = new InMemoryAnchorRecordStore();
    const provider = new BadHashProvider();
    const out = await coordinator({ store }).anchorHead(provider, { head: payload, hsmSignature: await hsmFor() });
    expect(out).toEqual({ status: 'failed', reason: 'hash_mismatch' });
    expect(provider.calls).toBe(1); // terminal, not retried
    expect(store.size).toBe(0);
  });

  it('coalesces concurrent attempts for the same head into one provider call', async () => {
    const store = new InMemoryAnchorRecordStore();
    const provider = new FlakyProvider(rfcProvider(), 0, () => new Error('unused'));
    const coord = coordinator({ store });
    const hsm = await hsmFor();
    const [a, b] = await Promise.all([
      coord.anchorHead(provider, { head: payload, hsmSignature: hsm }),
      coord.anchorHead(provider, { head: payload, hsmSignature: hsm }),
    ]);
    if (a.status !== 'anchored' || b.status !== 'anchored') throw new Error('unreachable');
    expect(a.record).toEqual(b.record);
    expect(provider.calls).toBe(1);
    expect(store.size).toBe(1);
  });

  it('same head with different providers yields two distinct records', async () => {
    const store = new InMemoryAnchorRecordStore();
    const coord = coordinator({ store });
    const a = await coord.anchorHead(rfcProvider(), { head: payload, hsmSignature: await hsmFor() });
    const b = await coord.anchorHead(new DevTransparencyLogProvider({ sthTime: '2026-06-01T10:05:05.000Z' }), { head: payload, hsmSignature: await hsmFor() });
    if (a.status !== 'anchored' || b.status !== 'anchored') throw new Error('unreachable');
    expect(a.anchor_id).not.toBe(b.anchor_id);
    expect(a.record.anchor_provider.type).toBe('rfc3161');
    expect(b.record.anchor_provider.type).toBe('transparency_log');
    expect(store.size).toBe(2);
  });

  it('same provider with different heads yields two distinct records', async () => {
    const store = new InMemoryAnchorRecordStore();
    const coord = coordinator({ store });
    const a = await coord.anchorHead(rfcProvider(), { head: headForSeq(0), hsmSignature: await hsmFor(headForSeq(0)) });
    const b = await coord.anchorHead(rfcProvider(), { head: headForSeq(1), hsmSignature: await hsmFor(headForSeq(1)) });
    if (a.status !== 'anchored' || b.status !== 'anchored') throw new Error('unreachable');
    expect(a.anchor_id).not.toBe(b.anchor_id);
    expect(store.size).toBe(2);
  });

  it('detects an anchor_id collision bound to a different head (fail closed)', async () => {
    const store = new InMemoryAnchorRecordStore();
    // Build a genuine record for head seq=1, then store it under head seq=0's deterministic anchor_id.
    const coordB = coordinator({ store: new InMemoryAnchorRecordStore() });
    const built = await coordB.anchorHead(rfcProvider(), { head: headForSeq(1), hsmSignature: await hsmFor(headForSeq(1)) });
    if (built.status !== 'anchored') throw new Error('unreachable');
    const collidingId = anchorIdFor(anchorPayloadHash(headForSeq(0)), 'rfc3161');
    store.putIfAbsent({ ...built.record, anchor_id: collidingId });
    await expect(coordinator({ store }).anchorHead(rfcProvider(), { head: headForSeq(0), hsmSignature: await hsmFor(headForSeq(0)) })).rejects.toBeInstanceOf(AnchorIdCollisionError);
  });

  it('is deterministic across coordinators given a fixed clock + same provider key', async () => {
    const pem = (await import('node:crypto')).generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const mk = () => new DevRfc3161Provider({ privateKeyPem: pem, genTime: '2026-06-01T10:05:05.000Z', serialNumber: 'sn-1' });
    const hsm = await hsmFor();
    const a = await coordinator().anchorHead(mk(), { head: payload, hsmSignature: hsm });
    const b = await coordinator().anchorHead(mk(), { head: payload, hsmSignature: hsm });
    if (a.status !== 'anchored' || b.status !== 'anchored') throw new Error('unreachable');
    expect(a.record).toEqual(b.record);
  });
});

describe('nextBackoffMs (T134)', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    const p = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1000, factor: 2 };
    expect([0, 1, 2, 3, 4, 5].map((n) => nextBackoffMs(n, p))).toEqual([100, 200, 400, 800, 1000, 1000]);
  });
});

describe('CadencePolicy (T134)', () => {
  it('is due after N events (whichever first)', () => {
    const t = 1000;
    const c = new CadencePolicy({ maxEvents: 3, maxIntervalMs: 60_000 }, { clock: { now: () => t }, startAt: 1000 });
    c.recordEvents(2);
    expect(c.due()).toBe(false);
    c.recordEvents(1);
    expect(c.dueReason()).toBe('events');
    c.markAnchored();
    expect(c.pendingEvents).toBe(0);
    expect(c.due()).toBe(false);
  });

  it('is due after T minutes even with few events', () => {
    let t = 1000;
    const c = new CadencePolicy({ maxEvents: 100, maxIntervalMs: 60_000 }, { clock: { now: () => t }, startAt: 1000 });
    c.recordEvents(1);
    expect(c.due()).toBe(false);
    t = 1000 + 60_000;
    expect(c.dueReason()).toBe('interval');
    c.markAnchored(t);
    expect(c.due()).toBe(false);
  });

  it('rejects invalid configuration', () => {
    expect(() => new CadencePolicy({ maxEvents: 0, maxIntervalMs: 1000 })).toThrow();
    expect(() => new CadencePolicy({ maxEvents: 1, maxIntervalMs: 0 })).toThrow();
  });
});

describe('UnanchoredWindowMonitor (T134)', () => {
  it('does not alarm when there are no un-anchored heads', () => {
    const m = new UnanchoredWindowMonitor({ maxWindowMs: 1000, clock: fixedClock });
    expect(m.check().breached).toBe(false);
  });

  it('escalates severity with breach duration and emits on breach', () => {
    let t = 10_000;
    const alarms: WindowAlarm[] = [];
    const m = new UnanchoredWindowMonitor({ maxWindowMs: 1000, clock: { now: () => t }, onAlarm: (a) => alarms.push(a) });
    m.observePending('h1', 10_000);
    t = 10_500; expect(m.check().severity).toBe('none');   // within window
    t = 11_500; expect(m.check().severity).toBe('warning'); // > 1x
    t = 13_000; expect(m.check().severity).toBe('critical'); // > 2x
    t = 16_000; expect(m.check().severity).toBe('emergency'); // > 4x
    expect(alarms.map((a) => a.severity)).toEqual(['warning', 'critical', 'emergency']);
  });

  it('clears the window when the oldest head is anchored', () => {
    let t = 10_000;
    const m = new UnanchoredWindowMonitor({ maxWindowMs: 1000, clock: { now: () => t } });
    m.observePending('h1', 10_000);
    m.observePending('h2', 10_400);
    t = 12_000;
    expect(m.check().severity).toBe('warning');
    expect(m.check().oldestUnanchoredAt).toBe(10_000);
    m.observeAnchored('h1');
    expect(m.check().oldestUnanchoredAt).toBe(10_400); // h2 is now oldest
    m.observeAnchored('h2');
    expect(m.check().breached).toBe(false);
    expect(m.pendingCount).toBe(0);
  });
});

describe('integration: cadence → retry → window recovery (WV-13)', () => {
  it('stays un-anchored under outage (alarms, no fabrication), then anchors on recovery', async () => {
    let t = Date.parse('2026-06-01T10:00:00.000Z');
    const clock: Clock = { now: () => t };
    const store = new InMemoryAnchorRecordStore();
    const cadence = new CadencePolicy({ maxEvents: 2, maxIntervalMs: 300_000 }, { clock, startAt: t });
    const alarms: WindowAlarm[] = [];
    const monitor = new UnanchoredWindowMonitor({ maxWindowMs: 120_000, clock, onAlarm: (a) => alarms.push(a) });
    const coord = new AnchorCoordinator({ clock, sleep: async () => {}, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, store });

    // Two sealed heads accumulate ⇒ cadence due.
    cadence.recordEvents(2);
    expect(cadence.dueReason()).toBe('events');
    const anchorId = anchorIdFor(anchorPayloadHash(payload), 'rfc3161');
    monitor.observePending(anchorId, t);

    // TSA is out: stays un-anchored, no token fabricated.
    const flaky = new FlakyProvider(rfcProvider(), 2, () => new AnchorOutageError());
    const pending = await coord.anchorHead(flaky, { head: payload, hsmSignature: await hsmFor() });
    expect(pending.status).toBe('pending');
    expect('record' in pending).toBe(false);
    expect(store.size).toBe(0);

    // Window breaches ⇒ escalating alarm.
    t += 130_000;
    expect(monitor.check().breached).toBe(true);
    expect(alarms.length).toBeGreaterThan(0);

    // Recovery: same head re-requested, now anchors; window clears; cadence resets.
    const ok = await coord.anchorHead(rfcProvider(), { head: payload, hsmSignature: await hsmFor() });
    expect(ok.status).toBe('anchored');
    if (ok.status !== 'anchored') throw new Error('unreachable');
    monitor.observeAnchored(ok.anchor_id);
    cadence.markAnchored(t);
    expect(monitor.check().breached).toBe(false);
    expect(store.size).toBe(1);
  });
});
