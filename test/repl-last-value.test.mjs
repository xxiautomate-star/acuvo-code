/**
 * ── ⭐⭐ SEVERAL STATEMENTS NOW HAND BACK THE LAST ONE'S VALUE ───────────────
 *
 * `repl.mjs` used to document: "One expression returns its value; several
 * statements run as a block" — so `const z = 5; z*2` answered `undefined` and
 * the model had to spend a WHOLE EXTRA ROUND asking for a value it had already
 * computed. Rounds are the unit of cost in this product; that is the most
 * expensive kind of "documented, not broken".
 *
 * ⚠️ THE RISK WAS REAL AND IT IS WHY THE MECHANISM MATTERS. The obvious
 * implementation — find the last statement, prefix it with `return` — is string
 * surgery on JavaScript and corrupts code the first time a `;` sits inside a
 * string literal. This uses V8's own completion value instead (the thing
 * `node -i` prints), which needs no parser at all.
 *
 * ⭐ SO THE TESTS THAT MATTER MOST ARE THE ONES PROVING NOTHING ELSE MOVED:
 * every shape that worked before must still give the IDENTICAL answer, and a
 * shape that cannot compile the new way must fall back having run NOTHING —
 * side effects exactly once, never twice.
 *
 * ⭐ $0.00, no key, no network: the subject is a `node` child process.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replEval, replReset, replStopAll, replToolSchemas } from '../lib/repl.mjs';

const made = [];
after(() => {
  replStopAll();
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-replval-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"r","version":"1.0.0","type":"module"}\n');
  writeFileSync(join(root, 'lib.mjs'), 'export const parse = (s) => s.toUpperCase();\n');
  return root;
}

// ── ⭐ THE ROUND THIS SAVES ────────────────────────────────────────────────

test('the reported case: `const z=5; z*2` answers 10, not undefined', async () => {
  const root = workspace();
  const r = await replEval(root, 'const z=5; z*2');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, '10', 'this is the whole point — the value came back in the SAME round');
  // ⚠️ And the state is still kept, which is the other half of the tool.
  assert.equal((await replEval(root, 'z + 1')).value, '6');
  replReset(root);
});

test('several statements across several lines, ending in an expression', async () => {
  const root = workspace();
  assert.equal((await replEval(root, 'const a=1\nconst b=2\na+b')).value, '3');
  /**
   * ⚠️ THREE statements, and the last one is the value. The middle statement
   * MUTATES — `sort()` in place — so this also pins that the earlier statements
   * really ran rather than being skipped on the way to evaluating the last.
   */
  assert.equal((await replEval(root, 'const list=[3,1,2]; list.sort(); list.join("-")')).value, '1-2-3');
  replReset(root);
});

test('⚠️ a semicolon inside a STRING does not become a statement boundary', async () => {
  /**
   * ⚠️⚠️ THE TEST THAT REJECTS THE PARSER-FREE-BUT-WRONG IMPLEMENTATION. Any
   * "split on the last semicolon and prefix return" version answers `b"` or
   * throws here. V8's completion value cannot get this wrong because it is not
   * splitting anything.
   */
  const root = workspace();
  assert.equal((await replEval(root, 'const s="a;b"; s.length')).value, '3');
  assert.equal((await replEval(root, 'const t="x; y"; t.split("; ").length')).value, '2');
  replReset(root);
});

test('a submission ending in a // comment works, instead of dying on "Unexpected end of input"', async () => {
  /**
   * ⚠️ A BUG FOUND WHILE MEASURING THIS, NOT A FEATURE. The old wrapper was
   * built on ONE line — `(async () => { globalThis.p = 2\n// trailing })()` —
   * so the closing brace landed inside the comment and the submission died with
   * a SyntaxError that had nothing to do with the user's code. Measured before
   * the change: THREW SyntaxError: Unexpected end of input.
   */
  const root = workspace();
  const r = await replEval(root, 'const p = 2\n// what p is for');
  assert.equal(r.ok, true, `a trailing comment must not be a syntax error: ${r.error}`);
  assert.equal(r.value, '2');

  /**
   * ⚠️ THE SECOND CASE IS THE ONE THAT COVERS THE *WRAPPER*. The first has a
   * newline, so it takes the completion-value path and would pass even if the
   * wrapper were still built on one line. This one is a single statement, so it
   * still goes through `(async () => { … })()` — and if that template is not
   * broken across lines, the closing `})()` lands inside the comment.
   */
  const single = await replEval(root, 'const p2 = 3 // why');
  assert.equal(single.ok, true, `the wrapper must also survive a trailing comment: ${single.error}`);
  assert.equal((await replEval(root, 'p2')).value, '3', 'and it really assigned');
  replReset(root);
});

// ── ⚠️ NOTHING ELSE MOVED ─────────────────────────────────────────────────

test('every shape that worked before gives the IDENTICAL answer', async () => {
  const root = workspace();
  const same = [
    ['2 + 2', '4'],                                 // one expression
    ['"a" + "b"', 'ab'],                            // one expression
    ['({ a: 1 })', '{ a: 1 }'],                     // an object literal, parenthesised
    ['{ a: 1 }', '{ a: 1 }'],                       // ⚠️ and unparenthesised — a BLOCK would read this as a label
    ['const q = 2', 'undefined'],                   // ⚠️ a lone declaration stays quiet, and stays cheap
    ['return 9', '9'],                              // ⚠️ illegal in a block — must fall back to the wrapper
  ];
  for (const [code, expected] of same) {
    const r = await replEval(root, code);
    assert.equal(r.ok, true, `${code} → ${r.error}`);
    assert.equal(r.value, expected, `${code} must still answer ${expected}`);
  }
  replReset(root);
});

test('await still works, and `return` is how you get its value — as the description says', async () => {
  const root = workspace();
  const m = await replEval(root, 'const mod = await import("./lib.mjs"); return mod.parse("hi")');
  assert.equal(m.ok, true, m.error);
  assert.equal(m.value, 'HI', 'the workspace module opened AND its value came back in one call');

  // ⚠️ A completion value does not exist inside a function body and top-level
  // await does not exist outside one, so without `return` this is `undefined`.
  // Pinned rather than wished away, because the tool description promises it.
  const without = await replEval(root, 'const n = await Promise.resolve(3); n+1');
  assert.equal(without.ok, true, without.error);
  assert.equal(without.value, 'undefined');
  replReset(root);
});

test('⚠️⚠️ a fallback runs the code ONCE — the compile check happens before anything executes', async () => {
  /**
   * ⚠️ THE ONE WAY THIS CHANGE COULD HAVE BEEN CATASTROPHIC: try the new form,
   * and on failure re-run the old form — with the side effects of the first
   * attempt already on disk. `return` is the common submission that cannot
   * compile as a block, so it is the probe. `new Script()` throws at COMPILE
   * time, before a byte of user code runs, so the counter must read 1.
   */
  const root = workspace();
  await replEval(root, 'globalThis.__hits = 0');
  const r = await replEval(root, 'globalThis.__hits++; return globalThis.__hits');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, '1', 'a doubled side effect would read 2 here');
  /**
   * ⚠️ `return` here, not a bare `globalThis.__hits`. A submission starting with
   * `globalThis.` is deliberately NOT treated as an expression — lifted
   * declarations are rewritten to `globalThis.x = …`, and returning their
   * assigned value is what would make `const q = 2` answer `2` instead of
   * `undefined`. That is a load-bearing wart, not one to fix in passing.
   */
  assert.equal((await replEval(root, 'return globalThis.__hits')).value, '1', 'and it is still 1 afterwards');

  /**
   * ⚠️⚠️ AND THE SHARPER CASE, which the `return` probe above CANNOT catch:
   * code that compiles as a block perfectly well and then throws HALFWAY. If the
   * fallback were ever widened from "did not compile" to "did not succeed", this
   * submission would increment the counter, blow up, get re-run, and increment
   * it again — a retry that silently doubles every side effect before the error.
   * The counter is the only witness; the error message would look identical.
   */
  await replEval(root, 'globalThis.__hits = 0');
  const boom = await replEval(root, 'globalThis.__hits++; nope_undefined_fn()');
  assert.equal(boom.ok, false, 'it must surface the error rather than swallowing it');
  assert.match(boom.error, /nope_undefined_fn/);
  assert.equal((await replEval(root, 'return globalThis.__hits')).value, '1', 'the side effect before the throw happened ONCE');
  replReset(root);
});

test('a destructure can be submitted twice — the block scope is what makes that true', async () => {
  /**
   * ⚠️⚠️ THE MEASUREMENT THAT CHOSE THE IMPLEMENTATION. Running the submission
   * as a BARE script also yields the completion value, and it makes script-level
   * `const` a GLOBAL LEXICAL binding: the second identical submission dies with
   * "Identifier 'q' has already been declared". Measured, both ways:
   *   bare  1st=3  2nd=THREW      block 1st=3  2nd=3
   * A stateful tool poisoned by its own history is worse than one that answers
   * undefined, so the brace is load-bearing.
   */
  const root = workspace();
  const first = await replEval(root, 'const {q,w} = {q:1,w:2}; q+w');
  const second = await replEval(root, 'const {q,w} = {q:1,w:2}; q+w');
  assert.equal(first.value, '3');
  assert.equal(second.ok, true, `the second identical submission must not explode: ${second.error}`);
  assert.equal(second.value, '3');
  replReset(root);
});

test('an error still keeps its stack, and still does not kill the session', async () => {
  const root = workspace();
  const bad = await replEval(root, 'const x = 1; x.nope.deeper');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /TypeError/);
  assert.equal((await replEval(root, 'const ok = 1; ok + 1')).value, '2', 'the session survived');
  replReset(root);
});

test('the description tells the model it gets the last value, and names the await exception', () => {
  const repl = replToolSchemas().find((s) => s.function.name === 'repl').function;
  // ⚠️ A behaviour the model is not told about costs exactly the round this
  // change was made to save.
  assert.match(repl.description, /const z = 5; z\*2/, 'show it, do not describe it');
  assert.match(repl.description, /await/, 'and name the one case where it does not hold');
  assert.match(repl.parameters.properties.code.description, /await/, 'on the parameter too — models read one or the other');
});
