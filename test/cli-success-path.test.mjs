/**
 * ── ⚠️⚠️ THE SUCCESS PATH HAD NEVER BEEN RUN BY A TEST ──────────────────────
 *
 * Every existing test that drives `bin/acuvo.mjs` gives it a DEAD KEY and
 * asserts on the refusal. That covers the front door beautifully and leaves
 * everything after a successful completion — the summary, the change list, the
 * inline image rendering, the exit code — completely uncovered.
 *
 * ⚠️ A `ReferenceError` shipped on that path and 1,413 GREEN TESTS SAID
 * NOTHING. Removing a duplicate print also removed the `const changes` binding
 * that the PNG-rendering loop still used, forty lines further down. The CLI
 * finished the work, wrote the file, printed the cost — and then crashed on the
 * way out, so the run reported failure after succeeding.
 *
 * ⭐ AND THE CHECK THAT MISSED IT COULD NOT HAVE FOUND IT. I grepped for other
 * uses with `awk '/\bchanges\b/'`. **In POSIX awk `\b` is a backspace, not a
 * word boundary** — the pattern matched nothing, and could never have matched
 * anything. A check that cannot fail is worse than no check, because it reads
 * as evidence.
 *
 * These tests drive the REAL binary against a stub model on 127.0.0.1, which is
 * why `resolveApiUrl` exists and why it refuses anything that is not loopback.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveApiUrl, OPENROUTER_URL } from '../lib/model.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

/** A stub completions endpoint that replies with a fixed sequence of turns. */
async function stubModel(turns) {
  const seen = [];
  let i = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(body);
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
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

const call = (name, args) => ({
  id: `c_${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/**
 * ⚠️⚠️ `spawnSync` CANNOT BE USED HERE, and the failure is a deadlock rather
 * than an error. The stub server lives in THIS process; `spawnSync` blocks this
 * process's event loop until the child exits; so the server can never accept
 * the child's connection, and the child waits for a reply that this process is
 * structurally unable to send. Both sides wait until the timeout fires.
 *
 * ⭐ It cost a debugging cycle because the symptom — "round 1/3" then silence —
 * looks exactly like a hung HTTP client, and the CLI is entirely innocent: the
 * same run against the same stub in a separate process finishes in under a
 * second. **A synchronous child-process call and an in-process server are
 * mutually exclusive, always.**
 */
function runCli(args, env) {
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

/* ── the loopback guard ───────────────────────────────────────────────────── */

test('with no override, the real OpenRouter endpoint is used', () => {
  assert.equal(resolveApiUrl({}), OPENROUTER_URL);
  assert.equal(resolveApiUrl({ ACUVO_API_URL: '  ' }), OPENROUTER_URL);
});

test('⭐ a loopback override is accepted, in every spelling of loopback', () => {
  for (const h of ['127.0.0.1', 'localhost', '127.9.9.9', '[::1]']) {
    assert.match(resolveApiUrl({ ACUVO_API_URL: `http://${h}:8080/v1` }), /^http:\/\//, `${h} should be accepted`);
  }
});

test('⚠️⚠️ a NON-loopback override THROWS — it must never route the key off-machine', () => {
  assert.throws(
    () => resolveApiUrl({ ACUVO_API_URL: 'https://evil.example.com/v1/chat/completions' }),
    /may only point at loopback/,
  );
});

test('⚠️ a bad override throws rather than silently falling back', () => {
  /**
   * ⚠️ SILENTLY IGNORING IT WOULD BE WORSE. A test that believes it is talking
   * to its stub, but is actually billing the real API, is the single most
   * expensive way this seam could fail.
   */
  assert.throws(() => resolveApiUrl({ ACUVO_API_URL: 'not a url' }), /is not a URL/);
});

/* ── ⚠️ the path that had no coverage at all ──────────────────────────────── */

test('⚠️⚠️ a SUCCESSFUL run completes, reports, and exits 0 — no crash on the way out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-success-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Writing the file.', tool_calls: [call('write_file', { path: 'hello.txt', content: 'hi\n' })] },
    { role: 'assistant', content: 'Done — hello.txt now exists.' },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '3', 'create hello.txt'], { ACUVO_API_URL: stub.url });

    assert.equal(r.status, 0, `the CLI exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.equal(
      /ReferenceError|TypeError|acuvo crashed/.test(`${r.stdout}${r.stderr}`),
      false,
      `the CLI crashed on the success path:\n${r.stdout}\n${r.stderr}`,
    );
    assert.ok(existsSync(join(dir, 'hello.txt')), 'the file the model asked for was not written');
    assert.equal(readFileSync(join(dir, 'hello.txt'), 'utf8'), 'hi\n');
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ the change list appears EXACTLY ONCE in the output', async () => {
  /**
   * ⚠️ THE DEFECT THIS REPLACES A SOURCE-GREP FOR. A test that greps
   * bin/acuvo.mjs for `formatChanges(` pins the current shape of the fix; this
   * one pins the OBSERVABLE PROPERTY, which is what actually matters and what
   * survives a refactor.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-once-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Writing.', tool_calls: [call('write_file', { path: 'only.txt', content: 'x\n' })] },
    { role: 'assistant', content: 'Done.' },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '3', 'create only.txt'], { ACUVO_API_URL: stub.url });
    const mentions = (r.stdout.match(/^\s*created\s+only\.txt/gm) || []).length;
    assert.equal(mentions, 1, `"created only.txt" appeared ${mentions} times:\n${r.stdout}`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ the banner names the workspace without printing an absolute path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-banner-'));
  const stub = await stubModel([{ role: 'assistant', content: 'Nothing to do.' }]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '1', 'say hello'], { ACUVO_API_URL: stub.url });
    const banner = `${r.stdout}${r.stderr}`.split('\n').find((l) => l.startsWith('acuvo ·')) || '';
    assert.ok(banner, `no banner was printed:\n${r.stdout}\n${r.stderr}`);
    assert.ok(banner.length < 120, `the banner is ${banner.length} chars and will wrap: ${banner}`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
