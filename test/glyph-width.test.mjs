/**
 * ── ⚠️ THE BANNER HAS BEEN WRONG FOUR TIMES AND GREEN EVERY TIME ────────────
 *
 * Every previous version of this screen passed its tests, because those tests
 * asked "is the string right" and the terminal asks "how many cells is it".
 * These tests are written against the second question: the probe's parsing, its
 * cleanup, its refusal to hang — and, for the banner, that NO line at ANY width
 * can exceed the terminal, which is the property that was actually violated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseCursorReport, residualInput, bannerStyle, measureCellWidth } from '../lib/glyph-width.mjs';
import { openingScreen } from '../lib/banner.mjs';

/* ── parsing the reply ───────────────────────────────────────────────────── */

test('⭐ a cursor report is parsed out of the stream', () => {
  assert.deepEqual(parseCursorReport('\x1b[12;3R'), { row: 12, col: 3 });
});

test('⚠️⚠️ it is found even when glued to a keystroke that raced it', () => {
  /**
   * The reply arrives asynchronously, so anything the user typed during the
   * round trip lands in the same chunk. Anchoring at the start would throw away
   * a good measurement because somebody pressed a key.
   */
  assert.deepEqual(parseCursorReport('a\x1b[1;3Rb'), { row: 1, col: 3 });
  assert.equal(residualInput('a\x1b[1;3Rb'), 'ab');
});

test('⚠️ nonsense is null, never a plausible number', () => {
  for (const junk of ['', 'hello', '\x1b[R', '\x1b[;R']) {
    assert.equal(parseCursorReport(junk), null, JSON.stringify(junk));
  }
});

/* ── the probe ───────────────────────────────────────────────────────────── */

/** A fake TTY pair that answers the DSR query with a given column. */
function fakeTty(answerCol) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (v) => { input.isRaw = v; };
  input.unshift = () => {};
  const written = [];
  const output = { isTTY: true, write: (s) => { written.push(s); return true; } };
  if (answerCol !== null) {
    output.write = (s) => {
      written.push(s);
      if (s.includes('\x1b[6n')) setImmediate(() => input.emit('data', `\x1b[1;${answerCol}R`));
      return true;
    };
  }
  return { input, output, written };
}

test('⭐⭐⭐ a single-width glyph measures 1, a double-width one measures 2', async () => {
  assert.equal(await measureCellWidth({ ...fakeTty(2) }), 1, 'cursor at column 2 means one cell used');
  assert.equal(await measureCellWidth({ ...fakeTty(3) }), 2, 'cursor at column 3 means two cells used');
});

test('⚠️⚠️ a terminal that never answers times out and returns unknown', async () => {
  /**
   * THE ONE THAT MATTERS MOST. A probe that hangs has broken the program it was
   * meant to improve, on startup, before the user has typed anything.
   */
  const t = fakeTty(null);
  const started = Date.now();
  assert.equal(await measureCellWidth({ ...t, timeoutMs: 40 }), null);
  assert.ok(Date.now() - started < 1000, 'it waited far too long');
});

test('⚠️⚠️ raw mode is restored and the probe glyph is erased', async () => {
  const t = fakeTty(2);
  await measureCellWidth({ ...t });
  assert.equal(t.input.isRaw, false, 'the terminal was left in raw mode');
  assert.ok(t.written.some((w) => w.includes('\x1b[2K')), 'the glyph it printed was never erased');
});

test('⚠️ raw mode that was ALREADY on is left on', async () => {
  /**
   * Turning it off would silently break whatever had turned it on — the input
   * box, in this package's case, whose entire key handling depends on it.
   */
  const t = fakeTty(2);
  t.input.isRaw = true;
  await measureCellWidth({ ...t });
  assert.equal(t.input.isRaw, true);
});

test('⚠️ off a TTY it does not probe at all', async () => {
  assert.equal(await measureCellWidth({ input: {}, output: {} }), null);
});

test('⚠️ a nonsense column reads as unknown, not as a width', async () => {
  assert.equal(await measureCellWidth({ ...fakeTty(99) }), null);
});

/* ── the decision ────────────────────────────────────────────────────────── */

test('⭐⭐ blocks only on a measured single-width terminal', () => {
  assert.equal(bannerStyle({ cellWidth: 1 }), 'blocks');
  assert.equal(bannerStyle({ cellWidth: 2 }), 'text');
});

test('⭐⭐⭐ UNKNOWN falls back to text, not to blocks', () => {
  /**
   * The two errors are not symmetric. Text on a capable terminal costs a little
   * beauty; blocks on an incapable one is a screen of torn garbage as the first
   * thing a new user sees — reported three times before this was measured.
   */
  assert.equal(bannerStyle({ cellWidth: null }), 'text');
});

test('⭐ an explicit setting outranks the measurement, both ways', () => {
  assert.equal(bannerStyle({ cellWidth: 2, env: { ACUVO_BANNER: 'blocks' } }), 'blocks');
  assert.equal(bannerStyle({ cellWidth: 1, env: { ACUVO_BANNER: 'text' } }), 'text');
});

/* ── the property that was actually broken ───────────────────────────────── */

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

test('⭐⭐⭐ NO line exceeds the terminal, at any width, in either style', () => {
  /**
   * ⚠️ THIS IS THE TEST THE OLD BANNER COULD NOT HAVE PASSED, and it never ran
   * because the banner did not take a width — it built to a fixed 80 columns
   * and looked immaculate in an 80-column terminal. A line one cell too wide
   * does not degrade gracefully; it wraps, and every row below it shifts.
   */
  for (let columns = 24; columns <= 120; columns += 1) {
    for (const style of ['blocks', 'text']) {
      const s = openingScreen({
        version: '9.9.9',
        workspace: 'C:/Projects/some/quite/deeply/nested/workspace/path',
        model: 'Acuvo Flash 1',
        billing: 'Acuvo account',
        canRun: 'read + write + shell',
        interactive: true,
        style,
        columns,
      });
      for (const line of s.split('\n')) {
        assert.ok(
          visible(line) <= columns - 1,
          `${style} at ${columns} columns produced a ${visible(line)}-cell line: ${JSON.stringify(line)}`,
        );
      }
    }
  }
});

test('⭐⭐ the ASCII fallback is still the MARK, not a wordmark', () => {
  /**
   * Roman asked for our logo, then asked again when he got letters spelling the
   * name. A terminal that cannot draw half-blocks must still get the angular A,
   * drawn another way — a degraded logo is a logo, a text substitute is a
   * missing one.
   */
  const s = openingScreen({ version: '1', workspace: 'w', model: 'm', billing: 'b', canRun: 'c', style: 'text', columns: 100 });
  /**
   * ⚠️ RE-ANCHORED 2026-08-22: the mark shrank from seven rows to four, so its
   * base row changed shape. The PROPERTY is unchanged and is what matters — the
   * fallback must still draw the angular A, not letters spelling the name.
   */
  assert.match(s, /\/-{4}\\/, 'the ASCII mark is not being drawn');
  assert.doesNotMatch(s, /A\s*C\s*U\s*V\s*O/, 'the fallback became a wordmark');
});

test('⚠️ a narrow terminal stacks the mark above the facts rather than tearing them', () => {
  const s = openingScreen({ version: '1', workspace: 'my-repo', model: 'm', billing: 'b', canRun: 'c', style: 'text', columns: 30 });
  const lines = s.split('\n').filter(Boolean);
  /**
   * ⚠️ RE-ANCHORED with the four-row mark and the label-free fact lines. The
   * mark's base row is now `/      \` and the facts have no `workspace` label to
   * find, so both anchors moved — the PROPERTY did not: when there is no room
   * for two columns, the facts sit BELOW the mark rather than beside it.
   */
  const markRow = lines.findIndex((l) => l.includes('/----\\'));
  const factRow = lines.findIndex((l) => l.includes('my-repo'));
  assert.ok(markRow >= 0, 'the mark is not drawn at all');
  assert.ok(factRow > markRow, 'the facts should sit BELOW the mark when stacked');
});

test('⚠️ the hint is shortened in stages, never cut mid-word', () => {
  for (const columns of [24, 30, 40, 60, 80]) {
    const s = openingScreen({ version: '1', workspace: 'w', model: 'm', billing: 'b', canRun: 'c', interactive: true, style: 'text', columns });
    assert.doesNotMatch(s, /exit to leav$/m, `cut mid-word at ${columns}`);
  }
});
