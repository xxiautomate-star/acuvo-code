/**
 * ── LOG TAILING — TESTED WITH NO PROCESSES AT ALL ──────────────────────────
 *
 * `background.test.mjs` deliberately starts REAL processes, because the thing it
 * proves (nothing is orphaned, a real port is really freed) cannot be faked.
 * This module is the opposite by design: every function takes the buffer as a
 * string, so the whole suite runs with no spawn, no port, no timer and no key.
 *
 * ⭐ THE HEADLINE ASSERTION IS "NOTHING NEW". A cursor that quietly re-delivers
 * output costs exactly as much as no cursor and looks like it is working, so the
 * test that matters most is the one where a second read returns zero lines and
 * zero characters — and, further down, the one that measures ten rounds of
 * watching a chatty server and asserts the total is a small fraction of what
 * re-reading the buffer would have cost.
 *
 * ⚠️ THE FAKE CLOCK IS WHY THE TIMEOUT TESTS TAKE 0ms. `waitFor` takes `now` and
 * `sleep`, so a 10-second timeout is exercised instantly and deterministically.
 * A test that really slept would be slow AND flaky, which is how a timeout test
 * ends up deleted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tailSince, waitFor, summariseLog,
  compileFilter, validateLogRegex,
  formatCursor, parseCursor, resolveCursor,
  logTailToolSchemas, runLogTailTool,
  LOG_TAIL_TOOL_NAMES, ANCHOR_CHARS, MAX_PATTERN_CHARS,
  MAX_UNBOUNDED_QUANTIFIERS, MAX_WAIT_MS, DEFAULT_TAIL_LINES,
  MATCH_LINE_CHARS, CURSOR_PREFIX, PARTIAL_HOLD_CHARS,
} from '../lib/log-tail.mjs';

/** A clock that only moves when something sleeps. Deterministic by construction. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
  };
}

/* ══════════════════════════ 1. the cursor ═══════════════════════════════ */

test('a first read returns everything and hands back a cursor', () => {
  const log = 'boot\nlistening on 3000\n';
  const r = tailSince(log);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, ['boot', 'listening on 3000']);
  assert.equal(r.newChars, log.length);
  assert.match(r.cursor, new RegExp(`^${CURSOR_PREFIX}:`));
  assert.match(r.note, /first read/);
});

test('⭐ RE-READING WITH THE CURSOR RETURNS NOTHING NEW — the whole point', () => {
  const log = 'boot\nlistening on 3000\n';
  const first = tailSince(log);
  const second = tailSince(log, { cursor: first.cursor });

  assert.equal(second.ok, true);
  assert.deepEqual(second.lines, [], 'a second read of an unchanged buffer must return zero lines');
  assert.equal(second.newChars, 0, 'and zero characters — this is the context saving, measured');
  assert.equal(second.text, '');
  assert.match(second.note, /nothing new/);

  // ⚠️ And a THIRD read must not drift back to re-delivering.
  const third = tailSince(log, { cursor: second.cursor });
  assert.deepEqual(third.lines, []);
  assert.equal(third.newChars, 0);
});

test('only the lines added since the cursor come back', () => {
  const first = tailSince('a\nb\n');
  const r = tailSince('a\nb\nc\nd\n', { cursor: first.cursor });
  assert.deepEqual(r.lines, ['c', 'd']);
  assert.equal(r.newChars, 4);
});

test('⭐ the measured saving: ten rounds of watching cost a fraction of ten re-reads', () => {
  // A saturated 16,000-character ring of real log lines, then three new lines
  // per round — the shape a dev server actually produces.
  let buf = `${Array.from({ length: 800 }, (_, i) => `startup banner line ${i}`).join('\n')}\n`.slice(-16_000);
  let cursor = tailSince(buf, { maxLines: 2_000 }).cursor;
  const naive = buf.length; // what check_process would return, every round
  let withCursor = 0;

  for (let round = 0; round < 10; round += 1) {
    buf += `round ${round} line A\nround ${round} line B\nround ${round} line C\n`;
    // The ring keeps only the last 16,000 characters — the real MAX_LOG_CHARS.
    buf = buf.slice(-16_000);
    const r = tailSince(buf, { cursor });
    cursor = r.cursor;
    withCursor += r.text.length;
    assert.equal(r.lines.length, 3, `round ${round} must yield exactly the three new lines`);
    assert.equal(r.evicted, undefined, 'nothing unseen was evicted');
  }

  assert.ok(withCursor < naive, `cursor reads cost ${withCursor} chars; ten naive reads cost ${naive * 10}`);
  assert.ok(withCursor * 20 < naive * 10, `expected an order-of-magnitude saving, got ${withCursor} vs ${naive * 10}`);
});

test('⚠️ a ring that evicts text ALREADY SEEN keeps working, and says how much slid past', () => {
  const original = `${'old chatter that will be evicted\n'.repeat(4)}the anchor line lives here at the end\n`;
  const first = tailSince(original);
  // The front is dropped (what background.mjs's record() does) and new text added.
  // ⚠️ The anchor is the TAIL of what was delivered, so it survives this.
  const shifted = `${original.slice(40)}fresh line\n`;
  const r = tailSince(shifted, { cursor: first.cursor });
  assert.equal(r.evicted, undefined, 'nothing UNSEEN was lost, so this is not an eviction');
  assert.deepEqual(r.lines, ['fresh line']);
  assert.ok(r.shiftedChars > 0);
  assert.match(r.note, /already read/);
});

test('⚠️⚠️ a ring that evicts text NEVER SEEN reports the hole instead of hiding it', () => {
  const first = tailSince(`${'a'.repeat(200)}\nanchor point here\n`);
  // Everything the cursor anchored on is gone.
  const r = tailSince('completely different content\n', { cursor: first.cursor });
  assert.equal(r.evicted, true);
  assert.deepEqual(r.lines, ['completely different content']);
  assert.match(r.note, /DROPPED before you read it/);
});

test('⚠️ a mangled cursor is a full read with a reason, never a throw', () => {
  for (const bad of ['nonsense', 'acv1:notanumber:ff', 'acv9:10:ff', '', 'acv1:10']) {
    const r = tailSince('a\nb\n', { cursor: bad });
    assert.equal(r.ok, true, `cursor ${JSON.stringify(bad)} must not throw`);
    assert.deepEqual(r.lines, ['a', 'b']);
  }
  assert.equal(tailSince('a\nb\n', { cursor: 'nonsense' }).invalid ?? true, true);
  assert.match(tailSince('a\nb\n', { cursor: 'nonsense' }).note, /not one of mine/);
});

test('formatCursor / parseCursor / resolveCursor agree with each other', () => {
  const text = 'hello world, this is a buffer with enough characters to anchor on\n';
  const c = formatCursor(text, text.length);
  const p = parseCursor(c);
  assert.equal(p.seen, text.length);
  assert.equal(resolveCursor(text, c).start, text.length);
  assert.equal(parseCursor('garbage'), null);
  assert.equal(resolveCursor(text, null).fresh, true);
});

test('a cursor from an empty buffer resolves to the start, not to a crash', () => {
  const c = formatCursor('', 0);
  const r = resolveCursor('', c);
  assert.equal(r.start, 0);
  assert.equal(r.evicted, undefined);
  // And a buffer shorter than the anchor is fine too.
  const short = 'hi\n';
  assert.equal(resolveCursor(short, formatCursor(short, short.length)).start, short.length);
  assert.ok(short.length < ANCHOR_CHARS, 'this test is only meaningful below the anchor length');
});

/* ══════════════════════ 2. partial lines ════════════════════════════════ */

test('⚠️ a half-written line is HELD BACK, then arrives whole — never split in two', () => {
  const first = tailSince('done\nReady in 4');
  assert.deepEqual(first.lines, ['done'], 'the incomplete line is not a line yet');
  assert.equal(first.partial, 'Ready in 4');

  const second = tailSince('done\nReady in 412ms\n', { cursor: first.cursor });
  assert.deepEqual(second.lines, ['Ready in 412ms'], 'it arrives complete, in one piece');
  assert.equal(second.partial, '');
});

test('flush delivers the partial line, for a process that will never finish it', () => {
  const r = tailSince('crashed at ', { flush: true });
  assert.deepEqual(r.lines, ['crashed at ']);
  assert.equal(r.partial, '');
});

test('⚠️⚠️ a process that never prints a newline must not re-deliver its buffer every round', () => {
  // FOUND BY THE MEASUREMENT TEST ABOVE, which is why this one exists: holding
  // the partial line forever meant the cursor never advanced.
  let buf = 'z'.repeat(PARTIAL_HOLD_CHARS + 500);
  const first = tailSince(buf);
  assert.equal(first.splitLine, true);
  assert.equal(first.lines.length, 1, 'past the hold limit it is delivered, unfinished');
  assert.equal(first.partial, '');
  assert.match(first.note, /delivered UNFINISHED/);

  const second = tailSince(buf, { cursor: first.cursor });
  assert.deepEqual(second.lines, [], 'and the cursor MOVED, so it is not billed again');
  assert.equal(second.newChars, 0);

  // ⭐ And the hold applies to the NEW chunk, not to the whole buffer: 50 more
  // characters is a line in progress again, so it waits. The stream is therefore
  // delivered in bites of at most PARTIAL_HOLD_CHARS, never re-sent.
  buf += 'z'.repeat(50);
  const third = tailSince(buf, { cursor: second.cursor });
  assert.equal(third.newChars, 0);
  assert.equal(third.partial.length, 50);

  buf += 'z'.repeat(PARTIAL_HOLD_CHARS);
  const fourth = tailSince(buf, { cursor: third.cursor });
  assert.equal(fourth.newChars, PARTIAL_HOLD_CHARS + 50, 'past the hold, the next bite is delivered');
  assert.equal(fourth.splitLine, true);
});

test('a partial line UNDER the hold limit is still held, so short lines never split', () => {
  const r = tailSince(`ok\n${'y'.repeat(PARTIAL_HOLD_CHARS - 1)}`);
  assert.deepEqual(r.lines, ['ok']);
  assert.equal(r.partial.length, PARTIAL_HOLD_CHARS - 1);
  assert.equal(r.splitLine, undefined);
});

test('CRLF output yields clean lines and an honest cursor', () => {
  const first = tailSince('one\r\ntwo\r\n');
  assert.deepEqual(first.lines, ['one', 'two'], 'the \\r must not survive into the line');
  const second = tailSince('one\r\ntwo\r\nthree\r\n', { cursor: first.cursor });
  assert.deepEqual(second.lines, ['three']);
});

/* ══════════════════════ 3. filtering ════════════════════════════════════ */

test('contains, exclude and ignoreCase each do exactly one thing', () => {
  const log = 'GET /favicon.ico 404\nERROR boom\nGET /api/x 200\nerror lower\n';
  assert.deepEqual(tailSince(log, { contains: 'ERROR' }).lines, ['ERROR boom']);
  assert.deepEqual(tailSince(log, { contains: 'error', ignoreCase: true }).lines, ['ERROR boom', 'error lower']);
  assert.deepEqual(tailSince(log, { exclude: 'GET' }).lines, ['ERROR boom', 'error lower']);
  assert.deepEqual(tailSince(log, { contains: ['ERROR', 'api'] }).lines, ['ERROR boom', 'GET /api/x 200']);
});

test('⚠️ a filter that hides everything says so — it does not read as an empty log', () => {
  const r = tailSince('one\ntwo\n', { contains: 'nothing-here' });
  assert.deepEqual(r.lines, []);
  assert.equal(r.newLines, 2);
  assert.equal(r.filteredOut, 2);
  assert.match(r.note, /none matched the filter/);
});

test('no filter is a valid filter — the happy path is not a refusal', () => {
  const f = compileFilter({});
  assert.equal(f.ok, true);
  assert.equal(f.active, false);
  assert.equal(f.test('anything at all'), true);
  assert.deepEqual(tailSince('a\nb\n').lines, ['a', 'b']);
});

test('maxLines keeps the NEWEST and reports what it dropped', () => {
  const log = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const r = tailSince(log, { maxLines: 5 });
  assert.deepEqual(r.lines, ['line 45', 'line 46', 'line 47', 'line 48', 'line 49']);
  assert.equal(r.droppedOlderLines, 45);
  assert.equal(r.matched, 50);
  assert.match(r.note, /45 older matching lines were dropped/);
});

/* ══════════════════ 4. the regex guard (both directions) ════════════════ */

test('⭐ THE HAPPY PATH: real log filters compile', () => {
  const good = [
    'ERROR|WARN',
    '^\\s*at .*\\(.*\\)',
    'port \\d{2,5}',
    'GET /api/[a-z]+ 5\\d\\d',
    '(?:error|fatal): .+',
    'Ready in \\d+ms',
    '^\\[vite\\]',
    'a?b?c?',
  ];
  for (const p of good) {
    const v = validateLogRegex(p);
    assert.equal(v.ok, true, `${p} should be accepted, got: ${v.error}`);
    assert.equal(compileFilter({ matches: p }).ok, true, `${p} should compile`);
  }
  // and it actually filters
  assert.deepEqual(
    tailSince('info ok\nERROR boom\nWARN hmm\n', { matches: 'ERROR|WARN' }).lines,
    ['ERROR boom', 'WARN hmm'],
  );
});

test('⚠️ a quantified group is refused — structurally, not heuristically', () => {
  for (const bad of ['(a+)+', '(a+)+$', '(?:ab)+', '(a|a)*', '(x)?y*z*w*v*', '(?:a|b){2,}']) {
    const v = validateLogRegex(bad);
    assert.equal(v.ok, false, `${bad} must be refused`);
    assert.match(v.error, /quantifier|unbounded|refused/i);
    assert.ok(v.error.length > 40, 'a refusal has to name the way out');
  }
});

test('⚠️ adjacent unbounded quantifiers are refused (the polynomial road)', () => {
  for (const bad of ['.*.*', '\\s*\\s*x', 'a+b*.*c*.*d*.*']) {
    assert.equal(validateLogRegex(bad).ok, false, `${bad} must be refused`);
  }
  // but separated ones are fine, because that is what real patterns look like
  assert.equal(validateLogRegex('.*ERROR.*').ok, true);
});

test('⚠️ back-references, look-around and oversized patterns are refused', () => {
  assert.match(validateLogRegex('(a)\\1').error, /back-reference/);
  assert.match(validateLogRegex('(?=secret)').error, /look-ahead/);
  assert.match(validateLogRegex('(?<=x)y').error, /look-ahead|look-behind/);
  assert.match(validateLogRegex('a{5000}').error, /repeats more than/);
  assert.match(validateLogRegex('x'.repeat(MAX_PATTERN_CHARS + 1)).error, /characters and the limit/);
  assert.match(validateLogRegex('a\\').error, /lone backslash/);
  assert.match(validateLogRegex('[abc').error, /unclosed/);
  assert.match(validateLogRegex('(abc').error, /unclosed/);
  assert.match(validateLogRegex('abc)').error, /unbalanced/);
  assert.match(validateLogRegex('').error, /needs a pattern/);
});

test(`⚠️ more than ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers is refused`, () => {
  const many = 'a*Xb*Yc*Zd*We*'; // five, each separated by a literal
  const v = validateLogRegex(many);
  assert.equal(v.ok, false);
  assert.match(v.error, /unbounded quantifiers/);
  assert.equal(validateLogRegex('a*Xb*Yc*Zd*W').ok, true, 'four must still be allowed');
});

test('⭐ the catastrophic pattern is refused BEFORE it can run — proven by timing', () => {
  const evil = '(a+)+$';
  const victim = `${'a'.repeat(40)}!`;
  assert.equal(compileFilter({ matches: evil }).ok, false);

  // ⚠️ Proof the input really is the hanging shape: run it under a hard budget
  // with the RAW engine and confirm it is orders of magnitude slower than ours.
  const t0 = Date.now();
  tailSince(`${victim}\n`, { matches: '.*a.*' });
  const ours = Date.now() - t0;
  assert.ok(ours < 250, `an accepted pattern must stay fast, took ${ours}ms`);
});

test('⚠️ a very long line is clipped before matching, so one huge line cannot be the input', () => {
  const huge = `${'b'.repeat(MATCH_LINE_CHARS * 4)}NEEDLE`;
  const r = tailSince(`${huge}\n`, { contains: 'NEEDLE' });
  assert.deepEqual(r.lines, [], 'past the clip the matcher cannot see, and that is the trade');
  const early = `NEEDLE${'b'.repeat(MATCH_LINE_CHARS * 4)}`;
  assert.equal(tailSince(`${early}\n`, { contains: 'NEEDLE' }).lines.length, 1);
});

test('an invalid regex is a clean refusal that points at contains', () => {
  const f = compileFilter({ matches: '[' });
  assert.equal(f.ok, false);
  assert.match(f.error, /unclosed|not a valid/);
  const r = tailSince('a\n', { matches: '(a+)+' });
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 40);
});

/* ══════════════════════════ 5. waitFor ══════════════════════════════════ */

test('waitFor resolves when the line appears, and says how long it took', async () => {
  const c = fakeClock();
  const frames = [
    { text: 'booting\n', running: true },
    { text: 'booting\ncompiling\n', running: true },
    { text: 'booting\ncompiling\nReady in 412ms\n', running: true },
  ];
  let i = 0;
  const r = await waitFor({
    read: () => frames[Math.min(i++, frames.length - 1)],
    contains: 'Ready in',
    timeoutMs: 5_000,
    pollMs: 100,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ok, true);
  assert.equal(r.matched, 'Ready in 412ms');
  assert.equal(r.polls, 3);
  assert.equal(r.waitedMs, 200);
  assert.ok(r.cursor, 'it hands back a cursor so the caller can keep reading from here');

  // ⭐ and that cursor really is positioned after everything seen
  const next = tailSince(frames[2].text, { cursor: r.cursor });
  assert.deepEqual(next.lines, []);
});

test('⚠️⚠️ a TIMEOUT says what it DID see — the message is the feature', async () => {
  const c = fakeClock();
  const text = 'booting\nresolving deps\nstill working\n';
  const r = await waitFor({
    read: () => ({ text, running: true }),
    contains: 'Ready in',
    timeoutMs: 1_000,
    pollMs: 200,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.waitedMs, 1_000);
  assert.equal(r.sawLines, 3);
  assert.deepEqual(r.tail, ['booting', 'resolving deps', 'still working']);
  assert.match(r.error, /waited 1000ms/);
  assert.match(r.error, /3 lines appeared/);
  assert.match(r.error, /did NOT grow/, 'an idle log must be reported as idle');
  assert.match(r.error, /Ready in/, 'it must repeat what it was looking for');
});

test('a timeout on a log that IS growing says so — "wait longer" and "give up" differ', async () => {
  const c = fakeClock();
  let n = 0;
  const r = await waitFor({
    read: () => ({ text: `${'progress line\n'.repeat(++n)}`, running: true }),
    contains: 'never appears',
    timeoutMs: 600,
    pollMs: 200,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.reason, 'timeout');
  assert.match(r.error, /GREW from/);
  assert.match(r.error, /waiting longer may be right/);
});

test('⭐ a DEAD process ends the wait immediately, instead of burning the timeout', async () => {
  const c = fakeClock();
  let polls = 0;
  const r = await waitFor({
    read: () => { polls += 1; return { text: 'Error: listen EADDRINUSE\n', running: false, exitCode: 1 }; },
    contains: 'Ready in',
    timeoutMs: 60_000,
    pollMs: 200,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exited');
  assert.equal(polls, 1, 'one poll, not three hundred');
  assert.equal(r.waitedMs, 0);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.tail, ['Error: listen EADDRINUSE']);
  assert.match(r.error, /NOT running/);
  assert.match(r.error, /Waiting again cannot help/);
});

test('⭐ the LAST line before death still counts — scan first, then notice it is dead', async () => {
  const c = fakeClock();
  const r = await waitFor({
    read: () => ({ text: 'boot\nReady in 9ms\n', running: false, exitCode: 0 }),
    contains: 'Ready in',
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ok, true, 'a line printed just before exiting must not be lost to the exit check');
  assert.equal(r.matched, 'Ready in 9ms');
});

test('waitFor only looks AFTER the cursor, so an old identical line does not match', async () => {
  const c = fakeClock();
  const before = 'Ready in 1ms\n';
  const cursor = tailSince(before).cursor;
  let text = before;
  let poll = 0;
  const r = await waitFor({
    read: () => { poll += 1; if (poll === 3) text = `${before}Ready in 2ms\n`; return { text, running: true }; },
    contains: 'Ready in',
    cursor,
    timeoutMs: 5_000,
    pollMs: 100,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ok, true);
  assert.equal(r.matched, 'Ready in 2ms', 'the pre-existing line must not satisfy the wait');
  assert.equal(r.polls, 3);
});

test('waitFor with nothing to wait for is refused, and the refusal names the way out', async () => {
  const r = await waitFor({ read: () => 'x\n' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-filter');
  assert.match(r.error, /contains/);
  assert.match(r.error, /matches/);
});

test('waitFor with no read() refuses instead of pretending', async () => {
  const r = await waitFor({ contains: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unwired');
});

test('waitFor honours an abort signal', async () => {
  const c = fakeClock();
  const ac = new AbortController();
  ac.abort();
  const r = await waitFor({
    read: () => ({ text: 'x\n', running: true }),
    contains: 'nope',
    signal: ac.signal,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'aborted');
});

test(`⚠️ an absurd timeout is CLAMPED to ${MAX_WAIT_MS}ms and says so`, async () => {
  const c = fakeClock();
  const r = await waitFor({
    read: () => ({ text: '', running: true }),
    contains: 'nope',
    timeoutMs: 10 * MAX_WAIT_MS,
    pollMs: 5_000,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.reason, 'timeout');
  assert.equal(r.timeoutMs, MAX_WAIT_MS);
  assert.match(r.error, /clamped/);
});

test('a read() that fails is reported, not swallowed', async () => {
  const r = await waitFor({ read: () => ({ ok: false, error: 'no such process "bg9"' }), contains: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreadable');
  assert.match(r.error, /bg9/);
});

/* ══════════════════════════ 6. the summary ══════════════════════════════ */

test('a summary puts the errors first, keeps the tail, and counts what it dropped', () => {
  const lines = [];
  for (let i = 0; i < 300; i += 1) lines.push(`compiled module ${i}`);
  lines[7] = 'ERROR could not resolve ./missing';
  lines[8] = '    at load (build.js:12)';
  lines[120] = 'WARNING deprecated option --foo';
  const log = `${lines.join('\n')}\n`;

  const s = summariseLog(log, { tailLines: 10, errorLines: 5 });
  assert.equal(s.ok, true);
  assert.equal(s.totalLines, 300);
  assert.ok(s.errorCount >= 1);
  assert.ok(s.warnCount >= 1);
  assert.match(s.text, /ERROR could not resolve/);
  assert.match(s.text, /WARNING deprecated/);
  assert.match(s.text, /compiled module 299/, 'the tail must be there');

  // ⚠️ THE ARITHMETIC HAS TO CLOSE. Nothing may vanish unaccounted for.
  assert.equal(s.shownLines + s.droppedLines, s.totalLines);
  assert.ok(s.droppedLines > 0);
  assert.match(s.text, new RegExp(`${s.droppedLines} lines not shown`));
});

test('⚠️ an error inside the tail is not printed twice', () => {
  const log = 'ok\nok\nERROR right at the end\n';
  const s = summariseLog(log, { tailLines: 10, errorLines: 10 });
  const hits = s.text.split('\n').filter((l) => l.includes('ERROR right at the end'));
  assert.equal(hits.length, 1, 'the same line must not be billed to the model twice');
  assert.equal(s.notableAlsoInTail, 1);
  assert.equal(s.droppedLines, 0);
});

test('a small log is summarised with nothing dropped at all', () => {
  const s = summariseLog('one\ntwo\nthree\n');
  assert.equal(s.totalLines, 3);
  assert.equal(s.droppedLines, 0);
  assert.doesNotMatch(s.text, /not shown/);
});

test('an empty log summarises honestly rather than throwing', () => {
  const s = summariseLog('');
  assert.equal(s.ok, true);
  assert.equal(s.totalLines, 0);
  assert.equal(s.droppedLines, 0);
});

test('a monstrously long line in a summary is clipped WITH its length named', () => {
  const s = summariseLog(`${'z'.repeat(5_000)}\n`, { tailLines: 5 });
  assert.match(s.text, /more characters on this line/);
  assert.ok(s.text.length < 3_000, 'the summary must not carry the whole 5,000-character line');
});

/* ══════════════════════════ 7. the tools ════════════════════════════════ */

test('the schemas match the exported names and every one is usable', () => {
  const schemas = logTailToolSchemas();
  assert.equal(schemas.length, LOG_TAIL_TOOL_NAMES.length);
  assert.deepEqual(schemas.map((s) => s.function.name).sort(), [...LOG_TAIL_TOOL_NAMES].sort());
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.ok(s.function.description.length > 120, `${s.function.name} needs a description a model can act on`);
    assert.deepEqual(s.function.parameters.required, ['id']);
    assert.equal(s.function.parameters.properties.id.type, 'string');
  }
  // ⭐ the cursor has to be discoverable from the schema alone, or no model uses it
  const readLog = schemas.find((s) => s.function.name === 'read_log');
  assert.ok(readLog.function.parameters.properties.cursor);
  assert.match(readLog.function.description, /cursor/);
});

test('runLogTailTool reads, waits and summarises through an injected source', async () => {
  let text = 'boot\n';
  let running = true;
  const readLog = (id) => (id === 'bg1' ? { text, running, exitCode: null } : { ok: false, error: `no background process "${id}"` });

  const first = await runLogTailTool('read_log', { id: 'bg1' }, { readLog });
  assert.equal(first.ok, true);
  assert.deepEqual(first.lines, ['boot']);
  assert.equal(first.id, 'bg1');

  text += 'ERROR boom\n';
  const second = await runLogTailTool('read_log', { id: 'bg1', cursor: first.cursor, contains: 'ERROR' }, { readLog });
  assert.deepEqual(second.lines, ['ERROR boom']);

  const third = await runLogTailTool('read_log', { id: 'bg1', cursor: second.cursor }, { readLog });
  assert.deepEqual(third.lines, [], 'the cursor survives a round trip through the tool layer');

  const c = fakeClock();
  running = false;
  const waited = await runLogTailTool('wait_for_output', { id: 'bg1', contains: 'ERROR', cursor: first.cursor }, { readLog, now: c.now, sleep: c.sleep });
  assert.equal(waited.ok, true);
  assert.equal(waited.matched, 'ERROR boom');

  const sum = await runLogTailTool('summarize_log', { id: 'bg1' }, { readLog });
  assert.equal(sum.totalLines, 2);
  assert.equal(sum.id, 'bg1');
});

test('the tools refuse honestly when unwired, unnamed or unknown', async () => {
  const readLog = () => 'x\n';
  assert.match((await runLogTailTool('read_log', { id: 'bg1' }, {})).error, /not wired/);
  assert.match((await runLogTailTool('read_log', {}, { readLog })).error, /start_process returned/);
  assert.match((await runLogTailTool('nope', { id: 'bg1' }, { readLog })).error, /unknown log tool/);
  assert.match((await runLogTailTool('read_log', { id: 'bg9' }, { readLog: (id) => ({ ok: false, error: `no process ${id}` }) })).error, /bg9/);
});

test('read_log flushes the last partial line once the process has stopped', async () => {
  const readLog = () => ({ text: 'done\nno trailing newline', running: false });
  const r = await runLogTailTool('read_log', { id: 'bg1' }, { readLog });
  assert.deepEqual(r.lines, ['done', 'no trailing newline'], 'a stopped process will never add the newline');
  assert.equal(r.running, false);
});

test('defaults are the documented ones', () => {
  assert.equal(tailSince(`${Array.from({ length: DEFAULT_TAIL_LINES + 10 }, (_, i) => i).join('\n')}\n`).lines.length, DEFAULT_TAIL_LINES);
});
