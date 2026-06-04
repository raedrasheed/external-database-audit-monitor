// P2-HSM-DRYRUN — SoftHSM2-backed Ed25519 PKCS#11 helper (TEST-SCOPED).
//
// Implements the EXISTING @edam/signing `Pkcs11Provider` SPI against a SoftHSM2
// token via pkcs11js — proving the HSM seam works UNCHANGED. Ed25519 / CKM_EDDSA
// only (ADR-EDAM-001). Private keys are generated NON-EXPORTABLE (CKA_EXTRACTABLE=
// false, CKA_SENSITIVE=true) and never leave the token; only signatures + the
// published SPKI public key cross the boundary (INV-EV-4).
//
// pkcs11js is loaded DYNAMICALLY via a variable specifier so the repo typechecks /
// lints WITHOUT the native dependency installed; the gated integration test is the
// only caller and runs only when PKCS11_MODULE_PATH is set.
import { createRequire } from 'node:module';
import { createHash, createPublicKey } from 'node:crypto';
import type { Pkcs11Provider, SignAlgorithm } from '@edam/signing';

// --- PKCS#11 v3.0 numeric constants pkcs11js does not export by name (EdDSA) ---
const CKM_EC_EDWARDS_KEY_PAIR_GEN = 0x00001055;
const CKM_EDDSA = 0x00001057;
const CKK_EC_EDWARDS = 0x00000040;
const CKO_PUBLIC_KEY = 2;
const CKO_PRIVATE_KEY = 3;
const CKU_USER = 1;
const CKF_SERIAL_SESSION = 4;
const CKF_RW_SESSION = 2;
const CKA = {
  CLASS: 0, TOKEN: 1, PRIVATE: 2, LABEL: 3, KEY_TYPE: 256, VALUE: 17,
  SIGN: 264, VERIFY: 266, SENSITIVE: 259, EXTRACTABLE: 354, EC_PARAMS: 384, EC_POINT: 385,
} as const;
// Ed25519 EC_PARAMS = DER PrintableString "edwards25519" (what SoftHSM2 emits/accepts).
const ED25519_EC_PARAMS = Buffer.from('130c656477617264733235353139', 'hex');
// SPKI DER prefix for an Ed25519 public key, followed by the 32-byte raw point.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/* pkcs11js native module is loosely typed below; `no-explicit-any` is disabled repo-wide. */
type Pk = any; // pkcs11js native module
type Handle = Buffer;

/** Load pkcs11js at runtime only (variable specifier => not resolved at compile time). */
function loadPkcs11js(): Pk {
  const req = createRequire(import.meta.url);
  const spec = 'pkcs11js';
  const mod = req(spec);
  return new mod.PKCS11();
}

export interface SoftHsmConfig {
  modulePath: string; // PKCS11_MODULE_PATH (libsofthsm2.so)
  tokenLabel: string;
  pin: string;
}

export interface HsmKey {
  signing_key_id: string;
  /** SPKI DER (base64) — the published public key the verifier consumes. */
  public_key: string;
  privHandle: Handle;
  pubHandle: Handle;
}

/** A logged-in SoftHSM2 session with Ed25519 keygen + a Pkcs11Provider. */
export class SoftHsmSession {
  #pk: Pk;
  #session: Handle | undefined;
  readonly #keys = new Map<string, Handle>(); // signing_key_id -> private key handle

  constructor(private readonly cfg: SoftHsmConfig) {
    this.#pk = loadPkcs11js();
  }

  open(): void {
    this.#pk.load(this.cfg.modulePath);
    this.#pk.C_Initialize();
    const slots: Handle[] = this.#pk.C_GetSlotList(true);
    let slot: Handle | undefined;
    for (const s of slots) {
      const info = this.#pk.C_GetTokenInfo(s);
      if (String(info.label).trim() === this.cfg.tokenLabel) { slot = s; break; }
    }
    if (slot === undefined) throw new Error(`SoftHSM2 token ${JSON.stringify(this.cfg.tokenLabel)} not found`);
    this.#session = this.#pk.C_OpenSession(slot, CKF_SERIAL_SESSION | CKF_RW_SESSION);
    this.#pk.C_Login(this.#session, CKU_USER, this.cfg.pin);
  }

  private get session(): Handle {
    if (this.#session === undefined) throw new Error('SoftHSM2 session not open');
    return this.#session;
  }

  /** Generate a NON-EXPORTABLE Ed25519 keypair in the token; returns the published SPKI + handles. */
  generateEd25519(labelSeed: string): HsmKey {
    const label = `${labelSeed}-${Date.now().toString(36)}`;
    const pubTmpl = [
      { type: CKA.CLASS, value: CKO_PUBLIC_KEY },
      { type: CKA.KEY_TYPE, value: CKK_EC_EDWARDS },
      { type: CKA.EC_PARAMS, value: ED25519_EC_PARAMS },
      { type: CKA.TOKEN, value: true },
      { type: CKA.VERIFY, value: true },
      { type: CKA.LABEL, value: label },
    ];
    const privTmpl = [
      { type: CKA.CLASS, value: CKO_PRIVATE_KEY },
      { type: CKA.KEY_TYPE, value: CKK_EC_EDWARDS },
      { type: CKA.TOKEN, value: true },
      { type: CKA.PRIVATE, value: true },
      { type: CKA.SIGN, value: true },
      { type: CKA.SENSITIVE, value: true },     // private material is sensitive
      { type: CKA.EXTRACTABLE, value: false },  // NON-EXPORTABLE
      { type: CKA.LABEL, value: label },
    ];
    const { publicKey, privateKey } = this.#pk.C_GenerateKeyPair(
      this.session, { mechanism: CKM_EC_EDWARDS_KEY_PAIR_GEN }, pubTmpl, privTmpl,
    );
    // Read CKA_EC_POINT (DER OCTET STRING wrapping the 32-byte raw point) -> SPKI.
    const [{ value: ecPoint }] = this.#pk.C_GetAttributeValue(this.session, publicKey, [{ type: CKA.EC_POINT }]);
    const buf = Buffer.from(ecPoint as Buffer);
    if (buf[0] !== 0x04) throw new Error('unexpected EC_POINT encoding (not an OCTET STRING)');
    const raw = buf.subarray(2, 2 + buf[1]!);
    if (raw.length !== 32) throw new Error(`unexpected Ed25519 point length ${raw.length}`);
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
    createPublicKey({ key: spki, format: 'der', type: 'spki' }); // validate it parses as Ed25519
    const public_key = spki.toString('base64');
    const signing_key_id = `edam-hsm-ed25519-${createHash('sha256').update(spki).digest('hex').slice(0, 16)}`;
    this.#keys.set(signing_key_id, privateKey as Handle);
    return { signing_key_id, public_key, privHandle: privateKey as Handle, pubHandle: publicKey as Handle };
  }

  /** A Pkcs11Provider (the existing SPI) bound to this session — signature only, no private material. */
  provider(): Pkcs11Provider {
    const pk = this.#pk;
    const session = this.session;
    const keys = this.#keys;
    return {
      algorithm: 'ed25519' as SignAlgorithm,
      hasKey(signingKeyId: string): boolean { return keys.has(signingKeyId); },
      async sign(signingKeyId: string, message: Uint8Array): Promise<Uint8Array> {
        const priv = keys.get(signingKeyId);
        if (priv === undefined) throw new Error(`PKCS#11: no private key for ${signingKeyId}`);
        pk.C_SignInit(session, { mechanism: CKM_EDDSA }, priv);
        const sig: Buffer = pk.C_Sign(session, Buffer.from(message), Buffer.alloc(64));
        return new Uint8Array(sig);
      },
    };
  }

  /** Prove the private key never leaves: extractable=false, sensitive=true, value read denied. */
  proveNonExportable(privHandle: Handle): { extractable: boolean; sensitive: boolean; value_read_denied: boolean } {
    const [{ value: ext }] = this.#pk.C_GetAttributeValue(this.session, privHandle, [{ type: CKA.EXTRACTABLE }]);
    const [{ value: sen }] = this.#pk.C_GetAttributeValue(this.session, privHandle, [{ type: CKA.SENSITIVE }]);
    const extractable = Buffer.from(ext as Buffer)[0] === 1;
    const sensitive = Buffer.from(sen as Buffer)[0] === 1;
    let value_read_denied = false;
    try {
      this.#pk.C_GetAttributeValue(this.session, privHandle, [{ type: CKA.VALUE }]);
    } catch {
      value_read_denied = true; // CKR_ATTRIBUTE_SENSITIVE — private material cannot be read out
    }
    return { extractable, sensitive, value_read_denied };
  }

  /** SoftHSM2 version string (best-effort, for the evidence artifact). */
  moduleInfo(): { manufacturer: string; library: string; version: string } {
    const info = this.#pk.C_GetInfo();
    const v = info.libraryVersion ?? {};
    return {
      manufacturer: String(info.manufacturerID ?? '').trim(),
      library: String(info.libraryDescription ?? '').trim(),
      version: `${v.major ?? '?'}.${v.minor ?? '?'}`,
    };
  }

  close(): void {
    try { if (this.#session !== undefined) { this.#pk.C_Logout(this.#session); this.#pk.C_CloseSession(this.#session); } } catch { /* best-effort */ }
    try { this.#pk.C_Finalize(); } catch { /* best-effort */ }
    this.#session = undefined;
  }
}
