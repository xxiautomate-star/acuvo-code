/**
 * The parity commands — /init · /memory · /review · /compact · /context ·
 * /usage · /permissions — and the three hook events added beside them
 * (PostToolUseFailure, StopFailure, PostCompact). See lib/session-commands.mjs.
 *
 * Each command is tested at the three places it can break: the pure module,
 * the `/` registry, and the chat loop that performs the effect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  draftProjectMemory, initProjectMemory, describeMemory, compactHistory, describeContext,
  reviewWorkingTree, INIT_FILE, REVIEW_INSTRUCTION,
} from '../lib/session-commands.mjs';
import { parseSlash, runSlashCommand, SLASH_COMMANDS, helpLines } from '../lib/slash.mjs';
import { runChat } from '../lib/chat.mjs';
import { HOOK_EVENTS, parseHooksConfig, createHookRunner } from '../lib/hooks.mjs';
import { USAGE } from '../lib/cli-args.mjs';
const helpText = () => (Array.isArray(USAGE) ? USAGE.join('\n') : String(USAGE));

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}
function lines(...ls) {
  const body = `${ls.join('\n')}\n`;
  return { isTTY: false, async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8'); } };
}
function tmp() { return mkdtempSync(join(tmpdir(), 'acuvo-parity-')); }

/** A transcript with stale, oversized tool output — the thing /compact exists for. */
function heavyHistory(rounds = 6, size = 9_000) {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do the work' }];
  for (let i = 0; i < rounds; i += 1) {
    const id = `c${i}`;
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: `npm test ${i}` }) } }] });
    msgs.push({ role: 'tool', tool_call_id: id, content: `line ${i}\n`.repeat(size / 8) });
  }
  msgs.push({ role: 'assistant', content: 'done' });
  return msgs;
}

// ── registry reach ──────────────────────────────────────────────────────────

test('⭐ every parity command is registered and listed in /help and --help', () => {
  const names = SLASH_COMMANDS.map((c) => c.name);
  const help = helpLines().join('\n');
  const cli = helpText();
  for (const n of ['init', 'memory', 'review', 'compact', 'context', 'usage', 'permissions']) {
    assert.ok(names.includes(n), `/${n} is not registered`);
    assert.ok(help.includes(`/${n}`), `/${n} missing from /help`);
    assert.ok(cli.includes(`/${n}`), `/${n} missing from acuvo --help`);
  }
});

test('/usage is /cost and /permissions is /approve — the rival names reach the same providers', () => {
  const ctx = {
    cost: () => ({ spentUsd: 0.5, turns: 2 }),
    approve: () => ({ mode: 'auto', modes: ['auto', 'always', 'never'] }),
  };
  assert.deepEqual(runSlashCommand(parseSlash('/usage'), ctx).output, runSlashCommand(parseSlash('/cost'), ctx).output);
  assert.deepEqual(runSlashCommand(parseSlash('/permissions'), ctx).output, runSlashCommand(parseSlash('/approve'), ctx).output);
});

test('/compact parses a token target and refuses anything else without spending', () => {
  assert.equal(runSlashCommand(parseSlash('/compact'), {}).targetTokens, null);
  assert.equal(runSlashCommand(parseSlash('/compact 8000'), {}).targetTokens, 8000);
  assert.equal(runSlashCommand(parseSlash('/compact 8k'), {}).targetTokens, 8000);
  const bad = runSlashCommand(parseSlash('/compact lots'), {});
  assert.equal(bad.effect, undefined);
  assert.match(bad.output.join('\n'), /token target/);
});

test('/init passes --force through and prints what the provider did', () => {
  let got;
  const r = runSlashCommand(parseSlash('/init --force'), { init: (o) => { got = o; return { lines: ['wrote ACUVO.md'] }; } });
  assert.deepEqual(got, { force: true });
  assert.match(r.output.join('\n'), /wrote ACUVO\.md/);
  assert.match(runSlashCommand(parseSlash('/init'), {}).output.join('\n'), /not available/);
});

// ── /init ───────────────────────────────────────────────────────────────────

test('draftProjectMemory writes only what it can see: name, stack, scripts, layout', () => {
  const text = draftProjectMemory({
    rootFiles: ['package.json'],
    dirs: ['src', 'test', 'weird'],
    pkg: { name: 'demo', description: 'a demo', type: 'module', scripts: { test: 'node --test', build: 'tsc', zz: 'x' }, dependencies: {} },
  });
  assert.match(text, /^# ACUVO\.md/);
  assert.match(text, /demo — a demo/);
  assert.match(text, /`npm run test` → `node --test`/);
  assert.match(text, /ES modules/);
  assert.match(text, /`src\/` source/);
  assert.ok(!/weird/.test(text), 'a directory with no known role was described anyway');
});

test('⭐ initProjectMemory writes ACUVO.md once, never overwrites, and will not shadow CLAUDE.md without --force', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }));
    const first = initProjectMemory(dir);
    assert.equal(first.ok, true);
    assert.match(readFileSync(join(dir, INIT_FILE), 'utf8'), /npm run test/);
    const again = initProjectMemory(dir, { force: true });
    assert.equal(again.ok, false, 'an existing ACUVO.md was overwritten');
    assert.match(again.lines[0], /already exists/);

    const other = tmp();
    writeFileSync(join(other, 'CLAUDE.md'), '# rules\n- be careful\n');
    const blocked = initProjectMemory(other);
    assert.equal(blocked.ok, false);
    assert.match(blocked.lines.join('\n'), /CLAUDE\.md.*--force|--force/s);
    assert.ok(!existsSync(join(other, INIT_FILE)));
    assert.equal(initProjectMemory(other, { force: true }).ok, true);
    rmSync(other, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/memory names the file in force and shows it; says so when there is none', () => {
  const dir = tmp();
  try {
    assert.match(describeMemory(dir).join('\n'), /no project memory here/);
    writeFileSync(join(dir, 'AGENTS.md'), '# notes\n- use pnpm\n');
    const out = describeMemory(dir).join('\n');
    assert.match(out, /AGENTS\.md/);
    assert.match(out, /use pnpm/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /compact · /context ─────────────────────────────────────────────────────

test('⭐ compactHistory shrinks stale tool output, removes no message, and keeps the opening byte-identical', () => {
  const h = heavyHistory();
  const done = compactHistory(h, { targetTokens: 3_000 });
  assert.equal(done.changed, true);
  assert.ok(done.after < done.before, `${done.after} !< ${done.before}`);
  assert.equal(done.messages.length, h.length, 'a message was removed');
  assert.deepEqual(done.messages.slice(0, 3), h.slice(0, 3), 'the cached opening was rewritten');
  assert.match(done.lines[0], /compacted/);
});

test('compactHistory on a transcript with nothing stale changes nothing and says so', () => {
  const h = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  const done = compactHistory(h);
  assert.equal(done.changed, false);
  assert.equal(done.messages, h);
  assert.match(done.lines[0], /nothing stale/);
  assert.match(compactHistory(null).lines[0], /no conversation yet/);
});

test('describeContext reports tokens by role', () => {
  const out = describeContext(heavyHistory(2, 800)).join('\n');
  assert.match(out, /tokens of conversation across/);
  assert.match(out, /tool\s+~/);
});

test('⭐⭐ REACH: /compact rewrites the history the NEXT turn is sent, and fires Pre/PostCompact', async () => {
  const sent = [];
  const phases = [];
  let call = 0;
  const out = sink();
  await runChat({
    runOne: async (task, history) => {
      sent.push(history);
      call += 1;
      return { ok: true, messages: call === 1 ? heavyHistory() : [...(history ?? []), { role: 'user', content: task }] };
    },
    render: () => {},
    input: lines('first', '/context', '/compact 3k', 'second', 'exit'),
    output: out,
    slashContext: { onCompact: async (phase) => { phases.push(phase); } },
  });
  assert.equal(sent.length, 2, '/compact or /context was sent to the model');
  const before = JSON.stringify(heavyHistory()).length;
  assert.ok(JSON.stringify(sent[1]).length < before, 'the second turn was sent the uncompacted history');
  assert.deepEqual(phases, ['pre', 'post']);
  assert.match(out.text(), /tokens of conversation across/);
  assert.match(out.text(), /compacted ~/);
});

// ── /review ─────────────────────────────────────────────────────────────────

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

test('⭐ reviewWorkingTree: pattern scan free, then a model task carrying the real diff (--local skips it)', async () => {
  const dir = tmp();
  try {
    git(dir, 'init', '-q');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
    writeFileSync(join(dir, 'a.js'), 'export const x = 1;\n');
    git(dir, 'add', 'a.js');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a');
    writeFileSync(join(dir, 'a.js'), 'export const x = 2;\nexport function run(cmd) { return eval(cmd); }\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'new.js'), 'export const y = 3;\n');

    const full = await reviewWorkingTree(dir, { args: '' });
    assert.match(full.lines[0], /2 changed files/);
    assert.ok(full.task.startsWith(REVIEW_INSTRUCTION));
    assert.match(full.task, /\+export const x = 2;/, 'the diff never reached the task');
    assert.match(full.task, /src\/new\.js/, 'the untracked file was not named');
    assert.doesNotMatch(full.task, /^(\+\+\+ b\/|--- a\/|diff --git a\/)/m, 'a/ b/ prefixes are read as nonexistent files');

    const local = await reviewWorkingTree(dir, { args: '--local' });
    assert.equal(local.task, undefined, '--local still asked the model');

    const scoped = await reviewWorkingTree(dir, { args: 'src' });
    assert.match(scoped.lines[0], /1 changed file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reviewWorkingTree outside git, and on a clean tree, says so and spends nothing', async () => {
  const dir = tmp();
  try {
    const notRepo = await reviewWorkingTree(dir);
    assert.equal(notRepo.task, undefined);
    assert.match(notRepo.lines[0], /git repository/);
    git(dir, 'init', '-q');
    const clean = await reviewWorkingTree(dir);
    assert.equal(clean.task, undefined);
    assert.match(clean.lines[0], /nothing to review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐⭐ REACH: /review hands the provider\'s task to the model as THIS turn; --local-style results do not', async () => {
  const seen = [];
  await runChat({
    runOne: async (task) => { seen.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    input: lines('/review', '/review --local', 'exit'),
    output: sink(),
    slashContext: {
      review: async (args) => (args.includes('--local') ? { lines: ['scan only'] } : { lines: ['x'], task: 'REVIEW THIS DIFF' }),
    },
  });
  assert.deepEqual(seen, ['REVIEW THIS DIFF']);
});

// ── hook events ─────────────────────────────────────────────────────────────

test('the three new hook events are accepted and named in --help', () => {
  const cli = helpText();
  for (const e of ['PostToolUseFailure', 'StopFailure', 'PostCompact']) {
    assert.ok(HOOK_EVENTS.includes(e));
    assert.equal(parseHooksConfig(JSON.stringify({ hooks: [{ event: e, command: 'x' }] })).ok, true, e);
    assert.ok(cli.includes(e), `${e} missing from --help`);
  }
});

test('⭐ PostToolUseFailure fires only on a failed call, StopFailure only on a failed session, PostCompact on demand', async () => {
  const cfg = parseHooksConfig(JSON.stringify({ hooks: [
    { event: 'PostToolUseFailure', command: 'f' },
    { event: 'StopFailure', command: 's' },
    { event: 'PostCompact', command: 'c' },
    { event: 'PostToolUse', command: 'p' },
  ] }));
  assert.equal(cfg.ok, true);
  const fired = [];
  const runner = createHookRunner({
    hooks: cfg.hooks, root: '/w',
    runImpl: async (spec) => { fired.push(spec.env.ACUVO_HOOK_EVENT); return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' }; },
  });
  await runner.after({ name: 'read_file', args: {}, result: { ok: true } });
  assert.deepEqual(fired, ['PostToolUse']);
  fired.length = 0;
  await runner.after({ name: 'read_file', args: {}, result: { ok: false, error: 'nope' } });
  assert.deepEqual(fired.sort(), ['PostToolUse', 'PostToolUseFailure']);
  fired.length = 0;
  await runner.stop({ ok: true });
  assert.deepEqual(fired, []);
  await runner.stop({ ok: false, stoppedBecause: 'model-error' });
  assert.deepEqual(fired, ['StopFailure']);
  fired.length = 0;
  await runner.postCompact({ beforeTokens: 10, afterTokens: 5, messages: 3, trigger: 'manual' });
  assert.deepEqual(fired, ['PostCompact']);
});
