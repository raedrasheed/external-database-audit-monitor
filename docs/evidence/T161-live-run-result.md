# EDAM-T161 — Live Evidence Harness Run Result

Machine-readable result: [`T161-live-run-result.json`](./T161-live-run-result.json).

T161 drove **real CCEs** through the evidence path **writer → seal → sign → anchor**
against a **live MinIO WORM** store, forcing two segments (genesis + one successor),
and read the objects back from live MinIO. The temporary harness itself is **not
committed** (per the backlog: "Temporary harness (not committed)"); this result
summary is the committed artifact that the T163 live-validation report cites.

## What was live vs in-process

- **Live:** MinIO WORM (S3 Object Lock + versioning) — `ensureBucket`, `putImmutable`,
  `get`, and an **overwrite-rejected** immutability check, over the wire at
  `127.0.0.1:9000` (image: cached `quay.io/minio/minio:latest`, retagged
  `minio/minio:latest` to avoid a rate-limited Docker Hub pull).
- **In-process (NOT external live services):** the dev signer
  (`@edam/signing` `DevEd25519Signer`) and the dev anchor provider
  (`@edam/anchoring` `DevRfc3161Provider` + `requestAnchor`), plus the T133
  anchor-record/anchor-ref builders. Consistent with T160 (the dev-signer /
  dev-tsa-log compose services are topology/health stand-ins, never the real
  crypto path). These are **not** described as external live services.

## Result (summary)

| Item | Value |
|---|---|
| Objects written + anchored | **3** |
| Segments | **2** (genesis `seq 0` + successor `seq 1`) |
| `evidence.worm_object_key` populated live | **yes** (e.g. `kafel-dev-mysql/seg-<run>-000000/000000.cce.json`) |
| `evidence.segment_id` populated live | **yes** (e.g. `seg-<run>-000000`) |
| `evidence.anchor_ref` populated | **yes** (`{head_hash, hsm_signature, tsa_token, anchor_provider:rfc3161}`) |
| Read back from live MinIO | **3 / 3**, all back-refs populated |
| Live WORM overwrite rejected (immutability) | **yes** |
| No fabricated anchor tokens (INV-EV-3/6) | **yes** (`requestAnchor` returns `anchored` only on a verified token) |
| WV-1 deterministic manifest hash | **PASS** |
| WV-11 genesis + continuity | **PASS** |

## Caveats

- All CCEs were built as **streaming-phase** `cce-1.1`. A fully-valid **snapshot-phase**
  CCE requires the snapshot-epoch assembly path (normalization/collector), which was
  scoped out for T161 (Q2: prove the evidence path, not the CDC pipeline). The
  WORM/seal/sign/anchor evidence path proven here is snapshot/streaming-phase-agnostic.
- The signer/anchor are **in-process dev providers** (not external TSA/HSM services);
  the real external anchoring authority remains future work (deferred at T130).
- Per the §13.3 gating, this run demonstrates the live **evidence path + durability +
  immutability-on-overwrite**; full WORM read-path-integrity-under-a-compromised-writer
  enforcement (H1/H2/H3/H5) and the tamper drills remain T162.
