# EDAM Post-Deployment Validation Plan — Real Kafel Workloads

Validates the pilot against **real Kafel data + workflows** before any scale-up. Pass all
exit criteria for the soak window.

## Steps
1. **Connect (read-only):** point the collector at Kafel MySQL with the **read-only** CDC
   user; confirm **INV-1** (grant audit + conformance no-write proof; no write path exists).
2. **Fidelity:** verify Kafel runs ROW+FULL+GTID; confirm captured changes carry complete
   **before/after** images and **GTID** continuity.
3. **Drive + observe:** run representative Kafel workflows (or `npm run traffic` against a
   Kafel-like schema); confirm **CCEs** are built for real transactions with expected
   attribution.
4. **Evidence path:** confirm **≥ 2 segments** sealed → signed (dev) → anchored (dev) →
   exported; objects **born-locked COMPLIANCE** in WORM; `worm_object_key` / `segment_id`
   / anchor records populated.
5. **Independent verification:** run the offline verifier over **real Kafel evidence** +
   the generated trust file → **PASS**; run a tamper drill on a copy → **fails as expected**.
6. **Resilience:** restart the stack → **exact resume** (no gap/dup); inject a recoverable
   failure → **DLQ capture + replay**; attempt a WORM delete → **store-denied** (403/WORM).
7. **Soak (24–72h):** DLQ ~ 0, no fidelity downgrade, verifier **PASS** each run, monitoring
   stable; produce a **pilot validation report** (with the **DEV-anchored** caveat, R-01).

## Exit criteria (GO / extend decision)
- [ ] INV-1 confirmed (read-only; no source writes).
- [ ] Fidelity (ROW/FULL/GTID) intact across the window.
- [ ] ≥ 2 segments end-to-end; all objects born-locked COMPLIANCE.
- [ ] Offline verifier PASS on real evidence; tamper drill fails as expected.
- [ ] Exact resume after restart; DLQ drains; WORM immutability proven (delete denied).
- [ ] Soak: DLQ ~ 0, verifier PASS each run, no fidelity downgrade, monitoring stable.
- [ ] Risk register reviewed; **R-01 caveat recorded** on evidence; **R-07** reconciliation
      (backup/DR) scheduled as Priority 2.

## Out of scope of this validation
Legal-grade crypto (HSM/TSA/ceremony), mTLS, dual control, DR — deferred (P2/P3).
A PASS here certifies **operational monitoring + WORM collection**, **not** the §15
Production Security Sign-Off.
