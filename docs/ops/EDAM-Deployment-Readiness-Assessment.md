# EDAM Deployment-Readiness Assessment (Pilot / Operational Monitoring)

**Status:** APPROVED — **Conditional GO** for a pilot / operational monitoring rollout.
**Not** a Production Security Sign-Off (§15). Authored as documentation; no live
deployment is performed by this document.

## 0. Readiness boundary (read first)
- **Mature & validated:** monitoring + CDC + **store-level WORM evidence collection**
  (Sprint 1 fidelity, Sprint 2 evidence path + live validation, Sprint 3 P1 store-level
  WORM hardened + revalidated; 700+ tests, determinism, conformance gates, INV-1
  read-only-to-source).
- **Deferred (accepted):** the **legal-grade crypto path + production hardening** —
  dev Ed25519 signer (HSM only dry-run'd), dev RFC-3161 TSA stand-in, **no mTLS / S-8
  dual-control / immutable backups / DR**; verifier trust roots are **dev keys**.
  ⇒ Evidence collected now is **born-locked WORM but DEV-anchored** (R-01) and may
  require re-anchoring once P2 (HSM/TSA/ceremony) completes — the WORM objects survive
  re-anchoring (append-only).
- **Deployment tooling:** the only deploy artifact is the **dev compose**; a minimal
  **pilot runtime config** is provided in [`deploy/pilot/`](../../deploy/pilot). EDAM
  services are **not yet containerized** (no Dockerfiles) — the collector runs as a
  process for the pilot (documented in the runbook); containerization is a pending
  implementation item.

## 1. Readiness by dimension
| Dimension | Status | Notes |
|---|---|---|
| Source safety (INV-1) | ✅ GO | Read-only CDC user; EDAM never writes the monitored DB. |
| CDC fidelity | ✅ GO | ROW+FULL+GTID; file-backed offsets + schema history → exact resume. |
| Store-level WORM collection | ✅ GO | Object Lock COMPLIANCE + per-role SoD IAM + H5 403s + default retention; revalidated. |
| Evidence pipeline (CCE→seal→sign→anchor→export) | ✅ GO (functional) | End-to-end proven live; deterministic; offline-verifiable. |
| Independent verification | ✅ GO | Public-inputs-only verifier; trust file generated (dev roots). |
| Quality gates | ✅ GO | typecheck/lint/full suite/determinism/compose-validate green. |
| Crypto legal-weight (HSM/TSA/ceremony, S-4/S-9) | ⛔ Deferred | Dev signer/TSA/roots — DEV-anchored (R-01). |
| Transport security (mTLS/IP-allow, S-4/S-5) | ⛔ Deferred | Run on a private/isolated network for the pilot. |
| Dual control (S-8) | ⛔ Deferred | Key-lifecycle dual control still the stub. |
| Backups / DR (S-10/S-11) | ⛔ Deferred (R-07) | **Highest-priority post-deployment item.** |
| Production deployment tooling | ⚠️ Conditional | Pilot infra config provided; service containerization pending. |
| Operator documentation | ✅ (this set) | Runbook + monitoring + rollback + validation authored. |

## 2. Verdict & conditions
**CONDITIONAL GO** for a pilot rollout of monitoring + WORM collection against Kafel,
conditioned on:
1. The **DEV-anchored** provenance limitation (R-01) is recorded on all pilot evidence.
2. The pilot runs on the [`deploy/pilot/`](../../deploy/pilot) infra on a private network,
   with the collector run per the runbook.
3. **R-07 (no backups/DR)** is accepted **for the pilot window only** and tracked as the
   **highest-priority** post-deployment item (Priority 2).
4. Post-deployment validation (Kafel) passes its exit criteria before any scale-up.

## 3. Explicitly out of scope (deferred per decision)
P2-DUAL-CONTROL, P2-HSM-SIGNER, P2-TSA, P2-MTLS (Priority 3); Backup/DR planning
(Priority 2). None block the pilot; all are tracked.
