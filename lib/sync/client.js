/**
 * HTTPS client for talking to a peer's /sync/{health,push,pull} endpoints.
 *
 * Tracer-bullet shape: supports plain bearer + --insecure (skip TLS validation).
 * Cert-fingerprint pinning lands in Day 5; for now we still send the request
 * over TLS, just don't verify the cert chain.
 *
 * The client is intentionally dumb — it doesn't decide WHAT to push or pull,
 * just shuttles bytes. The replication loop lives in lib/sync/replicate.js.
 */

import { request as httpsRequest } from 'node:https';
import { fingerprintsMatch } from './cert.js';

/**
 * Create a client bound to one remote.
 *
 * opts:
 *   url      — required, e.g. "https://localhost:8765"
 *   bearer   — required, hex token
 *   insecure — bool. If true, skip TLS cert validation entirely (tracer-bullet).
 *   cert_fp  — string. If set, pin the server cert to this SHA-256 fingerprint
 *              (overrides insecure — pinning is enabled even when insecure=true).
 *   timeoutMs — request timeout, default 30s
 */
export function createSyncClient(opts) {
  if (!opts || !opts.url) throw new Error('createSyncClient: url required');
  if (!opts.bearer) throw new Error('createSyncClient: bearer required');

  const url = new URL(opts.url);
  const insecure = !!opts.insecure;
  const certFp = opts.cert_fp || null;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  function makeRequest({ method, path, body }) {
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = {
        Authorization: `Bearer ${opts.bearer}`,
      };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }

      const req = httpsRequest({
        host: url.hostname,
        port: url.port || 443,
        path,
        method,
        headers,
        // When cert pinning is on (cert_fp set), we still set rejectUnauthorized
        // to false because self-signed certs would otherwise fail the chain check —
        // we validate the fingerprint manually on 'secureConnect' instead.
        rejectUnauthorized: (!insecure && !certFp),
        timeout: timeoutMs,
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = { _raw: chunks }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });

      // Cert-pinning validation hook. Day 5 will exercise this via
      // pair-blob's cert_fp; for tracer-bullet (insecure mode) we skip.
      if (certFp) {
        req.on('socket', (socket) => {
          socket.on('secureConnect', () => {
            const peerCert = socket.getPeerCertificate(true);
            // node returns SHA-256 fingerprint as fingerprint256 in "AA:BB:..." form
            const peerFp = peerCert?.fingerprint256;
            if (!peerFp || !fingerprintsMatch(certFp, peerFp)) {
              req.destroy(new Error(
                `TLS fingerprint mismatch — expected ${certFp}, got ${peerFp || 'none'}`
              ));
            }
          });
        });
      }

      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`request timeout (${timeoutMs}ms)`)));

      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    async health() {
      const r = await makeRequest({ method: 'GET', path: '/sync/health' });
      if (r.status !== 200) throw new Error(`health failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },

    async pull({ since = 0, limit = 500 } = {}) {
      const r = await makeRequest({
        method: 'GET',
        path: `/sync/pull?since=${since}&limit=${limit}`,
      });
      if (r.status !== 200) throw new Error(`pull failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },

    async push({ rows }) {
      if (!Array.isArray(rows)) throw new Error('push: rows[] required');
      const r = await makeRequest({
        method: 'POST',
        path: '/sync/push',
        body: { rows },
      });
      if (r.status !== 200) throw new Error(`push failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },

    // Direct access for advanced/test callers
    raw: makeRequest,
  };
}
