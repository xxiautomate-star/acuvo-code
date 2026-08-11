/**
 * ── ⚠️ A FLAKY SUITE TRAINS EVERYONE TO IGNORE RED ──────────────────────────
 *
 * MEASURED, not assumed. `test/command-tree-kill-timeout.regression.test.mjs`
 * was run 22 times in isolation on this Windows machine and failed ONCE:
 *
 *   not ok 2 - a direct child with no descendants still settles from close…
 *     error: "EBUSY: resource busy or locked, rmdir
 *             'C:\\Users\\angus\\AppData\\Local\\Temp\\acuvo-treekill-solo-YjzEaX'"
 *
 * ⭐ THE ASSERTIONS PASSED. Only the `rmSync` in the `finally` failed, because
 * Windows keeps a handle on a directory for a short window after the process
 * that lived in it is killed — and a killed process tree is exactly what those
 * two tests create. So the product was correct and the suite said it was broken.
 *
 * ⚠️ THE RETRY GOES AROUND THE CLEANUP AND NOWHERE ELSE. Wrapping an assertion
 * in a retry would convert a real intermittent product bug into a green test,
 * which is strictly worse than the flake. Nothing here retries an assertion.
 *
 * ⚠️ AND IT MUST NOT FAIL CORRECT WORK. A teardown helper that chokes on a
 * deep tree, a non-ASCII filename, a CRLF file, a BOM, an empty file or a file
 * with no trailing newline would break every test that uses it — so those
 * shapes are pinned below, on the real filesystem, not only the defect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { rmDirWithRetry, RETRYABLE_RM_CODES } from './_teardown.mjs';

const WINDOWS = process.platform === 'win32';

function scratch(tag = 'acuvo-teardown-') {
  return mkdtempSync(join(tmpdir(), tag));
}

/* ────────────────────────────────────────────────────────────────────────────
 * The retry loop itself — injected, so it is deterministic on every platform
 * and so a mutation to the loop cannot hide behind an OS that never locks.
 * ──────────────────────────────────────────────────────────────────────────── */

function busy(code = 'EBUSY') {
  const err = new Error(`${code}: resource busy or locked, rmdir 'x'`);
  err.code = code;
  return err;
}

test('it retries a retryable failure until the removal succeeds', async () => {
  let calls = 0;
  const rmImpl = () => { calls += 1; if (calls < 3) throw busy(); };
  const r = await rmDirWithRetry('/does-not-matter', { rmImpl, delayMs: 1 });
  assert.equal(calls, 3, 'the second and third attempts were never made — there is no retry');
  assert.equal(r.removed, true);
  assert.equal(r.attempts, 3);
});

test('every Windows lock code the flake can present as is retried', async () => {
  for (const code of RETRYABLE_RM_CODES) {
    let calls = 0;
    const rmImpl = () => { calls += 1; if (calls < 2) throw busy(code); };
    const r = await rmDirWithRetry('/x', { rmImpl, delayMs: 1 });
    assert.equal(r.removed, true, `${code} was not retried`);
    assert.equal(calls, 2, `${code} was not retried`);
  }
});

test('a first-attempt success does not sleep or retry at all', async () => {
  let calls = 0;
  const r = await rmDirWithRetry('/x', { rmImpl: () => { calls += 1; }, delayMs: 10_000 });
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
  assert.equal(r.removed, true);
});

test('⚠️ a NON-retryable error is surfaced, never swallowed — a real bug must stay visible', async () => {
  const boom = new Error('EINVAL: invalid argument');
  boom.code = 'EINVAL';
  await assert.rejects(
    () => rmDirWithRetry('/x', { rmImpl: () => { throw boom; }, delayMs: 1 }),
    /EINVAL/,
  );
});

test('⚠️ it gives up honestly after the budget: no throw, removed:false, and it says so out loud', async () => {
  let calls = 0;
  const warnings = [];
  const r = await rmDirWithRetry('/stuck', {
    rmImpl: () => { calls += 1; throw busy(); },
    attempts: 4,
    delayMs: 1,
    onGiveUp: (msg) => warnings.push(msg),
  });
  assert.equal(calls, 4, 'the budget must be bounded and honoured exactly');
  assert.equal(r.removed, false, 'giving up must be reported, not disguised as success');
  assert.equal(r.attempts, 4);
  assert.equal(r.error.code, 'EBUSY');
  assert.equal(warnings.length, 1, 'a silent give-up is how litter becomes invisible');
  assert.match(warnings[0], /stuck/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The real filesystem — the legitimate shapes a real repo contains.
 * A helper that fails correct work is worse than the flake it replaces.
 * ──────────────────────────────────────────────────────────────────────────── */

test('legitimate content shapes are removed on the first attempt, not retried', async () => {
  const root = scratch();
  const shapes = {
    'lf.txt': 'a\nb\nc\n',
    'crlf.txt': 'a\r\nb\r\nc\r\n',
    'bom.txt': '\uFEFFconst x = 1;\n',
    'bom-crlf.txt': '\uFEFFa\r\nb\r\n',
    'no-trailing-newline.txt': 'last line has no newline',
    'tabs.txt': '\tone\n\t\ttwo\n\t\t\tthree\n',
    'deep-indent.txt': `${' '.repeat(64)}deeply indented\n`,
    'non-ascii-café-ünïcode-日本語.txt': 'héllo — ünïcode ✓ 日本語\n',
    'empty.txt': '',
    'crlf-no-trailing.txt': 'a\r\nb',
  };
  for (const [name, body] of Object.entries(shapes)) writeFileSync(join(root, name), body);
  // deep nesting, plus a non-ASCII directory name
  let deep = join(root, 'ünïcode-dir');
  mkdirSync(deep);
  for (let i = 0; i < 10; i += 1) {
    deep = join(deep, `level${i}`);
    mkdirSync(deep);
    writeFileSync(join(deep, 'file.txt'), i % 2 ? 'a\r\n' : 'a\n');
  }
  mkdirSync(join(root, 'empty-dir'));

  const r = await rmDirWithRetry(root, { delayMs: 1 });
  assert.equal(r.removed, true);
  assert.equal(r.attempts, 1, 'a perfectly ordinary tree must not need a single retry');
  assert.equal(existsSync(root), false);
});

test('a directory that is already gone is a no-op, not an error', async () => {
  const root = scratch();
  rmSync(root, { recursive: true, force: true });
  const r = await rmDirWithRetry(root, { delayMs: 1 });
  assert.equal(r.removed, true);
  assert.equal(r.attempts, 1);
});

test('an empty directory removes cleanly', async () => {
  const root = scratch();
  const r = await rmDirWithRetry(root, { delayMs: 1 });
  assert.equal(r.removed, true);
  assert.equal(existsSync(root), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The actual Windows condition, held open on purpose.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ AN OPEN `fs` HANDLE IS NOT THE MECHANISM — I tried that first and Windows
 * happily removed the tree, because Node opens files with FILE_SHARE_DELETE.
 * The thing that actually locks a directory is a LIVE PROCESS WHOSE CWD IT IS,
 * which is precisely what the tree-kill tests create. Probed directly:
 *
 *   LOCK EBUSY EBUSY: resource busy or locked, rmdir 'C:\…\Temp\lockprobe-…'
 *
 * — byte-for-byte the error class the flake reports.
 */
/**
 * ── ⚠️ AND MY FIRST VERSION OF THESE TWO WAS ITSELF FLAKY — 2 FAILURES IN 25 ─
 *
 * It spawned the lock holder and slept a fixed 300ms before attempting the
 * removal. Under suite load Node's own startup sometimes exceeded that, so the
 * directory was not locked yet and `attempts > 1` failed. Writing a flaky test
 * to fix a flaky test is not a fix, so the timing is now a HANDSHAKE:
 *
 *   · the holder prints `up` only once it is actually running in the cwd, and
 *     the parent waits for that line — no sleep is guessed;
 *   · the holder then stays alive until the parent creates a sentinel OUTSIDE
 *     the directory, so the parent decides exactly when the lock clears;
 *   · a hard cap makes the holder exit on its own no matter what, because a
 *     test that can leave a process behind is a worse bug than the flake.
 */
function lockHolder(root, sentinel) {
  writeFileSync(join(root, 'holder.mjs'), [
    "import { existsSync } from 'node:fs';",
    `const sentinel = ${JSON.stringify(sentinel)};`,
    'const t = setInterval(() => { if (existsSync(sentinel)) { clearInterval(t); process.exit(0); } }, 25);',
    // a hard cap so this can never outlive the test, whatever goes wrong
    'setTimeout(() => process.exit(0), 20_000).unref();',
    "console.log('up');",
  ].join('\n'));
  return spawn(process.execPath, [join(root, 'holder.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
}

const exited = (kid) => new Promise((r) => kid.on('exit', r));

/** Resolves only when the holder has really started, so nothing is guessed. */
function whenUp(kid) {
  return new Promise((resolve, reject) => {
    let seen = '';
    kid.stdout.on('data', (b) => { seen += b; if (seen.includes('up')) resolve(); });
    kid.on('exit', () => reject(new Error('the lock holder exited before it ever locked anything')));
  });
}

test('⭐ the condition is real: a live process in the directory defeats a plain rmSync', { skip: WINDOWS ? false : 'Windows-only cwd lock semantics' }, async () => {
  const root = scratch();
  const sentinel = join(tmpdir(), `acuvo-teardown-release-${process.pid}-${Date.now()}-a`);
  const kid = lockHolder(root, sentinel);
  try {
    await whenUp(kid);
    let code = null;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err) {
      code = err.code;
    }
    assert.ok(code, 'rmSync did not fail on a locked directory — this test no longer reproduces the flake');
    assert.ok(RETRYABLE_RM_CODES.includes(code), `unexpected lock code ${code}`);
  } finally {
    writeFileSync(sentinel, '');
    await exited(kid);
    rmSync(sentinel, { force: true });
    await rmDirWithRetry(root, { delayMs: 50 });
  }
});

test('⭐ rmDirWithRetry outlasts a lock that clears a moment later', { skip: WINDOWS ? false : 'Windows-only cwd lock semantics' }, async () => {
  const root = scratch();
  const sentinel = join(tmpdir(), `acuvo-teardown-release-${process.pid}-${Date.now()}-b`);
  const kid = lockHolder(root, sentinel);
  let gone = false;
  /**
   * ⚠️ HOLD THE PROMISE, DO NOT FLOAT IT. This was
   * `exited(kid).then(() => { gone = true; });` — a dangling promise nobody
   * awaited, while the `finally` awaited a SECOND, separate `exited(kid)`. The
   * test could therefore finish with the first one still pending, and node
   * failed it with `cancelledByParent` / "Promise resolution is still pending
   * but the event loop has already resolved".
   *
   * ⭐ The product was never involved: `rmDirWithRetry` behaved correctly every
   * run. This was a red accusing correct code, which is the failure mode this
   * repo has now paid for seven times — and this one arrived from a lane that
   * died mid-stream, so nobody was watching it land.
   */
  const kidExited = exited(kid).then(() => { gone = true; });
  try {
    await whenUp(kid);
    // The parent, not a sleep, decides when the lock clears — so at the moment
    // rmDirWithRetry makes its first attempt the directory is certainly locked.
    const release = setTimeout(() => writeFileSync(sentinel, ''), 400);

    const r = await rmDirWithRetry(root, { delayMs: 50, attempts: 200 });
    clearTimeout(release);

    /**
     * ⚠️⚠️ THE `gone` ASSERTION WAS REMOVED — IT WAS FLAKY BY CONSTRUCTION.
     *
     * It read `assert.equal(gone, true, …)`, where `gone` is set by the child's
     * `exit` EVENT. But the directory becomes removable the instant the OS drops
     * the child's cwd handle, and Node delivers the exit callback to the parent
     * some microseconds later. So `rmDirWithRetry` can legitimately win the race
     * and return while `gone` is still false.
     *
     * Measured: 2 passes then a fail, over three consecutive runs, on unchanged
     * code. ⭐ It was asserting NODE'S EVENT SCHEDULING, not our behaviour — and
     * a test that fails one run in three trains everyone to ignore red, which
     * costs more than the assertion was ever worth.
     *
     * ⭐ WHAT ACTUALLY PROVES THE POINT IS `attempts > 1`. If the lock had not
     * been in force, the very first attempt would have succeeded. Retrying at
     * all IS the evidence that something blocked it, and that assertion is
     * deterministic. The `finally` below still awaits the child, so nothing is
     * left running either way.
     */
    assert.equal(r.removed, true, `still locked after ${r.attempts} attempts: ${r.error && r.error.code}`);
    assert.ok(r.attempts > 1, `it removed on attempt ${r.attempts}, so the lock was not in force`);
    assert.equal(existsSync(root), false);
  } finally {
    writeFileSync(sentinel, '');
    // ⭐ Await the SAME promise the `gone` flag hangs off, so nothing is left
    // pending when the test returns.
    await kidExited;
    rmSync(sentinel, { force: true });
    await rmDirWithRetry(root, { delayMs: 50 });
  }
});
