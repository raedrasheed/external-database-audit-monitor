// Deterministic DLQ hashing + id derivation (Epic E5 / EDAM-T037).
//
// The payload hash and event id are deterministic so the SAME failing event
// maps to ONE DLQ row (retry_count increments) rather than spawning duplicates
// — this is what prevents unbounded growth under retry loops while guaranteeing
// no event is lost. Uses the shared, tested SHA-256 from @edam/canonical; the
// payload is serialized with a local stable stringifier that (unlike the CCE
// canonical form) never rejects floats — a failing payload must always hash.

import { sha256Hex } from '@edam/canonical';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

/** Deterministic, total stringification of an arbitrary payload (never throws). */
export function stableStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(sortKeys(value ?? null));
  } catch {
    return String(value);
  }
}

/** Deterministic sha256:<hex> of the original payload. */
export function payloadHash(payload: unknown): string {
  return 'sha256:' + sha256Hex(stableStringify(payload));
}

/** Deterministic DLQ event id from (engine, offset, payload hash). */
export function deterministicEventId(engine: string, offset: string | null, pHash: string): string {
  return 'dlq-' + sha256Hex(`${engine}|${offset ?? ''}|${pHash}`).slice(0, 32);
}
