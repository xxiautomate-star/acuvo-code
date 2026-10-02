/**
 * ── ⚠️⚠️⚠️ THE STUB THAT BECAME A MACHINE-WIDE ROUTING LOCK ────────────────
 *
 * `~/.acuvo/warm-providers.json` is not a cache hint, it is a LOCK: `routeFor`
 * turns whatever it holds into a single-name request with `allow_fallbacks:
 * false`, for every workspace on the machine, and the lock releases only on a
 * FAILURE — an overpriced success is not one. One wrong entry measured a
 * multiple of the configured endpoints on cache reads, indefinitely.
 *
 * ⭐ AND THE TEST SUITE IS ONE OF ITS WRITERS. `turn.mjs` ends every session
 * with `saveWarmth(warmth)` — no env, no home. Measured 2026-08-25 by logging
 * every argument `rememberWarm` was handed across BOTH checkouts of this
 * package (4,223 tests here, 3,617 in `C:/Projects/acuvo-code-public`), the
 * values a test run tries to persist are:
 *
 *     fake/model  -> five different upstream names, from five fixtures
 *     guard/model -> NotARealUpstream
 *
 * Every one of them is a scripted stub. None of them ever served anything.
 *
 * ── ⚠️ WHY THE EXISTING TWO GUARDS DO NOT COVER THIS ────────────────────────
 *
 *   1. `rememberWarm`'s plausibility floor rejects `"P"` and its membership
 *      check rejects an unchosen pin for a model we PRICED. Neither has any
 *      opinion about a well-formed stub name under `fake/model` — nothing about
 *      the STRING is wrong. Its PROVENANCE is what is wrong, and a string
 *      cannot carry that.
 *   2. `scripts/test.mjs` gives the run a throwaway `ACUVO_HOME`, and
 *      `the-suite-never-writes-the-real-home.test.mjs` holds it there. That is
 *      correct and it is one `cd` from being off: the published clone at
 *      `C:/Projects/acuvo-code-public` ships the same `saveWarmth` and its
 *      harness sets no `ACUVO_HOME` at all (verified on disk), and the
 *      documented single-file invocation — `node --test test/x.test.mjs` —
 *      never reaches the harness in either repo.
 *
 * ⭐ SO THE REFUSAL IS AT THE WRITE, WHERE NOTHING CAN ROUTE AROUND IT.
 * `NODE_TEST_CONTEXT` is set by `node --test` in every test process and by
 * nothing else — probed, `"child-v8"` under `node --test`, `undefined` for a
 * plain `node file.mjs`. It is the one fact available at the moment of the write
 * that separates a session from a stub.
 *
 * ⚠️ THESE TESTS NEVER TOUCH `$HOME`. Every call passes a throwaway `home`
 * argument, so even a regression in the code under test writes into a temp
 * directory. A test that proves damage must not also be able to do it.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  freshWarmth, rememberWarm, saveWarmth, loadWarmth, warmthPath,
  persistenceRefusedByTestRunner,
} from '../lib/warm-provider.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** A throwaway stand-in for `$HOME`, so the default path can be exercised safely. */
function fakeHome() {
  const d = mkdtempSync(join(tmpdir(), 'acuvo-warmth-guard-'));
  made.push(d);
  return d;
}

/** A state carrying exactly the kind of value the suite was persisting. */
function stubWarmth() {
  // ⚠️ `fake/model` has no configured pin, so `rememberWarm` learns this freely —
  // which is precisely why the floor and the membership check cannot help here.
  return rememberWarm(freshWarmth(), 'fake/model', 'Relace');
}

test('⚠️⚠️ under `node --test` with no ACUVO_HOME, warmth is NOT persisted', () => {
  const home = fakeHome();
  const env = { NODE_TEST_CONTEXT: 'child-v8' };

  assert.equal(saveWarmth(stubWarmth(), env, home), false,
    'a scripted stub was written to the default warmth path — that path is a machine-wide, fallback-free '
    + 'provider lock, and the lock only releases on a FAILURE');
  assert.equal(existsSync(warmthPath(env, home)), false, 'the file was created at all, which is the write');
});

test('⭐ an explicit ACUVO_HOME is still honoured — a prepared directory is deliberate', () => {
  const home = fakeHome();
  const scratch = fakeHome();
  const env = { NODE_TEST_CONTEXT: 'child-v8', ACUVO_HOME: scratch };

  assert.equal(saveWarmth(stubWarmth(), env, home), true,
    'aiming the suite at a throwaway home is the containment that already exists; refusing there would break it');
  assert.match(readFileSync(warmthPath(env, home), 'utf8'), /Relace/);
  assert.equal(existsSync(join(home, '.acuvo', 'warm-providers.json')), false,
    'it wrote the real-shaped path as well as the override');
});

test('⭐ a REAL run is untouched — no test context, so it persists exactly as before', () => {
  const home = fakeHome();
  // ⚠️ `{}` is what a real `acuvo` process looks like here: `NODE_TEST_CONTEXT`
  // is set by `node --test` and by nothing else.
  const env = {};

  assert.equal(saveWarmth(stubWarmth(), env, home), true, 'the feature this file guards is cross-run warmth; it must still work');
  assert.equal(loadWarmth(env, home).byModel.get('fake/model'), 'Relace',
    'a real run must be able to read back what it learned, or round one is cold forever');
});

/**
 * ⭐⭐ THE END-TO-END HALF, BECAUSE ONLY THE REAL ENVIRONMENT PROVES REACH. The
 * three cases above hand-build an env; this one uses the env THIS PROCESS
 * actually has. The harness sets `ACUVO_HOME`, so it is blanked to reproduce the
 * bypass — `node --test test/x.test.mjs`, and the published clone's harness,
 * which sets none.
 */
test('⭐⭐ this very process is a test runner, and the real env is refused when ACUVO_HOME is blank', () => {
  assert.ok(String(process.env.NODE_TEST_CONTEXT ?? '').trim(),
    'NODE_TEST_CONTEXT is absent, so the signal this guard depends on is not present in a real run of the suite — '
    + 'the guard would be decoration');

  const home = fakeHome();
  const bypass = { ...process.env, ACUVO_HOME: '' };
  assert.equal(persistenceRefusedByTestRunner(bypass), true);
  assert.equal(saveWarmth(stubWarmth(), bypass, home), false);
  assert.equal(existsSync(join(home, '.acuvo', 'warm-providers.json')), false);
});

/**
 * ⚠️ A READ IS NOT A WRITE. Refusing to LOAD under a test runner would change
 * what the suite exercises for no safety gain — the damage this file exists to
 * stop is a stub becoming a lock, and nothing is locked by reading.
 */
test('loading is unaffected — the refusal is about writing, not about reading', () => {
  /**
   * ⚠️ RE-PINNED 2026-08-27: flash's pin dropped StreamLake entirely — it led
   * the OLD list at 7.3x the cheapest reachable endpoint, its own comment
   * claiming "the three cheapest within 3%" was false, and it is not in
   * `KNOWN_PROVIDERS_BY_MODEL` for flash any more (pin is now
   * `['DeepInfra','Ambient','Relace']`, lanes add `OpenInference`/`BaseTen`/
   * `SiliconFlow`). `rememberWarm`'s membership check — the thing
   * `a-test-run-cannot-write-the-machines-warmth.test.mjs` exists to test
   * AROUND, not to trip on by accident — now rejects `StreamLake` for this
   * model, so `freshWarmth()` came back unchanged and `.get()` read
   * `undefined` instead of the string this test asserted. Swapped to
   * `DeepInfra`, the new lead name, which is what a real warm session would
   * actually learn.
   */
  const scratch = fakeHome();
  const seed = { NODE_TEST_CONTEXT: 'child-v8', ACUVO_HOME: scratch };
  saveWarmth(rememberWarm(freshWarmth(), 'deepseek/deepseek-v4-flash-0731', 'DeepInfra'), seed, fakeHome());

  const loaded = loadWarmth({ NODE_TEST_CONTEXT: 'child-v8', ACUVO_HOME: scratch }, fakeHome());
  assert.equal(loaded.byModel.get('deepseek/deepseek-v4-flash-0731'), 'DeepInfra');
});

/**
 * ⚠️ THE ONE LINE THAT SAYS THE DEFAULT PATH IS STILL THE HOME PATH. If somebody
 * "fixes" this guard by pointing `warmthPath` somewhere else, the refusal above
 * would be guarding a location nothing uses.
 */
test('the path this protects really is the machine-global one', () => {
  assert.equal(warmthPath({}, homedir()), join(homedir(), '.acuvo', 'warm-providers.json'));
});
