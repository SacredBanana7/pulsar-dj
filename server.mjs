// Minimal static server for Pulsar DJ. Web MIDI, AudioWorklet and the File
// System Access API all need a secure context, which localhost provides.
import { createServer } from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), 'app');
const port = Number(process.env.PORT) || 5180;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
};

// Hosts of freely licensed music sources the app may fetch through /proxy
// (for APIs without CORS headers, e.g. ccMixter). Not an open proxy.
const PROXY_HOSTS = [
  /^(.+\.)?archive\.org$/, /^api\.openverse\.org$/, /^(.+\.)?jamendo\.com$/, /^(.+\.)?ccmixter\.org$/,
  /^(.+\.)?freesound\.org$/, /^upload\.wikimedia\.org$/,
];
const allowed = (u) => u.protocol === 'https:' && PROXY_HOSTS.some((re) => re.test(u.hostname));

// node:https instead of fetch: some sources (ccMixter) send headers larger than fetch accepts
function upstream(u, headers, hops = 0) {
  return new Promise((resolveUp, reject) => {
    const r = https.get(u, { headers, maxHeaderSize: 256 * 1024 }, (up) => {
      if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && hops < 5) {
        up.resume();
        const next = new URL(up.headers.location, u);
        if (!allowed(next)) return reject(Object.assign(new Error('redirect host not allowed'), { code: 403 }));
        return resolveUp(upstream(next, headers, hops + 1));
      }
      resolveUp(up);
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('upstream timeout')));
  });
}

async function proxy(req, res, target) {
  let u;
  try { u = new URL(target); } catch { u = null; }
  if (!u || !allowed(u)) throw Object.assign(new Error('host not allowed'), { code: 403 });
  const headers = { 'User-Agent': 'PulsarDJ/0.1 (+https://github.com/SacredBanana7/pulsar-dj)' };
  if (req.headers.range) headers.Range = req.headers.range;
  const up = await upstream(u, headers);
  const out = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    if (up.headers[h]) out[h] = up.headers[h];
  }
  res.writeHead(up.statusCode, out);
  up.pipe(res);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/proxy') return await proxy(req, res, url.searchParams.get('url'));
    if (url.pathname === '/__alive') { res.writeHead(204); return res.end(); }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    // generated demo/test loops (npm run testtracks) are served from ../test-tracks
    const base = /^test-tracks[/\\]/.test(path) ? resolve(root, '..') : root;
    let file = join(base, path);
    if (!file.startsWith(base)) throw Object.assign(new Error('forbidden'), { code: 403 });
    const info = await stat(file).catch(() => null);
    if (!info) throw Object.assign(new Error('not found'), { code: 404 });
    if (info.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    if (res.headersSent) return res.end();
    res.writeHead(err.code === 403 ? 403 : err.code === 404 || err.code === 'ENOENT' ? 404 : 502, { 'Content-Type': 'text/plain' });
    res.end(String(err.message));
  }
}).listen(port, () => {
  console.log(`Pulsar DJ läuft auf http://localhost:${port}`);
});
