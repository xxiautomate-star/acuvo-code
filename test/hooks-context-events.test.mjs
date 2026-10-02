/**
 * ── THE THREE HOOK EVENTS THAT PUT CONTEXT IN FRONT OF THE MODEL ───────────
 *
 * Parity with Claude Code's hook surface (code.claude.com/docs/en/hooks, read
 * 2026-09-27): `SessionStart`, `UserPromptSubmit`, `PreCompact`. The two that
 * matter are proven END TO END through `runSession` with a real spawned hook —
 * a runner unit test alone would pass while `turn.mjs` never called it, which
 * is the built-and-unreached defect this package keeps shipping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { HOOKS_CONFIG_FILE, HOOK_EVENTS, parseHooksConfig, createHookRunner, MAX_HOOK_CONTEXT_CHARS } from '../lib/hooks.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-hook-ctx-'));
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hooksFile = (dir, hooks) =>
  writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({ hooks }, null, 2), 'utf8');

/** A hook that prints `out` on stdout and exits `code`. Bare `node x.mjs`, no quoting. */
function script(dir, name, { out = '', err = '', code = 0 } = {}) {
  writeFileSync(join(dir, name), [
    out ? `process.stdout.write(${JSON.stringify(out)} + (process.env.ACUVO_PROMPT ? ' [prompt=' + process.env.ACUVO_PROMPT + ']' : ''));` : '',
    err ? `process.stderr.write(${JSON.stringify(err)});` : '',
    `process.exit(${code});`,
  ].filter(Boolean).join('\n'), 'utf8');
  return `node ${name}`;
}

/** A model that records every message array it is shown and stops at once. */
function recordingModel() {
  const seen = [];
  const impl = async ({ messages }) => {
    seen.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })));
    return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
  };
  impl.seen = seen;
  return impl;
}

const session = (dir, opts = {}) => runSession({
  task: 'fix the login bug',
  executor: createLocalExecutor(dir),
  config: { apiKey: 'k', model: 'm' },
  maxRounds: 1,
  allowRun: false,
  ...opts,
});

test('the three events exist, and a tool filter on any of them is refused', () => {
  for (const e of ['SessionStart', 'UserPromptSubmit', 'PreCompact']) {
    assert.ok(HOOK_EVENTS.includes(e), `${e} must be a hook event`);
    const bad = parseHooksConfig(JSON.stringify({ hooks: [{ event: e, tools: ['write_file'], command: 'x' }] }));
    assert.equal(bad.ok, false, `${e} has no tool in flight; a tools filter would silently mean nothing`);
    assert.match(bad.error, new RegExp(`${e} hook has no tool`));
  }
  // The typo is still quoted back — the old contract holds.
  const typo = parseHooksConfig(JSON.stringify({ hooks: [{ event: 'PromptSubmit', command: 'x' }] }));
  assert.equal(typo.ok, false);
  assert.match(typo.error, /"PromptSubmit" is not a hook event/);
});

test('⭐⭐⭐ a UserPromptSubmit hook that exits non-zero refuses the prompt BEFORE any model call', async (t) => {
  const dir = workspace(t);
  hooksFile(dir, [{ event: 'UserPromptSubmit', command: script(dir, 'gate.mjs', { err: 'no prod credentials in prompts', code: 2 }), name: 'no-secrets' }]);
  const model = recordingModel();
  const outcome = await session(dir, { callModelImpl: model });
  assert.equal(outcome.ok, false, 'a refused prompt that still runs makes the gate a logger');
  assert.equal(outcome.stoppedBecause, 'prompt-blocked');
  assert.match(outcome.error, /no-secrets/);
  assert.match(outcome.error, /no prod credentials/, "the hook's own words must reach the person");
  assert.equal(model.seen.length, 0, 'NOT ONE model call may be bought for a refused prompt');
});

test('⭐⭐⭐ SessionStart and UserPromptSubmit STDOUT reach the model, in the user message, never the system one', async (t) => {
  const dir = workspace(t);
  hooksFile(dir, [
    { event: 'SessionStart', command: script(dir, 'start.mjs', { out: 'ON-CALL: alice' }) },
    { event: 'UserPromptSubmit', command: script(dir, 'ctx.mjs', { out: 'TICKET: AC-42' }) },
  ]);
  const model = recordingModel();
  const outcome = await session(dir, { callModelImpl: model });
  assert.equal(outcome.ok, true, `session errored: ${outcome.error}`);
  const first = model.seen[0];
  const user = first.find((m) => m.role === 'user').content;
  const system = first.find((m) => m.role === 'system').content;
  assert.match(user, /ON-CALL: alice/, 'SessionStart output must reach the model');
  assert.match(user, /TICKET: AC-42 \[prompt=fix the login bug\]/, 'UserPromptSubmit sees $ACUVO_PROMPT and its output reaches the model');
  assert.doesNotMatch(system, /ON-CALL|TICKET/, 'hook text in the SYSTEM message would miss the cached prefix every run');
});

test('SessionStart does NOT fire on a continued conversation, UserPromptSubmit does', async (t) => {
  const dir = workspace(t);
  hooksFile(dir, [
    { event: 'SessionStart', command: script(dir, 'start.mjs', { out: 'START-MARK' }) },
    { event: 'UserPromptSubmit', command: script(dir, 'ctx.mjs', { out: 'PROMPT-MARK' }) },
  ]);
  const model = recordingModel();
  const outcome = await session(dir, {
    callModelImpl: model,
    priorMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }],
  });
  assert.equal(outcome.ok, true, `session errored: ${outcome.error}`);
  const all = model.seen[0].map((m) => m.content).join('\n');
  assert.doesNotMatch(all, /START-MARK/, 'a second prompt in one chat is not a new session');
  assert.match(all, /PROMPT-MARK/, 'every prompt a person submits passes the prompt hook');
});

test('a delegate helper (depth 1) fires neither context hook — its prompt is the parent model\'s sentence', async (t) => {
  const dir = workspace(t);
  hooksFile(dir, [{ event: 'UserPromptSubmit', command: script(dir, 'gate.mjs', { code: 1 }) }]);
  const model = recordingModel();
  const outcome = await session(dir, { callModelImpl: model, depth: 1 });
  assert.equal(outcome.ok, true, 'a person\'s prompt gate refusing a helper would stall the parent\'s own reasoning');
  assert.equal(model.seen.length, 1);
});

test('a failing SessionStart hook is advisory: reported, and the run goes on', async () => {
  const cfg = parseHooksConfig(JSON.stringify({ hooks: [{ event: 'SessionStart', command: 'x' }] }));
  const events = [];
  const runner = createHookRunner({
    hooks: cfg.hooks, root: '/w', onEvent: (e) => events.push(e),
    runImpl: async () => ({ ok: true, exitCode: 1, timedOut: false, stdout: 'ignored', stderr: 'boom' }),
  });
  const res = await runner.sessionStart({ task: 't' });
  assert.equal(res.context, '', "a failed hook's stdout is not an instruction for the model");
  assert.equal(res.failures.length, 1);
  assert.ok(events.some((e) => e.type === 'hook' && e.ok === false && e.blocked === false));
});

test('hook context is CAPPED out loud', async () => {
  const cfg = parseHooksConfig(JSON.stringify({ hooks: [{ event: 'UserPromptSubmit', command: 'x' }] }));
  const runner = createHookRunner({
    hooks: cfg.hooks, root: '/w',
    runImpl: async () => ({ ok: true, exitCode: 0, timedOut: false, stdout: 'y'.repeat(MAX_HOOK_CONTEXT_CHARS * 3), stderr: '' }),
  });
  const res = await runner.promptSubmit({ prompt: 'p' });
  assert.equal(res.ok, true);
  assert.ok(res.context.length < MAX_HOOK_CONTEXT_CHARS + 200);
  assert.match(res.context, /cut at 4000 characters/);
});

test('PreCompact is handed the size of what is about to be compacted, and never blocks', async () => {
  const cfg = parseHooksConfig(JSON.stringify({ hooks: [{ event: 'PreCompact', command: 'snap' }] }));
  let env = null;
  const runner = createHookRunner({
    hooks: cfg.hooks, root: '/w',
    runImpl: async (spec) => { env = spec.env; return { ok: true, exitCode: 3, timedOut: false, stdout: '', stderr: '' }; },
  });
  const res = await runner.preCompact({ estimatedTokens: 123456, messages: 40 });
  assert.equal(env.ACUVO_HOOK_EVENT, 'PreCompact');
  assert.equal(env.ACUVO_COMPACT_ESTIMATED_TOKENS, '123456');
  assert.equal(env.ACUVO_COMPACT_MESSAGES, '40');
  assert.equal(res.ok, false, 'the failure is reported…');
  assert.equal(res.failures[0].exitCode, 3);
  // …and there is no `block` field for a caller to honour: compaction always proceeds.
  assert.equal('record' in res, false);
});
