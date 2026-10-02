/**
 * ── ⭐ A WORKSPACE FILE IS PLAYTESTED OVER LOOPBACK, NOT file:// (2026-09-27) ──
 *
 * `playtest` hands a local browser server `file:///…/game/index.html` for a
 * workspace path. `@playwright/mcp` refuses file:// by default ("Access to
 * "file:" protocol is blocked"), and the only switch it offers,
 * `--allow-unrestricted-file-access`, lets the browser read ANY file on the
 * disk. And file:// is the wrong origin anyway: `<script type="module">` and
 * `fetch('levels.json')` both fail there, so a game that works when served is
 * reported broken.
 *
 * So for the length of one drive this serves the WORKSPACE, read-only, on an
 * ephemeral 127.0.0.1 port. Every path goes through `resolveInWorkspace(…,
 * 'read')` — the same containment the model's own `read_file` obeys — so the
 * browser can reach exactly what the agent could already read, and nothing
 * outside the root. GET/HEAD only; the server is closed in the caller's
 * `finally`. Zero dependencies: `serve-handler`/`sirv` would do this, and this
 * package ships none by design.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { resolveInWorkspace } from './workspace.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/**
 * @param {string} root workspace root
 * @returns {Promise<{ origin: string, urlFor: (rel: string) => string, close: () => Promise<void> }>}
 */
export async function serveWorkspace(root) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '');
    } catch { res.writeHead(400).end(); return; }
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const r = resolveInWorkspace(root, rel, 'read');
    if (!r.ok) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(r.absolute);
      res.writeHead(200, { 'content-type': TYPES[extname(r.absolute).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      // ⚠️ The browser asks for /favicon.ico on its own. A 404 for a request the
      // page never made would be reported as the page's console error — measured
      // on the first real drive. The page's own missing files still 404.
      if (rel === 'favicon.ico') { res.writeHead(204).end(); return; }
      res.writeHead(404).end();
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  server.unref();
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    urlFor: (rel) => `${origin}/${String(rel).split(/[\\/]/).map(encodeURIComponent).join('/')}`,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
