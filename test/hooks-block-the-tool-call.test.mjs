/**
 * ── ⭐⭐⭐ HOOKS, END TO END, THROUGH THE REAL `runSession` ────────────────────
 *
 * `hooks.test.mjs` proves the module. This proves the WIRING, and in this
 * package that is the distinction that matters: `wiring-reach.test.mjs` exists
 * because 39% of this codebase was once finished, unit-tested, and imported by
 * nothing. A hook runner that blocks perfectly in a unit test and is never
 * consulted by the tool loop has shipped exactly nothing.
 *
 * ⚠️ EVERYTHING HERE IS REAL EXCEPT THE MODEL. A real `.acuvo/hooks.json` on
 * disk, a real workspace, a real `spawnBounded` running a real child process
 * through the platform's real shell — because the three things most likely to
 * be wrong are the ones a fake spawner cannot see: whether the hook is spawned
 * at all, whether its environment survives the scrub, and whether a non-zero
 * exit reaches the loop as a refusal.
 *
 * ⭐ THE HOOK COMMAND IS `node <file>` RATHER THAN A SHELL ONE-LINER, and that
 * is not squeamishness: `echo %VAR%` and `echo $VAR` are different languages,
 * so a one-liner would test cmd.exe on this laptop and sh in CI. `node` is
 * guaranteed present — it is running this test — and the script is identical on
 * both platforms, which is what makes the assertion about ACUVO_TOOL_ARG_PATH
 * mean the same thing everywhere.
 *
 * SPENDS NOTHING: `callModelImpl` is a stub, so no provider is contacted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession, renderEvent } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { HOOKS_CONFIG_FILE } from '../lib/hooks.mjs';

/* ── fixtures ────────────────────────────────────────────────────────────── */

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-hooks-e2e-'));
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hooksFile = (dir, hooks) =>
  writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({ hooks }, null, 2), 'utf8');

/**
 * A hook script that records the environment it was handed and exits with a
 * code we choose. Written into the workspace so the command is a bare
 * `node <name>` with no quoting to get wrong on either platform.
 */
function hookScript(dir, name, { exitCode = 0, say = '' }) {
  writeFileSync(join(dir, name), [
    "import { writeFileSync, readFileSync, existsSync } from 'node:fs';",
    `const out = ${JSON.stringify(join(dir, `${name}.seen.json`))};`,
    "const seen = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : [];",
    'seen.push({',
    '  event: process.env.ACUVO_HOOK_EVENT ?? null,',
    '  tool: process.env.ACUVO_TOOL_NAME ?? null,',
    '  args: process.env.ACUVO_TOOL_ARGS ?? null,',
    '  path: process.env.ACUVO_TOOL_ARG_PATH ?? null,',
    '  ok: process.env.ACUVO_TOOL_OK ?? null,',
    '  stoppedBecause: process.env.ACUVO_SESSION_STOPPED_BECAUSE ?? null,',
    '  cwd: process.cwd(),',
    // ⚠️ The one negative assertion that matters: a hook must never be handed
    // the key this process is holding. `scrubEnvironment` owns that promise and
    // this is where it is proven for the hook path specifically.
    '  sawApiKey: process.env.OPENROUTER_API_KEY !== undefined,',
    '});',
    'writeFileSync(out, JSON.stringify(seen));',
    say ? `process.stderr.write(${JSON.stringify(say)});` : '',
    `process.exit(${exitCode});`,
  ].filter(Boolean).join('\n'), 'utf8');
  return {
    command: `node ${name}`,
    seen: () => (existsSync(join(dir, `${name}.seen.json`))
      ? JSON.parse(readFileSync(join(dir, `${name}.seen.json`), 'utf8'))
      : []),
  };
}

/** A model that asks for one `write_file` in round 1 and then says it is done. */
function modelThatWrites(path, content) {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) {
      return {
        ok: true,
        content: 'writing it now',
        toolCalls: [{ id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path, content }) } }],
        usage: null,
        finishReason: 'tool_calls',
      };
    }
    return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
  };
}

const session = (dir, opts = {}) => runSession({
  task: 'write the file',
  executor: createLocalExecutor(dir),
  config: { apiKey: 'k', model: 'm' },
  maxRounds: 2,
  allowRun: false,
  ...opts,
});

/* ── the whole point ─────────────────────────────────────────────────────── */

test('⭐⭐⭐ a PreToolUse hook that exits non-zero STOPS the write from reaching disk', async (t) => {
  const dir = workspace(t);
  const guard = hookScript(dir, 'guard.mjs', { exitCode: 1, say: 'infra/ is protected — ask a human' });
  hooksFile(dir, [{ event: 'PreToolUse', tools: ['write_file'], command: guard.command, name: 'protect-infra' }]);

  const events = [];
  const outcome = await session(dir, {
    onEvent: (e) => events.push(e),
    callModelImpl: modelThatWrites('infra/main.tf', 'resource "aws_iam_role" "x" {}'),
  });

  assert.equal(outcome.ok, true, `session errored: ${outcome.error}`);
  assert.equal(
    existsSync(join(dir, 'infra', 'main.tf')), false,
    'THE FILE IS ON DISK — the hook ran and the dispatcher wrote anyway, which makes hooks a logger',
  );

  const record = outcome.executed.find((r) => r.name === 'write_file');
  assert.ok(record, 'the blocked call must still be recorded — a refusal nobody can see did not happen');
  assert.equal(record.result.ok, false);
  assert.equal(record.mutated, false);
  assert.equal(record.result.blockedByHook, 'protect-infra');
  assert.match(record.result.error, /infra\/ is protected/, "the guard's own stderr must reach the model");
  assert.match(record.result.error, /do not retry/i, 'a policy the model retries is a policy that costs tokens forever');

  // ⭐ And the hook really did see the call it was asked about.
  const seen = guard.seen();
  assert.equal(seen.length, 1, 'the hook was spawned exactly once');
  assert.equal(seen[0].event, 'PreToolUse');
  assert.equal(seen[0].tool, 'write_file');
  assert.equal(seen[0].path, 'infra/main.tf', 'ACUVO_TOOL_ARG_PATH is the variable every real hook will use');
  assert.deepEqual(JSON.parse(seen[0].args).path, 'infra/main.tf');
  assert.equal(seen[0].sawApiKey, false, "a user's hook must never inherit this process's provider key");
});

test('⭐ a PreToolUse hook that exits 0 leaves the write completely alone', async (t) => {
  const dir = workspace(t);
  const guard = hookScript(dir, 'allow.mjs', { exitCode: 0 });
  hooksFile(dir, [{ event: 'PreToolUse', tools: ['write_file'], command: guard.command }]);

  const outcome = await session(dir, { callModelImpl: modelThatWrites('src/app.ts', 'export const a = 1;\n') });
  assert.equal(outcome.ok, true, `session errored: ${outcome.error}`);
  assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(guard.seen().length, 1);
});

test('⭐⭐ a PostToolUse failure reaches the MODEL, not just the terminal', async (t) => {
  const dir = workspace(t);
  const linter = hookScript(dir, 'lint.mjs', { exitCode: 1, say: "lint: 'a' is assigned but never used" });
  hooksFile(dir, [{ event: 'PostToolUse', tools: ['write_file'], command: linter.command, name: 'eslint' }]);

  /**
   * ⭐ MEASURED AT THE TRANSPORT. The only place that proves the hook's
   * complaint entered the CONVERSATION is the messages the second round is
   * called with — a record field the model never reads would be a log line
   * wearing a feature's name.
   */
  let secondRoundMessages = null;
  let round = 0;
  const outcome = await session(dir, {
    callModelImpl: async ({ messages }) => {
      round += 1;
      if (round === 1) {
        return {
          ok: true, content: '', usage: null, finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.ts', content: 'const a = 1;\n' }) } }],
        };
      }
      secondRoundMessages = messages;
      return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
    },
  });

  assert.equal(outcome.ok, true, `session errored: ${outcome.error}`);
  // The tool itself SUCCEEDED — a post hook cannot undo a write.
  assert.equal(existsSync(join(dir, 'a.ts')), true, 'a PostToolUse hook must not be able to unwrite a file');
  const record = outcome.executed.find((r) => r.name === 'write_file');
  assert.equal(record.result.ok, true, 'the write happened; the hook is a note about it, not a verdict on it');
  assert.equal(record.hookFailures.length, 1);

  const toolMessage = secondRoundMessages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(toolMessage, 'the tool result never reached round 2');
  assert.match(toolMessage.content, /created a\.ts/, "the tool's own result must survive");
  assert.match(toolMessage.content, /assigned but never used/, 'the linter told the terminal and left the model believing the file was clean');
  assert.equal(linter.seen()[0].ok, '1', 'a post hook must be able to see whether the tool succeeded');
});

test('⭐ the Stop hook fires when the session ends, and knows how it ended', async (t) => {
  const dir = workspace(t);
  const notify = hookScript(dir, 'notify.mjs', { exitCode: 0 });
  hooksFile(dir, [{ event: 'Stop', command: notify.command }]);

  const outcome = await session(dir, {
    callModelImpl: async () => ({ ok: true, content: 'nothing to do', toolCalls: [], usage: null, finishReason: 'stop' }),
  });
  assert.equal(outcome.ok, true);
  const seen = notify.seen();
  assert.equal(seen.length, 1, 'the Stop hook must fire exactly once per session');
  assert.equal(seen[0].event, 'Stop');
  assert.equal(seen[0].stoppedBecause, 'no-tool-calls');
  assert.equal(seen[0].tool, null, 'there is no tool at session stop');
});

test('⚠️⚠️ the Stop hook ALSO fires when round 1 fails — silence must not mean "still working"', async (t) => {
  const dir = workspace(t);
  const notify = hookScript(dir, 'notify.mjs', { exitCode: 0 });
  hooksFile(dir, [{ event: 'Stop', command: notify.command }]);

  const outcome = await session(dir, {
    callModelImpl: async () => ({ ok: false, error: 'chain exhausted: 429 from every provider' }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stage, 'model');
  const seen = notify.seen();
  assert.equal(seen.length, 1, 'the early return skipped the Stop hook — the run a notifier most needs to report');
  assert.equal(seen[0].stoppedBecause, 'model-error');
});

/* ── the configuration errors that must not be silent ────────────────────── */

test('⚠️⚠️ a malformed hooks.json FAILS THE RUN — it never degrades to unhooked', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, HOOKS_CONFIG_FILE), '{ "hooks": [ {"event": "PreToolUse"', 'utf8');

  let modelWasCalled = false;
  const outcome = await session(dir, {
    callModelImpl: async () => { modelWasCalled = true; return { ok: true, content: '', toolCalls: [], usage: null, finishReason: 'stop' }; },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stage, 'hooks');
  assert.match(outcome.error, /hooks\.json/);
  assert.equal(modelWasCalled, false, 'a run whose gate could not be read must not spend a single token');
});

test('⚠️ a hook pinned to a tool that does not exist is refused before the run starts', async (t) => {
  const dir = workspace(t);
  hooksFile(dir, [{ event: 'PreToolUse', tools: ['write_fil'], command: 'node nope.mjs' }]);
  const outcome = await session(dir, { callModelImpl: async () => ({ ok: true, content: '', toolCalls: [], usage: null, finishReason: 'stop' }) });
  assert.equal(outcome.ok, false, 'a gate on a misspelled tool never fires, so it protects nothing');
  assert.equal(outcome.stage, 'hooks');
  assert.match(outcome.error, /write_fil/);
});

test('⚠️⚠️ a PreToolUse hook that CANNOT BE RUN blocks the call and is announced', async (t) => {
  const dir = workspace(t);
  // ⚠️ A REAL, ABSENT PROGRAM. Both shells report a non-zero exit for an unknown
  // command rather than failing the spawn of the shell itself — so this is the
  // honest cross-platform shape of "the guard is not installed on this machine".
  hooksFile(dir, [{ event: 'PreToolUse', tools: ['write_file'], command: 'acuvo-no-such-guard-binary', name: 'missing-guard' }]);

  const events = [];
  const outcome = await session(dir, {
    onEvent: (e) => events.push(e),
    callModelImpl: modelThatWrites('a.txt', 'hello'),
  });
  assert.equal(outcome.ok, true, `session errored: ${outcome.error}`);
  assert.equal(existsSync(join(dir, 'a.txt')), false, 'a gate that could not answer was treated as a yes');

  const record = outcome.executed.find((r) => r.name === 'write_file');
  assert.equal(record.result.ok, false);
  assert.equal(record.result.blockedByHook, 'missing-guard');

  const announced = events.filter((e) => e.type === 'hook' || e.type === 'hook-error');
  assert.ok(announced.length > 0, 'a hook that refused a call in silence is the failure this module exists to remove');
});

test('⚠️ an unhooked workspace is byte-identical to the behaviour before hooks existed', async (t) => {
  const dir = workspace(t);
  const events = [];
  const outcome = await session(dir, {
    onEvent: (e) => events.push(e),
    callModelImpl: modelThatWrites('a.txt', 'hello'),
  });
  assert.equal(outcome.ok, true, `session errored: ${outcome.error}`);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'hello');
  assert.equal(events.filter((e) => e.type === 'hook' || e.type === 'hook-error').length, 0);
});

/* ── the renderer ────────────────────────────────────────────────────────── */

test('⚠️ a failing hook PRINTS — an event printer that falls through is the silent gate again', () => {
  const blocked = renderEvent({
    type: 'hook', event: 'PreToolUse', tool: 'write_file', hook: 'protect-infra',
    command: 'node guard.mjs', ok: false, blocked: true, exitCode: 1, output: 'infra/ is protected',
  }).join('\n');
  assert.match(blocked, /blocked/);
  assert.match(blocked, /protect-infra/);
  assert.match(blocked, /infra\/ is protected/);

  const broken = renderEvent({
    type: 'hook-error', event: 'PreToolUse', tool: 'write_file', hook: 'missing-guard',
    command: 'node guard.mjs', error: 'spawn ENOENT', output: '', blocked: true,
  }).join('\n');
  assert.match(broken, /ENOENT/);
  assert.match(broken, /node guard\.mjs/, 'the command must be named, or the user cannot tell which line to fix');

  // ⭐ AND A PASSING HOOK IS QUIET. It fires on every matching tool call; a line
  // each would double the transcript to report that nothing happened.
  assert.deepEqual(
    renderEvent({ type: 'hook', event: 'PostToolUse', tool: 'write_file', hook: 'prettier', ok: true, blocked: false, exitCode: 0, output: '' }),
    [],
  );
});
