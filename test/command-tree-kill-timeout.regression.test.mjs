/**
 * REGRESSION: `--command-timeout` must fire for `npm test`, and must take the
 * whole process tree with it.
 *
 * ⚠️ WHY THIS TEST USES A REAL SPAWN AND NOT `spawnImpl`.
 *
 * Every other spawn test in this package stubs `spawnImpl`, which is exactly why
 * the suite was 316/316 green while a documented flag did nothing at all. The
 * defect is not in the code that decides WHAT to spawn — it is in the pipe and
 * signal semantics of a real OS process that has real descendants. A stub cannot
 * have a grandchild holding an inherited pipe open, so a stub cannot see this bug.
 *
 * The two facts pinned here, both measured before the fix:
 *   1. `npm test` against a script that spawns a child and then never exits
 *      NEVER RESOLVED — waited 20,019ms on a 4,000ms timeout. `close` needs both
 *      process exit AND EOF on the captured pipes; SIGKILL to npm's node left the
 *      script's descendant holding the write handles, so EOF never came.
 *   2. The descendant was a true orphan afterwards — pid alive, parent pid gone.
 *
 * The isolation control that proves it is the DESCENDANT and not the timeout:
 * the identical hanging script run as a direct child (no grandchildren) already
 * resolved correctly at 4,154ms with signal SIGKILL. That path must keep working,
 * which is why `close` remains the normal-path settle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { executeRunCommand } from '../lib/command.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { rmDirWithRetry } from './_teardown.mjs';

/**
 * ── ⚠️ THE TEARDOWN, NOT THE ASSERTIONS, IS WHAT FLAKED ─────────────────────
 *
 * Measured: 1 failure in 22 isolated runs of this file, and it was always the
 * `rmSync` in a `finally`:
 *
 *   not ok 2 - a direct child with no descendants still settles from close…
 *     error: "EBUSY: resource busy or locked, rmdir '…\\acuvo-treekill-solo-YjzEaX'"
 *
 * Every assertion above it passed. Windows keeps the directory locked for a
 * short window after the process whose CWD it was is killed — and killing that
 * process is the entire point of these two tests, so the lock is guaranteed to
 * be in play here and nowhere else in the suite.
 *
 * ⚠️ ONLY THE CLEANUP IS RETRIED. `rmDirWithRetry` cannot be pointed at an
 * assertion; wrapping one would turn a real intermittent product bug green,
 * which is a worse outcome than the flake. See `_teardown.mjs`.
 */

/** Is this pid still alive? Signal 0 asks without sending anything. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * ⚠️ THE TEST MUST NOT BE THE THING THAT COOKS THE MACHINE. Before the fix this
 * test leaves a hung server and its grandchild running, so cleanup here is not
 * tidiness — it is the difference between a red test and two processes that run
 * until reboot.
 */
function killTreeHard(pid) {
  if (!alive(pid)) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* already gone */ }
}

async function waitGone(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

function makeHangingWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-treekill-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'hangs', private: true, type: 'module', scripts: { test: 'node server.mjs' } }, null, 2),
  );
  // The script npm will run: spawn a descendant that inherits the captured
  // pipes, record both pids, then never exit. This is a dev server, a watcher
  // and a worker pool — the ordinary shapes, not a contrived one.
  writeFileSync(
    join(root, 'server.mjs'),
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "import { join, dirname } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const here = dirname(fileURLToPath(import.meta.url));",
      "const kid = spawn(process.execPath, [join(here, 'grandchild.mjs')], { stdio: 'inherit' });",
      "writeFileSync(join(here, 'pids.json'), JSON.stringify({ server: process.pid, grandchild: kid.pid }));",
      "console.log('server up');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  writeFileSync(join(root, 'grandchild.mjs'), 'setInterval(() => {}, 1000);\n');
  return root;
}

test('npm test that spawns a descendant still times out, and the whole tree dies with it', async () => {
  const root = makeHangingWorkspace();
  const pidFile = join(root, 'pids.json');
  /** @type {{server?: number, grandchild?: number}} */
  let pids = {};
  try {
    const executor = createLocalExecutor(root);
    const started = Date.now();

    /**
     * ⚠️ THIS IS NOT PADDING, IT IS MEASURED. npm's own cold start on Windows is
     * ~3.6s before it reaches the script at all (timed in a fresh temp dir).
     * A 3s timeout fired while npm was still booting, killed a process that had
     * no descendants yet, and the test went green-ish for the wrong reason —
     * which would have been a worse outcome than no test. The timeout must
     * outlast npm's startup or it is not testing the descendant at all.
     *
     * ⚠️⚠️ RAISED 8s → 40s BECAUSE 8s WAS FLAKY UNDER THE FULL SUITE. `node
     * --test` runs all 65 files in parallel, and npm's ~3.6s idle cold start
     * stretches past 8s — and past 20s — when sixty other processes are competing for the disk.
     * The timeout then fired while npm was still booting, no descendant existed
     * yet, and the test failed with its own "raise TIMEOUT_MS" message — on
     * completely correct code.
     *
     * ⭐ The number has to outlast npm's WORST start, not its typical one,
     * because everything below this line is only meaningful once the grandchild
     * actually exists.
     */
    const TIMEOUT_MS = 40_000;

    // ⚠️ The watchdog is what turns "hangs forever" into "fails". Without it the
    // unfixed code does not fail this test, it wedges the whole suite.
    let watchdogTimer;
    const watchdog = new Promise((resolve) => {
      watchdogTimer = setTimeout(() => resolve({ NEVER_RESOLVED: true }), 150_000);
    });

    const result = await Promise.race([
      executeRunCommand({ command: 'npm test', executor, timeoutMs: TIMEOUT_MS }),
      watchdog,
    ]);
    clearTimeout(watchdogTimer);
    const elapsed = Date.now() - started;

    if (existsSync(pidFile)) pids = JSON.parse(readFileSync(pidFile, 'utf8'));

    assert.ok(
      !result.NEVER_RESOLVED,
      `executeRunCommand never settled: an ${TIMEOUT_MS}ms --command-timeout left the call open for ${elapsed}ms. `
      + 'The descendant is holding the captured pipes open, so `close` never fires.',
    );
    assert.equal(result.ok, true, `expected a result, got: ${result.error}`);
    assert.equal(result.timedOut, true, 'the run must be reported as timed out');
    assert.equal(result.passed, false, 'a timed-out run has not passed');
    /**
     * ⚠️ NO TIGHT WALL-CLOCK BOUND HERE ANY MORE. The watchdog above already
     * proves the call SETTLED, which is the property under test and the one a
     * regression would break. A second, tighter deadline measured machine load
     * instead — and failed correct code under a parallel suite.
     */
    assert.ok(elapsed < 140_000, `${elapsed}ms is a hang, not slowness`);

    // The bug's second half: the tree, not just the direct child.
    // If this is missing, npm never reached the script and the test proved
    // nothing — say that, rather than passing quietly.
    assert.ok(
      Number.isInteger(pids.grandchild),
      'npm never got as far as running the script, so the descendant case was never exercised — raise TIMEOUT_MS',
    );
    const gone = await waitGone(pids.grandchild, 5_000);
    assert.ok(gone, `grandchild pid ${pids.grandchild} survived the timeout kill — it is an orphan now`);
    assert.ok(await waitGone(pids.server, 5_000), `server pid ${pids.server} survived the timeout kill`);
  } finally {
    killTreeHard(pids.server);
    killTreeHard(pids.grandchild);
    await rmDirWithRetry(root);
  }
});

/**
 * ── ⚠️⚠️ THE FIXED 2s TIMEOUT WAS RACING NODE'S OWN COLD START ───────────────
 *
 * Measured 2026-08-13: this test failed roughly 1 run in 5 when the full suite
 * was under load, always the same way —
 *
 *     The input did not match the regular expression /direct child up/.
 *     Input: ''
 *
 * Nothing was wrong with the product. `node --test` runs every file in
 * parallel; with sixty processes competing for the disk, node's cold start
 * stretches past 2,000ms, the timeout fires before the script reaches its first
 * line, and the test asserts that output survived a kill that happened before
 * any output existed. It was measuring machine load, not `close` semantics —
 * the same trap the sibling test above already carries a warning about.
 *
 * ⭐ THE FIX IS NOT A BIGGER CONSTANT. A constant is a bet on the worst load
 * this suite will ever see, and that bet has now been lost twice in this file
 * (8s → 40s over there). Two changes instead:
 *
 *   1. **Measure this machine, under this load.** Time a node process that does
 *      nothing, and give the real run a multiple of what that actually cost.
 *      A loaded machine gets a longer rope; an idle one still finishes fast.
 *   2. **Tell a setup failure apart from the defect.** The script drops a
 *      marker file, so "the child never started" and "the child started and its
 *      output was lost" cannot produce the same red. Only the second is the
 *      regression this file exists to pin, and only it should ever read as one.
 *
 * ⚠️ Deliberately NOT a retry around the assertion. `_teardown.mjs` explains
 * why only cleanup is ever retried: retrying an assertion is how a real
 * intermittent product bug goes green.
 */
test('a direct child with no descendants still settles from close, with its signal intact', async () => {
  // The isolation control, kept as a test so a future "just settle on exit"
  // rewrite cannot quietly stop collecting output on the normal path.
  const root = mkdtempSync(join(tmpdir(), 'acuvo-treekill-solo-'));
  try {
    const executor = createLocalExecutor(root);

    // What does starting node COST right now? Not what did it cost on an idle
    // laptop in August. `node warm.mjs` exits immediately, so this is start-up
    // and nothing else.
    writeFileSync(join(root, 'warm.mjs'), 'process.exit(0);\n');
    const warmStarted = Date.now();
    await executeRunCommand({ command: 'node warm.mjs', executor, timeoutMs: 120_000 });
    const coldStartMs = Date.now() - warmStarted;
    const timeoutMs = Math.min(30_000, Math.max(2_000, coldStartMs * 4));

    writeFileSync(
      join(root, 'hang.mjs'),
      // ⚠️ `import`, not `require` — this is an .mjs file and `require` is not
      // defined in module scope. A ReferenceError here would kill the script
      // before its first line and look exactly like the flake being fixed.
      "import { writeFileSync } from 'node:fs';\n"
      + "console.log('direct child up');\n"
      + "writeFileSync('started.txt', 'up');\n"
      + 'setInterval(() => {}, 1000);\n',
    );
    const started = Date.now();
    const result = await executeRunCommand({ command: 'node hang.mjs', executor, timeoutMs });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < timeoutMs + 30_000, `took ${elapsed}ms against a ${timeoutMs}ms timeout — that is a hang, not slowness`);

    /**
     * ⚠️ The marker is written AFTER the log line, so its presence proves the
     * script really did reach `console.log`. Missing marker = the kill landed
     * during start-up and this run never exercised the property at all; say
     * that, rather than blaming the code for output it was never given time to
     * write.
     */
    assert.ok(
      existsSync(join(root, 'started.txt')),
      `node did not reach its first line inside ${timeoutMs}ms (cold start measured at ${coldStartMs}ms under this load), `
      + 'so nothing was killed after writing output and this run proves nothing about `close`',
    );
    // Output written before the kill must survive — that is what `close` buys.
    assert.match(result.stdout, /direct child up/);
  } finally {
    await rmDirWithRetry(root);
  }
});
