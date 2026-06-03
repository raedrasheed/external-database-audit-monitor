#!/usr/bin/env node
// EDAM dev-tsa-log — DEV TOPOLOGY/HEALTH STAND-IN ONLY (EDAM-T160).
//
// A minimal, zero-dependency Node HTTP stub representing the production external
// anchoring authorities (spec §15 S-4: B↔anchor-provider is an mTLS network
// service) — an RFC-3161 timestamp authority and an RFC-6962 transparency log.
// It exists so the M-Live dev stack has a reachable, healthy "anchor authority"
// endpoint. It is NOT on the real anchoring path: the live evidence harness
// (T161) performs the ACTUAL anchoring IN-PROCESS via @edam/anchoring
// (DevRfc3161Provider / DevTransparencyLogProvider) so the canonical proof bytes
// come from @edam/anchor-proof — no builder/verifier drift. This stub only
// demonstrates liveness and representative timestamp / transparency endpoints.
//
// Endpoints (dev only, plain HTTP — production uses mTLS + real authorities):
//   GET  /health        -> 200 {"status":"ok","service":"dev-tsa-log"}
//   POST /rfc3161        -> 200 {"provider":"rfc3161","gen_time":<iso>,"digest":<sha256>}
//   POST /transparency   -> 200 {"provider":"transparency_log","leaf_hash":<sha256>}

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.DEV_TSA_LOG_PORT ?? 8091);

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks)));
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok', service: 'dev-tsa-log' });
  if (req.method === 'POST' && req.url === '/rfc3161') {
    return readBody(req, (b) => send(res, 200, { provider: 'rfc3161', gen_time: new Date().toISOString(), digest: 'sha256:' + createHash('sha256').update(b).digest('hex') }));
  }
  if (req.method === 'POST' && req.url === '/transparency') {
    // RFC-6962 leaf hash = SHA256(0x00 || data) — representative only.
    return readBody(req, (b) => send(res, 200, { provider: 'transparency_log', leaf_hash: 'sha256:' + createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), b])).digest('hex') }));
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  process.stdout.write(`[dev-tsa-log] DEV STAND-IN listening on :${PORT} (not the real anchoring path; T161 anchors in-process)\n`);
});
