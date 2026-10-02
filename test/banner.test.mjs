import test from 'node:test';
import assert from 'node:assert/strict';
import { openingScreen, MAX_BANNER_COLUMNS } from '../lib/banner.mjs';

const base = {
  version: '0.3.2',
  workspace: 'C:\\Projects\\claude-build',
  model: 'deepseek/deepseek-v4-flash-0731',
  billing: 'your Acuvo plan',
  canRun: '24 rounds · node, npm test, npm run, npx vitest, tsc',
};

test('⭐⭐ the mark is there — this is the first thing anyone sees', () => {
  const out = openingScreen(base);
  assert.match(out, /█/, 'the logo is gone; `acuvo` opens on an unbranded wall of facts again');
  /**
   * ⚠️ RE-ANCHORED 2026-08-22, FROM `CODE  0.3.2` TO `Acuvo Code v0.3.2`. The
   * title line was rebuilt against a screenshot of the reference, which reads
   * `Claude Code v2.1.219` — sentence case, a `v` before the number. The old
   * shouted form was mine, not theirs.
   */
  assert.match(out, /Acuvo Code v0\.3\.2/);
});

test('⭐⭐⭐ all four facts are stated before anything runs', () => {
  /**
   * ── ⚠️⚠️ RE-ANCHORED FROM THE LABELS TO THE VALUES ────────────────────────
   *
   * This asserted the words `workspace`, `model`, `billing`, `can run` — the
   * LABELS of a four-row table. A screenshot of the reference shows there are no
   * labels at all: three prose lines whose values are self-describing, because a
   * version looks like a version and a path looks like a path.
   *
   * ⭐ THE PROPERTY WAS NEVER THE LABELS. It is that all four facts REACH the
   * user before anything runs, and that is what is asserted now — the values
   * themselves. Anchoring a guard on presentation is how it stops protecting a
   * guarantee and starts forbidding a redesign.
   */
  const out = openingScreen(base);
  assert.match(out, /deepseek\/deepseek-v4-flash-0731/, 'the model is not stated');
  assert.match(out, /your Acuvo plan/, 'who is paying is not stated');
  assert.match(out, /claude-build/, 'the workspace is not stated');
  assert.match(out, /24 rounds/, 'what it may run is not stated');
});

test('⚠️⚠️ nothing wraps, even on the longest realistic values', () => {
  /**
   * ⚠️ THE VALUES ARE SUPPLIED AT RUNTIME, so the width rule cannot be checked
   * by reading the module. A long model id or a deep path is what pushes a row
   * over 80 columns, and a wrapped banner does not look dense — it looks broken,
   * which is the first impression of the product.
   */
  const out = openingScreen({
    ...base,
    workspace: 'C:\\Users\\somebody\\Projects\\a-fairly-deeply-nested\\monorepo\\packages\\web',
    model: 'deepseek/deepseek-v4-flash-0731-extended-context-preview',
    billing: 'YOUR OWN OpenRouter key (not your Acuvo plan)',
    canRun: '24 rounds · ⚠ SHELL MODE — may run ANY program, with your privileges',
  });
  for (const line of out.split('\n')) {
    assert.ok(
      line.length <= MAX_BANNER_COLUMNS,
      `a banner row is ${line.length} columns and will wrap at 80: ${line}`,
    );
  }
});

test('⚠️ half-blocks only — braille and box-drawing render as tofu on cmd.exe', () => {
  /**
   * A logo that renders as question marks is worse than no logo: it makes the
   * tool look broken on the exact platform this project is developed on.
   */
  const out = openingScreen(base);
  const allowed = /^[\x20-\x7E█▀▄·⚠…—’]*$/u;
  for (const line of out.split('\n')) {
    assert.ok(allowed.test(line), `unsupported glyph in a banner line: ${JSON.stringify(line)}`);
  }
});

test('⚠️ NO colour escapes — the caller owns colour and honours NO_COLOR', () => {
  // A module that hard-codes escapes produces garbage the moment output is
  // piped to a file or read by CI.
  assert.doesNotMatch(openingScreen(base), /\u001b\[/);
});

test('⚠️⚠️ the invitation appears ONLY when a prompt actually follows', () => {
  /**
   * `runChat` prints its own "Type what you want done" line. Emitting it here
   * too showed the instruction twice, three lines apart — and on a ONE-SHOT run
   * it is worse than duplication: it invites input into something that has
   * already been given its task and is working.
   */
  assert.doesNotMatch(openingScreen(base), /Type what you want done/);
  assert.match(openingScreen({ ...base, interactive: true }), /Type what you want done/);
});

test('⭐ a missing version degrades quietly rather than printing "CODE undefined"', () => {
  const out = openingScreen({ ...base, version: '' });
  assert.match(out, /Acuvo Code/);
  assert.doesNotMatch(out, /undefined/);
  // A bare `v` with no number after it is worse than omitting the version.
  assert.doesNotMatch(out, /Acuvo Code v\s*$/m);
});

test('⭐⭐ the mark is painted brand green — and ONLY the mark', async () => {
  /**
   * Roman: "can you colour our logo green in the terminal?" #C8E91E, sampled
   * from the brand PNG.
   *
   * ⚠️ ONLY THE LOGO. Colouring the detail rows would put the one line that must
   * read as a warning — `billing: YOUR OWN OpenRouter key` — in competition with
   * decoration.
   */
  const { createPainter } = await import('../lib/colour.mjs');
  const out = openingScreen({ ...base, paint: createPainter(true) });

  assert.match(out, /\x1b\[38;[25]/, 'the mark is not painted at all');
  for (const line of out.split('\n')) {
    if (/workspace|model|billing|can run/.test(line)) {
      const afterMark = line.slice(line.lastIndexOf('\x1b[0m') + 4);
      assert.doesNotMatch(afterMark, /\x1b\[/, `a detail row carries colour of its own: ${JSON.stringify(line)}`);
    }
  }
});

test('⚠️⚠️ with colour OFF not one escape byte is emitted', async () => {
  /**
   * The painter is INJECTED rather than imported precisely so this holds: the
   * caller already decided, and a module that reaches for colour itself will
   * eventually write escapes into somebody's redirected file.
   */
  const { createPainter } = await import('../lib/colour.mjs');
  assert.doesNotMatch(openingScreen({ ...base, paint: createPainter(false) }), /\x1b\[/);
  assert.doesNotMatch(openingScreen(base), /\x1b\[/, 'no painter at all must also be plain');
});

test('⚠️ colour never changes the LAYOUT — escapes have no width', async () => {
  /**
   * Padding a coloured string aligns the text against invisible bytes and the
   * whole right-hand column drifts. Padded first, painted second.
   */
  const { createPainter } = await import('../lib/colour.mjs');
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(
    strip(openingScreen({ ...base, paint: createPainter(true) })),
    openingScreen(base),
    'the coloured banner does not lay out identically to the plain one',
  );
});
