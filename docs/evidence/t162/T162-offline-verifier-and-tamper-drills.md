# EDAM-T162 — Offline Verifier Run + Tamper Drills (live)

Machine-readable summary: [`T162-drill-result-summary.json`](./T162-drill-result-summary.json).
Reproducibility artifacts: [`base-export-package.json`](./base-export-package.json),
[`trust.json`](./trust.json), [`objects/`](./objects), [`valid-report.json`](./valid-report.json),
and per-drill CLI reports under [`drills/`](./drills).

T162 ran the **actual `verifier-cli` binary offline** on a real evidence-export
package built from a chain written to **live MinIO**, and executed the nine
tamper drills. The temporary harness is **not committed**; only the public
reproducibility artifacts + result records are.

## Live vs offline vs in-process (explicit)

- **Live:** MinIO WORM (S3 Object Lock bucket) — 3 CCEs written + read back; the
  **legal-hold-delete** drill (deletion denied by live WORM). Image: cached
  `quay.io/minio/minio:latest` retagged `minio/minio:latest` (Docker Hub
  rate-limit).
- **Offline:** the **`verifier-cli` binary** (`npx tsx apps/verifier-cli/src/main.ts
  verify --export … --objects … --trust … --json`, real exit codes) — drills 1–7
  and the valid run. No services contacted during verification.
- **In-process (NOT external live services):** the dev signer
  (`@edam/signing` `DevEd25519Signer`) and the dev anchor providers
  (`@edam/anchoring` `DevRfc3161Provider` / `FakeAnchorProvider`), used to build
  the chain and to run the TSA-outage drill.

## Valid offline run

`verifier-cli verify` on the committed base package → **exit 0**, `overall_result
= PASS`, `export_signature = PASS`. This is **independently reproducible**: run
the CLI on the committed `base-export-package.json` + `objects/` + `trust.json`
(a minimal conformance test also re-runs it).

## Drill results

| # | Drill | WV | Via | Outcome | Fails as expected |
|---|---|---|---|---|---|
| 1 | byte-flip | WV-2 | verifier-cli (offline) | `per_object_hash` FAIL + located id, **exit 1** | ✅ |
| 2 | withhold-object | WV-3 | verifier-cli (offline) | hydration error naming the missing key, **exit 2** (fail-closed; not a §10 FAIL, per D3) | ✅ |
| 3 | break-link | WV-4 | verifier-cli (offline) | `object_chain` FAIL + located id, **exit 1** | ✅ |
| 4 | forge-signature | WV-5 | verifier-cli (offline) | `hsm_signature` FAIL + located id (`export_signature` PASS), **exit 1** | ✅ |
| 5 | tamper-token | WV-6 | verifier-cli (offline) | `anchor_token` FAIL + located id, **exit 1** | ✅ |
| 6 | segment-gap | WV-9 | verifier-cli (offline) | dropped manifest caught by `export_signature` recompute (**exit 1**); see caveat | ✅ |
| 7 | offset-gap | WV-10 | verifier-cli (offline) | `no_missing_event` FAIL + located segment, **exit 1** | ✅ |
| 8 | legal-hold-delete | WV-8 | **live MinIO/WORM** (non-CLI) | deletion **denied** — "under legal hold; deletion denied (W-3)" | ✅ |
| 9 | TSA-outage | WV-13 | **in-process** anchoring (non-CLI) | `pending(provider_outage)`, **no token**, `buildAnchorRecord` refuses (`UnverifiedAnchorError`) — no fabrication | ✅ |

## Caveats

- **Streaming-only** `cce-1.1` CCEs (snapshot-phase scoped out per D5).
- Signing + anchoring are **in-process dev providers**, not external live services.
- **Drill 6 (segment-gap):** dropping a manifest from a built package is detected
  by **`export_signature`** (package_hash recompute), **not** by the §10
  `no_missing_segment` check — the verifier-CLI derives verification scope from
  the manifests present, so `no_missing_segment` stays PASS over the reduced
  scope. The tampering is still caught (exit 1). The `no_missing_segment` §10
  check itself is proven in-process with an explicit scope by T148 WV-9.
- Per §13.3, this validates the live evidence path + the offline verifier + the
  tamper-detection drills; store-level WORM enforcement hardening (H1/H2/H3/H5)
  and the full security sign-off remain T164.
