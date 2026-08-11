/**
 * ── test/compact.test.mjs — THE HORIZON COMPACTOR ───────────────────────────
 *
 * The module under test has ONE property that outranks every other thing it
 * does: an OpenAI-shaped history where an assistant `tool_calls` entry has no
 * answering `tool` message is rejected with an HTTP 400, on that round and
 * every round after it. A compactor that violates it does not degrade the
 * product, it BREAKS the product, and it breaks it in the shape of a provider
 * error that reads like a bug in the prompt.
 *
 * ⚠️ THE PAIRING CHECK IN HERE IS DELIBERATELY WRITTEN TWICE. `compact.mjs`
 * has its own structural guard; this file does NOT import it, and re-derives
 * the rule from scratch. A test that asserts by calling the implementation's
 * own checker proves the checker agrees with itself and nothing else — this
 * repo has been bitten by exactly that shape of false confidence, so the
 * duplication is the point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compactMessages,
  estimateTokens,
  estimateMessagesTokens,
  groupRounds,
  structuralFingerprint,
  CHARS_PER_TOKEN,
} from '../lib/compact.mjs';

/* ── transcript builders ─────────────────────────────────────────────────── */

let idSeq = 0;
const nextId = () => `call_${++idSeq}`;

function call(name, args, id = nextId()) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function assistant(content, calls) {
  return calls ? { role: 'assistant', content, tool_calls: calls } : { role: 'assistant', content };
}

function toolResult(c, content) {
  return { role: 'tool', tool_call_id: c.id, name: c.function.name, content };
}

/** One complete round: an assistant message plus one answered call. */
function round(note, name, args, resultText) {
  const c = call(name, args);
  return [assistant(note, [c]), toolResult(c, resultText)];
}

function head() {
  return [
    { role: 'system', content: 'You are acuvo, a terminal coding agent. Follow the rules.' },
    { role: 'user', content: 'TASK: refactor lib/slug.mjs so slugify handles unicode.' },
  ];
}

const bulk = (label, n) => `${label}\n${'x'.repeat(n)}`;

/**
 * ⚠️ THE INDEPENDENT PAIRING RULE. Re-derived here on purpose (see the header).
 * For every assistant message carrying tool_calls, the messages immediately
 * following it must be `tool` messages whose ids are EXACTLY its call ids, in
 * the same order, with none missing and none extra.
 */
function assertPairing(messages, why = '') {
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const wanted = m.tool_calls.map((c) => c.id);
    const got = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === 'tool') got.push(messages[j++].tool_call_id);
    assert.deepEqual(got, wanted, `tool_call ids must be answered in order at index ${i} ${why}`);
  }
}

/** Deep-freeze so any mutation of the input throws in strict mode (ESM is strict). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/* ── the estimate, and the fact that it is one ───────────────────────────── */

test('estimateTokens is chars/4 and is never presented as exact', () => {
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2, 'partial tokens round up — under-reporting a budget is the dangerous direction');
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(12345), 0, 'a non-string is not silently coerced into a fake measurement');
});

test('estimateMessagesTokens counts content, name, ids and tool_calls — not just content', () => {
  const bare = [{ role: 'user', content: 'hello' }];
  const withCall = [assistant('', [call('read_file', { path: 'a/very/long/path/to/file.mjs' })])];
  assert.ok(estimateMessagesTokens(withCall) > estimateMessagesTokens(bare),
    'a message whose weight is entirely in tool_calls must not estimate as empty');
  assert.equal(estimateMessagesTokens([]), 0);
  assert.equal(estimateMessagesTokens(null), 0);
});

test('the report NAMES the number as an estimate', () => {
  const msgs = [...head(), ...round('reading', 'read_file', { path: 'a.mjs' }, bulk('a.mjs', 40_000))];
  const out = compactMessages(msgs, { budgetTokens: 10, keepLastRounds: 0 });
  assert.match(out.report.method, /estimat/i);
  assert.match(out.report.method, /not a tokeni[sz]er|approximat/i);
});

/* ── structure ───────────────────────────────────────────────────────────── */

test('groupRounds treats the system prompt and the opening task as head, never a round', () => {
  const msgs = [...head(), ...round('r1', 'read_file', { path: 'a.mjs' }, 'body')];
  const g = groupRounds(msgs);
  assert.deepEqual(g.head, [0, 1]);
  assert.equal(g.rounds.length, 1);
  assert.deepEqual(g.rounds[0], [2, 3]);
});

test('groupRounds keeps multiple leading system messages in the head', () => {
  const msgs = [
    { role: 'system', content: 'one' },
    { role: 'system', content: 'two' },
    { role: 'user', content: 'task' },
    ...round('r1', 'read_file', { path: 'a.mjs' }, 'body'),
  ];
  assert.deepEqual(groupRounds(msgs).head, [0, 1, 2]);
});

test('groupRounds survives a transcript with no head at all', () => {
  const g = groupRounds([{ role: 'assistant', content: 'hi' }]);
  assert.deepEqual(g.head, []);
  assert.equal(g.rounds.length, 1);
});

/* ── the do-nothing case, which is most of them ──────────────────────────── */

test('a transcript already under budget is returned COMPLETELY untouched', () => {
  const msgs = [...head(), ...round('r1', 'read_file', { path: 'a.mjs' }, 'short body')];
  const before = JSON.parse(JSON.stringify(msgs));
  const out = compactMessages(msgs, { budgetTokens: 1_000_000 });
  assert.equal(out.dropped, 0);
  assert.equal(out.freedTokens, 0);
  assert.deepEqual(out.messages, before);
  assert.equal(out.report.underBudget, true);
  assert.equal(out.report.actions.length, 0);
});

test('compaction does not mutate its input, even when it compacts hard', () => {
  const msgs = deepFreeze([
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('v1', 30_000)),
    ...round('r2', 'read_file', { path: 'a.mjs' }, bulk('v2', 30_000)),
    ...round('r3', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (1.0s) — PASSED\n--- stdout ---\nok'),
  ]);
  const out = compactMessages(msgs, { budgetTokens: 10, keepLastRounds: 0 });
  assert.ok(out.dropped > 0, 'this fixture must actually exercise the compactor');
  assert.notEqual(out.messages, msgs);
});

test('empty, absent and malformed inputs are refused honestly rather than crashing', () => {
  for (const bad of [[], null, undefined, 'nope', 42, {}]) {
    const out = compactMessages(bad, { budgetTokens: 0 });
    assert.deepEqual(out.messages, Array.isArray(bad) ? [] : []);
    assert.equal(out.dropped, 0);
    assert.equal(out.freedTokens, 0);
    assert.ok(out.report, 'a refusal still reports');
  }
});

test('absent config is a working config — every option defaults', () => {
  const msgs = [...head(), ...round('r1', 'read_file', { path: 'a.mjs' }, 'body')];
  const out = compactMessages(msgs);
  assert.ok(Array.isArray(out.messages));
  assert.equal(out.messages.length, msgs.length);
});

/* ── ⭐ THE INVARIANT ─────────────────────────────────────────────────────── */

test('INVARIANT: every tool_call keeps an answering tool message, in order', () => {
  const c1 = call('read_file', { path: 'a.mjs' });
  const c2 = call('read_file', { path: 'b.mjs' });
  const c3 = call('run_command', { command: 'npm test' });
  const msgs = [
    ...head(),
    assistant('parallel reads', [c1, c2, c3]),
    toolResult(c1, bulk('a.mjs', 20_000)),
    toolResult(c2, bulk('b.mjs', 20_000)),
    toolResult(c3, `$ npm test\nexit code: 1 (2.0s) — FAILED\n--- stderr ---\n${bulk('Error: boom', 20_000)}`),
    ...round('again', 'read_file', { path: 'a.mjs' }, 'fresh a.mjs'),
    ...round('again', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (2.0s) — PASSED'),
    assistant('done', undefined),
  ];
  assertPairing(msgs, '(fixture itself)');
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assertPairing(out.messages, '(after compaction)');
  assert.equal(out.messages.length, msgs.length, 'compaction REPLACES content — it must never remove a message');
});

test('INVARIANT: the structural fingerprint is byte-identical before and after', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('a', 40_000)),
    ...round('r2', 'search_text', { pattern: 'slugify' }, 'lib/slug.mjs:10: function slugify'),
    ...round('r3', 'edit_file', { path: 'lib/slug.mjs' }, 'changed lib/slug.mjs (900 bytes)'),
    ...round('r4', 'read_file', { path: 'a.mjs' }, 'a again'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.equal(structuralFingerprint(out.messages), structuralFingerprint(msgs));
  assert.equal(out.report.pairing.ok, true);
});

test('INVARIANT: no tool result is ever left empty', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('a', 50_000)),
    ...round('r2', 'read_file', { path: 'a.mjs' }, bulk('a', 50_000)),
    ...round('r3', 'read_file', { path: 'a.mjs' }, 'final'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  for (const m of out.messages) {
    if (m.role !== 'tool') continue;
    assert.equal(typeof m.content, 'string');
    assert.ok(m.content.trim().length > 0, 'a blank tool result is an unexplained hole in the history');
  }
});

test('an input that ALREADY has a dangling tool_call is reported, not silently repaired or worsened', () => {
  const c = call('run_command', { command: 'rm -rf build' });
  const msgs = [...head(), assistant('interrupted', [c])]; // no answering tool message
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.equal(out.report.inputPairing.ok, false, 'the caller must be told the history arrived broken');
  assert.equal(out.messages.length, msgs.length, 'compaction is not a repair tool — it does not remove the dangling call');
  assert.equal(structuralFingerprint(out.messages), structuralFingerprint(msgs));
});

test('an orphan tool message (no declaring call) does not crash the compactor', () => {
  const msgs = [...head(), { role: 'tool', tool_call_id: 'ghost', name: 'read_file', content: bulk('x', 30_000) }];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.equal(out.messages.length, msgs.length);
  assert.equal(out.report.inputPairing.ok, true, 'an orphan result breaks no PAIRING rule — only an unanswered call does');
});

/* ── pass 1: superseded reads ────────────────────────────────────────────── */

test('the same file read three times keeps the LAST and stubs the earlier two', () => {
  const msgs = [
    ...head(),
    ...round('look', 'read_file', { path: 'lib/slug.mjs' }, bulk('VERSION ONE', 20_000)),
    ...round('look', 'read_file', { path: 'lib/slug.mjs' }, bulk('VERSION TWO', 20_000)),
    ...round('look', 'read_file', { path: 'lib/slug.mjs' }, 'VERSION THREE — the current one'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const tools = out.messages.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /lib\/slug\.mjs/, 'the stub must NAME the file');
  assert.match(tools[0].content, /superseded|read again later/i);
  assert.ok(!tools[0].content.includes('VERSION ONE'), 'the stale body is gone');
  assert.ok(!tools[1].content.includes('VERSION TWO'));
  assert.equal(tools[2].content, 'VERSION THREE — the current one', 'the newest read is untouched');
  assert.equal(out.dropped, 2);
});

test('a stub is ONE LINE and vastly smaller than what it replaced', () => {
  const msgs = [
    ...head(),
    ...round('look', 'read_file', { path: 'a.mjs' }, bulk('body', 60_000)),
    ...round('look', 'read_file', { path: 'a.mjs' }, 'fresh'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const stub = out.messages.filter((m) => m.role === 'tool')[0];
  assert.ok(stub.content.length < 400, `stub was ${stub.content.length} chars`);
  assert.ok(out.freedTokens > 10_000);
});

test('path spelling differences still count as the same file', () => {
  const msgs = [
    ...head(),
    ...round('look', 'read_file', { path: './lib/slug.mjs' }, bulk('old', 30_000)),
    ...round('look', 'read_file', { path: 'lib\\slug.mjs' }, 'new'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.equal(out.dropped, 1);
});

test('⚠️ DIFFERENT WINDOWS OF THE SAME FILE ARE NOT SUPERSEDED — this is the check-that-fails-correct-work trap', () => {
  const msgs = [
    ...head(),
    ...round('look', 'read_lines', { path: 'big.mjs', offset: 1, limit: 200 }, bulk('LINES 1-200', 30_000)),
    ...round('look', 'read_lines', { path: 'big.mjs', offset: 201, limit: 200 }, bulk('LINES 201-400', 30_000)),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const tools = out.messages.filter((m) => m.role === 'tool');
  assert.ok(tools[0].content.includes('LINES 1-200'),
    'window 1-200 is not a stale copy of window 201-400; calling it superseded would delete real, current information');
  assert.ok(!/superseded/i.test(tools[0].content));
});

test('an identical windowed read IS superseded', () => {
  const msgs = [
    ...head(),
    ...round('look', 'read_lines', { path: 'big.mjs', offset: 1, limit: 200 }, bulk('OLD', 30_000)),
    ...round('look', 'read_lines', { path: 'big.mjs', offset: 1, limit: 200 }, 'NEW'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.equal(out.dropped, 1);
  assert.match(out.messages.filter((m) => m.role === 'tool')[0].content, /superseded/i);
});

test('a read of a DIFFERENT file is never touched by supersession', () => {
  const msgs = [
    ...head(),
    ...round('look', 'read_file', { path: 'a.mjs' }, bulk('A BODY', 30_000)),
    ...round('look', 'read_file', { path: 'b.mjs' }, bulk('B BODY', 30_000)),
  ];
  const out = compactMessages(msgs, { budgetTokens: 1_000_000_000, keepLastRounds: 0 });
  assert.equal(out.dropped, 0);
});

/* ── pass 2: stale command output ────────────────────────────────────────── */

const FAILING_RUN = [
  '$ npm test',
  'exit code: 1 (12.4s) — FAILED',
  '--- stdout ---',
  'ok 1 - alpha',
  'ok 2 - beta',
  ...Array.from({ length: 900 }, (_, i) => `ok ${i + 3} - filler assertion number ${i}`),
  'not ok 903 - slugify handles unicode',
  '  AssertionError: expected "cafe" to equal "café"',
  ...Array.from({ length: 900 }, (_, i) => `ok ${i + 904} - trailing filler ${i}`),
].join('\n');

test('a superseded command run keeps its exit code and its first failing line, and drops the body', () => {
  const msgs = [
    ...head(),
    ...round('test it', 'run_command', { command: 'npm test' }, FAILING_RUN),
    ...round('test it', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (11.9s) — PASSED\n--- stdout ---\nall good'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const stale = out.messages.filter((m) => m.role === 'tool')[0];
  assert.match(stale.content, /exit code: 1/, 'the exit code is the single most useful fact and must survive');
  assert.match(stale.content, /not ok 903 - slugify handles unicode/, 'the first failing line must survive');
  assert.ok(!stale.content.includes('filler assertion number 500'), 'the body is gone');
  assert.match(stale.content, /superseded|re-?run later/i);
  assert.ok(stale.content.length < FAILING_RUN.length / 10);
});

test('⚠️ REGRESSION: a PASSING line that merely contains the word "assertion" is not mistaken for the failure', () => {
  // The first cut of the failure detector was /(error|failed|assertion|…)/i and it
  // matched "ok 3 - filler assertion number 0" — so the one line the compactor
  // preserved as evidence was a PASS, and the real failure was dropped. A stale
  // result that keeps the wrong line is worse than one that keeps none.
  const msgs = [
    ...head(),
    ...round('t', 'run_command', { command: 'npm test' }, FAILING_RUN),
    ...round('t', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (1.0s) — PASSED'),
  ];
  const stale = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 })
    .messages.filter((m) => m.role === 'tool')[0];
  assert.ok(!stale.content.includes('ok 3 - filler assertion number 0'));
  assert.match(stale.content, /not ok 903/);
});

test('common runner failure formats are all recognised', () => {
  const formats = {
    jest: 'FAIL src/app.test.js',
    vitest: ' ✗ src/thing.spec.ts > works',
    tsc: 'lib/a.ts(3,5): error TS2345: Argument of type string',
    eslint: '  3:5  error  \'x\' is not defined  no-undef',
    node: 'Error: ENOENT: no such file or directory',
    python: 'Traceback (most recent call last)',
    go: 'panic: runtime error: index out of range',
    npm: 'npm ERR! code ELIFECYCLE',
    mocha: '  1) slugify handles unicode',
  };
  for (const [runner, line] of Object.entries(formats)) {
    const body = `$ npm test\nexit code: 1 (1.0s) — FAILED\n--- stdout ---\n${'noise line\n'.repeat(3_000)}${line}\n${'more\n'.repeat(3_000)}`;
    const msgs = [
      ...head(),
      ...round('t', 'run_command', { command: 'npm test' }, body),
      ...round('t', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (1.0s) — PASSED'),
    ];
    const stale = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 })
      .messages.filter((m) => m.role === 'tool')[0];
    assert.ok(stale.content.includes(line), `${runner}: the failing line "${line}" must survive`);
  }
});

test('ordinary prose containing the word "failed" does not hijack the failing line', () => {
  const body = [
    '$ npm test',
    'exit code: 1 (1.0s) — FAILED',
    '--- stdout ---',
    'ok 1 - retries after a failed connection',
    'ok 2 - reports the error message to the user',
    ...Array.from({ length: 3_000 }, (_, i) => `ok ${i + 3} - filler ${i}`),
    'not ok 3003 - the real failure',
  ].join('\n');
  const msgs = [
    ...head(),
    ...round('t', 'run_command', { command: 'npm test' }, body),
    ...round('t', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (1.0s) — PASSED'),
  ];
  const stale = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 })
    .messages.filter((m) => m.role === 'tool')[0];
  assert.match(stale.content, /not ok 3003 - the real failure/);
  assert.ok(!stale.content.includes('retries after a failed connection'));
});

test('a superseded run that TIMED OUT keeps the timeout line', () => {
  const timedOut = `$ npm test\nTIMED OUT after 120s and was killed. It produced no exit code.\n${bulk('noise', 40_000)}`;
  const msgs = [
    ...head(),
    ...round('t', 'run_command', { command: 'npm test' }, timedOut),
    ...round('t', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (1.0s) — PASSED'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.match(out.messages.filter((m) => m.role === 'tool')[0].content, /TIMED OUT/);
});

test('a superseded run with NO failing line still keeps its header and says so', () => {
  const passing = `$ npm test\nexit code: 0 (3.0s) — PASSED\n--- stdout ---\n${bulk('ok', 40_000)}`;
  const msgs = [
    ...head(),
    ...round('t', 'run_command', { command: 'npm test' }, passing),
    ...round('t', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (3.0s) — PASSED'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const stale = out.messages.filter((m) => m.role === 'tool')[0];
  assert.match(stale.content, /exit code: 0/);
  assert.ok(stale.content.length < 500);
});

test('a command run only ONCE is never gutted by the stale-command pass', () => {
  const msgs = [
    ...head(),
    ...round('t', 'run_command', { command: 'npm test' }, FAILING_RUN),
    ...round('t', 'run_command', { command: 'npm run lint' }, '$ npm run lint\nexit code: 0 (1.0s) — PASSED'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 1_000_000_000, keepLastRounds: 0 });
  assert.equal(out.dropped, 0, 'the only record of that run is not stale — it is the record');
});

/* ── pass 3: giant results ───────────────────────────────────────────────── */

test('a giant one-off result is clamped head-and-tail and SAYS how much was removed', () => {
  const body = `HEAD-MARKER\n${'m'.repeat(60_000)}\nTAIL-MARKER`;
  const msgs = [...head(), ...round('r', 'fetch_url', { url: 'https://x' }, body)];
  const out = compactMessages(msgs, { budgetTokens: 100, keepLastRounds: 0, maxResultChars: 2_000 });
  const clamped = out.messages.filter((m) => m.role === 'tool')[0];
  assert.ok(clamped.content.startsWith('HEAD-MARKER'), 'the head survives');
  assert.ok(clamped.content.endsWith('TAIL-MARKER'), 'the tail survives');
  assert.match(clamped.content, /\b\d[\d,]* characters removed/, 'silence about a cut is the dishonesty this repo hunts');
  assert.ok(clamped.content.length < 3_000);
});

test('a result at or under maxResultChars is left exactly alone', () => {
  const body = 'z'.repeat(2_000);
  const msgs = [...head(), ...round('r', 'fetch_url', { url: 'https://x' }, body)];
  // ⚠️ A REACHABLE budget on purpose. With budget 0 the clamp TIGHTENS below
  // maxResultChars — correctly, because the caller asked for the impossible —
  // and this test is about the threshold, not about the tightening. Asserting
  // the boundary under an unreachable budget would be testing the wrong thing.
  const out = compactMessages(msgs, { budgetTokens: 1_000, keepLastRounds: 0, maxResultChars: 2_000 });
  assert.equal(out.messages.filter((m) => m.role === 'tool')[0].content, body);
  assert.equal(out.report.tightenRounds, 0);
});

test('clamping never splits a surrogate pair — emoji survive as emoji', () => {
  const body = `${'👍'.repeat(20_000)}END`;
  const msgs = [...head(), ...round('r', 'fetch_url', { url: 'https://x' }, body)];
  const out = compactMessages(msgs, { budgetTokens: 10, keepLastRounds: 0, maxResultChars: 1_000 });
  const text = out.messages.filter((m) => m.role === 'tool')[0].content;
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), 'a lone high surrogate is a corrupted character');
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), 'a lone low surrogate is a corrupted character');
});

test('CRLF content is preserved, not silently normalised', () => {
  const body = `line one\r\nline two\r\n${'p'.repeat(40_000)}\r\nlast line`;
  const msgs = [...head(), ...round('r', 'fetch_url', { url: 'https://x' }, body)];
  const out = compactMessages(msgs, { budgetTokens: 10, keepLastRounds: 0, maxResultChars: 2_000 });
  const text = out.messages.filter((m) => m.role === 'tool')[0].content;
  assert.ok(text.includes('line one\r\nline two\r\n'), 'CRLF must survive a clamp');
});

test('non-ASCII text is counted and clamped without corruption', () => {
  const body = `café ${'日本語のテキスト'.repeat(5_000)} 終わり`;
  const msgs = [...head(), ...round('r', 'fetch_url', { url: 'https://x' }, body)];
  const out = compactMessages(msgs, { budgetTokens: 10, keepLastRounds: 0, maxResultChars: 1_000 });
  const text = out.messages.filter((m) => m.role === 'tool')[0].content;
  assert.ok(text.startsWith('café '));
  assert.ok(text.endsWith('終わり'));
});

test('a tool result whose content is not a string is never rewritten', () => {
  const c = call('read_file', { path: 'a.mjs' });
  const msgs = [
    ...head(),
    assistant('', [c]),
    { role: 'tool', tool_call_id: c.id, name: 'read_file', content: [{ type: 'text', text: 'structured' }] },
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.deepEqual(out.messages[3].content, [{ type: 'text', text: 'structured' }]);
});

/* ── pass 4: dead searches ───────────────────────────────────────────────── */

const HITS = [
  'lib/slug.mjs:10: export function slugify(s) {',
  'lib/slug.mjs:22:   return slugify(name);',
  'test/slug.test.mjs:4: import { slugify } from',
  ...Array.from({ length: 400 }, (_, i) => `vendor/copy${i}.mjs:1: slugify`),
].join('\n');

test('a search whose hits were then opened is stubbed, and the stub names the query', () => {
  const msgs = [
    ...head(),
    ...round('find it', 'search_text', { pattern: 'slugify' }, HITS),
    ...round('open it', 'read_file', { path: 'lib/slug.mjs' }, 'the file'),
    ...round('fix it', 'edit_file', { path: 'lib/slug.mjs' }, 'changed lib/slug.mjs (900 bytes)'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const stub = out.messages.filter((m) => m.role === 'tool')[0];
  assert.match(stub.content, /slugify/, 'the stub must name what was searched for');
  assert.match(stub.content, /lib\/slug\.mjs/, 'the stub must name a file that was acted on');
  assert.ok(!stub.content.includes('vendor/copy300.mjs'), 'the hit list is gone');
});

test('a search whose hits were NEVER opened keeps its hit list', () => {
  const msgs = [
    ...head(),
    ...round('find it', 'search_text', { pattern: 'slugify' }, HITS),
    ...round('unrelated', 'read_file', { path: 'README.md' }, 'readme'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 1_000_000_000, keepLastRounds: 0 });
  assert.ok(out.messages.filter((m) => m.role === 'tool')[0].content.includes('vendor/copy300.mjs'),
    'an unfollowed search is the only record of where the thing lives — deleting it deletes the finding');
});

test('a file opened BEFORE the search does not make the search dead', () => {
  const msgs = [
    ...head(),
    ...round('open first', 'read_file', { path: 'lib/slug.mjs' }, 'the file'),
    ...round('find it', 'search_text', { pattern: 'slugify' }, HITS),
  ];
  const out = compactMessages(msgs, { budgetTokens: 1_000_000_000, keepLastRounds: 0 });
  const searchResult = out.messages.filter((m) => m.role === 'tool')[1];
  assert.ok(searchResult.content.includes('vendor/copy300.mjs'), 'acting earlier is not acting on the result');
});

/* ── what must never be compacted ────────────────────────────────────────── */

test('the system prompt and the opening task are never rewritten, at any budget', () => {
  const msgs = [
    ...head(),
    ...round('r', 'read_file', { path: 'a.mjs' }, bulk('a', 50_000)),
    ...round('r', 'read_file', { path: 'a.mjs' }, 'fresh'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.equal(out.messages[0].content, msgs[0].content);
  assert.equal(out.messages[1].content, msgs[1].content);
});

test('the last keepLastRounds tool rounds are kept verbatim', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('ONE', 30_000)),
    ...round('r2', 'read_file', { path: 'a.mjs' }, bulk('TWO', 30_000)),
    ...round('r3', 'read_file', { path: 'a.mjs' }, bulk('THREE', 30_000)),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 2 });
  const tools = out.messages.filter((m) => m.role === 'tool');
  assert.ok(!tools[0].content.includes('ONE'), 'the oldest round is fair game');
  assert.ok(tools[1].content.includes('TWO'), 'round 2 is inside the keep window');
  assert.ok(tools[2].content.includes('THREE'));
  assert.equal(out.dropped, 1);
});

test('keepLastRounds larger than the transcript protects everything', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('ONE', 30_000)),
    ...round('r2', 'read_file', { path: 'a.mjs' }, bulk('TWO', 30_000)),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 99 });
  assert.equal(out.dropped, 0);
  assert.equal(out.report.compactableResults, 0);
});

test('a NEGATIVE keepLastRounds is clamped to zero rather than inverting the window', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('ONE', 30_000)),
    ...round('r2', 'read_file', { path: 'a.mjs' }, 'fresh'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: -5 });
  assert.equal(out.dropped, 1);
});

test('anything the NEWEST assistant message names is protected even when stale', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'lib/slug.mjs' }, bulk('THE STALE COPY', 30_000)),
    ...round('r2', 'read_file', { path: 'lib/other.mjs' }, bulk('OTHER', 30_000)),
    ...round('r3', 'read_file', { path: 'lib/slug.mjs' }, bulk('NEWER', 30_000)),
    assistant('I still need the earlier version of lib/slug.mjs to compare against.', undefined),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const tools = out.messages.filter((m) => m.role === 'tool');
  assert.ok(tools[0].content.includes('THE STALE COPY'),
    'the model said it needs that file by name — compacting it is deleting the thing it just asked for');
  assert.ok(out.report.protectedByReference.includes('lib/slug.mjs'));
});

/* ── budget behaviour ────────────────────────────────────────────────────── */

test('compaction stops the moment it is under budget — it never destroys more than it must', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('A1', 40_000)),
    ...round('r2', 'read_file', { path: 'b.mjs' }, bulk('B1', 40_000)),
    ...round('r3', 'read_file', { path: 'c.mjs' }, bulk('C1', 40_000)),
    ...round('r4', 'read_file', { path: 'a.mjs' }, 'a fresh'),
    ...round('r5', 'read_file', { path: 'b.mjs' }, 'b fresh'),
    ...round('r6', 'read_file', { path: 'c.mjs' }, 'c fresh'),
  ];
  const hard = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const gentle = compactMessages(msgs, { budgetTokens: 25_000, keepLastRounds: 0 });
  assert.equal(hard.dropped, 3);
  assert.equal(gentle.dropped, 1, 'one 40KB stub is enough to get under 25k tokens; taking the other two is gratuitous');
  assert.ok(gentle.report.underBudget);
});

/**
 * ⚠️⭐ MEASURED ON A REAL 23-MESSAGE SESSION, NOT INVENTED. Twelve unique large
 * `read_file` results, nothing re-read, nothing searched — so the only pass with
 * anything to attack was `giant-results`, and with a FIXED clamp it plateaued at
 * 22.1% freed no matter how low the budget went: 33,128 → 25,816 tokens at a
 * budget of 24,000, and the identical 25,816 at a budget of 8,000.
 *
 * That plateau is the module failing at its actual job. The floor of a fixed
 * clamp is `maxResultChars × compactable results`, and at the raised horizon this
 * module exists to unlock — 60 rounds, 100+ results — the floor is larger than
 * any sane budget. The session bursts anyway, and the compactor reports a
 * cheerful percentage while it happens.
 */
test('⭐ the clamp TIGHTENS when a fixed one cannot reach the budget', () => {
  const msgs = [...head()];
  for (let i = 0; i < 12; i += 1) {
    // Twelve DIFFERENT files: nothing superseded, nothing dead. Clamping is the
    // only cut available, exactly as in the measured session.
    msgs.push(...round(`r${i}`, 'read_file', { path: `lib/mod${i}.mjs` }, bulk(`module ${i}`, 8_000)));
  }
  // ⚠️ keepLastRounds is a HARD FLOOR and the first draft of this test forgot it:
  // two protected rounds of 8,000 characters are ~4,000 tokens on their own, so
  // a 4,000-token budget was never reachable and the implementation was right to
  // say so. Protection wins over the budget, always.
  const out = compactMessages(msgs, { budgetTokens: 4_000, keepLastRounds: 0, maxResultChars: 4_000 });
  assert.equal(out.report.underBudget, true, 'a reachable budget must actually be reached');
  assert.ok(out.report.afterTokens <= 4_000);
  assert.ok(out.report.clampChars < 4_000, 'the report must say the clamp was tightened and to what');
  assert.ok(out.report.clampChars >= 200, 'it must not tighten to nothing — a stub with no content is a hole');
  assert.ok(out.report.tightenRounds > 0);
});

test('⭐ the plateau is gone: a FIXED clamp floors at maxResultChars × results, tightening does not', () => {
  const msgs = [...head()];
  for (let i = 0; i < 12; i += 1) msgs.push(...round(`r${i}`, 'read_file', { path: `lib/mod${i}.mjs` }, bulk(`module ${i}`, 8_000)));
  // The measured symptom: lowering the budget changed nothing at all.
  const loose = compactMessages(msgs, { budgetTokens: 6_000, keepLastRounds: 0, maxResultChars: 4_000 });
  const tight = compactMessages(msgs, { budgetTokens: 2_000, keepLastRounds: 0, maxResultChars: 4_000 });
  assert.ok(tight.report.afterTokens < loose.report.afterTokens,
    'a lower budget must actually compact further — a plateau means the compactor stopped working and kept reporting');
  assert.ok(tight.report.clampChars < loose.report.clampChars);
});

test('the protected rounds are a hard floor that the budget cannot override', () => {
  const msgs = [...head()];
  for (let i = 0; i < 6; i += 1) msgs.push(...round(`r${i}`, 'read_file', { path: `m${i}.mjs` }, bulk(`mod ${i}`, 20_000)));
  const out = compactMessages(msgs, { budgetTokens: 10, keepLastRounds: 2, maxResultChars: 4_000 });
  const tools = out.messages.filter((m) => m.role === 'tool');
  assert.ok(tools[4].content.includes('x'.repeat(19_000)), 'the second-newest round is verbatim');
  assert.ok(tools[5].content.includes('x'.repeat(19_000)), 'the newest round is verbatim');
  assert.equal(out.report.underBudget, false, 'and it says the budget was not reached rather than sacrificing them');
});

test('a tightened clamp still says how much it removed, and does not nest its own markers', () => {
  const msgs = [...head()];
  for (let i = 0; i < 12; i += 1) msgs.push(...round(`r${i}`, 'read_file', { path: `m${i}.mjs` }, `START${i}\n${'y'.repeat(8_000)}\nEND${i}`));
  const out = compactMessages(msgs, { budgetTokens: 4_000, keepLastRounds: 0, maxResultChars: 4_000 });
  for (const m of out.messages) {
    if (m.role !== 'tool') continue;
    const markers = (m.content.match(/characters removed from the MIDDLE/g) ?? []).length;
    assert.ok(markers <= 1, 'a re-clamped result must be recomputed from the ORIGINAL, never clamped on top of a clamp');
  }
  // and each index appears exactly once in the action list, with honest arithmetic
  const seen = new Set();
  for (const a of out.report.actions) {
    assert.ok(!seen.has(a.index), `index ${a.index} reported twice`);
    seen.add(a.index);
    assert.equal(a.afterChars, out.messages[a.index].content.length);
    assert.equal(a.beforeChars, msgs[a.index].content.length);
  }
});

test('tightening never touches a stub that a cheaper pass already made', () => {
  const msgs = [...head()];
  msgs.push(...round('r0', 'read_file', { path: 'shared.mjs' }, bulk('OLD', 8_000)));
  for (let i = 0; i < 12; i += 1) msgs.push(...round(`r${i}`, 'read_file', { path: `m${i}.mjs` }, bulk(`mod ${i}`, 8_000)));
  msgs.push(...round('again', 'read_file', { path: 'shared.mjs' }, 'the fresh copy'));
  const out = compactMessages(msgs, { budgetTokens: 3_000, keepLastRounds: 0, maxResultChars: 4_000 });
  const superseded = out.report.actions.find((a) => a.subject === 'shared.mjs' && a.pass === 'superseded-reads');
  assert.ok(superseded, 'the superseded read must still be stubbed by its own pass');
  assert.match(out.messages[superseded.index].content, /superseded/i,
    'a clamp must never overwrite a stub — the stub is smaller AND more informative');
});

/**
 * ⚠️⚠️ THIS TEST EXISTS BECAUSE THE PREVIOUS ONE DID NOT BITE. Mutating the
 * guard to `if (prior && !allowReclamp) return false` — deliberately letting a
 * clamp overwrite an earlier pass's stub — left all 55 tests GREEN. The reason:
 * a superseded-read stub is ~300 characters and any clamp is longer, so the
 * "does this actually shrink it?" guard caught the mutation by accident, and the
 * test proved nothing about the rule it claimed to protect.
 *
 * ⭐ A GUTTED COMMAND RESULT IS THE CASE THAT ACTUALLY BITES. It keeps the exit
 * code AND a failing line that may be long, so it can be ~900 characters — bigger
 * than a tightened 400-character clamp. A clamp overwriting it silently throws
 * away the exit status and the reason the build broke, which is the single most
 * useful thing in the whole transcript, and replaces them with the first 240
 * characters of a test runner's banner.
 */
test('⚠️ a tightened clamp must not overwrite a GUTTED COMMAND RESULT, which is bigger than the clamp', () => {
  const longFailure = `not ok 41 - ${'the assertion message is extremely long and descriptive '.repeat(6)}`;
  const staleRun = [
    '$ npm test',
    'exit code: 1 (30.0s) — FAILED',
    '--- stdout ---',
    ...Array.from({ length: 400 }, (_, i) => `ok ${i + 1} - filler ${i}`),
    longFailure,
    ...Array.from({ length: 400 }, (_, i) => `ok ${i + 500} - more filler ${i}`),
  ].join('\n');

  const msgs = [...head()];
  msgs.push(...round('run', 'run_command', { command: 'npm test' }, staleRun));
  // enough unique bulk to force the clamp all the way down to its floor
  for (let i = 0; i < 14; i += 1) msgs.push(...round(`r${i}`, 'read_file', { path: `m${i}.mjs` }, bulk(`mod ${i}`, 9_000)));
  msgs.push(...round('run again', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (29.0s) — PASSED'));

  const out = compactMessages(msgs, { budgetTokens: 1_500, keepLastRounds: 0, maxResultChars: 4_000 });
  assert.ok(out.report.tightenRounds > 0, 'the fixture must actually drive the clamp down');

  const gutted = out.messages.filter((m) => m.role === 'tool')[0];
  assert.ok(gutted.content.length > out.report.clampChars,
    `the fixture only bites if the gutted result (${gutted.content.length}) is bigger than the clamp (${out.report.clampChars})`);
  assert.match(gutted.content, /exit code: 1/, 'the exit status must survive tightening');
  assert.ok(gutted.content.includes(longFailure.slice(0, 60)), 'the failing line must survive tightening');
  assert.match(gutted.content, /stale command output/, 'and it must still be the stale-command stub, not a clamp');
});

/**
 * ⚠️⚠️ ALSO WRITTEN BECAUSE A MUTATION SURVIVED. Feeding the tightening pass the
 * WORKING array instead of the originals left all tests green: re-clamping a
 * clamped body happens to cut the old marker out of the middle, so the
 * "no nested markers" assertion never fired. What it does break is the
 * ARITHMETIC — "N characters removed" would be measured against the previous
 * clamp, not the original, and the message would understate its own cut. A
 * number that is quietly wrong is precisely the failure mode this package
 * refuses to ship, so it gets an exact check rather than a shape check.
 */
test('⚠️ the "N characters removed" figure is EXACT against the original, even after tightening', () => {
  const msgs = [...head()];
  for (let i = 0; i < 14; i += 1) {
    msgs.push(...round(`r${i}`, 'read_file', { path: `m${i}.mjs` }, `START${i}\n${'w'.repeat(9_000)}\nEND${i}`));
  }
  const out = compactMessages(msgs, { budgetTokens: 1_500, keepLastRounds: 0, maxResultChars: 4_000 });
  assert.ok(out.report.tightenRounds > 0, 'the fixture must actually drive tightening');

  const MARKER = /\n\n\[… ([\d,]+) characters removed from the MIDDLE of this [^\]]*…\]\n\n/;
  let checked = 0;
  for (const a of out.report.actions) {
    const text = out.messages[a.index].content;
    const m = text.match(MARKER);
    assert.ok(m, `index ${a.index} should carry exactly one removal marker`);
    const stated = Number(m[1].replace(/,/g, ''));
    const verbatimKept = text.length - m[0].length;
    const original = msgs[a.index].content.length;
    assert.equal(stated, original - verbatimKept,
      `index ${a.index}: the message claims ${stated} removed, but ${original} - ${verbatimKept} = ${original - verbatimKept} were actually removed`);
    checked += 1;
  }
  assert.ok(checked >= 10, `only ${checked} clamped results were checked — the fixture is not exercising this`);
});

test('when compaction cannot reach the budget it says so instead of pretending', () => {
  const msgs = [...head(), ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('ONLY COPY', 200_000))];
  const out = compactMessages(msgs, { budgetTokens: 100, keepLastRounds: 1 });
  assert.equal(out.report.underBudget, false);
  assert.ok(out.report.afterTokens > 100);
});

test('freedTokens is exactly beforeTokens minus afterTokens', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('A', 50_000)),
    ...round('r2', 'read_file', { path: 'a.mjs' }, 'fresh'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.equal(out.report.beforeTokens, estimateMessagesTokens(msgs));
  assert.equal(out.report.afterTokens, estimateMessagesTokens(out.messages));
  assert.equal(out.freedTokens, out.report.beforeTokens - out.report.afterTokens);
  assert.equal(out.report.freedPercent, Math.round((out.freedTokens / out.report.beforeTokens) * 1000) / 10);
});

test('compaction is deterministic — no clock, no randomness', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('A', 40_000)),
    ...round('r2', 'run_command', { command: 'npm test' }, FAILING_RUN),
    ...round('r3', 'read_file', { path: 'a.mjs' }, 'fresh'),
    ...round('r4', 'run_command', { command: 'npm test' }, '$ npm test\nexit code: 0 (1.0s) — PASSED'),
  ];
  const a = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  const b = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.deepEqual(a.messages, b.messages);
  assert.deepEqual(a.report, b.report);
});

test('a large transcript compacts in reasonable time and stays well-formed', () => {
  const msgs = [...head()];
  for (let i = 0; i < 300; i += 1) {
    msgs.push(...round(`r${i}`, 'read_file', { path: `file${i % 20}.mjs` }, bulk(`body ${i}`, 4_000)));
  }
  const started = process.hrtime.bigint();
  const out = compactMessages(msgs, { budgetTokens: 5_000, keepLastRounds: 2 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assertPairing(out.messages, '(300-round transcript)');
  assert.ok(out.freedTokens > 0);
  assert.ok(ms < 5_000, `compaction took ${ms.toFixed(0)}ms`);
});

test('⭐ a PROVABLY DEAD search is sacrificed before a LIVE file read is gutted', () => {
  // The loop stops as soon as the transcript fits, so pass order decides which
  // single cut gets made. Cutting the middle out of the only copy of a live file
  // when a provably-finished search list is sitting right there is the worse of
  // the two available cuts, every time.
  const msgs = [
    ...head(),
    ...round('search', 'search_text', { pattern: 'slugify' }, HITS),
    ...round('open', 'read_file', { path: 'lib/slug.mjs' }, `LIVE FILE\n${'q'.repeat(20_000)}\nEND`),
    ...round('edit', 'edit_file', { path: 'lib/slug.mjs' }, 'changed lib/slug.mjs'),
  ];
  const before = estimateMessagesTokens(msgs);
  // A budget the dead-search cut alone can reach (it frees ~2,900 estimated
  // tokens). ⚠️ The first draft of this test asked for 3,000 and went red — and
  // the implementation was right: 2,924 < 3,000, so it correctly went on to the
  // next pass. A fixture that demands more saving than the cheap cut provides
  // is testing arithmetic, not ordering.
  const out = compactMessages(msgs, { budgetTokens: before - 2_000, keepLastRounds: 0, maxResultChars: 2_000 });
  assert.equal(out.dropped, 1);
  assert.equal(out.report.actions[0].pass, 'dead-searches');
  assert.ok(out.messages.filter((m) => m.role === 'tool')[1].content.includes('q'.repeat(1_000)),
    'the live file must still be whole');
});

test('the applied pass order is reported, so the deviation from the brief is visible not hidden', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('A', 40_000)),
    ...round('r2', 'read_file', { path: 'a.mjs' }, 'fresh'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.deepEqual(out.report.passes.map((p) => p.pass),
    ['superseded-reads', 'stale-commands', 'dead-searches', 'giant-results']);
});

test('report.actions describes every change, and nothing it does not do', () => {
  const msgs = [
    ...head(),
    ...round('r1', 'read_file', { path: 'a.mjs' }, bulk('A', 40_000)),
    ...round('r2', 'read_file', { path: 'a.mjs' }, 'fresh'),
  ];
  const out = compactMessages(msgs, { budgetTokens: 0, keepLastRounds: 0 });
  assert.equal(out.report.actions.length, out.dropped);
  const [a] = out.report.actions;
  assert.equal(a.pass, 'superseded-reads');
  assert.equal(a.tool, 'read_file');
  assert.equal(a.index, 3);
  assert.ok(a.beforeChars > a.afterChars);
  assert.ok(Array.isArray(out.report.lines) && out.report.lines.length > 0);
});
