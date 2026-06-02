// anchor-no-fabrication gate (Sprint-2 / EDAM-T135).
//
// Runtime conformance proof of INV-EV-6 / A-EV6 / WV-13: on a simulated external
// anchor-authority (TSA / transparency-log) OUTAGE — and on timeout, malformed
// response, or a provider that fabricates an unverifiable "anchored" claim — the
// anchoring stack produces NO token and NO anchor record, the head stays
// ANCHOR_PENDING, and an escalating alarm is raised; on recovery the SAME queued
// head anchors (verified token ⇒ schema-valid record) and the un-anchored window
// clears. Idempotent re-request does not re-anchor (no extra transparency-log
// leaf). Drives the real T133 builder + T134 coordinator/monitor (no new code).
//
// Lifecycle is derived, not re-implemented: a head is ANCHORED iff a VERIFIED
// anchor record exists in the store, else ANCHOR_PENDING — so "no transition to
// ANCHORED without a verified anchor record" is proven without a state machine
// (the WORM-persisted lifecycle is a later task). Mirrors the worm-no-mutate /
// signing-key-hygiene gates (--check / --report).

import { writeFileSync } from 'node:fs';
import {
  AnchorCoordinator,
  InMemoryAnchorRecordStore,
  UnanchoredWindowMonitor,
  anchorIdFor,
  DevRfc3161Provider,
  DevTransparencyLogProvider,
  AnchorOutageError,
  AnchorTimeoutError,
  type AnchorProvider,
  type AnchorProviderProof,
  type AnchorProviderType,
  type AnchorRecordStore,
  type AnchorRequest,
  type AnchorOutcome,
  type AnchorToken,
  type WindowAlarm,
} from '@edam/anchoring';
import { DevEd25519Signer, buildAnchorPayload, anchorPayloadHash, type AnchorPayload, type SignatureResult } from '@edam/signing';

/** The two external-anchor providers implemented this sprint (dual_custodian is unimplemented). */
const PROVIDER_TYPES: readonly AnchorProviderType[] = ['rfc3161', 'transparency_log'];
const MAX_WINDOW_MS = 120_000;
const RECOVERY_INSTANT = '2026-06-01T10:05:06.000Z';

export interface Check {
  provider: AnchorProviderType;
  scenario: string;
  name: string;
  ok: boolean;
  detail: string;
}

export interface AnchorNoFabricationProof {
  proof: 'anchor-no-fabrication';
  generated_at: string;
  ok: boolean;
  scanned: { providers: number; scenarios: number; checks: number };
  failures: Check[];
}

// ---------------------------------------------------------------------------
// Scripted providers that simulate failure / fabrication. None can ever produce
// a record: the T130 guard + T133 builder refuse anything not verified.
// ---------------------------------------------------------------------------

/** Throws a (retryable) outage/timeout error on every attempt. */
class ThrowingProvider implements AnchorProvider {
  constructor(readonly provider_type: AnchorProviderType, private readonly makeError: () => Error) {}
  async anchor(): Promise<AnchorOutcome> {
    throw this.makeError();
  }
  verifyToken(): boolean {
    return false;
  }
}

/** Returns an `anchored` outcome with a structurally MALFORMED token. */
class MalformedProvider implements AnchorProvider {
  constructor(readonly provider_type: AnchorProviderType) {}
  async anchor(): Promise<AnchorOutcome> {
    return { status: 'anchored', token: { provider_type: this.provider_type } as unknown as AnchorToken };
  }
  verifyToken(): boolean {
    return true;
  }
}

/** Claims `anchored` with a WELL-FORMED token bound to the right hash, but cannot verify it. */
class FabricatingProvider implements AnchorProvider {
  constructor(readonly provider_type: AnchorProviderType) {}
  async anchor(request: AnchorRequest): Promise<AnchorOutcome> {
    return {
      status: 'anchored',
      token: { provider_type: this.provider_type, anchor_provider: wellFormedProof(this.provider_type), anchored_at: '2026-06-01T10:05:05.000Z', payload_hash: request.payload_hash },
    };
  }
  verifyToken(): boolean {
    return false; // fabrication: no cryptographic proof exists
  }
}

function wellFormedProof(type: AnchorProviderType): AnchorProviderProof {
  if (type === 'rfc3161') return { type: 'rfc3161', rfc3161_token: 'forged-token', tsa_cert_ref: 'forged-cert' };
  if (type === 'transparency_log') return { type: 'transparency_log', transparency_log: { log_id: 'forged-log', leaf_index: 0, inclusion_proof: [], signed_tree_head: 'forged-sth' } };
  return { type: 'dual_custodian', dual_custodian: { custodian_id: 'x', signature: 'y', key_ref: 'z', timestamp: '2026-06-01T10:05:05.000Z' } };
}

function makeHealthyProvider(type: AnchorProviderType): AnchorProvider {
  if (type === 'rfc3161') return new DevRfc3161Provider({ genTime: '2026-06-01T10:05:05.000Z' });
  return new DevTransparencyLogProvider({ sthTime: '2026-06-01T10:05:05.000Z' });
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function headAndHsm(seq: number): Promise<{ head: AnchorPayload; hsm: SignatureResult }> {
  const head = buildAnchorPayload(
    { db_id: 'kafel-dev-mysql', segment_id: `seg-${String(seq).padStart(6, '0')}`, segment_sequence: seq, segment_hash: 'sha256:' + 'a'.repeat(64), last_row_hash: 'sha256:' + 'b'.repeat(64) },
    { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' },
  );
  const hsm = await new DevEd25519Signer({ createdAt: '2026-01-01T00:00:00.000Z' }).sign(head);
  return { head, hsm };
}

/** Derived lifecycle state: ANCHORED iff a verified record exists, else ANCHOR_PENDING. */
function lifecycleState(store: AnchorRecordStore, anchorId: string): 'ANCHORED' | 'ANCHOR_PENDING' {
  return store.get(anchorId) !== undefined ? 'ANCHORED' : 'ANCHOR_PENDING';
}

function hasRecord(outcome: AnchorOutcome | { status: string }): boolean {
  return 'record' in outcome;
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

async function runProvider(provider: AnchorProviderType): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (scenario: string, name: string, ok: boolean, detail = ''): void => {
    checks.push({ provider, scenario, name, ok, detail });
  };

  // ---- Outage → ANCHOR_PENDING, no token, alarm; recovery → ANCHORED ----
  {
    let t = Date.parse('2026-06-01T10:00:00.000Z');
    const clock = { now: () => t };
    const store = new InMemoryAnchorRecordStore();
    const alarms: WindowAlarm[] = [];
    const monitor = new UnanchoredWindowMonitor({ maxWindowMs: MAX_WINDOW_MS, clock, onAlarm: (a) => alarms.push(a) });
    const coord = new AnchorCoordinator({ store, clock, sleep: async () => {}, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });

    const { head, hsm } = await headAndHsm(0);
    const anchorId = anchorIdFor(anchorPayloadHash(head), provider);
    monitor.observePending(anchorId, t);

    const outage = await coord.anchorHead(new ThrowingProvider(provider, () => new AnchorOutageError()), { head, hsmSignature: hsm });
    add('outage', 'stays-pending', outage.status === 'pending', `status=${outage.status}`);
    add('outage', 'no-token-no-record', !hasRecord(outage), 'pending outcome carries no record');
    add('outage', 'state-ANCHOR_PENDING', lifecycleState(store, anchorId) === 'ANCHOR_PENDING', `store.size=${(store as InMemoryAnchorRecordStore).size}`);

    t += MAX_WINDOW_MS + 10_000; // exceed the un-anchored window
    const alarm = monitor.check();
    add('outage', 'alarm-raised', alarm.breached && alarms.length > 0, `severity=${alarm.severity} emitted=${alarms.length}`);

    // Recovery on the SAME head with a healthy provider.
    t = Date.parse(RECOVERY_INSTANT);
    const healthy = makeHealthyProvider(provider);
    const recovered = await coord.anchorHead(healthy, { head, hsmSignature: hsm });
    add('recovery', 'anchored', recovered.status === 'anchored', `status=${recovered.status}`);
    add('recovery', 'record-present', recovered.status === 'anchored' && recovered.record.anchor_version === 'anchor-record-1.0', 'verified, schema-valid record built');
    add('recovery', 'state-ANCHORED', lifecycleState(store, anchorId) === 'ANCHORED', 'verified record now exists');
    if (recovered.status === 'anchored') monitor.observeAnchored(recovered.anchor_id);
    add('recovery', 'window-cleared', monitor.check().breached === false, 'un-anchored window cleared after anchoring');

    // Idempotent re-request: dedup, no re-anchor, no extra transparency-log leaf.
    const again = await coord.anchorHead(healthy, { head, hsmSignature: hsm });
    add('recovery', 'idempotent-dedup', again.status === 'anchored' && again.deduplicated === true, 're-request returns stored record');
    if (provider === 'transparency_log') {
      add('recovery', 'no-extra-leaf', (healthy as DevTransparencyLogProvider).treeSize === 1, `treeSize=${(healthy as DevTransparencyLogProvider).treeSize}`);
    }
  }

  // ---- Timeout → pending, no record ----
  {
    const store = new InMemoryAnchorRecordStore();
    const coord = new AnchorCoordinator({ store, sleep: async () => {}, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    const { head, hsm } = await headAndHsm(1);
    const out = await coord.anchorHead(new ThrowingProvider(provider, () => new AnchorTimeoutError(1)), { head, hsmSignature: hsm });
    add('timeout', 'stays-pending', out.status === 'pending' && out.reason === 'provider_timeout', `${out.status}/${out.status === 'pending' ? out.reason : ''}`);
    add('timeout', 'no-record', !hasRecord(out) && store.size === 0, 'no token fabricated on timeout');
  }

  // ---- Malformed response → failed, no record ----
  {
    const store = new InMemoryAnchorRecordStore();
    const coord = new AnchorCoordinator({ store, sleep: async () => {}, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    const { head, hsm } = await headAndHsm(2);
    const out = await coord.anchorHead(new MalformedProvider(provider), { head, hsmSignature: hsm });
    add('malformed', 'fails-closed', out.status === 'failed' && out.reason === 'malformed_response', `${out.status}/${out.status === 'failed' ? out.reason : ''}`);
    add('malformed', 'no-record', !hasRecord(out) && store.size === 0, 'no token fabricated on malformed response');
  }

  // ---- Fabricating provider (claims anchored, cannot verify) → failed, no record ----
  {
    const store = new InMemoryAnchorRecordStore();
    const coord = new AnchorCoordinator({ store, sleep: async () => {}, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    const { head, hsm } = await headAndHsm(3);
    const anchorId = anchorIdFor(anchorPayloadHash(head), provider);
    const out = await coord.anchorHead(new FabricatingProvider(provider), { head, hsmSignature: hsm });
    add('fabricated', 'fails-closed', out.status === 'failed' && out.reason === 'token_verification_failed', `${out.status}/${out.status === 'failed' ? out.reason : ''}`);
    add('fabricated', 'no-record', !hasRecord(out) && store.size === 0, 'unverifiable token never becomes a record');
    add('fabricated', 'state-not-ANCHORED', lifecycleState(store, anchorId) === 'ANCHOR_PENDING', 'no ANCHORED without a verified token');
  }

  return checks;
}

export async function verifyAnchorNoFabrication(): Promise<AnchorNoFabricationProof> {
  const checks: Check[] = [];
  for (const provider of PROVIDER_TYPES) checks.push(...(await runProvider(provider)));
  const failures = checks.filter((c) => !c.ok);
  const scenarios = new Set(checks.map((c) => `${c.provider}/${c.scenario}`)).size;
  return {
    proof: 'anchor-no-fabrication',
    generated_at: new Date().toISOString(),
    ok: failures.length === 0,
    scanned: { providers: PROVIDER_TYPES.length, scenarios, checks: checks.length },
    failures,
  };
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const report = process.argv.includes('--report');
  const proof = await verifyAnchorNoFabrication();

  if (report) writeFileSync('anchor-no-fabrication-proof.json', JSON.stringify(proof, null, 2) + '\n', 'utf8');

  if (proof.ok) {
    process.stdout.write(
      `[anchor-no-fabrication] OK (INV-EV-6 / WV-13): ${proof.scanned.checks} checks across ${proof.scanned.providers} providers / ${proof.scanned.scenarios} scenarios; ` +
        `outage/timeout/malformed/fabricated never ANCHORED or produced a token; recovery anchored the queued head.\n`,
    );
    return;
  }
  for (const f of proof.failures) process.stderr.write(`[anchor-no-fabrication] FAIL ${f.provider}/${f.scenario}:${f.name} — ${f.detail}\n`);
  process.stderr.write(`[anchor-no-fabrication] ${proof.failures.length} failed check(s) — INV-EV-6 / WV-13 at risk.\n`);
  if (checkOnly) process.exitCode = 1;
}

// Run only when invoked as a script (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith('anchor-no-fabrication.ts')) await main();
