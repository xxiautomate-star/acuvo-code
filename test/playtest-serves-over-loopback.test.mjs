/**
 * A workspace file is playtested over loopback, not file:// — @playwright/mcp
 * refuses file:// by default, and modules/fetch() break there. See
 * lib/serve-workspace.mjs. The fake browser here FETCHES the URL it is sent,
 * so the assertion is about bytes served, not about a string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { playtest } from '../lib/playtest.mjs';
import { serveWorkspace } from '../lib/serve-workspace.mjs';
import { fingerprint } from '../lib/mcp-consent.mjs';

const SERVER = { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], env: {} };
const TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_console_messages', 'browser_network_requests']
  .map((name) => ({ name, inputSchema: { type: 'object', properties: name === 'browser_navigate' ? { url: { type: 'string' } } : {} } }));

function ws() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-serve-'));
  mkdirSync(join(root, 'game'));
  writeFileSync(join(root, 'game', 'index.html'), '<!doctype html><title>g</title><script type="module" src="main.js"></script>');
  writeFileSync(join(root, 'game', 'main.js'), 'export const ok = 1;');
  return root;
}

test('playtest navigates to an http://127.0.0.1 URL that serves the workspace file', async () => {
  const root = ws();
  const seen = [];
  try {
    await playtest(root, { url: 'game/index.html' }, {
      env: {},
      configImpl: () => ({ ok: true, servers: [SERVER] }),
      connectImpl: async () => ({ ok: true, name: 'playwright', tools: TOOLS }),
      closeImpl: () => {},
      trustImpl: () => ({ trusted: [{ fingerprint: fingerprint([SERVER]) }] }),
      callImpl: async (_c, name, args) => {
        if (name.endsWith('browser_navigate')) {
          const res = await fetch(args.url);
          const mod = await fetch(new URL('main.js', args.url));
          seen.push({ url: args.url, status: res.status, body: await res.text(), modType: mod.headers.get('content-type') });
        }
        return { ok: true, text: '' };
      },
    });
    assert.equal(seen.length, 1, 'navigated once');
    assert.match(seen[0].url, /^http:\/\/127\.0\.0\.1:\d+\/game\/index\.html$/);
    assert.equal(seen[0].status, 200);
    assert.match(seen[0].body, /type="module"/);
    assert.match(seen[0].modType, /javascript/, 'a module import resolves with a JS type');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the loopback server never serves outside the workspace', async () => {
  const root = ws();
  const outside = mkdtempSync(join(tmpdir(), 'acuvo-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  const s = await serveWorkspace(root);
  try {
    const rel = `../${outside.split(/[\\/]/).pop()}/secret.txt`;
    const r1 = await fetch(`${s.origin}/${encodeURIComponent(rel)}`);
    assert.notEqual(r1.status, 200);
    const r2 = await fetch(`${s.origin}/%2e%2e/%2e%2e/%2e%2e/Windows/win.ini`);
    assert.notEqual(r2.status, 200);
    const post = await fetch(`${s.origin}/game/index.html`, { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

/* A canvas game is judged by its picture: the local driver hashes the canvas
 * around each step (CANVAS_PROBE via browser_evaluate). Found on a real
 * Breakout drive where every key press read "changed nothing on the page". */
import { CANVAS_PROBE, holdKeyScript } from '../lib/playtest.mjs';

function canvasRun(hashes) {
  const root = ws();
  const calls = [];
  let i = 0;
  const tools = [...TOOLS, { name: 'browser_evaluate', inputSchema: { type: 'object', properties: { function: { type: 'string' } } } }];
  const opts = {
    env: {},
    configImpl: () => ({ ok: true, servers: [SERVER] }),
    connectImpl: async () => ({ ok: true, name: 'playwright', tools }),
    closeImpl: () => {},
    trustImpl: () => ({ trusted: [{ fingerprint: fingerprint([SERVER]) }] }),
    callImpl: async (_c, name, args) => {
      calls.push({ name, args });
      if (name.endsWith('browser_evaluate') && args.function === CANVAS_PROBE) return { ok: true, text: `### Result\n"canvas:${hashes[Math.min(i++, hashes.length - 1)]}"` };
      return { ok: true, text: '- button "Start" [ref=e1]' };
    },
  };
  return { root, calls, opts };
}

test('a canvas that never changes is reported, a canvas that moves is not inert', async () => {
  const dead = canvasRun([7, 7, 7, 7]);
  try {
    const r = await playtest(dead.root, { url: 'game/index.html', steps: [{ do: 'press', text: ' ' }, { do: 'hold', text: 'ArrowLeft' }] }, dead.opts);
    assert.ok(r.measured.includes('the canvas picture'));
    assert.ok(r.problems.some((p) => /canvas picture never changed/.test(p)), JSON.stringify(r.problems));
    assert.ok(dead.calls.some((c) => c.name.endsWith('browser_evaluate') && /keydown/.test(c.args.function)), 'hold dispatches keydown via evaluate');
  } finally { rmSync(dead.root, { recursive: true, force: true }); }

  const alive = canvasRun([1, 2, 3, 4]);
  try {
    const r = await playtest(alive.root, { url: 'game/index.html', steps: [{ do: 'press', text: ' ' }, { do: 'hold', text: 'ArrowLeft' }] }, alive.opts);
    assert.deepEqual(r.problems, [], JSON.stringify(r.problems));
  } finally { rmSync(alive.root, { recursive: true, force: true }); }
});

test('hold keeps the key down for a bounded time and names Space by its code', () => {
  const s = holdKeyScript(' ', 99999);
  assert.match(s, /setTimeout\(r, 3000\)/);
  assert.match(s, /"code": ?"Space"|code: "Space"/);
});
