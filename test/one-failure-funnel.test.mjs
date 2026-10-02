/**
 * ── ⭐⭐⭐ "THE SINGLE FUNNEL EVERY FAILURE PASSES THROUGH" — IT WAS FOUR ──────
 *
 * `turn.mjs` fixed `wait_for_output`'s timeout on 2026-09-01 and wrote the
 * lesson down: *"the lesson is not 'add a field to that verb' — it is that this
 * line is the single funnel every failure passes through, and it was reading
 * exactly one key."* The diagnosis was right and the word SINGLE was wrong. An
 * audit the same day found the same funnel written out four times:
 *
 *   turn.mjs   describeToolResult    the MODEL's line       error, reason   ✅
 *   turn.mjs   renderToolRecord      the HUMAN's line       error only      ✖
 *   read-window.mjs formatWindow…    read_lines/read_around error only      ✖
 *   mcp-server.mjs  callGeneral      the MCP surface        error only      ✖
 *                                    …and asked `ok === false`             ✖✖
 *
 * ⚠️⚠️ THE MCP ONE IS THE `review_code` BUG INVERTED. `review_code` returned no
 * `ok` field, so the CLI reported every SUCCESS as a failure. Asked
 * `ok === false`, the same result takes the SUCCESS branch — a FAILURE reported
 * as a success, which is the direction that gets built on.
 *
 * ⭐ THIS FILE PINS THE PROPERTY, NOT THE CALL. Every surface is driven with
 * the SAME fixtures and must agree. A fifth surface written next month fails
 * this file the moment somebody adds it to `SURFACES`, and the four that exist
 * cannot drift apart again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { failureReason, toolFailed } from '../lib/model-json.mjs';
import { toolResultText, renderEvent } from '../lib/turn.mjs';
import { formatWindowForModel } from '../lib/read-window.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE FUNNEL ITSELF
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ `error` wins, because it is the sentence a verb wrote for a human', () => {
  assert.equal(failureReason({ error: 'the disk is full', reason: 'enospc' }), 'the disk is full');
});

test('⭐ `reason` is used when nothing better exists, and it carries the wait', () => {
  assert.equal(failureReason({ reason: 'timeout', waitedMs: 30_000 }), 'timeout after 30s');
  assert.equal(failureReason({ reason: 'timeout' }), 'timeout');
});

test('⭐ `message` and `why` are read — the two spellings already live in lib/', () => {
  // budget.mjs and harness-run.mjs write `message`; lease.mjs and websearch.mjs write `why`.
  assert.equal(failureReason({ message: 'the budget is spent' }), 'the budget is spent');
  assert.equal(failureReason({ why: 'another terminal holds it' }), 'another terminal holds it');
  // …and they lose to the two that came first.
  assert.equal(failureReason({ error: 'e', message: 'm', why: 'w' }), 'e');
  assert.equal(failureReason({ reason: 'r', message: 'm' }), 'r');
});

test('⚠️ it never returns an empty string — silence reads as "nothing went wrong"', () => {
  for (const r of [null, undefined, {}, { error: '' }, { error: '   ' }, { reason: '' }]) {
    assert.equal(failureReason(r), 'unknown error', `an empty explanation escaped: ${JSON.stringify(r)}`);
  }
});

test('⚠️⚠️ `toolFailed` is `!== true`, so a MISSING ok is a failure — the review_code shape', () => {
  assert.equal(toolFailed({ findings: [] }), true, 'a result with no `ok` was read as a success');
  for (const ok of [undefined, null, false, 0, '', 'true', 1]) {
    assert.equal(toolFailed({ ok }), true, `ok: ${JSON.stringify(ok)} was read as a success`);
  }
  assert.equal(toolFailed({ ok: true }), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. EVERY SURFACE AGREES — driven with one fixture set
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE FIXTURES ARE REAL SHAPES, NOT INVENTED ONES. The first is verbatim
 * from `turn.mjs`'s own measurement of `wait_for_output`; the second is the
 * `review_code` shape that had no `ok` at all.
 */
const FIXTURES = [
  { label: 'a wait_for_output timeout', result: { ok: false, reason: 'timeout', waitedMs: 30_000, text: 'listening on 3000' }, expect: /timeout after 30s/ },
  { label: 'an ordinary error', result: { ok: false, error: 'no such file: a.js' }, expect: /no such file: a\.js/ },
  { label: 'a budget refusal under `message`', result: { ok: false, message: 'the budget is spent' }, expect: /the budget is spent/ },
  { label: 'a failure that explains nothing', result: { ok: false }, expect: /unknown error/ },
];

const SURFACES = [
  {
    name: "the MODEL's line (turn.mjs describeToolResult)",
    render: (r) => toolResultText({ id: 'c1', name: 'wait_for_output', args: {}, result: r }),
  },
  {
    /**
     * ⭐⭐ THE ONE THAT WAS BROKEN. A person watching the terminal saw
     * `✖ wait_for_output: unknown error` for the commonest outcome of that verb,
     * for as long as the "fixed" model line has existed.
     */
    name: "the HUMAN's line (turn.mjs renderToolRecord)",
    render: (r) => renderEvent({ type: 'tool', round: 1, record: { name: 'wait_for_output', args: {}, result: r } }).join('\n'),
  },
  {
    name: 'the read window (read-window.mjs formatWindowForModel)',
    render: (r) => formatWindowForModel(r),
  },
];

for (const surface of SURFACES) {
  test(`⭐⭐ ${surface.name} explains the failure the same way`, () => {
    for (const f of FIXTURES) {
      const out = surface.render(f.result);
      assert.match(out, f.expect, `${f.label} rendered as: ${out}`);
    }
  });

  test(`⚠️ ${surface.name} treats a MISSING \`ok\` as a failure`, () => {
    const out = surface.render({ findings: ['a'], summary: 'looks fine' });
    assert.doesNotMatch(out, /looks fine/, 'a result with no `ok` was rendered as a success');
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE MCP SURFACE — the inverted bug
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ READ FROM THE SOURCE, and stated plainly why. `callGeneral` is closed over
 * a live executor, a secret and a spend journal built inside `createMcpServer`;
 * reaching it behaviourally means standing up the whole server. The property
 * that was wrong is a single operator, and it is visible without doing that.
 *
 * ⚠️ THE PATTERN IS ANCHORED ON `callGeneral`, not on the file. A bare search
 * for `ok === false` would match a comment, a test fixture, or an unrelated
 * branch — the way `builder-cli-verb-parity`'s guard once matched a nested
 * rescue list instead of the seam it was written for and let the seam be
 * deleted with every test green.
 */
test('⚠️⚠️ the MCP surface asks `ok !== true`, never `ok === false`', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/mcp-server.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('async function callGeneral');
  assert.ok(at > 0, 'callGeneral moved — this guard is now checking nothing');
  const body = src.slice(at, at + 3_000).replace(/\/\*[\s\S]*?\*\//g, '');

  assert.doesNotMatch(
    body, /result\.ok === false/,
    'callGeneral treats a result with a MISSING `ok` as a SUCCESS — that is the review_code '
    + 'defect inverted, and a failure rendered as a success is the direction that gets built on',
  );
  assert.match(body, /toolFailed\(result\)/, 'callGeneral no longer routes through the shared funnel');
  assert.match(body, /failureReason\(result\)/, 'callGeneral reads one key again — a `reason` failure is `unknown error` here');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. AND THERE IS ONLY ONE OF THEM
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⭐ THE STRUCTURAL GUARD. The four surfaces drifted because each one spelled
 * the question out by hand. This fails the moment a fifth one does.
 */
test('⭐⭐⭐ no module hand-rolls the funnel — `?? \'unknown error\'` lives in ONE file', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../lib/', import.meta.url);
  const offenders = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.mjs'))) {
    if (f === 'model-json.mjs') continue; // the one legitimate home
    const src = (await readFile(new URL(f, dir), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /**
     * ⚠️ THE PATTERN IS THE DEFECT, NOT THE STRING. The class is "reads
     * `.error` and calls that the whole explanation" — which is what left
     * `reason`, `message` and `why` unread on four surfaces. A bare search for
     * the literal `'unknown error'` also matches `repl-driver.mjs:231`
     * (`String(e?.stack ?? e ?? 'unknown error')`), which is an EXCEPTION
     * fallback and reads no result key at all. Flagging it would be a guard
     * failing correct work, and the fix would be to make an exception list —
     * which is how a guard stops meaning anything.
     */
    if (/\??\.error\s*\?\?\s*'unknown error'/.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders, [],
    `${offenders.join(', ')} spell the failure funnel out by hand. Four copies of this question `
    + 'drifted apart once already — import `failureReason` from model-json.mjs instead.',
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. `--no-run` HOLDS AT THE DISPATCHER, NOT ONLY AT THE OFFER
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ── ⚠️⚠️⚠️ `evaluate` RAN THE MODEL'S CODE UNDER THE FLAG THAT SAYS IT NEVER DOES
 *
 * `tools.mjs` withheld `evaluate` and the three `gh_*` verbs from the OFFER when
 * `allowRun` is false, and that was the only gate. The offer is not a gate —
 * this file's own comment on `repl` says so: *"a caller that widens the tool
 * list, replays a session, or hands the name in directly reaches this switch
 * without ever consulting the offer."* And the comment above `playtest` cites
 * `evaluate` BY NAME as the precedent for double-gating, crediting it with a
 * guard it did not have below the offer.
 *
 * ⭐ SO THIS DRIVES THE DISPATCHER DIRECTLY, which is the only way to prove it —
 * asking the offer proves the half that already worked.
 */
test('⚠️⚠️ --no-run is enforced at the DISPATCHER for every verb that starts a process', async () => {
  const { executeToolCall } = await import('../lib/tools.mjs');
  const { createLocalExecutor } = await import('../lib/workspace.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'acuvo-norun-'));
  const executor = createLocalExecutor(root);

  /**
   * ⚠️ THE `evaluate` SNIPPET IS THE PROOF, NOT THE ASSERTION. If the guard is
   * absent this writes a file to the temp directory, so the test can tell
   * "refused" from "ran and returned something that looks like a refusal".
   */
  const marker = join(root, 'IT-RAN.txt');
  const cases = [
    ['evaluate', { source: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');` }],
    ['gh_issue', { action: 'list' }],
    ['gh_pr', { action: 'list' }],
    ['gh_run', { action: 'list' }],
    ['run_command', { command: 'node -e "1"' }],
  ];

  for (const [name, args] of cases) {
    const rec = await executeToolCall(
      { id: 'c1', function: { name, arguments: JSON.stringify(args) } },
      executor,
      { allowRun: false, commandTimeoutMs: 20_000, round: { roundIndex: 1, maxRounds: 2, task: 't' } },
    );
    assert.equal(rec.result.ok, false, `${name} executed under --no-run`);
    assert.match(rec.result.error, /--no-run/, `${name} refused for some other reason: ${rec.result.error}`);
  }

  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(marker), false,
    'evaluate actually executed the model\'s JavaScript under --no-run — the flag documented as '
    + '"never execute anything" was a lie by a side door');
});
