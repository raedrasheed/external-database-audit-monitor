// WV-1…WV-14 conformance cases (EDAM-T148). Each case exercises the REAL frozen
// implementations and asserts the spec §17.2 behavior: positive verdicts for the
// happy path and located FAILs for every tamper/gap/forgery. WV-1…WV-11 run the
// §10 procedure in-process via `verifySegments`; WV-12 and WV-14 run through the
// T146 verifier CLI (`runExportVerification`); WV-13 drives the anchoring outage
// path; WV-8 uses the in-memory WORM store. No verifier behavior is modified.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

import { verifySegments, type VerificationReport, type CheckName, type ProjectionSnapshot } from '@edam/verifier';
import { runExportVerification, loadTrustRoots } from '@edam/verifier-cli';
import { DevEd25519Signer } from '@edam/signing';
import { FakeAnchorProvider, requestAnchor, anchorRequestFor, isAnchored, buildAnchorRecord, UnverifiedAnchorError } from '@edam/anchoring';
import { deriveSegmentHead, buildAnchorPayload } from '@edam/evidence';
import { InMemoryWormStore } from '@edam/worm';

import { verifyVerifierIsolation } from '../security/verifier-isolation.js';
import type { WvCase, WvOutcome } from './types.js';
import { buildBaseChain, toSegments, clone, manifestFor, recomputeManifestHash, DB, GENESIS_PREVIOUS_SEGMENT_HASH, type BaseChain } from './fixtures.js';

const REPORT_ID = '99999999-2222-4333-8444-555555555555';
const GEN_AT = '2026-06-02T00:00:00.000Z';

function pass(detail: string): WvOutcome {
  return { passed: true, detail };
}
function fail(detail: string): WvOutcome {
  return { passed: false, detail };
}

function check(report: VerificationReport, name: CheckName) {
  return report.checks.find((c) => c.check === name)!;
}

/** Verify the full chain (or an override) in-process via verifySegments. */
function verifyChain(base: BaseChain, opts: { segments?: ReturnType<typeof toSegments>; scope?: { first_segment_sequence: number; last_segment_sequence: number }; projection?: ProjectionSnapshot; withTrust?: boolean } = {}): VerificationReport {
  const withTrust = opts.withTrust ?? true;
  return verifySegments({
    db_id: base.db_id,
    scope: opts.scope ?? { first_segment_sequence: 0, last_segment_sequence: base.manifests.length - 1 },
    segments: opts.segments ?? toSegments(base.manifests, base.segObjects, base.anchorRecords),
    ...(withTrust ? { trustedKeys: base.trustedKeys, trustedCerts: base.trustedCerts } : {}),
    ...(opts.projection ? { projection: opts.projection } : {}),
    reportId: REPORT_ID,
    generatedAt: GEN_AT,
  });
}

/** Assert a check FAILed with at least one located id (optionally containing `mustLocate`). */
function expectFailLocated(report: VerificationReport, name: CheckName, mustLocate?: string): WvOutcome {
  const c = check(report, name);
  if (c.result !== 'FAIL') return fail(`${name} expected FAIL, got ${c.result} (${c.details ?? ''})`);
  const ids = c.offending_ids ?? [];
  if (ids.length === 0) return fail(`${name} FAILed but located no offending ids`);
  if (mustLocate !== undefined && !ids.some((id) => id.includes(mustLocate))) {
    return fail(`${name} FAIL but located ids ${JSON.stringify(ids)} do not include ${mustLocate}`);
  }
  return pass(`${name} FAIL located [${ids.join(', ')}]`);
}

function expectPass(report: VerificationReport, name: CheckName): WvOutcome {
  const c = check(report, name);
  return c.result === 'PASS' ? pass(`${name} PASS`) : fail(`${name} expected PASS, got ${c.result} (${c.details ?? ''})`);
}

/** Run a function with a materialized sidecar object bundle on disk; always cleans up. */
async function withSidecar(base: BaseChain, fn: (objectsDir: string) => Promise<WvOutcome>): Promise<WvOutcome> {
  const dir = mkdtempSync(join(tmpdir(), 'edam-wv-'));
  try {
    for (const { key, cce } of base.sidecar) {
      const p = resolve(dir, key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(cce));
    }
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const WV_CASES: WvCase[] = [
  {
    id: 'WV-1', title: 'Deterministic manifest hashing', spec_ref: 'spec §17.2 WV-1',
    async run() {
      const base = await buildBaseChain();
      const m = base.manifests[0]!;
      const h1 = recomputeManifestHash(m);
      const h2 = recomputeManifestHash(m);
      if (h1 !== h2 || h1 !== m.manifest_hash) return fail(`manifest_hash not stable: ${h1} / ${h2} / stored ${m.manifest_hash}`);
      const report = verifyChain(base);
      return expectPass(report, 'segment_manifest');
    },
  },
  {
    id: 'WV-2', title: 'Tampered CCE detection (anchor still valid)', spec_ref: 'spec §17.2 WV-2',
    async run() {
      const base = await buildBaseChain();
      const objs = clone(base.segObjects);
      objs[0]![0]!.changes![0]!.after = { id: 0, amount: '999999.00' }; // post-anchor byte alteration; evidence.event_hash left stale
      const tamperedId = objs[0]![0]!.envelope_id;
      const report = verifyChain(base, { segments: toSegments(base.manifests, objs, base.anchorRecords) });
      // A pure content alteration is localized by the event_hash recompute (per_object_hash);
      // the stored row_hash linkage is unchanged, so object_chain is WV-4's domain.
      const per = expectFailLocated(report, 'per_object_hash', tamperedId);
      if (!per.passed) return per;
      const hsm = expectPass(report, 'hsm_signature'); // alteration is post-anchor ⇒ HSM still verifies
      if (!hsm.passed) return hsm;
      return pass(`tampered CCE located on per_object_hash (${tamperedId}); hsm_signature PASS (proves post-anchor)`);
    },
  },
  {
    id: 'WV-3', title: 'Missing object detection', spec_ref: 'spec §17.2 WV-3',
    async run() {
      const base = await buildBaseChain();
      const withheldKey = base.manifests[0]!.object_list[0]!.worm_object_key; // harness identifies the withheld key (Q7)
      const objs = clone(base.segObjects);
      objs[0] = [objs[0]![1]!]; // withhold seq-0 object from segment 0
      const report = verifyChain(base, { segments: toSegments(base.manifests, objs, base.anchorRecords) });
      const seg = expectFailLocated(report, 'segment_manifest', base.manifests[0]!.segment_id);
      if (!seg.passed) return seg;
      return pass(`missing object detected; segment_manifest FAIL located segment; withheld key ${withheldKey}`);
    },
  },
  {
    id: 'WV-4', title: 'Broken chain detection', spec_ref: 'spec §17.2 WV-4',
    async run() {
      const base = await buildBaseChain();
      const objs = clone(base.segObjects);
      objs[0]![1]!.evidence.prev_row_hash = 'sha256:' + 'f'.repeat(64); // break intra-segment linkage
      const brokenId = objs[0]![1]!.envelope_id;
      const report = verifyChain(base, { segments: toSegments(base.manifests, objs, base.anchorRecords) });
      return expectFailLocated(report, 'object_chain', brokenId);
    },
  },
  {
    id: 'WV-5', title: 'Invalid HSM signature', spec_ref: 'spec §17.2 WV-5',
    async run() {
      const base = await buildBaseChain();
      // (a) corrupted signature
      const ars = clone(base.anchorRecords);
      ars[0]!.hsm_signature.signature = Buffer.from('x'.repeat(64)).toString('base64');
      const r1 = verifyChain(base, { segments: toSegments(base.manifests, base.segObjects, ars) });
      const corrupt = expectFailLocated(r1, 'hsm_signature', base.manifests[0]!.segment_id);
      if (!corrupt.passed) return corrupt;
      // (b) unpublished key: empty signing-key directory ⇒ unknown key ⇒ FAIL
      const r2 = verifySegments({
        db_id: base.db_id, scope: { first_segment_sequence: 0, last_segment_sequence: 1 },
        segments: toSegments(base.manifests, base.segObjects, base.anchorRecords),
        trustedKeys: { get: () => undefined }, trustedCerts: base.trustedCerts, reportId: REPORT_ID, generatedAt: GEN_AT,
      });
      const unpublished = expectFailLocated(r2, 'hsm_signature');
      if (!unpublished.passed) return unpublished;
      return pass(`forged signature and unpublished key both FAIL hsm_signature`);
    },
  },
  {
    id: 'WV-6', title: 'Invalid timestamp/anchor token', spec_ref: 'spec §17.2 WV-6',
    async run() {
      const base = await buildBaseChain();
      const ars = clone(base.anchorRecords);
      (ars[0]!.anchor_provider as { rfc3161_token: string }).rfc3161_token = Buffer.from('{}').toString('base64'); // malformed token
      const report = verifyChain(base, { segments: toSegments(base.manifests, base.segObjects, ars) });
      return expectFailLocated(report, 'anchor_token', base.manifests[0]!.segment_id);
    },
  },
  {
    id: 'WV-7', title: 'Projection drift detection (advisory)', spec_ref: 'spec §17.2 WV-7 / §11',
    async run() {
      const base = await buildBaseChain();
      const rows = base.segObjects.flat().map((c) => ({ object_id: c.envelope_id, row_hash: c.evidence.row_hash }));
      const driftedId = rows[0]!.object_id;
      rows[0]!.row_hash = 'sha256:' + 'd'.repeat(64); // projection row drifts away from WORM
      const report = verifyChain(base, { projection: { rows } });
      const drift = expectFailLocated(report, 'projection_consistency', driftedId);
      if (!drift.passed) return drift;
      if (report.overall_result !== 'PASS') return fail(`projection drift must NOT fail overall integrity, got ${report.overall_result}`);
      return pass(`projection drift located on ${driftedId}; overall integrity remains PASS (advisory)`);
    },
  },
  {
    id: 'WV-8', title: 'Legal hold enforcement', spec_ref: 'spec §17.2 WV-8 (in-memory; live MinIO is T162)',
    async run() {
      const store = new InMemoryWormStore();
      const key = `${DB}/seg-000000/000000.cce.json`;
      await store.writer().putImmutable(key, new TextEncoder().encode('{"x":1}'), { retentionMode: 'compliance' });
      await store.retentionAdmin().placeLegalHold(key);
      let denied = false;
      let message = '';
      try {
        await store.retentionAdmin().deleteExpired(key, '2030-01-01T00:00:00.000Z');
      } catch (e) {
        denied = true;
        message = (e as Error).message;
      }
      if (!denied) return fail(`deletion of a legal-hold object was NOT denied`);
      if (!/legal hold|denied/i.test(message)) return fail(`denied but unexpected reason: ${message}`);
      return pass(`legal-hold deletion denied by storage: ${message}`);
    },
  },
  {
    id: 'WV-9', title: 'No missing segment', spec_ref: 'spec §17.2 WV-9',
    async run() {
      const base = await buildBaseChain();
      const segments = toSegments([base.manifests[1]!], [base.segObjects[1]!], [base.anchorRecords[1]!]); // drop genesis (seq 0)
      const report = verifyChain(base, { segments, scope: { first_segment_sequence: 0, last_segment_sequence: 1 } });
      return expectFailLocated(report, 'no_missing_segment', 'seq:0');
    },
  },
  {
    id: 'WV-10', title: 'No missing event (offset continuity)', spec_ref: 'spec §17.2 WV-10',
    async run() {
      const base = await buildBaseChain({ offsetOverlap: true }); // seg1 reuses seg0's last offset key
      const report = verifyChain(base);
      return expectFailLocated(report, 'no_missing_event', base.manifests[1]!.segment_id);
    },
  },
  {
    id: 'WV-11', title: 'Genesis correctness', spec_ref: 'spec §17.2 WV-11',
    async run() {
      const base = await buildBaseChain();
      // Positive: genesis has null previous_segment + all-zero previous hash; valid chain continuity PASS.
      const genesis = base.manifests[0]!;
      if (genesis.previous_segment !== null) return fail(`genesis previous_segment must be null`);
      const positive = expectPass(verifyChain(base, { withTrust: false }), 'cross_segment_continuity');
      if (!positive.passed) return positive;
      // Negative: a non-genesis segment with a wrong previous_segment_hash breaks the link (self-consistent manifest ⇒ isolates continuity).
      const badSeg1 = manifestFor(1, 'seg-000001', base.segObjects[1]!, { segment_id: genesis.segment_id, segment_sequence: 0, segment_hash: 'sha256:' + 'b'.repeat(64) });
      const report = verifyChain(base, { segments: toSegments([genesis, badSeg1], base.segObjects, [undefined, undefined]), withTrust: false });
      const neg = expectFailLocated(report, 'cross_segment_continuity', 'seg-000001');
      if (!neg.passed) return neg;
      const manifestOk = expectPass(report, 'segment_manifest'); // the bad-link manifest is internally self-consistent
      if (!manifestOk.passed) return manifestOk;
      return pass(`genesis null+all-zero (${GENESIS_PREVIOUS_SEGMENT_HASH.slice(0, 14)}…); broken non-genesis link located on cross_segment_continuity`);
    },
  },
  {
    id: 'WV-12', title: 'Independent verifier isolation', spec_ref: 'spec §17.2 WV-12 / INV-EV-5',
    async run() {
      // (a) static isolation proof (T147) is green
      const iso = verifyVerifierIsolation();
      if (!iso.ok) return fail(`verifier-isolation-proof not green: ${JSON.stringify(iso.violations)}`);
      // (b) a full offline verification completes via the CLI using ONLY package + sidecar + out-of-band trust
      const base = await buildBaseChain();
      return withSidecar(base, async (objectsDir) => {
        const result = runExportVerification(base.exportPackage, { objectsDir, trust: loadTrustRoots(base.trustFile), reportId: REPORT_ID, generatedAt: GEN_AT });
        if (result.export_signature.result !== 'PASS') return fail(`offline export envelope not PASS: ${result.export_signature.details}`);
        if (result.report.overall_result !== 'PASS') return fail(`offline verification not PASS: ${JSON.stringify(result.report.checks)}`);
        return pass(`isolation proof green (${iso.scanned.source_files} files) + full offline verification PASS via CLI`);
      });
    },
  },
  {
    id: 'WV-13', title: 'Anchor outage behavior (no fabrication)', spec_ref: 'spec §17.2 WV-13 / INV-EV-6',
    async run() {
      const base = await buildBaseChain();
      const payload = buildAnchorPayload(deriveSegmentHead(base.manifests[0]!), { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
      const req = anchorRequestFor(payload);
      const outage = await requestAnchor(new FakeAnchorProvider('rfc3161', { mode: 'outage' }), req);
      if (outage.status !== 'pending' || outage.reason !== 'provider_outage') return fail(`outage expected pending/provider_outage, got ${JSON.stringify(outage)}`);
      if ('token' in outage) return fail(`outage produced a token (fabrication)`);
      // no fabrication: the anchor-record builder refuses a non-anchored outcome
      const sig = await new DevEd25519Signer().sign(payload);
      let refused = false;
      try {
        buildAnchorRecord({ head: payload, hsmSignature: sig, anchorOutcome: outage });
      } catch (e) {
        refused = e instanceof UnverifiedAnchorError;
      }
      if (!refused) return fail(`anchor-record builder did not refuse a pending (un-anchored) outcome`);
      // recovery anchors the queued head
      const recovered = await requestAnchor(new FakeAnchorProvider('rfc3161', { mode: 'anchored' }), req);
      if (!isAnchored(recovered)) return fail(`recovery did not anchor: ${JSON.stringify(recovered)}`);
      return pass(`outage ⇒ pending(provider_outage), no token, builder refused; recovery anchored`);
    },
  },
  {
    id: 'WV-14', title: 'Export self-verification', spec_ref: 'spec §17.2 WV-14',
    async run() {
      const base = await buildBaseChain();
      return withSidecar(base, async (objectsDir) => {
        // Positive: the export self-verifies offline.
        const ok = runExportVerification(base.exportPackage, { objectsDir, trust: loadTrustRoots(base.trustFile), reportId: REPORT_ID, generatedAt: GEN_AT });
        if (ok.export_signature.result !== 'PASS' || ok.report.overall_result !== 'PASS') {
          return fail(`valid export did not self-verify: envelope=${ok.export_signature.result}, overall=${ok.report.overall_result}`);
        }
        // Negative: tamper a sidecar object ⇒ located per_object_hash FAIL.
        const tamperedKey = base.sidecar[0]!.key;
        const mutated = clone(base.sidecar[0]!.cce);
        mutated.changes![0]!.after = { id: 0, amount: '424242.00' };
        writeFileSync(resolve(objectsDir, tamperedKey), JSON.stringify(mutated));
        const bad = runExportVerification(base.exportPackage, { objectsDir, trust: loadTrustRoots(base.trustFile), reportId: REPORT_ID, generatedAt: GEN_AT });
        if (bad.report.overall_result !== 'FAIL') return fail(`tampered export did not FAIL`);
        const per = expectFailLocated(bad.report, 'per_object_hash', base.sidecar[0]!.cce.envelope_id);
        if (!per.passed) return per;
        return pass(`valid export self-verifies; tampered export FAILs located on per_object_hash`);
      });
    },
  },
];
