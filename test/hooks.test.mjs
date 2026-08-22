/**
 * ── LIFECYCLE HOOKS — THE UNIT LEVEL ────────────────────────────────────────
 *
 * The defect these exist for: **every policy this CLI had was a sentence in a
 * prompt asking the model nicely.** `policy.mjs` can withhold a tool from the
 * offer and the dispatcher can refuse a command, but a team that wants
 * "run prettier after every write", "never let this agent touch `infra/`", or
 * "ping me when the session ends" had nowhere to put that. Claude Code has
 * hooks and it is how teams actually adopt an agent — the agent runs inside
 * THEIR rules, not the vendor's.
 *
 * ⭐ THE ONE THAT MATTERS IS `PreToolUse` EXITING NON-ZERO. A hook that can
 * observe but not refuse is a logger, and a logger is not a policy. Every other
 * behaviour here is subordinate to that one.
 *
 * ⚠️ AND THE FAILURE MODE THIS FILE SPENDS MOST OF ITS ASSERTIONS ON IS THE
 * SILENT PASS. This repo's signature defect is capability that is built and
 * never reached; the hook-shaped version of it is a gate that quietly lets
 * everything through — a typo'd event name, a command that is not installed, a
 * hook that hangs and is killed. Each of those must be LOUD, and for
 * `PreToolUse` each of them must BLOCK, because a gate that could not answer
 * has not said yes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HOOKS_CONFIG_FILE,
  HOOK_EVENTS,
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_HOOK_TIMEOUT_MS,
  MAX_HOOK_ENV_CHARS,
  parseHooksConfig,
  loadHooks,
  hooksFor,
  hookEnvironment,
  createHookRunner,
} from '../lib/hooks.mjs';

/* ── helpers ─────────────────────────────────────────────────────────────── */

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeHooks(dir, body) {
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  writeFileSync(join(dir, HOOKS_CONFIG_FILE), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return dir;
}

/** A stand-in for `spawnBounded`, with its exact settle contract. */
function fakeRunner(reply = () => ({ ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' })) {
  const calls = [];
  const run = async (spec) => {
    calls.push(spec);
    return reply(spec, calls.length);
  };
  run.calls = calls;
  return run;
}

const modelCall = (name, args) => ({ id: 'c1', function: { name, arguments: JSON.stringify(args ?? {}) } });

const parsed = (body, opts) => parseHooksConfig(JSON.stringify(body), opts);

/* ── the config file ─────────────────────────────────────────────────────── */

test('no hooks file at all means no hooks, no error, and not one spawn', async (t) => {
  const dir = workspace(t);
  const loaded = loadHooks({ root: dir });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.found, false, 'a workspace with no hooks file has not configured anything');
  assert.deepEqual(loaded.hooks, []);

  const run = fakeRunner();
  const runner = createHookRunner({ hooks: loaded.hooks, root: dir, runImpl: run });
  assert.equal(runner.enabled, false);
  const gate = await runner.before(modelCall('write_file', { path: 'a.txt' }));
  assert.equal(gate.ok, true, 'an unhooked workspace must be byte-identical to the behaviour before hooks existed');
  assert.equal(run.calls.length, 0, 'nothing may be spawned when nothing is configured');
});

test('⚠️ a malformed hooks file is a CONFIGURATION ERROR, never an empty hook list', async (t) => {
  const dir = writeHooks(workspace(t), '{ "hooks": [ ');
  const loaded = loadHooks({ root: dir });
  assert.equal(loaded.ok, false, 'unparseable JSON must not silently degrade to "no hooks"');
  assert.match(loaded.error, /hooks\.json/, 'the error must name the file the user has to open');
  assert.equal(loaded.path, HOOKS_CONFIG_FILE);
});

test('⚠️ a typo in the event name is refused, and the message lists the real ones', () => {
  const r = parsed({ hooks: [{ event: 'PreToolCall', command: 'true' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /PreToolCall/, 'the refusal must quote what the user actually typed');
  for (const e of HOOK_EVENTS) assert.match(r.error, new RegExp(e), `the refusal must name ${e}`);
});

test('⚠️ a hook with no command is refused rather than registered as a no-op', () => {
  const r = parsed({ hooks: [{ event: 'Stop' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /command/);
});

test('⚠️ a hook naming a tool this CLI does not have is refused — it would never fire', () => {
  const r = parsed(
    { hooks: [{ event: 'PreToolUse', tools: ['write_fil'], command: 'true' }] },
    { knownTools: ['write_file', 'read_file'] },
  );
  assert.equal(r.ok, false, 'a misspelled tool name is a gate that silently protects nothing');
  assert.match(r.error, /write_fil/);
});

test('a NAMESPACED (MCP) tool name is accepted without a local-tool check', () => {
  const r = parsed(
    { hooks: [{ event: 'PreToolUse', tools: ['github.create_issue'], command: 'true' }] },
    { knownTools: ['write_file'] },
  );
  assert.equal(r.ok, true, 'MCP tool names are not in TOOL_NAMES and never will be');
});

test('a Stop hook that tries to match a tool is refused — there is no tool to match', () => {
  const r = parsed({ hooks: [{ event: 'Stop', tools: ['write_file'], command: 'true' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /Stop/);
});

test('timeouts default, and a wild one is refused rather than quietly clamped', () => {
  const ok = parsed({ hooks: [{ event: 'Stop', command: 'true' }] });
  assert.equal(ok.hooks[0].timeoutMs, DEFAULT_HOOK_TIMEOUT_MS);

  const explicit = parsed({ hooks: [{ event: 'Stop', command: 'true', timeoutMs: 5_000 }] });
  assert.equal(explicit.hooks[0].timeoutMs, 5_000);

  const wild = parsed({ hooks: [{ event: 'Stop', command: 'true', timeoutMs: MAX_HOOK_TIMEOUT_MS + 1 }] });
  assert.equal(wild.ok, false, 'silently clamping would let a user believe a 10-minute hook is configured');
  assert.match(wild.error, new RegExp(String(MAX_HOOK_TIMEOUT_MS)));
});

/* ── matching ────────────────────────────────────────────────────────────── */

test('matching is by exact tool name, with `*` for every tool', () => {
  const cfg = parsed({
    hooks: [
      { event: 'PreToolUse', tools: ['write_file'], command: 'a' },
      { event: 'PreToolUse', tools: ['*'], command: 'b' },
      { event: 'PostToolUse', tools: ['write_file'], command: 'c' },
      { event: 'Stop', command: 'd' },
    ],
  });
  assert.equal(cfg.ok, true, cfg.error);
  assert.deepEqual(hooksFor(cfg.hooks, 'PreToolUse', 'write_file').map((h) => h.command), ['a', 'b']);
  assert.deepEqual(hooksFor(cfg.hooks, 'PreToolUse', 'read_file').map((h) => h.command), ['b']);
  assert.deepEqual(hooksFor(cfg.hooks, 'PostToolUse', 'read_file').map((h) => h.command), []);
  assert.deepEqual(hooksFor(cfg.hooks, 'Stop', null).map((h) => h.command), ['d']);
});

test('a PreToolUse hook with no `tools` key matches every tool', () => {
  const cfg = parsed({ hooks: [{ event: 'PreToolUse', command: 'a' }] });
  assert.equal(hooksFor(cfg.hooks, 'PreToolUse', 'anything_at_all').length, 1);
});

/* ── what the command can see ────────────────────────────────────────────── */

test('⭐ the tool NAME and its ARGUMENTS reach the command — the whole point of a hook', () => {
  const env = hookEnvironment({
    event: 'PreToolUse',
    toolName: 'write_file',
    args: { path: 'src/app.ts', content: 'export const a = 1;\n' },
    root: '/work',
  });
  assert.equal(env.ACUVO_HOOK_EVENT, 'PreToolUse');
  assert.equal(env.ACUVO_TOOL_NAME, 'write_file');
  assert.equal(env.ACUVO_WORKSPACE_ROOT, '/work');
  assert.deepEqual(JSON.parse(env.ACUVO_TOOL_ARGS), { path: 'src/app.ts', content: 'export const a = 1;\n' });
  /**
   * ⭐ AND THE SCALARS SEPARATELY, because the hook people actually write is
   * `prettier --write "$ACUVO_TOOL_ARG_PATH"` in a POSIX shell or a `cmd.exe`
   * one-liner — neither has a JSON parser, and requiring `jq` would make the
   * feature unusable on the machines it is for.
   */
  assert.equal(env.ACUVO_TOOL_ARG_PATH, 'src/app.ts');
});

test('⚠️ a huge argument is TRUNCATED, because the environment has a hard kernel limit', () => {
  const env = hookEnvironment({
    event: 'PreToolUse',
    toolName: 'write_file',
    args: { path: 'big.js', content: 'x'.repeat(500_000) },
  });
  assert.ok(env.ACUVO_TOOL_ARG_CONTENT.length <= MAX_HOOK_ENV_CHARS + 64, 'an unbounded value would E2BIG the spawn');
  assert.ok(env.ACUVO_TOOL_ARGS.length <= MAX_HOOK_ENV_CHARS + 64);
  assert.match(env.ACUVO_TOOL_ARG_CONTENT, /truncated/, 'silent truncation is the bug class this package treats as worst');
});

test('a PostToolUse hook can see whether the tool SUCCEEDED', () => {
  const env = hookEnvironment({
    event: 'PostToolUse',
    toolName: 'run_command',
    args: { command: 'npm test' },
    result: { ok: false, error: 'exit 1' },
  });
  assert.equal(env.ACUVO_TOOL_OK, '0');
  assert.equal(env.ACUVO_TOOL_ERROR, 'exit 1');
});

test('a Stop hook can see how the session ended', () => {
  const env = hookEnvironment({
    event: 'Stop',
    session: { ok: true, stoppedBecause: 'no-tool-calls', roundsUsed: 3 },
  });
  assert.equal(env.ACUVO_SESSION_OK, '1');
  assert.equal(env.ACUVO_SESSION_STOPPED_BECAUSE, 'no-tool-calls');
  assert.equal(env.ACUVO_SESSION_ROUNDS, '3');
  assert.equal(env.ACUVO_TOOL_NAME, undefined, 'there is no tool at session stop, so inventing one would be a lie');
});

/* ── the blocking behaviour: the reason hooks exist ──────────────────────── */

test('⭐⭐⭐ a PreToolUse hook that exits non-zero BLOCKS the tool call', async () => {
  const cfg = parsed({ hooks: [{ event: 'PreToolUse', tools: ['write_file'], command: 'guard.sh' }] });
  const run = fakeRunner(() => ({ ok: true, exitCode: 2, timedOut: false, stdout: '', stderr: 'infra/ is protected\n' }));
  const events = [];
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/w', runImpl: run, onEvent: (e) => events.push(e) });

  const gate = await runner.before(modelCall('write_file', { path: 'infra/main.tf', content: 'x' }));
  assert.equal(gate.ok, false, 'a non-zero PreToolUse exit that does not block makes the whole feature a logger');
  assert.equal(gate.record.result.ok, false);
  assert.equal(gate.record.mutated, false, 'a blocked call changed nothing and must not claim it did');
  assert.equal(gate.record.name, 'write_file');
  assert.match(gate.record.result.error, /infra\/ is protected/, "the hook's own words must reach the model, or it cannot adapt");
  assert.match(gate.record.result.error, /hook/i);
  const blocked = events.find((e) => e.type === 'hook' && e.blocked === true);
  assert.ok(blocked, 'a block that is not announced is indistinguishable from the tool failing on its own');
});

test('a PreToolUse hook that exits 0 lets the call through', async () => {
  const cfg = parsed({ hooks: [{ event: 'PreToolUse', command: 'ok.sh' }] });
  const run = fakeRunner();
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/w', runImpl: run });
  const gate = await runner.before(modelCall('write_file', { path: 'a.txt' }));
  assert.equal(gate.ok, true);
  assert.equal(run.calls.length, 1);
});

test('⚠️ the FIRST refusal stops the chain — a gate that already said no needs no seconds', async () => {
  const cfg = parsed({
    hooks: [
      { event: 'PreToolUse', command: 'first' },
      { event: 'PreToolUse', command: 'second' },
    ],
  });
  const run = fakeRunner((spec) => ({
    ok: true, exitCode: /first/.test(spec.args.join(' ')) ? 1 : 0, timedOut: false, stdout: '', stderr: 'no',
  }));
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/w', runImpl: run });
  const gate = await runner.before(modelCall('write_file', { path: 'a.txt' }));
  assert.equal(gate.ok, false);
  assert.equal(run.calls.length, 1, 'the second gate ran after the first had already refused the call');
});

/* ── the errors that must not be silent ──────────────────────────────────── */

test('⚠️⚠️ a PreToolUse hook that CANNOT BE RUN blocks and is reported — it never silently passes', async () => {
  const cfg = parsed({ hooks: [{ event: 'PreToolUse', command: 'not-installed' }] });
  const run = fakeRunner(() => ({ ok: false, error: 'spawn ENOENT' }));
  const events = [];
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/w', runImpl: run, onEvent: (e) => events.push(e) });

  const gate = await runner.before(modelCall('write_file', { path: 'a.txt' }));
  assert.equal(gate.ok, false, 'a gate that could not answer has not said yes');
  assert.match(gate.record.result.error, /ENOENT/);
  const err = events.find((e) => e.type === 'hook-error');
  assert.ok(err, 'a hook the machine cannot run is a configuration error the user has to see');
  assert.match(err.error, /ENOENT/);
});

test('⚠️⚠️ a PreToolUse hook that TIMES OUT blocks and is reported as an error, not a pass', async () => {
  const cfg = parsed({ hooks: [{ event: 'PreToolUse', command: 'sleep-forever', timeoutMs: 50 }] });
  const run = fakeRunner(() => ({ ok: true, exitCode: null, timedOut: true, stdout: '', stderr: '' }));
  const events = [];
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/w', runImpl: run, onEvent: (e) => events.push(e) });

  const gate = await runner.before(modelCall('write_file', { path: 'a.txt' }));
  assert.equal(gate.ok, false);
  assert.match(gate.record.result.error, /timed out|timeout/i);
  assert.ok(events.some((e) => e.type === 'hook-error'), 'a killed hook must be loud');
  assert.equal(run.calls[0].timeoutMs, 50, 'the configured bound must reach the spawner or nothing is bounded');
});

test('⭐ every hook is spawned with a TIMEOUT — an unbounded one would hang the agent forever', async () => {
  const cfg = parsed({ hooks: [{ event: 'PreToolUse', command: 'a' }, { event: 'Stop', command: 'b' }] });
  const run = fakeRunner();
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/w', runImpl: run });
  await runner.before(modelCall('write_file', {}));
  await runner.stop({ ok: true, stoppedBecause: 'done', roundsUsed: 1 });
  assert.equal(run.calls.length, 2);
  for (const c of run.calls) {
    assert.equal(typeof c.timeoutMs, 'number');
    assert.ok(c.timeoutMs > 0 && c.timeoutMs <= MAX_HOOK_TIMEOUT_MS, `hook spawned with timeoutMs=${c.timeoutMs}`);
  }
});

/* ── after, and stop ─────────────────────────────────────────────────────── */

test('a PostToolUse failure cannot block — the tool already ran — but it is never swallowed', async () => {
  const cfg = parsed({ hooks: [{ event: 'PostToolUse', tools: ['write_file'], command: 'lint' }] });
  const run = fakeRunner(() => ({ ok: true, exitCode: 1, timedOut: false, stdout: '', stderr: 'lint: 3 errors\n' }));
  const events = [];
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/w', runImpl: run, onEvent: (e) => events.push(e) });

  const out = await runner.after({ id: 'c1', name: 'write_file', args: { path: 'a.ts' }, result: { ok: true, path: 'a.ts' } });
  assert.equal(out.ok, false);
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].output, /3 errors/);
  const evt = events.find((e) => e.type === 'hook' && e.ok === false);
  assert.ok(evt, 'a failing post hook that prints nothing is the silent pass in a different costume');
  assert.equal(evt.blocked, false, 'a post hook must never claim it blocked something that already happened');
});

test('Stop hooks run once, with no tool, and a failure is reported not thrown', async () => {
  const cfg = parsed({ hooks: [{ event: 'Stop', command: 'notify' }] });
  const run = fakeRunner(() => ({ ok: true, exitCode: 7, timedOut: false, stdout: '', stderr: 'no notifier' }));
  const events = [];
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/w', runImpl: run, onEvent: (e) => events.push(e) });

  const out = await runner.stop({ ok: true, stoppedBecause: 'no-tool-calls', roundsUsed: 2 });
  assert.equal(out.ok, false);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].env.ACUVO_HOOK_EVENT, 'Stop');
  assert.equal(run.calls[0].env.ACUVO_SESSION_STOPPED_BECAUSE, 'no-tool-calls');
  assert.ok(events.some((e) => e.type === 'hook' && e.ok === false));
});

test('the hook runs in the WORKSPACE, not in whatever directory the CLI was started from', async () => {
  const cfg = parsed({ hooks: [{ event: 'PreToolUse', command: 'a' }] });
  const run = fakeRunner();
  const runner = createHookRunner({ hooks: cfg.hooks, root: '/work/tree', runImpl: run });
  await runner.before(modelCall('read_file', { path: 'x' }));
  assert.equal(run.calls[0].cwd, '/work/tree');
});
