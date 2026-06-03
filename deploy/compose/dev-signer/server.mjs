#!/usr/bin/env node
// EDAM dev-signer — DEV TOPOLOGY/HEALTH STAND-IN ONLY (EDAM-T160).
//
// A minimal, zero-dependency Node HTTP stub representing the production HSM
// signing service (spec §15 S-4: B↔HSM is an mTLS network service). It exists so
// the M-Live dev stack has a reachable, healthy "signer" endpoint. It is NOT on
// the real signing path: the live evidence harness (T161) performs the ACTUAL
// anchor-payload signing IN-PROCESS via @edam/signing (so the canonical signing
// bytes come from @edam/evidence — no builder/verifier drift). This stub only
// demonstrates liveness and a representative Ed25519 sign endpoint over dev keys.
//
// Endpoints (dev only, plain HTTP — production uses mTLS + a real HSM):
//   GET  /health   -> 200 {"status":"ok","service":"dev-signer"}
//   GET  /pubkey   -> 200 {"algorithm":"ed25519","public_key": <spki-der-b64>}
//   POST /sign     -> 200 {"algorithm":"ed25519","signature": <b64>}  (signs the raw body)

import { createServer } from 'node:http';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';

const PORT = Number(process.env.DEV_SIGNER_PORT ?? 8090);

// A throwaway dev keypair generated at startup (NEVER a production key).
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok', service: 'dev-signer' });
  if (req.method === 'GET' && req.url === '/pubkey') return send(res, 200, { algorithm: 'ed25519', public_key: spkiB64 });
  if (req.method === 'POST' && req.url === '/sign') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const signature = edSign(null, Buffer.concat(chunks), privateKey).toString('base64');
        send(res, 200, { algorithm: 'ed25519', signature });
      } catch (err) {
        send(res, 400, { error: String(err && err.message) });
      }
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  process.stdout.write(`[dev-signer] DEV STAND-IN listening on :${PORT} (not the real signing path; T161 signs in-process)\n`);
});
