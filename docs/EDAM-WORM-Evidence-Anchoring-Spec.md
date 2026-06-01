# EDAM WORM Evidence Segment & Anchoring Specification — v1
### How EDAM stores evidence immutably, seals it, signs it, anchors it externally, and proves it without trusting EDAM

> **Document class:** Frozen foundational specification. Changes follow the versioning/deprecation discipline of CCE v1 (§9 of `docs/CCE-v1-Specification.md`) and the Breaking-Changes rules in §20 here.
> **Authoritative inputs:** `docs/External-Database-Audit-Monitor-Plan.md` (v1), `docs/EDAM-Architecture-Review.md`, `docs/EDAM-v2-Architecture.md`, `docs/CCE-v1-Specification.md`, `docs/EDAM-Companion-Contracts.md`.
> **Status:** Contract/spec design only — no implementation code.
> **Schema ids:** `evidence-segment-manifest-1.0`, `anchor-record-1.0`, `verification-report-1.0`, `evidence-export-package-1.0`.
> **Spec date:** 2026-06-01.

---

## 1. Purpose and Scope

### 1.1 Purpose
This specification defines the **evidence system of record** for EDAM: how Canonical Change Events (CCEs), ExecutionResults, and DB-Audit Events are committed to Write-Once-Read-Many (WORM) storage, grouped into **sealed segments**, linked by a **hash chain**, signed by an **HSM**, **anchored externally** to an independent trust authority, and **independently verifiable** by an outside auditor who trusts neither EDAM's software nor its operators.

It directly resolves review blocker **C1** ("self-anchored hash chain is worthless against the primary adversary"): the integrity proof here is verifiable using only public keys and immutable storage, *not* EDAM code.

### 1.2 Why WORM is the system of record (and PostgreSQL is only a projection)
The adversary EDAM most needs to defeat is the **privileged insider/DBA** who can edit data *and* tamper with the systems that audit it. Any record EDAM can rewrite is not evidence against EDAM's own operators. Therefore:

- **WORM object storage is the authoritative system of record.** Objects are written **once** under compliance-mode retention; no identity — including EDAM administrators and cloud root — can mutate or delete them within the retention window.
- **PostgreSQL is a disposable, rebuildable projection** (per EDAM v2 §2). It exists for query/filter/dashboard speed. It carries `row_hash` values for convenience but **never** constitutes the integrity guarantee. On any disagreement between PostgreSQL and WORM, **WORM wins** and PostgreSQL is rebuilt (§11).
- Consequence: an auditor verifies against WORM + public keys, never against EDAM's database or APIs.

### 1.3 Scope
In scope: evidence object model, segment lifecycle, manifest format, chain-head model, HSM signing, external anchoring (RFC 3161 / transparency log / dual-custodian), independent verification, projection consistency, export packages, chain-of-custody, failure modes, security requirements, JSON Schemas, examples, conformance tests, implementation constraints, breaking changes.

Out of scope: CCE/ReversalDirective/ExecutionResult/DB-Audit Event internal structure (frozen in their own specs); the act of executing reversals (CES, Domain D). This spec consumes those contracts' sealed objects as evidence payloads.

### 1.4 Evidence payload types
A WORM evidence object wraps exactly one of: a **CCE** (`cce-1.0`), an **ExecutionResult** (`execution-result-1.0`), or a **DB-Audit Event** (`db-audit-event-1.0`). All three already define `evidence.event_hash` / `row_hash` and are designed to be WORM-compatible (Companion Contracts INV-3). This spec defines how those objects are *grouped, sealed, chained, signed, and anchored*.

---

## 2. Trust Domains

This spec spans the EDAM v2 trust-domain model (EDAM v2 §1), focusing on the boundary between Domain B and Domain C.

| Party | Domain | Responsibilities | Explicitly CANNOT |
|---|---|---|---|
| **EDAM Audit Core** | **B** | Build CCEs/results/audit events; compute `event_hash`/`row_hash`; open segments; **append** objects to WORM via an append-only writer identity; request HSM signatures and external anchors; maintain the PostgreSQL projection. | Mutate or delete WORM objects; extract HSM private keys; change retention; approve its own evidence integrity. |
| **Evidence Domain (custodian)** | **C** | Own the WORM bucket and its retention/legal-hold configuration; own the HSM and signing keys (non-exportable); operate/contract the external anchor; perform dual-control retention changes; serve read/export under chain-of-custody. | Write or alter CCE content (it only seals/signs what B appended); bypass dual-control. |
| **External Timestamp / Anchor Provider** | External | Provide an independent, verifiable proof of *when* a chain head existed: RFC 3161 TSA, transparency log, or a second custodian co-signer. | See or store CCE plaintext (it only receives a hash). |
| **Independent Verifier** | External / auditor | Re-derive and check every hash, chain link, manifest, signature, and anchor using only public inputs (§10). | Require any EDAM/CES software, secret, or online API to verify. |

**Separation principle:** B produces evidence but cannot prove its own integrity; C and the external anchor provide the integrity proof; the Independent Verifier confirms it without trusting B or C's software. Compromise of B alone cannot forge a verifiable chain because B holds no signing key and cannot mutate WORM.

---

## 3. Evidence Object Model

```
 Individual evidence object (one CCE | ExecutionResult | DB-Audit Event)
        │  carries evidence.event_hash, prev_row_hash, row_hash
        ▼
 Evidence Segment  = an ordered, contiguous run of evidence objects for one db_id
        │  bounded by event_count or time; objects ordered by the global order (§7.4)
        ▼
 Segment Manifest  = the sealed, hashed description of a segment (§6)
        │  references first/last envelope_id, first/last row_hash, per-object hashes,
        │  source offset range, fidelity & completeness summaries, previous segment
        ▼
 Chain Head        = the cryptographic tip after a segment is sealed (§7)
        │  segment_hash linked to previous_segment_hash → cross-segment chain
        ▼
 Anchor Record     = HSM signature + external timestamp/anchor over a chain head (§9)
        ▼
 Verification Report = signed output of running the Independent Verification Procedure (§10)
```

| Object | Definition | Immutable once | Stored in |
|---|---|---|---|
| **Individual CCE object** | One sealed contract instance (CCE/Result/Audit). | sealed (CCE v1 SEALED) | WORM |
| **Evidence segment** | Logical group of contiguous objects for a db_id. | SEALED (§5) | WORM (objects) |
| **Segment manifest** | Canonical description + `manifest_hash` of a segment. | SEALED | WORM |
| **Chain head** | `{segment_id, segment_sequence, segment_hash, last_row_hash}`. | derived/sealed | WORM + projection |
| **Anchor record** | HSM signature + TSA/anchor token over a head. | ANCHORED | WORM |
| **Verification report** | Result of §10 run by EDAM (daily) or an external verifier. | issued | WORM (EDAM runs); auditor-held (external runs) |

---

## 4. WORM Storage Requirements

| # | Requirement | Specification |
|---|---|---|
| **W-1** | **Object immutability** | Objects are written once; no overwrite, no in-place edit. Enforced by the storage backend (e.g., S3 Object Lock, Azure Immutable Blob, GCS retention/Bucket Lock), not by application logic. |
| **W-2** | **Compliance-mode retention** | Retention is set in **compliance mode** (not governance mode): even an account with root/admin cannot shorten retention or delete within the window. Retention period is policy-driven and ≥ the regulatory minimum for the monitored domain. |
| **W-3** | **Legal hold** | An independent legal-hold flag can be placed on objects/segments that **prevents deletion regardless of retention expiry**. Placing/lifting holds requires dual-control (§15) and is itself logged (§13). |
| **W-4** | **Object versioning** | Bucket versioning enabled; combined with Object Lock so that no "new version" can supersede a sealed evidence object's authoritative content. Manifests reference exact object keys + content hashes, so version confusion is detectable. |
| **W-5** | **Retention policy** | Tiered retention is permitted (hot/warm/cold) but the **retention lock** travels with the object; tier transitions must not weaken immutability. Documented retention schedule per evidence type. |
| **W-6** | **Geo-replication** | Evidence is replicated to at least one independent region/custodian with the same immutability guarantees, so loss of one site during an incident does not destroy the forensic record (review DR gap). Replication integrity is verified by re-checking content hashes at the replica. |
| **W-7** | **Deletion prevention** | No identity has standing delete permission within retention. Deletion after lawful expiry (and absent legal hold) requires dual-control and is logged. Crypto-shred (destroying a per-record field key) is the mechanism for GDPR erasure of sensitive fields **without** deleting the evidence object (EDAM v2 §9). |
| **W-8** | **Access control** | Separate identities for: append-only writer (Domain B), retention/hold administrator (Domain C, dual-control), and reader/exporter (chain-of-custody gated). Least privilege; no identity holds more than one of these by default. |
| **W-9** | **Audit logging of reads and exports** | Every read and export of evidence is logged to the chain-of-custody record (§13), including reviewer identity, reason, objects accessed, and timestamp. Access logs are themselves append-only/WORM. |

---

## 5. Evidence Segment Lifecycle

A segment is the unit of sealing and anchoring. Lifecycle is **strictly forward** except for the explicit terminal/parallel states below.

```
 OPEN ──► SEALING ──► SEALED ──► ANCHOR_PENDING ──► ANCHORED
   │                     │                              │
   │                     └──(integrity check fails)──► VERIFICATION_FAILED (terminal-alarm)
   │
   └─ (LEGAL_HOLD may be applied to a SEALED/ANCHORED segment as an overlay flag,
       freezing retention/deletion; it does not replace the lifecycle state)
```

| State | Meaning | Allowed transitions | Forbidden transitions | Trigger | Security controls |
|---|---|---|---|---|---|
| **OPEN** | Accepting appended objects in global order. | → SEALING | → ANCHORED/SEALED directly | Auto on first object after previous seal. | Append-only writer (Domain B) only; objects validated against their contract schemas before append. |
| **SEALING** | No more objects accepted; manifest being computed. | → SEALED, → VERIFICATION_FAILED | back to OPEN | Reaching `event_count` cap or time cap, or forced seal (e.g., shutdown). | Manifest computed deterministically; intra-segment chain re-verified before seal. |
| **SEALED** | Manifest finalized + `manifest_hash` computed; objects + manifest immutable in WORM. | → ANCHOR_PENDING, → VERIFICATION_FAILED, (overlay) LEGAL_HOLD | mutate any object, reopen | Manifest write to WORM succeeds. | WORM W-1/W-2; manifest references previous segment (cross-segment link). |
| **ANCHOR_PENDING** | Awaiting HSM signature + external anchor. | → ANCHORED, → VERIFICATION_FAILED | delete, reopen | Seal completes; anchor request queued. | Anchor request carries only the chain head (a hash), never CCE plaintext. |
| **ANCHORED** | Chain head HSM-signed + externally timestamped; anchor record in WORM. | (overlay) LEGAL_HOLD | any mutation | Anchor provider returns a valid token; HSM signature verified. | Anchor record immutable; covered objects reference `anchor_ref`. |
| **VERIFICATION_FAILED** | A daily/independent verification found a mismatch (hash/chain/manifest/signature). | (none — terminal; raises CRITICAL alarm; triggers incident) | silent recovery | Verifier detects tampering or corruption. | Cannot be cleared by editing; only by documented incident handling. The failed state itself is recorded in WORM. |
| **LEGAL_HOLD** *(overlay)* | Retention/deletion frozen for litigation/investigation. | applied to SEALED/ANCHORED; lifted by dual-control | auto-lift on retention expiry | Legal/compliance places hold. | Dual-control to apply/lift (§15); logged (§13). |

**Rules:**
- A segment **cannot skip** SEALED before anchoring; an unsealed segment can never be anchored.
- VERIFICATION_FAILED is **not** reversible by software; it mandates incident response. The evidence objects remain (immutable) for forensic analysis of the failure itself.
- LEGAL_HOLD is an **overlay**, not a lifecycle replacement: a segment is e.g. `ANCHORED + LEGAL_HOLD`.

---

## 6. Segment Manifest Format

The manifest is the sealed, canonical description of a segment. It is the object an auditor reads to verify a segment without re-reading the application's database.

| Field | Type | Req | Description |
|---|---|---|---|
| `manifest_version` | string | R | `"evidence-segment-manifest-1.0"`. |
| `segment_id` | string | R | Stable segment identifier (e.g., `seg-000142`). |
| `db_id` | string | R | Monitored DB this segment belongs to (one db_id per segment). |
| `engine` | string(enum) | R | `mysql\|mariadb\|postgres\|sqlserver\|oracle\|mongodb`. |
| `segment_sequence` | integer | R | Monotonic, contiguous per db_id (0 = genesis). |
| `opened_at` | timestamp | R | When the segment started accepting objects (trusted ingest clock). |
| `sealed_at` | timestamp | R | When sealing completed. |
| `event_count` | integer | R | Number of evidence objects in the segment (≥1). |
| `first_envelope_id` | string(uuid) | R | First object's identity (CCE envelope_id / result_id / audit_event_id). |
| `last_envelope_id` | string(uuid) | R | Last object's identity. |
| `first_row_hash` | hash | R | `row_hash` of the first object. |
| `last_row_hash` | hash | R | `row_hash` of the last object (this is the segment's chain tip input). |
| `object_list` | array<object> | R | Ordered list: `{seq, object_id, worm_object_key, object_type}` where `object_type ∈ {cce, execution_result, db_audit_event}`. |
| `object_hash_list` | array<object> | R | Ordered list: `{seq, event_hash, row_hash}` — one per object, in segment order. Enables per-object verification without fetching every object first. |
| `source_offset_range` | object | R | `{first_offset_key, last_offset_key, consumed_gtid_set?}` — engine offset span covered (for completeness, ties to CCE `completeness`). |
| `fidelity_summary` | object | R | `{all_healthy: bool, degraded_count, compromised_count, reasons[]}` summarizing CCE `fidelity.state` across the segment. |
| `completeness_summary` | object | R | `{gap_detected: bool, expected_continuous: bool, notes[]}` summarizing CCE `completeness`. |
| `previous_segment` | object\|null | R | `{segment_id, segment_sequence, segment_hash}` — null only for genesis (segment_sequence 0). Cross-segment link (§7). |
| `manifest_hash` | hash | R | SHA-256 over the canonical serialization of the manifest **core** (all fields above except `manifest_hash`). |

**Determinism:** the manifest is serialized with the **same canonical form as CCE v1 §12.7** (sorted keys, UTF-8 NFC, exact formatting, no insignificant whitespace). `manifest_hash` MUST be reproducible byte-for-byte by an independent verifier.

---

## 7. Chain Head Model

### 7.1 Per-object hashes (inherited)
Each evidence object already carries (from its own contract):
- `event_hash` = SHA-256 over the canonical **core** of the object.
- `row_hash` = SHA-256(`prev_row_hash` ‖ `event_hash`), linking it to the previous object in the **global order**.

### 7.2 Segment hash
On seal: `segment_hash = SHA-256(manifest_hash ‖ last_row_hash ‖ previous_segment_hash)`.
- Binds the segment's content (`manifest_hash`), its chain tip (`last_row_hash`), and the prior segment (`previous_segment_hash`) into one value.

### 7.3 Cross-segment linking & genesis
- `previous_segment_hash` for `segment_sequence == 0` (the **genesis segment**) is the all-zero hash `sha256:00…00`.
- For every later segment, `previous_segment_hash == segment_hash` of `segment_sequence - 1` for the same `db_id`. This produces an unbroken **chain of segments** on top of the **chain of objects**.

### 7.4 Chain continuity (two levels)
1. **Intra-segment:** objects ordered by the CCE global order — `(commit_ts, then monotonic offset tie-break)` (CCE v1 §4.2); each object's `prev_row_hash` equals the previous object's `row_hash`.
2. **Inter-segment:** `first_row_hash` of segment *n* MUST chain from `last_row_hash` of segment *n−1* (the object chain does not reset at segment boundaries), AND `previous_segment.segment_hash` MUST equal segment *n−1*'s `segment_hash`.

A break at either level is a chain-continuity failure (§14, §18).

### 7.5 Chain head
The **chain head** at any point is `{db_id, segment_id, segment_sequence, segment_hash, last_row_hash}`. The head is what gets HSM-signed and externally anchored (§9). Anchoring a head transitively anchors all objects and segments up to it.

---

## 8. HSM Signing Model

| Aspect | Specification |
|---|---|
| **Key custody** | The signing key lives in an HSM owned by the **Evidence Domain (C)**, not by EDAM Audit Core operators (B). Operators of B can *request* signatures but cannot *export* or *use* the key outside the HSM's controlled operation. |
| **Non-exportable keys** | Keys are generated in-HSM and marked non-exportable; no code path yields the private key material. Compromise of EDAM servers does not yield the key. |
| **Signature payload** | The HSM signs the **anchor payload**: `canonical({db_id, segment_id, segment_sequence, segment_hash, last_row_hash, head_count, signed_at})`. It signs a *hash structure*, never CCE plaintext. |
| **Algorithm recommendations** | ECDSA P-384 or Ed25519 for head signatures; SHA-256 for hashing (SHA-384 acceptable). RSA-PSS 3072+ acceptable where ECDSA/Ed25519 unavailable. Algorithm + key id are recorded in the anchor record so verifiers select the right scheme. |
| **Key rotation** | Keys rotate on a fixed schedule and on suspected compromise. Each anchor records `signing_key_id`. Rotation never invalidates prior anchors: old public keys remain published for verification of historically-signed heads. A rotation event is itself recorded in WORM. |
| **Revoked keys** | A revoked key's public part stays published with a `revoked_at`; anchors signed **before** `revoked_at` remain valid; anchors purporting to be signed **after** revocation are invalid. Revocation is dual-controlled and logged. |
| **Verification using public keys** | Anyone with the published public key + algorithm can verify a head signature offline. No EDAM/HSM online access required. |
| **Separation from operators** | Signing requests are authenticated (mTLS, scoped role); the HSM enforces rate/usage policy; **key usage is audited** (§15). EDAM B operators and C custodians are distinct identities; neither alone can both produce evidence and forge its anchor. |

---

## 9. External Anchoring Model

Anchoring proves **when** a head existed, using a trust source EDAM does not control. The anchor mechanism is a pluggable **Anchor Provider** with three supported types. Every anchor record states which was used.

### 9.1 RFC 3161 Timestamp Authority
| Aspect | Specification |
|---|---|
| **Input payload** | A timestamp request (`TimeStampReq`) over the **hash of the signed anchor payload** (head + HSM signature). The TSA sees only a hash. |
| **Output token** | An RFC 3161 `TimeStampToken` (signed, contains the hash + trusted time + TSA cert chain). |
| **Verification** | Validate the token's signature against the TSA's published cert; confirm the embedded hash equals the locally-recomputed hash of the head+signature; confirm time is sane. |
| **Failure behavior** | If the TSA rejects/returns invalid, the segment stays `ANCHOR_PENDING`; alarm raised (§14); never marked ANCHORED. |
| **Retry behavior** | Exponential backoff retries; idempotent (re-request over the same hash). |
| **Outage behavior** | Anchoring queues; sealing/object-append continues. Prolonged outage raises an escalating alarm and is recorded; the "when" proof is delayed, not faked. Optionally fail over to a secondary provider/type. |

### 9.2 Transparency Log
| Aspect | Specification |
|---|---|
| **Input payload** | The signed anchor payload (or its hash) submitted to an append-only, publicly-verifiable Merkle transparency log. |
| **Output token** | An inclusion proof (Merkle audit path) + signed tree head (STH) / log entry index. |
| **Verification** | Recompute the Merkle inclusion proof to the published STH; verify the log's STH signature against its public key. |
| **Failure / retry / outage** | Same posture as 9.1: stay ANCHOR_PENDING on failure; backoff retry; queue on outage with escalating alarm; never fabricate inclusion. |

### 9.3 Dual-Custodian Co-Signing
| Aspect | Specification |
|---|---|
| **Input payload** | The signed anchor payload sent to a **second, independent custodian** (different organization/key custody). |
| **Output token** | The second custodian's signature over the head payload + its trusted timestamp. |
| **Verification** | Verify both the EDAM-domain HSM signature **and** the second custodian's signature against their respective published keys. |
| **Failure / retry / outage** | Stay ANCHOR_PENDING until the co-signature is obtained; backoff retry; escalating alarm on outage. Used where external internet TSAs are unavailable (air-gapped/regulated networks). |

**Common rules:**
- The anchor payload is always a **hash structure**; no provider ever receives CCE/audit plaintext.
- A segment is `ANCHORED` only when at least one configured provider returns a verified token. Policy may require **≥2 providers** for high-value deployments.
- Anchoring cadence: every `N` events or `T` minutes (whichever first), bounding the maximum un-anchored window.

---

## 10. Independent Verification Procedure

An external auditor MUST be able to fully verify the evidence using **only**:
1. **WORM read access** (to objects, manifests, anchor records);
2. **Published public signing keys** (HSM public keys, with `revoked_at` where applicable);
3. **TSA / anchor-provider public certificates** (TSA cert chains, transparency-log public keys, dual-custodian public keys);
4. **This published verifier specification.**

No EDAM or CES software, secret, online API, or operator cooperation is required. This is the property that defeats blocker C1.

### 10.1 Procedure (deterministic)
For a chosen `db_id` and segment range (or the whole history):

1. **Per-object hash check.** For each evidence object: recompute `event_hash` from its canonical core (per the object's own contract + CCE §12.7 rules). Confirm it equals the stored `event_hash` and the manifest's `object_hash_list[seq].event_hash`.
2. **Object chain check.** For each object in global order: confirm `row_hash == SHA256(prev_row_hash ‖ event_hash)` and that `prev_row_hash` equals the previous object's `row_hash`.
3. **Segment manifest check.** Recompute `manifest_hash` from the manifest core; confirm it matches. Confirm `first/last_envelope_id`, `first/last_row_hash`, and `event_count` match the actual objects.
4. **Cross-segment continuity check.** For each segment *n* > 0: confirm `previous_segment.segment_hash == segment_hash(n−1)` and that object chaining is unbroken across the boundary (§7.4). Recompute `segment_hash = SHA256(manifest_hash ‖ last_row_hash ‖ previous_segment_hash)`.
5. **No-missing-segment check.** Confirm `segment_sequence` is **contiguous from 0** with no gaps for the db_id.
6. **No-missing-event check.** Confirm `source_offset_range` across consecutive segments is continuous (e.g., GTID sets contiguous; LSN/SCN monotonic with no gap), corroborated by CCE `completeness`. A gap ⇒ missing-event finding.
7. **HSM signature check.** For each anchored head: verify the HSM signature over the anchor payload against the published public key for `signing_key_id`, honoring `revoked_at`.
8. **Timestamp/anchor token check.** Validate the external anchor (RFC 3161 token / Merkle inclusion proof / dual-custodian signature) against the provider's published certificate/key, and confirm it commits to the same head.
9. **PostgreSQL projection consistency (optional, if projection provided).** Recompute the projection from WORM and compare to the supplied projection snapshot; report any drift (§11). The projection is **never** used to *prove* integrity — only to detect that the queryable copy matches the evidence.

### 10.2 Output
A **Verification Report** (§16.3) stating, per check, pass/fail with the offending ids/hashes. Any failure in steps 1–8 is a CRITICAL integrity finding; step 9 drift is a projection finding (rebuildable, not an evidence failure).

---

## 11. PostgreSQL Projection Consistency

| Aspect | Specification |
|---|---|
| **Rebuildable** | The entire PostgreSQL projection can be reconstructed by replaying WORM segments in order. PostgreSQL stores no authoritative state that is not derivable from WORM. |
| **WORM wins on conflict** | If any projection row disagrees with the corresponding WORM object (content or hash), the WORM object is authoritative; the projection row is corrected by rebuild. |
| **Projection rebuild process** | Read segments in `segment_sequence` order; for each object, re-derive projection rows (audit_events, audit_field_changes, reversal/exec state, alerts indices). Rebuild is idempotent (deterministic ids from the contracts). Rebuild may run online (shadow tables → atomic swap) or offline. |
| **Projection drift detection** | Periodic job recomputes `row_hash` for a sample (or all) projection rows and compares to WORM `object_hash_list`. Mismatch ⇒ drift alarm + scheduled rebuild. Continuous: every projection write is checked against the source object's `event_hash`. |
| **Projection corruption handling** | On detected corruption, mark the projection (or affected partitions) untrusted, serve a degraded read banner on the dashboard, and rebuild from WORM. No evidentiary loss occurs because WORM is intact. |

---

## 12. Evidence Export Package

A self-contained, independently-verifiable bundle for an external consumer (legal audit, financial audit, regulator, court dispute). It contains everything needed to run §10 offline.

### 12.1 Contents
| Component | Description |
|---|---|
| `selected_cces` (and/or results/audit events) | The specific evidence objects in scope (full sealed objects). |
| `segment_manifests` | All manifests covering the selected objects (and any needed for continuity proof). |
| `anchor_records` | Anchor records for the covered heads. |
| `public_keys` | HSM public keys (with `revoked_at` where relevant). |
| `timestamp_certificates` | TSA cert chains / transparency-log public keys / dual-custodian public keys. |
| `verification_instructions` | A pointer to (and pinned hash of) this published verifier spec + the exact §10 steps. |
| `chain_of_custody_log` | The access/export records for these objects (§13). |
| `export_signature` | A signature over the whole package manifest (export integrity). |

### 12.2 Properties
- **Self-verifying:** a recipient runs §10 using only the package + published specs; no EDAM access.
- **Scoped + continuity-preserving:** includes enough manifests/anchors to prove the selected objects sit in an unbroken, anchored chain (not cherry-picked out of context).
- **Masking-aware:** sensitive fields remain masked unless an explicit, authorized, logged reveal is part of the export (and even then governed by chain-of-custody and crypto-shred policy).
- **Immutable + logged:** producing an export is a chain-of-custody event (§13); the export package itself is written to WORM.

---

## 13. Chain-of-Custody Model

Every interaction with evidence is recorded immutably, so the handling of evidence is itself evidence.

| Field | Description |
|---|---|
| `custody_event_id` | Unique id of the access/export event. |
| `action` | `read \| export \| reveal_sensitive \| place_legal_hold \| lift_legal_hold \| retention_change \| verification_run`. |
| `reviewer_identity` | Authenticated principal (with role); for sensitive actions, WebAuthn-backed. |
| `reason` | Required justification (case id / ticket / investigation reference). |
| `objects_accessed` | List of object ids / segment ids / export id. |
| `legal_hold_ref` | Linkage to the legal hold under which access occurred, if any. |
| `occurred_at` | Trusted timestamp. |
| `evidence` | `event_hash`/`row_hash`/`worm_object_key` — the custody record is **append-only and WORM-stored**, hash-chained like other evidence. |

**Rules:** custody records are immutable, hash-chained, and themselves anchored. `reveal_sensitive` and `retention_change`/legal-hold actions require dual-control (§15). Access without a recorded custody event is impossible by access-control design (the reader identity cannot read WORM evidence except through the custody-logging gateway).

---

## 14. Failure Modes and Alerts

| Failure | Detection | Severity | Response |
|---|---|---|---|
| **WORM write failure** | Append-writer error / object not durable. | High | Halt sealing of that segment; retry with backoff; if persistent, raise CRITICAL and stop ingestion advancement (do not lose offset position). |
| **HSM signing failure** | Signature request error/invalid. | High | Segment stays ANCHOR_PENDING; retry; alarm; never mark ANCHORED. |
| **TSA unavailable** | Timestamp request timeout/error. | Medium→High (escalating) | Queue anchor; backoff retry; optional failover to alternate provider/type; alarm on prolonged outage. |
| **Anchor delayed** | Un-anchored window exceeds threshold. | Medium | Alarm; bounded by N/T cadence; record the delay. |
| **Manifest mismatch** | Recomputed `manifest_hash` ≠ stored. | Critical | Segment → VERIFICATION_FAILED; incident response; treat as tampering until proven otherwise. |
| **Hash mismatch (object)** | Recomputed `event_hash`/`row_hash` ≠ stored. | Critical | VERIFICATION_FAILED; incident; identify offending object. |
| **Missing object** | `object_list` references an absent WORM key. | Critical | VERIFICATION_FAILED; incident. |
| **Missing segment** | `segment_sequence` gap for a db_id. | Critical | VERIFICATION_FAILED; incident; correlate with completeness. |
| **Projection mismatch** | Projection row ≠ WORM object. | Medium | Drift alarm; mark projection degraded; rebuild from WORM (not an evidence failure). |
| **Retention misconfiguration** | Object lacks compliance-mode lock / window too short. | Critical | Alarm; block further writes to that location; dual-control remediation; record finding. |
| **Legal hold violation attempt** | Delete/shorten attempted on held object. | Critical | Denied by storage; alarm; security incident; record attempt in custody log. |

All failures are recorded in WORM and surfaced on the Integrity Verification dashboard (v1 plan §7E).

---

## 15. Security Requirements

| # | Requirement | Specification |
|---|---|---|
| **S-1** | **Append-only writer identity** | Domain B writes evidence via an identity that can `PutObject` only; it has no delete/overwrite/retention rights. |
| **S-2** | **No delete permission** | No standing identity can delete WORM evidence within retention; lawful expiry deletion is dual-controlled + logged. |
| **S-3** | **No overwrite permission** | Object Lock + versioning ensure a sealed object's authoritative content cannot be superseded. |
| **S-4** | **mTLS** | All traffic — B↔WORM, B↔HSM, B↔anchor provider, B↔CES — is mutually-authenticated TLS with scoped service identities (SPIFFE). |
| **S-5** | **IP allowlisting** | WORM/HSM/anchor admin endpoints reachable only from allowlisted ranges/VPN. |
| **S-6** | **Least privilege** | Writer, retention-admin, reader/exporter, key-admin are distinct roles; no role spans two by default. |
| **S-7** | **Separation of duties** | Domain B (produces evidence) ≠ Domain C (custody/keys/retention). Neither alone can both create evidence and forge a verifiable anchor. |
| **S-8** | **Dual-control for retention changes** | Any retention shortening, legal-hold lift, lawful deletion, or key revocation requires two distinct authorized principals (WebAuthn). |
| **S-9** | **Audited key usage** | Every HSM sign/rotate/revoke is logged (immutable) with requester identity, purpose, and key id. |
| **S-10** | **Immutable backups** | Backups (including the projection's) are encrypted + object-locked; the WORM evidence is geo-replicated (W-6) with verified hashes. |
| **S-11** | **Disaster recovery** | DR specifically for the evidence tier: documented RPO/RTO, geo-replicated WORM, restore drills that include a full §10 verification at the DR site, dual-control to promote a DR copy. |

---

## 16. JSON Schemas (Draft 2020-12)

> All four reuse CCE v1 canonical serialization/hashing. Stateful checks (hash recomputation, chain continuity, signature/anchor validation) are enforced by the conformance suite (§18), not by JSON Schema alone.

### 16.1 Evidence Segment Manifest v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/evidence-segment-manifest-1.0.schema.json",
  "title": "Evidence Segment Manifest v1",
  "type": "object",
  "required": ["manifest_version","segment_id","db_id","engine","segment_sequence",
               "opened_at","sealed_at","event_count","first_envelope_id","last_envelope_id",
               "first_row_hash","last_row_hash","object_list","object_hash_list",
               "source_offset_range","fidelity_summary","completeness_summary",
               "previous_segment","manifest_hash"],
  "additionalProperties": false,
  "properties": {
    "manifest_version": { "type": "string", "const": "evidence-segment-manifest-1.0" },
    "segment_id": { "type": "string", "minLength": 1 },
    "db_id": { "type": "string", "minLength": 1 },
    "engine": { "type": "string", "enum": ["mysql","mariadb","postgres","sqlserver","oracle","mongodb"] },
    "segment_sequence": { "type": "integer", "minimum": 0 },
    "opened_at": { "type": "string", "format": "date-time" },
    "sealed_at": { "type": "string", "format": "date-time" },
    "event_count": { "type": "integer", "minimum": 1 },
    "first_envelope_id": { "type": "string", "format": "uuid" },
    "last_envelope_id": { "type": "string", "format": "uuid" },
    "first_row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
    "last_row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
    "object_list": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["seq","object_id","worm_object_key","object_type"],
        "additionalProperties": false,
        "properties": {
          "seq": { "type": "integer", "minimum": 0 },
          "object_id": { "type": "string", "format": "uuid" },
          "worm_object_key": { "type": "string", "minLength": 1 },
          "object_type": { "type": "string", "enum": ["cce","execution_result","db_audit_event"] }
        }
      }
    },
    "object_hash_list": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["seq","event_hash","row_hash"],
        "additionalProperties": false,
        "properties": {
          "seq": { "type": "integer", "minimum": 0 },
          "event_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
          "row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
        }
      }
    },
    "source_offset_range": {
      "type": "object",
      "required": ["first_offset_key","last_offset_key"],
      "additionalProperties": false,
      "properties": {
        "first_offset_key": { "type": "string" },
        "last_offset_key": { "type": "string" },
        "consumed_gtid_set": { "type": "string" }
      }
    },
    "fidelity_summary": {
      "type": "object",
      "required": ["all_healthy","degraded_count","compromised_count"],
      "additionalProperties": false,
      "properties": {
        "all_healthy": { "type": "boolean" },
        "degraded_count": { "type": "integer", "minimum": 0 },
        "compromised_count": { "type": "integer", "minimum": 0 },
        "reasons": { "type": "array", "items": { "type": "string" } }
      }
    },
    "completeness_summary": {
      "type": "object",
      "required": ["gap_detected","expected_continuous"],
      "additionalProperties": false,
      "properties": {
        "gap_detected": { "type": "boolean" },
        "expected_continuous": { "type": "boolean" },
        "notes": { "type": "array", "items": { "type": "string" } }
      }
    },
    "previous_segment": {
      "type": ["object","null"],
      "additionalProperties": false,
      "properties": {
        "segment_id": { "type": "string" },
        "segment_sequence": { "type": "integer", "minimum": 0 },
        "segment_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    },
    "manifest_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
  },
  "allOf": [
    { "if": { "properties": { "segment_sequence": { "const": 0 } } },
      "then": { "properties": { "previous_segment": { "const": null } } },
      "else": { "properties": { "previous_segment": { "type": "object", "required": ["segment_id","segment_sequence","segment_hash"] } } } }
  ]
}
```

### 16.2 Anchor Record v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/anchor-record-1.0.schema.json",
  "title": "Anchor Record v1",
  "type": "object",
  "required": ["anchor_version","anchor_id","db_id","head","hsm_signature","anchor_provider","created_at"],
  "additionalProperties": false,
  "properties": {
    "anchor_version": { "type": "string", "const": "anchor-record-1.0" },
    "anchor_id": { "type": "string", "format": "uuid" },
    "db_id": { "type": "string", "minLength": 1 },
    "head": {
      "type": "object",
      "required": ["segment_id","segment_sequence","segment_hash","last_row_hash","head_count","signed_at"],
      "additionalProperties": false,
      "properties": {
        "segment_id": { "type": "string" },
        "segment_sequence": { "type": "integer", "minimum": 0 },
        "segment_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "last_row_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "head_count": { "type": "integer", "minimum": 1 },
        "signed_at": { "type": "string", "format": "date-time" }
      }
    },
    "hsm_signature": {
      "type": "object",
      "required": ["algorithm","signing_key_id","signature"],
      "additionalProperties": false,
      "properties": {
        "algorithm": { "type": "string", "enum": ["ecdsa-p384","ed25519","rsa-pss-3072","ecdsa-p256"] },
        "signing_key_id": { "type": "string" },
        "signature": { "type": "string" },
        "revoked_at": { "type": ["string","null"], "format": "date-time" }
      }
    },
    "anchor_provider": {
      "type": "object",
      "required": ["type"],
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "enum": ["rfc3161","transparency_log","dual_custodian"] },
        "rfc3161_token": { "type": "string" },
        "tsa_cert_ref": { "type": "string" },
        "transparency_log": {
          "type": "object",
          "properties": {
            "log_id": { "type": "string" },
            "leaf_index": { "type": "integer", "minimum": 0 },
            "inclusion_proof": { "type": "array", "items": { "type": "string" } },
            "signed_tree_head": { "type": "string" }
          }
        },
        "dual_custodian": {
          "type": "object",
          "properties": {
            "custodian_id": { "type": "string" },
            "signature": { "type": "string" },
            "key_ref": { "type": "string" },
            "timestamp": { "type": "string", "format": "date-time" }
          }
        }
      },
      "allOf": [
        { "if": { "properties": { "type": { "const": "rfc3161" } } },
          "then": { "required": ["rfc3161_token","tsa_cert_ref"] } },
        { "if": { "properties": { "type": { "const": "transparency_log" } } },
          "then": { "required": ["transparency_log"] } },
        { "if": { "properties": { "type": { "const": "dual_custodian" } } },
          "then": { "required": ["dual_custodian"] } }
      ]
    },
    "created_at": { "type": "string", "format": "date-time" }
  }
}
```

### 16.3 Verification Report v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/verification-report-1.0.schema.json",
  "title": "Verification Report v1",
  "type": "object",
  "required": ["report_version","report_id","db_id","verifier","scope","generated_at","overall_result","checks"],
  "additionalProperties": false,
  "properties": {
    "report_version": { "type": "string", "const": "verification-report-1.0" },
    "report_id": { "type": "string", "format": "uuid" },
    "db_id": { "type": "string", "minLength": 1 },
    "verifier": {
      "type": "object",
      "required": ["type"],
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "enum": ["edam_daily","independent_external"] },
        "identity": { "type": "string" }
      }
    },
    "scope": {
      "type": "object",
      "required": ["first_segment_sequence","last_segment_sequence"],
      "additionalProperties": false,
      "properties": {
        "first_segment_sequence": { "type": "integer", "minimum": 0 },
        "last_segment_sequence": { "type": "integer", "minimum": 0 }
      }
    },
    "generated_at": { "type": "string", "format": "date-time" },
    "overall_result": { "type": "string", "enum": ["PASS","FAIL"] },
    "checks": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["check","result"],
        "additionalProperties": false,
        "properties": {
          "check": { "type": "string", "enum": [
            "per_object_hash","object_chain","segment_manifest","cross_segment_continuity",
            "no_missing_segment","no_missing_event","hsm_signature","anchor_token","projection_consistency"] },
          "result": { "type": "string", "enum": ["PASS","FAIL","SKIPPED"] },
          "details": { "type": "string" },
          "offending_ids": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "report_signature": { "type": ["string","null"] }
  }
}
```

### 16.4 Evidence Export Package v1
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://edam.spec/evidence-export-package-1.0.schema.json",
  "title": "Evidence Export Package v1",
  "type": "object",
  "required": ["package_version","package_id","db_id","purpose","created_at","created_by",
               "object_refs","segment_manifests","anchor_records","public_keys",
               "timestamp_certificates","verification_instructions","chain_of_custody_log","export_signature"],
  "additionalProperties": false,
  "properties": {
    "package_version": { "type": "string", "const": "evidence-export-package-1.0" },
    "package_id": { "type": "string", "format": "uuid" },
    "db_id": { "type": "string", "minLength": 1 },
    "purpose": { "type": "string", "enum": ["legal_audit","financial_audit","regulator","court_dispute","internal_investigation"] },
    "created_at": { "type": "string", "format": "date-time" },
    "created_by": { "type": "string", "minLength": 1 },
    "case_reference": { "type": "string" },
    "object_refs": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["object_id","object_type","worm_object_key","event_hash"],
        "additionalProperties": false,
        "properties": {
          "object_id": { "type": "string", "format": "uuid" },
          "object_type": { "type": "string", "enum": ["cce","execution_result","db_audit_event"] },
          "worm_object_key": { "type": "string" },
          "event_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
        }
      }
    },
    "segment_manifests": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "anchor_records": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "public_keys": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["key_id","algorithm","public_key"],
        "additionalProperties": false,
        "properties": {
          "key_id": { "type": "string" },
          "algorithm": { "type": "string" },
          "public_key": { "type": "string" },
          "revoked_at": { "type": ["string","null"], "format": "date-time" }
        }
      }
    },
    "timestamp_certificates": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "verification_instructions": {
      "type": "object",
      "required": ["spec_id","spec_hash"],
      "additionalProperties": false,
      "properties": {
        "spec_id": { "type": "string" },
        "spec_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "procedure_ref": { "type": "string" }
      }
    },
    "chain_of_custody_log": { "type": "array", "items": { "type": "object" }, "minItems": 1 },
    "export_signature": {
      "type": "object",
      "required": ["algorithm","signing_key_id","signature","package_hash"],
      "additionalProperties": false,
      "properties": {
        "algorithm": { "type": "string" },
        "signing_key_id": { "type": "string" },
        "signature": { "type": "string" },
        "package_hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    }
  }
}
```

---

## 17. Examples

### 17.1 Sealed segment manifest
```json
{
  "manifest_version": "evidence-segment-manifest-1.0",
  "segment_id": "seg-000142",
  "db_id": "kafel-prod-mysql",
  "engine": "mysql",
  "segment_sequence": 142,
  "opened_at": "2026-06-01T10:00:00.000Z",
  "sealed_at": "2026-06-01T10:30:00.000Z",
  "event_count": 3,
  "first_envelope_id": "8b1f5c7a-2d44-5f0e-9a3b-1c2d3e4f5a6b",
  "last_envelope_id": "5f6a7b8c-9d0e-5f1a-2b3c-4d5e6f708190",
  "first_row_hash": "sha256:ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
  "last_row_hash":  "sha256:cc22dd33ee44ff5566778899aabbccddeeff00112233445566778899aabbccdd",
  "object_list": [
    { "seq": 0, "object_id": "8b1f5c7a-2d44-5f0e-9a3b-1c2d3e4f5a6b", "worm_object_key": "evidence/2026/06/01/seg-000142/8b1f5c7a.json", "object_type": "cce" },
    { "seq": 1, "object_id": "c3d4e5f6-a7b8-5c9d-0e1f-2a3b4c5d6e7f", "worm_object_key": "evidence/results/2026/06/01/seg-000142/c3d4e5f6.json", "object_type": "execution_result" },
    { "seq": 2, "object_id": "5f6a7b8c-9d0e-5f1a-2b3c-4d5e6f708190", "worm_object_key": "evidence/2026/06/01/seg-000142/5f6a7b8c.json", "object_type": "cce" }
  ],
  "object_hash_list": [
    { "seq": 0, "event_hash": "sha256:9f2c4e1a7b6d3c8f0e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70", "row_hash": "sha256:ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12" },
    { "seq": 1, "event_hash": "sha256:99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa", "row_hash": "sha256:bb11cc22dd33ee44ff5566778899aabbccddeeff001122334455667788990011" },
    { "seq": 2, "event_hash": "sha256:2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80910", "row_hash": "sha256:cc22dd33ee44ff5566778899aabbccddeeff00112233445566778899aabbccdd" }
  ],
  "source_offset_range": {
    "first_offset_key": "3E11FA47-71CA-11E1-9E33-C80AA9429562:152",
    "last_offset_key": "3E11FA47-71CA-11E1-9E33-C80AA9429562:158",
    "consumed_gtid_set": "3E11FA47-71CA-11E1-9E33-C80AA9429562:1-158"
  },
  "fidelity_summary": { "all_healthy": true, "degraded_count": 0, "compromised_count": 0, "reasons": [] },
  "completeness_summary": { "gap_detected": false, "expected_continuous": true, "notes": [] },
  "previous_segment": {
    "segment_id": "seg-000141",
    "segment_sequence": 141,
    "segment_hash": "sha256:5a6b7c8d9e0f102132435465768798a9bacbdcedfe0f102132435465768798a9"
  },
  "manifest_hash": "sha256:7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d"
}
```

### 17.2 RFC 3161 anchor record
```json
{
  "anchor_version": "anchor-record-1.0",
  "anchor_id": "f1e2d3c4-b5a6-5978-8a9b-0c1d2e3f4a5b",
  "db_id": "kafel-prod-mysql",
  "head": {
    "segment_id": "seg-000142",
    "segment_sequence": 142,
    "segment_hash": "sha256:c1d2e3f405162738495a6b7c8d9e0f102132435465768798a9bacbdcedfe0f10",
    "last_row_hash": "sha256:cc22dd33ee44ff5566778899aabbccddeeff00112233445566778899aabbccdd",
    "head_count": 429,
    "signed_at": "2026-06-01T10:30:05.000Z"
  },
  "hsm_signature": {
    "algorithm": "ecdsa-p384",
    "signing_key_id": "edam-evidence-sign-2026Q2",
    "signature": "MGUCMQDk7…base64…",
    "revoked_at": null
  },
  "anchor_provider": {
    "type": "rfc3161",
    "rfc3161_token": "MIIFxDCCA6ygAwIBAgI…base64-DER-TimeStampToken…",
    "tsa_cert_ref": "tsa:freetsa-or-internal:cert-2026"
  },
  "created_at": "2026-06-01T10:30:06.200Z"
}
```

### 17.3 Failed verification report
```json
{
  "report_version": "verification-report-1.0",
  "report_id": "0a1b2c3d-4e5f-5061-7283-94a5b6c7d8e9",
  "db_id": "kafel-prod-mysql",
  "verifier": { "type": "independent_external", "identity": "auditor:pwc-forensics-2026" },
  "scope": { "first_segment_sequence": 140, "last_segment_sequence": 142 },
  "generated_at": "2026-06-02T09:00:00.000Z",
  "overall_result": "FAIL",
  "checks": [
    { "check": "per_object_hash", "result": "FAIL",
      "details": "Recomputed event_hash for object 5f6a7b8c… does not match stored event_hash; CCE core was altered after sealing.",
      "offending_ids": ["5f6a7b8c-9d0e-5f1a-2b3c-4d5e6f708190"] },
    { "check": "object_chain", "result": "FAIL",
      "details": "row_hash chain breaks at seq 2 of seg-000142 due to altered event_hash.",
      "offending_ids": ["seg-000142#2"] },
    { "check": "segment_manifest", "result": "PASS" },
    { "check": "cross_segment_continuity", "result": "PASS" },
    { "check": "no_missing_segment", "result": "PASS" },
    { "check": "no_missing_event", "result": "PASS" },
    { "check": "hsm_signature", "result": "PASS",
      "details": "Anchor signature valid — proves the ALTERED object was NOT the one anchored; tampering occurred post-anchor on the WORM copy or in transit." },
    { "check": "anchor_token", "result": "PASS" },
    { "check": "projection_consistency", "result": "SKIPPED" }
  ],
  "report_signature": "MEUCIQ…base64…"
}
```

### 17.4 Evidence export package
```json
{
  "package_version": "evidence-export-package-1.0",
  "package_id": "1b2c3d4e-5f60-5172-8394-a5b6c7d8e9f0",
  "db_id": "kafel-prod-mysql",
  "purpose": "court_dispute",
  "created_at": "2026-06-03T14:00:00.000Z",
  "created_by": "compliance.omar",
  "case_reference": "CASE-2026-0042",
  "object_refs": [
    { "object_id": "8b1f5c7a-2d44-5f0e-9a3b-1c2d3e4f5a6b", "object_type": "cce",
      "worm_object_key": "evidence/2026/06/01/seg-000142/8b1f5c7a.json",
      "event_hash": "sha256:9f2c4e1a7b6d3c8f0e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70" },
    { "object_id": "c3d4e5f6-a7b8-5c9d-0e1f-2a3b4c5d6e7f", "object_type": "execution_result",
      "worm_object_key": "evidence/results/2026/06/01/seg-000142/c3d4e5f6.json",
      "event_hash": "sha256:99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa" }
  ],
  "segment_manifests": ["evidence/manifests/seg-000141.json","evidence/manifests/seg-000142.json"],
  "anchor_records": ["evidence/anchors/seg-000142.json"],
  "public_keys": [
    { "key_id": "edam-evidence-sign-2026Q2", "algorithm": "ecdsa-p384", "public_key": "MFkwEwYHKoZ…base64…", "revoked_at": null }
  ],
  "timestamp_certificates": ["tsa:internal:cert-2026.pem"],
  "verification_instructions": {
    "spec_id": "EDAM-WORM-Evidence-Anchoring-Spec-1.0",
    "spec_hash": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "procedure_ref": "section-10"
  },
  "chain_of_custody_log": [
    { "custody_event_id": "cc-9001", "action": "export", "reviewer_identity": "compliance.omar",
      "reason": "CASE-2026-0042 court production", "objects_accessed": ["8b1f5c7a…","c3d4e5f6…"],
      "legal_hold_ref": "hold-2026-0042", "occurred_at": "2026-06-03T14:00:00.000Z" }
  ],
  "export_signature": {
    "algorithm": "ecdsa-p384",
    "signing_key_id": "edam-export-sign-2026Q2",
    "signature": "MGUCMQ…base64…",
    "package_hash": "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
  }
}
```

---

## 18. Conformance Tests

| # | Test | Expectation |
|---|---|---|
| **WV-1** | **Deterministic manifest hashing** | Computing `manifest_hash` twice, on two machines/languages, over the same segment yields identical bytes/hash (CCE §12.7 canonical form). |
| **WV-2** | **Tampered CCE detection** | Alter one byte of a sealed CCE core in WORM → `per_object_hash` FAIL and `object_chain` FAIL at that seq; HSM signature still PASS (proving the alteration is post-anchor). |
| **WV-3** | **Missing object detection** | Remove/withhold a WORM object referenced by `object_list` → verification FAIL with the offending key. |
| **WV-4** | **Broken chain detection** | Break `prev_row_hash` linkage (intra- or cross-segment) → `object_chain`/`cross_segment_continuity` FAIL. |
| **WV-5** | **Invalid HSM signature** | Corrupt/forge `hsm_signature.signature` or use an unpublished key → `hsm_signature` FAIL. |
| **WV-6** | **Invalid timestamp token** | Tamper RFC 3161 token / inclusion proof / co-signature → `anchor_token` FAIL. |
| **WV-7** | **Projection drift detection** | Mutate a projection row away from its WORM object → drift alarm + `projection_consistency` FAIL; WORM unaffected; rebuild restores match. |
| **WV-8** | **Legal hold enforcement** | Attempt delete/retention-shorten on a `LEGAL_HOLD` object → denied by storage + CRITICAL alarm + custody-logged attempt. |
| **WV-9** | **No missing segment** | Introduce a `segment_sequence` gap → `no_missing_segment` FAIL. |
| **WV-10** | **No missing event (offset continuity)** | Introduce a GTID/LSN gap between adjacent segments → `no_missing_event` FAIL. |
| **WV-11** | **Genesis correctness** | `segment_sequence==0` MUST have `previous_segment==null` and `previous_segment_hash` of all-zero; non-genesis MUST link. |
| **WV-12** | **Independent verifier isolation** | Run the full §10 procedure using ONLY WORM read + public keys + TSA certs + this spec; MUST complete with no EDAM/CES software or secret. |
| **WV-13** | **Anchor outage behavior** | Simulate TSA outage → segment stays ANCHOR_PENDING, never ANCHORED; alarm raised; no fabricated token; recovery anchors the queued head. |
| **WV-14** | **Export self-verification** | An Evidence Export Package verifies standalone via §10 and continuity holds for the selected objects. |

---

## 19. Implementation Constraints (binding)

1. **WORM is the system of record; PostgreSQL is a rebuildable projection.** No component may treat the projection as authoritative. On conflict, WORM wins and the projection is rebuilt.
2. **Domain B holds an append-only writer only.** No code in B may delete, overwrite, shorten retention, or extract signing keys.
3. **Canonical serialization is frozen and shared.** Manifest, anchor payload, and all hashing use CCE v1 §12.7 rules verbatim. Do not introduce a second serializer.
4. **Sign and anchor only hash structures.** The HSM and external providers receive heads/hashes — never CCE/audit plaintext.
5. **A segment is ANCHORED only after a verified external token.** Never mark ANCHORED on HSM signature alone (unless policy explicitly equates dual-custodian co-sign as the external anchor).
6. **Segment sequences are contiguous from 0 per db_id.** No gaps, no reuse. Genesis uses all-zero `previous_segment_hash`.
7. **The object chain does not reset at segment boundaries.** `first_row_hash` of a segment chains from the prior segment's `last_row_hash`.
8. **VERIFICATION_FAILED is terminal and software-irreversible.** It triggers incident response; never auto-clear by re-writing.
9. **Retention shortening, legal-hold lift, lawful deletion, and key revocation require dual-control** and are chain-of-custody logged.
10. **Every read/export is custody-logged.** Reading evidence is only possible through the custody-logging access gateway.
11. **Anchoring must be bounded** by a max un-anchored window (N events or T minutes); exceeding it alarms.
12. **No fabrication on failure.** TSA/HSM/WORM failure → ANCHOR_PENDING/halt + alarm; never synthesize a token, hash, or "OK".
13. **Crypto-shred, not delete, for erasure.** GDPR erasure of sensitive fields destroys per-record field keys; the evidence object and its hashes remain intact and verifiable over ciphertext.
14. **Geo-replication must preserve immutability** and be hash-verified at the replica; a replica that cannot enforce WORM is not a valid evidence copy.

---

## 20. Breaking Changes (require a v2 of this spec)

The following force a **major** bump (`evidence-segment-manifest-2.0` / `anchor-record-2.0` / etc.):

1. Changing the **canonical serialization or hashing algorithm** (alters `manifest_hash`/`event_hash`/`segment_hash`).
2. Changing the **segment_hash construction** (e.g., from `H(manifest_hash ‖ last_row_hash ‖ previous_segment_hash)` to a Merkle-tree-of-segments scheme).
3. Changing **cross-segment linking** or the genesis rule (§7.3).
4. Changing the **chain order definition** (would desync from CCE v1 §4.2 — itself a CCE breaking change).
5. Removing/renaming any **required manifest, anchor, report, or export field**, or changing its type/meaning.
6. Changing the **anchor payload structure** the HSM signs, or the set of verifiable anchor types in a way that invalidates prior verification.
7. Changing the **independent-verification input set** (e.g., requiring an EDAM online API) — this would *break the core C1 guarantee* and is the most serious possible breakage.
8. Repurposing existing **lifecycle states** or enum values (`SEALED`, `ANCHORED`, provider types, check names).
9. Changing **immutability semantics** (e.g., allowing governance-mode retention as default, or permitting overwrite).
10. Changing the **export package** such that older packages no longer self-verify under the published procedure.

Additive, optional, non-semantic fields and **new** anchor-provider types that don't alter existing verification are **minor** (`*-1.x`), not breaking.

---

*End of WORM Evidence Segment & Anchoring Specification v1. Spec/contract design only — no implementation code. All prior documents remain unmodified; this spec is compatible with CCE v1 and the EDAM companion contracts.*
