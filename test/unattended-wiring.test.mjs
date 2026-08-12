/**
 * ── ⭐⭐ THE ANTI-ORPHAN TEST FOR THE UNATTENDED LOOP ────────────────────────
 *
 * `lib/budget.mjs`, `lib/lease.mjs`, `lib/repo-map.mjs` and `lib/stuck.mjs`
 * shipped finished, documented and tested — and imported by NOTHING. In this
 * package that is the same as not shipping: 7,397 lines (39%) once sat in
 * exactly that state, and every one of them had a green unit test.
 *
 * ⚠️ SO NOTHING HERE UNIT-TESTS THOSE MODULES. Their own test files already do
 * that, and every one of them would stay green forever while `--budget` did not
 * exist. This file asserts the opposite thing: that the RUNTIME PATH REACHES
 * THEM — by spawning the binary a user types, or by driving the real
 * `runSession`, and watching the new behaviour come out the far end.
 *
 * ⚠️ AND IT COSTS $0.00. Every model is injected (`callModelImpl`), every clock
 * is injected, and the two CLI assertions that would otherwise need a key are
 * chosen precisely because they must answer BEFORE any network call — the
 * budget preflight and the `leases` command. A test that only passes on a
 * configured machine is a test that gets deleted the first week it fires in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgv, USAGE, UNTIL_DONE_MAX_ROUNDS, DEFAULT_MAX_ROUNDS } from '../lib/cli-args.mjs';
import { DEFAULT_BUDGET_USD } from '../lib/budget.mjs';
import { runSession, formatSummary, renderEvent } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { declareAcceptance } from '../lib/acceptance.mjs';
import { acquire } from '../lib/lease.mjs';

const CLI = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 64;

/** Spawn the real binary with a scrubbed environment. Never reaches a model. */
function runCli(args, { key = null, cwd = undefined } = {}) {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const v of ['OPENROUTER_API_KEY', 'MODAL_TTS_URL', 'MODAL_TRANSCRIBE_URL', 'MODAL_PRESS_URL', 'RENDER_AUDIT_URL', 'MODAL_VIDEO_SECRET', 'PERCHANCE_IMAGE_URL']) {
    delete env[v];
  }
  if (key !== null) env.OPENROUTER_API_KEY = key;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', input: '', timeout: 60_000, windowsHide: true, env, cwd,
  });
}

const made = [];
function workspace({ gitignore = null, files = {}, scripts = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-unattended-'));
  made.push(root);
  const pkg = { name: 'demo', version: '1.0.0', ...(scripts ? { scripts } : {}) };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg)}\n`);
  if (gitignore) writeFileSync(join(root, '.gitignore'), gitignore);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}
test.after(() => {
  for (const dir of made) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ } }
});

/** A scripted model. Records what it was asked, answers from a list. */
function scripted(script) {
  let i = 0;
  const prompts = [];
  const impl = async (opts) => {
    prompts.push(opts.messages);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return typeof step === 'function' ? step(i) : step;
  };
  impl.calls = () => i;
  impl.prompts = prompts;
  impl.lastMessages = () => prompts[prompts.length - 1] ?? [];
  return impl;
}

const reply = (content, toolCalls = [], usage = { cost: 0.001, total_tokens: 1000 }) => ({
  ok: true, content, toolCalls, usage, finishReason: 'stop', model: 'fake/model',
});
const call = (name, args) => ({ id: `c_${name}_${Math.random().toString(36).slice(2, 6)}`, function: { name, arguments: JSON.stringify(args) } });

const session = (root, extra = {}) => runSession({
  task: extra.task ?? 'do the thing',
  executor: createLocalExecutor(root),
  config: { apiKey: 'k', model: 'fake/model' },
  maxRounds: 4,
  allowRun: false,
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE FLAG — lib/cli-args.mjs reaches lib/budget.mjs
 * ══════════════════════════════════════════════════════════════════════════ */

test('--budget parses through budget.mjs, in every spelling a person types', () => {
  for (const [raw, usd] of [['0.50', 0.5], ['$0.50', 0.5], ['.5', 0.5], ['25c', 0.25], ['1,000', 1000], ['2usd', 2]]) {
    const p = parseArgv(['--budget', raw, 'task']);
    assert.ok(p.ok, `--budget ${raw} was refused: ${p.error}`);
    assert.equal(p.options.budgetUsd, usd, `--budget ${raw}`);
  }
});

test('--budget refuses what cannot be a budget, with a sentence not a stack trace', () => {
  for (const raw of ['lots', '0', '-1']) {
    const p = parseArgv(['--budget', raw, 'task']);
    assert.equal(p.ok, false, `--budget ${raw} was accepted`);
    assert.match(p.error, /budget/i);
  }
  const missing = parseArgv(['--budget']);
  assert.equal(missing.ok, false, '--budget with no value must be refused');
});

test('⭐ no --budget now means the DEFAULT ceiling — everything else is still untouched', () => {
  /**
   * ⚠️ THIS TEST USED TO ASSERT `budgetUsd === null`, and it was right to. The
   * rule it enforced — a new flag must be inert until someone types it — is the
   * only way to add options to a tool people already script against.
   *
   * ⭐ IT WAS CHANGED ON PURPOSE, 2026-08-12, and the reason is the opposite of
   * a new flag: the governor was ALREADY BUILT and unreachable, so "inert by
   * default" was not protecting a user's expectations, it was hiding the one
   * behaviour no competitor offers. See DEFAULT_BUDGET_USD in budget.mjs.
   *
   * ⭐ EVERY OTHER DEFAULT IN THIS ASSERTION IS DELIBERATELY UNCHANGED, and the
   * point of keeping them here is that one considered exception must not become
   * licence for the next one.
   */
  const p = parseArgv(['just do it']);
  assert.ok(p.ok);
  assert.equal(p.options.budgetUsd, DEFAULT_BUDGET_USD, 'the ceiling is on by default now');
  assert.equal(p.options.budgetExplicit, false, 'and it knows nobody chose it');
  assert.equal(p.options.untilDone, false);
  assert.equal(p.options.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.deepEqual(p.options.lease, []);

  // ⚠️ And the way back to yesterday's behaviour must exist, exactly.
  const off = parseArgv(['--budget', 'none', 'just do it']);
  assert.ok(off.ok);
  assert.equal(off.options.budgetUsd, null, '--budget none restores the unbounded default');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. ⚠️⚠️ --until-done WITHOUT --budget IS THE ONE THING THIS CLI MAY NOT DO
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ --until-done WITHOUT --budget is REFUSED — an unbounded loop on someone else\'s money', () => {
  const p = parseArgv(['--until-done', 'grind on this']);
  assert.equal(p.ok, false, '--until-done was accepted with no spending ceiling');
  assert.match(p.error, /--budget/, 'the refusal must name the flag that fixes it');
});

test('--until-done --budget raises the round backstop so MONEY is the wall', () => {
  const p = parseArgv(['--until-done', '--budget', '0.25', 'grind']);
  assert.ok(p.ok, p.error);
  assert.equal(p.options.untilDone, true);
  assert.equal(p.options.budgetUsd, 0.25);
  assert.equal(p.options.maxRounds, UNTIL_DONE_MAX_ROUNDS);
  assert.ok(UNTIL_DONE_MAX_ROUNDS > 16, 'the backstop must be far above the hand-typed ceiling');
});

test('an EXPLICIT --max-rounds still wins under --until-done — the user asked', () => {
  const p = parseArgv(['--until-done', '--budget', '0.25', '--max-rounds', '4', 'grind']);
  assert.ok(p.ok, p.error);
  assert.equal(p.options.maxRounds, 4);
});

test('--budget with --parallel is refused rather than silently multiplied by N', () => {
  const p = parseArgv(['--parallel', '--budget', '0.50', 'a', 'b', 'c']);
  assert.equal(p.ok, false, 'a per-task ceiling presented as a total is a lie about money');
  assert.match(p.error, /parallel/i);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE LEASE FLAGS
 * ══════════════════════════════════════════════════════════════════════════ */

test('--lease is repeatable and `leases` is a command', () => {
  const p = parseArgv(['--lease', 'src/a.ts', '--lease', 'src/b.ts', 'edit them']);
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.options.lease, ['src/a.ts', 'src/b.ts']);
  assert.equal(p.options.task, 'edit them');

  const l = parseArgv(['leases']);
  assert.ok(l.ok, l.error);
  assert.equal(l.options.command, 'leases');
  assert.equal(l.options.task, '', 'the command word must not become the task');
});

test('a task that merely starts with the word "leases" is still a task', () => {
  const p = parseArgv(['leases', 'are', 'broken', 'please', 'fix']);
  assert.ok(p.ok, p.error);
  assert.equal(p.options.command, null, 'only a bare `acuvo leases` is the command');
  assert.match(p.options.task, /^leases are broken/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. THE GOVERNOR — the loop stops on MONEY, not on a counter
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ THE PREFLIGHT — an unaffordable budget spends NOTHING, not one round', async () => {
  const root = workspace();
  const model = scripted([reply('hi')]);
  const out = await session(root, { budgetUsd: 0.0000001, callModelImpl: model, maxRounds: 8 });

  assert.equal(model.calls(), 0, 'a round was paid for before the budget was consulted');
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'budget');
  assert.equal(out.stoppedBecause, 'too-small');
  assert.match(out.error, /cannot cover even one round/i);
  // ⚠️ formatSummary must print the reason, not "✖ undefined".
  assert.match(formatSummary(out).join('\n'), /cannot cover even one round/i);
});

test('the loop stops on the BUDGET before it stops on the round counter', async () => {
  const root = workspace();
  // Each round costs $0.004. A $0.010 budget can pay for two and must refuse a third.
  const model = scripted([reply('again', [call('write_file', { path: 'a.js', content: 'a\n' })], { cost: 0.004, total_tokens: 4000 })]);
  const events = [];
  const out = await session(root, {
    budgetUsd: 0.010, maxRounds: 16, callModelImpl: model, onEvent: (e) => events.push(e),
  });

  assert.ok(out.ok, JSON.stringify(out));
  assert.ok(model.calls() < 16, `the round counter, not the budget, was the wall (${model.calls()} rounds)`);
  assert.ok(['would-exceed', 'limit-reached'].includes(out.stoppedBecause), `stoppedBecause was ${out.stoppedBecause}`);
  assert.ok(events.some((e) => e.type === 'budget-stop'), 'the stop was silent');
  assert.ok(out.budget.spentUsd <= 0.010 + 0.004, 'it overshot by more than one round');
  assert.match(out.budgetReport, /^budget: /);

  /**
   * ⚠️⚠️ THE THIRD SEAM, PINNED. A `budgetReport` string that nothing prints is
   * the same orphan as a module nothing imports — and this assertion is here
   * because a mutation that deleted the summary line left every other budget
   * test GREEN. What the user is owed is the LINE, not the field.
   */
  const summary = formatSummary(out).join('\n');
  assert.ok(summary.includes(out.budgetReport), `the budget line never reached the summary:\n${summary}`);
  assert.match(summary, /spending ceiling|budget: /, 'the summary never says money was the wall');
});

test('a run with NO --budget is never stopped by money and reports none', async () => {
  const root = workspace();
  const model = scripted([reply('done')]);
  const out = await session(root, { callModelImpl: model });
  assert.equal(out.stoppedBecause, 'no-tool-calls');
  assert.equal(out.budget, undefined, 'a run that set no budget must not grow a budget field');
  assert.equal(out.budgetReport, undefined);
  assert.ok(!formatSummary(out).join('\n').includes('budget:'), 'a budget line appeared for a run with no budget');
});

test('⚠️ A TRANSPORT FAILURE IS CHARGED, NOT COUNTED FREE', async () => {
  const root = workspace();
  let n = 0;
  const model = async () => {
    n += 1;
    if (n === 1) return reply('writing', [call('write_file', { path: 'a.js', content: 'a\n' })], { cost: 0.001, total_tokens: 1000 });
    return { ok: false, error: 'provider exploded after billing' };
  };
  const out = await session(root, { budgetUsd: 1, maxRounds: 4, callModelImpl: model });
  assert.equal(out.stoppedBecause, 'model-error');
  assert.equal(out.budget.rounds, 2, 'the failed round was not recorded — a provider that errors after billing looked free');
  assert.ok(out.budget.spentUsd > 0.001, 'the failed round was priced at zero, which is the unknown-priced-as-zero trap');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. THE REPO MAP — the model sees the whole repo, and not the secrets
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ the repo map reaches the model: a file four levels deep, referenced by nothing', async () => {
  const root = workspace({
    gitignore: 'secret.txt\n',
    files: {
      'src/deep/deeper/buried.js': 'export function buriedTreasure() { return 1; }\n',
      'secret.txt': 'SUPER-SECRET-VALUE-42\n',
    },
  });
  const model = scripted([reply('nothing to do')]);
  await session(root, { callModelImpl: model });

  const prompt = model.lastMessages().map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.match(prompt, /src\/deep\/deeper\/buried\.js/, 'the deep file never reached the model');
  assert.match(prompt, /buriedTreasure/, 'its exported symbol never reached the model');
});

test('⚠️⚠️ a gitignored file\'s CONTENTS no longer reach the provider', async () => {
  const root = workspace({
    gitignore: 'secret.txt\n',
    files: { 'secret.txt': 'SUPER-SECRET-VALUE-42\n' },
  });
  const model = scripted([reply('nothing to do')]);
  await session(root, { callModelImpl: model });

  const prompt = model.lastMessages().map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.ok(
    !prompt.includes('SUPER-SECRET-VALUE-42'),
    'the body of a gitignored file was sent to the model — that is the leak the repo map exists to close',
  );
});

test('⭐⭐ THE CACHE PREFIX SURVIVES: rounds 2..N open with byte-identical messages', async () => {
  /**
   * ⚠️ THIS IS WORTH 3.05x ON DEEPSEEK AND IT IS INVISIBLE WHEN IT BREAKS. A
   * cached prefix only fires on BYTE-IDENTICAL bytes; a repo map that reshuffled,
   * a nudge inserted rather than appended, or a countdown edited into the system
   * message would each throw the whole cache away and nothing would look wrong.
   *
   * The rule this pins: everything variable goes at the END. So message[0] (the
   * system prompt) and message[1] (the task + the repo map) must be identical in
   * every round — INCLUDING the rounds where a nudge was injected.
   */
  const root = workspace({ files: { 'src/deep/deeper/buried.js': 'export const x = 1;\n' } });
  // Identical writes, so the stuck nudge fires part-way through and we prove it
  // did not disturb the prefix.
  const model = scripted([reply('again', [call('write_file', { path: 'same.js', content: 'IDENTICAL\n' })])]);
  const out = await session(root, { maxRounds: 5, callModelImpl: model });

  assert.ok(model.prompts.length >= 4, `only ${model.prompts.length} rounds ran`);
  const [sys0, user0] = model.prompts[0];
  for (let i = 1; i < model.prompts.length; i += 1) {
    const [sys, user] = model.prompts[i];
    assert.equal(sys.content, sys0.content, `round ${i + 1} rewrote the SYSTEM message — the cache prefix is dead`);
    assert.equal(user.content, user0.content, `round ${i + 1} rewrote the first USER message — the cache prefix is dead`);
  }
  // …and the nudge really did happen, so this is not a vacuous pass.
  assert.ok(
    out.messages.some((m) => typeof m.content === 'string' && m.content.includes('[loop watcher')),
    'no nudge fired, so this proved nothing about a prefix under pressure',
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. STUCK — the nudge lands in the conversation, once
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ a proven loop gets ONE nudge, and only one — re-nudging destroys the prompt cache', async () => {
  const root = workspace();
  // The same bytes to the same path, over and over: the detector's clearest case.
  const model = scripted([reply('writing it again', [call('write_file', { path: 'same.js', content: 'IDENTICAL\n' })])]);
  const events = [];
  const out = await session(root, { maxRounds: 6, callModelImpl: model, onEvent: (e) => events.push(e) });

  const nudges = out.messages.filter((m) => typeof m.content === 'string' && m.content.includes('[loop watcher'));
  assert.equal(nudges.length, 1, `expected exactly one nudge, got ${nudges.length}`);
  assert.match(nudges[0].content, /same\.js/, 'the nudge must name the artifact');
  assert.ok(events.some((e) => e.type === 'stuck'), 'the loop was detected silently');
});

test('a healthy run is never nudged', async () => {
  const root = workspace();
  const model = scripted([
    reply('one', [call('write_file', { path: 'a.js', content: 'a\n' })]),
    reply('two', [call('write_file', { path: 'b.js', content: 'b\n' })]),
    reply('done'),
  ]);
  const out = await session(root, { maxRounds: 6, callModelImpl: model });
  assert.equal(out.messages.filter((m) => typeof m.content === 'string' && m.content.includes('[loop watcher')).length, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. --until-done — it does not hand back a half-finished job
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ --until-done presses on when a DECLARED criterion is still unmet', async () => {
  // ⚠️ The script must EXIST. `declareAcceptance` marks a criterion unrunnable
  // when package.json has no such script, and an unrunnable criterion must not
  // press on — see the test below, which pins that.
  const root = workspace({ scripts: { test: 'node --test' } });
  const declared = declareAcceptance(root, { commands: ['npm test'] });
  assert.ok(declared.ok, declared.error);

  // The model says "done" immediately. Without --until-done that ends the run.
  const model = scripted([reply('all finished!')]);
  const events = [];
  const out = await session(root, {
    untilDone: true, budgetUsd: 1, maxRounds: 20, callModelImpl: model, onEvent: (e) => events.push(e),
  });

  assert.ok(model.calls() > 1, 'the loop accepted "done" while the declared criterion was unmet');
  assert.ok(events.some((e) => e.type === 'until-done'), 'pressing on was silent');
  const pressed = out.messages.filter((m) => typeof m.content === 'string' && m.content.includes('--until-done'));
  assert.ok(pressed.length >= 1, 'no continuation message reached the model');
  assert.match(pressed[0].content, /npm test/, 'the continuation must name the criterion that is unmet');

  /**
   * ⚠️ THE MODEL'S OWN "I AM FINISHED" MUST BE IN THE RECORD, IMMEDIATELY
   * BEFORE THE CONTINUATION. Two `user` messages back to back with the
   * assistant's answer missing is a conversation where the model is asked to
   * justify something it has no memory of saying — and OpenAI-shaped APIs are
   * entitled to reject the shape outright.
   */
  const at = out.messages.indexOf(pressed[0]);
  assert.ok(at > 0, 'the continuation is the first message in the conversation');
  assert.equal(out.messages[at - 1].role, 'assistant', 'the model\'s reply was dropped from the transcript');
  assert.equal(out.messages[at - 1].content, 'all finished!');
  assert.ok(
    out.messages.every((m, i) => !(i > 0 && m.role === 'user' && out.messages[i - 1].role === 'user')),
    'two user messages in a row — the transcript is malformed',
  );
});

test('⚠️ an UNRUNNABLE criterion does NOT press on — you cannot grind at an impossible thing', async () => {
  // No `test` script, so `npm test` is declared-but-unrunnable. Pressing on here
  // would spend the whole budget asking a model to satisfy something that has no
  // way to run — the check-that-fails-correct-work failure with a bill attached.
  const root = workspace();
  const declared = declareAcceptance(root, { commands: ['npm test'] });
  assert.ok(declared.ok, declared.error);
  const model = scripted([reply('all finished!')]);
  const out = await session(root, { untilDone: true, budgetUsd: 1, maxRounds: 20, callModelImpl: model });
  assert.equal(model.calls(), 1, 'it ground away at a criterion that can never run');
  assert.equal(out.stoppedBecause, 'no-tool-calls');
});

test('--until-done stops anyway when the budget runs out — money is the wall', async () => {
  const root = workspace({ scripts: { test: 'node --test' } });
  declareAcceptance(root, { commands: ['npm test'] });
  const model = scripted([reply('all finished!', [], { cost: 0.004, total_tokens: 4000 })]);
  const out = await session(root, { untilDone: true, budgetUsd: 0.010, maxRounds: 500, callModelImpl: model });
  assert.ok(model.calls() < 500, 'an --until-done run was bounded only by the round backstop');
  assert.ok(out.budget.spentUsd <= 0.014, `overspent: ${out.budget.spentUsd}`);
});

test('--until-done with NOTHING declared behaves exactly like a normal run', async () => {
  const root = workspace();
  const model = scripted([reply('done')]);
  const out = await session(root, { untilDone: true, budgetUsd: 1, maxRounds: 20, callModelImpl: model });
  assert.equal(model.calls(), 1, 'it invented work to do when no criterion was declared');
  assert.equal(out.stoppedBecause, 'no-tool-calls');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. ⭐⭐ THE DELIVERABLE IS A COMMAND A USER CAN TYPE
 * ══════════════════════════════════════════════════════════════════════════ */

test('--help documents every new flag — a capability only the changelog knows is an orphan', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, EXIT_OK);
  for (const flag of ['--budget', '--until-done', '--lease', 'acuvo leases']) {
    assert.ok(r.stdout.includes(flag), `--help never mentions ${flag}`);
  }
  assert.ok(USAGE.includes('--budget'), 'the USAGE constant itself must carry it');
});

test('⚠️⚠️ `acuvo --until-done "x"` with no budget is a USAGE ERROR at the front door', () => {
  const r = runCli(['--until-done', 'grind on this'], { key: 'sk-or-v1-fake' });
  assert.equal(r.status, EXIT_USAGE, `expected a usage error, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /--budget/);
});

test('⚠️ `acuvo --budget <tiny>` refuses BEFORE it opens a connection', () => {
  const root = workspace();
  // A key that would fail if it were ever used. The preflight must answer first,
  // offline, in well under the model timeout.
  const started = Date.now();
  const r = runCli(['--budget', '0.0000001', '--dir', root, 'write a file'], { key: 'sk-or-v1-not-a-real-key' });
  assert.equal(r.status, EXIT_FAILED, `stdout=${r.stdout.slice(0, 300)} stderr=${r.stderr.slice(0, 300)}`);
  assert.match(`${r.stdout}${r.stderr}`, /cannot cover even one round/i);
  assert.ok(Date.now() - started < 20_000, 'it looks like it went to the network before refusing');
});

test('⭐ `acuvo leases` is a real command: it reads the leases and needs NO API key', () => {
  const root = workspace();
  const empty = runCli(['leases', '--dir', root]);
  assert.equal(empty.status, EXIT_OK, `stderr=${empty.stderr.slice(0, 300)}`);
  assert.match(empty.stdout, /no file leases/i);

  const got = acquire(root, { path: 'src/app.ts', holder: 'terminal-7', pid: 4242 });
  assert.ok(got.ok, got.error);
  const held = runCli(['leases', '--dir', root]);
  assert.equal(held.status, EXIT_OK);
  assert.match(held.stdout, /src\/app\.ts/);
  assert.match(held.stdout, /terminal-7/);
});

test('⭐ `--lease` really takes the lease, and a second terminal is refused', () => {
  const root = workspace();
  const mine = acquire(root, { path: 'src/app.ts', holder: 'other-terminal', pid: 999_999 });
  assert.ok(mine.ok, mine.error);

  // A key is set so the run gets past the key check; it must die on the lease
  // before it ever calls a model.
  const r = runCli(['--lease', 'src/app.ts', '--dir', root, 'edit the app'], { key: 'sk-or-v1-not-a-real-key' });
  assert.equal(r.status, EXIT_FAILED, `stdout=${r.stdout.slice(0, 300)} stderr=${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /other-terminal/, 'the refusal must name who holds it');
});

test('⭐ a lease taken by a run that DIED is still released — proven by taking it again', () => {
  const root = workspace();
  /**
   * ⚠️ NO API KEY, ON PURPOSE. The run dies at the key check, which is BELOW
   * the lease block — so the lease is genuinely taken and the process then
   * exits abnormally, which is exactly the case where a lock gets left behind.
   * Offline, deterministic, and it spends nothing.
   */
  const first = runCli(['--lease', 'src/app.ts', '--dir', root, 'edit the app']);
  assert.equal(first.status, 2, `expected the unconfigured exit, got ${first.status}: ${first.stderr.slice(0, 200)}`);
  assert.match(first.stdout + first.stderr, /leased 1 path/, 'the lease was never taken, so this proves nothing');

  const view = runCli(['leases', '--dir', root]);
  assert.match(view.stdout, /no file leases/i, `a lease survived a process that died:\n${view.stdout}`);

  /**
   * ⭐ AND THE REAL PROOF IS THAT A SECOND RUN CAN TAKE IT. "The file says no
   * lease" and "another terminal can actually start" are different claims, and
   * only the second one is what a person cares about.
   */
  const second = runCli(['--lease', 'src/app.ts', '--dir', root, 'edit the app']);
  assert.equal(second.status, 2, `the second terminal was blocked by a ghost lease: ${second.stderr.slice(0, 300)}`);
  assert.match(second.stdout + second.stderr, /leased 1 path/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. ⚠️ THE REGRESSION: NO NEW FLAG ⇒ NO NEW BEHAVIOUR
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️ a caller passing no new option gets the same outcome as one passing a huge budget', async () => {
  const script = [
    reply('one', [call('write_file', { path: 'a.js', content: 'a\n' })]),
    reply('finished'),
  ];
  const bare = await session(workspace(), { callModelImpl: scripted(script), maxRounds: 5 });
  const rich = await session(workspace(), { callModelImpl: scripted(script), maxRounds: 5, budgetUsd: 1000 });

  const strip = (o) => JSON.stringify({
    ...o, messages: undefined, budget: undefined, budgetReport: undefined,
    executed: o.executed.map((e) => ({ ...e, result: { ...e.result, path: e.result?.path } })),
    rounds: o.rounds.length,
  }).replace(/acuvo-unattended-[\w]+/g, '<ws>').replace(/"durationMs":\d+/g, '"durationMs":0');

  assert.equal(strip(bare), strip(rich), 'the budget changed the outcome of a run it could never stop');
  assert.equal(bare.stoppedBecause, 'no-tool-calls');
});

test('⚠️ every original stop reason still exists and still reads the same', async () => {
  const root = workspace();
  const capped = await session(root, {
    maxRounds: 2,
    callModelImpl: scripted([reply('again', [call('write_file', { path: 'x.js', content: `${Math.random()}\n` })])]),
  });
  assert.equal(capped.stoppedBecause, 'round-cap');
  assert.match(formatSummary(capped).join('\n'), /file/);
});
