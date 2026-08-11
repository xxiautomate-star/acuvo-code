/**
 * ── REPLAY: STEP THROUGH A RUN THAT ALREADY HAPPENED ────────────────────────
 *
 * The property under test is unusual and it is the whole point: this module
 * must be able to describe a run that wrote files, deleted files and ran
 * commands — WITHOUT writing a file, deleting a file or running a command.
 * `session.mjs` holds the same line for resume and has a test that says so;
 * these tests hold it for replay, from both directions:
 *
 *   · BEHAVIOURAL — replay a record whose calls delete a real file that really
 *     exists on disk, then assert the file is still there.
 *   · STRUCTURAL  — assert the module imports nothing that could have done it.
 *
 * A behavioural test alone would pass against a module that had a `writeFileSync`
 * one branch away from being reached; a structural test alone would pass against
 * a module that shelled out through a helper. Both, or neither is evidence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  replaySession,
  formatTimeline,
  filterSteps,
  diffRuns,
  formatDiff,
  auditContext,
  WRITING_TOOLS,
  RUNNING_TOOLS,
  REPLAY_FORMAT_VERSION,
} from '../lib/replay.mjs';

import { saveSession, loadSession } from '../lib/session.mjs';
import { auditRecord } from '../lib/audit.mjs';
import { stripColour } from '../lib/colour.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * FIXTURES — built from the shape `saveSession` actually writes (verified
 * against a real recorded run before these were typed).
 * ──────────────────────────────────────────────────────────────────────────── */

const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

const asst = (content, calls) => (calls ? { role: 'assistant', content, tool_calls: calls } : { role: 'assistant', content });
const toolMsg = (id, name, content) => ({ role: 'tool', name, tool_call_id: id, content });

function rec(over = {}) {
  return {
    version: 1,
    id: '20260811-023539-bg12',
    savedAt: '2026-08-11T02:35:39.450Z',
    root: 'C:\\tmp\\ws',
    task: 'create hello.txt then read it back',
    model: 'deepseek/deepseek-v4-flash-0731',
    roundsUsed: 3,
    maxRounds: 4,
    stoppedBecause: 'no-tool-calls',
    error: null,
    verification: { ran: true, passed: true, command: 'evaluate' },
    usage: { cost: 0.001698, total_tokens: 27602 },
    files: [{ path: 'hello.txt', action: 'created', ok: true, bytes: 5 }],
    commands: [{ command: 'evaluate', ok: true, passed: true, exitCode: 0, timedOut: false, output: 'hello' }],
    resumable: true,
    truncated: false,
    droppedGroups: 0,
    droppedIncomplete: 0,
    redactions: 0,
    messages: [
      { role: 'system', content: 'You are Acuvo Code.' },
      { role: 'user', content: 'Workspace root: C:\\tmp\\ws\n\ncreate hello.txt then read it back' },
      asst('I will create the file.', [call('c1', 'write_file', { path: 'hello.txt', content: 'hello' })]),
      toolMsg('c1', 'write_file', 'created hello.txt (5 bytes)'),
      asst('Now verify it.', [call('c2', 'evaluate', { source: "import fs from 'fs'; console.log(fs.readFileSync('hello.txt','utf8'))" })]),
      toolMsg('c2', 'evaluate', '{"ok":true,"exitCode":0,"stdout":"hello\\n","passed":true}'),
      asst('Done — hello.txt exists and reads back as "hello".'),
    ],
    ...over,
  };
}

const tmp = (name) => mkdtempSync(join(tmpdir(), `acuvo-replay-${name}-`));

/* ════════════════════════════════════════════════════════════════════════════
 * A · THE TIMELINE
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐ a recorded run becomes an ordered timeline: task, reasoning, call, result, verdict', () => {
  const r = replaySession(rec());
  assert.equal(r.ok, true);
  assert.equal(r.id, '20260811-023539-bg12');
  assert.equal(r.model, 'deepseek/deepseek-v4-flash-0731');

  const kinds = r.steps.map((s) => s.kind);
  assert.deepEqual(kinds, [
    'system', 'task',
    'reasoning', 'call', 'result',
    'reasoning', 'call', 'result',
    'verdict',
  ]);

  // ⭐ `n` is the step's own index and it must be usable as one — a diff and a
  // filter both hand indices back to a human who then has to find the step.
  assert.deepEqual(r.steps.map((s) => s.n), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a call and the result answering it share ONE round, and rounds start at 1', () => {
  const r = replaySession(rec());
  const byKind = (k) => r.steps.filter((s) => s.kind === k);

  assert.deepEqual(byKind('system').map((s) => s.round), [0]);
  assert.deepEqual(byKind('task').map((s) => s.round), [0]);
  assert.deepEqual(byKind('reasoning').map((s) => s.round), [1, 2]);
  assert.deepEqual(byKind('call').map((s) => s.round), [1, 2]);
  assert.deepEqual(byKind('result').map((s) => s.round), [1, 2]);
  assert.deepEqual(byKind('verdict').map((s) => s.round), [3]);
  assert.equal(r.rounds, 3);
});

test('a call carries its tool, its call id and its arguments PARSED into data', () => {
  const r = replaySession(rec());
  const [first] = r.steps.filter((s) => s.kind === 'call');
  assert.equal(first.tool, 'write_file');
  assert.equal(first.callId, 'c1');
  assert.equal(first.argsParsed, true);
  assert.deepEqual(first.args, { path: 'hello.txt', content: 'hello' });
  // The paths a call names are lifted out — that is what the file filter needs.
  assert.deepEqual(first.paths, ['hello.txt']);
});

test('⚠️ unparseable arguments are reported, never thrown on — the raw text survives', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      asst('x', [call('c1', 'write_file', '{"path": "a.txt", trunc')]),
      toolMsg('c1', 'write_file', 'created a.txt (1 bytes)'),
    ],
  }));
  assert.equal(r.ok, true);
  const c = r.steps.find((s) => s.kind === 'call');
  assert.equal(c.argsParsed, false);
  assert.equal(c.args, null);
  assert.match(c.argsRaw, /trunc/);
  // and it still formats
  assert.doesNotThrow(() => formatTimeline(r));
});

test('⭐ a refusal is flagged as one — "<tool> failed: …" is how turn.mjs renders every refusal', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      asst('trying', [call('c1', 'run_command', { command: 'rm -rf /' })]),
      toolMsg('c1', 'run_command', 'run_command failed: refused — `rm` is not on the allowlist'),
      asst('ok, different approach', [call('c2', 'write_file', { path: 'a.txt', content: 'x' })]),
      toolMsg('c2', 'write_file', 'created a.txt (1 bytes)'),
    ],
  }));
  const results = r.steps.filter((s) => s.kind === 'result');
  assert.equal(results[0].refusal, true);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /not on the allowlist/);
  assert.equal(results[1].refusal, false);
  assert.equal(results[1].ok, true);
  assert.equal(r.counts.refusals, 1);
});

test('⚠️ a tool reply with no matching call is marked ORPHAN, not silently attributed', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      asst('x', [call('c1', 'write_file', { path: 'a.txt', content: 'x' })]),
      toolMsg('c1', 'write_file', 'created a.txt (1 bytes)'),
      toolMsg('GHOST', 'delete_file', 'deleted b.txt (9 bytes)'),
    ],
  }));
  assert.equal(r.ok, true);
  const orphans = r.steps.filter((s) => s.kind === 'result' && s.orphan);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].callId, 'GHOST');
  assert.ok(r.warnings.some((w) => /orphan/i.test(w)), `warnings: ${JSON.stringify(r.warnings)}`);
});

test('⭐ onStep sees every step exactly once, in order', () => {
  const seen = [];
  const r = replaySession(rec(), { onStep: (s) => seen.push(`${s.n}:${s.kind}`) });
  assert.equal(seen.length, r.steps.length);
  assert.deepEqual(seen, r.steps.map((s) => `${s.n}:${s.kind}`));
});

test('⚠️⭐ the transcript being SHORTER than the recorded round count is said out loud', () => {
  // This is the real recorded shape: `roundsUsed: 4` with the final assistant
  // answer absent from `messages`. A replay that quietly showed 3 rounds would
  // be describing a different run from the one the record counts.
  const r = replaySession(rec({
    roundsUsed: 4,
    messages: rec().messages.slice(0, -1),
  }));
  assert.equal(r.rounds, 2);
  assert.equal(r.roundsRecorded, 4);
  assert.ok(
    r.warnings.some((w) => /4/.test(w) && /2/.test(w)),
    `expected a warning naming both counts, got ${JSON.stringify(r.warnings)}`,
  );
});

/* ════════════════════════════════════════════════════════════════════════════
 * B · VALIDATE THE RECORD, DO NOT TRUST IT
 * ════════════════════════════════════════════════════════════════════════════ */

test('⚠️ junk in place of a record produces a sentence, never a crash', () => {
  for (const junk of [null, undefined, 0, 42, 'a string', [], [1, 2], true, NaN]) {
    const r = replaySession(junk);
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(junk)}`);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 20, `error too terse for ${JSON.stringify(junk)}: ${r.error}`);
  }
});

test('⚠️ a record from a NEWER version is refused by name, and says what to do', () => {
  const r = replaySession(rec({ version: 99 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /99/);
  assert.match(r.error, /version/i);
});

test('⚠️ a record with no messages array is refused; an EMPTY one replays as a run that recorded nothing', () => {
  const missing = replaySession(rec({ messages: undefined }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /messages/);

  const empty = replaySession(rec({ messages: [], resumable: false, stoppedBecause: 'failed:gather' }));
  assert.equal(empty.ok, true);
  assert.equal(empty.steps.length, 0);
  assert.equal(empty.rounds, 0);
  const out = formatTimeline(empty);
  assert.match(out, /nothing/i);
});

test('⭐ a hand-edited record missing its secondary arrays still replays, and the repair is WARNED', () => {
  const r = replaySession(rec({ files: undefined, commands: undefined, usage: undefined, verification: undefined }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.outcome.files, []);
  assert.deepEqual(r.outcome.commands, []);
  assert.equal(r.outcome.costUsd, null);
  assert.ok(r.warnings.length > 0);
  assert.doesNotThrow(() => formatTimeline(r));
});

test('⚠️ dropped rounds appear as a GAP step — a hole you can see beats a hole you cannot', () => {
  const r = replaySession(rec({ droppedGroups: 3, droppedIncomplete: 1, truncated: true }));
  const gaps = r.steps.filter((s) => s.kind === 'gap');
  assert.equal(gaps.length, 2, 'one gap for the size-capped rounds, one for the incomplete round');
  assert.ok(gaps.some((g) => g.count === 3));
  assert.ok(gaps.some((g) => g.count === 1));
  const out = formatTimeline(r);
  assert.match(out, /3 earlier round/);
  assert.match(out, /incomplete/i);
});

test('a message with a non-string content (a multimodal round) does not break the walk', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: [{ type: 'text', text: 'look at this' }] },
      asst(null, [call('c1', 'see_page', { url: 'http://x' })]),
      toolMsg('c1', 'see_page', 'screenshot written'),
    ],
  }));
  assert.equal(r.ok, true);
  assert.doesNotThrow(() => formatTimeline(r));
});

/* ════════════════════════════════════════════════════════════════════════════
 * C · IT MUST NEVER EXECUTE ANYTHING
 * ════════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ replaying a run that DELETED a file does not delete the file', () => {
  const dir = tmp('noexec');
  try {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'still here', 'utf8');
    const made = join(dir, 'made.txt');

    const r = replaySession(rec({
      root: dir,
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'delete victim.txt and write made.txt and run npm test' },
        asst('removing it', [
          call('c1', 'delete_file', { path: victim }),
          call('c2', 'write_file', { path: made, content: 'new' }),
          call('c3', 'run_command', { command: 'npm test' }),
        ]),
        toolMsg('c1', 'delete_file', 'deleted victim.txt (10 bytes)'),
        toolMsg('c2', 'write_file', 'created made.txt (3 bytes)'),
        toolMsg('c3', 'run_command', '$ npm test\nexit 0'),
      ],
    }));

    assert.equal(r.ok, true);
    // The steps DESCRIBE the deletion…
    assert.ok(r.steps.some((s) => s.kind === 'call' && s.tool === 'delete_file'));
    // …and the deletion did not happen again.
    assert.equal(existsSync(victim), true, 'replay deleted a real file');
    assert.equal(readFileSync(victim, 'utf8'), 'still here');
    assert.equal(existsSync(made), false, 'replay created a file the recording only described');

    // Formatting it, filtering it and diffing it are all equally inert.
    formatTimeline(r);
    filterSteps(r.steps, 'writes');
    formatDiff(diffRuns(r, r));
    assert.equal(existsSync(victim), true);
    assert.equal(existsSync(made), false);

    // ⭐ And the fact is in the DATA, not only in the prose — a caller can assert on it.
    assert.equal(r.executed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️⚠️ STRUCTURAL: lib/replay.mjs imports nothing that can touch the disk, a process or the network', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/replay.mjs', import.meta.url)), 'utf8');
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  // Only pure helpers from inside this package. Nothing from node:.
  for (const spec of imports) {
    assert.ok(
      spec.startsWith('./'),
      `lib/replay.mjs imports "${spec}" — replay is a reader, and a reader with a handle on ${spec} is one refactor away from being a runner`,
    );
  }
  assert.ok(!/from\s+['"]node:/.test(src), 'replay.mjs must not import any node: builtin');

  // And no dynamic escape hatch either.
  assert.ok(!/\bimport\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'no dynamic import()');
  assert.ok(!/\bcreateRequire\b|\brequire\s*\(/.test(src), 'no require()');
});

/* ════════════════════════════════════════════════════════════════════════════
 * D · SECRETS STAY REDACTED
 * ════════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ a hand-edited record carrying an API key does not print it — anywhere', () => {
  const KEY = 'sk-or-v1-abcdef0123456789abcdef0123456789abcdef0123456789';
  const AWS = 'AKIAIOSFODNN7EXAMPLE';
  const record = rec({
    task: `use ${KEY} to call the model`,
    messages: [
      { role: 'system', content: 'You are Acuvo Code.' },
      { role: 'user', content: `here is my key: ${KEY}` },
      asst(`I will store ${KEY} in the config.`, [
        call('c1', 'write_file', { path: 'config.json', content: `{"apiKey": "${KEY}"}` }),
      ]),
      toolMsg('c1', 'write_file', `created config.json containing ${AWS}`),
      asst(`Done. The key ${KEY} is saved.`),
    ],
  });

  const r = replaySession(record);
  assert.equal(r.ok, true);

  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(KEY), 'the openrouter key survived into the replay data');
  assert.ok(!serialized.includes(AWS), 'the aws key id survived into the replay data');

  const timeline = formatTimeline(r);
  assert.ok(!timeline.includes(KEY), 'the openrouter key was printed in the timeline');
  assert.ok(!timeline.includes(AWS), 'the aws key id was printed in the timeline');
  assert.match(timeline, /redacted/);

  // The diff path and the filter path are separate renderers; both must hold.
  const d = diffRuns(record, record);
  assert.ok(!JSON.stringify(d).includes(KEY));
  assert.ok(!formatDiff(d).includes(KEY));
  assert.ok(!JSON.stringify(filterSteps(r.steps, 'writes')).includes(KEY));
});

test('⚠️ …and redaction does NOT eat ordinary code — a check that mangles correct work is worse than none', () => {
  const src = 'const tokenCount = tokens.length;\nlet apiKey = process.env.OPENROUTER_API_KEY;\nconst KEYS = Object.keys(obj);';
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'refactor' },
      asst('here', [call('c1', 'write_file', { path: 'a.mjs', content: src })]),
      toolMsg('c1', 'read_file', src),
    ],
  }));
  const text = JSON.stringify(r);
  assert.ok(text.includes('tokens.length'), 'a plain variable read was redacted');
  assert.ok(text.includes('process.env.OPENROUTER_API_KEY'), 'an env reference was redacted');
  assert.ok(text.includes('Object.keys(obj)'), 'a method call was redacted');
});

/* ════════════════════════════════════════════════════════════════════════════
 * E · THE FILTERS
 * ════════════════════════════════════════════════════════════════════════════ */

const busy = () => rec({
  messages: [
    { role: 'system', content: 's' },
    { role: 'user', content: 'do several things' },
    asst('reading', [call('c1', 'read_file', { path: 'src/a.mjs' })]),
    toolMsg('c1', 'read_file', 'src/a.mjs (10 bytes):\nhello'),
    asst('editing', [call('c2', 'edit_file', { path: 'src/a.mjs', old_string: 'hello', new_string: 'bye' })]),
    toolMsg('c2', 'edit_file', 'edited src/a.mjs'),
    asst('running', [call('c3', 'run_command', { command: 'npm test' })]),
    toolMsg('c3', 'run_command', 'run_command failed: refused — npm test is not allowed here'),
    asst('deleting', [call('c4', 'delete_file', { path: 'src/b.mjs' })]),
    toolMsg('c4', 'delete_file', 'deleted src/b.mjs (4 bytes)'),
    asst('done'),
  ],
});

test('⭐ the refusals filter returns the refusal AND the call that earned it', () => {
  const r = replaySession(busy());
  const only = filterSteps(r.steps, 'refusals');
  assert.equal(only.length, 2, `expected the call + its refusal, got ${JSON.stringify(only.map((s) => s.kind))}`);
  assert.equal(only[0].kind, 'call');
  assert.equal(only[0].tool, 'run_command');
  assert.equal(only[1].kind, 'result');
  assert.equal(only[1].refusal, true);
});

test('the writes filter returns only the tools that produce a file — AND each call brings its result', () => {
  const r = replaySession(busy());
  const only = filterSteps(r.steps, 'writes');
  const tools = [...new Set(only.map((s) => s.tool))].sort();
  assert.deepEqual(tools, ['delete_file', 'edit_file']);
  assert.ok(!only.some((s) => s.tool === 'read_file'));
  assert.ok(!only.some((s) => s.tool === 'run_command'));

  // ⚠️ A filter that returns the calls and drops the results is a grep, and a
  // worse answer than the unfiltered log: "it called delete_file" with no sight
  // of whether the delete succeeded.
  assert.deepEqual(
    only.map((s) => `${s.kind}:${s.tool}`),
    ['call:edit_file', 'result:edit_file', 'call:delete_file', 'result:delete_file'],
  );

  const runs = filterSteps(r.steps, 'runs');
  assert.deepEqual(runs.map((s) => s.kind), ['call', 'result']);
  assert.deepEqual([...new Set(runs.map((s) => s.tool))], ['run_command']);

  const effects = filterSteps(r.steps, 'effects');
  assert.equal(effects.length, 6, 'writes ∪ runs, calls and results');

  assert.ok(WRITING_TOOLS.has('write_file') && WRITING_TOOLS.has('delete_file'));
  assert.ok(RUNNING_TOOLS.has('run_command') && RUNNING_TOOLS.has('evaluate'));
});

test('⭐ the file filter answers "what did this run do to src/a.mjs" — reads AND writes, in order', () => {
  const r = replaySession(busy());
  const only = filterSteps(r.steps, { file: 'src/a.mjs' });
  const seen = only.map((s) => `${s.kind}:${s.tool}`);
  assert.deepEqual(seen, ['call:read_file', 'result:read_file', 'call:edit_file', 'result:edit_file']);
  // A file nobody touched yields nothing, not a throw.
  assert.deepEqual(filterSteps(r.steps, { file: 'nope.mjs' }), []);
});

test('⚠️ the file filter matches by PATH, not by substring of a longer path', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      asst('a', [call('c1', 'write_file', { path: 'lib/a.mjs', content: 'x' })]),
      toolMsg('c1', 'write_file', 'created lib/a.mjs (1 bytes)'),
      asst('b', [call('c2', 'write_file', { path: 'lib/a.mjs.bak', content: 'x' })]),
      toolMsg('c2', 'write_file', 'created lib/a.mjs.bak (1 bytes)'),
    ],
  }));
  const only = filterSteps(r.steps, { file: 'lib/a.mjs' });
  assert.equal(only.length, 2);
  assert.equal(only[0].args.path, 'lib/a.mjs');
});

test('⚠️ windows and posix separators name the same file', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      asst('a', [call('c1', 'write_file', { path: 'lib\\deep\\a.mjs', content: 'x' })]),
      toolMsg('c1', 'write_file', 'created lib\\deep\\a.mjs (1 bytes)'),
    ],
  }));
  assert.equal(filterSteps(r.steps, { file: 'lib/deep/a.mjs' }).length, 2);
});

test('⚠️ an unknown filter is a refusal that names the ones that exist, never a silent empty list', () => {
  const r = replaySession(busy());
  assert.throws(
    () => filterSteps(r.steps, 'wrties'),
    (e) => /wrties/.test(e.message) && /refusals/.test(e.message) && /writes/.test(e.message),
  );
  // 'all' is the honest identity.
  assert.equal(filterSteps(r.steps, 'all').length, r.steps.length);
  assert.equal(filterSteps(r.steps).length, r.steps.length);
  assert.deepEqual(filterSteps([], 'writes'), []);
  assert.deepEqual(filterSteps(null, 'writes'), []);
});

/* ════════════════════════════════════════════════════════════════════════════
 * F · THE DIFF — "it passed once and failed once. where did they split?"
 * ════════════════════════════════════════════════════════════════════════════ */

test('two identical runs do not diverge', () => {
  const d = diffRuns(rec(), rec({ id: '20260811-030000-aa11' }));
  assert.equal(d.ok, true);
  assert.equal(d.sameTask, true);
  assert.equal(d.divergedAt, null);
  assert.equal(d.divergence, null);
  assert.equal(d.summary.onlyA, 0);
  assert.equal(d.summary.onlyB, 0);
  assert.match(formatDiff(d), /same/i);
});

test('⭐⭐ two runs of the same task that take different actions diverge at the ACTION, and it is named', () => {
  const a = rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'fix it' },
      asst('reading first', [call('a1', 'read_file', { path: 'a.mjs' })]),
      toolMsg('a1', 'read_file', 'a.mjs: contents'),
      asst('now editing', [call('a2', 'edit_file', { path: 'a.mjs', old_string: 'x', new_string: 'y' })]),
      toolMsg('a2', 'edit_file', 'edited a.mjs'),
      asst('done'),
    ],
  });
  const b = rec({
    id: '20260811-031111-bb22',
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'fix it' },
      asst('reading first, differently worded', [call('b1', 'read_file', { path: 'a.mjs' })]),
      toolMsg('b1', 'read_file', 'a.mjs: contents'),
      asst('rewriting the whole file', [call('b2', 'write_file', { path: 'a.mjs', content: 'y' })]),
      toolMsg('b2', 'write_file', 'replaced a.mjs (1 bytes)'),
      asst('done'),
    ],
  });

  const d = diffRuns(a, b);
  assert.equal(d.ok, true);
  assert.equal(d.sameTask, true);
  assert.notEqual(d.divergence, null);
  assert.equal(d.divergence.round, 2, 'the split is in round 2');
  assert.equal(d.divergence.a.tool, 'edit_file');
  assert.equal(d.divergence.b.tool, 'write_file');

  const out = formatDiff(d);
  assert.match(out, /edit_file/);
  assert.match(out, /write_file/);
  assert.match(out, /round 2/);
});

test('⚠️⭐ DIFFERENT PROSE IS NOT A DIVERGENCE — two runs that did the same things did not diverge', () => {
  // Two LLM runs never word a thought identically. A diff that called that a
  // divergence would fire on round 1 of every comparison and be worth nothing.
  const a = rec({ messages: rec().messages });
  const b = rec({
    id: '20260811-032222-cc33',
    messages: rec().messages.map((m) => (m.role === 'assistant' && m.content
      ? { ...m, content: `${m.content} (rephrased entirely differently by the model)` }
      : m)),
  });
  const d = diffRuns(a, b);
  assert.equal(d.divergence, null, 'prose set off the action divergence');
  assert.equal(d.divergedAt, null);
  assert.equal(d.proseDiffers, true, 'the prose difference must still be reported, just not as a divergence');
  assert.match(formatDiff(d), /wording/i);
});

test('⭐ the SAME action with different arguments IS a divergence', () => {
  const a = rec({
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('a1', 'run_command', { command: 'npm test' })]),
      toolMsg('a1', 'run_command', '$ npm test\nexit 0'),
    ],
  });
  const b = rec({
    id: '20260811-033333-dd44',
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('b1', 'run_command', { command: 'npm run build' })]),
      toolMsg('b1', 'run_command', '$ npm run build\nexit 0'),
    ],
  });
  const d = diffRuns(a, b);
  assert.notEqual(d.divergence, null);
  assert.match(d.divergence.why, /argument/i);
  assert.match(formatDiff(d), /npm run build/);
});

test('⭐ a REFUSAL on one side and not the other is a divergence, and the reason says which side', () => {
  const a = rec({
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('a1', 'run_command', { command: 'npm test' })]),
      toolMsg('a1', 'run_command', '$ npm test\nexit code: 0 (1.0s) — PASSED\n(no output)'),
    ],
  });
  const b = rec({
    id: '20260811-034444-ee55',
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('b1', 'run_command', { command: 'npm test' })]),
      toolMsg('b1', 'run_command', 'run_command failed: refused — npm is not on the allowlist'),
    ],
  });
  const d = diffRuns(a, b);
  assert.notEqual(d.divergence, null);
  assert.match(d.divergence.why, /refused/i);
  assert.match(d.divergence.why, /second/i, 'the reason must name WHICH run was refused');
});

/**
 * ── ⭐⭐ THE CASE THE WHOLE DIFF EXISTS FOR ─────────────────────────────────
 * `command.mjs`: "`ok: true` MEANS THE COMMAND RAN, NOT THAT IT PASSED." So a
 * failing `npm test` is a SUCCESSFUL tool call and nothing in the transcript
 * says "failed:". If the diff cannot see the exit code, the single most useful
 * comparison in the product degrades to "different output".
 */
test('⭐⭐ same command, PASSED once and FAILED once — reported as exactly that, not as "different output"', () => {
  const green = '$ npm test\nexit code: 0 (3.2s) — PASSED\n--- stdout ---\n41 passing';
  const red = '$ npm test\nexit code: 1 (3.4s) — FAILED\n--- stderr ---\n1 failing: turn.mjs handles CRLF';

  const mk = (id, body) => rec({
    id,
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('running the suite', [call(`${id}-1`, 'run_command', { command: 'npm test' })]),
      toolMsg(`${id}-1`, 'run_command', body),
    ],
  });

  const ra = replaySession(mk('20260811-034444-ee55', green));
  const rb = replaySession(mk('20260811-034445-ee56', red));

  // Both tool calls SUCCEEDED. Neither is a refusal. That is the trap.
  const resultA = ra.steps.find((s) => s.kind === 'result');
  const resultB = rb.steps.find((s) => s.kind === 'result');
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  assert.equal(resultA.refusal, false);
  assert.equal(resultB.refusal, false);
  // …and the outcome is read anyway.
  assert.equal(resultA.passed, true);
  assert.equal(resultA.exitCode, 0);
  assert.equal(resultB.passed, false);
  assert.equal(resultB.exitCode, 1);

  const d = diffRuns(ra, rb);
  assert.notEqual(d.divergence, null);
  assert.match(d.divergence.why, /PASSED/);
  assert.match(d.divergence.why, /FAILED/);
  assert.match(d.divergence.why, /exit 0/);
  assert.match(d.divergence.why, /exit 1/);

  // ⚠️ And the timeline must not put a green tick next to the failing one.
  assert.match(formatTimeline(rb), /✘ FAILED/);
  assert.match(formatTimeline(ra), /✔ passed/);
});

test("⭐ `evaluate` reports its outcome as DATA, and that is read rather than parsed", () => {
  // The real recorded shape: evaluate's result is the result object itself.
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('c1', 'evaluate', { source: 'process.exit(1)' })]),
      toolMsg('c1', 'evaluate', '{"ok":true,"exitCode":1,"timedOut":false,"stdout":"","stderr":"boom","passed":false}'),
    ],
  }));
  const res = r.steps.find((s) => s.kind === 'result');
  assert.equal(res.ok, true);
  assert.equal(res.refusal, false);
  assert.equal(res.passed, false);
  assert.equal(res.exitCode, 1);
});

test('⚠️ a timed-out command is FAILED and says so — it has no exit code to read', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('c1', 'run_command', { command: 'npm test' })]),
      toolMsg('c1', 'run_command', '$ npm test\nTIMED OUT after 120s and was killed. It produced no exit code.'),
    ],
  }));
  const res = r.steps.find((s) => s.kind === 'result');
  assert.equal(res.timedOut, true);
  assert.equal(res.passed, false);
  assert.equal(res.exitCode, null);
});

test('⚠️⚠️ a result whose shape states NO outcome reports null — never a confident false', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('c1', 'read_file', { path: 'a.mjs' })]),
      toolMsg('c1', 'read_file', 'a.mjs (12 bytes):\nhello world!'),
      asst('y', [call('c2', 'write_file', { path: 'b.mjs', content: 'x' })]),
      toolMsg('c2', 'write_file', 'created b.mjs (1 bytes)'),
    ],
  }));
  for (const res of r.steps.filter((s) => s.kind === 'result')) {
    assert.equal(res.passed, null, `${res.tool} invented an outcome it was never told`);
    assert.equal(res.ok, true);
  }

  // …and two "does not say" results are NOT a divergence just because they differ.
  const other = replaySession(rec({
    id: '20260811-039999-zz99',
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('d1', 'read_file', { path: 'a.mjs' })]),
      toolMsg('d1', 'read_file', 'a.mjs (12 bytes):\nhello world!'),
      asst('y', [call('d2', 'write_file', { path: 'b.mjs', content: 'x' })]),
      toolMsg('d2', 'write_file', 'created b.mjs (1 bytes)'),
    ],
  }));
  assert.equal(diffRuns(r, other).divergence, null);
});

test('⚠️⚠️ "we cannot tell" is never compared against "it failed" — the diff must not invent a verdict', () => {
  // A: the current renderer, which states the exit code.
  // B: the same command, but the result body does not state an outcome (an
  //    older build, a truncated record, a tool whose formatter changed).
  const a = rec({
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('a1', 'run_command', { command: 'npm test' })]),
      toolMsg('a1', 'run_command', '$ npm test\nexit code: 0 (1.0s) — PASSED\n(no output)'),
    ],
  });
  const b = rec({
    id: '20260811-038888-yy88',
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('b1', 'run_command', { command: 'npm test' })]),
      toolMsg('b1', 'run_command', '$ npm test\nran to completion'),
    ],
  });
  const ra = replaySession(a);
  const rb = replaySession(b);
  assert.equal(ra.steps.find((s) => s.kind === 'result').passed, true);
  assert.equal(rb.steps.find((s) => s.kind === 'result').passed, null);

  const d = diffRuns(ra, rb);
  assert.notEqual(d.divergence, null, 'the outputs differ, so this is still a divergence');
  assert.ok(
    !/PASSED/.test(d.divergence.why) && !/FAILED/.test(d.divergence.why),
    `the diff claimed a verdict it was never given: ${d.divergence.why}`,
  );
  assert.match(d.divergence.why, /different output/i);
});

test('⚠️⭐ the outcome is read from the WHOLE result, not from the clamped copy of it', () => {
  // The real `evaluate` shape: the result object serialised, with the source
  // echoed back BEFORE the exit code. A long source pushes `exitCode` past the
  // data clamp — and reading the clamped copy silently loses the verdict on
  // exactly the long-running commands whose verdict matters most.
  const longSource = 'console.log("xxxxxxxxx"); '.repeat(400);
  const body = JSON.stringify({
    ok: true,
    source: longSource,
    exitCode: 1,
    timedOut: false,
    durationMs: 483,
    stdout: '',
    stderr: 'boom',
    passed: false,
  });
  assert.ok(body.length > 4_000, 'the fixture must exceed the data clamp for this test to mean anything');

  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('c1', 'evaluate', { source: longSource })]),
      toolMsg('c1', 'evaluate', body),
    ],
  }));
  const res = r.steps.find((s) => s.kind === 'result');
  assert.ok(res.text.length < body.length, 'the stored text really is clamped');
  assert.equal(res.passed, false, 'the verdict was lost to the clamp');
  assert.equal(res.exitCode, 1);
});

test('a longer run reports the extra steps as only-B rather than as a divergence at the end', () => {
  const a = rec({
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('a1', 'read_file', { path: 'a.mjs' })]),
      toolMsg('a1', 'read_file', 'a'),
    ],
  });
  const b = rec({
    id: '20260811-035555-ff66',
    messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      asst('x', [call('b1', 'read_file', { path: 'a.mjs' })]),
      toolMsg('b1', 'read_file', 'a'),
      asst('and more', [call('b2', 'write_file', { path: 'a.mjs', content: 'z' })]),
      toolMsg('b2', 'write_file', 'replaced a.mjs (1 bytes)'),
    ],
  });
  const d = diffRuns(a, b);
  assert.ok(d.summary.onlyB >= 2, JSON.stringify(d.summary));
  assert.equal(d.summary.onlyA, 0);
  assert.match(formatDiff(d), /write_file/);
});

test('⚠️ diffing two DIFFERENT tasks still works, and says so loudly', () => {
  const d = diffRuns(rec({ task: 'build the parser' }), rec({ id: '20260811-036666-gg77', task: 'delete the parser' }));
  assert.equal(d.ok, true);
  assert.equal(d.sameTask, false);
  assert.match(formatDiff(d), /different task/i);
});

test('⚠️ diffing junk refuses with a sentence naming WHICH side was bad', () => {
  const bad = diffRuns(rec(), null);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /second|b\b/i);

  const bad2 = diffRuns({ version: 7 }, rec());
  assert.equal(bad2.ok, false);
  assert.match(bad2.error, /first|a\b/i);

  assert.doesNotThrow(() => formatDiff(bad));
  assert.match(formatDiff(bad), /second|b\b/i);
});

test('diffRuns accepts already-replayed runs as well as raw records', () => {
  const ra = replaySession(rec());
  const rb = replaySession(rec({ id: '20260811-037777-hh88' }));
  const d = diffRuns(ra, rb);
  assert.equal(d.ok, true);
  assert.equal(d.divergence, null);
});

/* ════════════════════════════════════════════════════════════════════════════
 * G · THE RENDERING — legitimate shapes, not only the happy one
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐ the timeline says it is a recording, on its own line, before anything else', () => {
  const out = formatTimeline(replaySession(rec()));
  const header = out.split('\n').slice(0, 8).join('\n');
  assert.match(header, /nothing here was re-run/i);
  assert.match(out, /round 1/);
  assert.match(out, /round 2/);
  assert.match(out, /write_file/);
  assert.match(out, /created hello\.txt/);
  assert.match(out, /no-tool-calls/);
});

test('⚠️ no ANSI escapes unless a painter is handed in', () => {
  const r = replaySession(rec());
  const plain = formatTimeline(r);
  assert.equal(plain, stripColour(plain), 'colour leaked into an unpainted render');

  const painted = formatTimeline(r, { paint: { dim: (t) => `\x1b[2m${t}\x1b[0m`, gold: (t) => t, green: (t) => t, red: (t) => t, bold: (t) => t, cyan: (t) => t } });
  assert.notEqual(painted, stripColour(painted));
  assert.equal(stripColour(painted).length, plain.length);
});

test('⚠️ CRLF in a recorded message does not leak carriage returns into the render', () => {
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      asst('line one\r\nline two\r\nline three', [call('c1', 'run_command', { command: 'npm test' })]),
      toolMsg('c1', 'run_command', 'stdout:\r\nok\r\nexit 0'),
    ],
  }));
  const out = formatTimeline(r);
  assert.ok(!out.includes('\r'), 'a carriage return survived into the timeline');
  assert.match(out, /line two/);
});

test('⚠️ non-ASCII survives intact — a transcript is not ASCII and never was', () => {
  const r = replaySession(rec({
    task: 'écrire un fichier — 日本語 — 🚀',
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'écrire un fichier — 日本語 — 🚀' },
      asst('d’accord ✅', [call('c1', 'write_file', { path: 'café/naïve.txt', content: '日本語' })]),
      toolMsg('c1', 'write_file', 'created café/naïve.txt (9 bytes)'),
    ],
  }));
  const out = formatTimeline(r);
  assert.match(out, /日本語/);
  assert.match(out, /🚀/);
  assert.match(out, /café\/naïve\.txt/);
  assert.equal(filterSteps(r.steps, { file: 'café/naïve.txt' }).length, 2);
});

test('⚠️ a huge recorded message is clamped — a debugger that floods the terminal is not a debugger', () => {
  const huge = 'x'.repeat(500_000);
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      asst(huge, [call('c1', 'read_file', { path: 'big.txt' })]),
      toolMsg('c1', 'read_file', huge),
    ],
  }));
  const out = formatTimeline(r);
  assert.ok(out.length < 20_000, `timeline was ${out.length} chars`);
  assert.match(out, /\+\d+ chars|truncated/i);
  // …and the clamp is honest about how much it hid.
  const step = r.steps.find((s) => s.kind === 'reasoning');
  assert.ok(step.text.length < huge.length);
});

test('⚠️ the display trim stays in the RENDERER — `chars` is the record\'s length, not the pretty one', () => {
  // Models end almost every message with blank lines. They must not become
  // blank rows between a thought and the call it introduced…
  const body = 'a thought.\n\n\n';
  const r = replaySession(rec({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      asst(body, [call('c1', 'write_file', { path: 'a.txt', content: 'x' })]),
      toolMsg('c1', 'write_file', 'created a.txt (1 bytes)'),
    ],
  }));

  // …and the DATA must still say what the record says. A replay whose character
  // counts disagree with the file it is describing is not a replay.
  const step = r.steps.find((s) => s.kind === 'reasoning');
  assert.equal(step.chars, body.length);
  assert.equal(step.text, body);

  const lines = formatTimeline(r).split('\n');
  const at = lines.findIndex((l) => l.includes('a thought.'));
  assert.ok(at >= 0);
  assert.match(lines[at + 1], /→ call/, 'a blank row was rendered between the thought and its call');
});

test('formatTimeline of a REFUSED replay prints the refusal, and does not throw', () => {
  const bad = replaySession({ version: 99 });
  assert.equal(bad.ok, false);
  const out = formatTimeline(bad);
  assert.match(out, /99/);
  assert.ok(!out.includes('undefined'));
});

/* ════════════════════════════════════════════════════════════════════════════
 * H · AGAINST WHAT session.mjs AND audit.mjs ACTUALLY WRITE
 *     (a fixture I typed is a fixture I can get wrong; these two are not)
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ END TO END: replay a record that saveSession WROTE and loadSession READ BACK', () => {
  const dir = tmp('e2e');
  try {
    const outcome = {
      ok: true,
      model: 'deepseek/deepseek-v4-flash-0731',
      roundsUsed: 2,
      maxRounds: 4,
      stoppedBecause: 'no-tool-calls',
      usage: { cost: 0.00042, total_tokens: 1234 },
      verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 },
      executed: [
        { name: 'write_file', args: { path: 'hello.txt' }, result: { ok: true, path: 'hello.txt', created: true, bytes: 5 } },
        { name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 0, passed: true, stdout: 'all good' } },
      ],
      messages: [
        { role: 'system', content: 'You are Acuvo Code.' },
        { role: 'user', content: 'create hello.txt and test' },
        asst('writing it', [call('t1', 'write_file', { path: 'hello.txt', content: 'hello' })]),
        toolMsg('t1', 'write_file', 'created hello.txt (5 bytes)'),
        asst('testing it', [call('t2', 'run_command', { command: 'npm test' })]),
        toolMsg('t2', 'run_command', '$ npm test\nexit 0\nall good'),
        asst('Done.'),
      ],
    };

    const saved = saveSession(dir, outcome, { task: 'create hello.txt and test' });
    assert.equal(saved.ok, true, saved.error);

    const loaded = loadSession(dir, saved.id);
    assert.equal(loaded.ok, true, loaded.error);

    const r = replaySession(loaded.session);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.id, saved.id);
    assert.equal(r.task, 'create hello.txt and test');
    assert.deepEqual(r.steps.map((s) => s.kind), [
      'system', 'task', 'reasoning', 'call', 'result', 'reasoning', 'call', 'result', 'verdict',
    ]);
    assert.equal(r.counts.calls, 2);
    assert.equal(r.counts.refusals, 0);
    assert.equal(r.outcome.costUsd, 0.00042);
    assert.deepEqual(r.outcome.files.map((f) => f.path), ['hello.txt']);

    const out = formatTimeline(r);
    assert.match(out, /npm test/);
    assert.match(out, /hello\.txt/);

    // ⚠️ Nothing in the replay wrote anything into the workspace it describes.
    const before = readdirSync(dir).sort();
    formatTimeline(r);
    replaySession(loaded.session);
    assert.deepEqual(readdirSync(dir).sort(), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ the audit line for the same run enriches the replay — acceptance and refusals the session record lacks', () => {
  const outcome = {
    ok: true,
    model: 'm1',
    roundsUsed: 1,
    stoppedBecause: 'no-tool-calls',
    usage: { cost: 0.5, total_tokens: 10 },
    verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 },
    acceptance: {
      source: 'declared',
      gating: true,
      verdict: { verdict: 'unmet', unmet: [{ command: 'npm test', why: 'never ran' }] },
    },
    executed: [{ name: 'run_command', args: {}, result: { ok: false, error: 'refused — not on the allowlist' } }],
    messages: [],
  };
  const audit = auditRecord(outcome, { task: 'do it', now: new Date('2026-08-11T00:00:00Z') });

  const ctx = auditContext(audit);
  assert.equal(ctx.ok, true);
  assert.equal(ctx.acceptance.verdict, 'unmet');
  assert.equal(ctx.refusals.length, 1);
  assert.equal(ctx.model.answered, null);

  const r = replaySession(rec(), { audit });
  assert.equal(r.ok, true);
  assert.equal(r.outcome.acceptance.verdict, 'unmet');
  assert.equal(r.outcome.refusals.length, 1);
  const out = formatTimeline(r);
  assert.match(out, /unmet/i);
  assert.match(out, /npm test/);
});

test('⚠️ a junk audit line is ignored with a warning — it must not take the replay down with it', () => {
  for (const junk of [null, 'nope', { v: 99 }, { v: 1 }, []]) {
    const r = replaySession(rec(), { audit: junk });
    assert.equal(r.ok, true, `audit ${JSON.stringify(junk)} broke the replay`);
    assert.equal(r.outcome.acceptance, null);
    if (junk !== null && junk !== undefined) {
      assert.ok(r.warnings.some((w) => /audit/i.test(w)), `no warning for audit ${JSON.stringify(junk)}`);
    }
  }
  assert.equal(auditContext(null).ok, false);
  assert.match(auditContext({ v: 99 }).error, /99/);
});

test('the format version is exported and is a number a consumer can branch on', () => {
  assert.equal(typeof REPLAY_FORMAT_VERSION, 'number');
  assert.equal(replaySession(rec()).formatVersion, REPLAY_FORMAT_VERSION);
});
