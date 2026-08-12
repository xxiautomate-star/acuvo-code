/**
 * ── ⚠️ THREE DEFECTS YOU CAN ONLY SEE BY LOOKING AT THE TERMINAL ────────────
 *
 * All three survived a green suite because every one of them is invisible to an
 * assertion about RETURN VALUES. The functions were correct; the SCREEN was
 * wrong. Found by rendering a real run and reading it.
 *
 *   1. the list of changed files printed TWICE — once inside `formatSummary`
 *      under its "1 file written:" header, and again bare, after the cost line
 *   2. streamed prose was cut MID-WORD at column 88, with no marker, so the
 *      reader could not tell truncation from the model stopping
 *   3. the banner printed a 100+ character ABSOLUTE path on every single run
 *
 * ⭐ THE GENERAL LESSON: a test that asks "did the function return the right
 * string" cannot see a second caller printing that string again, cannot see a
 * cut that loses a word, and cannot see a line too wide for the window. Those
 * are properties of the OUTPUT AS A WHOLE, and they need tests written at the
 * same level.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createLivePrinter } from '../lib/stream.mjs';
import { shortenRoot } from '../lib/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const binSource = readFileSync(join(here, '..', 'bin', 'acuvo.mjs'), 'utf8');

/* ── 1. the change list, printed once ─────────────────────────────────────── */

test('⚠️ bin must not re-print the change list that formatSummary already prints', () => {
  /**
   * ⚠️ THE RIGHT COPY TO DELETE WAS BIN'S, not turn.mjs's. `formatSummary`
   * emits the list UNDER its "N files written:" header — that is the copy with
   * context. Deleting that one instead would have left an unlabelled list of
   * paths floating below the price, which reads worse than the duplicate did.
   */
  /**
   * ⚠️ THE PATTERN MATCHES A CALL, NOT THE WORD. My first version grepped for
   * `formatChanges` and went red on the COMMENT explaining why it is absent —
   * a check that forbids naming the thing it forbids is unmaintainable, and it
   * fails the one change that documents itself properly.
   */
  assert.equal(
    /formatChanges\s*\(/.test(binSource),
    false,
    'bin/acuvo.mjs calls formatChanges again after formatSummary — that is the second copy on screen',
  );
});

/* ── 2. the cut that loses a word ─────────────────────────────────────────── */

const printerOutput = (text, opts = {}) => {
  const out = [];
  const p = createLivePrinter({ write: (s) => out.push(s), ...opts });
  p.onText(text);
  p.flush();
  return out.join('');
};

test('⚠️ a truncated line is never cut mid-word, and says that it was cut', () => {
  const long = `${'antidisestablishmentarianism '.repeat(6)}\n`;
  const out = printerOutput(long, { width: 40 });

  assert.ok(out.length > 0, 'a long line must still print something');
  assert.ok(out.includes('…'), 'a cut with no marker reads as the model having stopped mid-sentence');

  const shown = out.replace(/^ {2}/gm, '').replace('…', '').trimEnd();
  /**
   * ⚠️ THE ASSERTION THAT MATTERS: every word on screen is a whole word. A
   * hard `slice(0, width)` passes "is it short enough" and fails this.
   */
  for (const word of shown.split(/\s+/).filter(Boolean)) {
    assert.equal(word, 'antidisestablishmentarianism', `"${word}" is a fragment of a word, not a word`);
  }
});

test('⚠️ text that FITS gets no ellipsis — the marker must mean something', () => {
  const out = printerOutput('short enough\n', { width: 40 });
  assert.match(out, /short enough/);
  assert.equal(out.includes('…'), false, 'an ellipsis on untruncated text makes every ellipsis meaningless');
});

test('the same rule applies to flush(), which had its own copy of the slice', () => {
  /**
   * ⚠️ `flush()` handles the tail that never got a newline — the LAST thing the
   * user sees. It had an independent `slice(0, width)`, so fixing only `onText`
   * would have left the defect exactly where it is most visible.
   */
  const out = printerOutput('supercalifragilistic '.repeat(5), { width: 30 });
  assert.ok(out.includes('…'), 'the unterminated tail is truncated too, and must say so');
  const shown = out.replace(/^ {2}/gm, '').replace('…', '').trimEnd();
  for (const word of shown.split(/\s+/).filter(Boolean)) {
    assert.equal(word, 'supercalifragilistic', `flush() cut "${word}" mid-word`);
  }
});

test('a word longer than the whole width still prints, rather than vanishing', () => {
  /**
   * ⚠️ THE FAILURE MODE OF A NAIVE WORD-BOUNDARY FIX: with no space before the
   * limit there is no boundary to break on, and "never cut a word" becomes
   * "print nothing". Showing a hard-cut prefix is strictly better than silence.
   */
  const out = printerOutput(`${'x'.repeat(200)}\n`, { width: 40 });
  assert.ok(out.replace(/\s|…/g, '').length >= 30, 'an unbreakable token must still show, even if cut');
});

/* ── 3. the banner path ───────────────────────────────────────────────────── */

test('⭐ the banner shortens a home-relative path to ~', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
  const deep = join(home, 'code', 'a-project');
  const short = shortenRoot(deep, home);
  assert.match(short, /^~/, 'a path under $HOME is the common case and ~ is the universal shorthand');
  assert.ok(short.length < deep.length);
});

test('⚠️ a path OUTSIDE home is shortened by depth, never silently mangled', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
  const far = process.platform === 'win32'
    ? 'C:\\Projects\\claude-build-closer-wt\\acuvo-code\\lib\\deep\\deeper'
    : '/srv/projects/claude-build-closer-wt/acuvo-code/lib/deep/deeper';
  const short = shortenRoot(far, home);

  assert.ok(short.length < far.length, 'the whole point is that it is shorter');
  assert.ok(short.includes('deeper'), 'the LAST segment is the one that identifies the workspace — never drop it');
  assert.ok(/…|\.\.\./.test(short), 'an elided path that does not say it was elided is a wrong path');
});

test('a path already short enough is returned untouched', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
  const tiny = process.platform === 'win32' ? 'C:\\w' : '/w';
  assert.equal(shortenRoot(tiny, home), tiny, 'shortening something short adds noise and loses truth for nothing');
});

test('⚠️ shortenRoot never throws on the odd inputs a real root can be', () => {
  for (const v of [undefined, null, '', '.', '/', 'C:\\']) {
    assert.doesNotThrow(() => shortenRoot(v, undefined), `threw on ${JSON.stringify(v)}`);
  }
});
