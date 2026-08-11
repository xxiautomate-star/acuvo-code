/**
 * ── ⭐⭐ THE CLI COULD NOT RUN A TEST IN MOST OF THE WORLD'S REPOS ───────────
 *
 * `ALLOWED_BINARIES` was four names. A Python, Go, Rust or Ruby repo could be
 * WRITTEN to and never CHECKED — the run→fix loop, which is the product, was
 * simply unavailable. ENTERPRISE.md §5.1 says so in the vendor's own words.
 *
 * This file pins the fix in three directions at once, and the third is the one
 * that matters most:
 *
 *   1. A configured repo can run its own test command.
 *   2. ⚠️ AN UNCONFIGURED REPO IS BYTE-FOR-BYTE UNCHANGED. The default surface
 *      does not grow by one binary. Every "the allowlist got wider" bug is a
 *      silent one, so it is asserted rather than trusted.
 *   3. ⚠️ EVERY NEW BINARY GOES THROUGH THE SAME GATE. No shell, no
 *      metacharacters, no path escape, no credentials — asserted per-binary,
 *      not per-file, because a guard that only covers the four it was written
 *      for is a guard that expires the moment someone adds a fifth.
 *
 * ── ⚠️ AND THE ENVIRONMENT HOLE THAT WAS OPEN THE WHOLE TIME ────────────────
 * `command.mjs` refuses `--require`, `--import` and `--loader` by name on the
 * command line, and then handed the child a `NODE_OPTIONS` that could carry
 * exactly those flags. Same class, same file, one env var. Closed here, and
 * tested in BOTH directions — `--max-old-space-size` is legitimate work and
 * must survive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALLOWED_BINARIES,
  COMMAND_PRESETS,
  PRESET_NAMES,
  COMMANDS_CONFIG_FILE,
  ALLOW_COMMANDS_ENV,
  DEFAULT_ALLOWLIST,
  parseCommandsConfig,
  parseAllowCommandsEnv,
  resolveCommandAllowlist,
  validateCommand,
  buildInvocation,
  scrubEnvironment,
  executeRunCommand,
} from '../lib/command.mjs';

/** Build an allowlist from preset names, the way a config file would. */
const withPresets = (...names) => {
  const r = resolveCommandAllowlist({ configText: JSON.stringify({ presets: names }) });
  assert.ok(r.ok, r.error);
  return r.allowlist;
};

// ── 1. the default surface does not move ───────────────────────────────────

test('⚠️ DEFAULT POSTURE IS UNCHANGED — the four, and only the four', () => {
  assert.deepEqual(ALLOWED_BINARIES, ['node', 'npm', 'npx', 'tsc']);
  assert.deepEqual([...DEFAULT_ALLOWLIST.binaries].sort(), ['node', 'npm', 'npx', 'tsc']);
});

test('⚠️ with NO config and NO env, every preset binary is still refused', () => {
  const r = resolveCommandAllowlist({ configText: null, envValue: undefined });
  assert.ok(r.ok);
  assert.deepEqual([...r.allowlist.binaries].sort(), ['node', 'npm', 'npx', 'tsc']);
  for (const cmd of ['python -V', 'pytest -q', 'go test ./...', 'cargo test', 'make', 'rspec', 'eslint .']) {
    const v = validateCommand(cmd, { allowlist: r.allowlist });
    assert.equal(v.ok, false, `${cmd} must stay refused with no config`);
  }
});

test('⭐ the refusal NAMES THE WAY OUT — a model gets another round, so tell it', () => {
  const v = validateCommand('pytest -q');
  assert.equal(v.ok, false);
  assert.match(v.error, /\.acuvo\/commands\.json/);
  assert.match(v.error, /python/);
});

// ── 2. a configured repo can run its own tests ─────────────────────────────

test('⭐ the python preset makes pytest and python runnable', () => {
  const allowlist = withPresets('python');
  for (const cmd of ['pytest', 'pytest -q', 'pytest -q tests/test_a.py', 'python -m pytest', 'python src/main.py', 'python3 -V']) {
    const v = validateCommand(cmd, { allowlist });
    assert.equal(v.ok, true, `${cmd} should be allowed: ${v.error}`);
  }
});

test('⭐ go, rust, ruby and make presets each unlock their own test command', () => {
  const cases = [
    ['go', 'go test ./...'],
    ['go', 'go build ./...'],
    ['go', 'go vet ./...'],
    ['rust', 'cargo test'],
    ['rust', 'cargo build --release'],
    ['ruby', 'rspec'],
    ['ruby', 'ruby test/run.rb'],
    ['ruby', 'bundle exec rspec'],
    ['make', 'make test'],
  ];
  for (const [preset, cmd] of cases) {
    const v = validateCommand(cmd, { allowlist: withPresets(preset) });
    assert.equal(v.ok, true, `${preset}: ${cmd} should be allowed: ${v.error}`);
  }
});

test('⚠️ `go test ./...` — the package pattern is a PATTERN, not a path, and `../...` still dies', () => {
  const allowlist = withPresets('go');
  assert.equal(validateCommand('go test ./...', { allowlist }).ok, true);
  assert.equal(validateCommand('go test ./pkg/...', { allowlist }).ok, true);
  const escape = validateCommand('go test ../.../x', { allowlist });
  assert.equal(escape.ok, false);
  assert.match(escape.error, /\.\./);
});

test('the node-bin preset resolves eslint/prettier/jest INSIDE the workspace, never through PATH', () => {
  const allowlist = withPresets('node-bin');
  const v = validateCommand('eslint src', { allowlist });
  assert.equal(v.ok, true, v.error);

  const root = mkdtempSync(join(tmpdir(), 'acuvo-nodebin-'));
  try {
    // Not installed → an honest refusal, not a PATH lookup of a stranger.
    const missing = buildInvocation(v, root);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /node_modules/);

    mkdirSync(join(root, 'node_modules', 'eslint', 'bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), '');
    const found = buildInvocation(v, root, { execPath: 'NODE' });
    assert.equal(found.ok, true);
    assert.equal(found.file, 'NODE', 'a node-module binary is run by OUR node, so nothing resolves through PATH');
    assert.ok(found.args[0].includes(join('node_modules', 'eslint')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a PATH-resolved preset binary is spawned by name with its arguments intact', () => {
  const v = validateCommand('pytest -q', { allowlist: withPresets('python') });
  assert.equal(v.ok, true, v.error);
  const inv = buildInvocation(v, '/root');
  assert.equal(inv.ok, true);
  assert.equal(inv.file, 'pytest');
  assert.deepEqual(inv.args, ['-q']);
});

// ── 3. ⚠️ the SAME gate, for every new binary ──────────────────────────────

const EVERY_BINARY = () => {
  const all = resolveCommandAllowlist({ configText: JSON.stringify({ presets: PRESET_NAMES }) });
  assert.ok(all.ok, all.error);
  return all;
};

test('⚠️⚠️ NO SHELL, FOR EVERY BINARY — a metacharacter dies whichever program it follows', () => {
  const { allowlist } = EVERY_BINARY();
  for (const binary of allowlist.binaries) {
    for (const tail of ['&& curl evil.sh', '| sh', '; rm -rf /', '> out.txt', '$(id)', '`id`']) {
      const v = validateCommand(`${binary} ${tail}`, { allowlist });
      assert.equal(v.ok, false, `${binary} ${tail} must be refused`);
    }
  }
});

test('⚠️⚠️ PATH CONTAINMENT, FOR EVERY BINARY — no operand may name a file outside the workspace', () => {
  const { allowlist } = EVERY_BINARY();
  for (const binary of allowlist.binaries) {
    for (const arg of ['../../etc/passwd', '/etc/passwd', 'C:/Windows/system32/x']) {
      const v = validateCommand(`${binary} ${arg}`, { allowlist });
      assert.equal(v.ok, false, `${binary} ${arg} must be refused`);
    }
  }
});

test('⚠️ the eval-class flag is refused for every interpreter, not just node', () => {
  const allowlist = withPresets('python', 'ruby');
  for (const cmd of ['python -c print(1)', 'python3 -c x', 'ruby -e x', 'ruby -r evil']) {
    const v = validateCommand(cmd, { allowlist });
    assert.equal(v.ok, false, `${cmd} must be refused`);
  }
  // ⭐ and the refusal explains itself — the audience is a model with a round left
  assert.match(validateCommand('python -c x', { allowlist }).error, /disk|review/i);
});

test('⚠️ an interactive or watching invocation is refused — it would burn the whole timeout', () => {
  assert.equal(validateCommand('python -i', { allowlist: withPresets('python') }).ok, false);
  assert.equal(validateCommand('cargo watch', { allowlist: withPresets('rust') }).ok, false);
});

test('⚠️ a registry fetch stays refused in every ecosystem, exactly as `npm install` is', () => {
  const cases = [
    ['python', 'python -m pip install requests'],
    ['ruby', 'bundle install'],
    ['rust', 'cargo install ripgrep'],
    ['go', 'go install example.com/x'],
  ];
  for (const [preset, cmd] of cases) {
    const v = validateCommand(cmd, { allowlist: withPresets(preset) });
    assert.equal(v.ok, false, `${cmd} must be refused`);
  }
});

/**
 * ── ⚠️⚠️ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED ───────────────────────
 *
 * Nine deliberate breakages were applied to the fix; eight turned this file red
 * and one did not. `bundle exec` re-checks the program it is handed, and nothing
 * here noticed when that check was replaced with `if (false)`. A guard no test
 * pins is a guard that will be deleted by the next refactor and nobody will
 * know — which is the same "green suite, broken product" failure this package
 * has been bitten by before.
 *
 * ⭐ The shape being pinned is the `npm test` bypass arriving through a second
 * door: one allowed binary that launches another launders every program on the
 * machine. `bundle exec curl` must die, and so must `bundle exec node`, because
 * routing node through the delegate would skip `validateNode` and with it the
 * `--eval` refusal.
 */
test('⚠️⚠️ `bundle exec` CANNOT LAUNDER A PROGRAM — the delegate goes back through the allowlist', () => {
  const allowlist = withPresets('ruby');
  assert.equal(validateCommand('bundle exec rspec', { allowlist }).ok, true);

  for (const inner of ['curl', 'rm', 'python', 'make']) {
    const v = validateCommand(`bundle exec ${inner}`, { allowlist });
    assert.equal(v.ok, false, `bundle exec ${inner} must be refused`);
    assert.match(v.error, /not itself on the allowlist|delegat/i);
  }

  // ⚠️ And a BUILT-IN is refused too: `bundle exec node --eval x` would reach
  // node without ever passing validateNode, which is where --eval is refused.
  const builtin = validateCommand('bundle exec node --eval x', { allowlist });
  assert.equal(builtin.ok, false);

  // `bundle exec` with nothing after it is a refusal, not a crash.
  assert.equal(validateCommand('bundle exec', { allowlist }).ok, false);
});

test('⚠️ `make -C ..` cannot move the working directory out of the workspace', () => {
  const allowlist = withPresets('make');
  assert.equal(validateCommand('make -C /tmp', { allowlist }).ok, false);
  assert.equal(validateCommand('make -C ../..', { allowlist }).ok, false);
});

// ── 4. who may grant what ──────────────────────────────────────────────────

test('⚠️⚠️ THE WORKSPACE FILE MAY ONLY PICK FROM THE MENU — the agent can write it', () => {
  const hostile = parseCommandsConfig(JSON.stringify({ allow: [{ binary: 'curl' }] }), { admin: false });
  assert.equal(hostile.ok, false);
  assert.match(hostile.error, new RegExp(ALLOW_COMMANDS_ENV));
});

test('the admin env var may name a binary the presets do not cover', () => {
  const r = resolveCommandAllowlist({ envValue: 'ruff:check|--fix' });
  assert.ok(r.ok, r.error);
  assert.ok(r.allowlist.binaries.includes('ruff'));
  assert.equal(validateCommand('ruff check src', { allowlist: r.allowlist }).ok, true);
  assert.equal(validateCommand('ruff --fix src', { allowlist: r.allowlist }).ok, true);
  // A flag the admin did not declare is not guessed at.
  assert.equal(validateCommand('ruff --exec x', { allowlist: r.allowlist }).ok, false);
});

test('⚠️ a bare custom binary gets NO flags — we do not know a stranger binary\'s grammar', () => {
  const r = resolveCommandAllowlist({ envValue: 'ruff' });
  assert.ok(r.ok);
  assert.equal(validateCommand('ruff src', { allowlist: r.allowlist }).ok, true);
  const flagged = validateCommand('ruff -q src', { allowlist: r.allowlist });
  assert.equal(flagged.ok, false);
  assert.match(flagged.error, new RegExp(ALLOW_COMMANDS_ENV));
});

test('⚠️⚠️ A SHELL IS REFUSED EVEN TO THE ADMIN — every guard here assumes there is none', () => {
  for (const sh of ['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']) {
    const r = resolveCommandAllowlist({ envValue: sh });
    assert.equal(r.ok, false, `${sh} must be refused`);
    assert.match(r.error, /shell/i);
  }
});

test('⚠️ FAIL CLOSED — a malformed commands.json stops the command, it does not vanish', () => {
  const broken = resolveCommandAllowlist({ configText: '{ "presets": ["python", }' });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /JSON/i);

  const typo = resolveCommandAllowlist({ configText: JSON.stringify({ preset: ['python'] }) });
  assert.equal(typo.ok, false, 'a misspelled key that silently enables nothing is the dangerous kind');

  const unknown = resolveCommandAllowlist({ configText: JSON.stringify({ presets: ['pythn'] }) });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /python/, 'name the near miss');
});

test('⚠️ ABSENT IS NOT MALFORMED — no file means the default four, and no error', () => {
  const r = resolveCommandAllowlist({ configText: null });
  assert.ok(r.ok);
  assert.deepEqual(r.sources, []);
});

// ── 5. ⚠️ real-repo shapes: a guard must not fail correct work ─────────────

test('⚠️ a commands.json with a BOM, CRLF, tabs, no trailing newline still parses', () => {
  const body = '{\r\n\t"presets": ["python"]\r\n}';
  for (const text of [body, `\uFEFF${body}`, `${body}\n`, `\uFEFF${body}\r\n`, `  ${body}  `]) {
    const r = resolveCommandAllowlist({ configText: text });
    assert.ok(r.ok, `should parse: ${JSON.stringify(text)} — ${r.error}`);
    assert.ok(r.allowlist.binaries.includes('pytest'));
  }
});

test('⚠️ an EMPTY commands.json is a mistake with two readings, so neither is guessed', () => {
  const r = resolveCommandAllowlist({ configText: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/i);
});

test('⚠️ `{}` is a legal no-op — a user who wrote the file and enabled nothing gets the four', () => {
  const r = resolveCommandAllowlist({ configText: '{}' });
  assert.ok(r.ok, r.error);
  assert.deepEqual([...r.allowlist.binaries].sort(), ['node', 'npm', 'npx', 'tsc']);
});

test('⚠️ deep paths, dots, dashes and underscores in real operands are accepted', () => {
  const allowlist = withPresets('python');
  for (const cmd of [
    'pytest a/b/c/d/e/test_x.py',
    'pytest tests/test_a.py tests/test_b.py',
    'pytest src/my-pkg/test_thing.py',
    'pytest tests/test_*.py',
    'python src/main.py',
  ]) {
    assert.equal(validateCommand(cmd, { allowlist }).ok, true, `${cmd} — ${validateCommand(cmd, { allowlist }).error}`);
  }
});

/**
 * ⚠️⚠️ A LIMIT THIS LANE FOUND AND DID **NOT** FIX, PINNED SO IT CANNOT BE
 * MISTAKEN FOR SUPPORT.
 *
 * `SAFE_COMMAND_CHARS` is ASCII-only, so `pytest tests/café/test_x.py` is
 * refused — in EVERY ecosystem, including the four that already existed. That is
 * pre-existing behaviour of the tokeniser, not something the presets introduced,
 * and it is genuinely "a check that fails correct work": a repository with an
 * accented directory name cannot run its own tests.
 *
 * It is not fixed here on purpose. Widening the character whitelist touches
 * promise (1) — "the agent cannot compose a command" — and doing it safely means
 * deciding about bidi overrides, zero-width joiners and homoglyphs, which is a
 * deliberate decision with its own test surface and not a side effect of adding
 * Python support. Asserted as-is so the next person sees a documented limit
 * rather than discovering it in a refusal message.
 */
test('⚠️ KNOWN LIMIT — a non-ASCII operand is refused by the tokeniser, in every ecosystem', () => {
  const allowlist = withPresets('python');
  const v = validateCommand('pytest tests/café/test_x.py', { allowlist });
  assert.equal(v.ok, false);
  assert.match(v.error, /not allowed in a command/);
  // …and identically for a binary that was allowed long before this lane existed.
  assert.equal(validateCommand('node src/café.js').ok, false);
});

test('the two layers UNION, and the config plus env can be used together', () => {
  const r = resolveCommandAllowlist({
    configText: JSON.stringify({ presets: ['python'] }),
    envValue: 'go,ruff:check',
  });
  assert.ok(r.ok, r.error);
  for (const b of ['pytest', 'go', 'ruff', 'node']) assert.ok(r.allowlist.binaries.includes(b), `${b} missing`);
  assert.equal(r.sources.length, 2);
});

// ── 6. ⚠️ credentials, for a NEW binary ────────────────────────────────────

test('⚠️⚠️ OPENROUTER_API_KEY REACHES NO CHILD — asserted through the pytest path, not just node', async () => {
  const seen = [];
  const fakeSpawn = (file, args, opts) => {
    seen.push({ file, args, env: opts.env, shell: opts.shell });
    return {
      pid: 1234,
      stdout: { setEncoding() {}, on() {}, destroy() {} },
      stderr: { setEncoding() {}, on() {}, destroy() {} },
      on(event, cb) { if (event === 'close') setImmediate(() => cb(0, null)); },
      kill() {},
      unref() {},
    };
  };
  const executor = {
    root: '/root',
    dryRun: false,
    readFile: (p) => (p === COMMANDS_CONFIG_FILE
      ? { ok: true, content: JSON.stringify({ presets: ['python'] }) }
      : { ok: false, error: `no such file: ${p}` }),
  };
  const before = { ...process.env };
  process.env.OPENROUTER_API_KEY = 'sk-should-never-leave';
  process.env.MY_DEPLOY_TOKEN = 'nope';
  try {
    const res = await executeRunCommand({ command: 'pytest -q', executor, spawnImpl: fakeSpawn });
    assert.equal(res.ok, true, res.error);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].file, 'pytest');
    assert.equal(seen[0].shell, false);
    assert.equal(seen[0].env.OPENROUTER_API_KEY, undefined);
    assert.equal(seen[0].env.MY_DEPLOY_TOKEN, undefined);
    assert.equal(seen[0].env.CI, '1');
  } finally {
    delete process.env.MY_DEPLOY_TOKEN;
    if (before.OPENROUTER_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = before.OPENROUTER_API_KEY;
  }
});

// ── 7. ⚠️ NODE_OPTIONS — the same hole, one layer down ─────────────────────

test('⚠️⚠️ NODE_OPTIONS CANNOT SMUGGLE --require/--import/--loader PAST THE FLAG CHECK', () => {
  for (const value of [
    '--require ./evil.js',
    '--require=./evil.js',
    '--import ./evil.mjs',
    '--loader ./evil.mjs',
    '--experimental-loader=./evil.mjs',
    '--env-file .env',
    '-r ./evil.js',
    '--inspect-brk',
  ]) {
    const out = scrubEnvironment({ PATH: '/usr/bin', NODE_OPTIONS: value });
    assert.ok(
      !out.NODE_OPTIONS || !/require|import|loader|env-file|inspect/.test(out.NODE_OPTIONS),
      `NODE_OPTIONS=${value} survived as ${JSON.stringify(out.NODE_OPTIONS)}`,
    );
  }
});

test('⚠️ …AND LEGITIMATE NODE_OPTIONS SURVIVES — a check that fails correct work is worse than none', () => {
  const out = scrubEnvironment({ PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=4096 --no-warnings' });
  assert.equal(out.NODE_OPTIONS, '--max-old-space-size=4096 --no-warnings');
});

test('⚠️ a MIXED NODE_OPTIONS keeps the safe half and drops the injection', () => {
  const out = scrubEnvironment({ NODE_OPTIONS: '--max-old-space-size=4096 --require ./evil.js --no-warnings' });
  assert.equal(out.NODE_OPTIONS, '--max-old-space-size=4096 --no-warnings');
});

test('⚠️ an unparseable NODE_OPTIONS (quotes) is dropped whole rather than half-understood', () => {
  const out = scrubEnvironment({ NODE_OPTIONS: '--require "a b.js"' });
  assert.equal(out.NODE_OPTIONS, undefined);
});

test('⚠️ the other runtimes have the same hole and it is closed for them too', () => {
  const out = scrubEnvironment({
    PATH: '/usr/bin',
    RUBYOPT: '-r./evil',
    PERL5OPT: '-Mevil',
    PYTHONSTARTUP: '/tmp/evil.py',
    LD_PRELOAD: '/tmp/evil.so',
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
  });
  for (const name of ['RUBYOPT', 'PERL5OPT', 'PYTHONSTARTUP', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) {
    assert.equal(out[name], undefined, `${name} must not reach a child`);
  }
  assert.equal(out.PATH, '/usr/bin', 'PATH is how a preset binary is found — it must survive');
});

test('⚠️ ordinary environment is untouched — the scrub is not a purge', () => {
  const out = scrubEnvironment({ PATH: '/usr/bin', HOME: '/home/x', DATABASE_URL: 'postgres://localhost/x', LANG: 'en_AU.UTF-8' });
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/x');
  assert.equal(out.LANG, 'en_AU.UTF-8');
  assert.equal(out.DATABASE_URL, 'postgres://localhost/x');
});

// ── 8. the preset table itself ─────────────────────────────────────────────

test('every preset declares binaries, and every binary has a grammar', () => {
  assert.ok(PRESET_NAMES.length >= 5);
  for (const name of PRESET_NAMES) {
    const preset = COMMAND_PRESETS[name];
    assert.ok(Array.isArray(preset.binaries) && preset.binaries.length, `${name} has no binaries`);
    assert.ok(typeof preset.describe === 'string' && preset.describe.length > 10, `${name} has no description`);
    const { allowlist } = EVERY_BINARY();
    for (const b of preset.binaries) {
      const spec = allowlist.grammar.get(b);
      assert.ok(spec, `${name}: ${b} has no argument grammar — an ungoverned binary is not on the menu`);
      /**
       * ⚠️ `has()` WAS NOT ENOUGH, AND THIS IS THE FIX FOR A REAL MISS. The
       * first version of this test asserted only that a key existed. `python3`
       * was in `binaries` and absent from `grammar`, so the key existed with an
       * EMPTY spec — every flag refused, "allowed: " printed with nothing after
       * it — and this test was green. A binary that accepts no arguments is not
       * a governed binary, it is a broken one.
       */
      assert.ok(
        (spec.flags?.size ?? 0) + (spec.valueFlags?.size ?? 0) + (spec.separateValueFlags?.size ?? 0) + (spec.subcommands?.size ?? 0) > 0,
        `${name}: ${b} has an EMPTY grammar — it would refuse every flag and print "allowed: " with nothing after it`,
      );
      assert.ok(spec.resolve === 'path' || spec.resolve === 'node-module', `${name}: ${b} has no resolve rule`);
    }
  }
});

test('parseAllowCommandsEnv ignores blanks and trims, because humans write env vars by hand', () => {
  const r = parseAllowCommandsEnv(' python , , go ,');
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.presets, ['python', 'go']);
});
