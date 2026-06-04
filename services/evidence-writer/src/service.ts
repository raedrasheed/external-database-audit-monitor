// Evidence-writer SERVICE composition root (R-11b). Wires the proven pipeline
// components into a runnable service: CCE -> SegmentAccumulator -> SegmentSealer
// (writes CCE objects + manifest to WORM via EvidenceWriter, establishes the chain) ->
// sign the head (Domain-C signer) -> anchor (provider; ANCHORED only on a verified
// token, no fabrication) -> write the anchor record to WORM. Born-locked COMPLIANCE
// retention (B2/H4). Dependencies are INJECTED (ports), so the same composition runs
// against the InMemory fakes (tests) or the live MinIO + dev signer/anchoring (main.ts).
//
// PILOT BOUNDARY: signer/anchor are DEV providers in the pilot (DEV-anchored, R-01).
// The CCE input is produced by the normalization service (R-11c); until that lands the
// live service has no input on the bus.
import type { Cce } from '@edam/cce-model';
import { buildAnchorPayload } from '@edam/evidence';
import type { Signer } from '@edam/signing';
import { anchorRequestFor, requestAnchor, buildAnchorRecord, isAnchored, type AnchorProvider } from '@edam/anchoring';
import type { WormStore } from '@edam/worm';
import type { DlqService } from '@edam/dlq';
import { SegmentAccumulator, type SegmentCaps, type SealReadySegment } from './accumulator.js';
import { EvidenceWriter } from './writer.js';
import { SegmentSealer, type PreviousSealed, type SealAlarm } from './sealer.js';

export interface EvidenceWriterServiceDeps {
  /** WORM store (per-role handles; born-locked COMPLIANCE retention). */
  store: WormStore;
  /** Anchor-head signer (dev in the pilot — DEV-anchored, R-01). */
  signer: Signer;
  /** External anchoring provider (dev RFC-3161 in the pilot). */
  anchor: AnchorProvider;
  /** Failure sink for the object writer (persist-then-alarm). */
  dlq: DlqService;
  /** Segment caps (event-count + age). */
  caps: SegmentCaps;
  dbId: string;
  /** Clock (DI for determinism). */
  now?: () => string;
  /** Observability hook for seal alarms (incl. terminal VERIFICATION_FAILED). */
  onAlarm?: (a: SealAlarm) => void;
}

export interface ServiceStats {
  ingested: number;
  sealed: number;
  anchored: number;
  pending: number; // anchor produced no verified token (no fabrication) — re-drive later
  failed: number;  // seal VERIFICATION_FAILED / WORM write failure
  rejected: number; // CCE not admitted by the accumulator
}

/** Deterministic WORM key for a segment's anchor record. */
export function anchorRecordKey(dbId: string, segmentId: string): string {
  return `${dbId}/${segmentId}/anchor.json`;
}

export class EvidenceWriterService {
  readonly #acc: SegmentAccumulator;
  readonly #sealer: SegmentSealer;
  readonly #store: WormStore;
  readonly #signer: Signer;
  readonly #anchor: AnchorProvider;
  readonly #dbId: string;
  readonly #now: () => string;
  readonly #onAlarm: (a: SealAlarm) => void;
  #previous: PreviousSealed | null = null;
  readonly stats: ServiceStats = { ingested: 0, sealed: 0, anchored: 0, pending: 0, failed: 0, rejected: 0 };

  constructor(deps: EvidenceWriterServiceDeps) {
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#store = deps.store;
    this.#signer = deps.signer;
    this.#anchor = deps.anchor;
    this.#dbId = deps.dbId;
    this.#onAlarm = deps.onAlarm ?? (() => {});
    this.#acc = new SegmentAccumulator({ caps: deps.caps, now: this.#now });
    const objectWriter = new EvidenceWriter({ worm: deps.store.writer(), dlq: deps.dlq, now: this.#now });
    this.#sealer = new SegmentSealer({
      objectWriter,
      worm: deps.store.writer(),
      emitHead: () => {}, // the SEALED outcome carries the head; no separate emit needed here
      alarms: { raise: (a) => this.#onAlarm(a) },
      now: this.#now,
    });
  }

  /** Ingest one CCE; seals + anchors any segments that become ready. */
  async ingest(cce: Cce): Promise<void> {
    this.stats.ingested++;
    const { sealed, rejected } = this.#acc.add(cce);
    if (rejected !== undefined) this.stats.rejected++;
    for (const seg of sealed) await this.#sealAndAnchor(seg);
  }

  /** Time-cap sweep: seal + anchor any segments past their age cap. Call periodically. */
  async sweep(): Promise<void> {
    for (const seg of this.#acc.sweep()) await this.#sealAndAnchor(seg);
  }

  async #sealAndAnchor(seg: SealReadySegment): Promise<void> {
    const out = await this.#sealer.seal(seg, this.#previous);
    if (out.status !== 'SEALED') {
      this.stats.failed++; // VERIFICATION_FAILED (terminal alarm raised) or WRITE_FAILED
      return;
    }
    this.stats.sealed++;
    // SegmentHead is a ChainHead (db_id, segment_id, segment_sequence, segment_hash, last_row_hash).
    const payload = buildAnchorPayload(out.head, { headCount: 1, signedAt: this.#now() });
    const hsm = await this.#signer.sign(payload);
    const outcome = await requestAnchor(this.#anchor, anchorRequestFor(payload));
    if (isAnchored(outcome)) {
      const record = buildAnchorRecord({ head: payload, hsmSignature: hsm, anchorOutcome: outcome, createdAt: this.#now() });
      await this.#store.writer().putImmutable(
        anchorRecordKey(this.#dbId, out.head.segment_id),
        new TextEncoder().encode(JSON.stringify(record)),
        { retentionMode: 'compliance' },
      );
      this.stats.anchored++;
    } else {
      // No verified token ⇒ ANCHORED is NOT asserted and NO token is fabricated
      // (INV-EV-3/INV-EV-6). The segment is sealed + in WORM; anchoring is re-driven later.
      this.stats.pending++;
    }
    this.#previous = { manifest: out.manifest, head: out.head };
  }
}
