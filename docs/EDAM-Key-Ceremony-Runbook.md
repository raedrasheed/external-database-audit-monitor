# EDAM Key Ceremony Script / Runbook (DRAFT)

**Doc ID:** EDAM-KEY-CEREMONY-RUNBOOK-1.0
**Status:** PLANNING ONLY — a scripted runbook draft. It does **not** authorize or
schedule a ceremony and is **not** executed by any code yet. The real ceremony is the
later, separately-approved task **P2-KEY-CEREMONY-REVAL**, performed only after the
HSM signer / export-signer / trust-generator / dual-control tasks land. A test-HSM
**dry-run (P2-HSM-DRYRUN)** must pass before any production ceremony.

Pairs with `EDAM-Key-Ceremony-Policy.md` (decisions) and
`EDAM-Trust-Publication-Model.md` (trust outputs). Grounded in `Signer`,
`createSigner({kind:'pkcs11'})`, `Pkcs11Signer`/`Pkcs11Provider`,
`KeyRotationRegistry`/`KeyRecord`, `deriveKeyId`, and the verifier `TrustFile`.

Approved parameters: **Ed25519 preferred (ECDSA-P384 fallback)**, **3-of-5 quorum**,
WORM transcript at `p2-key/ceremony/<ceremony_id>/...`, repo evidence at
`docs/evidence/p2-key/`.

## A. Pre-ceremony checklist
- Policy ratified; algorithm confirmed (Ed25519 unless the chosen HSM lacks native
  support ⇒ ECDSA-P384); **HSM provider selected** (a later decision — open in this
  package); custodian roster of five confirmed and identities verified; `ceremony_id`
  `CER-<date>-<seq>` minted; change `ticket_id` linked; air-gapped ceremony host
  prepared (no network); witnesses scheduled; this runbook dry-run passed on a test
  HSM (P2-HSM-DRYRUN).

## B. HSM readiness checks
- HSM firmware + FIPS 140-3 L3 attested; M-of-N (3-of-5) quorum initialized; RNG
  health check; algorithm support confirmed (Ed25519 or P-384); PKCS#11 session
  establishes from the ceremony host; no residual keys present.

## C. Custodian verification
- Each of the five custodians authenticates to the HSM with their share; a 3-of-5
  quorum forms; record presence + identity of all custodians and witnesses in the
  transcript.

## D. Key generation steps (per class; in-HSM, non-exportable)
1. Generate the **Evidence-Signing** root key (chosen algorithm), `CKA_EXTRACTABLE = false`.
2. Generate the **Export-Signing** root key (same constraints).
3. Generate the **mTLS intermediate CA** key + CSR to the Root; sign the intermediate
   certificate. (Transport plane; not an evidence key.)

## E. Public key export steps
- Export **only** the SPKI public key (DER → base64) for the evidence and export keys.
  Private material never leaves the HSM (INV-EV-4). Capture each SPKI into the
  transcript.

## F. Key ID derivation
- `signing_key_id = deriveKeyId(spkiBase64)` for each evidence/export key — the same
  derivation used in `packages/signing/src/dev-signer.ts`. The mTLS CA uses a
  certificate reference managed by the cert tooling (not a `signing_key_id`).

## G. KeyRecord creation
- For each evidence/export key, assemble
  `KeyRecord { signing_key_id, algorithm, public_key, created_at, revoked_at: null }`
  and validate it against the registry's rules (real RFC3339 `created_at`; `algorithm`
  in the `SignAlgorithm` enum; `revoked_at` null — mirrors `InvalidKeyRecordError`).
  Seed the production `KeyRotationRegistry` (active) for each class.

## H. Trust-file generation
- Generate the verifier trust file **from registry history** (see
  `EDAM-Trust-Publication-Model.md`): `signing_keys` (evidence) + `export_keys`
  (export). Leave `anchor_certs` as a **P2-TSA placeholder** (empty/staged). The mTLS
  CA is **excluded**. Produce `trust.json` + its content hash.

## I. WORM ceremony transcript
- Write the full transcript (steps A–H: SPKIs, key ids, custodians, witnesses,
  `ticket_id`/`ceremony_id`, HSM attestation, trust-file hash) to the evidence WORM
  store under `p2-key/ceremony/<ceremony_id>/...` — **born-locked COMPLIANCE** (reuse
  the P1 writer path).

## J. Post-ceremony verification
- **Canary:** sign a known `AnchorPayload` via the production `Pkcs11Signer`; build an
  anchor record; run the **independent verifier** against the published trust file ⇒
  expect **PASS**. Confirm `getPublicKey(id)` resolves. Re-verify the S3-REVAL corpus
  against the production trust roots.

## K. Wrong-key rejection test
- Sign with a non-published key (or tamper the `signing_key_id`); the verifier **MUST
  reject** (`UnknownKeyError` / signature failure) ⇒ non-zero exit. Record this
  negative control proving the trust file is authoritative.

## L. Seal & close
- Re-seal the root activation material; distribute custodian shares to separate
  physical custody; close the HSM session; archive the transcript reference; publish
  the trust-file hash to the audit channel.

## Reproducibility artifacts (repo)
On a real ceremony, the reproducibility artifacts (published trust file, canary
verification report, wrong-key rejection report, and a committed offline re-verify
guard mirroring `conformance/test/s3-reval-offline-verify.test.ts`) are placed under
`docs/evidence/p2-key/`. **None of this is produced yet** — this is the runbook only.
