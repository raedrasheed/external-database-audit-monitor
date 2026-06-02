// Config-selectable signer factory (Sprint-2 / EDAM-T122).
//
// Proves the T122 acceptance criterion "swapping signer requires no caller
// change": both branches return the same `Signer` contract, so callers depend
// only on `Signer` and never on the concrete dev/HSM implementation.

import type { Signer } from './types.js';
import { DevEd25519Signer, type DevEd25519SignerOptions } from './dev-signer.js';
import { Pkcs11Signer, type Pkcs11SignerConfig } from './pkcs11-signer.js';

/** Discriminated configuration selecting the concrete signer implementation. */
export type SignerConfig =
  | { kind: 'dev'; options?: DevEd25519SignerOptions }
  | { kind: 'pkcs11'; config: Pkcs11SignerConfig };

/** Build a `Signer` from config. The return type is the interface — callers never change. */
export function createSigner(config: SignerConfig): Signer {
  switch (config.kind) {
    case 'dev':
      return new DevEd25519Signer(config.options);
    case 'pkcs11':
      return new Pkcs11Signer(config.config);
  }
}
