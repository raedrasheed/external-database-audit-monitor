# EDAM Sprint-2 Backlog
### Evidence + WORM + Anchoring — Epics → User Stories → Development Tasks

> **Document class:** Backlog / planning only — **no code, no implementation, no architecture or contract change.**
> **Derived from:** `docs/EDAM-Sprint2-Implementation-Plan.md` (which implements the frozen `docs/EDAM-WORM-Evidence-Anchoring-Spec.md` v1).
> **Baseline:** Sprint-1 complete + **D-LIVE-1 CLOSED** (`cce-1.1`).
> **Estimates:** story points (SP), Fibonacci. **Priority:** P0 (critical path) · P1 (high) · P2 (supporting).
> **Date:** 2026-06-01.

**Legend — risk tags:** `#determinism` `#security` `#worm-immutability` `#key-custody` `#external-dep` `#isolation` `#live-io` `#no-fabrication` `#integration` `#provenance` `#crypto` `#schema-vendor`.
**Acceptance criteria** refer to plan §17 (**A-EV1…A-EV11**). **Conformance tests** refer to WORM spec §18 (**WV-1…WV-14**).

---

## 0. Epic Index

| Epic | Title | Plan § | Milestone | SP |
|---|---|---|---|---|
| **E2A** | Evidence Segment Store | 2A | M-A | 34 |
| **E2B** | Row Hash Chain + Segment Sealing | 2B | M-B | 29 |
| **E2C** | Signing Layer (dev signer; HSM-compatible) | 2C | M-C | 21 |
| **E2D** | External Anchoring (RFC-3161 / transparency-log) | 2D | M-D | 26 |
| **E2E** | Independent Verifier | 2E | M-E | 39 |
| **E2F** | Live-stack Validation + Security Sign-off | 15/17/18 | M-Live | 21 |
| | **Total** | | | **170** |

---

# EPIC E2A — Evidence Segment Store
*Plan §2 · Milestone M-A · Append-only WORM writer; segment open/append. Implements WORM §3/§4/§5(OPEN→SEALING)/§6(append).*

## Story E2A-S1 — As the Evidence Domain, I need the WORM §16 schemas vendored verbatim so evidence records are contract-validated.
| Field | Value |
|---|---|
| **ID** | EDAM-T101 |
| **Title** | Vendor evidence schemas verbatim + validators |
| **Description** | Vendor `evidence-segment-manifest-1.0`, `anchor-record-1.0`, `verification-report-1.0`, `evidence-export-package-1.0` JSON Schemas **byte-verbatim** from WORM spec §16 into `packages/contracts/src/schemas/`; register in the schema registry; add `validate*` helpers. No semantic change. |
| **Dependencies** | — |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | All four schemas load + validate sample fixtures; `SCHEMA_IDS` updated; existing CCE schema provenance tests still pass. |
| **Risk tags** | `#schema-vendor` `#provenance` |
| **Conformance** | (enables WV-1, WV-9, WV-11, WV-14) |
| **Maps to** | A-EV1, A-EV9 |

| **ID** | EDAM-T102 |
|---|---|
| **Title** | `evidence-schemas-verbatim` CI gate |
| **Description** | Add a gate asserting the four vendored schemas match the WORM spec doc ```json blocks byte-for-byte (mirrors the existing `schemas.test` provenance check). |
| **Dependencies** | T101 |
| **Priority** | P0 |
| **Estimate** | 2 SP |
| **Acceptance criteria** | CI fails on any drift between vendored schema and spec block. |
| **Risk tags** | `#provenance` `#schema-vendor` |
| **Conformance** | — (gate) |
| **Maps to** | A-EV10 |

## Story E2A-S2 — As Domain B, I need an append-only WORM store so evidence is immutable and I cannot mutate it.
| **ID** | EDAM-T103 |
|---|---|
| **Title** | `infra/worm` interface + 3 identities |
| **Description** | Define `WormStore` (`putImmutable`, `get`, `list`, `headObjectLock`) with **separate** writer / retention-admin / reader identities (WORM W-8). Writer policy excludes delete/overwrite/retention. |
| **Dependencies** | — |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Interface + in-memory fake; writer identity exposes no delete/overwrite/retention API. |
| **Risk tags** | `#worm-immutability` `#security` |
| **Conformance** | WV-8 |
| **Maps to** | A-EV1, INV-EV-1 |

| **ID** | EDAM-T104 |
|---|---|
| **Title** | MinIO Object-Lock dev adapter (compliance mode + legal hold) |
| **Description** | Implement `WormStore` over MinIO with Object Lock **compliance-mode** retention (W-1/W-2), versioning (W-4), and a legal-hold flag (W-3). Dev compose service + configs. |
| **Dependencies** | T103 |
| **Priority** | P0 |
| **Estimate** | 8 SP |
| **Acceptance criteria** | Object written once cannot be overwritten/deleted within retention by the writer identity; legal-hold blocks deletion; integration test against MinIO. |
| **Risk tags** | `#worm-immutability` `#live-io` `#external-dep` |
| **Conformance** | WV-8 |
| **Maps to** | A-EV1 |

| **ID** | EDAM-T105 |
|---|---|
| **Title** | `worm-no-mutate-proof` CI gate |
| **Description** | Static scan: `services/evidence-writer` source + the WORM writer policy contain **no** delete/overwrite/retention-shorten/key-read path (mirrors Sprint-1 `no-write-proof`). |
| **Dependencies** | T103 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Gate flags any introduced mutation path; positive control (a planted delete) is detected. |
| **Risk tags** | `#worm-immutability` `#security` `#isolation` |
| **Conformance** | WV-8 |
| **Maps to** | A-EV11, INV-EV-1 |

## Story E2A-S3 — As the writer, I need to append validated evidence objects into OPEN segments in global order.
| **ID** | EDAM-T106 |
|---|---|
| **Title** | Evidence object append (validate-before-write) |
| **Description** | `EvidenceWriter.append(object)`: validate against the object's contract (`validateCceFull` / manifest validator), assign `worm_object_key`, write immutably, set CCE `evidence.{worm_object_key,segment_id}` (existing fields). DLQ on validation failure (reuse `infra/dlq`). |
| **Dependencies** | T101, T103 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Only validated objects reach WORM; invalid → DLQ + alarm; back-refs populated. |
| **Risk tags** | `#integration` `#no-fabrication` |
| **Conformance** | WV-3 |
| **Maps to** | A-EV1 |

| **ID** | EDAM-T107 |
|---|---|
| **Title** | Segment accumulator (open + global order + caps) |
| **Description** | Open one segment per `db_id` (sequence contiguous from 0); append in the frozen global order (reuse `@edam/cce-model` `orderCces` incl. Rev-4 snapshot tie-break); track first/last ids, first/last `row_hash`, `object_list`, `object_hash_list`, `source_offset_range`, fidelity/completeness summaries; trigger SEALING on event_count or time cap. |
| **Dependencies** | T106 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Objects ordered deterministically; caps trigger seal; summaries computed; sequence contiguous. |
| **Risk tags** | `#determinism` `#integration` |
| **Conformance** | WV-9, WV-10, WV-11 |
| **Maps to** | A-EV2 |

| **ID** | EDAM-T108 |
|---|---|
| **Title** | Minimal evidence-index (metadata only, rebuildable) |
| **Description** | Optional segment/head/anchor catalog (ids/hashes/keys only) to locate objects for export/verify. **Non-authoritative** (WORM wins); rebuildable from WORM listing. Skipped if WORM `list` suffices. |
| **Dependencies** | T104 |
| **Priority** | P2 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Index holds only metadata; drift vs WORM is a projection finding; rebuild restores. |
| **Risk tags** | `#integration` |
| **Conformance** | WV-7 |
| **Maps to** | A-EV1 (support) |

---

# EPIC E2B — Row Hash Chain + Segment Sealing
*Plan §3 · Milestone M-B · Implements WORM §5(SEALING→SEALED)/§6(manifest_hash)/§7(chain head).*

## Story E2B-S1 — As an auditor, I need deterministic sealed manifests so a segment is verifiable without the app DB.
| **ID** | EDAM-T110 |
|---|---|
| **Title** | `packages/evidence` pure types + canonical helpers |
| **Description** | New pure package: segment/manifest/chain-head types + canonical manifest assembly. Depends only on `@edam/canonical` + vendored schemas. **Shared by writer and verifier** (determinism keystone). |
| **Dependencies** | T101 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Package builds; no second serializer (reuses `serializeCanonical`); importable by both writer and verifier. |
| **Risk tags** | `#determinism` `#isolation` |
| **Conformance** | WV-1 |
| **Maps to** | A-EV3 |

| **ID** | EDAM-T111 |
|---|---|
| **Title** | Build `evidence-segment-manifest` core + `manifest_hash` |
| **Description** | Assemble §6 manifest core; compute `manifest_hash` = SHA-256 over canonical serialization (CCE §12.7). Validate against vendored schema. |
| **Dependencies** | T110, T107 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | `manifest_hash` reproducible byte-for-byte; manifest validates; field cross-checks (first/last ids, event_count) hold. |
| **Risk tags** | `#determinism` `#crypto` |
| **Conformance** | WV-1 |
| **Maps to** | A-EV3 |

## Story E2B-S2 — As the chain, I need object-level and segment-level linkage with a correct genesis.
| **ID** | EDAM-T112 |
|---|---|
| **Title** | Intra-segment object-chain re-verify (pre-seal) |
| **Description** | Before sealing, re-verify each object's `row_hash == SHA256(prev_row_hash ‖ event_hash)` and boundary continuity (reuse `@edam/canonical rowHash`, `verifyCce`). Fail → `VERIFICATION_FAILED`. |
| **Dependencies** | T110 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | A broken link is detected at seal; terminal state + CRITICAL alarm. |
| **Risk tags** | `#crypto` `#no-fabrication` |
| **Conformance** | WV-4 |
| **Maps to** | A-EV2, A-EV8 |

| **ID** | EDAM-T113 |
|---|---|
| **Title** | `segment_hash` + cross-segment link + genesis |
| **Description** | `segment_hash = SHA256(manifest_hash ‖ last_row_hash ‖ previous_segment_hash)`; genesis `previous_segment_hash = sha256:00…00`; n>0 links to prior `segment_hash`; first_row_hash chains from prior last_row_hash (object chain does not reset). |
| **Dependencies** | T111 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Genesis correct; non-genesis links; cross-boundary chain unbroken. |
| **Risk tags** | `#crypto` `#determinism` |
| **Conformance** | WV-4, WV-9, WV-11 |
| **Maps to** | A-EV2 |

| **ID** | EDAM-T114 |
|---|---|
| **Title** | Seal transition + chain-head emit |
| **Description** | OPEN→SEALING→SEALED; write manifest to WORM (immutable); emit chain head `{db_id, segment_id, segment_sequence, segment_hash, last_row_hash}` to the signing stage. |
| **Dependencies** | T113, T104 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Manifest immutable in WORM; head emitted; state machine enforced (no skip to ANCHORED). |
| **Risk tags** | `#worm-immutability` `#integration` |
| **Conformance** | WV-11 |
| **Maps to** | A-EV2 |

## Story E2B-S3 — As the build pipeline, I need cross-target determinism gated.
| **ID** | EDAM-T115 |
|---|---|
| **Title** | `evidence-determinism` rig + cross-target GATE |
| **Description** | Rig prints `manifest_hash`/`segment_hash` for pinned segment fixtures per target; gating job byte-compares ubuntu vs macos (mirrors the CCE determinism rig). |
| **Dependencies** | T113 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Cross-target MATCH; mismatch fails the GATE; golden manifest/segment fixtures pinned. |
| **Risk tags** | `#determinism` |
| **Conformance** | WV-1 |
| **Maps to** | A-EV3, A-EV10 |

| **ID** | EDAM-T116 |
|---|---|
| **Title** | Genesis + multi-segment golden fixtures |
| **Description** | Pin a genesis + 2-segment chain fixture (cross-segment link, offset continuity) for determinism + verifier tests. |
| **Dependencies** | T113 |
| **Priority** | P1 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Fixtures load; used by WV-9/10/11 + determinism. |
| **Risk tags** | `#determinism` `#integration` |
| **Conformance** | WV-9, WV-10, WV-11 |
| **Maps to** | A-EV3 |

---

# EPIC E2C — Signing Layer (dev signer; HSM-compatible)
*Plan §4 · Milestone M-C · Implements WORM §8 / §16.2(signature).*

## Story E2C-S1 — As the Evidence Domain, I need a signer interface that an HSM can later implement without caller changes.
| **ID** | EDAM-T120 |
|---|---|
| **Title** | `Signer` interface + canonical anchor payload |
| **Description** | `packages/signing`: `Signer.sign(payload)` → `{algorithm, signing_key_id, signature}`, `getPublicKey(id)`. Define the canonical **anchor payload** `canonical({db_id, segment_id, segment_sequence, segment_hash, last_row_hash, head_count, signed_at})`. Signs a hash structure only. |
| **Dependencies** | T114 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Interface exposes no private material; payload canonical + reproducible. |
| **Risk tags** | `#key-custody` `#crypto` `#isolation` |
| **Conformance** | WV-5 |
| **Maps to** | A-EV4, INV-EV-2 |

| **ID** | EDAM-T121 |
|---|---|
| **Title** | `DevEd25519Signer` + key registry |
| **Description** | In-process Ed25519 dev signer; key generated at deploy, **never committed/logged**; publish public key + WORM key-registration record (`signing_key_id, algorithm, public_key, created_at, revoked_at?`). |
| **Dependencies** | T120 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Signature verifies offline with the published public key; private key absent from repo/env/logs. |
| **Risk tags** | `#key-custody` `#crypto` `#security` |
| **Conformance** | WV-5 |
| **Maps to** | A-EV4 |

| **ID** | EDAM-T122 |
|---|---|
| **Title** | `Pkcs11Signer` interface stub (HSM-ready) |
| **Description** | Documented adapter slot implementing `Signer` over PKCS#11 (key non-exportable). Config-selectable; **not implemented** this sprint. |
| **Dependencies** | T120 |
| **Priority** | P2 |
| **Estimate** | 2 SP |
| **Acceptance criteria** | Type-checks; swapping signer requires no caller change. |
| **Risk tags** | `#key-custody` |
| **Conformance** | — |
| **Maps to** | A-EV4 |

| **ID** | EDAM-T123 |
|---|---|
| **Title** | Key rotation/revocation interfaces + `revoked_at` |
| **Description** | Interfaces for rotation/revocation; record `signing_key_id` per anchor; `revoked_at` semantics (anchors before revocation valid). Dual-control enforcement is a custodian control — stubbed/documented. |
| **Dependencies** | T121 |
| **Priority** | P1 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Verifier-consumable `revoked_at`; rotation never invalidates prior anchors. |
| **Risk tags** | `#key-custody` `#security` |
| **Conformance** | WV-5 |
| **Maps to** | A-EV4 |

## Story E2C-S2 — As security, I need proof no signing private key leaks.
| **ID** | EDAM-T124 |
|---|---|
| **Title** | `signing-key-hygiene` CI gate |
| **Description** | Extend secret-hygiene: assert no private key material in repo/env/compose/logs; only public keys published. |
| **Dependencies** | T121 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Gate flags any embedded/logged private key; positive control detected. |
| **Risk tags** | `#security` `#key-custody` |
| **Conformance** | WV-5 |
| **Maps to** | A-EV11, INV-EV-4 |

---

# EPIC E2D — External Anchoring (RFC-3161 / transparency-log)
*Plan §5 · Milestone M-D · Implements WORM §5(ANCHOR_PENDING→ANCHORED)/§9/§16.2.*

## Story E2D-S1 — As the chain head, I need a verified external timestamp before I am ANCHORED.
| **ID** | EDAM-T130 |
|---|---|
| **Title** | `AnchorProvider` abstraction |
| **Description** | `services/anchoring`: `AnchorProvider{ provider_type, anchor(signedHead), verifyToken(token, signedHead) }` over the frozen enum `{rfc3161, transparency_log, dual_custodian}`. Receives only the hash of the signed payload. |
| **Dependencies** | T120 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Interface fixed; provider sees no plaintext; pluggable. |
| **Risk tags** | `#external-dep` `#crypto` `#isolation` |
| **Conformance** | WV-6 |
| **Maps to** | A-EV5, INV-EV-2 |

| **ID** | EDAM-T131 |
|---|---|
| **Title** | Dev RFC-3161 TSA provider |
| **Description** | Implement RFC-3161 provider + a dev TSA (dev cert) producing/validating a `TimeStampToken` over the head+signature hash (§9.1). |
| **Dependencies** | T130 |
| **Priority** | P0 |
| **Estimate** | 8 SP |
| **Acceptance criteria** | Token issued + verified against the dev cert; embedded hash matches recomputed hash. |
| **Risk tags** | `#external-dep` `#crypto` `#live-io` |
| **Conformance** | WV-6 |
| **Maps to** | A-EV5 |

| **ID** | EDAM-T132 |
|---|---|
| **Title** | Dev transparency-log provider |
| **Description** | Append-only Merkle log provider producing inclusion proof + signed tree head (§9.2). (At least one of T131/T132 wired end-to-end; the other interface-complete.) |
| **Dependencies** | T130 |
| **Priority** | P1 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Inclusion proof verifies to the STH; STH signature verifies. |
| **Risk tags** | `#external-dep` `#crypto` |
| **Conformance** | WV-6 |
| **Maps to** | A-EV5 |

| **ID** | EDAM-T133 |
|---|---|
| **Title** | Anchor-record builder + ANCHORED transition + `anchor_ref` |
| **Description** | Build `anchor-record-1.0` (head, hsm_signature, provider_type, token/proof, signing_key_id, anchored_at), write immutably; SEALED→ANCHOR_PENDING→ANCHORED only after verified token; set CCE `evidence.anchor_ref`. |
| **Dependencies** | T131 (or T132), T121, T114 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | ANCHORED only post-verified-token; anchor record validates; `anchor_ref` populated on covered objects. |
| **Risk tags** | `#integration` `#crypto` `#worm-immutability` |
| **Conformance** | WV-6 |
| **Maps to** | A-EV5, INV-EV-3 |

## Story E2D-S2 — As operations, failures must never fabricate a token.
| **ID** | EDAM-T134 |
|---|---|
| **Title** | Retry/backoff + cadence (bounded un-anchored window) |
| **Description** | Idempotent re-request over the same hash; exponential backoff; cadence N events / T minutes; escalating alarm when the max un-anchored window is exceeded. |
| **Dependencies** | T133 |
| **Priority** | P1 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Cadence enforced; window breach alarms; retries idempotent. |
| **Risk tags** | `#external-dep` `#no-fabrication` |
| **Conformance** | WV-13 |
| **Maps to** | A-EV6 |

| **ID** | EDAM-T135 |
|---|---|
| **Title** | `anchor-no-fabrication` gate (outage test) |
| **Description** | Integration test/gate: on simulated TSA/log outage, **no** token produced, segment stays ANCHOR_PENDING, alarm raised; recovery anchors the queued head. |
| **Dependencies** | T133, T134 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Outage never yields ANCHORED or a fabricated token; recovery succeeds. |
| **Risk tags** | `#no-fabrication` `#external-dep` |
| **Conformance** | WV-13 |
| **Maps to** | A-EV6, INV-EV-6 |

---

# EPIC E2E — Independent Verifier
*Plan §6 · Milestone M-E · Implements WORM §10/§12/§16.3/§16.4/§18. The sprint's core guarantee.*

## Story E2E-S1 — As an external auditor, I re-prove the chain using only public inputs.
| **ID** | EDAM-T140 |
|---|---|
| **Title** | `packages/verifier` skeleton (public-inputs-only) |
| **Description** | Pure verifier package importing **only** `@edam/canonical` + vendored schemas + public-key/cert parsing. Input: WORM reader **or** export package. |
| **Dependencies** | T110, T101 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Builds; no import of writer/signing-private/anchoring-private/DB. |
| **Risk tags** | `#isolation` `#security` |
| **Conformance** | WV-12 |
| **Maps to** | A-EV7, INV-EV-5 |

| **ID** | EDAM-T141 |
|---|---|
| **Title** | §10 steps 1–3: per-object hash, object chain, manifest recompute |
| **Description** | Recompute `event_hash`; verify `row_hash` linkage; recompute `manifest_hash` + field cross-checks. |
| **Dependencies** | T140 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Valid chain passes; tampered object/manifest located. |
| **Risk tags** | `#crypto` `#determinism` |
| **Conformance** | WV-1, WV-2, WV-4 |
| **Maps to** | A-EV7, A-EV8 |

| **ID** | EDAM-T142 |
|---|---|
| **Title** | §10 steps 4–6: cross-segment continuity, no-missing-segment, no-missing-event |
| **Description** | Recompute `segment_hash`; verify cross-segment links + boundary chaining; sequence contiguity from 0; offset/GTID continuity corroborated by CCE completeness. |
| **Dependencies** | T141, T116 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Segment gap, offset gap, genesis errors located. |
| **Risk tags** | `#crypto` `#integration` |
| **Conformance** | WV-9, WV-10, WV-11 |
| **Maps to** | A-EV7, A-EV8 |

| **ID** | EDAM-T143 |
|---|---|
| **Title** | §10 steps 7–8: HSM signature + anchor-token verification |
| **Description** | Verify HSM signature against published public key (honor `revoked_at`); validate RFC-3161 token / Merkle proof against provider cert/key; confirm same-head commitment. |
| **Dependencies** | T142, T121, T131/T132 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Forged signature/token located; valid ones pass; post-anchor object tamper keeps signature valid (proves post-seal). |
| **Risk tags** | `#crypto` `#security` |
| **Conformance** | WV-2, WV-5, WV-6 |
| **Maps to** | A-EV7, A-EV8 |

| **ID** | EDAM-T144 |
|---|---|
| **Title** | §10 step 9 + Verification Report |
| **Description** | Optional evidence-index/projection consistency (drift = projection finding, not evidence failure); emit `verification-report-1.0` with per-check PASS/FAIL + offending ids. |
| **Dependencies** | T143 |
| **Priority** | P1 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Report validates; drift reported separately from integrity failures. |
| **Risk tags** | `#integration` |
| **Conformance** | WV-7 |
| **Maps to** | A-EV7 |

## Story E2E-S2 — As an auditor, I receive a self-verifying export and a CLI to run it offline.
| **ID** | EDAM-T145 |
|---|---|
| **Title** | Evidence Export Package builder |
| **Description** | Assemble §12.1 contents (objects, covering manifests, anchor records, public keys, anchor certs, pinned verifier-spec hash, custody log, export signature); write to WORM; continuity-preserving selection. |
| **Dependencies** | T133, T101 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Package validates; includes enough manifests/anchors to prove continuity. |
| **Risk tags** | `#integration` `#security` |
| **Conformance** | WV-14 |
| **Maps to** | A-EV9 |

| **ID** | EDAM-T146 |
|---|---|
| **Title** | `apps/verifier-cli` |
| **Description** | CLI: `verify --export <pkg>` (offline) or `--worm <readonly> --db <id> --segments a..b`; exit non-zero on any integrity FAIL. |
| **Dependencies** | T144 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Offline verify of a valid export PASSes; tampered export FAILs with located ids. |
| **Risk tags** | `#isolation` |
| **Conformance** | WV-12, WV-14 |
| **Maps to** | A-EV7, A-EV9 |

| **ID** | EDAM-T147 |
|---|---|
| **Title** | `verifier-isolation-proof` CI gate |
| **Description** | Dependency-graph gate: `packages/verifier` imports only `@edam/canonical` + vendored schemas + public-key/cert parsing — no EDAM service/secret/DB. |
| **Dependencies** | T140 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | A planted forbidden import fails the gate. |
| **Risk tags** | `#isolation` `#security` |
| **Conformance** | WV-12 |
| **Maps to** | A-EV7, A-EV10, INV-EV-5 |

## Story E2E-S3 — As QA, I need the full WV conformance suite.
| **ID** | EDAM-T148 |
|---|---|
| **Title** | WV-1…WV-14 conformance suite + `evidence-conformance` gate |
| **Description** | Implement all WV cases against the real implementations (tamper, missing object/segment/event, broken chain, forged sig/token, legal hold, outage, isolation, export self-verify); wire CI gate. |
| **Dependencies** | T143, T145, T135, T104 |
| **Priority** | P0 |
| **Estimate** | 8 SP |
| **Acceptance criteria** | WV-1…WV-14 green; located failures on tamper. |
| **Risk tags** | `#integration` `#crypto` `#no-fabrication` |
| **Conformance** | WV-1…WV-14 |
| **Maps to** | A-EV8, A-EV10 |

---

# EPIC E2F — Live-stack Validation + Security Sign-off
*Plan §15/§16/§17/§18 · Milestone M-Live.*

## Story E2F-S1 — As the team, I prove the whole flow on the real stack and sign off security.
| **ID** | EDAM-T160 |
|---|---|
| **Title** | Extend dev compose (minio + dev-signer + dev-tsa/log) |
| **Description** | Add MinIO (Object Lock), dev signer, dev TSA/transparency to `deploy/compose`; extend `compose-validate`. |
| **Dependencies** | T104, T121, T131/T132 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | `docker compose config` validates; services healthy. |
| **Risk tags** | `#live-io` `#external-dep` |
| **Conformance** | — |
| **Maps to** | A-EV10 |

| **ID** | EDAM-T161 |
|---|---|
| **Title** | Live evidence harness (Sprint-1 → WORM → seal → sign → anchor) |
| **Description** | Temporary harness (not committed) drives real CCEs (streaming + `cce-1.1` snapshot) + snapshot-epoch manifests through writer/seal/sign/anchor; forces ≥2 segments (genesis + 1). |
| **Dependencies** | T160, T133 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Objects anchored end-to-end; `evidence.{worm_object_key,segment_id,anchor_ref}` populated live. |
| **Risk tags** | `#live-io` `#integration` |
| **Conformance** | WV-1, WV-11 |
| **Maps to** | A-EV1…A-EV5 |

| **ID** | EDAM-T162 |
|---|---|
| **Title** | Offline verifier run + tamper drills (live) |
| **Description** | Run `verifier-cli` offline on an export package → PASS; execute tamper drills (byte-flip, withhold object, break link, forge sig, tamper token, segment gap, offset gap, legal-hold delete, TSA outage) → located FAIL / denied. |
| **Dependencies** | T161, T146 |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Valid chain PASSes offline; every drill fails-as-expected. |
| **Risk tags** | `#security` `#no-fabrication` `#isolation` |
| **Conformance** | WV-2…WV-14 |
| **Maps to** | A-EV6…A-EV9 |

| **ID** | EDAM-T163 |
|---|---|
| **Title** | `docs/EDAM-Evidence-Live-Validation-Report.md` |
| **Description** | Produce the live validation report (results + drills + Go/No-Go); stack torn down; only the report committed. |
| **Dependencies** | T162 |
| **Priority** | P0 |
| **Estimate** | 3 SP |
| **Acceptance criteria** | Report covers A-EV1…A-EV11 + WV-1…WV-14 outcomes. |
| **Risk tags** | `#live-io` |
| **Conformance** | WV-1…WV-14 |
| **Maps to** | A-EV10 |

| **ID** | EDAM-T164 |
|---|---|
| **Title** | Evidence security sign-off (extends Sprint-1 sign-off) |
| **Description** | Verify INV-1..INV-4 preserved + INV-EV-1..INV-EV-7 enforced (CI + live); confirm no dashboard/risk-engine/reversal/business-projection introduced; CCE semantics unchanged. |
| **Dependencies** | T163, all gate tasks |
| **Priority** | P0 |
| **Estimate** | 5 SP |
| **Acceptance criteria** | Sign-off doc GO; all gates green; invariants verified. |
| **Risk tags** | `#security` |
| **Conformance** | WV-1…WV-14 |
| **Maps to** | A-EV11 |

---

## 1. Acceptance-Criteria → Task Matrix (A-EV1…A-EV11)

| AC | Tasks |
|---|---|
| **A-EV1** (immutable ordered append + back-refs) | T101, T103, T104, T106, T108 |
| **A-EV2** (segments/genesis/contiguity) | T107, T112, T113, T114 |
| **A-EV3** (deterministic manifest/segment hash) | T110, T111, T115, T116 |
| **A-EV4** (signing; HSM-ready) | T120, T121, T122, T123 |
| **A-EV5** (anchored only after verified token) | T130, T131, T132, T133 |
| **A-EV6** (no fabrication on failure) | T134, T135 |
| **A-EV7** (verifier offline, public-inputs only) | T140, T141, T142, T143, T144, T146, T147 |
| **A-EV8** (tamper located) | T112, T141, T142, T143, T148 |
| **A-EV9** (export self-verifies) | T145, T146 |
| **A-EV10** (all gates green) | T102, T105, T115, T124, T135, T147, T148, T160, T163 |
| **A-EV11** (invariants; scope discipline) | T105, T124, T164 |

## 2. Conformance → Task Matrix (WV-1…WV-14)

| WV | Owning task(s) | Verified by |
|---|---|---|
| WV-1 deterministic manifest hash | T111, T115 | T141, T148 |
| WV-2 tampered CCE | T141, T143 | T148, T162 |
| WV-3 missing object | T106 | T148, T162 |
| WV-4 broken chain | T112, T113 | T141, T142, T148 |
| WV-5 invalid HSM sig | T121, T123, T124 | T143, T148 |
| WV-6 invalid token | T130, T131/T132, T133 | T143, T148 |
| WV-7 projection drift | T108 | T144, T148 |
| WV-8 legal hold | T103, T104, T105 | T148, T162 |
| WV-9 no missing segment | T107, T113 | T142, T148 |
| WV-10 no missing event | T107 | T142, T148 |
| WV-11 genesis | T113, T114 | T142, T148, T161 |
| WV-12 verifier isolation | T140, T147 | T146, T148, T162 |
| WV-13 anchor outage | T134, T135 | T148, T162 |
| WV-14 export self-verify | T145 | T146, T148, T162 |

## 3. Cross-cutting Gate Tasks (item 8)

| Gate | Task |
|---|---|
| evidence-schemas-verbatim | **T102** |
| worm-no-mutate-proof | **T105** |
| verifier-isolation-proof | **T147** |
| signing-key-hygiene | **T124** |
| anchor-no-fabrication | **T135** |
| evidence-determinism cross-target | **T115** |
| live-stack validation report | **T163** |

---

## 4. Dependency Graph

```
T101 ─┬─► T102 (gate)
      ├─► T106 ─► T107 ─► T111 ─► T113 ─► T114 ─► T120 ─► T121 ─► T133 ─► T145 ─► T146
      └─► T110 ─┘            │        │        │      │   │        │        │
T103 ─┬─► T104 ─► T114        │   T112┘   T115(gate)  │  T123      │        │
      ├─► T105 (gate)         │   T116────────────────┘            │        │
      └─► T106                │                                    │        │
T120 ─► T122 (stub)           │                        T130 ─┬─► T131 ─┘    │
T121 ─► T124 (gate)           │                              └─► T132        │
T130 ─► T133                  │                        T133 ─► T134 ─► T135(gate)
T110+T101 ─► T140 ─┬─► T141 ─► T142 ─► T143 ─► T144 ─► (T146)
                   └─► T147 (gate)
T143+T145+T135+T104 ─► T148 (WV suite/gate)
T104+T121+T131/2 ─► T160 ─► T161 ─► T162 ─► T163 ─► T164
```

## 5. Critical Path

**T101 → T103/T104 → T106 → T107 → T111 → T113 → T114 → T120 → T121 → T133 → T145 → T146 → T148 → T161 → T162 → T163 → T164.**
(Anchoring provider T130→T131 and verifier core T140→T143 feed T148/T162 and must complete before the WV suite and live drills.)

## 6. Parallelizable Tracks

- **Track 1 (Store/Seal):** E2A → E2B (T101→T114, T110/T115/T116).
- **Track 2 (Signing):** E2C (T120–T124) — starts once the anchor-payload shape (T120) is fixed; otherwise independent of WORM I/O.
- **Track 3 (Anchoring):** E2D (T130–T135) — dev TSA/log can be built in parallel against T120's payload.
- **Track 4 (Verifier):** E2E core (T140–T144, T147) — pure logic, developed against the T116 golden fixtures **in parallel** with Tracks 1–3; integrates at T143/T148.
- **Gate tasks** (T102, T105, T115, T124, T135, T147) run alongside their feature tasks.

## 7. Recommended Implementation Order

1. **Foundations:** T101, T102, T103, T105, T110.
2. **Store + Seal:** T104, T106, T107, T111, T112, T113, T114, T115, T116, T108.
3. **Signing (parallel):** T120, T121, T124, T123, T122.
4. **Anchoring (parallel):** T130, T131, T132, T133, T134, T135.
5. **Verifier (parallel from step 2):** T140, T141, T142, T143, T144, T147, T145, T146.
6. **Conformance:** T148.
7. **Live + sign-off:** T160, T161, T162, T163, T164.

## 8. Sprint Allocation & Milestone Mapping

| Iteration | Focus | Tasks | Milestone | Exit |
|---|---|---|---|---|
| **S2.1** | Schemas + WORM store + seal/chain | T101–T108, T110–T116 | **M-A**, **M-B** | Deterministic sealed chain in WORM; rig GATE green |
| **S2.2** | Signing + anchoring | T120–T124, T130–T135 | **M-C**, **M-D** | Heads signed + anchored only after verified token; no-fabrication gate green |
| **S2.3** | Verifier + conformance | T140–T148 | **M-E** | Offline verifier PASS; WV-1…WV-14 green; isolation gate green |
| **S2.4** | Live + sign-off | T160–T164 | **M-Live** | Live PASS + tamper drills; security sign-off GO |

## 9. GitHub / Jira Labels

`epic:E2A-evidence-store` · `epic:E2B-seal-chain` · `epic:E2C-signing` · `epic:E2D-anchoring` · `epic:E2E-verifier` · `epic:E2F-live-signoff`
`area:worm` `area:evidence` `area:signing` `area:anchoring` `area:verifier` `area:conformance` `area:ci-gate` `area:compose`
`prio:P0` `prio:P1` `prio:P2` · `type:feature` `type:gate` `type:schema` `type:docs` `type:test`
`risk:determinism` `risk:security` `risk:worm-immutability` `risk:key-custody` `risk:external-dep` `risk:isolation` `risk:no-fabrication` `risk:live-io`
`inv:INV-EV-1`…`inv:INV-EV-7` · `ac:A-EV1`…`ac:A-EV11` · `wv:WV-1`…`wv:WV-14`

## 10. Definition of Ready (DoR)

A task is **Ready** when: it traces to a plan §/spec § and ≥1 AC; dependencies are identified; estimate + priority assigned; acceptance criteria + conformance IDs listed; risk tags applied; it does **not** require any constraint-violating scope (no dashboard/risk-engine/business-projection/reversal/CCE change); test approach (unit/conformance/live) is named.

## 11. Definition of Done (DoD)

A task is **Done** when: code + tests merged on the feature branch; **all Sprint-1 gates remain green and unchanged**; its conformance tests (if any) pass; typecheck + lint (0 warnings) + coverage thresholds met; new schemas are vendored verbatim + provenance-gated; no secret/private-key/plaintext leak; the relevant CI gate is green; its ACs are demonstrably satisfied; docs updated where applicable. An **epic** is Done when its milestone exit criteria + mapped ACs + WV tests pass.

## 12. Go / No-Go Gates

**Per-milestone Go:**
- **M-A:** T101–T107 done; `evidence-schemas-verbatim` + `worm-no-mutate-proof` green.
- **M-B:** T110–T115 done; `evidence-determinism` cross-target MATCH; genesis/cross-link correct (WV-9/11).
- **M-C:** T120–T121, T124 done; signatures verify offline; `signing-key-hygiene` green.
- **M-D:** T130, T131(or T132), T133–T135 done; ANCHORED only after verified token; `anchor-no-fabrication` green (WV-13).
- **M-E:** T140–T148 done; offline verifier PASS; `verifier-isolation-proof` green; WV-1…WV-14 green.
- **M-Live:** T160–T164 done; live PASS + all tamper drills fail-as-expected; security sign-off GO.

**No-Go triggers (any one blocks the sprint):** verifier needs EDAM software/secret/online API (INV-EV-5); ANCHORED set without a verified external token (INV-EV-3); writer can mutate/delete WORM (INV-EV-1); a fabricated token/hash/OK on failure (INV-EV-6); non-deterministic `manifest_hash`/`segment_hash`; any Sprint-1 gate weakened; any dashboard/risk-engine/business-projection/reversal/CCE-semantic change introduced.

---

## 13. T104 MinIO Adapter Hardening — Tracked Findings (from the accepted adversarial review)

The T104 adversarial review was **accepted** (verdict: APPROVE WITH CHANGES; T106 proceeds). T104 is a **dev** adapter; its committed implementation is **not** modified now. The findings below are tracked as Epic-E2A hardening tasks that **must be closed before the Sprint-2 live evidence validation + security sign-off (T160–T164)** and before any production WORM claim (H1/H2 are Critical in production). None requires a `WormStore` contract, CCE, or architecture change.

### 13.1 Hardening backlog items (H1–H5)

| ID | Title | Description | Dependencies | Priority | Est | Acceptance criteria | Risk tags | Maps to | Blocks |
|---|---|---|---|---|---|---|---|---|---|
| **EDAM-T104-H1** | Distinct MinIO credentials per identity | Replace the single-credential `MinioWormConfig`/`Client` with **three credential sets** (writer/reader/retention-admin) and three `Client`s under distinct IAM policies, so the writer connection is physically incapable of delete/overwrite/retention/legal-hold-lift. Adapter-local; **no `WormStore` contract change**. | T104 | P0 | 5 SP | Writer credential cannot delete/overwrite/alter-retention/lift-hold (verified against MinIO with that credential, 403); reader cannot write; admin is a separate credential. | `#security` `#key-custody` `#worm-immutability` | INV-EV-1, W-8, A-EV11 | T164 |
| **EDAM-T104-H2** | Version-scoped delete enforcement | Stop deleting via delete markers; operate on **specific versionIds** so MinIO COMPLIANCE actually blocks the delete; correct the inaccurate "final authority" comment. | T104 | P0 | 3 SP | A version-scoped delete of a locked object is rejected by MinIO (403); no delete-marker hide path remains in `deleteExpired`. | `#worm-immutability` `#no-fabrication` | W-7, A-EV1, A-EV8 | T162, T164 |
| **EDAM-T104-H3** | Bucket Object-Lock verification | On `ensureBucket`/startup, assert `getObjectLockConfig` shows lock **Enabled**; **refuse to operate** on a non-lock bucket (object lock cannot be enabled post-creation). | T104 | P0 | 2 SP | Pointing the adapter at a non-lock bucket fails fast with a WormError; lock-enabled is asserted, not trusted. | `#worm-immutability` `#external-dep` | W-1, W-2, A-EV1 | T161, T164 |
| **EDAM-T104-H4** | Mandatory/default retention policy | Enforce a default/minimum COMPLIANCE retention (or require `retainUntil` for the writer) so no object can be written unlocked. | T104 | P1 | 2 SP | A write without `retainUntil` either applies the default retention or is rejected; no "no-lock" object is producible by the writer. | `#worm-immutability` | W-2, A-EV1 | T164 |
| **EDAM-T104-H5** | Store-level enforcement tests | Add integration tests that **bypass the adapter pre-check** (call the raw client) and assert MinIO returns 403 on (a) version-scoped delete of a locked object, (b) earlier-date retention, and (c) delete under legal hold; add a no-`retainUntil` test documenting/closing the gap. | T104, H1–H4 | P0 | 3 SP | W-3/W-7/shortening are proven at the **store** level (MinIO 403), not via the adapter guard. | `#worm-immutability` `#security` | WV-8, A-EV8, A-EV11 | T162, T164 |

Secondary (review M/L items, folded in): **M4** narrow `exists()` to treat only `NoSuchKey` as absent; **L1** pin `minio` to an exact version + image digest, wrap the legal-hold runtime quirk in a typed guard. (Tracked under H1–H5 scope; not separately scheduled.)

### 13.2 Finding → Risk → Sign-off-prerequisite map

| Review finding | Risk | Closed by | Sign-off prerequisite (T160–T164) |
|---|---|---|---|
| **H1** single privileged credential; runtime-bypassable role model | **R1** compromised Domain-B process hides/supersedes evidence at the read path | EDAM-T104-H1 | **T164** must verify INV-EV-1 against per-role credentials (writer credential proven incapable of mutation) |
| **H2** delete-marker hide; "final authority" comment wrong | **R1** | EDAM-T104-H2 | **T162** delete-drill must show MinIO 403 (store-level), not adapter pre-check |
| **H3** object-lock-enabled not verified | **R2** non-lock bucket → silently mutable evidence | EDAM-T104-H3 | **T161** live harness must boot against a verified-lock bucket; **T164** asserts lock config |
| **H4** `retainUntil` optional → no-lock writes | **R2** | EDAM-T104-H4 | **T164** asserts no unlocked object is producible |
| **H5** "blocks deletion/shorten" verified via adapter guard, not MinIO | **R3** false confidence (green tests imply MinIO enforcement) | EDAM-T104-H5 | **T162** tamper/deletion drills must exercise **store-level** enforcement |

### 13.2a T106 evidence-writer follow-ups (from the accepted T106 adversarial review)

T106 review verdict: APPROVE WITH CHANGES. The two **High** findings were closed in `fix(edam): close T106 high findings`:
- **F-H1 (closed):** `EvidenceWriter` now rejects any CCE lacking well-formed, verifying integrity evidence (`evidence.event_hash` + `evidence.row_hash`, validated via `isHashToken` + `verifyCce`) → DLQ `SCHEMA_VALIDATION_FAILURE`, no WORM write.
- **F-H2 (closed):** validation/`verifyCce`/serialization run in a protected `prepare()` block; any canonical-serialization throw → DLQ `SERIALIZATION_FAILURE`, no WORM write, no uncaught throw from `append` (except DLQ-persistence failure, F-L1).

Still tracked (no fix yet — none is closable without a content-aware WORM read, which would change `WormStore`):

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **EDAM-T106-FM1** | Medium | Benign idempotent replay (same content/key) is DLQ'd as `UNEXPECTED_EXCEPTION` + alarmed. | Needs a content-equality read (no `WormStore` change now). Decide duplicate-vs-conflict semantics in E2B. Blocks: T162 (replay drills). |
| **EDAM-T106-FM2** | Medium | A genuine same-key/different-content conflict is under-classified as `UNEXPECTED_EXCEPTION` rather than a CRITICAL integrity event. | Same root as FM1; introduce a content-aware `putIfAbsentOrEqual` semantic in a later interface revision (deferred). Blocks: T162, T164. |
| **EDAM-T106-FL1** | Low | `append` rejects if DLQ persistence itself fails; documented in `writer.ts` (no silent drop — the failure surfaces). | Documentation done; no further action. |

### 13.2b E2B-CHAIN-1 — chain establishment (surfaced by T112/T113)

**ID:** E2B-CHAIN-1 · **Status:** OPEN (owned by T114).

**Description:** T112 and T113 successfully *verify* intra-segment and cross-segment row-hash continuity. However, **neither component establishes the chain** — the current ingest path still produces independently-generated CCEs (each `prev_row_hash = GENESIS`), so a real segment's chain is broken and both verifiers correctly fail closed on it.

**T114 is responsible for:**
- establishing the final ordered `prev_row_hash` linkage (re-derive each object's `prev_row_hash`/`row_hash` in global order from the boundary — the prior segment's `last_row_hash`, or the object-chain genesis for the first segment; `event_hash` is unchanged because it excludes `evidence`);
- producing the actual chain (and recomputing the hash-dependent segment metadata — `object_hash_list`, `first/last_row_hash`);
- writing objects to WORM at the final ordered placement (M-A-INT-1 / Option B);
- invoking T112 (intra-segment) and T113 (cross-segment) verification **before** seal completion, failing closed (VERIFICATION_FAILED + CRITICAL alarm) on any mismatch.

No code change required by this note — **tracking only**. T112/T113 are not modified.

### 13.2c E2B-SEAL — seal-step findings (from the accepted T114 adversarial review)

T114 review verdict: APPROVE WITH CHANGES (E2C may proceed). The following are tracked; **not fixed now**. They **do not block E2C signing-layer development**, but they **block live validation / security sign-off (T160–T164)**. Resolution may require a **content-aware idempotent WORM write path** (e.g. a `putIfAbsentOrEqual` design / a `WormReader`) — shared root with T106-FM1/FM2.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2B-SEAL-H1** | High | **Non-atomic / non-idempotent partial seal can wedge a segment chain.** WORM writes are not transactional: object writes may succeed before the manifest write fails (objects orphaned, immutable, undeletable); a manifest may succeed before `emitHead` fails. Re-seal currently **fails** at the first existing object instead of **resuming**, so the segment can never complete — wedging the db_id's contiguous chain. `WRITE_FAILED` also omits the already-written `object_keys`. | OPEN. Make the seal idempotent/resumable (tolerate identical existing objects; treat an existing manifest as seal-complete); return already-written keys. **Must resolve before T160–T164.** Shares root with FM1/FM2. |
| **E2B-SEAL-M1** | Medium | `emitHead` is unguarded and can throw **after** the WORM writes — `seal()` then rejects, leaving a sealed-but-unsignaled segment. | OPEN. Wrap `emitHead` (best-effort); let the signing stage **pull** the head from the stored manifest (`deriveSegmentHead`). |
| **E2B-SEAL-M2** | Medium | `EvidenceWriter.append` / DLQ-persistence rejection (F-L1) can **escape** the seal flow (uncaught rejection mid-write). | OPEN. Wrap `append` calls; surface a clean `WRITE_FAILED`. |
| **E2B-SEAL-M3** | Medium | Re-seal / replay is **not idempotent** — a re-seal of an already/partly-sealed segment returns `WRITE_FAILED` rather than a no-op SEALED. | OPEN. Inherits FM1; resolve with H1. |
| **E2B-SEAL-M4** | Medium | Manifest/object **retention remains optional** in the sealer's `putOptions` and inherits **T104-H4** (a sealer without `retainUntil` writes evidence with no retention → mutable on a real backend). | OPEN. Enforce/default retention (with T104-H4). |

**Notes (binding):** these findings **do not block E2C / T120** (the signing layer consumes the emitted/derivable chain head and is independent of seal atomicity). They **do block** the Sprint-2 live evidence validation and security sign-off (T160–T164) — the live tamper/outage drills (T162) and durability claims would otherwise hit a wedged partial seal. Resolution may introduce a future **content-aware idempotent WORM write path / `putIfAbsentOrEqual`** (no `WormStore` contract change is being made now).

### 13.2d E2C-SIGN — signing-layer findings (from the accepted T120 adversarial review)

T120 review verdict: APPROVE WITH CHANGES — H1/M1 (and M2/M3) to be closed **in T121** (do not ship a generic oracle).

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2C-SIGN-H1** | High | `Signer.sign(payload: Uint8Array)` is a **generic signing oracle**; "signs a hash structure only" (INV-EV-2) is convention-only. | **Close in T121.** Change the interface so the signer accepts an `AnchorPayload` and canonicalizes internally; the dev signer must not sign arbitrary bytes. |
| **E2C-SIGN-M1** | Medium | **No domain separation** on the signed bytes. | **Close in T121.** Sign over a fixed domain tag `edam-anchor-payload-v1` + canonical payload. |
| **E2C-SIGN-M2** | Medium | Anchor-payload validation gaps. | **Close in T121.** Validate before signing: `signed_at` non-empty RFC3339; `segment_sequence` integer ≥ 0; `db_id`/`segment_id` non-empty (in addition to the existing hash-token + `head_count` checks). |
| **E2C-SIGN-M3** | Medium | Algorithm binding. | **Address in T121 verify helper / T2E.** Verification must use the **published public key's** algorithm; reject unknown `signing_key_id`; reject algorithm mismatch; (and honor `revoked_at` vs `signed_at`). |
| **E2C-SIGN-L1** | Low | Anchor payload not in the cross-target determinism gate. | Add to the T115 evidence-determinism rig. |
| **E2C-SIGN-L2** | Low | No dependency-isolation gate for `@edam/signing`. | Add a `signing` isolation check (alongside the T147 verifier-isolation gate). |
| **E2C-SIGN-L3** | Low | Isolated verifier (T2E) must reuse/re-specify the anchor-payload canonicalization. | The T121 verify helper (pure; `@edam/canonical` + `node:crypto` only) is reusable by the isolated verifier; confirm under T147. |

### 13.2e E2C-SIGN — signing-layer findings (from the accepted T121 adversarial review)

T121 review verdict: APPROVE WITH CHANGES — H1/M1/M2/M3 closed for the typed happy path; one Medium residue + Low hardening. T122 may proceed; **M4 to be fixed in the shared `anchor-payload.ts` before T122 starts** so the HSM signer inherits the fix.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2C-SIGN-M4** | Medium | **Extra-property smuggling into the signed message** (partial H1/INV-EV-2 residue). `assertValidAnchorPayload` checks the 7 known fields but does **not** reject unknown keys, and `anchorSigningMessage`/`serializeAnchorPayload` serialize the caller object **as-is** via `serializeCanonical`. A caller crossing the trust boundary with `({...validPayload, leaked: '<plaintext>'} as AnchorPayload)` passes validation and the extra field is canonicalized **into the signed bytes** (still verifies). The signer is no longer a byte-oracle but remains a **structured oracle** for arbitrary extra content. | **Fix before T122 in shared `anchor-payload.ts`.** (1) Reject unknown keys (exact key-set validation) **and** (2) reconstruct a clean exact 7-field payload before signing and verification. T122 (HSM) inherits the fix via the shared validation/canonicalization path. |
| **E2C-SIGN-L4** | Low | `signed_at` RFC3339 validation is **structural only** (regex); impossible instants such as `2026-13-45T99:99:99Z` pass. `signed_at` is signature-bound and downstream schema validation would likely reject it, so impact is low. | Pair the regex with real instant validation (`Number.isFinite(Date.parse(signed_at))` / component-range check). Hardened alongside the M4 fix (low-risk). |
| **E2C-SIGN-L5** | Low | `verifyAnchorSignature` trusts caller-supplied `PublicKey.signing_key_id` without recomputing the content-addressed id. Safe under the trusted-registry model, but cheap to harden. | Recompute `deriveKeyId(public_key)` and compare to `signing_key_id` (and to the signature's id) inside `verifyAnchorSignature`. Hardened alongside the M4 fix. |
| **E2C-SIGN-L6** | Low | No explicit tests for **modified-signature bytes** and **signature-substitution** (valid signature from a different payload/key). Both fail cryptographically today; lock the behavior. | Add the two verification-fails tests alongside the M4 fix. |
| **E2C-SIGN-L7** | Low | `anchorPayloadBytes` (un-domain-separated) is exported beside `anchorSigningMessage`; a future caller could sign/verify the wrong "bytes". | Add a cross-warning doc-comment and/or restrict usage to the determinism rig. |
| **E2C-SIGN-L8** | Low | Domain separation is **prefix-based** (`tag:` + canonical JSON). Adequate for a single fixed domain; could be prefix-ambiguous if more domains are added. | Record as a future **multi-domain signing** consideration (length-prefixed/structured domain) for when additional signed structures are introduced. |

### 13.2f E2C-SIGN — signing-layer findings (from the accepted T122 adversarial review)

T122 review verdict: APPROVE WITH CHANGES — HSM boundary correct (no private material, no real PKCS#11 pulled in, AnchorPayload-only + domain-separated signing, M4/T121 hardening inherited, fail-closed errors, clean isolation, no-caller-change swap proven). One Medium verification-compatibility gap + Low hardening. **T123 may proceed**; M5 is closed in the isolated-verifier work (not T123); L10 folds into T123's revocation scope.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2C-SIGN-M5** | Medium | **Verification-compatibility gap.** `Pkcs11Signer` can advertise algorithms from the anchor-record-1.0 enum — `ecdsa-p384` / `rsa-pss-3072` / `ecdsa-p256` — but the shipped `verifyAnchorSignature` supports **Ed25519 only** (`publicKey.algorithm !== 'ed25519' ⇒ false`). Non-Ed25519 HSM signatures would be **emitted but not offline-verifiable by shipped code**, conflicting with A-EV4/WV-5 ("signatures verify offline with the public key"). Tolerable for the T122 stub (dev path is Ed25519) but must be closed. | **Close in isolated-verifier work T2E / T143 / T148** (extend verify to the configured algorithms), **or** constrain the HSM signer/factory to verifier-supported algorithms until then. Not T123. |
| **E2C-SIGN-L9** | Low | Adapter returns the provider's signature **unverified**; a faulty/compromised provider yields an un-verifiable signature caught only downstream (WV-5). | Add an optional **sign-then-verify self-check** in `Pkcs11Signer.sign` for verifier-supported algorithms (fail fast; upholds fail-closed / no-fabrication). |
| **E2C-SIGN-L10** | Low | Signer does **not** check `revoked_at` at sign time — it will sign with an already-revoked key and rely on the verifier to reject. | Consider **fail-closed signing with already-revoked keys**. Coordinate with the **T123** rotation/revocation scope. |
| **E2C-SIGN-L11** | Low | No tests for `provider.sign` throwing (HSM signing failure), provider returning a malformed signature, or a throwing registry. Behavior (propagate / fail closed) appears correct but is unproven. | Add the three failure-path tests. |
| **E2C-SIGN-L12** | Low | For opaque HSM key ids there is no content-addressing, so the key-id↔material binding relies **entirely on registry integrity**. | **Document the published public-key registry as a trust root** for opaque HSM key ids. Relevant to T123/T2E. |
| **E2C-SIGN-L13** | Low | Provider/registry failures propagate as raw errors (no typed wrapper), hindering alarm classification (INV-EV-6). | Consider a typed **`Pkcs11SigningError`** wrapper for provider/registry failures. |

### 13.2g E2C-SIGN — signing-layer findings (from the accepted T123 adversarial review)

T123 review verdict: APPROVE WITH CHANGES — registry correct, immutable, fail-closed, public-only; both ACs met (verifier-consumable `revoked_at`; rotation never invalidates prior anchors); dual-control honestly stubbed/documented. All findings Low. **T124 may proceed**; L14 closes in the isolated-verifier work (not T124); L18 tracks alongside M5.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2C-SIGN-L14** | Low | **Verification completeness.** The registry models the validity window `[created_at, revoked_at)` (`statusAt`/`isValidAt`), but `verifyAnchorSignature` checks **only** `revoked_at`. A signature whose `signed_at` precedes the key's `created_at` is rejected by `registry.isValidAt` yet accepted by the crypto verifier, so `created_at` is advisory until the verifier consumes it. | **Offline verification MUST enforce the full window:** `verifyAnchorSignature(...)` **AND** `registry.isValidAt(signing_key_id, signed_at, algorithm)` (created_at **and** revoked_at semantics). Close in isolated-verifier work **T2E / T143 / T148**. |
| **E2C-SIGN-L15** | Low | **No automatic sign-time revocation linkage.** Using a `KeyRotationRegistry` as a `Pkcs11Signer`'s `PublicKeyRegistry` does not give sign-time revocation: the signers never call `assertSignableActiveKey`. | The **anchoring stage must call `assertSignableActiveKey(signed_at, algorithm)` before signing**, or a revoked/not-yet-valid active key check is bypassed. Track for **T130+** integration. |
| **E2C-SIGN-L16** | Low | **Backdated revocation.** `revoke(id, …, revokedAt)` accepts any `revokedAt >= created_at`; setting it to `created_at` makes every signature by that key fail. Legitimate for compromise-from-a-past-instant, but powerful and bounded only by the (stubbed) dual-control. | **Document backdated revocation semantics** and its impact on historical signatures (effective-from); governed by real dual-control (deferred). |
| **E2C-SIGN-L17** | Low | **Dual-control stub is structural only** (non-empty + `requestedBy != approvedBy`). | **Explicitly document the limits:** no authentication, no authorization, no audit trail, no replay protection — **not a security control**; real dual-control + WORM custody log is a deferred Domain-C control. |
| **E2C-SIGN-L18** | Low | **Crypto-free registry does not bind declared `algorithm` to `public_key` material** (e.g. an `ecdsa-p384` record with ed25519 material is accepted; caught only at verify). Inherent to the crypto-free design. | The **verification layer owns algorithm↔material binding.** Track alongside **E2C-SIGN-M5**. |
| **E2C-SIGN-L19** | Low | **Test gaps.** The `revoke()`-path timestamp guards (`isRealInstant(revokedAt)`, `revokedAt < created_at`), frozen-record immutability, and the L14 created_at validity-window divergence are untested (guards exist; behavior correct). | **Add future tests:** revoke timestamp guards; frozen-record immutability; created_at validity-window behavior. |

### 13.2h E2C-SIGN — signing-key-hygiene gate findings (from the accepted T124 adversarial review)

T124 review verdict: APPROVE WITH CHANGES — runtime custody proof thorough and correct; positive controls mandatory + fail-closed; ACs met; false positives well-controlled. Findings are gate-hardening + CI-wiring. **These findings do not block T130.** Current protection still runs through the vitest test (a real leak fails CI), but a dedicated CI proof job is required. **E2C-SIGN-MCI must be closed before T164**; **MFN1/MFN2 should be closed before live validation / security sign-off**.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2C-SIGN-MCI** | Medium | `signing-key-hygiene` exists as an npm script + vitest test but is **not wired as a dedicated CI job** (with `-- --check --report` and proof-artifact upload) like its five sibling proof gates. The `--check` exit contract and published artifact are unenforced in CI; protection currently rides on the vitest test. | **Add a `signing-key-hygiene` CI job** mirroring `secret-hygiene` (`npm run signing-key-hygiene -- --check --report` + artifact upload). **Must be closed before the T164 security sign-off.** |
| **E2C-SIGN-MFN1** | Medium | Static scan detects **PEM-armored** private keys but misses **base64/hex private-key assignments** (e.g. `PRIVATE_KEY=<base64>`, `SIGNING_PRIVATE_KEY=<hex>`) — a realistic env leak form. | **Add env/compose/source private-key-token assignment detection** (token + inline base64/hex value). Close before live validation / security sign-off. |
| **E2C-SIGN-MFN2** | Medium | `PRIVATE_KEY_EXPORT` is **single-line only**; a multi-line `.export({ type: 'pkcs8' })` may evade detection. | **Normalize/join source before matching** (whitespace-insensitive). Close before live validation / security sign-off. |
| **E2C-SIGN-L20** | Low | Custom logger calls (e.g. `logger.info(privateKey)`, pino/winston) are not covered (shared limitation with `secret-hygiene`). | Consider covering custom-logger call sites. |
| **E2C-SIGN-L21** | Low | Scanned roots exclude `tools/`, `apps/`, and `conformance/`. | Broaden scanned roots (mind self-flag exclusion for `conformance/`). |
| **E2C-SIGN-L22** | Low | JWK private (`"d":`) / raw-DER private-key forms are not detected. | Add JWK/raw-DER private-key detection. |
| **E2C-SIGN-L23** | Low | CLI `void main()` has no `.catch`; an unexpected throw would not set a non-zero exit. | **Add `.catch` to guarantee non-zero exit** on unexpected throw. |
| **E2C-SIGN-L24** | Low | Per-line rules strip only `//`; a `.export(…pkcs8…)` inside a `/* */` block comment could false-positive. | Handle block comments to avoid minor false positives. |

### 13.2i E2D-ANCHOR — anchoring findings (from the accepted T130 adversarial review)

T130 review verdict: APPROVE WITH CHANGES — abstraction clean, isolated (canonical + signing only), hash-only at the provider boundary (no plaintext), pluggable, fail-closed with no fabrication possible by construction; failure matrix thoroughly tested. **These findings do not block T131.** M1 must be addressed by **real provider verification in T131** and by the **independent verifier (T2E)**; **L1/L2 should be closed before the anchor-record builder / real-provider integration hardens**; the **fake provider must remain clearly non-authoritative**.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2D-ANCHOR-M1** | Medium | **Anchoring-time `verifyToken` is provider self-attestation.** `requestAnchor` gates ANCHORED on `provider.verifyToken`; a **compromised in-process provider** could return a fabricated token plus `verifyToken=true`. Not a T130 interface defect, but must be carried forward. | **Real providers (T131) must verify actual TSA / CT / external-authority signatures** (not self-attest). **Authoritative, trust-minimized verification belongs to the independent verifier (T2E)**, re-checking tokens offline against published external public keys / certs from **WORM**, never via the provider object. |
| **E2D-ANCHOR-L1** | Low | `isWellFormedToken` is **stricter than `anchor-record-1.0`**: the schema leaves `transparency_log` / `dual_custodian` sub-fields **optional**, but the guard requires all of them — a schema-valid real token could be rejected. | **Align with schema optionality** (or deliberately tighten the schema) **before real providers** land. |
| **E2D-ANCHOR-L2** | Low | `anchored_at` is validated only via `Date.parse`, **not strict RFC3339**, while the record schema uses `format: date-time`. | **Tighten `anchored_at` validation before anchor-record building** (avoid late schema failures). |
| **E2D-ANCHOR-L3** | Low | `FakeAnchorProvider` verification is **non-cryptographic** (recomputable commitment, no secret; provider-asserted `anchored_at`). | **Dev/test double ONLY — must never be treated as authoritative.** Live validation must use real providers + the independent verifier. |
| **E2D-ANCHOR-L4** | Low | `dual_custodian` currently models a **single custodian** because the vendored schema cannot represent true two-custodian / 2-of-2 semantics. | Track for the **future `dual_custodian` implementation**. |
| **E2D-ANCHOR-L5** | Low | **Timeout race** drops a late-but-valid provider response as `pending`. | Relies on **idempotent retry / re-request in T134** (re-request over the same hash). |
| **E2D-ANCHOR-L6** | Low | No explicit tests that provider-returned `pending` / `failed` outcomes **pass through unchanged**. | **Add the pass-through tests.** |

### 13.2j E2D-ANCHOR — RFC-3161 provider findings (from the accepted T131 adversarial review)

T131 review verdict: APPROVE WITH CHANGES — cryptographically sound dev TSA: real Ed25519-signed RFC-3161-modeled token + a pure, cert-parameterized verifier detecting every tamper/forgery/replay variant; hash-only input; non-exportable TSA key. **These findings do not block T132; T132 may proceed.** The **M1 residual must be closed by T2E** (verify against a trusted published TSA cert) **before independent-verifier sign-off**. The **fake/dev TSA must never be treated as production authority**.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2D-ANCHOR-M1-RESIDUAL** | Medium | T131 closes **real token generation + a pure cert-parameterized verification** (`verifyRfc3161Token`). **M1 is not fully closed:** `requestAnchor` still trusts `provider.verifyToken` (the provider's **self-held** cert) at anchoring time, so a compromised in-process provider can self-attest a fabricated token. | **Full closure requires T2E** to verify against a **trusted published TSA-certificate source** (resolved from `tsa_cert_ref` via a registry / WORM), **not the provider object**. **T132 should begin the cert-publication / cert-reference plumbing if in scope.** Must be closed by T2E before independent-verifier sign-off. |
| **E2D-ANCHOR-L7** | Low | TSA **certificate validity window is not modeled**; `verifyRfc3161Token` does not check `gen_time` within certificate validity. | Track for **T2E / real RFC-3161 provider** work (enforce `gen_time ∈ [not_before, not_after]`). |
| **E2D-ANCHOR-L8** | Low | TSA **certificate revocation is not modeled**. | Track with the **certificate registry / verifier** work (mirror the signing layer's `revoked_at` semantics). |
| **E2D-ANCHOR-L9** | Low | `tsa_cert_ref` exists in the token, but **no trusted published cert registry exists yet**. | **T132 / T2E must define how `tsa_cert_ref` resolves to trusted public certificate material.** |
| **E2D-ANCHOR-L10** | Low | No explicit **`gen_time` tamper test** (signature covers it today, but lock the behavior). | Add the gen_time-tamper test. |
| **E2D-ANCHOR-L11** | Low | No **T2E-style test** where the certificate is obtained from a **separately published source**, not `provider.getCertificate()`. | Add the published-cert verification test. |
| **E2D-ANCHOR-L12** | Low | **Provider outage / timeout pass-through** is not covered on the real/dev RFC-3161 path. | Cover via the real/dev RFC-3161 provider path or service-level tests (with E2D-ANCHOR-L6). |

### 13.2k E2D-ANCHOR — transparency-log provider findings (from the accepted T132 adversarial review)

T132 review verdict: APPROVE WITH CHANGES — RFC 6962 Merkle construction + verification correct (proper 0x00/0x01 prefixes; hand- and round-trip-verified); both ACs met with real crypto; proof shape matches `anchor-record-1.0`; clean isolation; every tamper/forgery/replay variant fails closed. **CT1 does not block T133; T133 may proceed.** **CT1 must be addressed during T2E / production-grade transparency-log validation.** **M1 remains only PARTIALLY closed** — full closure requires (1) a **trusted published log/TSA certificate source**, (2) **independent verification** (T2E) against that source (not the provider object), and (3) for `transparency_log`, a **consistency / anti-equivocation strategy**.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2D-ANCHOR-CT1** | Medium | **Transparency-log equivocation / split-view.** Inclusion-to-a-signed-STH proves "the log signed an STH whose tree includes P," **not** that P is in a single canonical append-only log. A compromised/malicious log can sign **divergent STHs** (different roots) to different parties; inclusion proofs alone do **not** detect this. | **Does NOT block T133.** **Address during T2E / production-grade transparency-log validation:** STH **consistency proofs + gossip**, and/or **multiple providers** / `dual_custodian` for high-value. Weakens the trust-minimized guarantee for `transparency_log` until then. |
| **E2D-ANCHOR-CT2** | Low | No trusted cert registry to resolve **`log_id` → log public cert** (transparency-log analog of E2D-ANCHOR-L9). | Fold into the **anchor-authority cert-registry** work (T2E); generalize L9 to "anchor authority cert". |
| **E2D-ANCHOR-CT3** | Low | Log cert has **no validity window / revocation** (analog of L7/L8 for the log cert). | Track with cert-registry / verifier work (enforce `sth_time ∈ validity`; honor revocation). |
| **E2D-ANCHOR-CT4** | Low | No explicit **proof-length bound** in `rootFromInclusion` (cryptographically safe via root comparison; defense-in-depth only). | Add an audit-path length check for the `(leaf_index, tree_size)` as hardening. |
| **E2D-ANCHOR-CT5** | Low | `merkleTreeHash` recomputes the whole tree per append (O(n²)) and `#leaves` grows unbounded in memory — **dev-only perf/memory**, not correctness. | Use an incremental Merkle tree + persistence for a production CT log. |
| **E2D-ANCHOR-CT6** | Low | The internal `TransparencyLogProof` type is **not exported** (ergonomics; structurally compatible with the exported proof shape). | Export the proof type (or reuse the `AnchorProviderProof` transparency_log variant) for T2E reuse. |
| **E2D-ANCHOR-CT7** | Low | **Outage / timeout pass-through** not tested on the transparency-log provider path (analog of E2D-ANCHOR-L12). | Add the pass-through coverage on the CT path. |

### 13.2l E2D-ANCHOR — anchor-record builder findings (from the accepted T133 adversarial review)

T133 review verdict: APPROVE WITH CHANGES — the builder faithfully matches the vendored `anchor-record-1.0`, enforces the head↔token binding by recomputing `anchorPayloadHash`, refuses pending/failed outcomes (no structural fabrication), validates every record, and produces a cce-1.1-compatible `anchor_ref`; clean isolation. **No Critical findings. No High findings.** **T134 may proceed.** **AR6 MUST be addressed within T134.** **AR1 and AR2 remain tied to the T2E trust-boundary work** (independent re-verification against a trusted published cert/key source, plus an `anchored_at` cross-check). INV-EV-3 is enforced **transitively** (via `requestAnchor` + the signing layer + the builder), **not independently by the builder alone**.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **E2D-ANCHOR-AR1** | Medium | **Builder trusts the `anchored` outcome; it does not independently re-verify the provider token or the HSM signature.** The only independent cryptographic check is head↔`payload_hash`. A hand-constructed `{status:'anchored', token}` with a matching `payload_hash` (bypassing `requestAnchor`) yields a schema-valid record with no cryptographic re-verification. INV-EV-3 is enforced **transitively**, not by the builder. | **Tied to T2E / E2D-ANCHOR-M1.** Document the builder contract (input MUST be a `requestAnchor`-sourced `anchored` outcome + a verified signature) and/or add an optional re-verify hook (provider/cert + published key). **T2E must independently re-verify the token + HSM signature against trusted published cert/key sources.** |
| **E2D-ANCHOR-AR2** | Medium | **`anchored_at` (the external authority's asserted instant) is not persisted as a record field.** The vendored `anchor-record-1.0` schema omits it (+`additionalProperties:false`), conflicting with the backlog description; the asserted instant is only recoverable by decoding the opaque token and is not cross-checked at the record level. | **Tied to T2E trust-boundary work.** Decide explicitly: extend the vendored schema to carry `anchored_at` (vendor/schema change, out of T133 scope), **or** document that T2E decodes and cross-checks `gen_time` / `sth_time` against the record. |
| **E2D-ANCHOR-AR3** | Low | **No signing-key revocation/validity check** — the builder records `hsm_signature.revoked_at` only if the caller supplies it; a revoked-key signature can be recorded as ANCHORED. | Enforce signing-key validity/revocation at the lifecycle/registry layer (mirror the signing layer's `revoked_at` semantics); T2E honors it. |
| **E2D-ANCHOR-AR4** | Low | **`anchor_ref` is a pointer, not self-sufficient** — no `anchor_id` / `tsa_cert_ref` / `signing_key_id` / `algorithm`; bare `hsm_signature` string; for `transparency_log` no log proof at all. Independent verification requires loading the full anchor record (join by `head_hash`). By cce-1.1 design. | Document `anchor_ref` as a pointer/summary; the anchor record is the source of truth for verification. |
| **E2D-ANCHOR-AR5** | Low | **`anchor_ref` is not formally validated against cce-1.1 in code** (only structurally produced; tests assert regex/enum). | Add a validation step (or an embedded-CCE test) that runs the produced `anchor_ref` through cce-1.1 validation. |
| **E2D-ANCHOR-AR6** | Low | **Non-deterministic `anchor_id` (random UUID) and `created_at` (wall-clock now)** make the builder non-idempotent by default; compounded by the transparency-log provider appending a new leaf per `anchor()` call. | **MUST be addressed within T134:** make deterministic `anchor_id` / `created_at` and head-dedup a first-class design point (inject deterministic values and/or dedup by head **before** anchoring). |
| **E2D-ANCHOR-AR7** | Low | **Raw signing-layer error propagation** — a malformed `input.head` makes `anchorPayloadHash` (via `cleanAnchorPayload`) throw a raw `Error` before the typed builder checks; fail-closed but inconsistent error typing. | Wrap head validation in a typed builder error for consistent failure semantics. |
| **E2D-ANCHOR-AR8** | Low | **`anchor-record-1.0` `transparency_log` schema laxity** — inner fields are not `required` and the sub-object lacks `additionalProperties:false`; a record whose token is missing inner proof fields would still pass record-schema. Pre-existing; relevant to T2E. | Tighten the vendored schema's `transparency_log` `required`/`additionalProperties` (schema/vendor change) and/or have T2E enforce inner-field presence. |

### 13.2m E2D-ANCHOR — retry/backoff + cadence findings (from the accepted T134 adversarial review)

T134 review verdict: APPROVE WITH CHANGES — correct, well-tested, no-fabrication retry/backoff; deterministic idempotent identity (UUIDv5) with captured-once `created_at`, store dedup, and in-flight coalescing; correct N-or-T cadence; escalating un-anchored-window alarm. Upstream boundaries intact (T130 fail-closed guard, T133 head↔`payload_hash` binding, provider hash-only, signing separation); **AR1 and AR2 unchanged**. **No Critical findings. No High findings.** **AR6 is substantially closed** (deterministic identity, captured-once `created_at`, in-process idempotent replay, duplicate-record prevention). **Record-level idempotency is achieved.** **Provider-call-level idempotency across HA instances remains deferred** (T134-M1). **None of these findings block T135.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T134-M1** | Medium | **Cross-instance concurrency can produce duplicate provider calls and orphan transparency-log leaves before first-write-wins deduplication occurs.** In-flight coalescing covers a single coordinator only; two coordinators sharing a persistent store can both pass the pre-check and both call the provider before either stores — record-level idempotency holds (first write wins), but provider-call-level idempotency across instances does not. | **Deferred to the lifecycle / WORM integration:** add an atomic claim/lock on `anchor_id` (or a conditional persistent put) **before** `requestAnchor`. Single-coordinator scope is unaffected. |
| **T134-L1** | Low | **Alarm emission is level-triggered (no debounce / edge-trigger).** `UnanchoredWindowMonitor.check()` invokes `onAlarm` on every breached call, so a frequent poller produces repeated same-severity alarms. | Edge-trigger (emit on severity change) or debounce in the alerting layer. |
| **T134-L2** | Low | **No retry jitter (possible thundering herd).** Backoff is deterministic exponential with no randomization; multiple workers could synchronize retries against the external authority. | Add jitter to `nextBackoffMs` for production multi-worker deployments. |
| **T134-L3** | Low | **`token_verification_failed` is terminal and not retried.** A transiently-misbehaving provider returning one bad token is given up on (fail-closed by design). | Document the design decision; revisit if transient verification flakiness is observed. |
| **T134-L4** | Low | **`CadencePolicy` and `UnanchoredWindowMonitor` are pure in-memory objects and require an external scheduler.** "Cadence enforced" / "window alarms" need a lifecycle scheduler to poll `due()`/`check()` and drive the coordinator; their state is non-persistent. | Wire into the (deferred) anchoring lifecycle/state machine; persist counters/pending set as needed. |
| **T134-L5** | Low | **Non-monotonic clock behavior is not guarded.** Interval/age use raw subtraction; a backward clock could under-report due-ness/window age. | Inject a monotonic clock source for cadence/window timing. |
| **T134-RI1** | Low | **Cross-restart idempotency depends on a persistent store.** Deterministic identity survives restart, but deduplication does not with the default in-memory store (a restart would re-anchor under the same id with a new proof/`created_at`). | Achieved once a persistent store (WORM) is injected by the lifecycle; tighten the header comment which currently overstates "restarts reuse the same identity". |

### 13.2n E2D-ANCHOR — anchor-no-fabrication gate findings (from the accepted T135 adversarial review)

T135 review verdict: APPROVE WITH CHANGES — a correctly-bounded integration gate routing outage/timeout/malformed/fabricated scenarios through the **real** T130 guard, T134 coordinator, and T133 builder; symmetric across both implemented providers (rfc3161, transparency_log); confirms ANCHORED requires a verified record, a fabricating provider cannot persist a record, and T134 record-level idempotency is preserved (no extra transparency-log leaf). **No Critical findings. No High findings.** **The no-fabrication invariant is enforced by code (T130 guard + T133 builder), but the T135 gate PROOF is incomplete** (coverage + CI-wiring gaps below). **A fabricated provider cannot persist a record through the coordinator path.** **ANCHORED cannot be reached through the coordinator path without a verified anchor record.** **None of these findings block T136.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T135-M1** | Medium | **`anchor-no-fabrication` is not wired as a first-class CI job.** It runs indirectly via the vitest test (under `build-test`/`coverage`), but there is no dedicated `anchor-no-fabrication -- --check --report` CI job and no uploaded proof artifact (unlike the peer proof-gates `no-write-proof` / `evidence-schemas-verbatim` / `worm-no-mutate-proof` / `secret-hygiene`). The standalone gate contract (exit 1 on breach, proof artifact) is not CI-exercised. | Add a dedicated CI job invoking `npm run anchor-no-fabrication -- --check --report` and uploading the proof artifact (mirror the peer gates). `signing-key-hygiene` shares this gap. |
| **T135-M2** | Medium | **The regression-control test is tautological.** Test 3 constructs a local fake object and asserts JS array logic (`[{...}].length === 0` is false); it does **not** inject a real failure into `verifyAnchorNoFabrication`, so it does not prove the gate detects a regression (false assurance). | Replace with a genuine negative control that forces a check to fail inside `verifyAnchorNoFabrication` (fault injection) and asserts `proof.ok === false`. |
| **T135-M3** | Medium | **Gate coverage is incomplete:** (a) missing the mismatched-`payload_hash` fabrication vector (→ `hash_mismatch`); (b) missing the valid-token-for-wrong-payload vector; (c) recovery is proven only after **outage**, not after the timeout / malformed / fabricated-token paths. All are protected by the T130 guard and covered in T130/T134 unit tests, but the canonical no-fabrication gate does not assert them. | Add hash_mismatch and wrong-payload scenarios and recovery-after-each-failure-mode checks to the gate. |
| **T135-L1** | Low | **State derivation uses store presence ⇒ ANCHORED** and does not re-verify stored record contents. Sound here (the coordinator is the sole writer and stores only verified records) but the model trusts the store. | Document the assumption; revisit when the WORM-persisted lifecycle/state machine lands. |
| **T135-L2** | Low | **SEALED is not modeled in the gate** — only ANCHOR_PENDING (no record) and ANCHORED (record) are modeled; SEALED is an upstream sealing-service concern. | Model SEALED when the anchoring lifecycle/state machine is implemented. |
| **T135-L3** | Low | **Alarm escalation is only partially exercised** — the gate asserts a single warning-level breach; critical/emergency escalation is covered only in T134 unit tests. | Assert escalation tiers in the gate for stronger WV-13 coverage. |
| **T135-L4** | Low | **`generated_at` in the proof report is wall-clock and non-deterministic.** Cosmetic; not part of pass/fail (consistent with peer gates). | Optionally inject the clock for the report timestamp. |

### 13.2o E2E-EVIDENCE — `@edam/evidence` keystone findings (from the accepted T110 adversarial review)

T110 review verdict: APPROVE WITH CHANGES — the pure shared `@edam/evidence` keystone depends only on `@edam/canonical` + `@edam/contracts` + `@edam/cce-model` (no writer/WORM/signing-private/anchoring/DB/verifier imports); the moved manifest/chain/cross-segment/anchor-payload logic is behavior-preserving (diffs are signature/import-only + one cosmetic cast removal); a single canonical serializer with no second implementation; the `@edam/signing` shims preserve all consumers; the writer is clean-cut; no tracked finding silently touched. **No Critical findings. No High findings. No Medium findings.** **`@edam/evidence` is pure enough for verifier use.** **No hash or serialization drift occurred** (`anchorPayloadHash` pinned-identical; `manifest_hash`/`segment_hash`/row-chain identical by construction; determinism rig exit 0; all pre-existing tests pass unchanged). **T140 may proceed after this tracking commit.** **`@edam/anchor-proof` remains a separate prerequisite before T143, NOT before T140.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T110-L1** | Low | **No pinned absolute golden for `manifest_hash` / `segment_hash`.** `@edam/evidence` pins an absolute golden for `anchorPayloadHash`, but the manifest/segment hashes are proven only by recompute-consistency tests + the byte-identical source diff + the unchanged shared serializer + the determinism rig (serializer probe). Current proof is **sufficient for this migration**, but a future uniform regression would not be caught by an absolute pin. | **Defense-in-depth:** add pinned realistic `manifest_hash`/`segment_hash` goldens later (likely during T141/T148 hardening). Not blocking T140. |
| **T110-L2** | Low (informational) | **`@edam/signing` dependency surface grew.** `@edam/signing` now depends on `@edam/evidence`, transitively reaching `@edam/contracts` and `@edam/cce-model` (it was `@edam/canonical`-only). | **Accepted and intentional** (the approved trade for the shared keystone; signing is not verifier-isolation-constrained; no cycle; signing-key-hygiene green). Recorded as an informational dependency-surface change. |
| **T110-L3** | Low | **`@edam/evidence` manifest-hash unit test uses a synthetic core.** `evidence-core.test.ts` exercises `computeManifestHash` with a synthetic `{x,y}` object; the realistic manifest-core hashing path is covered only cross-package by the writer tests. | Add a realistic manifest-core golden later (likely during T141/T148 hardening; overlaps T110-L1). Not blocking T140. |

### 13.2p E2E-VERIFIER — `@edam/verifier` skeleton findings (from the accepted T140 adversarial review)

T140 review verdict: APPROVE WITH CHANGES — the public-inputs-only `@edam/verifier` skeleton is correctly isolated (transitive closure = `{canonical, contracts, evidence, cce-model, ajv, ajv-formats, node:crypto}`; no writer/signing-private/anchoring/DB coupling); locally-defined `WormReadPort`; schema-validating export-package loader; pure trusted-material directories; parse-only key/cert helpers; schema-valid report builder. **No Critical findings. No High findings.** **T140 accepted with changes.** **Verifier isolation requirements are satisfied.** **T141 may proceed after this tracking commit.** **T140-M1 MUST be fixed before any verifier implementation can legitimately emit a PASS result.** T140 advances but does not close M1/AR1 (no verification performed yet); no E2D finding is silently closed.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T140-M1** | Medium | **Skeleton `verify()` emits `overall_result: "PASS"` for an all-SKIPPED report (false-attestation risk).** The builder's rule is `FAIL iff any FAIL, else PASS`, so SKIPPED counts as passing; a partially-implemented `verify()` during T141–T143 would read PASS while skipping integrity checks (e.g., `hsm_signature` SKIPPED, overall PASS). **A fail-closed verifier must never report PASS when required integrity checks were skipped.** | **MUST be fixed before any verifier implementation can legitimately emit PASS** (ideally when the first real check lands; by T144 at the latest). PASS only when the required integrity checks all ran and passed; any SKIPPED required check ⇒ `FAIL` (the schema lacks INDETERMINATE). Does not block starting T141. |
| **T140-L1** | Low | **Isolation test validates declared dependencies rather than actual source imports.** A forbidden source-level import not added to `package.json` would resolve via the workspace and pass the test (caught only by the T147 gate). | Add an interim source-import scan or explicitly defer to the mechanical T147 `verifier-isolation-proof` gate. |
| **T140-L2** | Low | **`@edam/evidence` and `@edam/canonical` are declared but currently unused in verifier source** (anticipatory floor for T141+). | Confirm intentional; they are consumed once T141 recompute logic lands. |
| **T140-L3** | Low | **`ajv` and `ajv-formats` are transitive runtime dependencies** (via `@edam/contracts`) the trust-minimized verifier relies on for schema validation. | The future T147 isolation gate's allow-list MUST explicitly permit `ajv`/`ajv-formats` (a naive "@edam/* only" rule would fail). |
| **T140-L4** | Low | **Hand-written `EvidenceExportPackage` interface duplicates the vendored schema and may drift over time.** `loadExportPackage` casts after validation. | Schema is the runtime source of truth; consider cross-checking/deriving to prevent drift. |
| **T140-L5** | Low | **Missing negative-control tests** — no `VerificationReportError` (build() throwing on an invalid report), no `parsePublicKey` failure, no export-mode scope cases. | Add the negative controls during T141/T144 test hardening. |

**T140 readiness notes (carry forward, not defects):**
- **Export-mode object-payload availability** — `object_refs` carry `event_hash` but not object content, so offline per-object-hash recompute (WV-1) is feasible in WORM mode but not from an export package as currently modeled; **must be resolved during T141/T145/T146**.
- **`anchorCertDirectoryFromExport` loader** — only `signingKeyDirectoryFromExport` exists; an anchor-cert directory loader (ref/log_id → cert) **remains required before T143**.
- **`@edam/anchor-proof`** — the pure RFC-3161 / transparency-log token verifiers **remain a separate prerequisite before T143** (not before T140/T141).

### 13.2q E2E-VERIFIER — §10 steps 1-3 findings (from the accepted T141 adversarial review)

T141 review verdict: APPROVE WITH CHANGES — the §10 steps 1-3 recompute (per_object_hash, object_chain, segment_manifest) is correct and tamper-locating, reuses the shared `@edam/evidence`/`@edam/canonical` keystone (no second serializer), and **correctly closes T140-M1** with a fail-closed overall result. **No Critical findings. No High findings.** **T141 accepted with changes.** **T140-M1 is confirmed closed** (any FAIL ⇒ FAIL; any required check missing/SKIPPED ⇒ FAIL; PASS only when every required check PASSed; `projection_consistency` advisory). **Verifier isolation remains intact** (runtime: no writer/signing-private/anchoring/DB/WORM coupling; the `@edam/cce-model` import is type-only and pure). **No serializer or hash drift occurred** (single serializer; determinism rig exit 0; round-trip build↔recompute consistent). **T142 may proceed after this tracking commit.** **T141-M1 MUST be fixed before §10 steps 1-3 can safely participate in a PASS attestation path.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T141-M1** | Medium | **Fail-open on truncated object sets.** `objects.length === manifest.object_list.length` is not enforced; a partially truncated segment can pass §10 steps 1-3 (only the empty case is special-cased — the count mismatch is not asserted, so the un-provided objects are never checked). | **MUST be fixed before §10 steps 1-3 can safely participate in a PASS attestation path** (i.e., before T143/T144 gate an overall PASS on these checks). Enforce `objects.length === object_list.length` in `object_chain`/`segment_manifest`. Does not block starting T142. |
| **T141-M2** | Medium | **Undeclared direct dependency `@edam/cce-model`.** `verify-segments.ts` imports `type Cce` from `@edam/cce-model`, which is not in the verifier's `package.json` (declared floor = `{canonical, contracts, evidence}`). Runtime isolation is intact (type-only, pure), but the **dependency manifest is inaccurate and the current isolation test does not detect it** (concretely realizing T140-L1). | Declare `@edam/cce-model` in the verifier `package.json` (it is an allowed pure package) **or** re-export `Cce` from `@edam/evidence`; strengthen the isolation test / defer to the T147 gate. |
| **T141-L1** | Low | **Stale `VerificationReportBuilder` documentation comment** describing the pre-T141 fail-open semantics ("`overall_result` is FAIL iff any check is FAIL, else PASS … SKIPPED does not fail"), contradicting the implemented fail-closed behavior. | Update the class doc comment to the fail-closed (required-checks) rule. |
| **T141-L2** | Low | **`@edam/canonical` remains declared but unused in verifier source** (carryover of T140-L2; `@edam/evidence` is now consumed, `@edam/canonical` is not directly imported). | Confirm intentional; it is consumed once later recompute logic imports it directly, otherwise reconcile the declared floor. |
| **T141-L3** | Low | **CCE objects are not independently schema-validated**; malformed objects fail closed through hash recomputation (`verifyCce` mismatch / try-catch) only. | Optionally add `validateCce` per object to harden malformed-input handling. |
| **T141-L4** | Low | **Missing tests:** truncated object set (would have caught T141-M1), self-consistent object tamper (content + `evidence.event_hash` rewritten), multi-segment `verifySegments` aggregation + offending-id prefixing, object misordering / extra objects. | Add these negative controls during T142/T144 test hardening. |

### 13.2r E2E-VERIFIER — §10 steps 4-6 findings (from the accepted T142 adversarial review)

T142 review verdict: APPROVE WITH CHANGES — §10 steps 4-6 (cross_segment_continuity, no_missing_segment, no_missing_event) are correct and locating, reuse the shared `@edam/evidence`/`@edam/canonical` keystone (no second serializer), and correctly close T141-M1 and T141-M2. **No Critical findings. No High findings. T142 accepted with changes. T141-M1 confirmed closed** (`objects.length === object_list.length === object_hash_list.length`; truncated/extra → `segment_manifest` FAIL with located segment id). **T141-M2 confirmed closed** (`@edam/cce-model` explicitly declared; verifier dependency manifest accurate). **Verifier isolation remains intact** (src imports only `@edam/cce-model`/`@edam/contracts`/`@edam/evidence` + `node:crypto`; no writer/signing-private/anchoring/WORM/DB). **No serializer or hash drift occurred; determinism rig remained green.** **T143 may proceed after this tracking commit; no mandatory fix is required before starting T143.** **T142-M1 remains a tracked hardening item.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T142-M1** | Medium | **Residual fail-open in `no_missing_event` (option-A implementation).** A forged-clean offset gap can pass when: events are removed, `gap_detected` is forged as `false`, offsets remain internally self-consistent, and endpoint/overlap checks still pass. | **Approved Q2 option-A limitation.** Honest gaps are still detected (the collector's `gap_detected=true`); overall verification remains **FAIL-closed until T143** (HSM/anchor-token), and a forged head fails the T143 HSM-signature backstop. **Tracked hardening:** future engine-aware GTID/LSN/SCN offset arithmetic to catch forged-clean gaps even under a compromised writer. |
| **T142-L1** | Low | **`@edam/canonical` remains declared but unused in verifier source** (carryover of T141-L2; `@edam/cce-model`/`@edam/contracts`/`@edam/evidence` are now all consumed). | Reconcile the declared floor (it is consumed once later stages import `@edam/canonical` directly), or remove until needed. |
| **T142-L2** | Low | **Sub-range verification (`a > 0`) currently fail-closes** — a non-genesis-rooted range cannot pass both `cross_segment_continuity` (predecessor absent ⇒ MISSING_PREVIOUS) and `no_missing_segment` (predecessor present ⇒ out-of-scope). | A **predecessor-anchor mechanism** (supply segment `a−1`'s `segment_hash` as a boundary input without counting it in scope) will be needed later for continuity-preserving export verification (**T145**). Safe (fail-closed) for T142. |
| **T142-L3** | Low | **Test gaps:** forged-clean offset gap, per-object `gap_detected=true`, cross-segment offset overlap, sub-range verification, empty-set-with-scope. | Add these negative controls during T143/T144 test hardening. |

### 13.2s E2E-ANCHOR-PROOF — `@edam/anchor-proof` extraction findings (from the accepted review)

Extraction review verdict: APPROVE WITH CHANGES — the RFC-3161 + RFC-6962 verify/sign/Merkle/STH logic is **byte-identical** to the pre-extraction source (diffed), provider-build and verifier-check now share **one** implementation path (no drift possible), key-holding + provider tree-state remain in `services/anchoring`, and the `@edam/anchoring` barrel keeps every consumer working (strictly additive; `TransparencyLogProof` now exported). **No Critical findings. No High findings. No Medium findings. Extraction accepted with changes.** **`@edam/anchor-proof` is pure enough for verifier use** (deps: `@edam/canonical` + `node:crypto`; no services/WORM/signing-private/key material/provider state). **No provider behavior drift occurred. No crypto, signature, Merkle, or token-verification drift occurred** (moved logic byte-identical; domain tags/prefixes unchanged; 72 `services/anchoring` tests pass unchanged; determinism rig exit 0; build↔verify round-trips pass). **CT6 is closed via exported `TransparencyLogProof`.** **Full suite (605 passed / 9 skipped) and determinism rig remained green.** **T143 may proceed after this tracking commit; no mandatory fixes are required before T143.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **AP-L1** | Low | **Intra-package helper duplication** — `@edam/anchor-proof`'s `rfc3161.ts` and `transparency-log.ts` each define their own `isRecord` / `isRealInstant` / `RFC3339_RE`. **Pre-existing** (each original `services/anchoring` module had its own copies) and **preserved verbatim** by the deliberately-minimal move — cosmetic and behavior-preserving. | Optionally consolidate into a shared internal util later; not blocking. |

**`@edam/anchor-proof` readiness notes (carry forward, not defects):**
- **AP-N1** — **T143 must adapt `TrustedAnchorCert`** (T140 `{ ref, algorithm, public_key, ... }`) into the verifier certificate shapes (`DevTsaCertificate` `{ tsa_cert_ref, ... }` / `DevLogCertificate` `{ log_id, ... }`) when calling `verifyRfc3161Token` / `verifyTransparencyLogToken`.
- **AP-N2** — **T147 verifier-isolation allow-list must explicitly include `@edam/anchor-proof`** (pure, verifier-importable) alongside `@edam/canonical` / `@edam/contracts` / `@edam/evidence` / `@edam/cce-model`.

### 13.2t E2E-VERIFIER — §10 steps 7-8 findings (from the accepted T143 adversarial review)

T143 review verdict: APPROVE WITH CHANGES — §10 steps 7-8 are correctly implemented: the HSM signature is re-verified verifier-locally over the shared `anchorSigningMessage` with a complete same-head binding (`segment_hash`/`last_row_hash`/`segment_id`/`segment_sequence`), algorithm/key-id resolution, and `revoked_at` semantics; the anchor token is verified via the shared `@edam/anchor-proof` functions with same-head commitment + cert-shape adaptation; everything is fail-closed and the first overall-PASS path is correctly gated. **No Critical findings. No High findings. No Medium findings. T143 accepted with changes.** **§10 steps 7-8 are correctly implemented.** **Verifier isolation remains intact** (src imports only `@edam/anchor-proof`/`@edam/cce-model`/`@edam/contracts`/`@edam/evidence` + `node:crypto`; no `@edam/signing`/`services/anchoring`/private-key access). **T143 unblocks T144; no mandatory fix is required before T144.** **AR1 and M1 / M1-RESIDUAL are closed for the verifier path** (offline re-verification against published trust roots, never a provider object). **CT1 remains open** (inclusion-to-STH only; no consistency/gossip). **T142-M1 is backstopped by the HSM signature path** (a forged head cannot be re-signed without the HSM key). **Full suite (618 passed / 9 skipped) and determinism rig (exit 0) remained green.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T143-L1** | Low | **Malformed `revoked_at` in the trusted signing-key directory is silently treated as not revoked** (`Number.isFinite(revoked)` false ⇒ revocation check skipped) — a fail-open on a security-relevant trust-root field. | Recommend **fail-closed** when revocation status cannot be determined (unparseable `revoked_at` ⇒ FAIL). Low: the directory is trusted published material; low attacker-exploitability. |
| **T143-L2** | Low | **Anchor-authority cert `revoked_at` / validity-window (`not_before`/`not_after`) is not enforced** (only signing-key revocation is). | Remains **deferred** with the existing cert-validity / revocation work (L7/L8/CT3); re-recorded in the T143 context. |
| **T143-L3** | Low | **Composition dependency:** `verifyHsmSignature` binds the anchored head to `segmentHashOf(manifest.manifest_hash)` (the stored `manifest_hash`) and relies on T141 `segment_manifest` (manifest_hash recompute) being a **required passing** check for overall PASS. Safe through `verifySegments` (all checks composed + fail-closed); `verifyAnchorForSegment` in isolation does not re-verify `manifest_hash`. | Document the dependency; keep the checks composed in `verifySegments`. |
| **T143-L4** | Low | **Test gaps:** multi-segment aggregation; `dual_custodian` → FAIL; trust-roots-present-but-record-absent → FAIL; schema-invalid anchor record → FAIL; malformed `revoked_at`; wrong-but-present cert. | Add these negative controls during T144 test hardening. |

### 13.2u E2E-VERIFIER — §10 step 9 / Verification Report findings (from the accepted T144 adversarial review)

T144 review verdict: APPROVE WITH CHANGES — §10 step 9 is correctly implemented as a pure, public-inputs-only, advisory projection-consistency check (supplied `{object_id,row_hash}` snapshot vs verified WORM `row_hash`; mismatch/missing/extra → FAIL with located object_ids; absent → SKIPPED), and `#computeOverall` is refined so projection drift is reported SEPARATELY from evidence integrity. **No Critical findings. No High findings. No Medium findings. T144 accepted with changes. §10 step 9 correctly implemented. Projection drift is advisory only.** **Overall PASS can coexist with `projection_consistency` FAIL** (a required integrity FAIL/SKIPPED still forces overall FAIL; integrity remains fail-closed). **Verifier isolation remains intact** (`verify-projection.ts` is pure — only a verifier-local type import; no DB/engine/WORM/signing/anchoring). **T144 unblocks T145; no mandatory fix is required before T145.** **The §10 nine-step verification procedure is complete; WV-7 is met on the verifier side.** **CT1 remains open.** **Report signing, CLI, and export builder remain deferred.** **Full suite (625 passed / 9 skipped) and determinism rig (exit 0) remained green.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T144-L1** | Low | **Duplicate projection `object_id`s are not flagged as a structural anomaly.** A drifted duplicate is caught (FAIL), but two identical correct rows pass silently. Not a fail-open evidence-integrity issue (any content drift is still caught, and projection is advisory). | Consider treating duplicate projection rows as drift in a later hardening pass. |
| **T144-L2** | Low | **Test gaps:** duplicate projection rows; supplied-empty `{ rows: [] }` all-missing FAIL assertion; multi-segment projection. | Add these negative controls during T145+ test hardening. |

### 13.2v E2E-EXPORT — Evidence Export Package builder findings (from the accepted T145 adversarial review)

T145 review verdict: APPROVE WITH CHANGES — `@edam/export` is a pure producer that assembles a schema-valid `evidence-export-package-1.0` (§12.1) with genesis-rooted continuity-preserving selection (§12.2), computes `package_hash = eventHash(serializeCanonical(package_minus_export_signature))`, signs via an injected `ExportSigner` over the domain-tagged message (`edam-evidence-export-package-v1:<package_hash>`), and validates against the vendored schema (fail-closed on continuity violation or schema-invalid result). **No Critical findings. No High findings. No Medium findings. T145 accepted with changes.** **Export package validates** against `evidence-export-package-1.0`. **Continuity-preserving (genesis-rooted) selection is correctly enforced** (refuses gapped / missing-genesis / missing-manifest / missing-anchor / uncovered / out-of-range / duplicate-sequence selections, in both directions). **Builder purity preserved** (no clock/RNG/I/O; the only I/O surface is the optional `writeExportPackageToWorm` helper over an injected, locally-typed `WormWritePort`). **Isolation preserved** (`packages/export/src` imports only `@edam/canonical` + `@edam/contracts`; the single `@edam/signing` reference is a comment; no concrete WORM / verifier / signing-private coupling; `@edam/verifier` is a test-only devDependency). **All gates green** (tsc -b exit 0; eslint --max-warnings 0 exit 0; full suite + focused export tests pass; determinism rig exit 0; worm-no-mutate-proof / evidence-schemas-verbatim / secret-hygiene / signing-key-hygiene / anchor-no-fabrication all OK). **T145 unblocks T146; no mandatory fix is required before T146.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T145-L1** | Low | **Continuity check trusts caller-supplied segment metadata** (`object_ids` / `segment_sequence`) rather than parsing the `serialized_manifest`. Build-time advisory convenience only. | **Not a fail-open** — the independent verifier re-derives coverage from the manifests and is authoritative. Recommend a doc note clarifying the build-time-vs-verify-time boundary. |
| **T145-L2** | Low | **Test-only undeclared direct imports** (`@edam/cce-model`, `@edam/evidence`) in `@edam/export` tests; they resolve only transitively (declared: deps `{canonical, contracts}`, devDeps `{verifier}`). Same class as T141-M2. | Add the missing test devDependencies during a later hygiene pass. Test-only. |
| **T145-L3** | Low | **Test gaps:** mid-chain gap (only genesis-omission is asserted), duplicate-sequence rejection, out-of-range (`seq > maxSelected`) rejection, and tampered-package-signature-break (mutate body post-build ⇒ verifier FAIL). Code paths are correct by inspection. | Add these negative controls during T146+ test hardening. |
| **T145-L4** | Low | **Builder does not automatically append the §12.2 export custody event;** the caller currently supplies `chain_of_custody_log` entries (schema enforces ≥1). Acceptable for T145 scope. | T146 / the CLI should own export-custody-event emission explicitly rather than by omission. |

**Carry-forward note for T146:** The export verifier MUST **independently recompute `package_hash`** from the canonical package-minus-signature and **verify `export_signature`** against an **out-of-band-trusted** export key. The verifier MUST NEVER trust the `package_hash` value carried in the package without recomputation. (Not a T145 defect; track as a T146 acceptance requirement.)

### 13.2w E2E-VERIFIER-CLI — T146 offline export verifier findings (from the accepted adversarial review)

T146 review verdict: APPROVE WITH CHANGES — `apps/verifier-cli` is a correct, fail-closed, isolation-preserving offline verifier: it independently RECOMPUTES `package_hash` over the canonical package-minus-signature (never trusting the carried value), verifies `export_signature` against an **out-of-band-trusted** export key (`--trust` mandatory; package-embedded keys/certs are never used for verification), hydrates §10 objects from the approved object-sidecar bundle (Q1; T145 export schema unchanged), builds `VerifierSegment[]`, and runs the pure `verifySegments` directly. Continuity is re-derived authoritatively from the manifests (closing T145-L1). **No Critical findings. No High findings. No Medium findings. T146 accepted with changes.** **Valid export PASSes offline** (overall PASS + envelope PASS + exit 0). **Tampered export FAILs with located ids** (tampered sidecar object ⇒ located `per_object_hash` FAIL + exit 1; tampered package body ⇒ `package_hash` recompute FAIL + exit 1). **`package_hash` is recomputed independently.** **`export_signature` is verified against an out-of-band trusted export key.** **Package-embedded trust roots are not trusted by default.** **Verifier isolation remains intact** (`packages/verifier/src` imports only `@edam/canonical`/`@edam/contracts`/`@edam/evidence`/`@edam/cce-model`/`@edam/anchor-proof` + `node:crypto`; no `@edam/export`/`@edam/signing`/services/DB; `EXPORT_SIGNATURE_DOMAIN` re-derived locally). **T146 unblocks T147; no mandatory fix is required before T147.** **WV-12 readiness is satisfied on the verifier side** (the formal proof is the T147 gate). **WV-14 readiness is satisfied for export verification with the approved object-sidecar model** (full conformance lands in T148). **Exit-code policy: 0 PASS / 1 integrity failure / 2 usage·parse·schema; projection drift never changes the exit code.** **Full suite (651 passed / 9 skipped), determinism rig (exit 0), and all mandatory gates (worm-no-mutate-proof / evidence-schemas-verbatim / secret-hygiene / signing-key-hygiene / anchor-no-fabrication) remained green; full-suite coverage stayed above thresholds with `apps/*/src` included.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T146-L1** | Low | **Export-key `revoked_at` that is unparseable is silently treated as not revoked** — fail-open on a security-relevant trust field (carry-forward of T143-L1 to the export-signature path). | Recommend **fail-closed**: an unparseable `revoked_at` ⇒ FAIL. |
| **T146-L2** | Low | **`@edam/worm` is declared as a dependency of `apps/verifier-cli` but is never imported** (WORM mode is deferred; referenced only in a comment). | **Remove** until WORM mode lands, or implement the minimal reader. |
| **T146-L3** | Low | **Human and JSON output do not expose a single combined verdict.** Human output can show `OVERALL: PASS (export envelope FAILED)` and the JSON has no top-level combined verdict field (exit code is still correctly 1). | Add a **combined verdict** = envelope result **AND** verification-report result. |
| **T146-L4** | Low | **Test and coverage gaps:** malformed inline manifest JSON; malformed inline anchor-record JSON; export-key revoked path; algorithm mismatch; non-Ed25519 export key; malformed-signature catch path; human envelope-FAIL offending-id branch; projection-advisory exit path. | Add these negative controls during T147+/T148 test hardening. |
| **T146-L5** | Low | **`segment_manifests[i]` and `anchor_records[i]` are paired by index.** Tail manifests without anchors fail closed, but **orphan anchor records beyond `segment_manifests.length` are silently ignored.** Not exploitable for a forged PASS (each anchor binds to its manifest via `segmentHashOf`). | Flag orphan/extra anchor records rather than silently dropping them. |

**Notes (non-findings):**
- **DOMAIN-drift defense:** `EXPORT_SIGNATURE_DOMAIN` is duplicated between `@edam/export` and `@edam/verifier`; the current acceptance tests transitively protect against drift (the signer uses `@edam/export`'s message, the verifier its own re-derived one — a divergence would fail the PASS test). Add an explicit equality assertion later for defense-in-depth.
- **Symlink sidecar caveat:** path traversal is blocked with path math, but symlinks inside the object-sidecar directory could escape. Out of the threat model (the auditor owns the bundle); recorded as a note.
- **Package `db_id` cosmetic note:** `pkg.db_id` is used as the report label and is not cross-checked against the manifest `db_id`. Cosmetic and not security-relevant — the manifest checks bind the evidence.

### 13.2x E2E-VERIFIER-ISOLATION — T147 verifier-isolation-proof findings (from the accepted adversarial review)

T147 review verdict: APPROVE WITH CHANGES — the `verifier-isolation-proof` gate is a sound, fail-closed, **default-deny** allow-list static scanner correctly scoped to `packages/verifier/src/**` + `packages/verifier/package.json`, with dual enforcement (a dedicated CI job **and** an in-suite conformance test) and working positive controls. The verifier remains pure and unmodified. **No Critical findings. No High findings. No Medium findings. T147 accepted with changes.** **The gate satisfies the acceptance criterion** (a planted forbidden import fails the gate). **A planted forbidden import fails the gate.** **Verifier isolation remains intact** (the live scan is clean; no verifier source modified). **CI wiring is correct** (`--check` fails on violations; `--report` emits `verifier-isolation-proof.json`; the artifact is gitignored). **The gate is default-deny** (any specifier not relative and not allow-listed is a violation). **The scan scope is strictly `packages/verifier/src/**` plus `packages/verifier/package.json`.** **`apps/verifier-cli/**` is intentionally excluded** (it is the impure boundary; scanning it would false-positive). **T147 unblocks T148; no mandatory fix is required before T148.** **WV-12 / INV-EV-5 / A-EV7 are meaningfully enforced at the verifier direct-import boundary.** **Full suite (661 passed / 9 skipped), determinism rig (exit 0), and all mandatory gates (worm-no-mutate-proof / evidence-schemas-verbatim / secret-hygiene / signing-key-hygiene / anchor-no-fabrication / verifier-isolation-proof) remained green; full-suite coverage stayed above thresholds.**

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| **T147-L1** | Low | **Comment-stripper false-negative:** a forbidden import on the same physical line as a `//`-containing string (e.g. a URL) is silently dropped before extraction (the naive `//` stripper treats the rest of the line as a comment). Probe-confirmed; shared naive-stripper limitation with sibling gates. | Recommend **line-aware/tokenizer-based stripping**, or a raw-source forbidden-specifier backstop. Non-blocking (verifier uses one-import-per-line). |
| **T147-L2** | Low | **Backtick-quoted dynamic `import` / `require` specifiers evade extraction** (the patterns match only `'`/`"`). | Add **backtick support** to the specifier patterns. Non-blocking (exotic). |
| **T147-L3** | Low | **A string literal containing import-like text yields a fail-closed false-positive violation.** Not present in current verifier source. | Document for future authors. Safe direction (fail-closed). |
| **T147-L4** | Low | **Test and coverage gaps:** `require()` form positive control; backtick import/require evasions; `://` comment-stripper evasion; `NO_SOURCE`; `MANIFEST_MISSING`; `MANIFEST_PARSE`. | Add these positive controls during a later hardening pass (`conformance/` is also outside `coverage.include`). |
| **T147-L5** | Low | **Source-level / direct-import scope only:** transitive purity of the allow-listed dependencies is trusted, not proven; only `dependencies` (not `devDependencies`) and only `packages/verifier/src/**` are scanned. | Approved design (non-invasive). Consider a future **deep dependency-graph or per-dependency isolation pass**. |

**Carry-forward note:** `@edam/anchor-proof` is imported in verifier source but remains **undeclared in `packages/verifier/package.json`**. It is allow-listed, so the gate passes. Track as a separate **manifest-completeness** follow-up — **not** a T147 blocker (fixing it would require editing the verifier manifest, out of T147 scope per Q1).

### 13.3 Gating statement
The Sprint-2 **security sign-off (T164)** and **live evidence validation (T160–T163)** MUST NOT assert WORM enforcement / INV-EV-1 on the basis of the current MinIO adapter until **H1, H2, H3, and H5** are closed (H4 by T164). Until then, evidence **durability** holds (locked versions persist and are recoverable), but **read-path integrity under a compromised writer is not yet store-enforced**. T106 and subsequent E2A/E2B logic proceed against the stable `WormStore` interface and the in-memory fake, independent of these adapter-hardening items.

---

*Backlog / planning only — no code, no architecture or contract modification. Derived from the Sprint-2 Implementation Plan; implements the frozen WORM Evidence Segment & Anchoring Specification v1. Dashboard, Risk Engine, business Projection DB, and reversal remain out of scope.*
