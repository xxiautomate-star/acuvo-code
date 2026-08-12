/**
 * ── ⚠️⚠️ THE TIMEOUT THAT KILLED CORRECT WORK ───────────────────────────────
 *
 * `--test-timeout` was added on 2026-08-12 because the suite could hang FOREVER
 * and a hang was indistinguishable from slow work. That was right. The number
 * chosen — 60s — was not, and it failed in the other direction within a day.
 *
 * MEASURED:
 *   test/tsserver.test.mjs alone     : 28.5s, three runs, consistent
 *   whole suite, 8-way parallel      : 90.4s wall-clock, 0 failures
 *   whole suite at --test-timeout=60s: tsserver killed at 60,045ms
 *
 * So the file was never hanging. It spawns real tsserver processes, takes ~28s
 * on an idle machine, and exceeds 60s when seven other files are competing for
 * eight cores. The timeout was reporting a healthy file as broken — which is the
 * exact class of failure this package has burned days on, arriving inside the
 * guard built to prevent its opposite.
 *
 * ⭐ THE RULE: a timeout meant to catch a HANG must be sized against the slowest
 * honest run under load, not against a comfortable-sounding round number. It
 * only has to be finite to do its job. 180s is ~2x the whole suite's wall-clock
 * and ~6x the slowest file measured alone, and still turns an infinite wait into
 * a named failure in three minutes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

test('⭐⭐ the suite still has a finite timeout — a hang must never be able to wait forever', () => {
  const m = /--test-timeout=(\d+)/.exec(pkg.scripts.test);
  assert.ok(m, 'the test script must pass --test-timeout; node --test has NO default and a hang is then unbounded');
  const ms = Number(m[1]);
  assert.ok(Number.isFinite(ms) && ms > 0, 'and it must be a real number');
  assert.ok(ms <= 600_000, `${ms}ms is long enough that a hang stops being reported to a human waiting for it`);
});

test('⚠️ …and enough headroom that a slow-but-healthy file is not failed', () => {
  /**
   * The measured worst case is the whole suite at 90.4s wall-clock, with
   * tsserver.test.mjs the long pole. A timeout below that is a false-failure
   * generator on a busy machine — which is how this rule got written.
   */
  const observedSuiteWallClockMs = 90_400;
  const ms = Number(/--test-timeout=(\d+)/.exec(pkg.scripts.test)[1]);
  assert.ok(
    ms >= observedSuiteWallClockMs * 1.5,
    `${ms}ms leaves too little headroom over the measured ${observedSuiteWallClockMs}ms suite — `
    + 'a slow machine will fail correct work, which is worse than no timeout at all',
  );
});
