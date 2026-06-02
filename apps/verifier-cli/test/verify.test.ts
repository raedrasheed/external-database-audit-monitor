// verifier-cli export-mode tests (EDAM-T146). Builds a REAL, fully-anchored
// export (genesis-rooted two-segment chain) with @edam/export + @edam/evidence +
// @edam/anchor-proof + node:crypto, materializes a sidecar object bundle + an
// out-of-band trust file on disk, then exercises the CLI orchestration:
//   - valid export => overall PASS + envelope PASS + exit 0;
//   - tampered sidecar object => located per_object_hash FAIL + exit 1;
//   - tampered package body => export-signature (package_hash) FAIL + exit 1;
//   - untrusted export key / wrong HSM key => fail-closed;
//   - argument parsing (mandatory --trust), exit-code policy, JSON output.
import { describe, it, expect, afterAll } from 'vitest';
import { generateKeyPairSync, sign as edSign, createHash, type KeyObject } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildCce, type Cce, type NormalizedTransaction } from '@edam/cce-model';
import {
  buildSegmentManifest, deriveSegmentHead, buildAnchorPayload, anchorPayloadHash, anchorSigningMessage,
  type SegmentManifest, type SegmentManifestInput, type PreviousSegmentRef,
} from '@edam/evidence';
import { tstSigningBytes, type TstInfo } from '@edam/anchor-proof';
import { buildEvidenceExportPackage, exportSigningMessage, type BuildExportInput, type ExportSigner, type ExportSegmentInput, type ExportObjectRef } from '@edam/export';
import { validateVerificationReport } from '@edam/contracts';

import { runExportVerification } from '../src/run-export.js';
import { loadTrustRoots, type TrustFile } from '../src/trust.js';
import { exitCodeFor, EXIT_PASS, EXIT_INTEGRITY_FAIL } from '../src/exit.js';
import { renderJson, renderHuman } from '../src/render.js';
import { parseArgs, CliUsageError } from '../src/args.js';

const UUID = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const DB = 'kafel-dev-mysql';
const HEALTHY = { state: 'HEALTHY' as const, source_config: { binlog_format: 'ROW', binlog_row_image: 'FULL', gtid_mode: 'ON', replica_identity: null, log_bin: 'ON', config_snapshot_id: 'cfg' } };
const spki = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function tx(seq: number): NormalizedTransaction {
  const id = `${UUID}:${seq}`;
  return {
    source: { db_id: DB, engine: 'mysql', server_uuid: UUID, schema: 'kafel' },
    transaction: { tx_id: id, commit_ts: '2026-06-01T10:00:00.000Z', ingest_ts: '2026-06-01T10:00:00.000Z' },
    offset: { gtid: id, binlog_file: 'mysql-bin.000042', binlog_pos: 1000 + seq, lsn: null, scn: null, resume_token: null },
    fidelity: HEALTHY,
    completeness: { consumed_offset_key: id, gap_detected: false, snapshot_phase: 'streaming' },
    actor: { attribution_confidence: 'unattributed' },
    changes: [{ operation: 'UPDATE', object: { schema: 'kafel', name: 'donations', primary_key: { id: seq } }, before: { id: seq, amount: '1.00' }, after: { id: seq, amount: '2.00' } }],
  };
}

function wormKey(segId: string, seq: number): string {
  return `${DB}/${segId}/${String(seq).padStart(6, '0')}.cce.json`;
}

function manifestFor(sequence: number, segId: string, objects: Cce[], previousSegment: PreviousSegmentRef | null): SegmentManifest {
  const first = objects[0]!;
  const last = objects[objects.length - 1]!;
  const input: SegmentManifestInput = {
    db_id: DB, engine: 'mysql', segment_id: segId, segment_sequence: sequence, opened_at: '2026-06-01T10:00:00.000Z',
    event_count: objects.length, first_envelope_id: first.envelope_id, last_envelope_id: last.envelope_id,
    first_row_hash: first.evidence.row_hash, last_row_hash: last.evidence.row_hash,
    object_list: objects.map((c, seq) => ({ seq, object_id: c.envelope_id, worm_object_key: wormKey(segId, seq), object_type: 'cce' as const })),
    object_hash_list: objects.map((c, seq) => ({ seq, event_hash: c.evidence.event_hash, row_hash: c.evidence.row_hash })),
    // Bind offset range to the objects' consumed_offset_key (so §10.6 corroborates).
    source_offset_range: { first_offset_key: first.completeness.consumed_offset_key, last_offset_key: last.completeness.consumed_offset_key },
    fidelity_summary: { all_healthy: true, degraded_count: 0, compromised_count: 0, reasons: [] },
    completeness_summary: { gap_detected: false, expected_continuous: true, notes: [] },
    objects,
  };
  return buildSegmentManifest(input, { sealedAt: '2026-06-01T10:00:01.000Z', previousSegment });
}

/** A dev export signer (Ed25519 over the domain-tagged export message). */
function devExportSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = spki(publicKey);
  const signing_key_id = 'edam-dev-export-' + createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
  const signer: ExportSigner = {
    signExport: (h) => ({ algorithm: 'ed25519', signing_key_id, signature: edSign(null, Buffer.from(exportSigningMessage(h)), privateKey).toString('base64') }),
  };
  return { signer, signing_key_id, public_key: pub };
}

/** A full, verifiable rfc3161 dev token committing to payloadHash, signed by the TSA key. */
function rfc3161Token(payloadHash: string, tsaCertRef: string, tsaPriv: KeyObject): string {
  const tst: TstInfo = {
    version: 1, policy: 'dev-policy',
    message_imprint: { hash_algorithm: 'sha-256', hashed_message: payloadHash },
    serial_number: '1', gen_time: '2026-06-01T10:05:02.000Z', tsa_cert_ref: tsaCertRef,
  };
  const signature = edSign(null, Buffer.from(tstSigningBytes(tst)), tsaPriv).toString('base64');
  return Buffer.from(JSON.stringify({ signature_algorithm: 'ed25519', signature, tst_info: tst })).toString('base64');
}

/** A full anchor-record-1.0: HSM Ed25519 over the head + an rfc3161 token over the payload hash. */
function anchorRecordFor(manifest: SegmentManifest, hsmPriv: KeyObject, hsmKeyId: string, tsaPriv: KeyObject, tsaCertRef: string): string {
  const head = deriveSegmentHead(manifest);
  const payload = buildAnchorPayload(head, { headCount: 1, signedAt: '2026-06-01T10:05:01.000Z' });
  const hsmSig = edSign(null, Buffer.from(anchorSigningMessage(payload)), hsmPriv).toString('base64');
  const token = rfc3161Token(anchorPayloadHash(payload), tsaCertRef, tsaPriv);
  return JSON.stringify({
    anchor_version: 'anchor-record-1.0', anchor_id: UUID, db_id: payload.db_id,
    head: { segment_id: payload.segment_id, segment_sequence: payload.segment_sequence, segment_hash: payload.segment_hash, last_row_hash: payload.last_row_hash, head_count: payload.head_count, signed_at: payload.signed_at },
    hsm_signature: { algorithm: 'ed25519', signing_key_id: hsmKeyId, signature: hsmSig },
    anchor_provider: { type: 'rfc3161', rfc3161_token: token, tsa_cert_ref: tsaCertRef },
    created_at: '2026-06-01T10:05:03.000Z',
  });
}

interface Scenario {
  pkg: ReturnType<typeof buildEvidenceExportPackage>;
  objectsDir: string;
  trustFile: TrustFile;
  exportKeyId: string;
  hsmPub: string;
  tsaPub: string;
}

/** Build a valid genesis-rooted two-segment export + sidecar bundle + trust file. */
function buildScenario(): Scenario {
  const hsm = generateKeyPairSync('ed25519');
  const tsa = generateKeyPairSync('ed25519');
  const hsmKeyId = 'edam-dev-hsm-ed25519-1';
  const tsaCertRef = 'edam-dev-tsa-1';

  const seg0Id = 'seg-000000';
  const seg1Id = 'seg-000001';
  const c0 = buildCce(tx(0));
  const c1 = buildCce(tx(1), { prevRowHash: c0.evidence.row_hash });
  const seg0 = manifestFor(0, seg0Id, [c0, c1], null);
  const c2 = buildCce(tx(2), { prevRowHash: c1.evidence.row_hash });
  const seg1 = manifestFor(1, seg1Id, [c2], { segment_id: seg0.segment_id, segment_sequence: 0, segment_hash: deriveSegmentHead(seg0).segment_hash });

  const segIn = (m: SegmentManifest, objs: Cce[]): ExportSegmentInput => ({
    segment_sequence: m.segment_sequence,
    object_ids: objs.map((c) => c.envelope_id),
    serialized_manifest: JSON.stringify(m),
    serialized_anchor_record: anchorRecordFor(m, hsm.privateKey, hsmKeyId, tsa.privateKey, tsaCertRef),
  });
  const ref = (c: Cce, segId: string, seq: number): ExportObjectRef => ({ object_id: c.envelope_id, object_type: 'cce', worm_object_key: wormKey(segId, seq), event_hash: c.evidence.event_hash });

  const { signer, signing_key_id, public_key: exportPub } = devExportSigner();
  const input: BuildExportInput = {
    package_id: '11111111-2222-4333-8444-555555555555', db_id: DB, purpose: 'legal_audit',
    created_at: '2026-06-01T12:00:00.000Z', created_by: 'edam-export',
    selected_object_refs: [ref(c2, seg1Id, 0)],
    segments: [segIn(seg0, [c0, c1]), segIn(seg1, [c2])],
    public_keys: [{ key_id: hsmKeyId, algorithm: 'ed25519', public_key: spki(hsm.publicKey), revoked_at: null }],
    timestamp_certificates: [JSON.stringify({ tsa_cert_ref: tsaCertRef, algorithm: 'ed25519', public_key: spki(tsa.publicKey) })],
    verification_instructions: { spec_id: 'worm-v1', spec_hash: 'sha256:' + 'a'.repeat(64) },
    chain_of_custody_log: [{ custody_event_id: 'ce-1', action: 'export', reviewer_identity: 'auditor', reason: 'case-123', occurred_at: '2026-06-01T12:00:00.000Z' }],
    signer,
  };
  const pkg = buildEvidenceExportPackage(input);

  // Materialize the sidecar object bundle on disk (keyed by worm_object_key).
  const objectsDir = mkdtempSync(join(tmpdir(), 'edam-objs-'));
  tmpDirs.push(objectsDir);
  for (const [c, segId, seq] of [[c0, seg0Id, 0], [c1, seg0Id, 1], [c2, seg1Id, 0]] as const) {
    const p = resolve(objectsDir, wormKey(segId, seq));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(c));
  }

  const trustFile: TrustFile = {
    signing_keys: [{ key_id: hsmKeyId, algorithm: 'ed25519', public_key: spki(hsm.publicKey), revoked_at: null }],
    anchor_certs: [{ ref: tsaCertRef, algorithm: 'ed25519', public_key: spki(tsa.publicKey) }],
    export_keys: [{ key_id: signing_key_id, algorithm: 'ed25519', public_key: exportPub }],
  };
  return { pkg, objectsDir, trustFile, exportKeyId: signing_key_id, hsmPub: spki(hsm.publicKey), tsaPub: spki(tsa.publicKey) };
}

describe('verifier-cli export mode (T146)', () => {
  it('1. valid export verifies: §10 overall PASS, envelope PASS, exit 0', () => {
    const s = buildScenario();
    const result = runExportVerification(s.pkg, { objectsDir: s.objectsDir, trust: loadTrustRoots(s.trustFile), reportId: '99999999-2222-4333-8444-555555555555', generatedAt: '2026-06-02T00:00:00.000Z' });
    expect(result.export_signature.result).toBe('PASS');
    expect(result.report.overall_result, JSON.stringify(result.report.checks)).toBe('PASS');
    for (const c of result.report.checks) {
      if (c.check === 'projection_consistency') expect(c.result).toBe('SKIPPED');
      else expect(c.result, c.check).toBe('PASS');
    }
    expect(exitCodeFor(result)).toBe(EXIT_PASS);
  });

  it('2. tampered sidecar object => per_object_hash FAIL with located id, exit 1', () => {
    const s = buildScenario();
    // Mutate one object's content on disk (envelope_id seq 0 of segment 0).
    const tamperedKey = wormKey('seg-000000', 0);
    const c0 = buildCce(tx(0));
    const mutated = { ...c0, changes: [{ ...c0.changes![0], after: { id: 0, amount: '999.00' } }] };
    writeFileSync(resolve(s.objectsDir, tamperedKey), JSON.stringify(mutated));

    const result = runExportVerification(s.pkg, { objectsDir: s.objectsDir, trust: loadTrustRoots(s.trustFile) });
    const perObj = result.report.checks.find((c) => c.check === 'per_object_hash')!;
    expect(perObj.result).toBe('FAIL');
    expect((perObj.offending_ids ?? []).length).toBeGreaterThan(0);
    expect(result.report.overall_result).toBe('FAIL');
    expect(result.export_signature.result).toBe('PASS'); // envelope intact; only the sidecar content drifted
    expect(exitCodeFor(result)).toBe(EXIT_INTEGRITY_FAIL);
  });

  it('3. tampered package body => export-signature (package_hash) FAIL, exit 1', () => {
    const s = buildScenario();
    const tampered = { ...s.pkg, created_by: 'attacker' }; // body changed; export_signature.package_hash now stale
    const result = runExportVerification(tampered, { objectsDir: s.objectsDir, trust: loadTrustRoots(s.trustFile) });
    expect(result.export_signature.result).toBe('FAIL');
    expect(result.export_signature.details).toMatch(/does not recompute/);
    expect(exitCodeFor(result)).toBe(EXIT_INTEGRITY_FAIL);
  });

  it('4. export key absent from trust => envelope FAIL (untrusted), exit 1', () => {
    const s = buildScenario();
    const trust = loadTrustRoots({ ...s.trustFile, export_keys: [] });
    const result = runExportVerification(s.pkg, { objectsDir: s.objectsDir, trust });
    expect(result.export_signature.result).toBe('FAIL');
    expect(result.export_signature.details).toMatch(/untrusted|unknown/);
    expect(exitCodeFor(result)).toBe(EXIT_INTEGRITY_FAIL);
  });

  it('5. wrong HSM public key in trust => hsm_signature FAIL, exit 1', () => {
    const s = buildScenario();
    const otherPub = spki(generateKeyPairSync('ed25519').publicKey);
    const trust = loadTrustRoots({ ...s.trustFile, signing_keys: [{ key_id: 'edam-dev-hsm-ed25519-1', algorithm: 'ed25519', public_key: otherPub, revoked_at: null }] });
    const result = runExportVerification(s.pkg, { objectsDir: s.objectsDir, trust });
    const hsm = result.report.checks.find((c) => c.check === 'hsm_signature')!;
    expect(hsm.result).toBe('FAIL');
    expect(result.report.overall_result).toBe('FAIL');
    expect(exitCodeFor(result)).toBe(EXIT_INTEGRITY_FAIL);
  });

  it('6. JSON output embeds a schema-valid verification-report-1.0', () => {
    const s = buildScenario();
    const result = runExportVerification(s.pkg, { objectsDir: s.objectsDir, trust: loadTrustRoots(s.trustFile) });
    const parsed = JSON.parse(renderJson(result));
    expect(validateVerificationReport(parsed.report).valid).toBe(true);
    expect(parsed.export_signature.result).toBe('PASS');
  });

  it('7. human output names the verdict and the advisory projection check', () => {
    const s = buildScenario();
    const out = renderHuman(runExportVerification(s.pkg, { objectsDir: s.objectsDir, trust: loadTrustRoots(s.trustFile) }));
    expect(out).toContain('OVERALL: PASS');
    expect(out).toContain('projection_consistency (advisory)');
  });

  it('8. unreadable sidecar object (incomplete bundle) is a usage error (not PASS)', () => {
    const s = buildScenario();
    const emptyDir = mkdtempSync(join(tmpdir(), 'edam-empty-'));
    tmpDirs.push(emptyDir);
    expect(() => runExportVerification(s.pkg, { objectsDir: emptyDir, trust: loadTrustRoots(s.trustFile) })).toThrow(/cannot read sidecar object/);
  });
});

describe('verifier-cli argument parsing (T146)', () => {
  it('requires the verify command', () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
    expect(() => parseArgs(['bogus'])).toThrow(CliUsageError);
  });

  it('requires --trust (mandatory for real verification)', () => {
    expect(() => parseArgs(['verify', '--export', 'p.json', '--objects', 'o'])).toThrow(/--trust/);
  });

  it('export mode requires --export and --objects', () => {
    expect(() => parseArgs(['verify', '--trust', 't.json'])).toThrow(/--export/);
    expect(() => parseArgs(['verify', '--export', 'p.json', '--trust', 't.json'])).toThrow(/--objects/);
  });

  it('parses a valid export invocation', () => {
    const a = parseArgs(['verify', '--export', 'p.json', '--objects', './objs', '--trust', 't.json', '--json']);
    expect(a).toMatchObject({ command: 'verify', mode: 'export', exportPath: 'p.json', objectsDir: './objs', trustPath: 't.json', json: true });
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['verify', '--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['verify', '--export'])).toThrow(/missing value/);
  });
});

describe('verifier-cli trust loading (T146)', () => {
  it('rejects a malformed / empty trust file (fail-closed)', () => {
    expect(() => loadTrustRoots(null)).toThrow(/must be a JSON object/);
    expect(() => loadTrustRoots({})).toThrow(/empty/);
    expect(() => loadTrustRoots({ signing_keys: [{ key_id: 'x' }] })).toThrow(/signing_keys/);
  });
});
