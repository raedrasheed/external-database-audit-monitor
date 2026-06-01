// Deterministic UUIDv5 + envelope_id derivation (Epic E1 / EDAM-T003).
//
// CCE §3: envelope_id = UUIDv5(namespace = EDAM_CCE_NAMESPACE,
//                              name = db_id ‖ "|" ‖ tx_id ‖ "|" ‖ server_uuid)
// with a `part` index appended for size-split envelopes (CCE §12.5).
//
// The derivation is deterministic: identical inputs always yield the same
// envelope_id, which is what makes ingestion idempotent (replays dedupe).

import { createHash } from 'node:crypto';
import { CanonicalError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 4122 URL namespace, used to derive the fixed EDAM namespace below. */
const RFC4122_URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

function uuidToBytes(uuid: string): Buffer {
  if (!UUID_RE.test(uuid)) {
    throw new CanonicalError(`invalid UUID: ${JSON.stringify(uuid)}`);
  }
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(buf: Buffer): string {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** RFC 4122 version-5 (SHA-1, name-based) UUID. */
export function uuidv5(name: string, namespace: string): string {
  const ns = uuidToBytes(namespace);
  const digest = createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/**
 * The fixed EDAM CCE namespace. Derived reproducibly (UUIDv5 of the spec name
 * under the RFC 4122 URL namespace) so the constant itself is verifiable.
 */
export const EDAM_CCE_NAMESPACE = uuidv5('edam.spec/cce/v1', RFC4122_URL_NAMESPACE);

export interface EnvelopeIdParts {
  db_id: string;
  tx_id: string;
  server_uuid: string;
  /** Size-split part index (CCE §12.5); omit for a whole-transaction envelope. */
  part?: number | string;
}

/** Derive the deterministic CCE envelope_id (CCE §3). */
export function envelopeId(parts: EnvelopeIdParts): string {
  let name = `${parts.db_id}|${parts.tx_id}|${parts.server_uuid}`;
  if (parts.part !== undefined) {
    name += `|${parts.part}`;
  }
  return uuidv5(name, EDAM_CCE_NAMESPACE);
}
