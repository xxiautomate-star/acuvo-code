import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStickyKey } from '../lib/turn.mjs';

/**
 * ── 💰⭐⭐⭐ THE STICKY KEY IS THE PROMPT CACHE ───────────────────────────────
 *
 * `session_id` is what OpenRouter groups by when it picks an upstream, and
 * `deepseek-v4-flash-0731` has 28 of them. A prompt cache lives on ONE provider,
 * so a key that changes between runs means a different upstream — and a COLD
 * cache — every single time.
 *
 * ⚠️ IT USED TO BE `acuvo-${randomUUID()}`. `turn.mjs` already recorded the
 * damage without calling it a bug: *"each cold process rolled the dice afresh"*,
 * measured as a 65 / 98 / 31 / 98 alternation. Only RESUMED sessions escaped it,
 * and the common case — `acuvo "do the thing"` in a project, over and over —
 * never resumes.
 *
 * ⭐ NOTHING GUARDED THIS. The full suite was 3,584-green both before and after
 * the fix, because no test had an opinion about the key at all. That is the same
 * shape as every other silent regression here: the change is invisible to the
 * tests standing next to it.
 */

const withCwd = (dir, fn) => {
  const before = process.cwd();
  try {
    process.chdir(dir);
    return fn();
  } finally {
    process.chdir(before);
  }
};

test('⭐⭐⭐ the same workspace produces the SAME key — a cold process reuses its cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-sticky-'));
  const a = withCwd(dir, defaultStickyKey);
  const b = withCwd(dir, defaultStickyKey);
  assert.equal(a, b, 'two runs in one project must return to the same upstream');
});

test('⭐ different workspaces do NOT share a key — one project cannot poison another', () => {
  const one = mkdtempSync(join(tmpdir(), 'acuvo-sticky-one-'));
  const two = mkdtempSync(join(tmpdir(), 'acuvo-sticky-two-'));
  assert.notEqual(withCwd(one, defaultStickyKey), withCwd(two, defaultStickyKey));
});

test('⚠️ it never carries the path itself — this value goes to a third party', () => {
  /**
   * A raw cwd would put `C:/Projects/clients/<name>` into request metadata at
   * OpenRouter, leaking a customer list into someone else's logs. Hashing keeps
   * it stable AND silent — both properties are load-bearing, not one.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-sticky-secretclient-'));
  const key = withCwd(dir, defaultStickyKey);
  assert.ok(!key.includes('secretclient'), `the workspace path leaked into the key: ${key}`);
  assert.match(key, /^acuvo-[0-9a-f]{32}$/, 'expected acuvo- plus a hex digest');
});

test('⚠️ it stays inside the 256 characters OpenRouter accepts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-sticky-len-'));
  assert.ok(withCwd(dir, defaultStickyKey).length <= 256);
});
