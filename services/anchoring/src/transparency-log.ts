// Dev transparency-log provider (Sprint-2 / EDAM-T132).
//
// An append-only Merkle transparency log (RFC 6962-style) acting as an external
// anchor authority (WORM §9.2). Each anchored payload hash is appended as a leaf;
// the provider returns an inclusion proof to a Signed Tree Head (STH) signed by
// the log's key.
//
// The pure RFC 6962 Merkle hashing (leaf/node/tree/inclusion), the canonical STH
// signing bytes, the offline verifier, and the proof/cert/result types live in
// @edam/anchor-proof — shared with the independent verifier so there is ONE
// implementation and no builder<->verifier drift. This module is the KEY-HOLDING,
// tree-state-holding provider wrapper only.
//
// The STH/token are modeled (canonical JSON, not RFC 6962 wire format); a real CT
// log + DER/TLS encoding is a production concern. The provider receives ONLY the
// payload hash; no plaintext (INV-EV-2). The log private key is held in a #field
// and never exported or logged (INV-EV-4).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { isHashToken } from '@edam/canonical';
import {
  leafHashFromPayload,
  merkleTreeHash,
  inclusionPath,
  sthSigningBytes,
  verifyTransparencyLogToken,
  type SignedTreeHead,
  type DevLogCertificate,
} from '@edam/anchor-proof';
import type { AnchorOutcome, AnchorProvider, AnchorRequest, AnchorToken } from './types.js';

export interface DevTransparencyLogProviderOptions {
  /** Existing Ed25519 log private key (PEM/PKCS#8). If omitted, a fresh dev key is generated. */
  privateKeyPem?: string;
  /** Deterministic STH time (RFC3339). Defaults to issue-time `now`. */
  sthTime?: string;
}

function spkiDerB64(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

function deriveLogId(spkiB64: string): string {
  return `dev-ct-ed25519-${createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').slice(0, 16)}`;
}

/**
 * Dev transparency-log provider. Appends each payload hash as a Merkle leaf and
 * returns an inclusion proof to a signed tree head. Holds no plaintext; never
 * exposes the log private key. The Merkle/STH primitives come from
 * @edam/anchor-proof (the same code the verifier checks against).
 */
export class DevTransparencyLogProvider implements AnchorProvider {
  readonly provider_type = 'transparency_log' as const;
  readonly #privateKey: KeyObject;
  readonly #cert: DevLogCertificate;
  readonly #sthTime: string | undefined;
  readonly #leaves: Buffer[] = [];

  constructor(opts: DevTransparencyLogProviderOptions = {}) {
    if (opts.privateKeyPem !== undefined) {
      this.#privateKey = createPrivateKey({ key: opts.privateKeyPem, format: 'pem' });
      if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error(`DevTransparencyLogProvider: expected an ed25519 log key (got ${String(this.#privateKey.asymmetricKeyType)})`);
      }
    } else {
      this.#privateKey = generateKeyPairSync('ed25519').privateKey;
    }
    const publicKeyB64 = spkiDerB64(createPublicKey(this.#privateKey));
    this.#cert = { log_id: deriveLogId(publicKeyB64), algorithm: 'ed25519', public_key: publicKeyB64, subject: 'CN=EDAM Dev Transparency Log' };
    this.#sthTime = opts.sthTime;
  }

  /** The published log certificate (public material only). */
  getCertificate(): DevLogCertificate {
    return { ...this.#cert };
  }

  /** Current number of appended leaves. */
  get treeSize(): number {
    return this.#leaves.length;
  }

  async anchor(request: AnchorRequest): Promise<AnchorOutcome> {
    if (!isHashToken(request.payload_hash)) return { status: 'failed', reason: 'invalid_request' };
    const leafIndex = this.#leaves.length;
    this.#leaves.push(leafHashFromPayload(request.payload_hash));
    const treeSize = this.#leaves.length;
    const inclusion = inclusionPath(leafIndex, this.#leaves).map((b) => b.toString('hex'));
    const sthTime = this.#sthTime ?? new Date().toISOString();
    const sth: SignedTreeHead = {
      log_id: this.#cert.log_id,
      tree_size: treeSize,
      root_hash: merkleTreeHash(this.#leaves).toString('hex'),
      sth_time: sthTime,
    };
    const signature = edSign(null, Buffer.from(sthSigningBytes(sth)), this.#privateKey).toString('base64');
    const signedTreeHead = Buffer.from(JSON.stringify({ sth, signature, signature_algorithm: 'ed25519' }), 'utf8').toString('base64');
    return {
      status: 'anchored',
      token: {
        provider_type: 'transparency_log',
        anchor_provider: { type: 'transparency_log', transparency_log: { log_id: this.#cert.log_id, leaf_index: leafIndex, inclusion_proof: inclusion, signed_tree_head: signedTreeHead } },
        anchored_at: sthTime,
        payload_hash: request.payload_hash,
      },
    };
  }

  verifyToken(token: AnchorToken, request: AnchorRequest): boolean {
    if (token.provider_type !== 'transparency_log' || token.anchor_provider.type !== 'transparency_log') return false;
    if (token.payload_hash !== request.payload_hash) return false;
    const proof = token.anchor_provider.transparency_log;
    if (proof.log_id !== this.#cert.log_id) return false;
    const result = verifyTransparencyLogToken(proof, request.payload_hash, this.#cert);
    if (!result.ok) return false;
    return token.anchored_at === result.sth_time;
  }
}
