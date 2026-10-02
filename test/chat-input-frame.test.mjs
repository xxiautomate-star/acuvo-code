/**
 * ── ⭐⭐ THE PROMPT HAS TO LOOK LIKE SOMEWHERE INPUT GOES ────────────────────
 *
 * Roman, comparing `acuvo` against a real Claude Code screenshot: *"you can see
 * the box where you type, acuvo doesn't have that."*
 *
 * He was right — the prompt was `› `, two characters floating in the scrollback,
 * indistinguishable from output. These assert the frame exists, that it never
 * appears on a piped run, and that it survives a resize.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runChat } from '../lib/chat.mjs';

function fakeTty(columns = 80) {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => {};
  s.columns = columns;
  return s;
}

function sink(columns = 80) {
  const s = new PassThrough();
  s.isTTY = true;
  s.columns = columns;
  s.text = '';
  s.on('data', (c) => { s.text += c.toString(); });
  return s;
}

const tick = () => new Promise((r) => setImmediate(r));
const noop = {
  runOne: async () => ({ ok: true, messages: [], stoppedBecause: 'no-tool-calls' }),
  render: () => {},
};

test('⭐⭐ the input is a full-width RULE with the prompt beneath it', async () => {
  const input = fakeTty();
  const output = sink();
  const done = runChat({ ...noop, input, output });
  await tick();
  input.write('exit\n');
  await done;

  /**
   * ⚠️ RE-ANCHORED FOR THE REAL BOX. This asserted an open-close FRAME, which is
   * what readline allowed; the input is now a closed four-sided box painted by
   * `input-box.mjs`. Same property — the prompt is visibly a place input goes —
   * asserted against the shape that actually ships.
   */
  /**
   * ⚠️ RE-ANCHORED FROM A BOX. A screenshot of the real Claude Code settled it:
   * there is no box — one rule across the full width with `› ` beneath it. Same
   * property asserted (the prompt is visibly a place input goes), against the
   * shape that actually ships.
   */
  assert.match(output.text, /─{20,}/, 'no rule — the prompt is floating in the scrollback again');
  assert.match(output.text, /›/, 'the prompt marker is gone');
  assert.doesNotMatch(output.text, /[╭╮╰╯│]/, 'box drawing is back — the input is a rule, not a box');
});

test('⚠️ a PIPED run is never framed — box drawing in a transcript is noise', async () => {
  /**
   * Piping a list of prompts is how anyone scripts this, and the output is read
   * by tooling as often as by a person. Rules and edges in that stream are
   * characters somebody has to strip back out.
   */
  const input = new PassThrough();      // no isTTY -> not interactive
  const output = sink();
  const done = runChat({ ...noop, input, output });
  input.end('exit\n');
  await done;

  assert.doesNotMatch(output.text, /[╭╰]/, `a piped run drew a frame:\n${output.text}`);
});

test('⚠️ the width is read FRESH each turn, so a mid-session resize is honoured', async () => {
  /**
   * Read once at startup, a terminal resized halfway through keeps drawing rules
   * at the old width for the rest of the run — which looks like a rendering bug
   * rather than a stale variable.
   */
  const input = fakeTty(60);
  const output = sink(60);
  const done = runChat({ ...noop, input, output });
  await tick();
  output.columns = 100;
  input.write('first\n');
  /**
   * ⚠️ A REAL WAIT, NOT setImmediate. A turn runs an async model call; two
   * microtask ticks return before the box has repainted even once, so this saw
   * zero rules and read as "the resize is broken" when the code was correct.
   */
  await new Promise((r) => setTimeout(r, 80));
  input.write('exit\n');
  await done;

  /**
   * ⚠️ MATCHED INSIDE THE LINE, NOT ANCHORED TO IT. The paint prefixes each
   * repaint with cursor escapes, so a border never starts at column 0 of its
   * line — an anchored `^…$` finds nothing and reports the feature missing.
   */
  const rules = (output.text.match(/─{20,}/g) || []).map((l) => l.length);
  assert.ok(rules.length >= 2, `expected several rules, saw ${rules.length}`);
  assert.ok(
    new Set(rules).size > 1,
    `every rule is the same width (${rules[0]}) — the resize was not picked up`,
  );
});

test('⚠️ the frame is clamped — it never trusts an absurd or missing column count', async () => {
  for (const columns of [undefined, 5, 10_000]) {
    const input = fakeTty(columns);
    const output = sink(columns);
    const done = runChat({ ...noop, input, output });
    await tick();
    input.write('exit\n');
    await done;

    for (const line of output.text.split('\n').filter((l) => /^[╭╰]─+$/.test(l))) {
      assert.ok(
        line.length >= 40 && line.length <= 100,
        `columns=${columns} drew a ${line.length}-char rule`,
      );
    }
  }
});
