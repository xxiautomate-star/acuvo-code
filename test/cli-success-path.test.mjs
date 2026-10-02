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

/** Signed out, stated explicitly — see the note further down. */
const SIGNED_OUT = { ACUVO_HOME: join(tmpdir(), `acuvo-signed-out-${process.pid}`) };

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
      /**
       * ── ⚠️⚠️ THE SPAWNED CLI MUST BE SIGNED OUT TOO ────────────────────────
       *
       * `...process.env` carries the developer's real HOME, so a machine where
       * somebody has run `acuvo --login` gives the child a real account — and a
       * signed-in run routes to OUR GATEWAY, deliberately outranking the
       * loopback seam these tests depend on. The child then talks to production
       * instead of the stub, and the assertions fail for a reason that has
       * nothing to do with the code.
       *
       * ⭐ THIS HAPPENED TODAY, AND IT IS WHY THE FIX IS HERE RATHER THAN IN THE
       * ASSERTIONS. Roman logged in at 11:23 and seventeen tests went red at
       * once. The comment above `SIGNED_OUT` had already diagnosed exactly this
       * shape for the in-process calls; the SPAWNED ones were never given the
       * same treatment, so the suite quietly depended on nobody using the
       * product. `...env` still comes last, so a test that wants a signed-in
       * child can say so.
       */
      env: {
        ...process.env,
        NO_COLOR: '1',
        OPENROUTER_API_KEY: 'sk-or-v1-stub',
        ...SIGNED_OUT,
        ...env,
      },
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

/**
 * ── ⚠️ SIGNED OUT MUST BE STATED, NOT ASSUMED ───────────────────────────────
 *
 * `resolveApiUrl` now consults the ACUVO ACCOUNT first, because a signed-in user
 * routes through our gateway rather than straight to the provider. That means a
 * bare `{}` is no longer "no configuration" — it is "whatever this developer
 * happens to have in `~/.acuvo/credentials.json`", and on a machine where
 * somebody has run `acuvo login` these assertions would fail for a reason that
 * has nothing to do with the code.
 *
 * ⭐ This morning that exact shape — a test whose verdict depends on the
 * developer's environment — made the anti-orphan guard permanently red and
 * trained everyone to read past it. Pointing `ACUVO_HOME` at a directory that
 * cannot exist states "signed out" explicitly, so the test means the same thing
 * on every machine.
 */

test('with no override, the real OpenRouter endpoint is used', () => {
  assert.equal(resolveApiUrl(SIGNED_OUT), OPENROUTER_URL);
  assert.equal(resolveApiUrl({ ...SIGNED_OUT, ACUVO_API_URL: '  ' }), OPENROUTER_URL);
});

test('⭐⭐ a signed-in account routes to OUR gateway, and outranks the loopback test seam', () => {
  // The account must win over ACUVO_API_URL: that variable is a loopback-only
  // TEST SEAM, and letting it redirect an authenticated session would be the
  // exact exfiltration primitive its restriction exists to deny.
  const signedIn = { ...SIGNED_OUT, ACUVO_TOKEN: 'acuvo_live_test' };
  assert.match(resolveApiUrl(signedIn), /^https:\/\//);
  assert.equal(
    resolveApiUrl({ ...signedIn, ACUVO_API_URL: 'http://127.0.0.1:8080/v1' }),
    resolveApiUrl(signedIn),
    'the loopback seam must not redirect a signed-in run',
  );
});

test('⚠️ a BYOK key is NEVER routed through our gateway', () => {
  // Their key, their balance, their provider. A user's own credential arriving
  // at our servers would be a betrayal of the plainest kind.
  assert.equal(resolveApiUrl({ ...SIGNED_OUT, OPENROUTER_API_KEY: 'sk-or-v1-theirs' }), OPENROUTER_URL);
});

test('⭐ a loopback override is accepted, in every spelling of loopback', () => {
  for (const h of ['127.0.0.1', 'localhost', '127.9.9.9', '[::1]']) {
    assert.match(resolveApiUrl({ ...SIGNED_OUT, ACUVO_API_URL: `http://${h}:8080/v1` }), /^http:\/\//, `${h} should be accepted`);
  }
});

test('⚠️⚠️ a NON-loopback override THROWS — it must never route the key off-machine', () => {
  assert.throws(
    () => resolveApiUrl({ ...SIGNED_OUT, ACUVO_API_URL: 'https://evil.example.com/v1/chat/completions' }),
    /may only point at loopback/,
  );
});

test('⚠️ a bad override throws rather than silently falling back', () => {
  /**
   * ⚠️ SILENTLY IGNORING IT WOULD BE WORSE. A test that believes it is talking
   * to its stub, but is actually billing the real API, is the single most
   * expensive way this seam could fail.
   */
  assert.throws(() => resolveApiUrl({ ...SIGNED_OUT, ACUVO_API_URL: 'not a url' }), /is not a URL/);
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

test('⭐⭐ --best-of runs N attempts through the REAL binary and keeps one', async () => {
  /**
   * ⚠️ BUILT IS NOT WIRED, four times in this package. best-of.mjs has 15 unit
   * tests and every one of them injects `runOne` — so all fifteen would still
   * pass with the flag unreachable from the command line. This is the only test
   * that proves a user typing `--best-of 2` gets anything at all.
   *
   * ⭐ AND IT ALREADY EARNED ITSELF: both `say()` helpers in bin are declared
   * inside other branches, so the first draft of the wiring referenced one that
   * was not in scope — the identical ReferenceError that shipped this morning.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-bestof-cli-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Writing.', tool_calls: [call('write_file', { path: 'out.txt', content: 'ok\n' })] },
    { role: 'assistant', content: 'Done.' },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--best-of', '2', '--max-rounds', '3', 'create out.txt'], { ACUVO_API_URL: stub.url });

    assert.equal(
      /ReferenceError|TypeError|acuvo crashed/.test(`${r.stdout}${r.stderr}`),
      false,
      `--best-of crashed:\n${r.stdout}\n${r.stderr}`,
    );
    assert.match(r.stdout, /best of 2/, `no best-of report was printed:\n${r.stdout}`);
    assert.match(r.stdout, /total spend across all attempts/);
    assert.ok(existsSync(join(dir, 'out.txt')), 'the winning attempt\'s file was never applied back to the real workspace');
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'ok\n');
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
    const all = `${r.stdout}${r.stderr}`.split('\n');

    /**
     * ⚠️ RE-ANCHORED 2026-08-22, NOT WEAKENED. The banner was one line starting
     * `acuvo ·`; it is now a titled block with a row per fact. The properties
     * under test are unchanged — a banner IS printed, the workspace is named,
     * and no line wraps — so the anchor moved and the assertions did not.
     */
    /**
     * ⚠️ ANCHORED ON THE MARK, NOT ON THE TEXT "ACUVO CODE" — the logo is
     * drawn, so that string does not reliably appear as a title.
     *
     * ⚠️⚠️ AND ON EITHER MARK, RE-ANCHORED 2026-08-22. This asserted on '█'
     * alone, which quietly encoded an assumption the product no longer makes:
     * that the half-block art is ALWAYS what gets drawn. It is now chosen by
     * measuring the terminal (`lib/glyph-width.mjs`), and a test harness has
     * no TTY to measure — so the honest answer here is "unknown", which
     * correctly selects the ASCII mark. The property under test is that a mark
     * is printed at all; WHICH mark is a different test, and it lives in
     * test/glyph-width.test.mjs where it can control the terminal.
     */
    const title = all.find((l) => l.includes('█') || l.includes('/----\\')) || '';
    assert.ok(title, `no banner was printed:\n${r.stdout}\n${r.stderr}`);

    /**
     * ⚠️ RE-ANCHORED 2026-08-22: NO MORE LABELS. The banner now reads like the
     * reference — three prose lines, the last of which is the path itself, with
     * nothing introducing it. So the workspace is found by its VALUE (the temp
     * directory's own leaf name), which is a stronger check anyway: the old one
     * passed as long as the word "workspace" appeared, even beside the wrong
     * path.
     */
    const leaf = dir.split(/[\\/]/).filter(Boolean).pop();
    const workspace = all.find((l) => l.includes(leaf)) || '';
    assert.ok(workspace, `the banner no longer names the workspace:\n${all.join('\n')}`);

    /**
     * ⚠️ EVERY BANNER ROW, NOT JUST THE LONGEST-LOOKING ONE. The billing clause
     * can carry a whole sentence and `can run` carries the shell-mode warning —
     * checking one row would let either wrap unnoticed, and a banner that wraps
     * is exactly what this test was written to stop.
     */
    const bannerRows = all.filter((l) => /Acuvo Code v|OpenRouter key|Acuvo plan|Acuvo account|rounds ·/.test(l) || l.includes(leaf));
    assert.ok(bannerRows.length >= 2, `expected several banner rows, saw ${bannerRows.length}`);
    for (const line of bannerRows) {
      assert.ok(line.length < 120, `a banner row is ${line.length} chars and will wrap: ${line}`);
    }
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐⭐⭐ the banner says WHO IS PAYING, and names BYOK as not-your-plan', async () => {
  /**
   * ── THE INCIDENT THIS GUARDS ────────────────────────────────────────────────
   *
   * Roman opened a terminal, typed `acuvo`, and got a working prompt without
   * ever logging in — a leftover `OPENROUTER_API_KEY` in the project's
   * `.env.local` was picked up automatically and nothing on screen said so.
   *
   * ⚠️ THAT IS A BILLING FAILURE, NOT A COSMETIC ONE. A paying customer with a
   * stray provider key in a directory burns THEIR OWN credits believing their
   * plan covers it, and the first evidence is someone else's invoice. The
   * banner already discloses what the tool may RUN before it runs it; what it
   * will CHARGE is the same obligation.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-billing-'));
  const stub = await stubModel([{ role: 'assistant', content: 'Nothing to do.' }]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '1', 'say hello'], {
      ACUVO_API_URL: stub.url,
      OPENROUTER_API_KEY: 'sk-or-v1-whatever',
      // A home with no saved account, so BYOK is what resolves.
      ACUVO_HOME: dir,
    });
    // ⚠️ `includes`, not `startsWith` — the detail rows sit to the RIGHT of the
    // logo, so nothing on these lines begins with the label any more.
    /**
     * ⚠️ RE-ANCHORED 2026-08-22: THE LABEL IS GONE, THE OBLIGATION IS NOT. The
     * banner was rebuilt against a screenshot of the reference, which has no
     * labels — billing now rides on the model line ("Acuvo Flash 1 · YOUR OWN
     * OpenRouter key…"), the way theirs reads "Opus 5 … · Claude Max". So the
     * search moves from the label to the DISCLOSURE, which is what this test was
     * always about.
     */
    const billing = `${r.stdout}${r.stderr}`.split('\n').find((l) => /OpenRouter key|Acuvo plan|Acuvo account/i.test(l)) || '';
    assert.ok(billing, `the banner does not say who is paying:\n${r.stdout}\n${r.stderr}`);
    assert.match(
      billing, /not your Acuvo plan/i,
      `BYOK must say plainly that the Acuvo plan is NOT what is being charged, got: ${billing}`,
    );
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
