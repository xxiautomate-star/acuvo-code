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
 * invites — would run `npm test`, see green, and conclude the suite passed.
 *
 * ⚠️⚠️ THAT SENTENCE USED TO END *"and which is the entire reason `test/` is in
 * the published files allowlist"*, AND `test/` IS NOT IN IT. Measured 2026-09-10
 * from `npm pack --dry-run`: 259 files — `bin/`, `lib/`, `skills/`, `scripts/`
 * and five documents, no `test/`. `ENTERPRISE.md` records the removal as
 * deliberate and argues the audit claim does not need the suite. So the reason
 * this script exists is unchanged and its stated premise was simply wrong: the
 * collapse it guards against is a broken glob or a file that stopped compiling
 * **in a source checkout**, which is where the suite is meant to be run. What an
 * INSTALLED copy gets is the clean refusal three lines below, not a false green.
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
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
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

/**
 * ── ⚠️⚠️⚠️ THE SUITE WAS WRITING TO THE DEVELOPER'S REAL `~/.acuvo` ─────────
 *
 * MEASURED 2026-08-25 on this laptop. `turn.mjs` ends every session with
 * `saveWarmth(warmth)` — no env, no home — so the path resolves to
 * `$HOME/.acuvo/warm-providers.json`, and **24 test files drive `runSession`**.
 * One file was enough to prove it:
 *
 *     node --test test/provider-routing-visibility.test.mjs
 *     ~/.acuvo/warm-providers.json  ->  { "byModel": { "fake/model": "Relace" } }
 *
 * ⭐ THAT FILE IS NOT A CACHE HINT, IT IS A LOCK. `routeFor` turns whatever it
 * holds into `provider: { only: [...] }` with fallbacks OFF, for EVERY workspace
 * on the machine, and the lock releases only on a FAILURE — an overpriced
 * success is not one. `ECONOMICS.md` prices one wrong entry at 4x the cache-read
 * rate we should be paying. A scripted stub has no business being in it.
 *
 * ⚠️ AND IT IS THE WHOLE DIRECTORY, NOT ONE FILE. `credentials.json` (a real
 * Acuvo token), `mcp-trust.json` and `update-check.json` live there too, and
 * `model.mjs` already records the other direction of the same coupling: *"The
 * moment Roman signed in, `~/.acuvo/credentials.json` existed, and a scoped
 * `env: {}` still resolved to the production gateway."* A suite whose result
 * depends on whether the developer is signed in is not a suite.
 *
 * ⭐ CONTAINED HERE RATHER THAN TRUSTED TO 24 FILES. Every module already
 * honours `ACUVO_HOME` (`warmthPath`, `account.mjs`, `acuvo-dir.mjs`); what was
 * missing is anyone setting it. Giving the run a throwaway home makes a module
 * that forgets harmless instead of dangerous, which is the opposite trade to
 * asking each test to remember.
 *
 * ⚠️ AN EXPLICIT `ACUVO_HOME` IS HONOURED. Someone deliberately pointing the
 * suite at a prepared directory is doing it on purpose; this only fills the gap.
 * `test/the-suite-never-writes-the-real-home.test.mjs` asserts the result.
 */
const borrowedHome = String(process.env.ACUVO_HOME ?? '').trim();
const scratchHome = borrowedHome || mkdtempSync(join(tmpdir(), 'acuvo-test-home-'));

// ⚠️ TAP, not spec: the machine-readable `# tests N` line is the thing being
// asserted below, and the spec reporter writes a decorated `ℹ tests N` instead.
const args = ['--test', `--test-concurrency=${concurrency}`, '--test-timeout=180000', '--test-reporter=tap', ...files];
const run = spawnSync(process.execPath, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  /**
   * ── ⚠️⚠️ THE FILE THAT PREVENTS A SILENTLY-GREEN SUITE WAS ITSELF SILENTLY
   * RED ─────────────────────────────────────────────────────────────────────
   *
   * `spawnSync`'s default `maxBuffer` is 1 MiB. TAP output for this suite is
   * ~1.05 MB, so stdout was TRUNCATED — and the `# tests N` summary is the LAST
   * line node writes. The parse below found no total, the "an unreadable result
   * is not a passing one" branch fired correctly, and `npm test` exited 1 on a
   * suite where 5,343 of 5,344 tests passed.
   *
   * ⭐ THE FAILURE MODE WAS EXACTLY BACKWARDS FROM THE ONE THIS FILE GUARDS.
   * Its header worries about reporting green when nothing ran; what actually
   * happened is reporting red when everything did — which trains people to
   * ignore the suite, and an ignored suite is a suite that is not run.
   *
   * ⚠️ 64 MiB, not `Infinity`. A runaway test that prints without bound should
   * still be stopped; the cap exists to catch that, and it was only ever set
   * too low for an honest amount of output. Measured 2026-09-01 at ~1.05 MB,
   * so this is ~60x headroom for a suite that grows.
   */
  maxBuffer: 64 * 1024 * 1024,
  /**
   * ⚠️⚠️ `ACUVO_GIT_SAFETY=0` IS NOT A PREFERENCE — IT STOPS THE SUITE WRITING
   * INTO THE DEVELOPER'S OWN REPOSITORY.
   *
   * `lib/git-safety.mjs` snapshots the working tree before every `run_command`
   * into `refs/acuvo/safety/`, which is exactly right for a user's project and
   * exactly wrong here: some tests use a root INSIDE this checkout, so running
   * `npm test` left 8 real refs in this repo the first time it shipped. They
   * were found and removed by hand, and hand is not a mechanism.
   *
   * ⭐ Same argument as `ACUVO_HOME` on the line below it: a suite that writes
   * outside its scratch directory is a suite that can damage the machine it is
   * meant to be proving safe.
   */
  env: { ...process.env, ACUVO_HOME: scratchHome, ACUVO_GIT_SAFETY: '0' },
});

/**
 * ⚠️ CLEANED UP ONLY IF WE MADE IT, and never fatally. A leftover temp directory
 * is litter; deleting a directory the caller chose would be data loss, and
 * failing the suite over `rm` would report a bookkeeping problem as a test
 * failure.
 */
if (!borrowedHome) { try { rmSync(scratchHome, { recursive: true, force: true }); } catch { /* litter beats loss */ } }

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
