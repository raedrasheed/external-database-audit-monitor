# EDAM P2-KEY Planning Package (Index)

**Doc ID:** EDAM-P2-KEY-INDEX-1.0
**Status:** PLANNING ONLY — documentation index for the Production Security Sign-Off
key-ceremony work (Phase P2, task family P2-KEY). **No implementation, code, config,
HSM dry-run, or later task is authorized by this package.** Each implementation task
below is a separate, future, individually-approved task.

## Documents
1. [`EDAM-Key-Ceremony-Policy.md`](./EDAM-Key-Ceremony-Policy.md) — root-trust
   hierarchy, key classes, algorithm, custodian model, rotation/revocation/emergency,
   audit & WORM custody.
2. [`EDAM-Key-Ceremony-Runbook.md`](./EDAM-Key-Ceremony-Runbook.md) — scripted ceremony
   steps (pre-checks → generation → public export → key-id → KeyRecord → trust-file →
   WORM transcript → post-verification → wrong-key rejection).
3. [`EDAM-Trust-Publication-Model.md`](./EDAM-Trust-Publication-Model.md) — registry as
   source of truth, `signing_keys` / `export_keys` generation, `anchor_certs` P2-TSA
   placeholder, mTLS exclusion, versioning/hash, drift prevention.
4. [`EDAM-Dual-Control-Design.md`](./EDAM-Dual-Control-Design.md) — replacing the
   dual-control stub with M-of-N + WORM custody record + ticket/ceremony binding.

## Three trust planes (must stay distinct)
- **Evidence trust** → verifier `signing_keys` (evidence-signing keys).
- **Export trust** → verifier `export_keys` (export-signing keys).
- **Transport trust (mTLS)** → service SVIDs only; **explicitly excluded** from the
  verifier trust file.

## Approved decisions (this documentation package)
| # | Decision | Value |
|---|---|---|
| D1 | Algorithm | **Ed25519 preferred; ECDSA-P384 fallback** only if HSM lacks native Ed25519 |
| D2 | HSM provider | **Open** — candidates documented (CloudHSM / Azure Managed HSM / YubiHSM); not selected |
| D3 | M-of-N quorum | **3-of-5** |
| D4 | Ceremony artifact storage | WORM transcript `p2-key/ceremony/<ceremony_id>/...`; repo evidence `docs/evidence/p2-key/` |
| D5 | Trust generator order | Build **P2-TRUST-GENERATOR before** the real HSM ceremony (dev/test keys first, then production keys) |
| D6 | ExportSigner HSM support | Separate task **P2-HSM-EXPORT-SIGNER** |

## Exact code gaps (identified; not implemented)
| Gap | Where | Resolved by |
|---|---|---|
| HSM-backed `ExportSigner` missing | `@edam/export` (dev signer only) | P2-HSM-EXPORT-SIGNER |
| Concrete `Pkcs11Provider` missing | `packages/signing/src/pkcs11-signer.ts` (`Pkcs11NotConfiguredError`) | P2-HSM-SIGNER |
| Trust-file generator missing | none today | P2-TRUST-GENERATOR |
| Dual-control stub still present | `key-registry.ts` `assertDualControl` (requester ≠ approver only) | P2-DUAL-CONTROL |
| Ceremony artifacts not yet modeled | none today | P2-DUAL-CONTROL / P2-KEY-CEREMONY-REVAL |
| CI drift guard not yet present | none today | P2-TRUST-GENERATOR |

## Implementation task roadmap (each future + separately approved)
| Task | Type | Depends on |
|---|---|---|
| **P2-KEY-DOCS** | documentation (this commit) | — |
| **P2-HSM-DRYRUN** | impl (test-only) | decisions; provider choice |
| **P2-TRUST-GENERATOR** | impl | registry (dev keys ok) — **before HSM ceremony (D5)** |
| **P2-HSM-SIGNER** | impl | P2-HSM-DRYRUN; HSM provisioned |
| **P2-HSM-EXPORT-SIGNER** | impl | P2-HSM-SIGNER (D6) |
| **P2-DUAL-CONTROL** | impl | P2-TRUST-GENERATOR; WORM store |
| **P2-KEY-CEREMONY-REVAL** | impl + evidence | all above |

## Recommended next task
**P2-TRUST-GENERATOR — analysis only** (not implementation). Per D5 it is built before
the real ceremony and gives the drift guard early using dev/test keys.

> This index and its four companion documents are **planning artifacts only**. No
> product code, configuration, or test behavior is changed by committing them.
