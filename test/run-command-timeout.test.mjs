/**
 * ── ⭐⭐ `run_command` CAN ASK FOR MORE TIME — `run_program` ALWAYS COULD ────
 *
 * `run_program` has taken `timeoutMs` since it was written. `run_command` — the
 * tool that actually runs builds, installs and long test suites, and the only
 * one available under `--shell` — did not even DECLARE it. So the tool most
 * likely to need longer was the only one that could not ask, and a slow install
 * simply died at the default with nothing to show for it.
 *
 * Measured on the benchmark before this: one task lost 841s of a 900s budget
 * (93%) to four kills that each returned nothing.
 *
 * ⚠️ IT RAISES WHAT A COMMAND MAY TAKE, NEVER WHAT IT MAY BYPASS. The runner
 * still clamps to MAX_COMMAND_TIMEOUT_MS, and a non-positive or non-numeric
 * value falls back to the run's own setting rather than becoming a zero-length
 * timeout that would kill every command instantly.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOOL_SCHEMAS, executeToolCall } from '../lib/tools.mjs';

const made = [];
after(() => {
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows handle lag */ } }
});

/**
 * ⚠️ A REAL SLEEPING PROCESS, IN A FILE. An inline `node -e "…"` loses its
 * quotes crossing the shell layer and exits instantly — which made the first
 * version of this check pass against a command that never slept at all.
 */
function sleeper(ms) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-timeout-'));
  made.push(root);
  writeFileSync(join(root, 'sleeper.mjs'), `setTimeout(function () {}, ${ms});\n`);
  return { root, dryRun: false, readFile: () => null };
}

const call = (args) => ({ id: 'c_1', function: { name: 'run_command', arguments: JSON.stringify(args) } });
const opts = { commandTimeoutMs: 120_000, allowRun: true, shell: true };

test('⭐ the parameter is declared, or the model can never send it', () => {
  const props = TOOL_SCHEMAS.find((s) => s.function?.name === 'run_command')?.function?.parameters?.properties;
  assert.ok(props?.timeoutMs, 'run_command must declare timeoutMs');
  // An undeclared parameter is a parameter that does not exist, however well the
  // dispatcher would have handled it.
  assert.match(props.timeoutMs.description, /600000/);
});

test('⭐⭐ a SHORT timeoutMs kills a command the run-wide setting would have allowed', async () => {
  const ex = sleeper(5000);
  const started = Date.now();
  const rec = await executeToolCall(call({ command: 'node sleeper.mjs', timeoutMs: 1500 }), ex, opts);
  const elapsed = Date.now() - started;

  assert.equal(rec.result.timedOut, true, JSON.stringify(rec.result).slice(0, 200));
  // The run-wide setting is 120s; if the per-call value were ignored this would
  // have run the full five seconds.
  assert.ok(elapsed < 4000, `should have been killed early, took ${elapsed}ms`);
});

test('⭐⭐ a LONG timeoutMs lets the same command finish', async () => {
  const ex = sleeper(3000);
  const rec = await executeToolCall(call({ command: 'node sleeper.mjs', timeoutMs: 20_000 }), ex, opts);
  assert.notEqual(rec.result.timedOut, true);
  assert.equal(rec.result.ok, true, JSON.stringify(rec.result).slice(0, 200));
});

test('⚠️⚠️ a junk value falls back — it never becomes a zero-length timeout', async () => {
  /**
   * The failure this guards is severe and quiet: `timeoutMs: 0` or `"soon"`
   * coerced straight through would kill EVERY command the instant it started,
   * and the model would read a workspace where nothing can be run.
   */
  const ex = sleeper(200);
  for (const bad of [0, -5, 'soon', null]) {
    const rec = await executeToolCall(call({ command: 'node sleeper.mjs', timeoutMs: bad }), ex, opts);
    assert.equal(rec.result.ok, true, `timeoutMs=${JSON.stringify(bad)} should fall back, got ${JSON.stringify(rec.result).slice(0, 120)}`);
  }
});
