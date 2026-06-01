# EDAM Sprint-2 Implementation Plan
### Evidence + WORM + Anchoring (implements the frozen WORM Evidence Segment & Anchoring Specification v1)

> **Document class:** Implementation plan only — **no code, no implementation, no schema/contract changes** in this document.
> **Baseline:** Sprint-1 complete and signed off (E1–E8, 55/55); **D-LIVE-1 CLOSED** via CCE-AMD-001 Rev 4 (`cce-1.1` snapshot capture, live-verified).
> **Authoritative inputs (frozen, unmodified):** `docs/EDAM-WORM-Evidence-Anchoring-Spec.md` (§1–§20), `docs/CCE-v1-Specification.md`, `docs/EDAM-Companion-Contracts.md` (incl. PART H Snapshot Epoch Manifest), `docs/EDAM-v2-Architecture.md`, `docs/EDAM-Phase0-Engineering-Blueprint.md`.
> **Date:** 2026-06-01.

This sprint **implements** the WORM spec; it does not redesign it. Every artifact, hash construction, lifecycle state, and verification step below traces to a spec section. Where the spec already froze JSON Schemas (§16.1–§16.4), Sprint 2 **vendors them verbatim** under the same discipline E1 used for the CCE/companion schemas (provenance-tested against the spec doc).

---

## 0. Constraints (binding for the whole sprint)

| # | Constraint | How honored |
|---|---|---|
| C-1 | **No Dashboard.** | No UI work; verifier is a CLI + library. |
| C-2 | **No Risk Engine.** | No rule evaluation/alerting beyond evidence-integrity alarms required by WORM §14. |
| C-3 | **No Projection DB** unless strictly required as **evidence metadata.** | Only a minimal, **rebuildable evidence-index** (segment/head/anchor catalog) is built — used by the writer, exporter, and verifier to *locate* objects. It stores **no authoritative state** (WORM wins, §11/§19.1) and indexes only hashes/keys/ids, never CCE business rows. If the writer/exporter can operate from WORM listing alone, the index is skipped. |
| C-4 | **No reversal.** | ReversalDirective/ExecutionResult/CES untouched. |
| C-5 | **Do not change CCE semantics.** | CCE `cce-1.0`/`cce-1.1` schemas, canonical serialization, hashing, ordering, and `evidence` fields are used as-is; no new CCE fields. |
| C-6 | **Do not weaken Sprint-1 CI gates.** | All Sprint-1 jobs remain; Sprint-2 gates are **added**, never relaxed. |
| C-7 | **Preserve all Sprint-1 invariants.** | INV-1 (no monitored-DB write), INV-2 (no fabrication), INV-3 (append-only/WORM), INV-4 (single canonical impl) hold; Sprint 2 adds evidence-domain invariants (§12). |

---

## 1. Sprint Goal

**Make EDAM's evidence independently provable.** Take the validated CCE stream + snapshot-epoch manifests produced by Sprint 1 and: group them into **immutable WORM segments**, **chain** them (object-level + segment-level), **seal** them with deterministic manifests, **sign** chain heads (dev signer behind an HSM-compatible interface), **anchor** heads to an external time source (RFC-3161 or transparency-log provider abstraction), and ship an **independent verifier** that re-proves the entire chain using only WORM read access, public keys, anchor certificates, and published logic — **no EDAM software, secret, or online API** (defeats blocker C1, WORM §10/§19).

**Definition of done:** an external party, given only an Evidence Export Package + the published verifier spec, runs the verifier and gets a PASS — and any tamper (object byte-flip, missing object/segment, broken chain, forged signature, forged token) yields a deterministic, located FAIL (WV-1…WV-14).

**Out of scope (deferred):** Dashboard, Risk Engine, full business Projection DB, reversal/CES execution, geo-replication hardening (interface stubbed, single-region dev), crypto-shred field-key tooling (interface reserved, not built).

---

## 2. Sprint 2A — Evidence Segment Store

**Implements:** WORM §3 (object model), §4 (storage requirements), §5 (lifecycle: OPEN→SEALING), §6 (manifest format, append side).

**Purpose:** an append-only writer (Domain B identity) that receives sealed evidence objects (CCE `cce-1.0`/`cce-1.1`, Snapshot Epoch Manifest companion, and — interface-only — ExecutionResult/DB-Audit Event) and persists them, immutably and in global order, into WORM, grouping them into **OPEN** segments per `db_id`.

**Scope:**
- **WORM store abstraction** (`infra/worm`): a narrow interface — `putImmutable(key, bytes)`, `get(key)`, `list(prefix)`, `headObjectLock(key)` — with **three distinct identities** (append-only writer, retention/hold admin, reader/exporter; W-8). Dev backend: **MinIO with S3 Object Lock in compliance mode** (W-1/W-2) + versioning (W-4); legal-hold flag (W-3). No `delete`/`overwrite` in the writer identity's policy (INV-3, §19.2).
- **Evidence object writer** (`services/evidence-writer`): consumes the Sprint-1 emit stream (the same CCEs that pass `validateCceFull`), validates each against its contract before append (no unvalidated bytes in WORM), assigns `worm_object_key`, appends in **global order** (CCE §4.2 + the Rev-4 snapshot tie-break), and records the object in the current OPEN segment.
- **Segment opener/accumulator:** opens a segment per `db_id` (sequence contiguous from 0), bounded by `event_count` cap **or** time cap (§5 triggers), tracking `first/last_envelope_id`, `first/last_row_hash`, `object_list`, `object_hash_list`, `source_offset_range`, `fidelity_summary`, `completeness_summary` (§6).
- **CCE back-reference:** populate the CCE `evidence.worm_object_key` and `evidence.segment_id` (existing CCE fields — no schema change) as objects are appended. (`anchor_ref` is filled in 2D.)

**Key properties:** writer holds an **append-only** WORM identity only (no delete/overwrite/retention/key access). Objects are validated pre-append. Ordering is the frozen global order (reusing `@edam/cce-model` `orderCces`). Snapshot epoch manifests are appended as companion evidence objects in the same chain.

**Deliverables:** `infra/worm` (interface + MinIO dev adapter), `services/evidence-writer` (open/append, segment accumulator), evidence-index seed (C-3 minimal). Unit tests with an in-memory WORM fake.

---

## 3. Sprint 2B — Row Hash Chain + Segment Sealing

**Implements:** WORM §5 (SEALING→SEALED), §6 (`manifest_hash`), §7 (chain head: object chain, segment hash, cross-segment link, genesis).

**Purpose:** turn an OPEN segment into a **SEALED**, hashed, chain-linked manifest that an auditor can verify without reading the application DB.

**Scope:**
- **Object chain verification (intra-segment):** re-verify, before sealing, that each object's `row_hash == SHA256(prev_row_hash ‖ event_hash)` and that `prev_row_hash` equals the previous object's `row_hash` in global order (§7.4.1). Reuse `@edam/canonical` `rowHash`/`GENESIS_ROW_HASH` and `verifyCce` — **no second hasher** (§19.3, INV-4).
- **Deterministic manifest:** assemble the §6 manifest core and compute `manifest_hash` = SHA-256 over its canonical serialization (CCE §12.7 rules, via `@edam/canonical` `serializeCanonical`). Must be byte-reproducible cross-target (WV-1).
- **Segment hash + cross-segment link:** `segment_hash = SHA256(manifest_hash ‖ last_row_hash ‖ previous_segment_hash)` (§7.2); genesis `previous_segment_hash = sha256:00…00` (§7.3); for sequence *n*>0, `previous_segment.segment_hash == segment_hash(n−1)` and `first_row_hash(n)` chains from `last_row_hash(n−1)` (§7.4.2, the object chain does **not** reset — §19.7).
- **Seal transition:** write the manifest object to WORM (immutable), transition OPEN→SEALING→SEALED; emit the **chain head** `{db_id, segment_id, segment_sequence, segment_hash, last_row_hash}` (§7.5) for the signing/anchoring stage. On any intra-segment integrity failure at seal time → `VERIFICATION_FAILED` (terminal, CRITICAL alarm; §5, §19.8).

**Shared package:** introduce `packages/evidence` holding the **pure** segment/manifest/chain-head types + the canonical manifest/segment hashing helpers, so the **writer and the independent verifier compute identical bytes** (this is the determinism keystone for evidence, mirroring `@edam/canonical`'s role for CCEs). `packages/evidence` depends only on `@edam/canonical` and the vendored evidence schemas.

**Deliverables:** `packages/evidence` (manifest/segment-hash/chain-head, sealing logic), seal path in `services/evidence-writer`, vendored `evidence-segment-manifest-1.0` schema + validator in `@edam/contracts`. Unit + determinism tests.

---

## 4. Sprint 2C — Signing Layer (dev signer first; HSM-compatible interface)

**Implements:** WORM §8 (HSM signing model), §16.2 (anchor record signature portion).

**Purpose:** sign the **chain head / anchor payload** with a key the Audit Core (Domain B) **cannot extract**, producing offline-verifiable signatures — starting with a dev signer behind an interface that an HSM (PKCS#11) implementation can drop into later.

**Scope:**
- **`Signer` interface** (`packages/signing`): `sign(payload: bytes): { algorithm, signing_key_id, signature }` and a **public** `getPublicKey(signing_key_id): { algorithm, public_key, revoked_at? }`. The interface **never** exposes private material (§8 non-exportable). Signs the canonical **anchor payload** `canonical({db_id, segment_id, segment_sequence, segment_hash, last_row_hash, head_count, signed_at})` (§8) — a hash structure, never plaintext (§19.4).
- **Dev signer (default):** in-process **Ed25519** (or ECDSA P-384) key, generated at deploy, **never committed**, marked dev-only. Public key published to a **key registry** (a published file + a WORM-stored key-registration record carrying `signing_key_id`, `algorithm`, `public_key`, `created_at`, optional `revoked_at`).
- **HSM-compatible adapter (interface only, not built):** a documented `Pkcs11Signer` slot implementing the same `Signer` interface (key in HSM, non-exportable). Selectable by config; not implemented this sprint.
- **Key lifecycle hooks:** `signing_key_id` recorded on every anchor; rotation/revocation **interfaces** defined (dual-control + WORM-logged per §8, §19.9) — enforcement of dual-control is a custodian-domain control, stubbed for dev.

**Security:** dev key lives only in the running process / dev secret store, never in git, never logged (extends Sprint-1 secret-hygiene). B requests signatures; the key is conceptually Domain C — the interface boundary makes the future HSM swap a no-op for callers.

**Deliverables:** `packages/signing` (`Signer`, `DevEd25519Signer`, key registry, `Pkcs11Signer` stub), public-key publication, signing of the anchor payload. Unit tests + verify-with-public-key tests.

---

## 5. Sprint 2D — External Anchoring (RFC-3161 / transparency-log provider abstraction)

**Implements:** WORM §5 (ANCHOR_PENDING→ANCHORED), §9 (anchor providers), §16.2 (anchor record).

**Purpose:** prove **when** a signed head existed using a source EDAM does not control, behind a pluggable provider abstraction; a head is **ANCHORED only after a verified external token** (§19.5).

**Scope:**
- **`AnchorProvider` interface** (`services/anchoring`): `anchor(signedHead): AnchorToken` and `verifyToken(token, signedHead): boolean`, with `provider_type ∈ {rfc3161, transparency_log, dual_custodian}` (the frozen enum — no new types this sprint). The provider receives only the **hash of the signed anchor payload** (§9 common rules, §19.4).
- **Providers implemented for dev:**
  - **RFC-3161 abstraction** + a **dev TSA** (local timestamp authority using a dev cert) producing/validating an RFC-3161 `TimeStampToken` (§9.1); **and/or**
  - **Transparency-log abstraction** + a **dev append-only Merkle log** producing an inclusion proof + signed tree head (§9.2).
  - (At least one is fully wired end-to-end for live validation; the other is interface-complete. `dual_custodian` is interface-only this sprint.)
- **Anchor record builder:** assemble the §16.2 `anchor-record-1.0` (head, HSM signature, provider type, token/proof, `signing_key_id`, `anchored_at`), write it immutably to WORM, transition SEALED→ANCHOR_PENDING→ANCHORED, and populate the covered CCEs' `evidence.anchor_ref` (`head_hash`, `hsm_signature`, `tsa_token`, `anchor_provider` — existing CCE fields, no schema change).
- **Failure / outage / cadence (no fabrication, §19.11/§19.12):** on provider failure → stay **ANCHOR_PENDING**, exponential-backoff retry (idempotent re-request over the same hash), escalating alarm; **never** synthesize a token. Anchoring cadence bounded by **N events or T minutes** (§9 common rules) — exceeding the max un-anchored window alarms.

**Deliverables:** `services/anchoring` (`AnchorProvider`, dev RFC-3161 and/or dev transparency-log, anchor-record builder, retry/backoff/cadence), vendored `anchor-record-1.0` schema + validator. Unit tests incl. outage (WV-13).

---

## 6. Sprint 2E — Independent Verifier

**Implements:** WORM §10 (verification procedure), §12 (export package), §16.3 (verification report), §16.4 (export package), §18 (WV-1…WV-14).

**Purpose:** an **offline, dependency-isolated** verifier that re-proves the chain using **only**: (1) WORM read access, (2) published public signing keys, (3) TSA/anchor public certificates, (4) the published verifier logic. **No** EDAM/CES software, secret, or online API (§10, §19.7) — this is the sprint's most important guarantee.

**Scope:**
- **`packages/verifier`** (pure) + **`apps/verifier-cli`**: implements the §10.1 deterministic procedure end-to-end:
  1. per-object `event_hash` recompute (per object's own contract + CCE §12.7);
  2. object-chain check (`row_hash` linkage);
  3. manifest recompute (`manifest_hash`) + field cross-checks;
  4. cross-segment continuity (`segment_hash`, `previous_segment_hash`, boundary chaining);
  5. no-missing-segment (sequence contiguous from 0);
  6. no-missing-event (offset/GTID continuity, corroborated by CCE `completeness`);
  7. HSM signature verify against published public key (honor `revoked_at`);
  8. anchor-token verify (RFC-3161 token / Merkle inclusion proof) against provider cert/key;
  9. (optional) evidence-index/projection consistency — drift is a *projection finding*, never an evidence failure (§10.2/§11).
- **Inputs:** either a live WORM reader (read-only identity) **or** an **Evidence Export Package** (§16.4) for fully-offline verification.
- **Output:** a signed-able **`verification-report-1.0`** (§16.3) with per-check PASS/FAIL + offending ids/hashes.
- **Dependency isolation (enforced):** `packages/verifier` may import **only** `@edam/canonical` (the shared serializer/hasher) + the vendored evidence/CCE **schemas** + public-key/cert parsing. It MUST NOT import `services/evidence-writer`, `packages/signing` private paths, `services/anchoring` private providers, or any DB client. A CI boundary gate enforces this (the verifier proves it needs nothing from EDAM beyond public inputs).
- **Export package builder** (`services/evidence-writer` exporter or a small `tools/evidence-export`): assemble §12.1 contents (selected objects, covering manifests, anchor records, public keys, anchor certs, pinned verifier-spec hash, custody log, export signature); self-verifying (WV-14).

**Deliverables:** `packages/verifier`, `apps/verifier-cli`, export builder, vendored `verification-report-1.0` + `evidence-export-package-1.0` schemas + validators. The full WV-1…WV-14 suite (§13).

---

## 7. Required Services / Packages

| Component | Type | Sprint | Role | Depends on |
|---|---|---|---|---|
| `infra/worm` | infra lib + dev adapter | 2A | WORM interface (put-immutable/get/list/lock) + MinIO Object-Lock dev backend; 3 identities | — |
| `services/evidence-writer` | service | 2A/2B | Append-only writer; segment open/append/seal; chain head emit; CCE `evidence` back-refs; exporter | `@edam/contracts`, `@edam/cce-model`, `@edam/canonical`, `packages/evidence`, `infra/worm` |
| `packages/evidence` | package (pure) | 2B | Segment/manifest/chain-head types + canonical manifest/segment hashing (shared by writer **and** verifier) | `@edam/canonical`, vendored evidence schemas |
| `packages/signing` | package | 2C | `Signer` interface; `DevEd25519Signer`; key registry; `Pkcs11Signer` stub | `@edam/canonical` |
| `services/anchoring` | service | 2D | `AnchorProvider` abstraction; dev RFC-3161 / transparency-log; anchor-record builder; retry/cadence | `@edam/canonical`, `packages/signing` |
| `packages/verifier` | package (pure, isolated) | 2E | §10 procedure; offline; **public inputs only** | `@edam/canonical`, vendored schemas **only** |
| `apps/verifier-cli` | app/CLI | 2E | Run the verifier against WORM or an export package | `packages/verifier` |
| `tools/evidence-export` | tool (or writer subcmd) | 2E | Build a self-verifying export package | `services/evidence-writer` |
| `@edam/contracts` (extend) | package | 2A–2E | Vendor WORM §16 schemas verbatim + validators | existing |
| evidence-index (minimal) | metadata store | 2A | **Optional**, evidence-metadata only (segment/head/anchor catalog), rebuildable from WORM | `infra/worm` |

No changes to `@edam/canonical`'s public hashing/serialization behavior (INV-4); evidence reuses it verbatim.

---

## 8. Repository Layout Changes (proposed)

```
packages/
  canonical/                 (unchanged — reused)
  contracts/
    src/schemas/
      evidence-segment-manifest-1.0.schema.json   (NEW, vendored verbatim from WORM §16.1)
      anchor-record-1.0.schema.json                (NEW, §16.2)
      verification-report-1.0.schema.json          (NEW, §16.3)
      evidence-export-package-1.0.schema.json      (NEW, §16.4)
    src/{validator,index}.ts                        (extend: register + validate helpers)
  cce-model/                 (unchanged — orderCces/rowHash reused)
  evidence/                  (NEW package: manifest/segment-hash/chain-head, sealing — pure)
  signing/                   (NEW package: Signer, DevEd25519Signer, key registry, Pkcs11 stub)
  verifier/                  (NEW package: §10 procedure — public-inputs-only, dependency-isolated)
services/
  evidence-writer/           (NEW: append-only writer, segment open/append/seal, exporter)
  anchoring/                 (NEW: AnchorProvider, dev RFC-3161/transparency-log, anchor-record)
infra/
  worm/                      (NEW: WORM interface + MinIO Object-Lock dev adapter; 3 identities)
  dlq/                       (unchanged — failure isolation reused for evidence-write failures)
apps/
  verifier-cli/              (NEW: offline verifier CLI)
tools/
  evidence-export/           (NEW or evidence-writer subcommand)
conformance/
  evidence/                  (NEW: WV-1..WV-14 cases + golden manifests/anchors fixtures)
  scripts/
    evidence-determinism-rig.ts   (NEW: manifest_hash/segment_hash cross-target)
    verifier-isolation-proof.ts   (NEW: assert verifier deps are public-only)
deploy/compose/
  docker-compose.yml         (extend: minio (Object Lock), dev-signer/softhsm, dev-tsa/transparency)
  minio/, tsa/               (NEW dev configs)
docs/
  EDAM-Sprint2-Backlog.md    (companion backlog — task breakdown; planning)
```

All new workspaces follow existing conventions (npm workspaces, TypeScript ESM/NodeNext, tsx, vitest, eslint flat config). No change to root `tsconfig`/lint beyond adding the new paths.

---

## 9. Data Model

All shapes are **already frozen** in WORM §6/§16; Sprint 2 vendors them verbatim and populates them. No new CCE fields.

| Record | Schema id (vendored) | Key fields | Stored |
|---|---|---|---|
| Evidence object | (existing) `cce-1.0`/`cce-1.1`, `snapshot-epoch-manifest-1.0`, (iface) results/audit | `evidence.{event_hash, prev_row_hash, row_hash, worm_object_key, segment_id, anchor_ref}` | WORM |
| Segment manifest | `evidence-segment-manifest-1.0` (§16.1) | `segment_id, db_id, segment_sequence, first/last_envelope_id, first/last_row_hash, object_list, object_hash_list, source_offset_range, fidelity_summary, completeness_summary, previous_segment, manifest_hash` | WORM |
| Chain head | derived `{db_id, segment_id, segment_sequence, segment_hash, last_row_hash}` | `segment_hash = H(manifest_hash ‖ last_row_hash ‖ previous_segment_hash)` | WORM + evidence-index |
| Anchor record | `anchor-record-1.0` (§16.2) | head, `hsm_signature{algorithm,signing_key_id,signature}`, `provider_type`, token/proof, `anchored_at` | WORM |
| Key registration | small record | `signing_key_id, algorithm, public_key, created_at, revoked_at?` | WORM + published key file |
| Verification report | `verification-report-1.0` (§16.3) | per-check PASS/FAIL + offending ids | WORM (EDAM runs) / auditor-held |
| Export package | `evidence-export-package-1.0` (§16.4) | objects, manifests, anchors, public keys, certs, custody log, export_signature | WORM + delivered bundle |

**CCE back-references:** `evidence.worm_object_key` and `evidence.segment_id` set at append (2A); `evidence.anchor_ref` set at anchor (2D). These are **existing** CCE evidence fields (CCE §8 / schema) — populating them is not a schema change.

**Hash relationships (frozen, §7):** `event_hash` (object) → `row_hash` (object chain) → `manifest_hash` (segment) → `segment_hash` (segment chain) → anchor payload → HSM signature → external token. Genesis `previous_segment_hash = sha256:00…00`.

---

## 10. APIs (internal interfaces; no external HTTP/dashboard)

```
// infra/worm
WormStore {
  putImmutable(key, bytes, { retentionMode:'compliance', retainUntil, legalHold? }): void  // writer identity
  get(key): bytes                                                                          // reader identity
  list(prefix): key[]
  // retention/hold admin is a SEPARATE identity (dual-control); not callable by the writer
}

// services/evidence-writer
EvidenceWriter {
  append(object): { worm_object_key, segment_id }   // validates, orders, appends to OPEN segment
  sealCurrentSegment(db_id): ChainHead              // OPEN→...→SEALED, writes manifest, emits head
}

// packages/evidence (pure, shared with verifier)
buildSegmentManifest(core): { ...core, manifest_hash }
computeSegmentHash(manifest_hash, last_row_hash, previous_segment_hash): hash
verifySegment(manifest, objects): SegmentCheck[]    // §10 steps 1–5, pure

// packages/signing
Signer { sign(payload): { algorithm, signing_key_id, signature }; getPublicKey(id): PublicKey }

// services/anchoring
AnchorProvider { provider_type; anchor(signedHead): AnchorToken; verifyToken(token, signedHead): boolean }
buildAnchorRecord(head, hsmSig, token): AnchorRecord   // SEALED→ANCHOR_PENDING→ANCHORED

// packages/verifier (PUBLIC INPUTS ONLY)
verifyEvidence({ wormReader | exportPackage, publicKeys, anchorCerts }): VerificationReport
```

CLI: `verifier-cli verify --export <package>.json` (offline) or `--worm <readonly-conn> --db <id> --segments a..b`; `evidence-export build --db <id> --select <query> --out <package>.json`.

---

## 11. Event Flow

```
[Sprint-1] CCE built + validated (validateCceFull) ──► emit stream
        │   (+ Snapshot Epoch Manifest companion at handoff)
        ▼
[2A] EvidenceWriter.append: validate-before-append, assign worm_object_key,
        order globally, write object to WORM (immutable), record in OPEN segment,
        set CCE.evidence.{worm_object_key, segment_id}
        ▼  (event_count cap OR time cap reached)
[2B] Seal: re-verify intra-segment object chain ─► build manifest ─► manifest_hash
        ─► segment_hash (link to previous_segment_hash) ─► write manifest to WORM
        ─► SEALED ─► emit chain head
        ▼  (anchoring cadence: N events or T minutes)
[2C] Signer.sign(anchor payload over head)  ─► hsm_signature (dev signer; HSM-ready)
        ▼
[2D] AnchorProvider.anchor(signed head hash) ─► external token (RFC-3161 / transparency log)
        ─► verifyToken ─► buildAnchorRecord ─► write to WORM ─► ANCHORED
        ─► set CCE.evidence.anchor_ref on covered objects
        ▼  (failure at 2C/2D ⇒ stay ANCHOR_PENDING, backoff, alarm; never fabricate)
[2E] Independent Verifier (offline): WORM read + public keys + anchor certs + §10 logic
        ─► VerificationReport (PASS / located FAIL)
[2E] Evidence Export Package: self-verifying bundle for external auditors
```

Failure isolation reuses Sprint-1 `infra/dlq`: an object that fails validation pre-append is DLQ'd (never written unvalidated); a seal/anchor failure halts forward progress for that segment and alarms (no fabrication, §19.12).

---

## 12. Security Boundaries

**Preserved Sprint-1 invariants:** INV-1 (no monitored-DB write — collector creds unchanged, read-only), INV-2 (no fabrication), INV-3 (append-only/WORM), INV-4 (single canonical impl reused).

**New evidence-domain boundaries (WORM §2, §8, §19):**
- **INV-EV-1 — Domain B holds an append-only WORM writer only.** No code path in `evidence-writer` can delete, overwrite, shorten retention, lift legal hold, or read signing private keys (§19.2). Enforced by the WORM identity's policy and a CI no-mutate proof.
- **INV-EV-2 — Sign/anchor only hash structures.** HSM/dev-signer and external providers receive heads/hashes, never CCE/audit plaintext (§19.4).
- **INV-EV-3 — ANCHORED only after a verified external token** (§19.5); never on signature alone (unless dual-custodian policy explicitly equates it).
- **INV-EV-4 — Signing keys are non-exportable and Domain-C-owned (conceptually).** Dev key generated at deploy, never committed, never logged; the `Signer` interface exposes no private material; HSM swap is a no-op for callers.
- **INV-EV-5 — Verifier needs only public inputs.** `packages/verifier` imports only `@edam/canonical` + public schemas/keys/certs; CI boundary gate enforces it (defeats C1, §19.7).
- **INV-EV-6 — No fabrication on failure.** WORM/HSM/TSA failure ⇒ ANCHOR_PENDING/halt + alarm; never synthesize a token, hash, or "OK" (§19.12).
- **INV-EV-7 — VERIFICATION_FAILED is terminal/software-irreversible** (§19.8).

**Identity separation (dev approximation, documented):** append-only writer (B) ≠ retention/hold admin (C, dual-control) ≠ reader/exporter (custody-gated). In dev compose these are distinct MinIO/credentials; dual-control is stubbed and documented as a Domain-C operational control.

---

## 13. CI/CD Gates

**All Sprint-1 gates remain unchanged and must stay green (C-6):** build-test (ubuntu+macos), lint (0 warnings), coverage (≥90/80/90/90), conformance (CCE incl. Rev-4 cases), determinism-rig + determinism-compare (GATE), no-write-proof (INV-1), secret-hygiene, honesty-invariants (INV-2), compose-validate.

**Added Sprint-2 gates:**
| Gate | Asserts |
|---|---|
| `evidence-conformance` | WV-1…WV-14 pass (§18) |
| `evidence-determinism` (matrix + compare GATE) | `manifest_hash` / `segment_hash` byte-identical ubuntu vs macos (WV-1) |
| `worm-no-mutate-proof` | `evidence-writer` source + WORM writer policy contain no delete/overwrite/retention-shorten/key-read path (INV-EV-1) — static scan, like the Sprint-1 no-write-proof |
| `verifier-isolation-proof` | `packages/verifier` dependency graph imports only `@edam/canonical` + vendored schemas + public-key/cert parsing — no EDAM service/secret/DB (INV-EV-5) |
| `signing-key-hygiene` | no private key material in repo, env, compose, or logs; only public keys published (extends secret-hygiene) |
| `anchor-no-fabrication` | unit/integration: on simulated TSA/log outage, no token is produced and state stays ANCHOR_PENDING (WV-13, INV-EV-6) |
| `evidence-schemas-verbatim` | vendored §16 schemas match the WORM spec doc blocks byte-for-byte (provenance, like the existing schemas.test) |
| `compose-validate` (extended) | new minio/dev-signer/dev-tsa services validate |

Coverage thresholds extend to the new packages; live-IO adapters (MinIO, TSA) may be excluded from unit coverage and covered by the live-stack job (consistent with Sprint-1 D5).

---

## 14. Conformance Tests (WV-1 … WV-14, WORM §18)

| # | Test | Maps to |
|---|---|---|
| WV-1 | Deterministic manifest hashing (cross-target) | 2B, evidence-determinism gate |
| WV-2 | Tampered CCE byte-flip ⇒ per-object + object-chain FAIL; signature still PASS (post-anchor proof) | 2E |
| WV-3 | Missing referenced WORM object ⇒ FAIL with offending key | 2E |
| WV-4 | Broken `prev_row_hash` (intra/cross-segment) ⇒ chain/continuity FAIL | 2B/2E |
| WV-5 | Invalid/forged HSM signature or unpublished key ⇒ signature FAIL | 2C/2E |
| WV-6 | Tampered RFC-3161 token / inclusion proof ⇒ anchor-token FAIL | 2D/2E |
| WV-7 | Projection/evidence-index drift ⇒ drift finding (not evidence failure); rebuild restores | 2A/2E |
| WV-8 | Delete/retention-shorten on LEGAL_HOLD ⇒ denied + CRITICAL alarm + custody-logged | 2A |
| WV-9 | `segment_sequence` gap ⇒ no-missing-segment FAIL | 2B/2E |
| WV-10 | GTID/LSN gap between segments ⇒ no-missing-event FAIL (corroborated by CCE completeness) | 2B/2E |
| WV-11 | Genesis correctness (seq 0 ⇒ previous_segment null + zero hash; non-genesis links) | 2B/2E |
| WV-12 | **Independent verifier isolation** — full §10 with only WORM read + public keys + certs + spec | 2E (INV-EV-5) |
| WV-13 | Anchor outage ⇒ stays ANCHOR_PENDING, no fabricated token, recovers | 2D |
| WV-14 | Export package self-verifies standalone; continuity holds | 2E |

Golden fixtures: pinned sample segment manifest + anchor record + a small multi-segment chain (genesis + 2 segments), with cross-target-pinned `manifest_hash`/`segment_hash` (extends the determinism rig).

---

## 15. Live-Stack Validation Plan

Mirrors the Sprint-1 / D-LIVE-1 live methodology (real Docker Compose; temporary harness imports real modules; torn down after; no committed harness).

1. **Bring up** the extended compose: mysql + redis + debezium (Sprint-1 path) + **minio (Object Lock, compliance mode)** + **dev-signer** + **dev-tsa/transparency**.
2. **Run the Sprint-1 pipeline** so real CCEs (streaming **and** `cce-1.1` snapshot) + snapshot-epoch manifests flow.
3. **Evidence-writer** appends them to MinIO WORM, opens/seals segments (small caps to force ≥2 segments incl. genesis), populates CCE `evidence.{worm_object_key,segment_id}`.
4. **Sign + anchor** sealed heads via the dev signer + dev TSA/log; populate `anchor_ref`; confirm ANCHORED only after a verified token; confirm bounded un-anchored window.
5. **Independent verifier** runs **offline** against an Evidence Export Package using only WORM read + published public keys + TSA cert + verifier spec → expect full PASS (WV-12/WV-14).
6. **Tamper drills (must FAIL, located):** byte-flip a WORM object (WV-2), withhold an object (WV-3), break a chain link (WV-4), forge a signature (WV-5), tamper a token (WV-6), inject a segment gap (WV-9) and an offset gap (WV-10), attempt delete on LEGAL_HOLD (WV-8), simulate TSA outage (WV-13).
7. **Security re-checks:** INV-1 still holds (writes to monitored DB rejected); writer identity cannot delete/overwrite WORM (INV-EV-1); no plaintext to TSA/HSM (INV-EV-2); no private key in logs.
8. **Report:** `docs/EDAM-Evidence-Live-Validation-Report.md` (Go/No-Go for declaring evidence integrity provable). Stack torn down; only the report committed.

---

## 16. Threat Model Additions

| ID | Threat | Mitigation (this sprint) | Residual / deferred |
|---|---|---|---|
| TE-1 | **Post-anchor tamper** of a sealed CCE in WORM | Per-object hash + object-chain checks locate it; signature still verifies (proves alteration is post-anchor) (WV-2) | Storage must enforce Object Lock; dev MinIO approximates |
| TE-2 | **EDAM (B) compromise** attempts to forge evidence | B holds append-only writer + no signing key; cannot mutate WORM or sign; verifier needs no B software (INV-EV-1/4/5) | Real HSM + Object-Lock in prod |
| TE-3 | **Signing-key theft** | Non-exportable key behind `Signer` iface; dev key never committed/logged; rotation/revocation interface + `revoked_at` honored by verifier | HSM (PKCS#11) impl deferred; dual-control stubbed |
| TE-4 | **Anchor forgery / TSA spoof** | Token verified against the provider's published cert; forged token ⇒ FAIL (WV-6) | Real TSA/log provider in prod; ≥2 providers for high-value |
| TE-5 | **Anchor outage abused to stall/fake** | No fabrication: stay ANCHOR_PENDING + alarm + bounded window (WV-13, INV-EV-6) | Failover provider deferred |
| TE-6 | **Missing object/segment/event** (silent gap) | object_list + sequence contiguity + offset continuity checks (WV-3/9/10) | — |
| TE-7 | **WORM mutation/deletion attempt** (incl. retention shorten, legal-hold lift) | Compliance-mode retention; writer has no delete; dual-control + custody log on admin ops; no-mutate CI proof (WV-8, INV-EV-1) | Geo-replication + true compliance backend in prod |
| TE-8 | **Projection/evidence-index drift** masquerading as evidence | Index is non-authoritative; WORM wins; drift is a projection finding + rebuild (WV-7) | — |
| TE-9 | **Verifier dependency creep** (needing EDAM to "verify") | `verifier-isolation-proof` CI gate; public-inputs-only (WV-12, INV-EV-5) | — |
| TE-10 | **GDPR erasure vs immutability** | Crypto-shred *interface* reserved (destroy field key, keep object/hashes); not built this sprint | Field-key tooling deferred |

---

## 17. Acceptance Criteria

| ID | Criterion |
|---|---|
| A-EV1 | CCEs (streaming + `cce-1.1` snapshot) and snapshot-epoch manifests are appended to WORM immutably, in global order, with `evidence.{worm_object_key,segment_id}` populated; no unvalidated object is ever written. |
| A-EV2 | Segments open/seal per `db_id` with contiguous `segment_sequence` from 0; genesis uses all-zero `previous_segment_hash`; object chain does not reset across boundaries. |
| A-EV3 | `manifest_hash` and `segment_hash` are deterministic and **byte-identical cross-target** (ubuntu vs macos) — gated. |
| A-EV4 | Chain heads are signed by the dev signer behind the `Signer` interface; public keys are published; signatures verify offline with the public key; HSM adapter is interface-ready. |
| A-EV5 | Heads are anchored via an `AnchorProvider` (RFC-3161 and/or transparency-log dev provider); a segment reaches ANCHORED **only** after a verified external token; `evidence.anchor_ref` populated. |
| A-EV6 | On HSM/TSA/WORM failure the system stays ANCHOR_PENDING/halts and alarms; **no token/hash/OK is fabricated** (WV-13). |
| A-EV7 | The independent verifier completes the full §10 procedure using **only** WORM read + public keys + anchor certs + published logic, and PASSes a valid chain; the `verifier-isolation-proof` gate is green (WV-12). |
| A-EV8 | Every tamper drill (WV-2…WV-6, WV-8, WV-9, WV-10) produces a deterministic, **located** FAIL; a post-anchor byte-flip keeps the signature valid (proving alteration is post-seal). |
| A-EV9 | An Evidence Export Package self-verifies standalone with continuity preserved (WV-14). |
| A-EV10 | All Sprint-1 gates remain green and unchanged; all new gates green; coverage thresholds met on new packages. |
| A-EV11 | INV-1..INV-4 preserved and INV-EV-1..INV-EV-7 enforced (CI + live drills); no CCE semantic change; no dashboard/risk-engine/reversal/business-projection built. |

---

## 18. Go / No-Go Checklist

**Entry (Go to start Sprint 2):**
- [ ] Sprint-1 + D-LIVE-1 on `main` (or the integration branch), all gates green. ✅ (baseline)
- [ ] WORM spec §16 schemas frozen and available to vendor verbatim. ✅
- [ ] Dev WORM backend (MinIO Object Lock), dev signer, dev TSA/log selected and reproducible in compose.
- [ ] Sprint-2 backlog (`docs/EDAM-Sprint2-Backlog.md`) approved with task-level estimates.

**Exit (Go to declare Evidence/WORM/Anchoring done):**
- [ ] 2A–2E delivered; A-EV1…A-EV11 met.
- [ ] WV-1…WV-14 green in CI; evidence-determinism cross-target MATCH.
- [ ] `worm-no-mutate-proof`, `verifier-isolation-proof`, `signing-key-hygiene`, `anchor-no-fabrication`, `evidence-schemas-verbatim` green.
- [ ] Live-stack validation report PASS, incl. all tamper drills failing-as-expected and the offline verifier PASS.
- [ ] Sprint-1 gates unchanged and green; no dashboard/risk-engine/reversal/business-projection introduced; CCE semantics unchanged.
- [ ] Security sign-off (extends `EDAM-Sprint1-Security-Signoff.md`): INV-1..4 + INV-EV-1..7 verified.

**No-Go triggers:** any verifier dependency on EDAM software/secret/online API (INV-EV-5 violated); any path that marks ANCHORED without a verified external token; any writer capability to mutate/delete WORM; any fabricated token/hash on failure; any non-deterministic `manifest_hash`/`segment_hash`; any weakening of a Sprint-1 gate.

---

*Planning document only — no code, no implementation, no schema/contract modification. Implements the frozen WORM Evidence Segment & Anchoring Specification v1; all prior documents remain unmodified. Dashboard, Risk Engine, business Projection DB, and reversal are explicitly out of scope.*
