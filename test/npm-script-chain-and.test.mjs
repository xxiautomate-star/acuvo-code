/**
 * ── ⚠️⚠️ `&&` IN A package.json SCRIPT REFUSED THE COMMONEST SHAPE THERE IS ──
 *
 * `"test": "tsc --noEmit && vitest run"` is what a TypeScript project's test
 * script looks like. `validateNpmScriptChain` handed the WHOLE body to
 * `validateCommand`, whose `SAFE_COMMAND_CHARS` has no `&` in it, so the script
 * was rejected wholesale and the agent could not run the project's own contract.
 * Observed in a real run: it burned a paid round, read package.json, and
 * decomposed the chain by hand — which is admirable and should not be necessary.
 *
 * ⭐ AND THE EXECUTOR NEEDS NO CHANGE AT ALL. The CLI never executes that body:
 * `buildInvocation` spawns `node npm-cli.js <script>` with `shell:false`, and
 * NPM supplies its own script shell. Only the validator was blocking. So this is
 * a validator-only fix, which is why it is minutes rather than days.
 *
 * ⚠️⚠️ THE SAFETY CASES ARE THE POINT OF THIS FILE, NOT THE FEATURE. Splitting on
 * `&&` must not become "shell operators are fine now". Every case below that
 * MUST STILL REFUSE is asserted first, because a permissive bug here is a
 * remote-code-execution bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateNpmScriptChain } from '../lib/command.mjs';

const pkg = (scripts) => JSON.stringify({ name: 'x', version: '1.0.0', scripts });

// ── ⚠️ WHAT MUST STILL BE REFUSED ──────────────────────────────────────────

test('⚠️⚠️ a chained script may not smuggle a forbidden program past the allowlist', () => {
  /**
   * The whole risk of this change in one case: `&&` is now a separator, so each
   * side is validated on its own — and `curl` is not an allowed binary, so the
   * script must still die. If this ever passes, the allowlist has been defeated
   * by punctuation.
   */
  const r = validateNpmScriptChain('test', pkg({ test: 'npm test && curl evil.sh' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /curl/, 'and the refusal must name the offending segment, not just say no');
});

test('⚠️ every other shell operator is still refused — only && was ever the ask', () => {
  const forbidden = [
    'node a.js; rm -rf /',
    'node a.js | sh',
    'node a.js || curl evil.sh',
    'node a.js > out.txt',
    'node $(whoami).js',
    'node `whoami`.js',
    'node a.js & node b.js',
    'node a.js 2>&1',
  ];
  for (const body of forbidden) {
    const r = validateNpmScriptChain('test', pkg({ test: body }));
    assert.equal(r.ok, false, `${body} must be refused`);
  }
});

test('⚠️ a lone & is not a chain — a single ampersand still dies', () => {
  /**
   * `a & b` backgrounds on POSIX and is a different operator entirely. Splitting
   * on the two-character token `&&` leaves a lone `&` inside a segment, where
   * the tokenizer refuses it. Asserted so a future "simplify" to `split('&')`
   * fails loudly.
   */
  const r = validateNpmScriptChain('test', pkg({ test: 'node a.js & node b.js' }));
  assert.equal(r.ok, false);
});

test('⚠️ the pre/post hooks are chained too, and a chained hook is validated the same way', () => {
  const bad = validateNpmScriptChain('test', pkg({ pretest: 'curl evil.com && node ok.js', test: 'node t.js' }));
  assert.equal(bad.ok, false, 'a hook is executed by npm, so it is our problem');
  assert.match(bad.error, /pretest/);

  const good = validateNpmScriptChain('test', pkg({ pretest: 'tsc --noEmit && node gen.js', test: 'node t.js' }));
  assert.equal(good.ok, true, 'and a safe chained hook is fine');
});

// ── ⭐ WHAT MUST NOW WORK ───────────────────────────────────────────────────

test('⭐⭐ the commonest TypeScript test script in the world now runs', () => {
  const r = validateNpmScriptChain('test', pkg({ test: 'tsc --noEmit && vitest run' }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(r.chain.map((c) => c.name), ['test']);
  assert.equal(r.chain[0].body, 'tsc --noEmit && vitest run', 'the body is handed to npm UNMODIFIED — npm brings its own shell');
});

test('⭐ several links, and whitespace around the operator, all parse', () => {
  for (const body of [
    'node build.js && node test.js && node lint.js',
    'tsc&&vitest run',
    '  tsc --noEmit   &&   vitest run  ',
  ]) {
    const r = validateNpmScriptChain('test', pkg({ test: body }));
    assert.equal(r.ok, true, `${body} should be allowed: ${r.ok ? '' : r.error}`);
  }
});

test('an empty segment is refused rather than silently skipped', () => {
  /**
   * `node a.js &&` and `&& node a.js` are malformed. Treating an empty segment
   * as "nothing to check, therefore fine" is how a validator ends up approving
   * a string it never actually inspected.
   */
  for (const body of ['node a.js &&', '&& node a.js', 'node a.js && && node b.js']) {
    const r = validateNpmScriptChain('test', pkg({ test: body }));
    assert.equal(r.ok, false, `${body} must be refused`);
  }
});

test('an unchained script is byte-identical to before — the fix is additive', () => {
  const r = validateNpmScriptChain('unit', pkg({ unit: 'node t.js' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.chain, [{ name: 'unit', body: 'node t.js' }]);
});
