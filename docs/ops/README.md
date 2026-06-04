# EDAM Operations (Pilot)

Operator-facing documentation for running EDAM as a **pilot / operational monitoring +
WORM evidence collection** platform. This is **not** a Production Security Sign-Off (§15):
the crypto path is **DEV-anchored** (R-01) and backups/DR are deferred (R-07, highest
post-deployment priority).

## Documents
- [Deployment-Readiness Assessment](./EDAM-Deployment-Readiness-Assessment.md) — Conditional GO + conditions.
- [Operator Runbook](./EDAM-Operator-Runbook.md) — pre-flight, bring-up, health, failures, escalation.
- [Risk Register](./EDAM-Risk-Register.md) — accepted risks (R-01, R-07) + mitigations.
- [Rollback Plan](./EDAM-Rollback-Plan.md) — INV-1/WORM-safe rollback + resume.
- [Monitoring & Observability Checklist](./EDAM-Monitoring-Checklist.md) — signals + alarm severities.
- [Post-Deployment Validation Plan](./EDAM-Post-Deployment-Validation-Plan.md) — real Kafel validation + exit criteria.

## Runtime config
- [`deploy/pilot/`](../../deploy/pilot) — minimal pilot infra (CDC + state + WORM) with an
  **external** Kafel source. EDAM services run as processes for the pilot (containerization
  is a tracked pending item, R-11).

## Priorities (per decision)
1. Operational deployment readiness · monitoring · runbook · Kafel validation.
2. Backup & Disaster Recovery (R-07) — highest post-deployment item.
3. P2-DUAL-CONTROL · P2-HSM-SIGNER · P2-TSA · P2-MTLS.
