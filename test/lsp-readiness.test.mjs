/**
 * ── READINESS, AND THE LIE IT USED TO TELL ──────────────────────────────────
 *
 * `lspAvailable` decides whether the model is offered `find_definition`,
 * `find_references`, `check_types` and `list_symbols`. It asked ONE question —
 * is the server binary findable — and shipped four tools that fail on first use
 * in any workspace the server cannot actually serve.
 *
 * MEASURED 2026-08-15 on this machine, with `typescript-language-server@5.3.0`
 * installed globally:
 *
 *   · `console/`    → offered, and `list_symbols` returned 8 real symbols.
 *   · `acuvo-code/` → offered, and every verb died on the handshake with
 *                     "Could not find a valid TypeScript installation."
 *
 * ⭐ THE TWO HALVES ARE TESTED SEPARATELY AND FOR DIFFERENT REASONS. The
 * SYNTHETIC tests below build workspaces on disk and are the ones that will
 * still mean something on a machine with nothing installed — they pin the
 * decision. The two REAL tests at the bottom reproduce the exact measurement
 * above and are skipped when the server is absent; they are what catches our
 * model of the server being wrong, which a fixture built from that same model
 * never can.
 *
 * ⚠️ NOTHING HERE SPAWNS A LANGUAGE SERVER, and that is a claim about the
 * PRODUCT, not about the test being lazy: readiness runs on every session start
 * and must stay `existsSync`-cheap. One test asserts it directly by handing the
 * whole module a spawn that throws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHook } from 'node:async_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverLanguageServer,
  workspaceCanBeServed,
  checkLspArgs,
  runLspTool,
  LANGUAGE_SERVERS,
} from '../lib/lsp.mjs';

const ws = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-lspready-'));
  t?.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ } });
  return dir;
};

/** A `typescript-language-server` install, as far as discovery is concerned. */
function installServer(root) {
  const dir = join(root, 'node_modules', 'typescript-language-server', 'lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cli.mjs'), '// discoverable\n', 'utf8');
  return join(dir, 'cli.mjs');
}

/**
 * A `typescript` install, as far as the SERVER is concerned.
 *
 * ⚠️ `tsserver.js` IS THE FILE THAT MATTERS, not `package.json` and not
 * `typescript.js`. Measured against the server's own source: it joins
 * `tsserver.js` onto whichever module folder it finds and validates THAT. A
 * fixture that wrote a package.json would pass a check that guessed and fail
 * the one that read the source, which is the difference this test exists to pin.
 */
function installTypescript(dir, folder = 'node_modules/typescript/lib') {
  const libDir = join(dir, ...folder.split('/'));
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(libDir, 'tsserver.js'), '// tsserver\n', 'utf8');
  return join(libDir, 'tsserver.js');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE DEFECT ITSELF
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ a server installed into a workspace it cannot serve is NOT ready', (t) => {
  const root = ws(t);
  installServer(root);
  writeFileSync(join(root, 'index.ts'), 'export const a = 1;\n', 'utf8');
  // Deliberately no `typescript` anywhere: this is acuvo-code's shape, and it is
  // a DESIGN choice there, not an omission that will be corrected later.

  const found = discoverLanguageServer(root, 'typescript', { env: { PATH: '' } });
  assert.equal(found.ok, false, 'discovery used to say yes here and cost the model a round');
  assert.equal(found.unservable, true, 'the caller has to be able to tell this from "not installed"');
});

test('⭐ the refusal names the ONE command that fixes it', (t) => {
  const root = ws(t);
  installServer(root);
  const found = discoverLanguageServer(root, 'typescript', { env: { PATH: '' } });
  assert.equal(found.ok, false);
  // ⚠️ THE POINT OF THE WHOLE CHANGE. "did not initialize: Could not find a
  // valid TypeScript installation" is what the model used to see, and there is
  // no action in it — a user who reads it learns that something is broken, not
  // that one npm command fixes it.
  assert.match(found.error, /npm i -D typescript/, 'a refusal without a fix is a refusal that gets retried');
  assert.match(found.error, /tsconfig\.json does NOT satisfy/i, 'the intuitive wrong answer has to be pre-empted');
  assert.match(found.error, /search_text/, 'and it must name what still works');
});

test('⭐ …and it becomes ready the moment `typescript` is installed, with nothing else changed', (t) => {
  const root = ws(t);
  installServer(root);
  assert.equal(discoverLanguageServer(root, 'typescript', { env: { PATH: '' } }).ok, false);

  installTypescript(root);

  const found = discoverLanguageServer(root, 'typescript', { env: { PATH: '' } });
  assert.equal(found.ok, true, 'the gate must OPEN — a check that never says yes is not a check');
  assert.match(String(found.tsserverFrom), /tsserver\.js$/, 'and it should say which tsserver it expects to drive');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. NOT STRICTER THAN THE SERVER — the "guard that fails correct work" risk
 *
 * Every case here is a workspace the real server SERVES. If any of them went
 * red we would be withholding four working tools, which is the more expensive
 * of the two possible mistakes.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ a `typescript` hoisted to a PARENT directory counts — that is how monorepos are shaped', (t) => {
  const outer = ws(t);
  const root = join(outer, 'packages', 'app');
  mkdirSync(root, { recursive: true });
  installServer(root);
  installTypescript(outer); // hoisted three levels up, exactly like a real monorepo

  assert.equal(workspaceCanBeServed(root, 'typescript').ok, true);
  assert.equal(discoverLanguageServer(root, 'typescript', { env: { PATH: '' } }).ok, true);
});

test('⭐ yarn PnP and pnpify layouts count — they have no node_modules at all', (t) => {
  for (const folder of ['.yarn/sdks/typescript/lib', '.vscode/pnpify/typescript/lib']) {
    const root = ws(t);
    installServer(root);
    installTypescript(root, folder);
    assert.equal(
      workspaceCanBeServed(root, 'typescript').ok, true,
      `${folder} is in the server's own MODULE_FOLDERS — refusing it would withhold working tools from every PnP repo`,
    );
  }
});

/** A `typescript` package nested where only NODE RESOLUTION can see it. */
function installBundledTypescript(serverPkgDir) {
  const pkg = join(serverPkgDir, 'node_modules', 'typescript');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3', main: 'lib/typescript.js' }), 'utf8');
  writeFileSync(join(pkg, 'lib', 'typescript.js'), 'module.exports = {};\n', 'utf8');
  writeFileSync(join(pkg, 'lib', 'tsserver.js'), '// tsserver\n', 'utf8');
}

test('⭐ a `typescript` bundled INSIDE the server package counts — node resolution finds it, a path walk does not', (t) => {
  const root = ws(t);
  installServer(root);
  const serverPkg = join(root, 'node_modules', 'typescript-language-server');
  installBundledTypescript(serverPkg);

  /**
   * ⚠️ THIS IS THE SERVER'S LAST RESORT (`bundledVersion()`: `require.resolve
   * ('typescript')` from its own file), and it is invisible to a directory walk
   * — nothing named `node_modules/typescript/lib/tsserver.js` exists at the root
   * or above it. Reimplementing node's resolution instead of calling
   * `createRequire` is what would fail here, and failing here means withholding
   * four tools from a workspace the server serves fine.
   */
  assert.equal(workspaceCanBeServed(root, 'typescript').ok, false, 'without the server file there is nothing to resolve FROM');
  const viaServer = workspaceCanBeServed(root, 'typescript', { serverFile: join(serverPkg, 'lib', 'cli.mjs') });
  assert.equal(viaServer.ok, true);
  assert.equal(viaServer.source, 'bundled');
  assert.equal(discoverLanguageServer(root, 'typescript', { env: { PATH: '' } }).ok, true);
});

test('⚠️ a server install that cannot serve does not hide a SECOND one that can', (t) => {
  const outer = ws(t);
  const root = join(outer, 'app');
  mkdirSync(root, { recursive: true });
  // The nearer install — found first, and useless: nothing to drive.
  installServer(root);
  // The further one, carrying its own typescript.
  installServer(outer);
  installBundledTypescript(join(outer, 'node_modules', 'typescript-language-server'));

  /**
   * ⭐ WHY THE LOOP CONTINUES INSTEAD OF RETURNING THE FIRST FAILURE. The
   * bundled fallback depends on WHICH install was found, so "the first
   * candidate cannot serve" is not "no candidate can". Returning early here
   * would report a workspace as unservable while a perfectly good server sat one
   * level up — a guard failing correct work, in the exact shape this repo keeps
   * catching.
   */
  const found = discoverLanguageServer(root, 'typescript', { env: { PATH: '' } });
  assert.equal(found.ok, true, found.error);
  assert.match(found.via.split(/[\\/]/).join('/'), /node_modules\/typescript-language-server/);
  assert.ok(!found.via.includes(join('app', 'node_modules')), 'it must have moved past the unservable one');
});

test('⭐ the servers that need nothing are unaffected — rust, go and python stay self-contained', (t) => {
  const root = ws(t);
  for (const language of ['rust', 'go', 'python']) {
    assert.equal(LANGUAGE_SERVERS[language].workspace, undefined, `${language} must not acquire a requirement by accident`);
    assert.equal(
      workspaceCanBeServed(root, language).ok, true,
      `${language}'s server bundles what it needs; gating it on a file in the tree would be inventing a requirement`,
    );
  }
});

test('⚠️ the escape hatch still answers the OLD question, for callers that really want it', (t) => {
  const root = ws(t);
  installServer(root);
  assert.equal(discoverLanguageServer(root, 'typescript', { env: { PATH: '' } }).ok, false);
  assert.equal(
    discoverLanguageServer(root, 'typescript', { env: { PATH: '' }, requireWorkspaceSupport: false }).ok, true,
    '"is the program on this machine" is a legitimate question — it is just not the readiness question',
  );
});

test('⚠️ readiness never throws, whatever the root is', () => {
  for (const root of [undefined, '', null, 42, '(memory)', join(tmpdir(), 'acuvo-nope-4f2a')]) {
    assert.doesNotThrow(() => workspaceCanBeServed(root, 'typescript'), `root ${JSON.stringify(root)}`);
    assert.doesNotThrow(() => discoverLanguageServer(root, 'typescript', { env: { PATH: '' } }));
  }
  assert.equal(discoverLanguageServer('/x', 'cobol', { env: { PATH: '' } }).ok, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. IT MUST STAY CHEAP — the comment on lspAvailable promises "spawns nothing"
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ answering the readiness question is cheaper than a single spawn', (t) => {
  const root = ws(t);
  installServer(root);
  installTypescript(root);

  /**
   * ⚠️ WHY NOT JUST COUNT `spawn` CALLS: you cannot. `lsp.mjs` does
   * `import { spawn } from 'node:child_process'`, and an ES module namespace is
   * frozen — assigning to it throws, and even if it did not, the binding was
   * captured when the module loaded. My first version of this test did exactly
   * that and failed, which is the only reason I know.
   *
   * ⭐ TWO INSTRUMENTS, BECAUSE ONE OF THEM HAS A HOLE — and mutation testing is
   * what found the hole rather than reasoning about it. The timing budget below
   * catches a BLOCKING probe (`spawnSync`, or an awaited handshake). It does NOT
   * catch a fire-and-forget `spawn`, which returns instantly and costs wall
   * clock nothing here while still churning a process per session — a mutation
   * that added exactly that SURVIVED the timing check alone.
   *
   * `async_hooks` closes it: every asynchronously-spawned child creates a
   * `PROCESSWRAP` resource, whatever module spawned it and whether or not
   * anybody awaits it. Verified in this repo: async `spawn` → 1 PROCESSWRAP,
   * `spawnSync` → 0, which is exactly why both instruments are needed.
   */
  const spawned = [];
  const hook = createHook({ init(_id, type) { if (type === 'PROCESSWRAP') spawned.push(type); } });

  const spawnStart = process.hrtime.bigint();
  spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const oneSpawnMs = Number(process.hrtime.bigint() - spawnStart) / 1e6;

  const N = 30;
  hook.enable();
  const readyStart = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) {
    discoverLanguageServer(root, 'typescript', { env: { PATH: '' } });
    workspaceCanBeServed(root, 'typescript');
  }
  const readyMs = Number(process.hrtime.bigint() - readyStart) / 1e6;
  hook.disable();

  assert.equal(spawned.length, 0, 'readiness spawned a child process; it runs on every session start');
  /**
   * ⭐ A BUDGET THAT CALIBRATES ITSELF. A fixed millisecond bound would flake on
   * a loaded machine; "cheaper than one `node -e 0`" moves with the machine.
   * Measured here: 30 readiness calls ≈ 16ms, one spawn ≈ 120ms — and a probe
   * that asked the server would pay at least one spawn even if it cached after.
   */
  assert.ok(
    readyMs < oneSpawnMs,
    `${N} readiness checks took ${readyMs.toFixed(1)}ms; one spawn costs ${oneSpawnMs.toFixed(1)}ms. Readiness must stay existsSync-cheap.`,
  );

  /**
   * ⭐ AND THE STRUCTURAL HALF, which does not depend on a clock at all: both
   * functions are SYNCHRONOUS. An LSP handshake cannot be awaited from a
   * synchronous function, so "just ask the server" cannot be added without
   * changing these signatures — and changing them turns this line red.
   */
  const answer = discoverLanguageServer(root, 'typescript', { env: { PATH: '' } });
  assert.equal(typeof answer.then, 'undefined', 'a promise here means something is being awaited');
  assert.notEqual(discoverLanguageServer.constructor.name, 'AsyncFunction');
  assert.notEqual(workspaceCanBeServed.constructor.name, 'AsyncFunction');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE WRONG-ARGUMENT MESSAGE
 *
 * The old one complained about a missing line number when the real problem was
 * that the caller sent `path` and `symbol`.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️ "path" instead of "file" is told the argument name, not a line-number complaint', async () => {
  const r = await runLspTool('/nowhere', 'find_definition', { path: 'src/a.ts', symbol: 'handleClick' });
  assert.equal(r.ok, false);
  assert.match(r.error, /takes "file", not "path"/);
  assert.match(r.error, /src\/a\.ts/, 'echo the value back so the retry is a copy, not a re-derivation');
  assert.doesNotMatch(r.error, /line must be a whole number/, 'that was the confusing old message');
});

test('⭐ "symbol" without a line is told where line numbers COME FROM', async () => {
  const r = await runLspTool('/nowhere', 'find_references', { file: 'src/a.ts', symbol: 'handleClick' });
  assert.equal(r.ok, false);
  assert.match(r.error, /position-based/);
  assert.match(r.error, /handleClick/);
  // ⚠️ THE PART THAT ACTUALLY SAVES THE ROUND. Telling a caller that `line` is
  // required, when all it has is a name, invites it to guess a number.
  assert.match(r.error, /search_text/);
  assert.match(r.error, /list_symbols/);
});

test('⭐ a missing file, with no alias to blame, still names what is needed', async () => {
  const r = await runLspTool('/nowhere', 'list_symbols', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /needs "file"/);
});

test('⚠️⚠️ the guard does not fail correct calls', () => {
  // ⭐ THE HAPPY PATH IS THE TEST THAT MATTERS MOST HERE. A refusal that fires
  // on a well-formed call would disable four tools completely, which is worse
  // than the confusing message it replaced.
  assert.equal(checkLspArgs('find_definition', { file: 'a.ts', line: 3, column: 11 }).ok, true);
  assert.equal(checkLspArgs('find_definition', { file: 'a.ts', line: 1 }).ok, true, 'column is optional');
  assert.equal(checkLspArgs('check_types', { file: 'a.ts' }).ok, true, 'check_types needs no position');
  assert.equal(checkLspArgs('list_symbols', { file: 'a.ts' }).ok, true);
  // Both spellings present: `file` wins silently. Rejecting a call that carries
  // everything it needs would be pedantry with a token cost.
  assert.equal(checkLspArgs('list_symbols', { file: 'a.ts', path: 'b.ts' }).ok, true);
  assert.equal(checkLspArgs('find_definition', { file: 'a.ts', line: 3, symbol: 'x' }).ok, true, 'a stray extra key is not an error');
});

test('⭐ an optional argument is FORGIVEN, not refused — "col" is accepted as "column"', async () => {
  const root = ws();
  writeFileSync(join(root, 'a.ts'), 'export const alpha = 1;\n', 'utf8');
  const sent = [];
  const session = {
    ok: true, label: 'stub', root, stopped: false,
    docs: new Map(), published: new Map(), waiters: new Map(), seq: 0, capabilities: {},
    rpc: { request: async (m, p) => { sent.push({ m, p }); return { result: null }; }, notify: () => {} },
  };
  const r = await runLspTool(root, 'find_definition', { file: 'a.ts', line: 1, col: 14 }, { session });
  assert.equal(r.ok, true, JSON.stringify(r));
  const req = sent.find((s) => s.m === 'textDocument/definition');
  // 1-based 14 → 0-based 13. If `col` were dropped the default would send 0.
  assert.equal(req.p.position.character, 13, 'refusing the call would have cost a round; ignoring it would have answered about the wrong token');
  rmSync(root, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE REAL MACHINE — the two workspaces that were actually measured
 *
 * ⚠️ SKIPPED WHEN THE SERVER IS ABSENT, which is the normal case. A test that
 * cannot run is not evidence, so the synthetic section above carries the
 * decision and this section only catches our MODEL of the server being wrong.
 * ──────────────────────────────────────────────────────────────────────────── */

const REAL = {
  works: 'C:/Projects/claude-build-closer-wt/console',
  cannot: 'C:/Projects/claude-build-closer-wt/acuvo-code',
};
// "Is the server on this machine at all" — the OLD question, which is exactly
// the right one for deciding whether these two tests can run.
const serverHere = existsSync(REAL.cannot)
  && discoverLanguageServer(REAL.cannot, 'typescript', { requireWorkspaceSupport: false }).ok;
const realSkip = !serverHere
  ? 'typescript-language-server is not installed here'
  : (!existsSync(join(REAL.works, 'node_modules', 'typescript', 'lib', 'tsserver.js'))
    ? 'the measured console/ workspace is not present on this machine'
    : false);

test('⭐ REAL: console/ still says ready — the case that WORKS must not regress', { skip: realSkip }, () => {
  const found = discoverLanguageServer(REAL.works, 'typescript');
  assert.equal(found.ok, true, `measured working 2026-08-15 (8 symbols from list_symbols): ${found.error ?? ''}`);
});

test('⚠️ REAL: acuvo-code/ now says NOT ready — it is zero-dependency by design', { skip: realSkip }, () => {
  const found = discoverLanguageServer(REAL.cannot, 'typescript');
  assert.equal(found.ok, false, 'this is the workspace where all four tools failed on first use');
  assert.match(found.error, /npm i -D typescript/);
});
