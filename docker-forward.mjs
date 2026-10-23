#!/usr/bin/env node
// A temporary Docker Hub mirror for servers that cannot reach Docker Hub (for example in mainland China).
// Run it on a machine that can; the other server's Docker daemon then uses it as a registry mirror. It fetches
// manifests and layers from Docker Hub on demand and streams them through, storing nothing. Pulls only.
// No dependencies (Node.js 18.3+).
//
//   node docker-forward.mjs --allow-ip 203.0.113.7 [--port 5000]
//        [--allow-repo mlikiowa/napcat-docker,library/node] [--cert mirror.crt --key mirror.key]
//
// --allow-ip    the only client address(es) served, comma-separated ("any" serves everyone; not recommended)
// --allow-repo  optional: the only repositories served (official images are "library/<name>")
// --cert/--key  serve HTTPS (recommended); without them it serves plain HTTP
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    port: { type: 'string', default: '5000' },
    'allow-ip': { type: 'string', default: '' },
    'allow-repo': { type: 'string', default: '' },
    cert: { type: 'string' },
    key: { type: 'string' },
  },
});
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const allowIps = list(opt['allow-ip']);
const allowRepos = list(opt['allow-repo']);
if (!allowIps.length) {
  console.error('--allow-ip is required (the address of the server that will pull), or "any"');
  process.exit(1);
}

const UPSTREAM = 'https://registry-1.docker.io';
const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const REFERENCE = /^(?:[\w][\w.-]{0,127}|sha256:[a-f0-9]{64})$/;
const PASSED_HEADERS = ['content-type', 'content-length', 'docker-content-digest', 'etag', 'content-range', 'accept-ranges', 'last-modified'];

// Anonymous pull tokens from Docker Hub, cached per repository until shortly before they expire.
const tokens = new Map();
async function token(name) {
  const cached = tokens.get(name);
  if (cached && cached.expires > Date.now()) return cached.token;
  const r = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${name}:pull`);
  if (!r.ok) throw new Error(`auth.docker.io answered ${r.status}`);
  const { token: value, expires_in: ttl = 300 } = await r.json();
  tokens.set(name, { token: value, expires: Date.now() + (ttl - 30) * 1000 });
  return value;
}

function fail(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'docker-distribution-api-version': 'registry/2.0' });
  res.end(JSON.stringify({ errors: [{ code, message }] }));
}

async function handle(req, res) {
  const ip = req.socket.remoteAddress.replace(/^::ffff:/, '');
  const path = new URL(req.url, 'http://mirror').pathname;
  res.on('finish', () => console.log(`${new Date().toISOString()} ${ip} ${req.method} ${path} ${res.statusCode}`));

  if (!allowIps.includes('any') && !allowIps.includes(ip)) return fail(res, 403, 'DENIED', `address ${ip} is not allowed`);
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'UNSUPPORTED', 'this mirror only serves pulls');
  if (path === '/v2/' || path === '/v2') {
    res.writeHead(200, { 'content-type': 'application/json', 'docker-distribution-api-version': 'registry/2.0' });
    return res.end('{}');
  }

  const m = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(path);
  if (!m || !NAME.test(m[1]) || !REFERENCE.test(m[3])) return fail(res, 404, 'NAME_UNKNOWN', 'not a pull request');
  const [, name, kind, reference] = m;
  if (allowRepos.length && !allowRepos.includes(name)) return fail(res, 403, 'DENIED', `repository ${name} is not allowed`);

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const headers = { authorization: `Bearer ${await token(name)}`, 'accept-encoding': 'identity' };
  for (const h of ['accept', 'range', 'if-none-match']) if (req.headers[h]) headers[h] = req.headers[h];
  // Layers redirect to a CDN; fetch follows that and drops the Authorization header on the way.
  const upstream = await fetch(`${UPSTREAM}/v2/${name}/${kind}/${reference}`, { method: req.method, headers, signal: abort.signal });

  const out = { 'docker-distribution-api-version': 'registry/2.0' };
  for (const h of PASSED_HEADERS) {
    const value = upstream.headers.get(h);
    if (value) out[h] = value;
  }
  res.writeHead(upstream.status, out);
  if (req.method === 'HEAD' || !upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

const listener = (req, res) => handle(req, res).catch((e) => {
  console.error(`${req.method} ${req.url}: ${e.message}`);
  if (!res.headersSent) fail(res, 502, 'UNKNOWN', e.message);
  else res.destroy();
});
const server = opt.cert && opt.key
  ? createHttpsServer({ cert: readFileSync(opt.cert), key: readFileSync(opt.key) }, listener)
  : createHttpServer(listener);
server.listen(Number(opt.port), () => {
  console.log(`Docker Hub mirror on ${opt.cert ? 'https' : 'http'}://0.0.0.0:${opt.port}, serving ${allowIps.join(', ')}`
    + (allowRepos.length ? ` (repositories: ${allowRepos.join(', ')})` : ''));
});
