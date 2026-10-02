/**
 * ── ⚠️ A HALF-BUILT LINE EDITOR IS WORSE THAN A PLAIN PROMPT ────────────────
 *
 * Backspace that does nothing, or an arrow key that prints `^[[D`, makes the
 * tool feel broken in a way `› ` never did. Replacing readline means taking on
 * everything readline did for free, so every key people actually press is
 * asserted here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBox, applyKey, splitKeys, visibleWidth } from '../lib/input-box.mjs';

const type = (s, text) => splitKeys(text).reduce(applyKey, s);
const fresh = (over = {}) => ({ value: '', cursor: 0, history: [], historyIndex: 0, ...over });

/* ── the box itself ──────────────────────────────────────────────────────── */

test('⭐⭐ a RULE and a prompt — not a box — both exactly full width', () => {
  /**
   * ⚠️ RE-ANCHORED FROM A BOX, AND THE SCREENSHOT IS WHY. I built four sides
   * because Roman said "copy Claude's box exactly"; a screenshot of the real
   * thing shows there IS no box — one rule across the full width with the
   * prompt beneath it. Two borders and two side walls make the input an object
   * floating in the terminal; one rule makes it the bottom of the page.
   */
  const { lines } = renderBox({ value: 'hi', cursor: 2, columns: 60 });
  assert.equal(lines.length, 2, 'the input is two rows now: a rule and the prompt line');
  assert.match(lines[0], /^─+$/, 'the first row must be an unbroken rule');
  assert.match(lines[1], /^› hi/, 'the prompt line must start with the prompt');
  const widths = new Set(lines.map(visibleWidth));
  assert.equal(widths.size, 1, `the rule and the prompt line disagree on width: ${[...widths].join(', ')}`);
});

test('⚠️⚠️ a long line SCROLLS the view — it must never wrap and break the box', () => {
  /**
   * A wrapped line pushes the bottom border down a row, and the box stops being
   * a box the moment somebody types a real sentence. The buffer is windowed
   * around the cursor instead, which is what every real input does.
   */
  const long = 'x'.repeat(500);
  const { lines } = renderBox({ value: long, cursor: long.length, columns: 60 });
  assert.equal(lines.length, 2, 'the input grew a row — the line wrapped');
  for (const l of lines) assert.ok(visibleWidth(l) <= 59, `line is ${visibleWidth(l)} wide`);
});

test('⚠️ the cursor stays INSIDE the border, at both ends of a long buffer', () => {
  for (const cursor of [0, 1, 40, 200]) {
    const value = 'y'.repeat(200);
    const { lines, cursorColumn } = renderBox({ value, cursor, columns: 60 });
    assert.ok(cursorColumn >= 1, `cursor at column ${cursorColumn} is off the left edge`);
    assert.ok(cursorColumn <= visibleWidth(lines[1]), `cursor at ${cursorColumn} is past the right edge`);
  }
});

test('⚠️ absurd or missing widths are clamped, not trusted', () => {
  for (const columns of [undefined, 0, 3, 10_000]) {
    const { lines } = renderBox({ value: 'a', cursor: 1, columns });
    const w = visibleWidth(lines[0]);
    /**
     * ⚠️ THE 100-COLUMN CEILING IS GONE. Roman, from a screenshot: "ours isn't
     * the entire width" — a 100-column box in a 200-column terminal reads as
     * half-finished. What still must hold is that it never EXCEEDS the terminal
     * (which wraps and breaks the cursor arithmetic) and never collapses below
     * something usable.
     */
    const limit = (columns ?? 80) - 1;
    assert.ok(w >= 20, `columns=${columns} drew a ${w}-wide box`);
    assert.ok(w <= Math.max(20, limit), `columns=${columns} drew ${w}, wider than the terminal`);
  }
});

/* ── keys ────────────────────────────────────────────────────────────────── */

test('⭐ typing, backspace, and insertion in the middle', () => {
  let s = type(fresh(), 'helo');
  s = applyKey(s, '\x1b[D');            // left
  s = applyKey(s, 'l');
  assert.equal(s.value, 'hello');
  s = applyKey(s, '\x7f');
  assert.equal(s.value, 'helo', 'backspace deleted at the wrong position');
});

test('⭐ home / end / word-delete / kill-line', () => {
  let s = type(fresh(), 'the quick brown fox');
  s = applyKey(s, '\x17');
  assert.equal(s.value, 'the quick brown', 'ctrl-w');
  s = applyKey(s, '\x01');
  assert.equal(s.cursor, 0, 'ctrl-a');
  s = applyKey(s, '\x05');
  assert.equal(s.cursor, s.value.length, 'ctrl-e');
  s = applyKey(s, '\x15');
  assert.equal(s.value, '', 'ctrl-u');
});

test('⚠️⚠️ Ctrl-D is EOF only on an EMPTY line — on text it deletes forward', () => {
  /**
   * Collapsing the two exits the session when somebody meant to delete a
   * character. That is a data-loss-shaped surprise, and it is why this is
   * asserted rather than assumed.
   */
  assert.equal(applyKey(fresh(), '\x04').done, 'eof');
  const s = applyKey(fresh({ value: 'ab', cursor: 0 }), '\x04');
  assert.equal(s.value, 'b');
  assert.equal(s.done, undefined, 'it exited the session on a forward-delete');
});

test('⭐ enter submits, Ctrl-C cancels, and they are distinguishable', () => {
  assert.equal(applyKey(fresh({ value: 'go' }), '\r').done, 'submit');
  assert.equal(applyKey(fresh({ value: 'go' }), '\x03').done, 'cancel');
});

/* ── history ─────────────────────────────────────────────────────────────── */

test('⭐⭐ history walks up and down', () => {
  const h = ['npm test', 'fix the build'];
  let s = fresh({ history: h, historyIndex: h.length });
  s = applyKey(s, '\x1b[A');
  assert.equal(s.value, 'fix the build');
  s = applyKey(s, '\x1b[A');
  assert.equal(s.value, 'npm test');
  s = applyKey(s, '\x1b[A');
  assert.equal(s.value, 'npm test', 'walking past the oldest entry must stop, not wrap');
});

test('⚠️⚠️ a half-typed DRAFT survives a trip through history', () => {
  /**
   * Leaving it behind means one Up press destroys a sentence somebody was
   * writing. Losing typed input to a NAVIGATION key is the least forgivable bug
   * a line editor can have — and the first version of this module did it.
   */
  const h = ['npm test', 'fix the build'];
  let s = type(fresh({ history: h, historyIndex: h.length }), 'half typed');
  s = applyKey(s, '\x1b[A');
  s = applyKey(s, '\x1b[A');
  s = applyKey(s, '\x1b[B');
  s = applyKey(s, '\x1b[B');
  assert.equal(s.value, 'half typed', 'the draft was eaten by the history keys');
});

test('⚠️ history is CARRIED between keystrokes — it was silently dropped once', () => {
  /**
   * The first version returned only {value, cursor, historyIndex}, so the
   * history array vanished on the first character typed and Up did nothing
   * afterwards. It read as an unimplemented feature rather than as lost state.
   */
  const s = type(fresh({ history: ['a', 'b'], historyIndex: 2 }), 'zzz');
  assert.deepEqual(s.history, ['a', 'b']);
});

/* ── input parsing ───────────────────────────────────────────────────────── */

test('⭐ escape sequences are ONE key, and a paste is many', () => {
  assert.deepEqual(splitKeys('a\x1b[Db'), ['a', '\x1b[D', 'b']);
  assert.equal(splitKeys('a paste of text').length, 15);
});

test('⚠️⚠️ an UNHANDLED escape is dropped, never typed into the buffer', () => {
  /**
   * Inserting it shows the user `^[[5~` in their prompt and looks like the tool
   * is broken — the one impression a brand-new line editor cannot afford.
   */
  for (const junk of ['\x1b[5~', '\x1b[6~', '\x1b[200~', '\x1bOP']) {
    assert.equal(applyKey(fresh({ value: 'x', cursor: 1 }), junk).value, 'x', `${JSON.stringify(junk)} was typed`);
  }
});

/* ── the cursor arithmetic, which is where the real bug was ──────────────── */

/**
 * Track net vertical movement through an ANSI stream.
 *
 * ⚠️ THIS IS THE TEST THAT WAS MISSING. The box rendered perfectly in a string
 * assertion while destroying the screen in a real terminal, because nothing
 * followed the CURSOR. Roman saw it in one keystroke: "it moves upwards every
 * time you type a character then deletes the design you did."
 */
function netRowMovement(ansi) {
  let row = 0;
  let i = 0;
  while (i < ansi.length) {
    const esc = /^\x1b\[(\d*)([ABCDGJ])/.exec(ansi.slice(i));
    if (esc) {
      const n = esc[1] === '' ? 1 : Number(esc[1]);
      if (esc[2] === 'A') row -= n;
      if (esc[2] === 'B') row += n;
      i += esc[0].length;
      continue;
    }
    if (ansi[i] === '\n') row += 1;
    i += 1;
  }
  return row;
}

test('⭐⭐⭐ a repaint RETURNS the cursor to where it started — net zero rows', async () => {
  const { paint } = await import('../lib/input-box.mjs');
  const out = { text: '', columns: 80, write(s) { this.text += s; } };

  paint(out, { value: 'a', cursor: 1, columns: 80 }, { first: true });
  const afterFirst = netRowMovement(out.text);

  out.text = '';
  paint(out, { value: 'ab', cursor: 2, columns: 80 });
  const afterRepaint = netRowMovement(out.text);

  assert.equal(
    afterRepaint, 0,
    `a repaint moved the cursor ${afterRepaint} rows. Anything but 0 means the box ` +
    'walks up (or down) the screen one keystroke at a time, erasing whatever is there.',
  );
  /**
   * ⚠️ +1, AND I ASSERTED 2 FIRST. Three lines are joined by TWO newlines, and
   * the reposition moves up one — so the cursor lands one row below where it
   * started, which is the input line. Getting this wrong in the test is the same
   * off-by-one that produced the bug in the code.
   */
  assert.equal(afterFirst, 1, 'two rows joined by one newline, then no reposition — the cursor ends on the prompt line');
});

test('⚠️⚠️ a repaint never clears ABOVE the box — that is what ate the banner', async () => {
  const { paint } = await import('../lib/input-box.mjs');
  const out = { text: '', columns: 80, write(s) { this.text += s; } };
  paint(out, { value: 'x', cursor: 1, columns: 80 });

  /**
   * `ESC[0J` clears from the cursor to the end of the screen, so everything
   * depends on how far up the cursor moved first. From the input line the top
   * border is exactly ONE row up; two or more reaches into content this box
   * does not own.
   */
  const upBeforeClear = /^\x1b\[\?25l\r\x1b\[(\d*)A\x1b\[0J/.exec(out.text);
  assert.ok(upBeforeClear, `the repaint preamble changed shape: ${JSON.stringify(out.text.slice(0, 40))}`);
  const rows = upBeforeClear[1] === '' ? 1 : Number(upBeforeClear[1]);
  assert.equal(rows, 1, `it moves up ${rows} rows before clearing — anything above 1 erases the banner`);
});

test('⚠️ no trailing newline — it would scroll the viewport at the bottom of the screen', async () => {
  const { paint } = await import('../lib/input-box.mjs');
  const out = { text: '', columns: 80, write(s) { this.text += s; } };
  paint(out, { value: 'x', cursor: 1, columns: 80 }, { first: true });
  assert.equal(
    (out.text.match(/\n/g) || []).length, 1,
    'exactly ONE newline joins the two rows; a second scrolls the screen and every later `up` is off by a row',
  );
});

test('⭐⭐⭐ on submit the cursor lands BELOW the input, not on it', async () => {
  /**
   * ── THE BUG A SCREENSHOT FOUND ──────────────────────────────────────────────
   *
   * An MCP warning printed straight on top of the bottom border, leaving it
   * visible only where the message was shorter than the input.
   *
   * ⚠️ Nothing else in this file could have caught it: the rows render correctly
   * and every key behaves correctly. The defect is entirely in where the cursor
   * is LEFT, which only matters to whatever writes next.
   */
  const { readBoxedLine } = await import('../lib/input-box.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  let text = '';
  const output = { columns: 80, write(s) { text += s; } };

  const done = readBoxedLine({ input, output });
  await new Promise((r) => setImmediate(r));
  input.write('hi\r');
  await done;

  assert.match(text.slice(-16), /\x1b\[1B\n/, 'the cursor never moved off the prompt line before yielding');
});

/* ── the pinned region: the part that can wreck someone's terminal ────────── */

test('⭐⭐⭐ pinning RESERVES rows and NEVER clears the screen or the scrollback', async () => {
  /**
   * ── ⚠️⚠️⚠️ REWRITTEN 2026-08-22. THIS TEST USED TO DEMAND THE BUG. ──────────
   *
   * It asserted the exact sequence `H, 2J, 3J, region, home` and its own comment
   * described two rounds of getting that ORDER right. The order was never the
   * problem. The CLEAR was the problem, and a test that pinned it in place is
   * how four consecutive builds shipped it:
   *
   *   · `2J`/`3J` run AFTER the banner is printed, so they erase the thing the
   *     user just saw — "I see the green logo for a fraction of a second then
   *     just the prompt box."
   *   · `3J` deletes the SCROLLBACK: the user's shell history and then their own
   *     session — "can't scroll up, it's just not there."
   *
   * ⭐ The reference does not do this. Claude Code never clears your terminal;
   * everything from before is still above it and still scrollable afterwards.
   * Room is made by SCROLLING (printing newlines), which destroys nothing.
   */
  const { pinRegion } = await import('../lib/input-box.mjs');
  const out = { isTTY: true, rows: 40, text: '', write(s) { this.text += s; } };
  const pin = pinRegion(out);

  assert.equal(pin.enabled, true, 'the pin is on by default again — the clear was the bug, not the region');
  assert.equal(pin.bottom, 38, 'two rows should be reserved out of forty');

  assert.doesNotMatch(out.text, /\x1b\[2J/, 'it erased the screen — that wipes the banner the user just saw');
  assert.doesNotMatch(out.text, /\x1b\[3J/, 'it erased the SCROLLBACK — that is the user history, not ours to delete');
  assert.doesNotMatch(out.text, /\x1b\[?1049h/, 'the alternate buffer hides the session on exit');

  assert.match(out.text, /^\n\n/, 'room must be made by scrolling, so nothing on screen is destroyed');
  assert.match(out.text, /\x1b\[1;38r/, 'the scroll region was never set');

  /**
   * ⚠️ THE FINAL CURSOR MOVE IS LOAD-BEARING: DECSTBM homes the cursor to (1,1)
   * as a side effect, so without this the first line of output lands at the TOP
   * of the screen and overwrites the banner — a quieter version of the same
   * defect.
   */
  /**
   * ⚠️⚠️ THE FINAL MOVE IS A *RESTORE*, NOT AN ABSOLUTE POSITION — and that is
   * the fix for the gap Roman photographed: banner at the top, forty blank
   * rows, the invitation stranded near the bottom.
   *
   * The old sequence ended `ESC[{bottom};1H`, parking the cursor on the LAST row
   * of the region, so the first thing printed after pinning landed at the bottom
   * of the screen and the whole void opened up behind it. A terminal fills
   * downward: after reserving rows, output must carry on from exactly where the
   * banner stopped — a position only the terminal knows, which is what DECSC and
   * DECRC (`ESC7`/`ESC8`) are for.
   */
  assert.match(out.text, /\x1b7/, 'the cursor position was never saved');
  assert.match(out.text, /\x1b8/, 'the cursor was never restored — output will start at the wrong row');
  assert.doesNotMatch(out.text, /\x1b\[\d+;1H/, 'an absolute move is what stranded the prompt at the bottom');

  const seq = [...out.text.matchAll(/\x1b\[([0-9;]*)([A-Za-z])/g)].map((m) => m[1] + m[2]);
  assert.deepEqual(seq, ['2A', '1;38r'], `unexpected sequence: ${seq.join(' -> ')}`);
});

test('⚠️⚠️ release RESTORES the full screen — and is idempotent', async () => {
  /**
   * A process that exits with a region still set leaves the user a terminal that
   * scrolls inside a box until they type `reset` blind. `release` runs from a
   * `finally`, from `exit`, from SIGINT and from SIGTERM, so it must be safe to
   * call several times.
   */
  const { pinRegion } = await import('../lib/input-box.mjs');
  const out = { isTTY: true, rows: 40, text: '', write(s) { this.text += s; } };
  const pin = pinRegion(out, { env: {} });
  out.text = '';
  pin.release();
  assert.match(out.text, /\x1b\[r/, 'the region was never released');

  out.text = '';
  pin.release();
  assert.equal(out.text, '', 'a second release wrote again — this runs from four different paths');
});

test('⚠️⚠️ it NEVER pins where it would do harm', async () => {
  const { pinRegion } = await import('../lib/input-box.mjs');
  const tty = (rows) => ({ isTTY: true, rows, write() {} });
  assert.equal(pinRegion({ rows: 40, write() {} }, { env: {} }).enabled, false, 'off a TTY');
  assert.equal(pinRegion(tty(40), { env: { CI: 'true' } }).enabled, false, 'in CI');
  /**
   * ⭐ RE-ENABLED BY DEFAULT 2026-08-22, once the CLEAR was removed. Roman asked
   * for the input pinned near the bottom "in reference to Claude's", and a
   * region that only reserves rows takes nothing from the user — the escape
   * hatch is now `ACUVO_NO_PIN=1` rather than an opt-in nobody would find.
   */
  assert.equal(pinRegion(tty(40)).enabled, true, 'the pin is the requested behaviour and should be the default');
  assert.equal(pinRegion(tty(40), { env: { ACUVO_NO_PIN: '1' } }).enabled, false, 'and there must be a way out');
  assert.equal(pinRegion(tty(5), { env: {} }).enabled, false, 'a terminal too short to spare the rows');
  assert.equal(pinRegion(tty(40), { env: {} }).enabled, true, 'and it DOES pin when asked and safe');
});

test('⚠️ a disabled pin still hands back a working release()', async () => {
  const { pinRegion } = await import('../lib/input-box.mjs');
  const pin = pinRegion({ rows: 40, write() {} }, { env: {} });
  assert.equal(pin.enabled, false);
  assert.doesNotThrow(() => pin.release());
});

test('⭐⭐⭐ PINNED: drawn at ABSOLUTE rows, so it cannot wander', async () => {
  /**
   * Roman, from a screenshot: "the text is going underneath instead of above,
   * and it makes a new box." `pinRegion` reserved the rows and `paint` still
   * drew RELATIVE to the cursor — so the input was painted inline, scrolled away
   * with the transcript, and the next turn painted a fresh one lower down while
   * the reserved rows sat empty.
   */
  const { paint } = await import('../lib/input-box.mjs');
  const out = { text: '', columns: 80, write(s) { this.text += s; } };
  paint(out, { value: 'hi', cursor: 2, columns: 80 }, { atRow: 39 });

  assert.match(out.text, /\x1b\[39;1H/, 'the rule is not placed at its fixed row');
  assert.match(out.text, /\x1b\[40;1H/, 'the prompt line is not placed at its fixed row');
  assert.doesNotMatch(out.text, /\x1b\[\d*A/, 'a pinned paint must never move RELATIVE — that is how it wandered');
  assert.match(out.text, /\x1b\[40;\d+H/, 'the cursor must land on the prompt row by absolute address');
});

test('⚠️ PINNED: every row is CLEARED before it is drawn', async () => {
  /**
   * The reserved rows are never scrolled, so nothing else erases them. Without
   * an explicit clear a shorter line leaves the tail of the previous one
   * visible past its right edge.
   */
  const { paint } = await import('../lib/input-box.mjs');
  const out = { text: '', columns: 80, write(s) { this.text += s; } };
  paint(out, { value: 'x', cursor: 1, columns: 80 }, { atRow: 39 });
  assert.equal((out.text.match(/\x1b\[2K/g) || []).length, 2, 'both rows must be cleared before drawing');
});

test('⭐⭐ PINNED: submitting echoes ABOVE the input and leaves it empty', async () => {
  /**
   * One input, always in the same place, with history flowing upward past it —
   * rather than a trail of boxes with output wedged between them.
   */
  const { readBoxedLine } = await import('../lib/input-box.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const out = { text: '', columns: 80, write(s) { this.text += s; } };

  const done = readBoxedLine({ input, output: out, atRow: 39 });
  await new Promise((r) => setImmediate(r));
  input.write('build it\r');
  const got = await done;

  assert.equal(got.value, 'build it');
  const tail = out.text.slice(out.text.lastIndexOf('build it'));
  assert.match(tail, /\x1b\[39;1H/, 'the input was not repainted at its fixed home after submit');
  assert.match(
    out.text, /\x1b\[38;1H/,
    'the cursor must be parked at the bottom of the SCROLL region so the reply lands above the input',
  );
});

/* ── the slash menu: the discoverability fix ──────────────────────────────── */

test('⭐⭐⭐ typing "/" shows every command — the moment discovery is cheapest', () => {
  /**
   * 28 skills, 7 commands, MCP in both directions — all built, and nothing on
   * screen ever mentioned any of it. A capability nobody is shown is worth zero,
   * which is the same defect as the toolbox and the whiteboard.
   */
  const { lines } = renderBox({ value: '/', cursor: 1, columns: 90 });
  for (const c of ['/help', '/skills', '/mcp', '/cost', '/model', '/clear']) {
    assert.ok(lines[0].includes(c), `the menu omits ${c}: ${lines[0]}`);
  }
});

test('⭐ it NARROWS as you type, and says so when nothing matches', () => {
  assert.ok(renderBox({ value: '/sk', cursor: 3, columns: 90 }).lines[0].includes('/skills'));
  assert.ok(!renderBox({ value: '/sk', cursor: 3, columns: 90 }).lines[0].includes('/mcp'));
  /**
   * ⚠️ Falling back to the full list on a typo would tell somebody who mistyped
   * that everything is fine. Saying nothing matched is what lets them fix it.
   */
  assert.match(renderBox({ value: '/zzz', cursor: 4, columns: 90 }).lines[0], /no command starts with that/);
});

test('⚠️ the menu REPLACES the rule — it never adds a row', () => {
  /**
   * The input lives in a reserved region of fixed height. Growing it would mean
   * resizing the scroll region mid-keystroke, and a region that changes size
   * while a transcript scrolls through it is how a display gets corrupted.
   */
  const plain = renderBox({ value: 'hello', cursor: 5, columns: 90 });
  const menu = renderBox({ value: '/', cursor: 1, columns: 90 });
  assert.equal(menu.lines.length, plain.lines.length, 'the menu changed the row count');
  assert.equal(visibleWidth(menu.lines[0]), visibleWidth(plain.lines[0]), 'the menu row is a different width');
});

test('⚠️ a slash mid-sentence is NOT a command — no menu for "and/or"', () => {
  // The menu keys off a line that IS a command, not one that contains a slash.
  assert.equal(renderBox({ value: 'use and/or here', cursor: 15, columns: 90 }).isCommand, false);
  assert.equal(renderBox({ value: '/help me', cursor: 8, columns: 90 }).isCommand, false);
  assert.equal(renderBox({ value: '/help', cursor: 5, columns: 90 }).isCommand, true);
});

test('⭐⭐ command mode turns the input BRAND GREEN, and only then', async () => {
  const { paint } = await import('../lib/input-box.mjs');
  const { createPainter } = await import('../lib/colour.mjs');
  const brand = createPainter(true).brand;

  const cmd = { columns: 80, text: '', write(s) { this.text += s; } };
  paint(cmd, { value: '/s', cursor: 2, columns: 80 }, { first: true, paintFn: brand });
  assert.match(cmd.text, /\x1b\[38;[25]/, 'command mode is not painted');

  const plain = { columns: 80, text: '', write(s) { this.text += s; } };
  paint(plain, { value: 'hello', cursor: 5, columns: 80 }, { first: true, paintFn: brand });
  assert.doesNotMatch(plain.text, /\x1b\[38;[25]/, 'ordinary typing was painted too — the colour means nothing then');
});

test('⚠️ colour is applied AFTER layout, so it cannot shift a column', async () => {
  /**
   * Escape codes have no width. Colouring a string and THEN padding it aligns
   * the text against invisible bytes and the whole line drifts. `renderBox`
   * stays pure and returns plain text; paint is the only place colour exists.
   */
  const { paint } = await import('../lib/input-box.mjs');
  const { createPainter } = await import('../lib/colour.mjs');
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  const a = { columns: 80, text: '', write(s) { this.text += s; } };
  const b = { columns: 80, text: '', write(s) { this.text += s; } };
  paint(a, { value: '/s', cursor: 2, columns: 80 }, { first: true, paintFn: createPainter(true).brand });
  paint(b, { value: '/s', cursor: 2, columns: 80 }, { first: true });
  assert.equal(strip(a.text), b.text, 'the coloured render does not lay out identically to the plain one');
});
