/**
 * ── ⭐⭐ THE FOUR NAVIGATION TOOLS WERE DARK ON EVERY PROJECT ────────────────
 *
 * `find_definition`, `find_references`, `list_symbols` and `check_types` are
 * gated on `lspAvailable`, which needs **`typescript-language-server`** — a
 * separate npm package almost nobody installs. Measured 2026-08-12 against a
 * real Next.js app and a real API server: `lspAvailable` was **false for both**.
 * Four of the most valuable tools a coding agent can have, shipped, tested, and
 * unreachable on every machine including the author's.
 *
 * ⭐ AND THE THING THAT MAKES THEM REACHABLE IS ALREADY THERE. The `typescript`
 * package — which every TypeScript project has, because it is what compiles the
 * project — ships **`lib/tsserver.js`**, the same server VS Code drives. It was
 * present in both projects above. Nothing needed installing; something needed
 * writing.
 *
 * ── ⚠️ IT IS NOT LSP, AND THAT IS THE WHOLE REASON THIS FILE EXISTS ────────
 *
 * `lsp.mjs` speaks Language Server Protocol. tsserver speaks its own older
 * protocol, and the differences are not cosmetic:
 *
 *   · requests are ONE LINE of JSON terminated by \n — no Content-Length header
 *     on the way IN (there is one on the way out, which is the asymmetry that
 *     catches people);
 *   · positions are **1-based `line` and `offset`**, where LSP is 0-based
 *     `line` and `character`. An off-by-one here does not error, it silently
 *     answers about the wrong token;
 *   · a file must be `open`ed before anything can be asked about it;
 *   · errors arrive as `success:false` on the response, not as a JSON-RPC
 *     `error` member.
 *
 * So this could not be a flag on `lsp.mjs`. What it CAN do — and does — is
 * return **exactly the shapes `lsp.mjs` returns**, so `formatLspForModel`, the
 * tool schemas and the model's experience are identical no matter which server
 * answered. The user should never learn which one they got.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

import { resolveInWorkspace } from './workspace.mjs';

/** How far up to look for a `node_modules/typescript`. Deep enough for a monorepo. */
export const MAX_WALK_UP = 8;

/** tsserver is fast; a slow answer here means something is wrong, not busy. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Same caps as `lsp.mjs`, so the two cannot disagree about what "too many" is. */
export const MAX_LOCATIONS = 40;
export const MAX_DIAGNOSTICS = 40;
export const MAX_SYMBOLS = 200;

/** The extensions tsserver can answer about. JS included — it handles both. */
export const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export function handlesFile(file) {
  const m = /\.[a-z]+$/i.exec(String(file ?? ''));
  return m ? TS_EXTENSIONS.has(m[0].toLowerCase()) : false;
}

/**
 * Where is tsserver? Walks up looking for `node_modules/typescript/lib/tsserver.js`.
 *
 * ⚠️ NEVER SPAWNS ANYTHING. This runs on the tool-offer path of every
 * multi-round session, so it is one `existsSync` per level and nothing else.
 */
export function findTsserver(root, { maxUp = MAX_WALK_UP } = {}) {
  if (typeof root !== 'string' || root === '') return null;
  let dir = resolve(root);
  for (let i = 0; i < maxUp; i += 1) {
    const candidate = join(dir, 'node_modules', 'typescript', 'lib', 'tsserver.js');
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch { /* unreadable level */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Is the tsserver path available for this workspace? Cheap, for the offer path. */
export function tsserverAvailable(root) {
  return findTsserver(root) !== null;
}

// ── the protocol ───────────────────────────────────────────────────────────

const live = new Set();
let hooked = false;
function installExitHooks() {
  if (hooked) return;
  hooked = true;
  const killAll = () => { for (const s of [...live]) hardStop(s); };
  process.once('exit', killAll);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149]]) {
    try { process.once(sig, () => { killAll(); process.exit(code); }); } catch { /* no SIGBREAK off Windows */ }
  }
}

function hardStop(session) {
  live.delete(session);
  try { session.child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * ⚠️ RESPONSES ARE Content-Length FRAMED EVEN THOUGH REQUESTS ARE NOT. Splitting
 * the output on newlines — the symmetric-looking assumption — tears JSON bodies
 * apart the first time one contains a newline in a string, which a diagnostic
 * message routinely does.
 */
function makeReader(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { buffer = buffer.slice(headerEnd + 4); continue; }
      const length = Number(m[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.slice(start, start + length);
      buffer = buffer.slice(start + length);
      try { onMessage(JSON.parse(body)); } catch { /* a malformed frame is not fatal */ }
    }
  };
}

/** Start tsserver for this workspace. */
export function startTsserver(root, { file = null, spawnImpl = spawn } = {}) {
  const server = file ?? findTsserver(root);
  if (!server) {
    return {
      ok: false,
      error: 'no TypeScript found in this workspace — semantic navigation needs `typescript` installed '
        + '(npm i -D typescript). Use search_text and read_file instead.',
    };
  }

  const child = spawnImpl(process.execPath, [server, '--disableAutomaticTypingAcquisition'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map();
  /** @type {Map<string, object[]>} */
  const events = new Map();
  let seq = 0;

  const session = { child, root, server, ok: true, label: 'tsserver' };

  const read = makeReader((msg) => {
    if (msg.type === 'response' && typeof msg.request_seq === 'number') {
      const entry = pending.get(msg.request_seq);
      if (entry) { pending.delete(msg.request_seq); clearTimeout(entry.timer); entry.resolve(msg); }
      return;
    }
    if (msg.type === 'event' && msg.event) {
      if (!events.has(msg.event)) events.set(msg.event, []);
      events.get(msg.event).push(msg.body);
    }
  });

  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on?.('data', read);
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on?.('data', () => { /* tsserver logs noise here; not an error channel */ });
  child.on?.('exit', () => {
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.resolve({ success: false, message: 'tsserver exited' }); }
    pending.clear();
    live.delete(session);
  });

  /**
   * ⚠️ ONE LINE, NEWLINE-TERMINATED, NO HEADER. The response framing is
   * Content-Length; the request framing is not. Sending a header here makes
   * tsserver silently ignore every request — it does not complain, it just never
   * answers, which reads exactly like a hang.
   */
  session.request = (command, args, timeoutMs = REQUEST_TIMEOUT_MS) => {
    seq += 1;
    const id = seq;
    const payload = `${JSON.stringify({ seq: id, type: 'request', command, arguments: args })}\n`;
    return new Promise((resolveP) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolveP({ success: false, message: `tsserver did not answer "${command}" within ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      pending.set(id, { resolve: resolveP, timer });
      try { child.stdin.write(payload); } catch (e) {
        clearTimeout(timer); pending.delete(id);
        resolveP({ success: false, message: `could not talk to tsserver: ${e?.message ?? e}` });
      }
    });
  };

  session.events = events;
  session.stop = () => hardStop(session);

  installExitHooks();
  live.add(session);
  return session;
}

/** Resolve a model-supplied path and open it — tsserver answers nothing about a closed file. */
async function openFile(session, root, file) {
  const r = resolveInWorkspace(root, file, 'read');
  if (!r.ok) return { ok: false, error: r.reason };
  if (!existsSync(r.absolute)) return { ok: false, error: `${r.relative} does not exist` };
  let text;
  try { text = readFileSync(r.absolute, 'utf8'); } catch (e) { return { ok: false, error: `could not read ${r.relative}: ${e?.message ?? e}` }; }
  await session.request('open', { file: r.absolute, fileContent: text, scriptKindName: /\.tsx?$/.test(r.absolute) ? 'TS' : 'JS' });
  return { ok: true, absolute: r.absolute, relative: r.relative };
}

/** One excerpt reader per call, so a file read twice is read once. */
function makeExcerptReader() {
  const cache = new Map();
  return (absolute, line) => {
    if (!cache.has(absolute)) {
      try { cache.set(absolute, readFileSync(absolute, 'utf8').split(/\r?\n/)); } catch { cache.set(absolute, null); }
    }
    const lines = cache.get(absolute);
    if (!lines) return null;
    const text = lines[line - 1];
    return typeof text === 'string' ? text.trim().slice(0, 200) : null;
  };
}

/**
 * ⚠️ IDENTICAL TO `lsp.mjs`'s NORMALISER, DELIBERATELY. A definition inside
 * node_modules is often the CORRECT answer, so it is reported rather than
 * refused — shown relative when inside the workspace and absolute when not, so
 * the model can tell at a glance whether it can open it.
 */
function normalize(root, spans) {
  const excerptFor = makeExcerptReader();
  const out = [];
  for (const s of spans ?? []) {
    const absolute = s?.file;
    const line = s?.start?.line;
    const column = s?.start?.offset;
    if (!absolute || !Number.isInteger(line)) continue;
    const rel = relative(root, absolute);
    const inside = rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel);
    out.push({
      path: inside ? rel.split(sep).join('/') : absolute,
      inWorkspace: inside,
      line,
      column: column ?? 1,
      excerpt: excerptFor(absolute, line),
    });
  }
  return out;
}

function capped(list, max) {
  return { shown: list.slice(0, max), truncated: list.length > max };
}

/** Run one verb and guarantee the server dies afterwards. */
async function withServer(root, fn, { session = null } = {}) {
  const s = session ?? startTsserver(root);
  if (s.ok === false) return s;
  try {
    return await fn(s);
  } finally {
    if (!session) s.stop();
  }
}

// ── the four verbs, returning `lsp.mjs`'s shapes exactly ───────────────────

export async function definition(root, file, line, column = 1, opts = {}) {
  return withServer(root, async (s) => {
    const open = await openFile(s, root, file);
    if (!open.ok) return open;
    const res = await s.request('definition', { file: open.absolute, line, offset: column });
    if (res?.success === false) return { ok: false, error: `tsserver: ${res.message ?? 'definition failed'}` };
    const all = normalize(root, res?.body);
    const { shown, truncated } = capped(all, MAX_LOCATIONS);
    if (all.length === 0) {
      return {
        ok: true, kind: 'definition', path: open.relative, count: 0, shown: 0, truncated: false, locations: [],
        // ⚠️ Same note as lsp.mjs: "no definition" and "you pointed at
        // whitespace" look identical to the caller, and the second is commoner.
        note: `tsserver found no definition at ${open.relative}:${line}:${column}. Check the position is on the symbol itself — the column is 1-based and counts characters, not tabs-as-spaces.`,
      };
    }
    return { ok: true, kind: 'definition', path: open.relative, count: all.length, shown: shown.length, truncated, locations: shown };
  }, opts);
}

export async function references(root, file, line, column = 1, opts = {}) {
  return withServer(root, async (s) => {
    const open = await openFile(s, root, file);
    if (!open.ok) return open;
    const res = await s.request('references', { file: open.absolute, line, offset: column });
    if (res?.success === false) return { ok: false, error: `tsserver: ${res.message ?? 'references failed'}` };
    const refs = (res?.body?.refs ?? []).map((r) => ({ file: r.file, start: r.start }));
    const all = normalize(root, refs);
    const { shown, truncated } = capped(all, MAX_LOCATIONS);
    if (all.length === 0) {
      return {
        ok: true, kind: 'references', path: open.relative, count: 0, shown: 0, truncated: false, locations: [],
        note: `tsserver found no references to the symbol at ${open.relative}:${line}:${column}.`,
      };
    }
    return { ok: true, kind: 'references', path: open.relative, count: all.length, shown: shown.length, truncated, locations: shown };
  }, opts);
}

const CATEGORY_RANK = { error: 1, warning: 2, suggestion: 3, message: 3 };

export async function diagnostics(root, file, opts = {}) {
  return withServer(root, async (s) => {
    const open = await openFile(s, root, file);
    if (!open.ok) return open;

    /**
     * ⚠️ BOTH KINDS, AND SEMANTIC IS THE ONE THAT MATTERS. `syntacticDiagnosticsSync`
     * catches a missing brace; `semanticDiagnosticsSync` catches the type error
     * that is the entire reason to ask. Returning only the first would answer
     * "no problems" about a file that does not typecheck.
     */
    const [syn, sem] = await Promise.all([
      s.request('syntacticDiagnosticsSync', { file: open.absolute }),
      s.request('semanticDiagnosticsSync', { file: open.absolute }),
    ]);
    if (syn?.success === false && sem?.success === false) {
      return { ok: false, error: `tsserver: ${sem.message ?? syn.message ?? 'diagnostics failed'}` };
    }

    const raw = [...(syn?.body ?? []), ...(sem?.body ?? [])];
    const items = raw.map((d) => ({
      line: d?.start?.line ?? 1,
      column: d?.start?.offset ?? 1,
      severity: d?.category ?? 'error',
      code: d?.code ?? null,
      message: String(d?.text ?? '').slice(0, 300),
    }));
    items.sort((a, b) => (CATEGORY_RANK[a.severity] ?? 4) - (CATEGORY_RANK[b.severity] ?? 4) || a.line - b.line);

    const counts = { error: 0, warning: 0, information: 0, hint: 0 };
    for (const d of items) {
      if (d.severity === 'error') counts.error += 1;
      else if (d.severity === 'warning') counts.warning += 1;
      else counts.information += 1;
    }
    const { shown, truncated } = capped(items, MAX_DIAGNOSTICS);
    return {
      ok: true, kind: 'diagnostics', path: open.relative, counts, count: items.length,
      shown: shown.length, truncated, items: shown,
      note: items.length === 0 ? `tsserver reports no problems in ${open.relative}.` : null,
    };
  }, opts);
}

export async function documentSymbols(root, file, opts = {}) {
  return withServer(root, async (s) => {
    const open = await openFile(s, root, file);
    if (!open.ok) return open;
    const res = await s.request('navtree', { file: open.absolute });
    if (res?.success === false) return { ok: false, error: `tsserver: ${res.message ?? 'navtree failed'}` };

    const flat = [];
    const walk = (node, depth) => {
      for (const child of node?.childItems ?? []) {
        const line = child?.spans?.[0]?.start?.line;
        if (child?.text && Number.isInteger(line)) {
          flat.push({
            name: String(child.text).slice(0, 120),
            kind: String(child.kind ?? 'symbol'),
            line,
            depth,
            detail: child.kindModifiers ? String(child.kindModifiers).slice(0, 100) : null,
          });
        }
        walk(child, depth + 1);
      }
    };
    // ⚠️ The ROOT node is the file itself and is not a symbol in it — starting
    // the walk at its children keeps `list_symbols` from reporting the filename
    // as a declaration.
    walk(res?.body, 0);
    flat.sort((a, b) => a.line - b.line || a.depth - b.depth);
    const { shown, truncated } = capped(flat, MAX_SYMBOLS);
    return {
      ok: true, kind: 'symbols', path: open.relative, count: flat.length,
      shown: shown.length, truncated, symbols: shown,
      note: truncated ? `showing the first ${shown.length} of ${flat.length} symbols` : null,
    };
  }, opts);
}

/** Same dispatcher shape as `runLspTool`, so `tools.mjs` can pick either. */
export async function runTsserverTool(root, name, args = {}, opts = {}) {
  if (!handlesFile(args.file)) {
    return { ok: false, error: `tsserver handles TypeScript and JavaScript files; ${args.file} is neither. Use search_text instead.` };
  }
  switch (name) {
    case 'find_definition': return definition(root, args.file, args.line, args.column ?? 1, opts);
    case 'find_references': return references(root, args.file, args.line, args.column ?? 1, opts);
    case 'check_types': return diagnostics(root, args.file, opts);
    case 'list_symbols': return documentSymbols(root, args.file, opts);
    default: return { ok: false, error: `"${name}" is not a navigation tool` };
  }
}
