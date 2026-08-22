import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyConfigToOptions, resolveConfig, explicitKeysFromArgv, CONFIG_KEYS } from '../lib/rcfile.mjs';

/**
 * The config file was 825 written lines that NOTHING called until 2026-08-17.
 * These pin the wiring, not the parsing — `rcfile.test.mjs` already covers the
 * resolver itself.
 */

test('⚠️⚠️ a key the user TYPED is never overwritten by a file', () => {
  /**
   * THE RULE THE WHOLE FEATURE TURNS ON. `resolveConfig` is told WHICH keys were
   * explicit but never sees their VALUES, so `values.maxRounds` still carries
   * the FILE's number even when the flag set it. Applying that blindly lets a
   * config file silently beat a flag the person just typed.
   */
  const argv = ['--max-rounds', '7'];
  const resolved = resolveConfig({ argv, env: {}, homeText: JSON.stringify({ maxRounds: 2 }) });
  assert.equal(resolved.ok, true);

  const opts = { maxRounds: 7 };
  applyConfigToOptions(opts, resolved.values, explicitKeysFromArgv(argv));
  assert.equal(opts.maxRounds, 7, 'the typed flag must survive the config file');
});

test('a key the user did NOT type is taken from the file', () => {
  const argv = [];
  const resolved = resolveConfig({ argv, env: {}, homeText: JSON.stringify({ maxRounds: 2 }) });
  const opts = { maxRounds: 8 };
  applyConfigToOptions(opts, resolved.values, explicitKeysFromArgv(argv));
  assert.equal(opts.maxRounds, 2);
});

test('⭐ a WORKSPACE config cannot LOOSEN a setting — that is the trust split', () => {
  /**
   * `.acuvo/config.json` arrives with a repo you cloned. A workspace that could
   * RAISE your budget or switch running back on would be a config file with a
   * security hole in it.
   */
  const loose = resolveConfig({
    argv: [], env: {},
    homeText: JSON.stringify({ maxRounds: 4 }),
    workspaceText: JSON.stringify({ maxRounds: 40 }),   // a repo asking for MORE
  });
  assert.equal(loose.ok, true);
  assert.ok(loose.values.maxRounds <= 4, `a workspace must not raise the ceiling (got ${loose.values.maxRounds})`);
  // ⭐ And it SAYS so rather than silently dropping the value.
  assert.match(loose.notes.join(' '), /may only tighten/);
});

test('⚠️ your own home config outranks a repository, even when the repo is stricter', () => {
  /**
   * ⚠️⚠️ I ASSERTED THE OPPOSITE FIRST, AND THE MODULE WAS RIGHT. I expected a
   * workspace asking for FEWER rounds to win, on "a repo may only tighten".
   * Measured: home 40 + workspace 4 resolves to 40.
   *
   * ⭐ The layering explains it and is defensible: sources apply in order
   * workspace-then-home, and `~/.acuvo/config.json` is YOURS — it is outside any
   * repo and nothing you cloned can edit it. "A repo may only tighten" bounds
   * what a repo can do to the value BENEATH it; it was never a promise that a
   * repo outranks your own settings.
   *
   * Pinned because it is genuinely surprising, so that a future change to the
   * order is a deliberate decision rather than an accident.
   */
  const r = resolveConfig({
    argv: [], env: {},
    homeText: JSON.stringify({ maxRounds: 40 }),
    workspaceText: JSON.stringify({ maxRounds: 4 }),
  });
  assert.equal(r.values.maxRounds, 40, 'the home config is the trusted layer and applies last');
});

test('every CONFIG_KEYS option name is a real field the CLI parses', () => {
  /**
   * ⚠️ A DRIFT GUARD. `applyConfigToOptions` writes `options[spec.option]`, so a
   * renamed parser field would make the config silently stop applying — no
   * error, no warning, just settings that quietly do nothing.
   */
  const cli = readFileSync(join(import.meta.dirname, '..', 'lib', 'cli-args.mjs'), 'utf8');
  const missing = Object.values(CONFIG_KEYS)
    .map((s) => s.option)
    .filter((name) => !cli.includes(name));
  assert.deepEqual(missing, [], 'these config keys write option fields cli-args.mjs does not have');
});

test('a malformed config refuses rather than silently falling back', () => {
  const bad = resolveConfig({ argv: [], env: {}, homeText: '{ not json' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not valid JSON/);
});

test('applyConfigToOptions is a no-op when there is nothing to apply', () => {
  const opts = { maxRounds: 8 };
  applyConfigToOptions(opts, null, new Set());
  assert.deepEqual(opts, { maxRounds: 8 });
});
