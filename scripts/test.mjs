/**
 * ── ⚠️⚠️ ZERO TESTS EXITED 0, AND THAT IS THE WORST POSSIBLE GREEN ──────────
 *
 * `SHAKEDOWN.md` §1.2, measured on an INSTALLED copy of this package:
 *
 *     npm test
 *     # tests 0 / pass 0 / fail 0 — exit 0
 *
 * The old script was `node --test --test-timeout=180000 test/*.test.mjs`, and
 * the glob is expanded by the SHELL. On a machine whose shell does not expand it
 * (cmd.exe), or in an install where the pattern matches nothing, node is handed
 * a literal `test/*.test.mjs`, finds no such file, runs **nothing**, and reports
 * success. ⭐ Someone auditing this package — which `ENTERPRISE.md` explicitly
 * invites, and which is the entire reason `test/` is in the published files
 * allowlist — would run `npm test`, see green, and conclude the suite passed.
 *
 * ⭐ THIS IS THE SAME DEFECT CLASS AS "watch the total, not the failures": a
 * test file that fails to COMPILE also contributes zero tests, and the run still
 * says passed. Counting failures can never catch either one. **Only the total
 * can**, so the total is what this asserts.
 *
 * ⚠️ AND IT DOES NOT GLOB. Node's own directory discovery is used, so the
 * behaviour no longer depends on which shell invoked npm.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(root, 'test');

/**
 * ⚠️ A MISSING `test/` IS A FAILURE, NOT A SKIP. An install that dropped the
 * directory is exactly the case this script exists to catch, and "there was
 * nothing to run" must never be reported as "everything passed".
 */
if (!existsSync(testDir)) {
  console.error(`✖ ${testDir} does not exist — this copy of acuvo-code ships no tests, so nothing was verified.`);
  process.exit(1);
}

/**
 * ⚠️ A FLOOR, NOT AN EXACT COUNT. Pinning the precise number would fail every
 * commit that adds a test — a check that fails correct work, which this repo has
 * paid for repeatedly. The floor only ever catches the collapse this exists for:
 * hundreds of tests becoming a handful because a glob broke or a file stopped
 * compiling. Raise it deliberately, never automatically.
 */
const MINIMUM_TESTS = 500;

/**
 * ⚠️⚠️ THE FILES ARE ENUMERATED HERE, NOT GLOBBED AND NOT DISCOVERED.
 *
 * · A shell glob (`test/*.test.mjs`) is what broke: cmd.exe does not expand it,
 *   so node received the literal string, matched nothing, and exited 0.
 * · Passing the DIRECTORY does not work either — measured on Node 22.17:
 *   `node --test test/` resolves `test/` as a MODULE and dies with
 *   `Cannot find module …\test`, which the runner then reports as one failing
 *   test. Directory discovery is not what that argument means.
 *
 * ⭐ `readdirSync` depends on neither the shell nor a node version's glob
 * support, and the list it produces can be counted before anything runs.
 */
const files = readdirSync(testDir)
  .filter((n) => n.endsWith('.test.mjs'))
  .map((n) => `test/${n}`)
  .sort();

if (files.length === 0) {
  console.error(`✖ ${testDir} contains no *.test.mjs files — nothing was verified.`);
  process.exit(1);
}

/**
 * ── ⚠️⚠️ A CONCURRENCY CEILING, BECAUSE THIS RUNS ON SOMEBODY'S LAPTOP ──────
 *
 * `node --test` defaults to one worker PER CORE. With 189 test files that is
 * eight processes on this machine — fine alone, and not fine at all in the
 * configuration this repo actually runs in: **two terminals plus three
 * background agents**, each firing the same suite. 8 cores, up to 24 workers.
 *
 * Measured consequence, 2026-08-16, from the person paying for the laptop:
 * *"we are absolutely fucking the shit out of my laptop so hard I can't even
 * open my Google tabs."* ⭐ THE INSTRUCTION WAS EXPLICITLY NOT "DO LESS WORK" —
 * it was that the machine has to stay usable while the work happens. So this
 * is a ceiling, not a reduction: the same tests run, they just cannot take
 * every core at once.
 *
 * ⚠️ HALF THE CORES, MINUS ONE, FLOOR OF 2. Half leaves room for a second
 * agent; the minus-one leaves a core for the interactive session, which is the
 * thing a human actually notices. A floor of 2 stops a small machine
 * serialising a 189-file suite into something nobody will wait for.
 *
 * ⭐ Override with `ACUVO_TEST_CONCURRENCY` when the machine is idle and you
 * want the suite back at full speed — the ceiling exists for the shared case,
 * not because more is wrong.
 */
const cores = Math.max(1, cpus().length);
const concurrency = (() => {
  const asked = Number(process.env.ACUVO_TEST_CONCURRENCY);
  if (Number.isInteger(asked) && asked > 0) return asked;
  return Math.max(2, Math.floor(cores / 2) - 1);
})();

// ⚠️ TAP, not spec: the machine-readable `# tests N` line is the thing being
// asserted below, and the spec reporter writes a decorated `ℹ tests N` instead.
const args = ['--test', `--test-concurrency=${concurrency}`, '--test-timeout=180000', '--test-reporter=tap', ...files];
const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
process.stdout.write(out);

/**
 * ⚠️ READ FROM THE REPORTER'S OWN TOTAL, never recomputed by counting lines.
 * `# tests N` is what node itself concluded; a line count is our opinion about
 * its output, and the two drift the moment the reporter changes.
 */
const total = Number(/^# tests (\d+)$/m.exec(out)?.[1] ?? NaN);
const failed = Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? NaN);

if (!Number.isFinite(total)) {
  console.error('\n✖ could not read a test total out of the runner output — treating that as a failure, '
    + 'because an unreadable result is not a passing one.');
  process.exit(1);
}

if (total < MINIMUM_TESTS) {
  console.error(`\n✖ only ${total} tests ran, and this package expects at least ${MINIMUM_TESTS}.`);
  console.error('  Nothing here failed — that is the point. A suite that collects no tests reports success,');
  console.error('  so the TOTAL is the check. Usually this means the test directory did not ship, or a test');
  console.error('  file failed to compile and silently contributed zero tests.');
  process.exit(1);
}

if (Number.isFinite(failed) && failed > 0) process.exit(1);
process.exit(run.status === null ? 1 : run.status);
