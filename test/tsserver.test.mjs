/**
 * ── THE ADAPTER THAT MADE FOUR DARK TOOLS REACHABLE ────────────────────────
 *
 * `find_definition`, `find_references`, `list_symbols` and `check_types` were
 * gated on `typescript-language-server` — a package almost nobody installs.
 * Measured: `lspAvailable` was FALSE on a real Next.js app and a real API
 * server. `typescript` itself, which ships `lib/tsserver.js`, was present in
 * both.
 *
 * ⚠️ THE INTEGRATION TESTS RUN A REAL tsserver against a real TypeScript file
 * and assert real type errors. They cost $0.00 — tsserver is a local process —
 * but they need `typescript` to exist somewhere on this machine. Where it does
 * not, they SKIP LOUDLY rather than passing: a test that quietly passes when it
 * exercised nothing is how this package ended up with 1,420 green tests and no
 * coverage of its own success path.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findTsserver, tsserverAvailable, handlesFile, runTsserverTool,
  diagnostics, definition, references, documentSymbols,
  MAX_WALK_UP, TS_EXTENSIONS,
} from '../lib/tsserver.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'acuvo-ts-'));
  made.push(d);
  return d;
}

/** Somewhere on this machine with a real `typescript` installed, or null. */
function findRealTypescript() {
  const candidates = [
    'C:/Projects/claude-build-closer-wt/console',
    'C:/Projects/claude-build-ro-wt/revenue-os',
    process.cwd(),
  ];
  for (const c of candidates) {
    const found = findTsserver(c);
    if (found) return found.replace(/[\\/]lib[\\/]tsserver\.js$/, '');
  }
  return null;
}

/** A temp workspace with a junction to a real typescript — junctions need no admin. */
function workspaceWithTypescript(files) {
  const ts = findRealTypescript();
  if (!ts) return null;
  const root = tmp();
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  try { symlinkSync(ts, join(root, 'node_modules', 'typescript'), 'junction'); } catch { return null; }
  writeFileSync(join(root, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  return root;
}

// ── discovery ──────────────────────────────────────────────────────────────

test('it finds tsserver inside the typescript package, walking up', () => {
  const root = tmp();
  const deep = join(root, 'packages', 'app', 'src');
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(root, 'node_modules', 'typescript', 'lib'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js'), '// stub\n');

  assert.ok(findTsserver(deep), 'a monorepo keeps typescript at the top and runs tools from a package');
  assert.ok(tsserverAvailable(deep));
  assert.match(findTsserver(deep), /tsserver\.js$/);
});

test('no typescript is a clean "not available", not a throw', () => {
  const root = tmp();
  assert.equal(findTsserver(root), null);
  assert.equal(tsserverAvailable(root), false);
  assert.equal(findTsserver(''), null);
  assert.equal(findTsserver(null), null);
});

test('the walk is bounded', () => {
  assert.ok(MAX_WALK_UP >= 4 && MAX_WALK_UP <= 16);
});

// ── which files it will answer about ───────────────────────────────────────

test('it answers for TypeScript AND JavaScript, and refuses the rest', () => {
  for (const f of ['a.ts', 'a.tsx', 'a.mts', 'b.js', 'b.jsx', 'b.mjs', 'b.cjs']) {
    assert.equal(handlesFile(f), true, `${f} should be handled`);
  }
  for (const f of ['a.py', 'a.rs', 'a.go', 'a.json', 'a', '']) {
    assert.equal(handlesFile(f), false, `${f} should not be`);
  }
  assert.ok(TS_EXTENSIONS.has('.tsx'));
});

test('a file it cannot answer about is refused BEFORE a server is started', async () => {
  /**
   * ⚠️ Handing tsserver a `.py` would produce a confident refusal from the
   * wrong component — and would pay for a process start to do it.
   */
  const r = await runTsserverTool(tmp(), 'check_types', { file: 'main.py' });
  assert.equal(r.ok, false);
  assert.match(r.error, /TypeScript and JavaScript/);
  assert.match(r.error, /search_text/, 'and it must name the fallback, or the model retries');
});

test('an unknown verb is refused', async () => {
  const r = await runTsserverTool(tmp(), 'rename_symbol', { file: 'a.ts' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a navigation tool/);
});

// ── ⭐⭐ the real thing ─────────────────────────────────────────────────────

const BROKEN = 'export function add(a: number, b: number): number { return a + b; }\n'
  + 'const wrong: string = add(1, 2);\n'
  + 'export const bad = add("x", 2);\n';

test('⭐ check_types finds REAL type errors in a REAL file', async (t) => {
  const root = workspaceWithTypescript({ 'broken.ts': BROKEN });
  if (!root) return t.skip('no typescript on this machine — the real tsserver path was NOT exercised');

  const d = await diagnostics(root, 'broken.ts');
  assert.equal(d.ok, true, d.error);
  assert.equal(d.kind, 'diagnostics');

  /**
   * ⚠️ THE POINT OF THE TEST. A type-checker that only ever says "clean" is
   * worthless, and "clean" is exactly what a broken adapter returns — no
   * response parsed, no diagnostics, everything fine.
   */
  assert.ok(d.counts.error >= 2, `expected at least 2 errors, got ${d.counts.error}`);
  const codes = d.items.map((i) => i.code);
  assert.ok(codes.includes(2322), 'TS2322: number is not assignable to string');
  assert.ok(codes.includes(2345), 'TS2345: string is not assignable to number');

  // The position has to be usable — 1-based line and column, like lsp.mjs.
  const first = d.items[0];
  assert.ok(first.line >= 1 && first.column >= 1);
  assert.ok(first.message.length > 10);
});

test('⭐ a clean file reports clean, and says so', async (t) => {
  const root = workspaceWithTypescript({ 'good.ts': 'export const n: number = 1;\n' });
  if (!root) return t.skip('no typescript on this machine');

  const d = await diagnostics(root, 'good.ts');
  assert.equal(d.ok, true, d.error);
  assert.equal(d.counts.error, 0);
  assert.match(d.note, /no problems/);
});

test('⭐ find_definition and find_references resolve real symbols', async (t) => {
  const root = workspaceWithTypescript({ 'broken.ts': BROKEN });
  if (!root) return t.skip('no typescript on this machine');

  // `add(` on line 3 — jump to its declaration on line 1.
  const def = await definition(root, 'broken.ts', 3, 20);
  assert.equal(def.ok, true, def.error);
  assert.equal(def.kind, 'definition');
  assert.equal(def.count, 1);
  assert.equal(def.locations[0].line, 1);
  assert.equal(def.locations[0].inWorkspace, true);
  assert.match(def.locations[0].path, /broken\.ts$/);
  assert.match(def.locations[0].excerpt, /export function add/);

  // The declaration itself — used twice below it.
  const refs = await references(root, 'broken.ts', 1, 17);
  assert.equal(refs.ok, true, refs.error);
  assert.equal(refs.kind, 'references');
  assert.equal(refs.count, 3, 'the declaration and both call sites');
  assert.ok(refs.locations.every((l) => typeof l.excerpt === 'string'));
});

test('⭐ list_symbols does not report the file itself as a symbol', async (t) => {
  const root = workspaceWithTypescript({ 'broken.ts': BROKEN });
  if (!root) return t.skip('no typescript on this machine');

  const s = await documentSymbols(root, 'broken.ts');
  assert.equal(s.ok, true, s.error);
  assert.equal(s.kind, 'symbols');
  assert.ok(s.count >= 3, `expected add, wrong and bad, got ${s.count}`);
  const names = s.symbols.map((x) => x.name);
  assert.ok(names.includes('add'));
  // ⚠️ The navtree ROOT is the file. Starting the walk at the root would report
  // "broken.ts" as a declaration inside broken.ts.
  assert.equal(names.includes('broken.ts'), false);
});

test('⭐ pointing at whitespace explains itself rather than saying "none"', async (t) => {
  const root = workspaceWithTypescript({ 'broken.ts': BROKEN });
  if (!root) return t.skip('no typescript on this machine');

  const def = await definition(root, 'broken.ts', 1, 1);
  assert.equal(def.ok, true);
  if (def.count === 0) {
    // "No definition" and "you pointed at the wrong column" look identical to
    // the caller, and the second is far more common.
    assert.match(def.note, /1-based/);
  }
});

test('a missing file is a sentence, not a crash', async (t) => {
  const root = workspaceWithTypescript({ 'broken.ts': BROKEN });
  if (!root) return t.skip('no typescript on this machine');
  const d = await diagnostics(root, 'nope.ts');
  assert.equal(d.ok, false);
  assert.match(d.error, /does not exist/);
});

// ── reach: the offer actually changes ──────────────────────────────────────

test('⭐⭐ typescript alone makes all four navigation tools reachable', async (t) => {
  const { toolNamesForRounds } = await import('../lib/tools.mjs');
  const root = workspaceWithTypescript({ 'a.ts': 'export const x = 1;\n' });
  if (!root) return t.skip('no typescript on this machine');

  const offered = toolNamesForRounds(10, { allowRun: true, root, env: { PATH: process.env.PATH } });
  for (const n of ['find_definition', 'find_references', 'check_types', 'list_symbols']) {
    assert.ok(offered.includes(n), `${n} should be offered where typescript is installed`);
  }

  // ⚠️ And still withheld where there is nothing to serve them — offering a tool
  // that can only apologise teaches the model to try, wait and apologise.
  const bare = tmp();
  const none = toolNamesForRounds(10, { allowRun: true, root: bare, env: { PATH: '' } });
  for (const n of ['find_definition', 'check_types']) assert.equal(none.includes(n), false);
});
