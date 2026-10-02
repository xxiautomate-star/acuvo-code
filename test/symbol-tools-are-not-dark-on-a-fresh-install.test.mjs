/**
 * ── ⭐⭐⭐ EIGHT SYMBOL VERBS WERE DARK ON EVERY PROJECT WITHOUT node_modules ──
 *
 * MEASURED 2026-09-19 with the real binary, in a scratch TypeScript project
 * holding `package.json`, `tsconfig.json` and two `.ts` files and nothing else:
 *
 *     node bin/acuvo.mjs --doctor      56 of 87 tools
 *       find_definition · find_references · check_types · list_symbols ·
 *       rename_symbol · insert_before_symbol · insert_after_symbol ·
 *       replace_function_body            ALL DARK
 *
 *     node bin/acuvo.mjs "call find_references on formatPrice…"
 *       → "I don't have a `find_references` tool in this session"
 *
 * After `acuvo lsp install`: **64 of 87**, no dark symbol row, and the same
 * prompt returned `references: 3 results` across two files plus
 * `list_symbols: 2 symbols`. This file guards the three decisions that make
 * that true, because each of them is one line away from being wrong in a way
 * nothing else would notice.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findTsserver, tsserverAvailable } from '../lib/tsserver.mjs';
import { installArgv, managedTsserverPath, managedRoot, MANAGED_TYPESCRIPT_SPEC } from '../lib/managed-language-server.mjs';
import { toolNamesForRounds } from '../lib/tools.mjs';
import { toolOffer } from '../lib/doctor.mjs';

const SYMBOL_TOOLS = [
  'find_definition', 'find_references', 'check_types', 'list_symbols',
  'rename_symbol', 'insert_before_symbol', 'insert_after_symbol', 'replace_function_body',
];

/** A HOME that holds a managed tsserver, or does not. Returns `{ env, home }`. */
function fakeHome(withServer) {
  const home = mkdtempSync(join(tmpdir(), 'acuvo-lsp-home-'));
  const env = { ACUVO_HOME: join(home, '.acuvo') };
  if (withServer) {
    const file = managedTsserverPath(env, home);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '// a stand-in: every gate in this file is existsSync, never a spawn\n');
  }
  return { env, home, cleanup: () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

/** A workspace of a given shape, with no node_modules unless asked for one. */
function workspace(files) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-lsp-ws-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

test('⭐⭐⭐ a TypeScript project with no node_modules gets all eight symbol verbs once a managed server exists', () => {
  const ws = workspace({ 'package.json': '{"name":"x"}', 'tsconfig.json': '{}', 'src/util.ts': 'export const a = 1;\n' });
  const without = fakeHome(false);
  const withIt = fakeHome(true);
  try {
    const dark = toolNamesForRounds(8, { root: ws.dir, env: without.env, home: without.home });
    for (const name of SYMBOL_TOOLS) {
      assert.equal(dark.includes(name), false, `${name} must NOT be offered with no server anywhere`);
    }

    const lit = toolNamesForRounds(8, { root: ws.dir, env: withIt.env, home: withIt.home });
    for (const name of SYMBOL_TOOLS) {
      assert.equal(lit.includes(name), true, `${name} must be offered once a managed tsserver exists`);
    }
    assert.equal(lit.length - dark.length, SYMBOL_TOOLS.length, 'exactly eight verbs should appear, no more');
  } finally {
    ws.cleanup(); without.cleanup(); withIt.cleanup();
  }
});

test('⚠️⚠️ a managed server must NOT light the TypeScript verbs inside a Rust project', () => {
  /**
   * This is the whole reason `tools.mjs` intersects the managed server with
   * `languagesPresent`. A server under HOME is reachable from EVERY workspace,
   * so without the intersection a `Cargo.toml` repo would be offered four tools
   * whose only possible answer is *"tsserver handles TypeScript and JavaScript
   * files; main.rs is neither"* — the dead button `lspAvailable`'s own header
   * spent a page of measurements learning to refuse, reintroduced from the
   * other side.
   */
  const ws = workspace({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/main.rs': 'fn main() {}\n' });
  const withIt = fakeHome(true);
  try {
    const names = toolNamesForRounds(8, { root: ws.dir, env: withIt.env, home: withIt.home });
    for (const name of SYMBOL_TOOLS) {
      assert.equal(names.includes(name), false, `${name} must stay dark in a Rust-only workspace`);
    }
  } finally {
    ws.cleanup(); withIt.cleanup();
  }
});

test("⭐⭐ the workspace's own tsserver wins over the managed one, and it is not a preference", () => {
  /**
   * A project's own `typescript` is the version that COMPILES it, so it is the
   * version whose diagnostics match its `tsc`. The managed copy is pinned to a
   * major and could be ahead or behind. If this order ever flipped, the symptom
   * would be confident, subtly-wrong type errors in exactly the repos that took
   * the most care to pin their compiler — and nothing would log it.
   */
  const ws = workspace({
    'package.json': '{"name":"x"}',
    'node_modules/typescript/lib/tsserver.js': '// the project\'s own\n',
  });
  const withIt = fakeHome(true);
  try {
    const chosen = findTsserver(ws.dir, { env: withIt.env, home: withIt.home });
    assert.ok(chosen.includes('node_modules'), 'a tsserver was found');
    assert.equal(chosen.startsWith(ws.dir), true, `expected the workspace copy, got ${chosen}`);
    assert.equal(chosen.startsWith(managedRoot(withIt.env, withIt.home)), false);
  } finally {
    ws.cleanup(); withIt.cleanup();
  }
});

test('⚠️ `allowManaged: false` still asks the original question — does THIS TREE carry one', () => {
  const ws = workspace({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1;\n' });
  const withIt = fakeHome(true);
  try {
    assert.equal(findTsserver(ws.dir, { allowManaged: false, env: withIt.env, home: withIt.home }), null);
    assert.equal(tsserverAvailable(ws.dir, { allowManaged: false, env: withIt.env, home: withIt.home }), false);
    assert.notEqual(findTsserver(ws.dir, { env: withIt.env, home: withIt.home }), null);
  } finally {
    ws.cleanup(); withIt.cleanup();
  }
});

test('🚨 the install must pin @5 — plain `typescript` now resolves to 7.x, which ships no tsserver', () => {
  /**
   * MEASURED 2026-09-19 against the live registry:
   *   npm install typescript   → typescript@7.0.2
   *   node_modules/typescript/lib/ → getExePath.js  tsc.js  version.cjs   (no tsserver.js)
   *
   * TypeScript 7 is the Go rewrite. `npm install typescript@5` → 5.9.3, which
   * has `lib/tsserver.js`. So this is not a version preference, it is the
   * difference between the feature existing and not — and the failure is
   * silent, because npm exits 0 either way.
   */
  assert.equal(MANAGED_TYPESCRIPT_SPEC, 'typescript@5');
  const argv = installArgv({ env: { ACUVO_HOME: '/tmp/x' }, home: '/tmp' });
  assert.ok(argv.includes('typescript@5'), 'the pinned spec must be on the command line');
  assert.equal(argv.includes('typescript'), false, 'a bare `typescript` would install 7.x');
  /** Arbitrary registry code must not run with the user's permissions to install a compiler. */
  assert.ok(argv.includes('--ignore-scripts'));
  /** `--prefix` is what keeps this out of whatever directory the shell happens to be in. */
  assert.ok(argv.includes('--prefix'));
});

test('⚠️⚠️ the doctor must never print `npm i -D typescript` as the cure — it is the defect', () => {
  /**
   * The doctor printed exactly that under four dark rows for weeks, and
   * `lsp.mjs` had ALREADY recorded that a global typescript@7 "contains no
   * tsserver.js at all" — two places disagreeing, with the wrong one on screen.
   * A reader who follows it downloads 23MB and the tools stay dark.
   *
   * ⭐ This asserts on the REAL `toolOffer` rather than on a string in the
   * source, so it reads what a user would actually see.
   */
  const ws = workspace({ 'package.json': '{"name":"x"}', 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
  const without = fakeHome(false);
  try {
    const offer = toolOffer({ root: ws.dir, env: without.env, home: without.home, maxRounds: 8 });
    const row = offer.withheld.find((d) => d.name === 'find_definition');
    assert.ok(row, 'find_definition should be dark with no server anywhere');
    assert.match(row.fix, /acuvo lsp install/);
    assert.match(row.fix, /typescript@5/);
    /**
     * ⚠️ THE NEGATIVE IS THE GUARD, AND IT IS THE EXACT OLD STRING. The fix
     * line used to be `LANGUAGE_SERVERS.typescript.install` verbatim — *"install
     * one: npm i -D typescript-language-server typescript"* — which now
     * installs TypeScript 7 and leaves all eight tools dark. A regex for "any
     * mention of npm i -D typescript" would be wrong in the other direction,
     * because the correct sentence has to NAME the broken command in order to
     * warn about it; ours does, one clause later.
     */
    assert.equal(row.fix.includes('typescript-language-server typescript'), false, row.fix);
    assert.match(row.fix, /NOT plain `npm i -D typescript`/);

    /** ⭐ AND ALL EIGHT GET A REASON. Four of them used to get "not offered in
     *  this configuration · run the doctor again with the flags you actually
     *  use" — advice about a flag that does not exist. */
    for (const name of SYMBOL_TOOLS) {
      const r = offer.withheld.find((d) => d.name === name);
      assert.ok(r, `${name} should be dark here`);
      assert.equal(/not offered in this configuration/.test(r.why), false, `${name}: ${r.why}`);
    }
  } finally {
    ws.cleanup(); without.cleanup();
  }
});
