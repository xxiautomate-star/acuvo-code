/**
 * ── ⭐⭐⭐ SWE-agent's THIRD ACI FINDING, FINISHED AGAINST OUR OWN TRANSCRIPTS ─
 *
 * The paper's claim is that terse errors which NAME THE NEXT MOVE move solve rate
 * as much as the windowed viewer does. Two files already apply it —
 * `aci-read-file-windows-and-names-the-argument.test.mjs` (the viewer) and
 * `aci-terse-errors-and-edit-time-parse.test.mjs` (the edit gate). What neither
 * of them did was ASK THE TRANSCRIPTS WHICH REFUSALS ACTUALLY FIRE.
 *
 * ── ⭐ THE MEASUREMENT THAT CHOSE EVERY LINE BELOW ──────────────────────────
 *
 * 2026-08-26: every `"error"` string extracted from all 3,859 stored transcript
 * files in this package (`.acuvo/sessions`, `.acuvo/audit`, `bench/`) and tallied.
 * 372 refusals. The head of the distribution:
 *
 *     22  absolute path                                   ← 16 DISTINCT tasks
 *      8  …is N bytes, over the 200000-byte read limit
 *      6  the log tools are not wired to a log source     (already fixed)
 *      6  git is not installed, or not on PATH            (git.mjs — not this lane)
 *      5  session not created                             ← NOT OURS, see below
 *      4  tool arguments were not valid JSON: Unterminated string…
 *      3  this workspace is not a git repository          (git.mjs — not this lane)
 *
 * ⚠️ ONE ROW OF THAT TABLE IS NOISE AND IS LABELLED RATHER THAN QUIETLY DROPPED:
 * `session not created` is Selenium's, scraped out of a bench VERIFIER's stdout,
 * not a refusal this package ever produced. A tally that silently launders
 * somebody else's error into our own top five is the kind of number that gets
 * quoted later.
 *
 * ⚠️ `absolute path` IS FIRST BY 3×, and it fired on `read_file`, `write_file`
 * AND `list_dir`. Its POSIX branch had already been given a next move; its
 * siblings — a Windows drive letter, `..`, a URL, the root itself — had not, and
 * they are the same mistake spelled differently.
 *
 * ⚠️⚠️ AND THE JSON ONE IS FIRST BY ROUNDS BURNED. All four hits are ONE task,
 * `bench/terminal-bench/results/deep100/break-filter-js-from-html…`, going in
 * circles. From its `acuvo-stderr.log`, verbatim:
 *
 *   ✖ write_file: …Unterminated string in JSON at position 25744
 *   ── round 3/100 ── "That was a mess. Let me write a clean, focused test
 *                      script instead."
 *   ✖ write_file: …Unterminated string in JSON at position 36459
 *   ── round 4/100 ── "I'm overcomplicating this."
 *   ✖ write_file: …Unterminated string in JSON at position 36633
 *   ── round 5/100 ── "I keep generating huge redundant content."
 *   ✖ write_file: …Unterminated string in JSON at position 36793
 *   ↻ going in circles (no-progress) — one hint sent, budget untouched.
 *
 * ⭐ THE MODEL BLAMED ITS OWN WRITING THREE TIMES. The real fact is arithmetic —
 * the reply hit the output limit and the argument blob was cut off mid-string —
 * and it is a fact only the runner can see. It shortened the content three times
 * and was still cut at ~36k, because 36k is where the ceiling is. A parser
 * position with no interpretation is precisely the refusal a model cannot act on.
 *
 * ⚠️ EVERY ASSERTION HERE IS OFFLINE AND FREE: no model call, no network, no
 * spawn. And the last test pins the thing that makes all of it affordable — none
 * of these sentences reaches a tool schema, so they cost nothing on the rounds
 * where they do not fire.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLocalExecutor,
  normalizeRelativePath,
  RELATIVE_PATH_NEXT_MOVE,
} from '../lib/workspace.mjs';
import { readWindow } from '../lib/read-window.mjs';
import { executeToolCall, parseToolArguments, jsonArgumentNextMove, TOOL_SCHEMAS } from '../lib/tools.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'acuvo-aci3-'));
}

/** A tool call whose `arguments` string is passed through UNTOUCHED — the point. */
const rawCall = (name, argumentsString) => ({ id: 't', function: { name, arguments: argumentsString } });

/* ══════════════════════════════════════════════════════════════════════════
 * (A) THE CUT-OFF ARGUMENT BLOB — the measured four-round failure
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐⭐ the bench failure, reproduced: a write_file blob cut off mid-string is TOLD it was cut off', async () => {
  const root = scratch();
  try {
    /**
     * The shape the bench task produced: a large `content` string that simply
     * stops. Built to ~36k so the reproduction is the real size, not a toy.
     */
    const body = 'const payloads = [\n' + '  "<svg><a><animate attributeName=href values=javascript:alert(1)>",\n'.repeat(500);
    const truncated = `{"path":"probe.js","content":"${body.replace(/\n/g, '\\n').replace(/"/g, '\\"')}`;
    assert.ok(truncated.length > 30_000, `the reproduction must be realistically large, got ${truncated.length}`);

    const out = await executeToolCall(rawCall('write_file', truncated), createLocalExecutor(root), { allowRun: false });

    assert.equal(out.result.ok, false);
    // The parser fact is kept — it is genuinely useful when the blob was mistyped.
    assert.match(out.result.error, /not valid JSON/);
    // ⭐ And the interpretation the model could not deduce is now stated.
    assert.match(out.result.error, /cut off by the reply limit/);
    assert.match(out.result.error, /same place/);
    // ⭐ …together with the move that actually works: write less, then extend.
    assert.match(out.result.error, /edit_file/);

    // ⚠️ Nothing landed. A refusal that half-wrote a file would be worse than the bug.
    assert.equal(existsSync(join(root, 'probe.js')), false);

    // ⚠️ And it must NOT tell the model to fix its escaping — that was the wrong
    // diagnosis, and a confident wrong diagnosis costs the same round the bare
    // refusal did.
    assert.equal(/Escape them/.test(out.result.error), false, out.result.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all three V8 truncation shapes classify as CUT OFF, and none of them guesses', () => {
  /**
   * ⚠️ THE MESSAGES ARE NOT HARD-CODED — they are produced by this node's own
   * `JSON.parse`, so a V8 wording change fails this test instead of silently
   * turning the classification into a coin flip.
   */
  const cutOff = [
    '{"path":"a.js","content":"line one and it just stops',   // Unterminated string
    '{"a":1,"b":',                                            // Unexpected end of JSON input
    '{"path":"a.js","content":"ok"',                          // Expected ',' or '}'
  ];
  for (const raw of cutOff) {
    let message = '';
    try { JSON.parse(raw); assert.fail(`${raw} parsed`); } catch (err) { message = err.message; }
    const advice = jsonArgumentNextMove(message, raw);
    assert.match(advice, /cut off by the reply limit/, `${message} → ${advice}`);
    assert.match(advice, /edit_file/, `${message} → ${advice}`);
    // The length is stated, because the length is the fact that explains it.
    assert.ok(advice.includes(String(raw.length)), `${message} → ${advice}`);
  }
});

test('⚠️ a syntax error in the MIDDLE is not called truncation — different cause, different fix', () => {
  /**
   * ⚠️ TWO FIXTURES, BECAUSE V8 REPORTS MID-BLOB ERRORS TWO WAYS — probed
   * 2026-08-26. One carries a position ("Expected ',' or '}' … at position 13");
   * the other quotes a snippet and carries NO position at all ("Unexpected token
   * ',', …\"extra\":, … is not valid JSON"). A classifier that assumed a position
   * was always present would read the second as a cut-off blob and hand the model
   * the wrong instruction, so both shapes are pinned.
   */
  const fixtures = [
    '{"a":1,"b":2 "c":3, "d":"a fairly long tail so the position is well short of the end"}',
    '{"path":"a.js", "content":"fine", "extra":, "more":"tail that keeps going for a while"}',
  ];
  let sawPositioned = false;
  let sawSnippet = false;
  for (const raw of fixtures) {
    let message = '';
    try { JSON.parse(raw); assert.fail(`${raw} parsed`); } catch (err) { message = err.message; }
    const at = /position (\d+)/.exec(message);
    if (at) {
      sawPositioned = true;
      assert.ok(Number(at[1]) < raw.length - 1, `this fixture must fail well before the end: ${message}`);
    } else {
      sawSnippet = true;
    }

    const advice = jsonArgumentNextMove(message, raw);
    assert.equal(/cut off/.test(advice), false, `${message} → ${advice}`);
    assert.match(advice, /single JSON object/);
    assert.match(advice, /nothing ran/i);
  }
  assert.ok(sawPositioned && sawSnippet, 'both V8 mid-blob shapes must be exercised');
});

test('⚠️ a non-string blob is never diagnosed as truncation — length 0 would make every position look terminal', () => {
  const advice = jsonArgumentNextMove('Expected \',\' or \'}\' after property value in JSON at position 13', undefined);
  assert.equal(/cut off/.test(advice), false, advice);
  assert.match(advice, /single JSON object/);
});

test('a raw newline inside a string is named as an ESCAPING rule, not described as a parse failure', () => {
  const raw = '{"path":"a.js","content":"first\nsecond"}';
  let message = '';
  try { JSON.parse(raw); assert.fail('parsed'); } catch (err) { message = err.message; }
  assert.match(message, /control character/i);

  const advice = jsonArgumentNextMove(message, raw);
  assert.match(advice, /Escape them/);
  assert.ok(advice.includes('\\n'), advice);
  assert.equal(/cut off/.test(advice), false, advice);
});

test('the non-object shapes say what shape to send instead', () => {
  const array = parseToolArguments('[1,2]');
  assert.equal(array.ok, false);
  assert.match(array.error, /must be a JSON object/);
  assert.match(array.error, /an array/);
  assert.match(array.error, /argument names as the keys/);

  const scalar = parseToolArguments('42');
  assert.equal(scalar.ok, false);
  assert.match(scalar.error, /you sent 42/);

  const wrongType = parseToolArguments(7);
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.error, /one JSON object/);

  // ⚠️ And the happy paths are untouched: an object and an empty blob still pass.
  assert.deepEqual(parseToolArguments('{"path":"a.js"}'), { ok: true, args: { path: 'a.js' } });
  assert.deepEqual(parseToolArguments(''), { ok: true, args: {} });
  assert.deepEqual(parseToolArguments({ path: 'a.js' }), { ok: true, args: { path: 'a.js' } });
});

/* ══════════════════════════════════════════════════════════════════════════
 * (B) SUGGESTED CALLS MUST BE PASTEABLE — the shape that hid a two-month bug
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the read_file refusal suggests LITERAL JSON, and this suite pastes it and runs it', async () => {
  const root = scratch();
  try {
    const lines = [];
    for (let i = 1; i <= 600; i += 1) lines.push(`const v${i} = ${i}; // line ${String(i).padStart(4, '0')}`);
    writeFileSync(join(root, 'mid.js'), `${lines.join('\n')}\n`);

    const out = await executeToolCall(
      rawCall('read_file', JSON.stringify({ path: 'mid.js', view_range: [300, 320] })),
      createLocalExecutor(root),
      { allowRun: false },
    );
    assert.equal(out.result.ok, false);
    assert.match(out.result.error, /does not accept "view_range"/);

    /**
     * ⚠️⚠️ THE WHOLE POINT. The two-month argument-name bug survived because the
     * advice was a placeholder SHAPE — `{"path","start","end"}` — which nobody
     * could paste into a probe. So the suite lifts the suggested object straight
     * out of the sentence, parses it, and EXECUTES it.
     */
    const suggested = /read_around (\{.*?\})/.exec(out.result.error);
    assert.ok(suggested, `no pasteable read_around call in: ${out.result.error}`);
    const args = JSON.parse(suggested[1]);
    assert.equal(args.path, 'mid.js', 'the suggestion must name the file actually asked for');

    const executed = readWindow(root, args);
    assert.equal(executed.ok, true, `the advice does not run: ${executed.error}`);
    assert.equal(executed.tool, 'read_around');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * (C) THE #1 MEASURED REFUSAL AND ITS SIBLINGS
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐⭐ every spelling of "that path is not relative" now names the next move', () => {
  const cases = [
    ['/app/eigen.py', /list_dir/],            // 22 hits across 16 tasks — the measured one
    ['C:/app/eigen.py', /list_dir/],          // the same mistake, Windows spelling
    ['C:\\app\\eigen.py', /list_dir/],
    ['../outside/x.py', /list_dir/],          // the containment refusal
    ['.', /list_dir/],                        // asking a file tool for the root
    ['https://example.com/a.js', /fetch_url/], // a different mistake, a different tool
  ];
  for (const [path, wants] of cases) {
    const r = normalizeRelativePath(path);
    assert.equal(r.ok, false, `${path} should be refused`);
    assert.match(r.reason, wants, `${path} → ${r.reason}`);
    // ⚠️ Terse still means terse: a refusal nobody reads is no better than a bare one.
    assert.ok(r.reason.length < 260, `${path} refusal is ${r.reason.length} chars: ${r.reason}`);
  }
});

test('⚠️ the four relative-path refusals share ONE constant, so they cannot drift apart', () => {
  for (const path of ['/app/eigen.py', 'C:/app/eigen.py', '../outside/x.py']) {
    const r = normalizeRelativePath(path);
    assert.equal(r.ok, false);
    assert.ok(
      r.reason.endsWith(RELATIVE_PATH_NEXT_MOVE),
      `${path} does not carry the shared clause: ${r.reason}`,
    );
  }
  /**
   * ⚠️ AND THE REASON STILL LEADS WITH THE CAUSE. Four suites match these by
   * their head (`/escapes the workspace/` in lsp, mcp-server-surface, python-reach,
   * subagent-write); the clause is a SUFFIX and must stay one.
   */
  assert.match(normalizeRelativePath('../x').reason, /^path escapes the workspace with "\.\."/);
  assert.match(normalizeRelativePath('/x').reason, /^absolute path/);
});

test('⭐ the advice in the root refusal is a call that works', () => {
  const root = scratch();
  try {
    writeFileSync(join(root, 'there.txt'), 'hello\n');
    const refusal = normalizeRelativePath('.');
    assert.equal(refusal.ok, false);

    const suggested = /list_dir (\{.*?\})/.exec(refusal.reason);
    assert.ok(suggested, `no pasteable list_dir call in: ${refusal.reason}`);
    const listed = createLocalExecutor(root).listDir(JSON.parse(suggested[1]).path);
    assert.equal(listed.ok, true, `the advice does not run: ${listed.error}`);
    assert.ok(listed.entries.some((e) => e.name === 'there.txt'), JSON.stringify(listed.entries));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ a URL is NOT told to re-spell itself as a relative path — that would send it hunting', () => {
  const r = normalizeRelativePath('https://example.com/a.js');
  assert.equal(r.ok, false);
  assert.equal(r.reason.includes(RELATIVE_PATH_NEXT_MOVE), false, r.reason);
  assert.match(r.reason, /^URL, not a path/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * (D) THE PRICE — every byte of a schema rides EVERY round
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ none of this bought a single byte of tool schema', () => {
  const wire = JSON.stringify(TOOL_SCHEMAS);
  for (const sentence of [
    'cut off by the reply limit',
    'Escape them',
    'argument names as the keys',
    RELATIVE_PATH_NEXT_MOVE,
    'fetch_url reads a web address',
  ]) {
    assert.equal(wire.includes(sentence), false, `"${sentence}" leaked into the schemas the model reads every round`);
  }

  // `read_file` still declares exactly one argument, as the windowed branch requires.
  const readFile = TOOL_SCHEMAS.find((t) => t.function.name === 'read_file');
  assert.deepEqual(Object.keys(readFile.function.parameters.properties), ['path']);
});
