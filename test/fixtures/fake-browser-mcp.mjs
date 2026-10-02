/**
 * ── A BROWSER MCP SERVER, SIMULATED OVER A REAL FILE ────────────────────────
 *
 * ⚠️⚠️ THIS IS NOT A BROWSER AND THE TEST THAT USES IT SAYS SO. No Chromium is
 * launched anywhere in this suite: the machine it runs on is the owner's laptop
 * and the standing rule is that a test may not start one. What this does is
 * emit the EXACT TEXT SHAPES `@playwright/mcp` and `chrome-devtools-mcp` return
 * — the ones recorded in `lib/mcp-defaults.mjs`'s verified catalogue entries —
 * derived from the fixture HTML on disk.
 *
 * ⭐ SO THE COUPLING IS REAL IN THE HALF THAT MATTERS. `lib/playtest.mjs` owns
 * the parsing, the ordering, the digesting and the refusals; every one of those
 * is exercised end to end here against output produced from a file. What is
 * simulated is the rendering, which is the one part this package does not own.
 *
 * ⚠️ WHAT THIS CANNOT PROVE, stated plainly so nobody quotes it as more:
 * that a real Playwright build still spells its tools and replies this way. The
 * catalogue entry is the evidence for that, and it is dated.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The tool list the real @playwright/mcp offered when it was measured. */
export const PLAYWRIGHT_TOOLS = [
  'browser_navigate', 'browser_snapshot', 'browser_console_messages', 'browser_network_requests',
  'browser_click', 'browser_type', 'browser_press_key', 'browser_resize', 'browser_wait_for',
].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));

/**
 * ── ⭐⭐ THE SCHEMAS A REAL SERVER PUBLISHED, COPIED OFF THE WIRE ────────────
 *
 * Read out of a live `@playwright/mcp` 0.0.79 over the real `connectServer` on
 * 2026-09-01 (`tools/list`, trimmed to the keys `adaptArgs` reads). They exist
 * because `PLAYWRIGHT_TOOLS` above declares `inputSchema: { type: 'object' }`
 * — no properties, no `required` — which accepts every argument shape there is.
 * That is why 5,405 green tests sat on top of a driver whose every click the
 * real server rejected with *"expected string, received undefined → at
 * target"*.
 *
 * ⚠️ `strict: true` MAKES THE FIXTURE REFUSE LIKE THE REAL ONE: both browser
 * schemas are `additionalProperties: false`, so an unknown key is a rejection of
 * the whole call and not a field that gets ignored. Without that half, a driver
 * could send `ref` AND `target` forever and never learn which one was wrong.
 *
 * ⚠️ THIS IS DATED TOO, and it does not become true by being written down. It
 * pins the SHAPE of the adaptation — drop the undeclared, fill the required —
 * which is what has to survive the next rename.
 */
export const PLAYWRIGHT_TOOLS_0_0_79 = [
  { name: 'browser_navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'browser_snapshot', inputSchema: { type: 'object', properties: { target: { type: 'string' }, filename: { type: 'string' }, depth: { type: 'number' }, boxes: { type: 'boolean' } }, required: [], additionalProperties: false } },
  { name: 'browser_console_messages', inputSchema: { type: 'object', properties: { level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'], default: 'info' }, all: { type: 'boolean' }, filename: { type: 'string' } }, required: ['level'], additionalProperties: false } },
  { name: 'browser_network_requests', inputSchema: { type: 'object', properties: { static: { type: 'boolean', default: false }, filter: { type: 'string' }, filename: { type: 'string' } }, required: ['static'], additionalProperties: false } },
  { name: 'browser_click', inputSchema: { type: 'object', properties: { element: { type: 'string' }, target: { type: 'string' }, doubleClick: { type: 'boolean' }, button: { type: 'string' }, modifiers: { type: 'array' } }, required: ['target'], additionalProperties: false } },
  { name: 'browser_type', inputSchema: { type: 'object', properties: { element: { type: 'string' }, target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, slowly: { type: 'boolean' } }, required: ['target', 'text'], additionalProperties: false } },
  { name: 'browser_press_key', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } },
  { name: 'browser_resize', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'], additionalProperties: false } },
  { name: 'browser_wait_for', inputSchema: { type: 'object', properties: { time: { type: 'number' }, text: { type: 'string' }, textGone: { type: 'string' } }, required: [], additionalProperties: false } },
].map((t) => ({ description: t.name, ...t }));

/** Validate one call the way a server with `additionalProperties:false` does. */
export function schemaRefusal(schema, args) {
  if (!schema?.properties) return null;
  const given = args && typeof args === 'object' ? args : {};
  for (const k of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) {
      return `Invalid arguments: unexpected property "${k}"`;
    }
  }
  for (const k of schema.required ?? []) {
    if (given[k] === undefined) return `Invalid input: expected value, received undefined → at ${k}`;
  }
  return null;
}

/** The chrome-devtools-mcp spelling of the same nine ideas. */
export const DEVTOOLS_TOOLS = [
  'navigate_page', 'take_snapshot', 'list_console_messages', 'list_network_requests',
  'click', 'fill', 'press_key', 'resize_page', 'wait_for',
].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));

/**
 * Pull the page apart with the same crude reading a browser would do properly.
 * Deliberately regex-based: this file must never grow into an HTML engine, and
 * the fixture is written to be legible to it.
 */
function readPage(file) {
  const html = readFileSync(file, 'utf8');
  const dir = dirname(file);

  const title = (/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const heading = (/<h1[^>]*>([^<]*)<\/h1>/i.exec(html)?.[1] ?? '').trim();

  const assets = [];
  for (const m of html.matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)\s*=\s*"([^"]+)"/gi)) {
    const ref = m[1];
    if (/^(https?:|data:|\/\/)/i.test(ref)) continue;
    assets.push({ ref, present: existsSync(join(dir, ref)) });
  }

  const fields = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => ({
    tag: m[0],
    name: /placeholder\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? /id\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? 'field',
  }));

  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((m) => ({
    name: m[2].replace(/<[^>]*>/g, '').trim(),
    adds: /data-adds\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? null,
  }));

  // A bare `name();` in an inline script with no matching declaration is what a
  // real browser reports as a ReferenceError, and it is the console error the
  // fixture is built around.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  const undefinedCalls = [...inline.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;/gm)]
    .map((m) => m[1])
    .filter((fn) => !new RegExp(`function\\s+${fn}\\b`).test(html));

  return { title, heading, assets, fields, buttons, undefinedCalls };
}

/**
 * A connection object shaped exactly like `connectServer`'s success return,
 * plus a `callImpl` that answers the nine verbs.
 *
 * @param file absolute path to the fixture HTML
 * @param dialect 'playwright' | 'chrome-devtools'
 */
export function fakeBrowser(file, { dialect = 'playwright', tools = null, extraConsole = [], strict = false } = {}) {
  const page = readPage(file);
  // ⚠️ `pathToFileURL`, not string surgery — a Windows drive letter and a space
  // in the path both break the hand-rolled version, and this suite runs on both.
  const url = pathToFileURL(file).href;

  const state = { typed: new Map(), added: [], width: 1280, navigated: false };
  const calls = [];

  const snapshotText = () => {
    const lines = [];
    let n = 0;
    const ref = () => (dialect === 'playwright' ? `[ref=e${++n}]` : `uid=1_${++n}`);
    if (page.heading) lines.push(`- heading "${page.heading}" ${ref()}`);
    for (const f of page.fields) {
      const typed = state.typed.get(f.name);
      lines.push(`- textbox "${f.name}"${typed ? `: ${typed}` : ''} ${ref()}`);
    }
    for (const b of page.buttons) lines.push(`- button "${b.name}" ${ref()}`);
    for (const t of state.added) lines.push(`- text: ${t}`);
    // The narrow viewport drops the secondary control, which is what a real
    // responsive layout does and is what `phone: true` is looking for.
    const visible = state.width < 500 ? lines.filter((l) => !/Need help\?/.test(l)) : lines;
    return [
      '### Ran Playwright code',
      '```js',
      'await page.goto(...)',
      '```',
      '### Page state',
      `- Page URL: ${url}`,
      `- Page Title: ${page.title}`,
      '- Page Snapshot:',
      '```yaml',
      ...visible,
      '```',
    ].join('\n');
  };

  const consoleText = () => [
    ...page.undefinedCalls.map((fn) => `[ERROR] ReferenceError: ${fn} is not defined @ ${url}:14`),
    '[WARNING] third-party cookie will be blocked',
    '[LOG] ready',
    ...extraConsole,
  ].join('\n');

  const networkText = () => [
    `[GET] ${url} => [200] OK`,
    ...page.assets.map((a) => `[GET] ${new URL(a.ref, url).href} => [${a.present ? '200] OK' : '404] Not Found'}`),
    // A healthy request whose PATH contains a status-looking number. It is here
    // to keep `failedRequests` honest: a regex that scans the whole line turns
    // this into the top finding of the report.
    `[GET] ${new URL('api/404-handler', url).href} => [200] OK`,
  ].join('\n');

  const findByRef = (wanted) => {
    let n = 0;
    const next = () => (dialect === 'playwright' ? `e${++n}` : `1_${++n}`);
    if (page.heading && next() === wanted) return { kind: 'heading' };
    for (const f of page.fields) if (next() === wanted) return { kind: 'field', field: f };
    for (const b of page.buttons) if (next() === wanted) return { kind: 'button', button: b };
    return null;
  };

  const ok = (text) => ({ ok: true, text });
  const bad = (error) => ({ ok: false, error });

  const handlers = {
    navigate: (args) => {
      if (!args?.url) return bad('no url supplied');
      state.navigated = true;
      return ok(snapshotText());
    },
    snapshot: () => (state.navigated ? ok(snapshotText()) : bad('no open page')),
    console: () => ok(consoleText()),
    network: () => ok(networkText()),
    resize: (args) => { state.width = Number(args?.width ?? state.width); return ok(snapshotText()); },
    click: (args) => {
      const el = findByRef(args?.ref ?? args?.uid ?? args?.target);
      if (!el) return bad(`no element with ref ${args?.ref ?? args?.uid ?? args?.target}`);
      if (el.kind === 'button' && el.button.adds) state.added.push(el.button.adds);
      return ok(snapshotText());
    },
    type: (args) => {
      const el = findByRef(args?.ref ?? args?.uid ?? args?.target);
      if (!el || el.kind !== 'field') return bad('that element does not take text');
      state.typed.set(el.field.name, String(args?.text ?? args?.value ?? ''));
      return ok(snapshotText());
    },
    press: () => ok(snapshotText()),
    wait: () => ok(snapshotText()),
  };

  const ROUTE = dialect === 'playwright'
    ? {
      browser_navigate: 'navigate', browser_snapshot: 'snapshot', browser_console_messages: 'console',
      browser_network_requests: 'network', browser_resize: 'resize', browser_click: 'click',
      browser_type: 'type', browser_press_key: 'press', browser_wait_for: 'wait',
    }
    : {
      navigate_page: 'navigate', take_snapshot: 'snapshot', list_console_messages: 'console',
      list_network_requests: 'network', resize_page: 'resize', click: 'click',
      fill: 'type', press_key: 'press', wait_for: 'wait',
    };

  const offered = tools ?? (dialect === 'playwright' ? PLAYWRIGHT_TOOLS : DEVTOOLS_TOOLS);

  return {
    calls,
    state,
    connection: { ok: true, name: 'playwright', transport: 'stdio', child: null, close: () => {}, rpc: null, tools: offered, truncated: false },
    /**
     * ⚠️ THE NAME ARRIVES NAMESPACED AND IS PARSED WITH THE REAL PARSER. That
     * round trip is half of what this test proves — `playtest` builds the id
     * with `namespacedName`, and if the two ever disagree every call would fail
     * with "not an MCP tool id" rather than silently doing the wrong thing.
     */
    async callImpl(conns, name, args) {
      const { parseNamespaced } = await import('../../lib/mcp.mjs');
      const parsed = parseNamespaced(name);
      if (!parsed) return { ok: false, error: `"${name}" is not an MCP tool id` };
      const conn = conns.find((c) => c.ok && c.name === parsed.server);
      if (!conn) return { ok: false, error: `the "${parsed.server}" server is not connected` };
      calls.push({ tool: parsed.tool, args });
      const route = ROUTE[parsed.tool];
      if (!route) return { ok: false, error: `unknown tool ${parsed.tool}` };
      /**
       * ⚠️ THE REFUSAL COMES FIRST, exactly as it does on the wire: a real
       * server validates before it acts, so a call with the wrong spelling
       * never reaches the page and never changes `state`.
       */
      if (strict) {
        const why = schemaRefusal(offered.find((t) => t.name === parsed.tool)?.inputSchema, args);
        if (why) return { ok: false, error: `### Error Invalid arguments for tool "${parsed.tool}": ${why}` };
      }
      return handlers[route](args);
    },
  };
}

export const FIXTURE_HTML = join(dirname(fileURLToPath(import.meta.url)), 'playtest-page.html');
