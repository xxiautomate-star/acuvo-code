/**
 * ── ⚠️⚠️⭐ 24 ROUNDS, 1.38M TOKENS, $0.025, AND NO REPORT AT ALL ────────────
 *
 * MEASURED 2026-09-21, one real run of this CLI. It spent every round, died in
 * the middle of a tool call on the round cap, and wrote nothing. The last thing
 * the model had said was a sentence about what it was ABOUT to do next.
 *
 * ⭐ THE DAMAGE WAS NOT THE WASTED ROUNDS — IT WAS THAT THE USER PAID AND GOT
 * NOTHING BACK. `roundCapWarning` already told the reader to discount whatever
 * was on screen; that is honest, and it is not a deliverable.
 *
 * So the LAST round is held back and spent on a text-only turn. What is pinned
 * here is the set of things that must all be true at once, because any one of
 * them failing rebuilds the defect:
 *
 *   1. the run comes back with a report, not with a half-finished tool call;
 *   2. the reserved round is offered NO TOOLS — it cannot start a long command;
 *   3. it cannot loop: exactly one reserved round, and the run ends on it;
 *   4. it costs no extra money — the round comes out of `maxRounds`;
 *   5. the run is still labelled `round-cap`, so the cap warning keeps firing
 *      and the exit code still says the job was not finished;
 *   6. a SHORT run is untouched — a reserve that costs a third of a 3-round
 *      budget buys a report by deleting the work it would report on.
 *
 * ── ⚠️ MUTATION-PROVEN (each restored, `git diff` clean afterwards) ─────────
 *   M1  `toolsThisRound` forced back to `tools`
 *       → "the reserved round is offered no tools" RED.
 *   M2  the `if (isSynthesisRound)` exit deleted from the reply handling
 *       → "it cannot loop / the run ends on it" RED (`no-tool-calls`, and the
 *         cap warning stops firing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSession, roundCapWarning, MIN_ROUNDS_FOR_SYNTHESIS, SYNTHESIS_INSTRUCTION,
} from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-synth-'));
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The model from the measured run: it never stops reaching for a tool, so the
 * counter is the only thing that can end the session. Every call it is given
 * is recorded, so the test can assert on what it was OFFERED, not on what the
 * prompt asked it to do.
 */
function neverStops() {
  const seen = [];
  const impl = async ({ messages, tools }) => {
    seen.push({ tools: (tools ?? []).map((t) => t?.function?.name ?? t?.name), messages: messages.slice() });
    return {
      ok: true,
      content: (tools ?? []).length === 0
        ? 'FINDINGS: index.js exports x. Nothing was changed. Next step: read the tests.'
        : 'Still working on it — let me read one more file.',
      toolCalls: (tools ?? []).length === 0
        ? []
        : [{ id: `c${seen.length}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'index.js' }) } }],
      finishReason: (tools ?? []).length === 0 ? 'stop' : 'tool_calls',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00001 },
      model: 'stub/model',
    };
  };
  impl.seen = seen;
  return impl;
}

const ROUNDS = 6;

async function cappedRun(t, over = {}) {
  const model = neverStops();
  const outcome = await runSession({
    task: 'analyse this repository',
    executor: createLocalExecutor(workspace(t)),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: ROUNDS,
    allowRun: false,
    callModelImpl: model,
    ...over,
  });
  return { outcome, model };
}

test('⭐⭐⭐ THE MEASURED DEFECT: a run that spends every round still hands back a report', async (t) => {
  const { outcome } = await cappedRun(t);

  assert.equal(outcome.stoppedBecause, 'round-cap', 'not the run this test is about');
  assert.equal(outcome.synthesised, true, 'the reserved round never ran');
  assert.match(
    String(outcome.note),
    /FINDINGS/,
    `the run ended on a half-finished tool call again, with nothing written:\n${outcome.note}`,
  );
});

test('⚠️⚠️ the reserved round is offered NO TOOLS — it cannot start a long tool call', async (t) => {
  const { model } = await cappedRun(t);

  const last = model.seen[model.seen.length - 1];
  assert.deepEqual(last.tools, [], 'the reserved round was handed the whole tool array');
  assert.ok(
    model.seen.slice(0, -1).every((c) => c.tools.length > 0),
    'a WORKING round lost its tools — the reserve is one round, not a mode',
  );
  // And it is told why, in the conversation, rather than left to guess.
  assert.equal(last.messages[last.messages.length - 1].content, SYNTHESIS_INSTRUCTION);
});

test('⚠️⚠️ it cannot loop, and it costs no extra money', async (t) => {
  const { outcome, model } = await cappedRun(t);

  assert.equal(model.seen.length, ROUNDS, `${model.seen.length} model calls for a ${ROUNDS}-round budget`);
  assert.equal(outcome.roundsUsed, ROUNDS);
  assert.equal(
    outcome.rounds.filter((r) => r.synthesis === true).length, 1,
    'exactly one reserved round, and the run ends on it',
  );
  assert.equal(outcome.rounds[outcome.rounds.length - 1].synthesis, true, 'it was not the LAST round');
  // Nothing was executed on it, whatever the model tried.
  assert.deepEqual(outcome.rounds[outcome.rounds.length - 1].executed, []);
});

test('⚠️ the run is still a CAPPED run — the report does not relabel it as a finish', async (t) => {
  const { outcome } = await cappedRun(t);

  assert.equal(outcome.stoppedBecause, 'round-cap');
  const warning = roundCapWarning(outcome, 'acuvo --continue').join('\n');
  assert.match(warning, /RAN OUT OF ROUNDS/, 'the cap warning stopped firing');

  /**
   * ⚠️ AND THE TWO SENTENCES THAT CONTRADICT EACH OTHER: exactly one may be
   * printed. Telling a reader to discount a real report costs as much as
   * having no report.
   */
  assert.match(warning, /report of what was FOUND/);
  assert.ok(!/ABOUT to do/.test(warning), 'it told the reader to discount the report it had just written');

  // A capped run with no reserve keeps the old sentence, unchanged.
  const old = roundCapWarning({ ...outcome, synthesised: false }, null).join('\n');
  assert.match(old, /ABOUT to do/);
  assert.ok(!/report of what was FOUND/.test(old));
});

test('⭐ a SHORT run is untouched — a reserve that costs a third of the budget is not a reserve', async (t) => {
  const short = MIN_ROUNDS_FOR_SYNTHESIS - 1;
  const { outcome, model } = await cappedRun(t, { maxRounds: short });

  assert.equal(outcome.stoppedBecause, 'round-cap');
  assert.equal(outcome.synthesised, false, `a ${short}-round run gave up a round it could not spare`);
  assert.ok(model.seen.every((c) => c.tools.length > 0), 'a short run lost a working round');
});

test('⚠️ and the caller can say no — the default is the module\'s constant, not a hard-coded rule', async (t) => {
  const { outcome, model } = await cappedRun(t, { synthesiseOnCap: false });

  assert.equal(outcome.stoppedBecause, 'round-cap');
  assert.equal(outcome.synthesised, false);
  assert.ok(model.seen.every((c) => c.tools.length > 0), 'the opt-out did not reach the loop');
});
