/**
 * ── ⚠️⚠️ THE ROAD WITH THE GATE WAS SAFER THAN THE ROAD WITHOUT ─────────────
 *
 * With `ACUVO_ALLOW_INSTALL` unset, `npm install is-number` is refused with a
 * paragraph. An adversarial pass then wrote `setup.js` with `write_file` and ran
 * `node setup.js`, which installed the same package — exit 0, and with LIFECYCLE
 * SCRIPTS ENABLED, because `--ignore-scripts` is a flag this package puts on the
 * npm command line, and a command line it never sees has no flags on it.
 *
 * ⚠️ THE ROAD ITSELF DOES NOT CLOSE, AND CLAIMING OTHERWISE WOULD BE THE LIE.
 * `node <a file the model wrote>` is a risk this package carries in the open;
 * `validateInstallSpec`'s own paragraph names it. What closes is the
 * ESCALATION — the step from "code the model wrote runs" to "a stranger's
 * `postinstall` runs", which is the actual npm supply-chain vector.
 *
 * ⭐ MEASURED A/B, the real `runProgram`, a real `npm install` of a local
 * package whose postinstall writes a marker file:
 *     pre-fix (HEAD)   installed: true   POSTINSTALL RAN: true
 *     with the fix     installed: true   POSTINSTALL RAN: false
 * The install still succeeds. That is the point — the road is unchanged and
 * only the escalation is gone.
 *
 * ⚠️⚠️ AND THE COST WAS MEASURED BEFORE IT WAS ACCEPTED. With
 * `npm_config_ignore_scripts=true`, `npm run build` still runs `build` but
 * SILENTLY SKIPS `prebuild`. This package explicitly resolves and validates
 * `[pre<name>, <name>, post<name>]` in `validateNpmScriptChain`, so pre/post
 * hooks are behaviour it supports on purpose — which is why npm itself is
 * exempt, and why that exemption has its own test below.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment, scrubEnvironment } from '../lib/command.mjs';
import { runProgram } from '../lib/spawn-argv.mjs';

const OFF = 'npm_config_ignore_scripts';

test('⚠️⚠️ a NON-npm child gets install scripts switched off in its environment', () => {
  // A command line cannot reach an npm that a script starts. An environment can.
  const env = childEnvironment({ file: 'C:\\node.exe', args: ['setup.js'] }, {});
  assert.equal(env[OFF], 'true');
});

test('⭐⭐ npm ITSELF is exempt — pre/post hooks are behaviour this package supports', () => {
  /**
   * Measured: with the variable set, `npm run build` runs `build` and silently
   * skips `prebuild`. `validateNpmScriptChain` resolves that exact chain and
   * validates every link, so suppressing it here would break work the package
   * deliberately supports, with no message. A guard that fails correct work is
   * worse than no guard.
   */
  assert.equal(childEnvironment({ file: 'npm', args: ['run', 'build'] }, {})[OFF], undefined);
  assert.equal(childEnvironment({ file: 'npx', args: ['tsc'] }, {})[OFF], undefined);
});

test('⚠️⚠️ npm is spawned as `node …/npm-cli.js`, so the FILE is node — detection must read the ARGV', () => {
  /**
   * ⭐ THE ASSERTION MOST LIKELY TO CATCH A FUTURE BREAK. `buildInvocation`
   * resolves npm to a `.js` file because Node refuses to spawn `npm.cmd`
   * without a shell (BatBadBut, CVE-2024-27980). So a check on `file` alone
   * would exempt nothing and quietly break every `npm run` with a prebuild.
   * Derived from the argv about to be spawned — the precedent `buildInvocation`
   * already sets for "is this an install?".
   */
  for (const args of [
    ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'build'],
    ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'test'],
    ['/usr/lib/node_modules/npm/bin/npx-cli.js', 'tsc'],
  ]) {
    assert.equal(childEnvironment({ file: process.execPath, args }, {})[OFF], undefined, args[0]);
  }
});

test('⚠️ a package merely NAMED like npm does not get the exemption', () => {
  // `npm-check-updates`, `./npmish/run.js`, `my-npm-helper` are ordinary
  // programs. An exemption that matched them would be a hole with a friendly
  // name on it.
  for (const args of [['npm-check-updates'], ['./npmish/run.js'], ['tools/my-npm-helper.js'], ['npmfoo']]) {
    assert.equal(childEnvironment({ file: process.execPath, args }, {})[OFF], 'true', args[0]);
  }
});

test('⚠️⚠️ it still SCRUBS — the new job must not have cost the old one', () => {
  /**
   * `childEnvironment` wraps `scrubEnvironment`, and the whole reason that
   * function exists is that a child must never see the provider key. A wrapper
   * that quietly stopped delegating would be a credential leak wearing a
   * feature's name.
   */
  const dirty = { OPENROUTER_API_KEY: 'sk-real', GITHUB_TOKEN: 'ghp_real', PATH: '/usr/bin' };
  const env = childEnvironment({ file: 'node', args: ['x.js'] }, dirty);
  assert.equal(env.OPENROUTER_API_KEY, undefined, 'the provider key reached a child');
  assert.equal(env.GITHUB_TOKEN, undefined, 'a conventionally-named secret reached a child');
  assert.equal(env.PATH, '/usr/bin', 'an ordinary variable must survive, or every child breaks');
  // And it must agree with scrubEnvironment on everything except the one key.
  const scrubbed = scrubEnvironment(dirty);
  const { [OFF]: _added, ...rest } = env;
  assert.deepEqual(rest, scrubbed, 'childEnvironment diverged from scrubEnvironment beyond the one variable it adds');
});

test('⚠️ an inherited npm_config_ignore_scripts=false is OVERRIDDEN, not inherited', () => {
  // Otherwise the parent environment is the bypass: one variable and the
  // protection is off, which is the shape `scrubEnvironment` refuses for
  // NODE_OPTIONS for exactly the same reason.
  const env = childEnvironment({ file: 'node', args: ['x.js'] }, { npm_config_ignore_scripts: 'false' });
  assert.equal(env[OFF], 'true');
});

test('⚠️⚠️ END TO END: `node setup.js` installs, and the postinstall does NOT run', async () => {
  /**
   * ⭐ THE ASSERTION IS THE MARKER FILE, not an error message. The install is
   * SUPPOSED to succeed: the road stays open and this package says so. What
   * must not happen is a stranger's script executing. Pre-fix, this same script
   * wrote the marker.
   *
   * ⚠️ THE CONTROL MATTERS. `installed: true` is asserted alongside, so a run
   * where npm simply failed cannot masquerade as protection — "nothing ran"
   * because "nothing happened" would prove nothing at all.
   */
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-postinstall-'));
  try {
    const marker = join(ws, 'PWNED.txt').split('\\').join('/');
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'victim', version: '1.0.0' }));
    mkdirSync(join(ws, 'dep'));
    writeFileSync(join(ws, 'dep', 'package.json'), JSON.stringify({
      name: 'dep-probe',
      version: '1.0.0',
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','postinstall ran')"` },
    }));
    // Exactly what an agent can write with write_file today.
    writeFileSync(join(ws, 'setup.js'), [
      "const { execSync } = require('child_process');",
      "execSync('npm install ./dep --silent --no-audit --no-fund', { cwd: __dirname, stdio: 'inherit' });",
    ].join('\n'));

    const res = await runProgram({ program: 'node', args: ['setup.js'], root: ws, timeoutMs: 120_000 });

    assert.equal(existsSync(join(ws, 'node_modules', 'dep-probe')), true,
      `the install did not happen at all, so this test proves nothing: ${res.error ?? res.stderr ?? ''}`);
    assert.equal(existsSync(join(ws, 'PWNED.txt')), false,
      'a dependency postinstall executed through the ungated road');
  } finally {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('⚠️⚠️ REACH: `evaluate` gets it too — the model-written-snippet road, wired but otherwise unproven', async () => {
  /**
   * ⭐ WIRED IS NOT PROVEN. Four spawn sites were changed and only two are
   * exercised above (spawnBounded's default, and spawn-argv through the
   * end-to-end install). `evaluate` stages a snippet the model wrote and spawns
   * node on it — the purest form of the road this whole file is about — and a
   * site connected without a test is exactly how this package ships a correct
   * function nothing calls.
   *
   * The snippet reports its own environment, so the assertion reads what the
   * child actually received rather than what the caller meant to send.
   */
  const { evaluateSnippet } = await import('../lib/evaluate.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-eval-env-'));
  try {
    const res = await evaluateSnippet({
      source: `console.log('IGNORE_SCRIPTS=' + process.env.npm_config_ignore_scripts);`,
      executor: {
        root: ws,
        dryRun: false,
        // A REAL writer: evaluateSnippet stages the snippet through the executor,
        // and a stub that pretended to write would test nothing.
        writeFile: (rel, body) => { writeFileSync(join(ws, rel), body); return { ok: true }; },
      },
      timeoutMs: 30_000,
    });
    assert.equal(res.ok, true, res.error);
    assert.match(String(res.stdout ?? res.output ?? ''), /IGNORE_SCRIPTS=true/,
      'a snippet the model wrote could still start an npm with lifecycle scripts on');
  } finally {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
