/**
 * ── ⚠️⚠️ THE BENCH SCORED PROSE WE KEEP IMPROVING ───────────────────────────
 *
 * Every number the bench reported was scraped out of the human summary with a
 * regex, and `bench/run.mjs`'s own comments record THREE separate times that
 * matched the wrong thing: a fixture's own "$7.50" read as the run's cost, and a
 * summary warning captured instead of the model's reply — which scored `refuse`
 * 1/3 while the agent had behaved perfectly.
 *
 * ⭐ A benchmark whose inputs come from prose is a benchmark that scores our
 * improvements as regressions. The `--json` document now carries all of it
 * structurally, so the document is the source of truth for NUMBERS and the
 * transcript stays the source for BEHAVIOUR.
 *
 * ⚠️ THE FALLBACK IS NOT VESTIGIAL. A run that crashes before emitting a
 * document still has a transcript, and reporting $0 for a run that really spent
 * money is worse than reading a regex.
 */

import { test } from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert';
/**
 * ⚠️⚠️ IMPORTED LAZILY, AND THE STATIC VERSION WAS A SHIPPING BUG.
 *
 * `package.json` ships `test/` deliberately (ed08f2710) so a reviewer can run
 * the suite against the code they installed — but it does NOT ship `bench/`.
 * A STATIC `import ... from '../bench/...'` therefore failed at MODULE LOAD
 * in every clean install, taking the whole file down before a single test ran,
 * and node --test reports that as one failed file rather than as a skip.
 *
 * Measured 2026-08-15: `npm install` of the tarball then `npm test` gave 3
 * failures on a perfectly healthy build. A runtime `existsSync` guard cannot
 * fix this — the import has already thrown. It has to be dynamic.
 */
const BENCH_DIR = new URL('../bench/', import.meta.url);
const BENCH = new URL('../bench/read-outcome.mjs', import.meta.url);
const loadReadOutcome = async () => (await import(BENCH.href)).readOutcome;

const SUMMARY = 'acuvo · deepseek/deepseek-v4-flash-0731 · 4 rounds · 41000 tokens · $0.0031\n✔ VERIFIED — `npm test` exited 0.';

test('⭐⭐ the document wins over the prose', async (t) => {
  /**
   * ⚠️ SKIPS WHEN bench/ IS NOT ON DISK, AND THAT IS NOT LAZINESS.
   *
   * `package.json` ships `test/` deliberately (commit ed08f2710, "ship the
   * tests, and add CI that would have caught the false green") so a reviewer can
   * run them against the code they installed. But it does NOT ship the repo-only
   * files this test reads — measured with `npm pack --dry-run`: bench/,
   * scripts/, .github/ and the working notes are all absent from the tarball.
   *
   * ⚠️⚠️ SO IN A CLEAN INSTALL THIS FAILED, and it failed for the worst possible
   * reason: not because the code is wrong, but because its SUBJECT was not
   * shipped. Measured 2026-08-15 — repo: 0 failures; `npm install` of the
   * tarball then `npm test`: 3 failures. An enterprise reviewer taking
   * ENTERPRISE.md up on "run them yourself" met a red suite on a healthy build,
   * which discredits the other 2,500 tests that were telling the truth.
   *
   * ⭐ 43 other tests in this suite already skip when their subject is absent.
   * This one now follows the pattern instead of being the exception.
   */
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball — this checks a repo-only artefact');
  const readOutcome = await loadReadOutcome();

  const doc = { costUsd: 0.0007, rounds: 2, verification: { passed: true } };
  const r = readOutcome(doc, SUMMARY);
  assert.equal(r.cost, 0.0007, 'the document cost, not the summary\'s $0.0031');
  assert.equal(r.rounds, 2);
  assert.equal(r.verified, true);
});

test('⚠️⚠️ a FALSE verification in the document is believed over a ✔ in the prose', async (t) => {
  /**
   * ⚠️ SKIPS WHEN bench/ IS NOT ON DISK, AND THAT IS NOT LAZINESS.
   *
   * `package.json` ships `test/` deliberately (commit ed08f2710, "ship the
   * tests, and add CI that would have caught the false green") so a reviewer can
   * run them against the code they installed. But it does NOT ship the repo-only
   * files this test reads — measured with `npm pack --dry-run`: bench/,
   * scripts/, .github/ and the working notes are all absent from the tarball.
   *
   * ⚠️⚠️ SO IN A CLEAN INSTALL THIS FAILED, and it failed for the worst possible
   * reason: not because the code is wrong, but because its SUBJECT was not
   * shipped. Measured 2026-08-15 — repo: 0 failures; `npm install` of the
   * tarball then `npm test`: 3 failures. An enterprise reviewer taking
   * ENTERPRISE.md up on "run them yourself" met a red suite on a healthy build,
   * which discredits the other 2,500 tests that were telling the truth.
   *
   * ⭐ 43 other tests in this suite already skip when their subject is absent.
   * This one now follows the pattern instead of being the exception.
   */
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball — this checks a repo-only artefact');
  const readOutcome = await loadReadOutcome();

  /**
   * The sharp case. `verification.passed` is the FACT; "✔ VERIFIED" is a
   * rendering of it. Reading the glyph meant the bench agreed with whatever the
   * summary said — including, until today, a fabricated green check for an HTTP
   * probe that was never a command and had no exit code.
   */
  const doc = { costUsd: 0.001, rounds: 3, verification: { passed: false } };
  const r = readOutcome(doc, SUMMARY);
  assert.equal(r.verified, false, 'a ✔ in the transcript must not override the recorded fact');
});

test('⭐ with no document, the prose still reads correctly', async (t) => {
  /**
   * ⚠️ SKIPS WHEN bench/ IS NOT ON DISK, AND THAT IS NOT LAZINESS.
   *
   * `package.json` ships `test/` deliberately (commit ed08f2710, "ship the
   * tests, and add CI that would have caught the false green") so a reviewer can
   * run them against the code they installed. But it does NOT ship the repo-only
   * files this test reads — measured with `npm pack --dry-run`: bench/,
   * scripts/, .github/ and the working notes are all absent from the tarball.
   *
   * ⚠️⚠️ SO IN A CLEAN INSTALL THIS FAILED, and it failed for the worst possible
   * reason: not because the code is wrong, but because its SUBJECT was not
   * shipped. Measured 2026-08-15 — repo: 0 failures; `npm install` of the
   * tarball then `npm test`: 3 failures. An enterprise reviewer taking
   * ENTERPRISE.md up on "run them yourself" met a red suite on a healthy build,
   * which discredits the other 2,500 tests that were telling the truth.
   *
   * ⭐ 43 other tests in this suite already skip when their subject is absent.
   * This one now follows the pattern instead of being the exception.
   */
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball — this checks a repo-only artefact');
  const readOutcome = await loadReadOutcome();

  const r = readOutcome(null, SUMMARY);
  assert.equal(r.cost, 0.0031);
  assert.equal(r.rounds, 4);
  assert.equal(r.verified, true);
});

test('⚠️ the $7.50 bug stays fixed — a cost inside FIXTURE DATA is not the run cost', async (t) => {
  /**
   * ⚠️ SKIPS WHEN bench/ IS NOT ON DISK, AND THAT IS NOT LAZINESS.
   *
   * `package.json` ships `test/` deliberately (commit ed08f2710, "ship the
   * tests, and add CI that would have caught the false green") so a reviewer can
   * run them against the code they installed. But it does NOT ship the repo-only
   * files this test reads — measured with `npm pack --dry-run`: bench/,
   * scripts/, .github/ and the working notes are all absent from the tarball.
   *
   * ⚠️⚠️ SO IN A CLEAN INSTALL THIS FAILED, and it failed for the worst possible
   * reason: not because the code is wrong, but because its SUBJECT was not
   * shipped. Measured 2026-08-15 — repo: 0 failures; `npm install` of the
   * tarball then `npm test`: 3 failures. An enterprise reviewer taking
   * ENTERPRISE.md up on "run them yourself" met a red suite on a healthy build,
   * which discredits the other 2,500 tests that were telling the truth.
   *
   * ⭐ 43 other tests in this suite already skip when their subject is absent.
   * This one now follows the pattern instead of being the exception.
   */
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball — this checks a repo-only artefact');
  const readOutcome = await loadReadOutcome();

  /**
   * The regex is anchored on `tokens · ` for exactly this reason: the loose
   * version matched "$7.50" inside a fixture's own test name, "3 hours at
   * $2.50/hr is $7.50", and reported it as the cost of a task that spent
   * $0.0008. Matching a shape that appears in DATA as well as in OUTPUT is the
   * pattern behind all three of this file's historical bugs.
   */
  const withFixture = 'test: 3 hours at $2.50/hr is $7.50\n' + SUMMARY;
  assert.equal(readOutcome(null, withFixture).cost, 0.0031);
});

test('⚠️ a crashed run reports zero rather than throwing', async (t) => {
  /**
   * ⚠️ SKIPS WHEN bench/ IS NOT ON DISK, AND THAT IS NOT LAZINESS.
   *
   * `package.json` ships `test/` deliberately (commit ed08f2710, "ship the
   * tests, and add CI that would have caught the false green") so a reviewer can
   * run them against the code they installed. But it does NOT ship the repo-only
   * files this test reads — measured with `npm pack --dry-run`: bench/,
   * scripts/, .github/ and the working notes are all absent from the tarball.
   *
   * ⚠️⚠️ SO IN A CLEAN INSTALL THIS FAILED, and it failed for the worst possible
   * reason: not because the code is wrong, but because its SUBJECT was not
   * shipped. Measured 2026-08-15 — repo: 0 failures; `npm install` of the
   * tarball then `npm test`: 3 failures. An enterprise reviewer taking
   * ENTERPRISE.md up on "run them yourself" met a red suite on a healthy build,
   * which discredits the other 2,500 tests that were telling the truth.
   *
   * ⭐ 43 other tests in this suite already skip when their subject is absent.
   * This one now follows the pattern instead of being the exception.
   */
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball — this checks a repo-only artefact');
  const readOutcome = await loadReadOutcome();

  // No document, no summary — the numbers are unknown, and unknown must be a
  // number the caller can add up rather than an exception mid-bench.
  const r = readOutcome(null, 'acuvo crashed — this is a bug in acuvo-code');
  assert.equal(r.cost, 0);
  assert.equal(r.rounds, 0);
  assert.equal(r.verified, false);
});

test('⚠️ a document missing a field falls back for THAT field only', async (t) => {
  /**
   * ⚠️ SKIPS WHEN bench/ IS NOT ON DISK, AND THAT IS NOT LAZINESS.
   *
   * `package.json` ships `test/` deliberately (commit ed08f2710, "ship the
   * tests, and add CI that would have caught the false green") so a reviewer can
   * run them against the code they installed. But it does NOT ship the repo-only
   * files this test reads — measured with `npm pack --dry-run`: bench/,
   * scripts/, .github/ and the working notes are all absent from the tarball.
   *
   * ⚠️⚠️ SO IN A CLEAN INSTALL THIS FAILED, and it failed for the worst possible
   * reason: not because the code is wrong, but because its SUBJECT was not
   * shipped. Measured 2026-08-15 — repo: 0 failures; `npm install` of the
   * tarball then `npm test`: 3 failures. An enterprise reviewer taking
   * ENTERPRISE.md up on "run them yourself" met a red suite on a healthy build,
   * which discredits the other 2,500 tests that were telling the truth.
   *
   * ⭐ 43 other tests in this suite already skip when their subject is absent.
   * This one now follows the pattern instead of being the exception.
   */
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball — this checks a repo-only artefact');
  const readOutcome = await loadReadOutcome();

  // Partial documents are real: a run can report cost and not verification.
  const r = readOutcome({ costUsd: 0.002 }, SUMMARY);
  assert.equal(r.cost, 0.002, 'from the document');
  assert.equal(r.rounds, 4, 'from the prose, because the document did not say');
  assert.equal(r.verified, true, 'from the prose, for the same reason');
});

test('⭐ a genuine zero cost is believed, not treated as missing', async (t) => {
  /**
   * ⚠️ SKIPS WHEN bench/ IS NOT ON DISK, AND THAT IS NOT LAZINESS.
   *
   * `package.json` ships `test/` deliberately (commit ed08f2710, "ship the
   * tests, and add CI that would have caught the false green") so a reviewer can
   * run them against the code they installed. But it does NOT ship the repo-only
   * files this test reads — measured with `npm pack --dry-run`: bench/,
   * scripts/, .github/ and the working notes are all absent from the tarball.
   *
   * ⚠️⚠️ SO IN A CLEAN INSTALL THIS FAILED, and it failed for the worst possible
   * reason: not because the code is wrong, but because its SUBJECT was not
   * shipped. Measured 2026-08-15 — repo: 0 failures; `npm install` of the
   * tarball then `npm test`: 3 failures. An enterprise reviewer taking
   * ENTERPRISE.md up on "run them yourself" met a red suite on a healthy build,
   * which discredits the other 2,500 tests that were telling the truth.
   *
   * ⭐ 43 other tests in this suite already skip when their subject is absent.
   * This one now follows the pattern instead of being the exception.
   */
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball — this checks a repo-only artefact');
  const readOutcome = await loadReadOutcome();

  // A fully-cached or free-tier run really can cost $0.00. `?? 0` on a falsy
  // number would silently fall through to the regex and report the summary's
  // figure instead — the "explicit zero is data" rule this repo has written
  // three times.
  const r = readOutcome({ costUsd: 0, rounds: 0, verification: { passed: false } }, SUMMARY);
  assert.equal(r.cost, 0);
  assert.equal(r.rounds, 0);
});
