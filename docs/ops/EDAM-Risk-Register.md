# EDAM Risk Register (Pilot)

Accepted risks and mitigations for the pilot / operational monitoring phase. Severity =
Likelihood × Impact. **R-01 and R-07 are formally accepted** per the deployment decision;
R-07 is the **highest-priority** post-deployment item.

| ID | Risk | Likelihood | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| **R-01** | Evidence is **DEV-anchored** (dev signer/TSA/roots) — not legally defensible yet | Certain | High | Record provenance caveat on all pilot evidence; plan re-anchor after P2 (HSM/TSA/ceremony); WORM objects survive re-anchor | Security | **ACCEPTED (pilot)** |
| **R-07** | **No immutable backups / DR** — single-store loss destroys evidence | Med | **High** | Pilot on durable infra; add cross-region/account Object-Lock replication **before** scale-up; short reconciliation plan | Ops/Infra | **ACCEPTED (pilot only) — HIGHEST-PRIORITY follow-up (Priority 2)** |
| R-02 | No mTLS / IP allow-list — internal traffic in clear | Med | Med | Run on a **private/isolated** network; restrict access; close in P2-MTLS/NET | Infra | Accepted (deferred, P3) |
| R-03 | Dual-control stub — single actor can rotate/revoke keys | Med | High | Restrict key-op access operationally; **no routine key ops** in pilot; close in P2-DUAL | Security | Accepted (deferred, P3) |
| R-04 | Keys not hardware-protected (no HSM ceremony) | Certain | High | Treat dev keys as non-authoritative; restrict; P2-HSM + ceremony | Security | Accepted (deferred, P3) |
| R-05 | Source fidelity regression (Kafel binlog/GTID change) | Low | High | Stack asserts ROW/FULL/GTID; alarm on downgrade; pre-flight check | Ops | Mitigated |
| R-06 | CDC lag / DLQ growth → evidence gaps | Med | Med | Monitor lag+DLQ; source binlog retention ≥ recovery window; replay path | Ops | Mitigated |
| R-08 | Operating the **dev** stack as if production | Med | Med | Use `deploy/pilot/` infra; never run `dev-*` stubs as the real crypto path; runbook boundaries | Ops | Mitigated |
| R-09 | WORM mis-config (lock/retention off) | Low | High | minio-init + adapter `ensureBucket` assert Object Lock (H3) fail-fast; pre-flight verify | Infra | Mitigated |
| R-10 | INV-1 violation (write to source) | Very low | Critical | Read-only CDC grants; conformance no-write proof; pre-flight grant audit | Security | Mitigated |
| R-11 | EDAM services not containerized (pilot runs as process) | Med | Low | Documented run procedure; containerization tracked as pending implementation | Ops/Eng | Tracked |

## Review cadence
- Re-review on any incident, before scale-up, and at the start of each Priority-2/3 task.
- **R-07** reviewed weekly until backup/DR (Priority 2) is implemented.
