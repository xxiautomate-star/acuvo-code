/**
 * ── THE STATEFUL REPL ──────────────────────────────────────────────────────
 *
 * Every assertion here drives a REAL node process holding REAL state. A stubbed
 * child could not test the one property this tool exists for — that call N+1
 * sees what call N defined — and that property was BROKEN in the first
 * implementation while everything else worked.
 *
 * ⚠️ Costs $0.00: the subject is `node`, which is already running this test.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  replEval, replReset, replStopAll, replToolSchemas, runReplTool,
  REPL_TOOL_NAMES, MAX_CODE_CHARS,
} from '../lib/repl.mjs';

const made = [];
after(() => {
  replStopAll();
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-repl-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"r","version":"1.0.0","type":"module"}\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  return root;
}

// ── ⭐⭐ the property the whole tool exists for ─────────────────────────────

test('⭐⭐ state SURVIVES between calls — this is the entire point', async () => {
  /**
   * The first implementation wrapped each submission in an AsyncFunction body,
   * so `const a = 21` then `a * 2` returned "a is not defined". Everything else
   * worked; the one thing that makes this different from `evaluate` did not.
   */
  const root = workspace();

  const first = await replEval(root, 'const a = 21');
  assert.equal(first.ok, true, first.error);
  assert.equal(first.startedFresh, true);

  const second = await replEval(root, 'a * 2');
  assert.equal(second.ok, true, second.error);
  assert.equal(second.value, '42', 'the second call must see the first call\'s binding');
  assert.equal(second.startedFresh, false, 'and it must be the SAME session, not a new one');

  replReset(root);
});

test('⭐ it can open the project it is sitting in', async () => {
  /**
   * ⚠️ Relative imports resolve against the DRIVER unless rewritten — measured
   * as ERR_MODULE_NOT_FOUND pointing at lib/. A REPL that cannot import the
   * workspace is a calculator.
   */
  const root = workspace({
    'thing.mjs': 'export const answer = 42;\nexport function twice(n) { return n * 2; }\n',
  });

  const load = await replEval(root, 'const m = await import("./thing.mjs")');
  assert.equal(load.ok, true, load.error);

  const used = await replEval(root, 'm.twice(m.answer)');
  assert.equal(used.ok, true, used.error);
  assert.equal(used.value, '84', 'a real function from a real project file');

  replReset(root);
});

test('a single expression returns its value; a block does not', async () => {
  const root = workspace();
  assert.equal((await replEval(root, '2 + 3')).value, '5');
  assert.equal((await replEval(root, '"a" + "b"')).value, 'ab');
  // ⚠️ `const x = 2` yielding undefined is CORRECT — a declaration is not an
  // expression. The tool would be write-only if `x * 3` also yielded nothing.
  assert.equal((await replEval(root, 'const q = 2')).value, 'undefined');
  assert.equal((await replEval(root, 'q * 3')).value, '6');
  replReset(root);
});

test('console output is captured, not lost to the void', async () => {
  const root = workspace();
  const r = await replEval(root, 'console.log("hello"); 7');
  assert.equal(r.ok, true, r.error);
  assert.match(r.logs, /hello/, 'a log the model cannot see is a log it will write twice');
  replReset(root);
});

test('it reports what it is holding, so the model never guesses its own state', async () => {
  const root = workspace();
  await replEval(root, 'const alpha = 1');
  const r = await replEval(root, 'const beta = 2');
  assert.ok(r.defined.includes('alpha'));
  assert.ok(r.defined.includes('beta'));
  replReset(root);
});

// ── failure, which is most of what a debugging tool does ───────────────────

test('an error keeps its stack instead of collapsing to a message', async () => {
  const root = workspace();
  const r = await replEval(root, 'null.boom');
  assert.equal(r.ok, false);
  assert.match(r.error, /TypeError/);
  // ⚠️ Only `e.message` for a TypeError deep in a project makes this harder than
  // a console.log would have been.
  assert.ok(r.error.length > 20, 'the stack must survive');
  replReset(root);
});

test('an error does not destroy the session', async () => {
  const root = workspace();
  await replEval(root, 'const keep = 5');
  await replEval(root, 'this.is.not.valid');
  const after_ = await replEval(root, 'keep + 1');
  assert.equal(after_.ok, true, 'a thrown expression must not cost the state');
  assert.equal(after_.value, '6');
  replReset(root);
});

test('⚠️ a hanging expression stops the session rather than blocking every later call', async () => {
  /**
   * The driver is single-threaded, so an infinite loop would queue every later
   * call behind it forever. A REPL that answers nothing is worse than no REPL,
   * because the model keeps waiting instead of trying something else.
   */
  const root = workspace();
  const r = await replEval(root, 'while (true) {}', { timeoutMs: 1200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not finish/);
  assert.match(r.error, /state discarded/, 'and it must say the state is gone');

  // ⭐ And the next call works — a fresh session, not a dead one.
  const next = await replEval(root, '1 + 1');
  assert.equal(next.ok, true, next.error);
  assert.equal(next.value, '2');
  replReset(root);
});

// ── bounds and governance ──────────────────────────────────────────────────

test('a dry run evaluates nothing', async () => {
  const root = workspace();
  const r = await replEval(root, 'process.exit(1)', { dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /dry-run/);
});

test('oversized code is refused with the way out named', async () => {
  const root = workspace();
  const r = await replEval(root, 'x'.repeat(MAX_CODE_CHARS + 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /over the .* limit/);
  assert.match(r.error, /import it here instead/, 'the refusal must name what to do instead');
});

test('empty code is a sentence, not a crash', async () => {
  const root = workspace();
  const r = await replEval(root, '   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /code is required/);
});

test('reset clears the state and says so', async () => {
  const root = workspace();
  await replEval(root, 'const gone = 99');
  const reset = replReset(root);
  assert.equal(reset.ok, true);
  assert.equal(reset.reset, true);

  const after_ = await replEval(root, 'typeof gone');
  // ⚠️ `render` returns a string value RAW, so `typeof gone` is the four
  // characters u-n-d-e-f, not a quoted inspect form.
  assert.equal(after_.value, 'undefined', 'the binding must really be gone');
  assert.equal(after_.startedFresh, true);
  replReset(root);

  // ⚠️ Resetting nothing is a success, not an error.
  assert.equal(replReset(workspace()).ok, true);
});

test('two workspaces do not share state', async () => {
  const a = workspace();
  const b = workspace();
  await replEval(a, 'const mine = "a"');
  const inB = await replEval(b, 'typeof mine');
  assert.equal(inB.value, 'undefined', 'one session per workspace, or there are two truths about one state');
  replReset(a); replReset(b);
});

// ── the schemas and the wiring ─────────────────────────────────────────────

test('the tool description tells the model WHY this is not evaluate', async () => {
  const schemas = replToolSchemas();
  assert.deepEqual(schemas.map((s) => s.function.name), REPL_TOOL_NAMES);
  const d = schemas[0].function.description;
  assert.match(d, /REMEMBERS/, 'the distinguishing property must be the first thing said');
  assert.match(d, /await import/, 'and the highest-value use named concretely');
  // ⚠️ The one real trap: a stale module after editing a file.
  assert.match(schemas[1].function.description, /cached/);
});

test('repl is reachable from the registry and correctly gated', async () => {
  const { TOOL_SCHEMAS, toolNamesForRounds } = await import('../lib/tools.mjs');
  const declared = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
  for (const n of REPL_TOOL_NAMES) assert.ok(declared.has(n), `${n} is not in TOOL_SCHEMAS`);

  const offered = toolNamesForRounds(10, { allowRun: true, root: process.cwd() });
  for (const n of REPL_TOOL_NAMES) assert.ok(offered.includes(n), `${n} is never offered`);

  // ⚠️ It runs the user's JavaScript, so --no-run must withhold it.
  const noRun = toolNamesForRounds(10, { allowRun: false, root: process.cwd() });
  for (const n of REPL_TOOL_NAMES) assert.equal(noRun.includes(n), false, `${n} survived --no-run`);

  // ⚠️ And single-shot: there is no "next call" to see the state.
  const single = toolNamesForRounds(1, { allowRun: true, root: process.cwd() });
  for (const n of REPL_TOOL_NAMES) assert.equal(single.includes(n), false);
});

test('the dispatcher refuses a memory workspace with a reason', async () => {
  /**
   * ⚠️ THE FIRST VERSION OF THIS TEST ASSERTED `r.ok === false || r.ok === true`
   * — a check that cannot fail, which this package forbids outright. It also
   * started a REPL with a cwd of "(memory)", a directory that does not exist,
   * and left a child behind that hung the whole suite for ten minutes.
   *
   * The guard lives in `tools.mjs` (a memory workspace has no directory for a
   * process to run in), so that is what gets asserted — through the dispatcher
   * the model actually calls, without spawning anything.
   */
  const { executeToolCall } = await import('../lib/tools.mjs');
  const rec = await executeToolCall(
    { id: 'x', function: { name: 'repl', arguments: JSON.stringify({ code: '1 + 1' }) } },
    { root: '(memory)', dryRun: false },
  );
  assert.equal(rec.result.ok, false);
  assert.match(rec.result.error, /held in memory/);
  assert.equal(rec.mutated, false);
});

// ── ⚠️⚠️ THE HANG ──────────────────────────────────────────────────────────

test('⭐⭐ a dead session does not evict its successor — reset must still find the LIVE one', async () => {
  /**
   * ⚠️ THIS IS THE BUG THAT HUNG THE SUITE, and it is observable without any
   * timing games. `exit` arrives asynchronously, long after `replReset` deleted
   * the entry and a later `replEval` registered a REPLACEMENT under the same
   * root. An unguarded `sessions.delete(root)` in that late handler removes the
   * LIVE session, so the next reset reports "no REPL was running" — and the
   * child it should have released is never released by anyone.
   *
   * ⭐ Asserted on the RETURN VALUE, not on process exit. The unref in `start`
   * means a leaked child no longer holds the loop, so an exit-based test passes
   * either way and proves nothing. What still differs is whether the second
   * reset can see the session it is supposed to be throwing away.
   */
  const root = workspace();

  await replEval(root, 'const x = 1');
  const first = replReset(root);
  assert.equal(first.reset, true, 'the first reset must find the first session');

  const revived = await replEval(root, 'typeof x');
  assert.equal(revived.startedFresh, true, 'a reset session must come back as a NEW one');

  const second = replReset(root);
  assert.equal(
    second.reset, true,
    'the successor was evicted by the dead session\'s exit handler — nothing will ever release it',
  );
});

test('⭐⭐ after replStopAll the OWNING PROCESS can exit — a stopped REPL must not hold the loop', async () => {
  /**
   * ⚠️ THIS IS THE SECOND TIME THIS CLASS HAS HUNG THE SUITE TODAY. The test
   * above records the first ("left a child behind that hung the whole suite for
   * ten minutes") and fixed one CAUSE — a workspace with no directory. The
   * STRUCTURE was never fixed, so it came back: on 2026-08-12 the full run sat
   * frozen with every test passed, `repl.test.mjs` still resident and two live
   * `repl-driver` children. In isolation the same file finishes in 4.8s.
   *
   * Why it hangs: on Windows `killProcessTree` spawns `taskkill /T /F` and
   * returns IMMEDIATELY. `replStopAll()` clears the map and returns while the
   * child is still alive, still holding three pipes the parent opened. Node
   * keeps an event loop alive for those pipes, so a process with no work left
   * still cannot exit. Under load — precisely when the suite is slowest — the
   * reaper is slowest too, which is why it only bites in a full parallel run.
   *
   * ⭐ A flake that only appears under load is invisible to any test that runs
   * the assertion in-process, because the assertion passes and the HANG happens
   * afterwards, at exit. So the subject here is a whole process, and the thing
   * asserted is that it DIES.
   */
  const root = workspace();
  // ⚠️ The IMPORT SPECIFIER must stay a file:// URL — on Windows a bare `C:\…`
  // is ERR_UNSUPPORTED_ESM_URL_SCHEME, which fails the probe for the wrong reason.
  const lib = new URL('../lib/repl.mjs', import.meta.url).href;
  const probe = join(root, 'probe.mjs');
  writeFileSync(probe, [
    `import { replEval, replReset, replStopAll } from ${JSON.stringify(lib)};`,
    `const R = ${JSON.stringify(root)};`,
    /**
     * ⚠️ THE SEQUENCE MATTERS AND A SIMPLER ONE PROVES NOTHING. eval→stopAll
     * passed happily while the suite hung. The bug needed a session to be
     * REPLACED: the first child's async `exit` fires after a second session is
     * registered under the same root, and an unguarded delete evicts the LIVE
     * one — so the second child is never released and holds the loop forever.
     */
    `const a = await replEval(R, 'const x = 1');`,
    `if (!a.ok) { console.error('eval#1 failed: ' + a.error); process.exit(3); }`,
    `replReset(R);`,
    `const b = await replEval(R, 'typeof x');`,      // ← starts the SUCCESSOR
    `if (!b.ok) { console.error('eval#2 failed: ' + b.error); process.exit(4); }`,
    `replReset(R);`,                                  // ← must release the successor
    `replStopAll();`,
    // Nothing below this line. If the process is still alive, a handle is held.
  ].join('\n'));

  const child = spawn(process.execPath, [probe], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, hung: true }), 20_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, hung: false }); });
  });
  if (exited.hung) { try { child.kill('SIGKILL'); } catch { /* gone */ } }

  assert.equal(
    exited.hung, false,
    'the process was still alive 20s after replStopAll() — the REPL child is holding the event loop open, which is the suite hang',
  );
  // ⚠️ Without the stderr, a broken probe and a real regression look identical.
  assert.equal(exited.code, 0, `the probe itself must succeed, or this proves nothing. stderr: ${err.trim() || '(none)'}`);
});
