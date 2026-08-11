/**
 * ── ⚠️ A VERDICT THAT CONTRADICTED ITS OWN SUMMARY ──────────────────────────
 *
 * OBSERVED on a real pair of saved runs:
 *
 *   ✔ no divergence — both runs took the same actions, in the same order.
 *   …
 *   summary 4 same · 0 changed · 0 only in A · 2 only in B
 *
 * Those two lines cannot both be read as true. `divergence` is only set when two
 * ACTIONS disagree AT THE SAME POSITION, so a run where one side simply did MORE
 * has no divergence point at all and fell into the reassuring branch.
 *
 * ⭐ WHEN A TOOL CONTRADICTS ITSELF, ASSUME THE REASSURING HALF IS THE WRONG
 * ONE. The whole value of `--replay --diff` is answering "why did this pass once
 * and fail once", and an answer that says "identical" while its own arithmetic
 * says otherwise is worse than no answer — it ends the investigation.
 *
 * ⚠️ EXTRA PROSE IS NOT AN EXTRA ACTION. Every row already carries
 * `prose: !isAction(step)`. A model that SAYS more has not DONE more, and
 * collapsing the two would replace a false all-clear with a false alarm — which
 * is the same bug pointing the other way.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { formatDiff } from '../lib/replay.mjs';

const strip = (s) => s.replace(/\[[0-9;]*m/g, '');

/** The shape `diffSessions` returns, reduced to what the verdict reads. */
function diffWith(rows, extra = {}) {
  const summary = { same: 0, changed: 0, onlyA: 0, onlyB: 0 };
  for (const r of rows) {
    if (r.kind === 'same') summary.same += 1;
    else if (r.kind === 'changed') summary.changed += 1;
    else if (r.kind === 'only-a') summary.onlyA += 1;
    else if (r.kind === 'only-b') summary.onlyB += 1;
  }
  return {
    ok: true,
    a: { id: 'AAA', task: 't', roundsUsed: 1, stoppedBecause: 'done' },
    b: { id: 'BBB', task: 't', roundsUsed: 1, stoppedBecause: 'done' },
    rows,
    summary,
    divergence: null,
    proseDiffers: false,
    sameTask: true,
    ...extra,
  };
}

/**
 * ⚠️ THE REAL STEP SHAPE, read out of `rowLabel` / `argsLine` rather than
 * guessed. A `call` needs `tool` and `argsParsed` — my first fixture used
 * `name`/`label` and every row that reached the formatter threw
 * "Cannot read properties of undefined". The one test that passed was the one
 * whose rows never got that far, which is exactly how a bad fixture hides.
 */
const step = (tool) => ({ kind: 'call', tool, argsParsed: true, args: {} });

/** A prose row — the formatter falls through to `step.kind` for these. */
const note = () => ({ kind: 'note' });

test('⚠️ extra ACTIONS on one side are never reported as "the same actions"', () => {
  const out = strip(formatDiff(diffWith([
    { kind: 'same', a: step('read_file'), b: step('read_file'), prose: false, why: null },
    { kind: 'only-b', a: null, b: step('write_file'), prose: false, why: 'only the second run did this' },
    { kind: 'only-b', a: null, b: step('run_command'), prose: false, why: 'only the second run did this' },
  ])));

  assert.equal(
    /no divergence — both runs took the same actions/.test(out),
    false,
    'the summary says two actions happened on one side only, and the verdict called the runs identical',
  );
  assert.match(out, /DID MORE/i);
  assert.match(out, /SECOND run/i, 'it must name WHICH run went further, or the reader has to count rows');
});

test('⚠️ extra PROSE is not an extra action — no false alarm either', () => {
  const out = strip(formatDiff(diffWith([
    { kind: 'same', a: step('read_file'), b: step('read_file'), prose: false, why: null },
    { kind: 'only-b', a: null, b: note(), prose: true, why: 'only the second run did this' },
    { kind: 'only-b', a: null, b: note(), prose: true, why: 'only the second run did this' },
  ])));

  assert.match(out, /no divergence/, 'saying more is not doing more — this must stay an all-clear');
  assert.match(out, /said more, did not do more/i, 'but the extra rows must still be explained, or the summary looks unexplained');
  assert.equal(/DID MORE/i.test(out), false);
});

test('⭐ genuinely identical runs still get a clean all-clear, with nothing added', () => {
  const out = strip(formatDiff(diffWith([
    { kind: 'same', a: step('read_file'), b: step('read_file'), prose: false, why: null },
    { kind: 'same', a: step('write_file'), b: step('write_file'), prose: false, why: null },
  ])));
  assert.match(out, /no divergence/);
  assert.equal(/DID MORE/i.test(out), false);
  assert.equal(/said more/i.test(out), false, 'noise added to the one case that is genuinely clean');
});

test('a real DIVERGENCE still wins over both branches', () => {
  const out = strip(formatDiff(diffWith(
    [{ kind: 'changed', a: step('write_file'), b: step('delete_file'), prose: false, why: 'different tool' }],
    { divergence: { round: 2, why: 'different tool', a: step('write_file'), b: step('delete_file') } },
  )));
  assert.match(out, /DIVERGED at round 2/);
  assert.equal(/no divergence/.test(out), false);
});

test('⚠️ extras on BOTH sides name both, not one', () => {
  const out = strip(formatDiff(diffWith([
    { kind: 'only-a', a: step('read_file'), b: null, prose: false, why: 'only the first run did this' },
    { kind: 'only-b', a: null, b: step('write_file'), prose: false, why: 'only the second run did this' },
  ])));
  assert.match(out, /each run/i, 'when both sides went further, naming one of them is a half-truth');
});
