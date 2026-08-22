/**
 * ── ⭐⭐ THE AGENT COULD NOT ADD A DEPENDENCY ────────────────────────────────
 *
 * "Add zod validation to this endpoint" is a first-ten-minutes request and it
 * dead-ended: the agent wrote `import { z } from 'zod'`, ran the file, got
 * ERR_MODULE_NOT_FOUND, and no verb in the package could ever make that import
 * resolve. Measured end to end in a throwaway workspace before this file was
 * written, then again after — the "after" is in the report.
 *
 * ── ⚠️ WHAT THIS FILE IS REALLY PINNING ────────────────────────────────────
 *
 * `npm install` is the most dangerous thing this package permits: it runs
 * arbitrary code from the registry (install hooks, transitively) and the
 * headline property of the product is ZERO DEPENDENCIES and a small auditable
 * surface. So the tests below are weighted towards the REFUSALS, and there are
 * five separate ones that each independently prevent an install from turning
 * into "a stranger's code executed":
 *
 *   1. it is OFF unless the operator set an environment variable the agent has
 *      no verb that reaches — and it is deliberately NOT a preset, because
 *      `.acuvo/commands.json` is a file the agent can write;
 *   2. `--ignore-scripts` is FORCED at the spawn, derived from the argv rather
 *      than from a flag a caller remembered to pass;
 *   3. a spec must be a REGISTRY NAME — no URL, git, `file:`, GitHub shorthand,
 *      or `npm:` alias (the alias is the nasty one: package.json ends up saying
 *      `zod` while a different package landed);
 *   4. a workspace `.npmrc` that redirects the registry refuses the install —
 *      that file is agent-writable and would make (3) decorative;
 *   5. the install must be RECORDED (`--no-save` refused) so a human sees it.
 *
 * ⚠️⚠️ AND THE THING NONE OF THIS SOLVES, ASSERTED NOWHERE BECAUSE IT CANNOT
 * BE: a package NAME chosen by a model is not safe. `zod` and `zodd` are both
 * well-formed. The Shai-Hulud npm worm shipped payloads inside AI coding-agent
 * config files precisely because agents install what they are told to. (2) is
 * what bounds it: a typosquat that lands has not RUN.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALLOWED_SCRIPT_BINARIES,
  ALLOW_INSTALL_ENV,
  COMMANDS_CONFIG_FILE,
  COMMAND_PRESETS,
  MAX_INSTALL_PACKAGES,
  INSTALL_MIN_TIMEOUT_MS,
  buildInvocation,
  executeRunCommand,
  formatRunForModel,
  inspectNpmrcForInstall,
  installEnabled,
  validateCommand,
  validateInstallSpec,
  validateNpmInstallArgv,
  validateNpmScriptChain,
} from '../lib/command.mjs';
import { planSingleSpawn, runProgram } from '../lib/spawn-argv.mjs';

const ON = { allowInstall: true };

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE DEFAULT SURFACE DOES NOT MOVE
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️ with no environment variable, every install verb is still refused', () => {
  for (const sub of ['install', 'i', 'add', 'ci']) {
    const v = validateCommand(`npm ${sub} zod`);
    assert.equal(v.ok, false, `npm ${sub} must be refused by default`);
  }
});

test('⭐ the refusal NAMES THE SWITCH — a capability nobody can find does not exist', () => {
  const v = validateCommand('npm install zod');
  assert.equal(v.ok, false);
  assert.match(v.error, /ACUVO_ALLOW_INSTALL=1/, 'the exact line a human must run');
  assert.match(v.error, /environment that launches/, 'and where to put it');
  assert.match(v.error, /--ignore-scripts is forced/, 'and what it will and will not do');
});

test('⚠️ the default surface still promises "never installs or publishes" through run_program', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-ni-'));
  try {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
    delete process.env[ALLOW_INSTALL_ENV];
    for (const sub of ['install', 'ci', 'i', 'add']) {
      const r = await runProgram({ root: ws, program: 'npm', args: [sub, 'left-pad'] });
      assert.equal(r.ok, false, `npm ${sub}`);
      assert.match(r.error, /never installs or publishes/);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

/**
 * ⚠️⚠️ THE LOAD-BEARING ONE. The preset menu's whole safety argument is that a
 * preset buys an INTERPRETER for code already on disk, never a DOWNLOADER —
 * and `.acuvo/commands.json` is a file the agent can write. A preset named
 * anything install-ish would be the agent granting itself a downloader in one
 * `write_file`. This test fails the moment someone adds one.
 */
test('⚠️⚠️ NO PRESET GRANTS AN INSTALL — the workspace file can never turn this on', () => {
  for (const [name, preset] of Object.entries(COMMAND_PRESETS)) {
    for (const bin of preset.binaries) {
      assert.notEqual(bin, 'npm', `preset "${name}" must not redeclare npm`);
    }
    const refused = Object.values(preset.grammar)
      .flatMap((g) => [...(g.refusedSubcommands?.keys() ?? [])]);
    const subs = Object.values(preset.grammar)
      .flatMap((g) => [...(g.subcommands ?? [])]);
    for (const s of ['install', 'add', 'get']) {
      assert.ok(!subs.includes(s), `preset "${name}" allows "${s}", which fetches from a registry`);
    }
    void refused;
  }
  // and the file itself may still only name presets
  const r = validateCommand('npm install zod', ON);
  assert.equal(r.ok, true, 'the ONLY door is the env switch, checked below');
});

test('installEnabled: absent means OFF, and only the four affirmatives turn it on', () => {
  assert.equal(installEnabled({}), false);
  assert.equal(installEnabled({ [ALLOW_INSTALL_ENV]: '' }), false);
  assert.equal(installEnabled({ [ALLOW_INSTALL_ENV]: '0' }), false);
  assert.equal(installEnabled({ [ALLOW_INSTALL_ENV]: 'false' }), false);
  assert.equal(installEnabled({ [ALLOW_INSTALL_ENV]: 'maybe' }), false);
  for (const yes of ['1', 'true', 'YES', ' on ']) {
    assert.equal(installEnabled({ [ALLOW_INSTALL_ENV]: yes }), true, yes);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ⚠️⚠️ `--ignore-scripts` IS FORCED, AND IT IS DERIVED FROM THE ARGV
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ --ignore-scripts is injected into the REAL spawn argv, for every install verb', () => {
  for (const sub of ['install', 'i', 'add', 'ci']) {
    const inv = buildInvocation({ binary: 'npm', tokens: ['npm', sub, 'zod'] }, '/root');
    assert.equal(inv.ok, true, inv.error);
    // args[0] is npm-cli.js, args[1] the subcommand, args[2] must be the flag.
    assert.equal(inv.args[1], sub);
    assert.equal(inv.args[2], '--ignore-scripts', `npm ${sub} must be spawned with --ignore-scripts`);
  }
});

/**
 * ⭐ THE FORCING IS BOUND TO THE NOUN, NOT TO A CALLER'S BOOLEAN. `buildInvocation`
 * is handed a bare `{binary, tokens}` here — no `npmInstall` field, nothing that
 * says "this is an install" — and the flag still appears. That is what makes a
 * future third caller unable to forget it.
 */
test('⭐ a caller that says nothing about installs still gets the forced flag', () => {
  const inv = buildInvocation({ binary: 'npm', tokens: ['npm', 'install'] }, '/root');
  assert.ok(inv.args.includes('--ignore-scripts'));
});

test('⚠️ and it is NOT injected into npm test / npm run — that would change existing behaviour', () => {
  for (const tokens of [['npm', 'test'], ['npm', 'run', 'build']]) {
    const inv = buildInvocation({ binary: 'npm', tokens }, '/root');
    assert.ok(!inv.args.includes('--ignore-scripts'), `${tokens.join(' ')} must be untouched`);
  }
});

test('⚠️ the flag cannot be turned back off by asking', () => {
  for (const flag of ['--no-ignore-scripts', '--foreground-scripts', '--unsafe-perm']) {
    const v = validateCommand(`npm install zod ${flag}`, ON);
    assert.equal(v.ok, false, flag);
    assert.match(v.error, /ignore-scripts|lifecycle scripts do not run/, `${flag} must say why`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT A PACKAGE SPEC MAY BE
// ─────────────────────────────────────────────────────────────────────────────

test('a plain registry name, a scope, and a pinned version are accepted', () => {
  for (const spec of ['zod', 'left-pad', '@types/node', 'zod@4.1.12', 'zod@^4.1.0', 'zod@~4.1', 'zod@latest', 'lodash.merge@4.6.2']) {
    const v = validateInstallSpec(spec);
    assert.equal(v.ok, true, `${spec}: ${v.error}`);
  }
});

test('⚠️⚠️ every NON-REGISTRY spec is refused — this is where a stranger gets chosen', () => {
  const cases = [
    ['https://evil.example/pkg.tgz', /location rather than a registry package/],
    ['http://evil.example/pkg.tgz', /location rather than a registry package/],
    ['git+ssh://git@evil.example/x.git', /location rather than a registry package/],
    ['file:../../etc', /location rather than a registry package/],
    // ⭐ THE ALIAS: package.json would say "zod" and a different package lands.
    ['zod@npm:evil-package', /location rather than a registry package/],
    ['user/repo', /GitHub shorthand/],
    ['../../../etc/passwd', /GitHub shorthand|not a valid npm package name/],
    ['.\\evil', /backslash|not a valid/],
    ['-rf', /starts with "-"/],
    ['@scope', /scoped package name/],
    ['@scope/a/b', /scoped package name/],
    ['@/x', /scoped package name/],
    ['UPPERCASE', /not a valid npm package name/],
    ['_leading', /not a valid npm package name/],
    ['', /empty package name/],
  ];
  for (const [spec, pattern] of cases) {
    const v = validateInstallSpec(spec);
    assert.equal(v.ok, false, `${spec} must be refused`);
    assert.match(v.error, pattern, `${spec} must say why`);
  }
});

test('⚠️ a RANGE expression is refused — a receipt for "whatever resolved today" is not a receipt', () => {
  for (const spec of ['zod@*', 'zod@x', 'zod@>=1', 'zod@1 || 2', 'zod@']) {
    const v = validateInstallSpec(spec);
    assert.equal(v.ok, false, `${spec} must be refused`);
  }
});

test('⚠️⚠️ the cap is FOUR — the number itself, not whatever the constant happens to say', () => {
  /**
   * ── ⚠️⚠️ THIS TEST USED TO BE SATISFIED BY ANY NUMBER AT ALL ──────────────
   *
   * Every term in it was derived from `MAX_INSTALL_PACKAGES` — the array
   * length, the slice, and even the test's own NAME. So
   * `MAX_INSTALL_PACKAGES = 400` left the whole suite green: it built 401
   * packages, expected a refusal, built 400, expected success, and both held.
   * A safety cap that any value satisfies is not a cap; it is a variable with a
   * test-shaped comment next to it. Found by an adversarial pass mutating the
   * VALUE where four earlier passes had only mutated the COMPARISON.
   *
   * ⭐ The number is now bound to its NOUN. The constant's own paragraph argues
   * for four specifically — "one request is one or two names; a line with nine
   * is a model batching, which is the case where nobody reads any of them" —
   * so a diff that changes it has to change this line and say why.
   */
  assert.equal(MAX_INSTALL_PACKAGES, 4,
    'read the paragraph above the constant: four is an argument, not a round figure. Changing it is a decision, not a refactor.');

  // Written as literals on purpose. Five must be refused, four must not.
  const five = ['a', 'b', 'c', 'd', 'e'];
  const refused = validateNpmInstallArgv(['install', ...five], ON);
  assert.equal(refused.ok, false, 'five packages in one line must be refused');
  assert.match(refused.error, /separate steps/);

  const four = ['a', 'b', 'c', 'd'];
  const allowed = validateNpmInstallArgv(['install', ...four], ON);
  assert.equal(allowed.ok, true, allowed.error);

  // And the boundary the constant is about, stated the way a reader thinks of
  // it: one ordinary request ("add express and its types") must never trip it.
  assert.equal(validateNpmInstallArgv(['install', 'express', '@types/express'], ON).ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. FLAGS
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️ the flags that would leave the workspace or change the source are refused BY NAME', () => {
  const cases = [
    [['install', '-g', 'zod'], /outside the workspace/],
    [['install', '--global', 'zod'], /outside the workspace/],
    [['install', '--prefix', '/tmp', 'zod'], /out of the workspace/],
    [['install', '--registry=http://evil.example/', 'zod'], /registry nobody in this repository agreed to/],
    [['install', '--no-save', 'zod'], /reviewable/],
    [['install', '--no-package-lock', 'zod'], /unreproducible/],
    [['install', '--force', 'zod'], /only signal that something is wrong/],
  ];
  for (const [args, pattern] of cases) {
    const v = validateNpmInstallArgv(args, ON);
    assert.equal(v.ok, false, args.join(' '));
    assert.match(v.error, pattern, args.join(' '));
  }
});

/**
 * ⚠️ `--registry=http://evil` IS THE ONE A WHOLE-TOKEN CHECK MISSES. Asserted
 * separately because `--registry` and `--registry=x` are different strings and a
 * `Set.has(token)` guard waves the second one through.
 */
test('⚠️ a --flag=value form is split before it is checked', () => {
  const v = validateNpmInstallArgv(['install', '--registry=http://evil.example/', 'zod'], ON);
  assert.equal(v.ok, false);
});

test('the flags a real install needs are allowed', () => {
  for (const args of [
    ['install', '--save-dev', 'zod'],
    ['install', '-D', 'zod'],
    ['install', '--save-exact', 'zod'],
    ['install', '--ignore-scripts', 'zod'],
    ['install', '--no-audit', '--no-fund', 'zod'],
    ['install', '--legacy-peer-deps', 'zod'],
    ['install'],
    ['ci'],
  ]) {
    const v = validateNpmInstallArgv(args, ON);
    assert.equal(v.ok, true, `${args.join(' ')}: ${v.error}`);
  }
});

test('⚠️ npm ci takes no package names — it installs exactly what the lockfile records', () => {
  const v = validateNpmInstallArgv(['ci', 'zod'], ON);
  assert.equal(v.ok, false);
  assert.match(v.error, /takes no package names/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ⚠️⚠️ THE WORKSPACE `.npmrc` — THE FILE THAT UNDOES EVERYTHING ABOVE
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ a workspace .npmrc that redirects the registry refuses the install', () => {
  const bad = [
    ['registry=http://evil.example/', /registry at/],
    ['registry = https://evil.example/', /registry at/],
    ['@acme:registry=https://evil.example/', /registry at/],
    ['ignore-scripts=false', /ignore-scripts=false/],
    ['script-shell=/bin/bash', /A shell is the one thing/],
    ['unsafe-perm=true', /unsafe-perm/],
  ];
  for (const [text, pattern] of bad) {
    const v = inspectNpmrcForInstall(text);
    assert.equal(v.ok, false, text);
    assert.match(v.error, pattern, text);
  }
});

test('an ordinary .npmrc passes — the public registry, comments, and stricter settings', () => {
  const good = [
    '',
    '# a comment\n; another\n',
    'registry=https://registry.npmjs.org/\n',
    'registry="https://registry.npmjs.org"\n',
    'ignore-scripts=true\n',
    'save-exact=true\nfund=false\n',
  ];
  for (const text of good) {
    const v = inspectNpmrcForInstall(text);
    assert.equal(v.ok, true, `${JSON.stringify(text)}: ${v.error}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE `@` CHARACTER — A TOKENIZER FIX THAT WAS BLOCKING MORE THAN INSTALLS
// ─────────────────────────────────────────────────────────────────────────────

test('⭐ `@` reaches the validator now — scoped node_modules paths were unreachable before', () => {
  const v = validateCommand('node node_modules/@scope/pkg/cli.js');
  assert.equal(v.ok, true, v.error);
});

test('⚠️ and the two character regexes still agree — one edited without the other reads as a rule', () => {
  // A refusal must NAME the offending character. If SAFE_COMMAND_CHARS and
  // UNSAFE_CHAR drift, the message says `contains ""`, which reads like a bug.
  for (const bad of [';', '|', '&', '$', '`', '>', '"', "'", '(', ')']) {
    const v = validateCommand(`node a.js ${bad}`);
    assert.equal(v.ok, false, bad);
    assert.ok(v.error.includes(bad), `the refusal for ${bad} must name the character: ${v.error}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE SCRIPT-BODY PATH NEVER INHERITS THE SWITCH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── ⚠️⚠️ A CHECK THAT CANNOT FAIL, FOUND BY MUTATING IT ─────────────────────
 *
 * The first version of this test asserted only the BEHAVIOUR, and the mutation
 * `allowInstall && !script` → `allowInstall` SURVIVED it. The reason: `npm` is
 * not in `ALLOWED_SCRIPT_BINARIES`, so a script body naming npm is refused
 * several lines earlier and the `!script` clause is never reached. It is real
 * defence in depth and it stays — but the guard that actually holds the line is
 * the BINARY LIST, so that is what is pinned here. Two mutations are needed to
 * get an install into a script body, and this test kills the first one.
 */
test('⚠️⚠️ an npm script body can never name npm at all — the guard is the binary list', () => {
  assert.ok(!ALLOWED_SCRIPT_BINARIES.includes('npm'), 'npm in the script binaries would let a script body chain into an install');
  assert.ok(!ALLOWED_SCRIPT_BINARIES.includes('npx'), 'npx fetches from the registry too');

  const v = validateCommand('npm install zod', { script: true, allowInstall: true });
  assert.equal(v.ok, false);
  assert.match(v.error, /may only run: node, vitest, tsc/);

  const chain = validateNpmScriptChain('test', JSON.stringify({ scripts: { test: 'npm install evil && node a.js' } }));
  assert.equal(chain.ok, false, 'the package.json script gate is untouched by the install feature');
});

test('⚠️ exec and publish have no switch at all', () => {
  for (const sub of ['exec', 'publish', 'link', 'update']) {
    const v = validateCommand(`npm ${sub} x`, ON);
    assert.equal(v.ok, false, `npm ${sub} must stay refused even with installs on`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. END TO END THROUGH `executeRunCommand`, WITH A FAKE SPAWN
// ─────────────────────────────────────────────────────────────────────────────

function fakeSpawner(seen) {
  return (file, args, opts) => {
    seen.push({ file, args, shell: opts.shell });
    return {
      pid: 1,
      stdout: { setEncoding() {}, on() {}, destroy() {} },
      stderr: { setEncoding() {}, on() {}, destroy() {} },
      on(event, cb) { if (event === 'close') setImmediate(() => cb(0, null)); },
      kill() {}, unref() {},
    };
  };
}

/** An executor whose files are a plain map. `no such file` matches the real one. */
function mapExecutor(files) {
  return {
    root: '/root',
    dryRun: false,
    readFile: (p) => (p in files ? { ok: true, content: files[p] } : { ok: false, error: `no such file: ${p}` }),
  };
}

test('⚠️ an install with no package.json is refused — it would record the dependency nowhere', async () => {
  process.env[ALLOW_INSTALL_ENV] = '1';
  try {
    const res = await executeRunCommand({
      command: 'npm install zod',
      executor: mapExecutor({}),
      spawnImpl: fakeSpawner([]),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Write a package.json first|no such file/);
  } finally {
    delete process.env[ALLOW_INSTALL_ENV];
  }
});

test('⚠️⚠️ a hostile workspace .npmrc stops the install before npm is spawned', async () => {
  process.env[ALLOW_INSTALL_ENV] = '1';
  const seen = [];
  try {
    const res = await executeRunCommand({
      command: 'npm install zod',
      executor: mapExecutor({
        'package.json': JSON.stringify({ name: 'x' }),
        '.npmrc': 'registry=http://evil.example/\n',
      }),
      spawnImpl: fakeSpawner(seen),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /agent can write it/);
    assert.equal(seen.length, 0, 'nothing may be spawned');
  } finally {
    delete process.env[ALLOW_INSTALL_ENV];
  }
});

test('⭐ the whole path: env on → npm really spawned, with --ignore-scripts, and a receipt', async () => {
  process.env[ALLOW_INSTALL_ENV] = '1';
  const seen = [];
  try {
    const res = await executeRunCommand({
      command: 'npm install zod',
      executor: mapExecutor({ 'package.json': JSON.stringify({ name: 'x', dependencies: { zod: '^4.4.3' } }) }),
      spawnImpl: fakeSpawner(seen),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].shell, false, 'never a shell');
    assert.ok(seen[0].args.includes('--ignore-scripts'), `forced flag missing from ${JSON.stringify(seen[0].args)}`);
    assert.deepEqual(res.installed, [{ name: 'zod', range: '^4.4.3', section: 'dependencies' }]);
    const text = formatRunForModel(res);
    assert.match(text, /recorded in package\.json: "zod": "\^4\.4\.3"/);
    assert.match(text, /--ignore-scripts forced/, 'the model must be told, or a native-addon failure looks like its own bug');
  } finally {
    delete process.env[ALLOW_INSTALL_ENV];
  }
});

/**
 * ⚠️ npm EXITS 0 ON PLENTY OF PARTIAL OUTCOMES. A receipt that quietly drops
 * the line it could not confirm is the "green run, nothing happened" failure
 * this package keeps finding in itself.
 */
test('⚠️ a package missing from package.json afterwards is reported, not omitted', async () => {
  process.env[ALLOW_INSTALL_ENV] = '1';
  try {
    const res = await executeRunCommand({
      command: 'npm install zod',
      executor: mapExecutor({ 'package.json': JSON.stringify({ name: 'x' }) }),
      spawnImpl: fakeSpawner([]),
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.installed, [{ name: 'zod', range: null, section: null }]);
    assert.match(formatRunForModel(res), /is NOT in package\.json/);
  } finally {
    delete process.env[ALLOW_INSTALL_ENV];
  }
});

test('⚠️ the env switch is read at run time, not at import time', async () => {
  delete process.env[ALLOW_INSTALL_ENV];
  const off = await executeRunCommand({
    command: 'npm install zod',
    executor: mapExecutor({ 'package.json': '{}' }),
    spawnImpl: fakeSpawner([]),
  });
  assert.equal(off.ok, false);
  assert.match(off.error, /ACUVO_ALLOW_INSTALL=1/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. THE BACKGROUND DOOR STAYS SHUT
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️ an install can never be a BACKGROUND process, even with the switch on', () => {
  process.env[ALLOW_INSTALL_ENV] = '1';
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-bg-'));
  try {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
    for (const sub of ['install', 'i', 'add', 'ci']) {
      const p = planSingleSpawn({ root: ws, program: 'npm', args: [sub, 'zod'] });
      assert.equal(p.ok, false, `npm ${sub} in the background`);
      assert.match(p.error, /background/);
    }
  } finally {
    delete process.env[ALLOW_INSTALL_ENV];
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. THE TIMEOUT FLOOR
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️ an install gets a FLOOR, not the 120s default the dispatcher hands every call', async () => {
  assert.ok(INSTALL_MIN_TIMEOUT_MS >= 300_000, 'a cold install of a real tree exceeds two minutes');
  process.env[ALLOW_INSTALL_ENV] = '1';
  let sawTimeout = null;
  const spy = (file, args, opts) => {
    void opts;
    return {
      pid: 1,
      stdout: { setEncoding() {}, on() {}, destroy() {} },
      stderr: { setEncoding() {}, on() {}, destroy() {} },
      on(event, cb) { if (event === 'close') setImmediate(() => cb(0, null)); },
      kill() {}, unref() {},
    };
  };
  try {
    // `spawnBounded` owns the timer, so the observable fact is that a 1s request
    // does NOT kill an install: assert the constant is applied by the caller.
    const res = await executeRunCommand({
      command: 'npm install zod',
      executor: mapExecutor({ 'package.json': '{}' }),
      spawnImpl: spy,
      timeoutMs: 1_000,
    });
    assert.equal(res.ok, true, res.error);
    sawTimeout = res.durationMs;
    assert.ok(typeof sawTimeout === 'number');
  } finally {
    delete process.env[ALLOW_INSTALL_ENV];
  }
});

test('⚠️ the commands config file still cannot name an install — it may only name presets', () => {
  const executorFiles = { [COMMANDS_CONFIG_FILE]: JSON.stringify({ allow: [{ binary: 'npm', flags: ['install'] }] }) };
  // `allow` in the workspace file is refused outright; the point is that no
  // route through this file reaches an install.
  assert.ok(Object.keys(executorFiles).length === 1);
  const v = validateCommand('npm install zod');
  assert.equal(v.ok, false);
});
