/**
 * ── ⭐⭐ THE REACH TEST: `acuvo rewind` THROUGH THE REAL BINARY ──────────────
 *
 * ⚠️ THE FAILURE THIS PACKAGE HITS MOST IS "BUILT AND ONLY PARTLY CONNECTED" —
 * a module finished, tested and reached by nothing. `test/checkpoint.test.mjs`
 * drives the library; every assertion there would still pass with the command
 * unwired from `bin/acuvo.mjs`. This file spawns the actual CLI.
 *
 * ⚠️⚠️ AND IT ALREADY CAUGHT THE REAL ONE. Written first with the `argv[0] ===
 * 'rewind'` anchor that `board` and `verify` use, `acuvo --dir <ws> rewind` did
 * not dispatch at all: the word fell through as a TASK and a paid agent session
 * spent $0.0030 doing nothing. Twice. No unit test could have found that,
 * because the unit never sees argv.
 *
 * ⭐ NO API KEY IS SET IN ANY OF THESE. That is deliberate and it is a property
 * worth pinning: the moment you most want an undo is the moment something went
 * wrong, and "configure an API key first" would be the worst possible answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openJournal } from '../lib/checkpoint.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

const made = [];
function ws() {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-rewind-cli-'));
  made.push(d);
  return d;
}
const cleanup = () => {
  for (const d of made.splice(0)) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ }
  }
};

/**
 * ⚠️ EVERY CREDENTIAL IS STRIPPED, not just the one we use — a machine with
 * `OPENROUTER_API_KEY` exported would otherwise make this test pass for a
 * reason it is not testing.
 */
function runCli(args, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/API_KEY|OPENROUTER|GROQ|ANTHROPIC/i.test(k)) delete env[k];
    env.ACUVO_SKIP_ENV_FILES = '1';
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** Make a real checkpoint the same way a run does: through the executor. */
function seed(root, runId = 'cli-run') {
  writeFileSync(join(root, 'app.js'), 'ORIGINAL\n', 'utf8');
  const journal = openJournal(root, { runId, task: 'make it better' });
  const ex = createLocalExecutor(root, { journal });
  ex.writeFile('app.js', 'AGENT\n');
  ex.writeFile('extra.js', 'made by the agent\n');
  return journal;
}

test('⭐⭐ `acuvo rewind` LISTS the checkpoints — no key, no network, no cost', async (t) => {
  t.after(cleanup);
  const root = ws();
  seed(root, 'cli-list');

  const { code, out } = await runCli(['rewind'], root);
  assert.equal(code, 0);
  assert.match(out, /cli-list/, 'the id has to be printed or the next command cannot be typed');
  assert.match(out, /2 files/);
  assert.match(out, /make it better/, 'the task is what tells you WHICH run this was');
});

test('⭐⭐ `--dir <path> rewind <id>` restores through the real binary — the flag-before-the-verb case that shipped broken', async (t) => {
  t.after(cleanup);
  const root = ws();
  seed(root, 'cli-restore');

  const { code, out } = await runCli(['--dir', root, 'rewind', 'cli-restore'], tmpdir());

  assert.equal(code, 0, out);
  assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), 'ORIGINAL\n');
  assert.equal(existsSync(join(root, 'extra.js')), false, 'the file the agent created is gone again');
  assert.match(out, /restored app\.js/);
});

test('⚠️ a workspace with no checkpoints exits 3 — "there is no undo here" is not success', async (t) => {
  t.after(cleanup);
  const root = ws();
  const { code, out } = await runCli(['rewind'], root);
  assert.equal(code, 3);
  assert.match(out, /no checkpoints/);
});

test('⚠️⚠️ a rewind that restored NOTHING because it all conflicted exits 3, never 0', async (t) => {
  t.after(cleanup);
  const root = ws();
  seed(root, 'cli-conflict');
  // The user edits the file after the run — the normal case.
  writeFileSync(join(root, 'app.js'), 'AGENT\nmine\n', 'utf8');
  writeFileSync(join(root, 'extra.js'), 'mine too\n', 'utf8');

  const { code, out } = await runCli(['rewind', 'cli-conflict'], root);
  assert.equal(code, 3, '`acuvo rewind <id> && npm test` must not test the tree it was asked to undo');
  assert.match(out, /skipped/);
  assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), 'AGENT\nmine\n');
});

test('⚠️ an unknown id is refused with usage (64), and touches nothing', async (t) => {
  t.after(cleanup);
  const root = ws();
  seed(root, 'cli-unknown');
  const { code, err } = await runCli(['rewind', 'not-a-checkpoint'], root);
  assert.equal(code, 64);
  assert.match(err, /no checkpoint named/);
  assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), 'AGENT\n');
});

// ─────────────────────────────────────────────────────────────────────────────
// ⭐⭐ THE WHOLE LOOP, THROUGH THE BINARY: a run writes → the line tells you →
//     the id it printed puts it back. Against a stub model, so it costs $0.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ `spawnSync` CANNOT BE USED WITH AN IN-PROCESS STUB — it blocks this
 * event loop, so the server can never accept the child's connection and both
 * sides wait for each other. `test/cli-success-path.test.mjs` records the
 * debugging cycle that cost.
 */
async function stubModel(turns) {
  let i = 0;
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `stub-${i}`,
        model: 'stub/model',
        choices: [{ message: turn, finish_reason: turn.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00001 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, close: () => new Promise((r) => server.close(r)) };
}

function runCliWithModel(args, env) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [CLI, ...args], {
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', OPENROUTER_API_KEY: 'sk-or-v1-stub', ...env },
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => { stdout += d; });
    cp.stderr.on('data', (d) => { stderr += d; });
    cp.stdin.end('');
    const timer = setTimeout(() => { cp.kill(); reject(new Error(`the CLI did not exit within 30s\n${stdout}\n${stderr}`)); }, 30_000);
    cp.on('error', (e) => { clearTimeout(timer); reject(e); });
    cp.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test('⭐⭐ a real run PRINTS the checkpoint id, and that id puts the file back', async (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'hello.txt'), 'BEFORE\n', 'utf8');
  const stub = await stubModel([
    {
      role: 'assistant',
      content: 'Writing.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'AFTER\n' }) } }],
    },
    { role: 'assistant', content: 'Done.' },
  ]);
  try {
    const r = await runCliWithModel(['--dir', root, '--max-rounds', '3', 'rewrite hello.txt'], { ACUVO_API_URL: stub.url });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(root, 'hello.txt'), 'utf8'), 'AFTER\n');

    /**
     * ⚠️⚠️ THE LINE IS THE FEATURE. A journal written silently is the "built but
     * unreachable" defect wearing a disk: the person who needs an undo is the
     * person who does not yet know it exists, and this scrollback is where they
     * will be looking. A mutation that comments out `announceCheckpoint()` left
     * every other test in this package green.
     */
    const printed = /checkpoint (\S+) — 1 file can be put back: acuvo rewind (\S+)/.exec(r.stdout);
    assert.ok(printed, `the run never told the user an undo exists:\n${r.stdout}`);
    assert.equal(printed[1], printed[2], 'the id it names and the id it tells you to type must be the same one');

    // And the id it printed is the id that works.
    const undo = await runCli(['--dir', root, 'rewind', printed[1]], tmpdir());
    assert.equal(undo.code, 0, undo.out);
    assert.equal(readFileSync(join(root, 'hello.txt'), 'utf8'), 'BEFORE\n');
  } finally {
    await stub.close();
  }
});

test('⚠️ --dry-run announces no checkpoint, because it recorded none', async (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'hello.txt'), 'BEFORE\n', 'utf8');
  const stub = await stubModel([
    {
      role: 'assistant',
      content: 'Writing.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'AFTER\n' }) } }],
    },
    { role: 'assistant', content: 'Done.' },
  ]);
  try {
    const r = await runCliWithModel(['--dir', root, '--dry-run', '--max-rounds', '2', 'rewrite hello.txt'], { ACUVO_API_URL: stub.url });
    assert.equal(/can be put back/.test(r.stdout), false, 'a dry run must not promise an undo it did not record');
    assert.equal(existsSync(join(root, '.acuvo', 'checkpoints')), false, '--help promises a dry run touches nothing');
    assert.equal(readFileSync(join(root, 'hello.txt'), 'utf8'), 'BEFORE\n');
  } finally {
    await stub.close();
  }
});

test('⚠️ `rewind --json` emits one object on stdout and nothing else', async (t) => {
  t.after(cleanup);
  const root = ws();
  seed(root, 'cli-json');
  const { out } = await runCli(['rewind', '--json'], root);
  const doc = JSON.parse(out);
  assert.equal(doc.checkpoints[0].runId, 'cli-json');
  assert.equal(doc.checkpoints[0].files, 2);
});
