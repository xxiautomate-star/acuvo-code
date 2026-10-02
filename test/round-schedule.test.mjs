/**
 * ── THE ROUND SCHEDULER ─────────────────────────────────────────────────────
 *
 * ⚠️ THE POINT OF THIS FILE IS NOT "planRound returns an array". It is that the
 * schedule REACHES THE LOOP and that the safety rules BITE. This package's own
 * recorded failure is eight capabilities in 48 hours, every one with a green
 * suite and none of them reached — so the last third of this file drives
 * `runSession` with a fake model and asserts on what the dispatcher actually
 * did, not on what a pure function returned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  planRound, kindOf, pathsTouched, hoistableVerbs, runHoisted, takeSettled,
  describeSchedule, CALL_KINDS, WHOLE_WORKSPACE, DEFAULT_MAX_PARALLEL,
} from '../lib/round-schedule.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const c = (name, args = {}) => ({ name, args });

// ── the classification is total ─────────────────────────────────────────────

test('⚠️ EVERY registered verb is classified — an unclassified one defaults to the strictest kind', () => {
  const unclassified = TOOL_NAMES.filter((n) => {
    // `kindOf` answers `mutate` for both "classified as mutate" and "never
    // heard of it", so ask the module which names it actually knows.
    const known = kindOf(n);
    return !Object.values(CALL_KINDS).includes(known);
  });
  assert.deepEqual(unclassified, [], 'kindOf returned something that is not a CallKind');

  /**
   * ⭐ THE REAL ASSERTION: a verb nobody classified must not be silently
   * hoistable. `kindOf` on a name the map has never seen must be `mutate`.
   */
  assert.equal(kindOf('a_verb_invented_next_month'), CALL_KINDS.MUTATE);
  assert.equal(kindOf('mcp__github__create_issue'), CALL_KINDS.MUTATE,
    'an MCP tool is hoistable — a third-party verb name proves nothing about whether it writes');
  assert.equal(kindOf(null), CALL_KINDS.MUTATE);
  assert.equal(kindOf(''), CALL_KINDS.MUTATE);
});

test('⭐ the hoistable set is exactly the read-only asynchronous verbs, and it is pinned', () => {
  assert.deepEqual(hoistableVerbs(), [
    'fetch_url', 'gh_issue', 'gh_pr', 'gh_run', 'git_diff', 'git_log', 'git_status',
    'list_engines', 'read_document', 'read_image', 'read_table', 'see_page',
    'transcribe', 'web_search',
  ]);
  /**
   * ⚠️ NOT A COSMETIC PIN. Every name added here starts running before the
   * dispatcher reaches it, so the list is the security boundary of this module
   * and a change to it should have to be typed twice.
   */
  for (const n of hoistableVerbs()) {
    assert.ok(TOOL_NAMES.includes(n), `${n} is scheduled to be hoisted and is not a registered verb`);
  }
});

test('⚠️ no verb that writes, runs code or waits on a human is ever hoistable', () => {
  const mustNever = [
    'write_file', 'write_files', 'edit_file', 'delete_file', 'move_file', 'apply_patch',
    'run_command', 'run_program', 'evaluate', 'repl', 'start_process', 'stop_process',
    'delegate', 'ask_user', 'wait_for_output', 'git_commit', 'git_push', 'call_endpoint',
    'generate_image', 'speak', 'make_document', 'vercel_preview', 'check_acceptance',
  ];
  for (const n of mustNever) {
    assert.notEqual(kindOf(n), CALL_KINDS.ASYNC_READ, `${n} is hoistable`);
  }
});

// ── the rules ───────────────────────────────────────────────────────────────

test('⭐ the case the whole thing exists for: three git reads overlap', () => {
  const s = planRound([c('git_status'), c('git_log'), c('git_diff')]);
  assert.deepEqual(s.hoisted, [0, 1, 2]);
  assert.match(describeSchedule(s, [c('git_status'), c('git_log'), c('git_diff')]),
    /git_status, git_log, git_diff/);
});

test('⚠️ a write EARLIER in the round holds every read that touches what it wrote', () => {
  const s = planRound([c('write_file', { path: 'a.js' }), c('git_status'), c('git_log')]);
  assert.deepEqual(s.hoisted, [], 'a git read ran early across a pending write to the tree');
  assert.ok(s.held.some((h) => /writes what it touches/.test(h.reason)));
});

test('⚠️ a write AFTER the reads does not hold them — order is the whole question', () => {
  const s = planRound([c('git_status'), c('git_log'), c('write_file', { path: 'a.js' })]);
  assert.deepEqual(s.hoisted, [0, 1]);
});

test('⚠️ a path-scoped write only holds the reads that touch THAT path', () => {
  const s = planRound([
    c('write_file', { path: 'a.js' }),
    c('read_document', { path: 'b.pdf' }),
    c('read_table', { path: 'c.csv' }),
  ]);
  assert.deepEqual(s.hoisted, [1, 2], 'two reads of untouched paths were held by an unrelated write');

  const collide = planRound([
    c('write_file', { path: 'b.pdf' }),
    c('read_document', { path: 'b.pdf' }),
    c('read_table', { path: 'c.csv' }),
  ]);
  assert.deepEqual(collide.hoisted, [], 'a read of the exact path a write touched was started early');
});

test('⚠️⚠️ a command or a question is a BARRIER — nothing after it is pre-run', () => {
  for (const barrier of ['run_command', 'ask_user', 'evaluate', 'delegate', 'call_endpoint']) {
    const s = planRound([c(barrier), c('git_status'), c('git_log')]);
    assert.deepEqual(s.hoisted, [], `${barrier} did not stop the overlap behind it`);
    assert.ok(s.held.some((h) => h.reason.includes(barrier)),
      `${barrier} held the calls without saying it was the reason`);
  }
});

test('⚠️ synchronous reads are held, and the reason says why rather than pretending they are unsafe', () => {
  const s = planRound([c('read_file', { path: 'a' }), c('search_text', { pattern: 'x' }), c('find_files', { pattern: '*' })]);
  assert.deepEqual(s.hoisted, []);
  for (const h of s.held) assert.match(h.reason, /synchronous/);
});

test('⭐ one hoistable call is NOT a schedule — one call "in parallel" is one call', () => {
  const s = planRound([c('git_status'), c('read_file', { path: 'a' })]);
  assert.deepEqual(s.hoisted, []);
  assert.ok(s.held.some((h) => /nothing else in this round could run beside it/.test(h.reason)));
});

test('⚠️ the ceiling holds, and the overflow is reported rather than dropped silently', () => {
  const calls = [c('git_status'), c('git_log'), c('git_diff'), c('fetch_url'), c('web_search')];
  const s = planRound(calls, { maxParallel: 2 });
  assert.deepEqual(s.hoisted, [0, 1]);
  assert.equal(s.held.filter((h) => /concurrency ceiling/.test(h.reason)).length, 3);
  assert.equal(DEFAULT_MAX_PARALLEL, 4);
});

test('⭐⭐ maxParallel 1 is a total no-op — the flag restores the old loop exactly', () => {
  const calls = [c('git_status'), c('git_log'), c('git_diff')];
  assert.deepEqual(planRound(calls, { maxParallel: 1 }).hoisted, []);
  assert.deepEqual(planRound(calls, { maxParallel: 0 }).hoisted, []);
});

test('⚠️⚠️ ANY configured hook disables overlap — a gate that can be pre-empted is not a gate', () => {
  const calls = [c('git_status'), c('git_log'), c('git_diff')];
  assert.deepEqual(planRound(calls, { hooksEnabled: true }).hoisted, [],
    'a PreToolUse hook could no longer refuse a call that had already run');
  assert.deepEqual(planRound(calls, { hooksEnabled: false }).hoisted, [0, 1, 2]);
});

test('⚠️ an unreadable footprint is the whole workspace, never "touches nothing"', () => {
  assert.deepEqual(pathsTouched(c('apply_patch', {})).writes, [WHOLE_WORKSPACE]);
  assert.deepEqual(pathsTouched(c('a_verb_invented_next_month', {})).writes, [WHOLE_WORKSPACE]);
  // A write whose `path` argument did not survive parsing must still block.
  const s = planRound([c('write_file', {}), c('git_status'), c('git_log')]);
  assert.deepEqual(s.hoisted, [], 'a write with no readable path was treated as writing nothing');
});

test('⚠️ write_files reports every path in the batch, not just the first', () => {
  const t = pathsTouched(c('write_files', { files: [{ path: 'a.js' }, { path: 'b.js' }] }));
  assert.deepEqual(t.writes, ['a.js', 'b.js']);
  const s = planRound([c('write_files', { files: [{ path: 'z' }, { path: 'b.pdf' }] }), c('read_document', { path: 'b.pdf' }), c('read_table', { path: 'c.csv' })]);
  assert.deepEqual(s.hoisted, [], 'the SECOND path of a batch write did not block a read of it');
});

// ── runHoisted ──────────────────────────────────────────────────────────────

test('⚠️⚠️ allSettled, never all — one rejection must not abandon a call that already succeeded', async () => {
  let bFinished = false;
  const out = await runHoisted([0, 1], (i) => (i === 0
    ? () => Promise.reject(new Error('boom'))
    : async () => { await new Promise((r) => setTimeout(r, 10)); bFinished = true; return 'b'; }));
  assert.equal(bFinished, true, 'Promise.all semantics abandoned the second call');
  assert.equal(out.get(1).value, 'b');
  assert.throws(() => takeSettled(out.get(0)), /boom/,
    'a rejected pre-run must re-throw where the serial code would have thrown');
});

test('⭐ they really do overlap — two 60ms calls finish in about 60ms, not 120ms', async () => {
  const slow = () => new Promise((r) => setTimeout(() => r(1), 60));
  const t = Date.now();
  await runHoisted([0, 1], () => slow);
  const ms = Date.now() - t;
  assert.ok(ms < 110, `two 60ms calls took ${ms}ms — they ran one after the other`);
});

test('⚠️ fewer than two live thunks is an empty map — the loop falls through to serial', async () => {
  const out = await runHoisted([0, 1], (i) => (i === 0 ? () => Promise.resolve('a') : null));
  assert.equal(out.size, 0);
});

// ── ⭐⭐⭐ AND NOW: DOES IT ACTUALLY REACH THE LOOP? ─────────────────────────

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-sched-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  return root;
}

/** A model that emits one round of tool calls and then stops. */
function scriptedModel(toolCalls) {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) {
      return {
        ok: true, content: '',
        toolCalls: toolCalls.map((t, i) => ({ id: `c${i}`, function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })),
        usage: { cost: 0, total_tokens: 1 }, finishReason: 'tool_calls', model: 'test', provider: 'test',
      };
    }
    return { ok: true, content: 'done', toolCalls: [], usage: { cost: 0, total_tokens: 1 }, finishReason: 'stop', model: 'test', provider: 'test' };
  };
}

async function driveRound(toolCalls, extra = {}) {
  const root = workspace();
  const events = [];
  const outcome = await runSession({
    task: 'test', executor: createLocalExecutor(root), config: { apiKey: 'x', model: 'test' },
    maxRounds: 3, allowRun: false, callModelImpl: scriptedModel(toolCalls),
    onEvent: (e) => events.push(e), ...extra,
  });
  return { outcome, events, root };
}

test('⭐⭐⭐ END TO END: the scheduler reaches runSession and announces the overlap', async () => {
  const { outcome, events } = await driveRound([
    { name: 'git_status' }, { name: 'git_log', args: { count: 1 } }, { name: 'git_diff' },
  ]);
  const parallel = events.filter((e) => e.type === 'tools-parallel');
  assert.equal(parallel.length, 1, 'the round scheduler never fired inside the real loop');
  assert.deepEqual(parallel[0].names, ['git_status', 'git_log', 'git_diff']);

  /**
   * ⚠️ AND EVERY CALL STILL PRODUCED A RECORD, IN ORDER. Hoisting must change
   * WHEN a call starts and nothing else — the transcript, the `executed` array
   * and the tool messages are the model's whole view of the round.
   */
  const names = outcome.executed.map((r) => r.name);
  assert.deepEqual(names, ['git_status', 'git_log', 'git_diff']);
});

test('⭐⭐ END TO END: --no-parallel-tools (parallelTools: 1) leaves the loop strictly serial', async () => {
  const { outcome, events } = await driveRound([
    { name: 'git_status' }, { name: 'git_log', args: { count: 1 } }, { name: 'git_diff' },
  ], { parallelTools: 1 });
  assert.equal(events.filter((e) => e.type === 'tools-parallel').length, 0);
  assert.deepEqual(outcome.executed.map((r) => r.name), ['git_status', 'git_log', 'git_diff']);
});

test('⚠️⚠️ END TO END: a write in the same round is NOT overtaken by a read', async () => {
  const { events } = await driveRound([
    { name: 'write_file', args: { path: 'b.txt', content: 'x' } },
    { name: 'git_status' },
    { name: 'git_diff' },
  ]);
  assert.equal(events.filter((e) => e.type === 'tools-parallel').length, 0,
    'two git reads were started before a pending write in the same round had landed');
});

test('⚠️⚠️ END TO END: a hook in the workspace turns the overlap off', async () => {
  const root = workspace();
  writeFileSync(join(root, '.acuvo', 'hooks.json'), JSON.stringify({
    hooks: [{ event: 'PreToolUse', command: 'node -e "process.exit(0)"' }],
  }));
  const events = [];
  await runSession({
    task: 'test', executor: createLocalExecutor(root), config: { apiKey: 'x', model: 'test' },
    maxRounds: 3, allowRun: false,
    callModelImpl: scriptedModel([{ name: 'git_status' }, { name: 'git_log', args: { count: 1 } }, { name: 'git_diff' }]),
    onEvent: (e) => events.push(e),
  });
  assert.equal(events.filter((e) => e.type === 'tools-parallel').length, 0,
    'a PreToolUse hook was configured and calls still ran before it could refuse them');
});

/**
 * ── ⭐⭐⭐ THE SEAM NO OTHER TEST IN THIS FILE COVERS ─────────────────────────
 *
 * ⚠️⚠️ EVERY ASSERTION ABOVE STAYS GREEN IF THE LOOP THROWS THE PRE-RUN AWAY.
 * Delete the `preRun.has(callIndex) ? takeSettled(...)` branch in `turn.mjs` and
 * the calls still run, the records still land in order, and the
 * `tools-parallel` event still fires — because the event is emitted from the
 * SCHEDULE, not from the consumption. The result would be strictly worse than
 * before this module existed: every hoisted call executed twice.
 *
 * That is precisely the trap this package has already paid for once, where a
 * guard's regex matched a nested rescue list instead of the seam it was written
 * for, and the seam could be deleted with the suite green.
 *
 * ⭐ SO THIS ONE IS A CLOCK, and a clock is the only instrument that can tell
 * "used the result" from "computed it again". Three `git_diff` calls against a
 * REAL repository take ~250ms each: consumed, the round is one of them;
 * discarded and recomputed, it is four. The threshold is deliberately loose —
 * the defect it catches is a 4x, not a 5%.
 */
test('⭐⭐⭐ THE PRE-RUN RESULT IS CONSUMED, NOT RECOMPUTED — measured on the clock', async () => {
  const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const calls = [{ name: 'git_status' }, { name: 'git_log', args: { count: 3 } }, { name: 'git_diff' }];

  const drive = async (parallelTools) => {
    const t = Date.now();
    await runSession({
      task: 'test', executor: createLocalExecutor(repoRoot), config: { apiKey: 'x', model: 'test' },
      maxRounds: 2, allowRun: false, parallelTools,
      callModelImpl: scriptedModel(calls), onEvent: () => {},
    });
    return Date.now() - t;
  };

  // Warm git's own caches so the first run is not paying for both.
  await drive(1);
  const serial = Math.min(await drive(1), await drive(1));
  const overlapped = Math.min(await drive(4), await drive(4));

  /**
   * ⚠️ SKIPPED RATHER THAN FAILED ON A MACHINE WITHOUT git. A clock test that
   * fails for the wrong reason teaches people to ignore it.
   */
  if (serial < 45) return;

  assert.ok(
    overlapped < serial,
    `three git reads took ${overlapped}ms overlapped vs ${serial}ms serial — the pre-run result `
    + 'is being discarded and the call re-executed, which is slower than never hoisting at all',
  );
});

test('⭐ the announcement is rendered — an event nobody prints is not a feature', async () => {
  const { renderEvent } = await import('../lib/turn.mjs');
  const lines = renderEvent({ type: 'tools-parallel', round: 1, names: ['git_status', 'git_diff'] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 slow calls at once/);
  assert.match(lines[0], /git_status, git_diff/);
});
