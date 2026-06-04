# EDAM Dual-Control Replacement Design (DRAFT)

**Doc ID:** EDAM-DUAL-CONTROL-1.0
**Status:** PLANNING ONLY — design for replacing the current dual-control **stub** with
production-grade M-of-N custody. **Nothing here is implemented.** The build is the
later, separately-approved task **P2-DUAL-CONTROL** (the key-operations slice of §15
S-8; the broader retention / legal-hold / object-lock-config dual control is the
separate Phase-2 task **P2-DUAL**, not covered here).

Grounded in `KeyRotationRegistry` (`packages/signing/src/key-registry.ts`):
`rotate(newKey, approval)` / `revoke(id, approval, revokedAt)` /
`DualControlApproval` / `assertDualControl` / `CannotRevokeActiveKeyError` /
`InvalidKeyRecordError`.

## 1. Current state — STUB, NOT PRODUCTION SUFFICIENT
The registry's `assertDualControl` enforces **only** a two-person rule
(`requestedBy !== approvedBy`). The source itself marks this a **STUB** ("real
dual-control + a WORM-logged custody record is a Domain-C operational control,
deferred"). **It is explicitly not sufficient for production sign-off.** This design
replaces it.

## 2. Target controls (added on top of the stub)
The existing requester ≠ approver check is retained as a **first** gate. The following
are added as **required** additional gates for any lifecycle change
(`rotate` / `revoke` / emergency):

1. **M-of-N custodian approval (3-of-5).** The HSM crypto operation requires the
   3-of-5 quorum, **and** the registry change requires a matching approval record
   carrying ≥ 3 distinct custodian approvals.
2. **WORM custody record.** Every lifecycle change writes a **born-locked** custody
   record to the evidence store **before** the change is published.
3. **Ticket id binding.** Each change references an approved change `ticket_id`; the
   registry mutation is rejected without it.
4. **Ceremony id binding.** Root / emergency events bind a `ceremony_id`; routine
   rotations bind the originating `ticket_id`.

## 3. Identity model
- `requestedBy` — exactly one principal.
- `approvers` — ≥ M (3) distinct principals, each distinct from the requester and from
  each other.
- `witnesses` — ≥ 1 distinct principal.
- All distinct, role-separated principals (S-7 / S-8).

## 4. Failure modes (all fail-closed)
| Condition | Result |
|---|---|
| requester ∈ approvers | reject (`DualControlError`) |
| fewer than M distinct approvers | reject |
| missing `ticket_id` / required `ceremony_id` | reject |
| revoke before rotate (revoking the active key) | `CannotRevokeActiveKeyError` |
| unknown / malformed `KeyRecord` | `InvalidKeyRecordError` |
| WORM custody write fails | **abort** the lifecycle change (no publication) |

No code path may mutate the registry (or publish a new trust file) without a
successfully-written, born-locked custody record.

## 5. Audit record shape (proposed)
```
KeyLifecycleAuditRecord {
  record_version,
  event: 'ceremony' | 'rotate' | 'revoke' | 'emergency',
  ceremony_id?,                      // required for ceremony/emergency
  ticket_id,
  key_class: 'evidence' | 'export',
  signing_key_id, algorithm, public_key,
  requestedBy,
  approvers: [ ... ],                // >= M distinct, != requester
  witnesses: [ ... ],                // >= 1
  quorum: { m, n },                  // e.g. { m: 3, n: 5 }
  occurred_at,
  trust_version_after,
  trust_file_hash,                   // sha256(canonical(trust.json)) after the change
  prior_signing_key_id?              // for rotate / revoke
}
// Stored born-locked (COMPLIANCE) in the evidence WORM store.
```

## 6. Relationship to other tasks
- **Trust republication:** any approved change triggers a new trust-file version via
  P2-TRUST-GENERATOR (§7 of the Trust Publication Model). The new `trust_file_hash` is
  recorded in the custody record.
- **Emergency replacement:** the time-boxed, dual-approved, fully-audited break-glass
  flow from the Key Ceremony Policy (§8) uses this same custody-record + quorum model.

## 7. Code gaps (not yet implemented)
- **Dual-control stub still present** (`assertDualControl` = requester ≠ approver only).
- **Ceremony artifacts not yet modeled** (`KeyLifecycleAuditRecord` schema + WORM
  writer wiring do not exist).
- These are implemented in **P2-DUAL-CONTROL**, after P2-TRUST-GENERATOR.
