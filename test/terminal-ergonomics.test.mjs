/**
 * ── ⚠️⚠️ THE TWO THINGS THESE MODULES CAN GET WRONG ARE BOTH SILENT ──────────
 *
 * 1. **A completion script that offers a flag we removed.** Nothing checks a
 *    file sitting in `~/.bashrc`. The user types what the shell offered and the
 *    tool calls them wrong for it. So the flags are taken back OUT of the
 *    GENERATED TEXT — not out of the table that generated it — and driven
 *    through the real `parseArgv`. A test that reads the table would agree with
 *    itself; `test/cli-flags-parse.test.mjs` records the day exactly that
 *    happened and reported green about a flag that did not work.
 *
 * 2. **A config layer that lets a repository widen something.** The workspace
 *    config file is written by a repository the user may have cloned this
 *    minute. Every assertion below that starts "a hostile workspace" is the
 *    `policy.mjs` monotonicity argument applied to preferences.
 *
 * ⭐ AND THE THIRD THING, WHICH IS THE ONE THAT ACTUALLY BITES: **a guard that
 * fails correct work.** Half of this file is ordinary, legitimate usage — a
 * plain home config, a repo tightening its own round budget, a bare `acuvo` with
 * no files anywhere — proving none of the above broke it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgv, USAGE, MAX_ROUNDS_LIMIT, DEFAULT_MAX_ROUNDS } from '../lib/cli-args.mjs';
import { TIERS } from '../lib/escalate.mjs';
import { DEFAULT_BUDGET_USD } from '../lib/budget.mjs';
import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from '../lib/model.mjs';
import {
  SUPPORTED_SHELLS, SUBCOMMANDS, SUBCOMMAND_VERBS, FLAGS,
  completionScript, bashCompletion, zshCompletion, fishCompletion,
  usageDescriptions, safeDescription, allFlagNames, fallbackDescriptions,
} from '../lib/completion.mjs';
import {
  CONFIG_KEYS, KEY_NAMES, WORKSPACE_CONFIG_FILE, HOME_CONFIG_FILE, CONFIG_FILE_ENV,
  parseConfigDocument, resolveConfig, applyConfig, describeConfig,
  explicitKeysFromArgv, readConfigSources, readWorkspaceEnvNames, defaultConfig, narrow,
} from '../lib/rcfile.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

const scripts = () => Object.fromEntries(
  SUPPORTED_SHELLS.map((s) => {
    const r = completionScript(s);
    assert.equal(r.ok, true, `${s}: ${r.ok === false ? r.error : ''}`);
    return [s, r.script];
  }),
);

/**
 * Every flag SPELLING that appears in a generated script.
 *
 * ⚠️ FISH NEEDS ITS OWN READING. It writes `-l dir`, never `--dir`, so a single
 * `--[a-z-]+` scan would find almost nothing in the fish script and the drift
 * test would pass by finding nothing to check — the "guard satisfied by
 * coincidence" shape. Both forms are collected, and the count is asserted.
 */
function flagsIn(script, shell) {
  const found = new Set();
  for (const m of script.matchAll(/--[a-z][a-z0-9-]+/g)) found.add(m[0]);
  if (shell === 'fish') {
    for (const m of script.matchAll(/(?:^|\s)-l ([a-z][a-z0-9-]+)/gm)) found.add(`--${m[1]}`);
  }
  return [...found];
}

/** Long flags `--help` documents, read from the help text itself. */
function documentedFlags() {
  return [...new Set([...String(USAGE).matchAll(/^\s{2}(--[a-z][a-z-]*)/gm)].map((m) => m[1]))];
}

// ══ completion ═════════════════════════════════════════════════════════════

test('the flag table is real — otherwise every drift test below is vacuous', () => {
  assert.ok(FLAGS.length > 25, `only ${FLAGS.length} flags in the table`);
  assert.ok(documentedFlags().length > 15, 'the USAGE scan found almost nothing — the regex is wrong, not the CLI');
  assert.equal(SUPPORTED_SHELLS.length, 3);
});

test('⚠️⚠️ EVERY flag the generated scripts offer is one the parser accepts', () => {
  const values = {
    '--dir': '.', '--model': 'x/y', '--max-tokens': '1000', '--timeout': '60',
    '--max-rounds': '3', '--command-timeout': '30', '--budget': '0.10',
    '--fleet-budget': '1.00', '--budget-window': '7d', '--lease': 'src/a.ts',
    '--holder': 't1', '--since': '7d', '--max-tier': 'solo', '--best-of': '2',
    '--issue': '1', '--concurrency': '2',
  };

  const bad = [];
  for (const [shell, script] of Object.entries(scripts())) {
    const flags = flagsIn(script, shell);
    // ⭐ A script that mentions no flags would pass the loop below silently.
    assert.ok(flags.length > 20, `${shell}: only found ${flags.length} flags in the generated script`);
    for (const flag of flags) {
      const argv = values[flag] !== undefined ? [flag, values[flag], 'a task'] : [flag, 'a task'];
      const r = parseArgv(argv);
      if (r.ok === false && /Unknown option/.test(r.error)) bad.push(`${shell}: ${flag}`);
    }
  }

  assert.deepEqual(bad, [], `these completions offer flags the parser rejects: ${bad.join(', ')}`);
});

test('⚠️ and the other direction — every documented flag IS offered', () => {
  const offered = new Set(allFlagNames());
  const missing = documentedFlags().filter((f) => !offered.has(f));
  assert.deepEqual(missing, [], `documented but never completed: ${missing.join(', ')}`);
});

test('⭐ the subcommands are exactly the five the parser claims', () => {
  assert.deepEqual(SUBCOMMANDS.map((s) => s.name), ['verify', 'rewind', 'leases', 'spend', 'board']);
  for (const { name } of SUBCOMMANDS) {
    const r = parseArgv([name]);
    assert.equal(r.ok, true, `${name}: ${r.ok === false ? r.error : ''}`);
    assert.equal(r.options.command, name, `bare \`acuvo ${name}\` is not dispatched as a command`);
  }
});

test('⭐ board sub-verbs are the ones bin/ accepts, and nothing else', () => {
  assert.deepEqual(SUBCOMMAND_VERBS.board, ['add', 'done']);
  const r = parseArgv(['board', 'add', 'make the suite pass']);
  assert.deepEqual(r.options.boardArgs, ['add', 'make the suite pass']);
});

test('⚠️ every value-taking flag has its own arm, so a value never completes to a flag', () => {
  const bash = bashCompletion();
  const caseBlock = bash.slice(bash.indexOf('case "$prev" in'), bash.indexOf('esac'));
  const uncovered = FLAGS.filter((f) => f.value).map((f) => f.name).filter((n) => !caseBlock.includes(n));
  assert.deepEqual(uncovered, [], `these flags fall through to the flag list: ${uncovered.join(', ')}`);

  // The flags whose value we cannot guess must offer NOTHING, not filenames.
  assert.match(caseBlock, /--holder\|?[^)]*\) return 0 ;;/, '--holder must complete to nothing');
});

test('⚠️ --max-tier offers exactly TIERS — a fourth tier would be a value the parser refuses', () => {
  for (const [shell, script] of Object.entries(scripts())) {
    assert.ok(script.includes(TIERS.join(' ')), `${shell} does not offer the tier ladder`);
  }
  const bogus = parseArgv(['--max-tier', 'ludicrous', 'a task']);
  assert.equal(bogus.ok, false);
});

test('⚠️ descriptions carry nothing that breaks the shell they are pasted into', () => {
  // A backtick is command substitution; an apostrophe closes the string it sits
  // in; `[`, `]` and `:` are zsh _arguments field separators.
  const hostile = /[`'"$\\[\]:]/;
  const descriptions = usageDescriptions();
  assert.ok(descriptions.size > 15, `only scraped ${descriptions.size} descriptions from USAGE`);
  for (const [flag, raw] of descriptions) {
    assert.doesNotMatch(safeDescription(raw), hostile, `${flag}'s description survives a hostile character`);
  }
  // And prove the sanitiser is not a no-op fed only clean input.
  assert.doesNotMatch(safeDescription('use `rm -rf $HOME` [now]: yes'), hostile);
});

test('⚠️ a hand-written fallback never shadows a description USAGE already gives', () => {
  const documented = usageDescriptions();
  const shadowed = Object.keys(fallbackDescriptions()).filter((f) => documented.has(f));
  assert.deepEqual(shadowed, [], `delete these fallbacks — the help text now documents them: ${shadowed.join(', ')}`);
});

test('⭐ fish turns file completion OFF first, or every flag offers your directory', () => {
  assert.match(fishCompletion(), /^complete -c acuvo -f$/m);
});

test('⚠️ zsh: no spec is left with an empty description or a stray separator', () => {
  const zsh = zshCompletion();
  assert.doesNotMatch(zsh, /\[\]/, 'an empty [] would make _arguments treat the next field as the description');
  assert.match(zsh, /^#compdef acuvo$/m);
  assert.match(zsh, /^compdef _acuvo acuvo$/m);
});

test('⚠️ naming no shell refuses and names all three; an unknown shell says what exists', () => {
  const none = completionScript('');
  assert.equal(none.ok, false);
  for (const s of SUPPORTED_SHELLS) assert.ok(none.error.includes(s), `the refusal does not mention ${s}`);

  const nope = completionScript('powershell');
  assert.equal(nope.ok, false);
  assert.match(nope.error, /bash/, 'a refusal that names no way out is an obstacle');
});

test('⭐ extraFlags lets bin/ add the flags it parses itself, without this file guessing', () => {
  const bash = bashCompletion({ extraFlags: ['--doctor'] });
  assert.ok(bash.includes('--doctor'));
  // And it is NOT there by default — parseArgv would reject it.
  assert.ok(!bashCompletion().includes('--doctor'));
  assert.equal(parseArgv(['--doctor']).ok, false, 'if this passes, --doctor should move into cli-args.mjs and out of extraFlags');
});

test('⭐⭐ the generated bash actually parses as bash', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-completion-'));
  try {
    const file = join(dir, 'acuvo.bash');
    writeFileSync(file, bashCompletion(), 'utf8');
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    if (r.error) {
      // ⚠️ SKIPPED, NOT SILENTLY PASSED. A machine with no bash cannot answer
      // this question, and a test that quietly reports green on every machine
      // that cannot run it is the "check that cannot fail" shape.
      t.skip(`no bash on this machine (${r.error.code}) — syntax not verified here`);
      return;
    }
    assert.equal(r.status, 0, `bash -n rejected the generated script:\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══ rcfile: the precedence chain ═══════════════════════════════════════════

const HOME = `~/.acuvo/${HOME_CONFIG_FILE}`;

test('⭐ nothing configured changes nothing — the ninety-nine users case', () => {
  const r = resolveConfig({ argv: ['a task'], env: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.options, {}, 'a run with no config file must be byte-identical to today');
  assert.deepEqual(describeConfig(r), [], 'and must print nothing about a feature nobody is using');
  assert.equal(r.values.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.equal(r.values.budget, DEFAULT_BUDGET_USD);
  // ⚠️ `null`, not DEFAULT_MODEL — the parser's value for "nobody chose". See
  // the note on `defaultConfig().model`.
  assert.equal(r.values.model, null);
});

test('⭐ step 1 — a workspace file beats the default', () => {
  const r = resolveConfig({ argv: ['t'], workspaceText: '{"maxRounds": 3}' });
  assert.equal(r.ok, true);
  assert.equal(r.values.maxRounds, 3);
  assert.equal(r.options.maxRounds, 3);
});

test('⭐ step 2 — a home file beats the workspace file', () => {
  const r = resolveConfig({ argv: ['t'], workspaceText: '{"maxRounds": 3}', homeText: '{"maxRounds": 9}' });
  assert.equal(r.values.maxRounds, 9, 'the user\'s own file must win over a repository\'s');
});

test('⭐ step 3 — the environment beats the home file', () => {
  const r = resolveConfig({
    argv: ['t'],
    workspaceText: '{"maxRounds": 3}',
    homeText: '{"maxRounds": 9}',
    env: { ACUVO_MAX_ROUNDS: '11' },
  });
  assert.equal(r.values.maxRounds, 11);
});

test('⭐ step 4 — an explicit flag beats everything, and is never returned to be re-applied', () => {
  const argv = ['--max-rounds', '4', 'a task'];
  const r = resolveConfig({
    argv,
    workspaceText: '{"maxRounds": 3}',
    homeText: '{"maxRounds": 9}',
    env: { ACUVO_MAX_ROUNDS: '11' },
  });
  assert.equal(r.options.maxRounds, undefined, 'a key the user typed must not appear in what the caller merges');

  const parsed = parseArgv(argv);
  assert.equal(parsed.ok, true);
  const merged = applyConfig(parsed.options, r);
  assert.equal(merged.maxRounds, 4, 'the flag lost to a config file — the whole chain is upside down');
});

test('⭐ the whole chain on one key, end to end', () => {
  const layers = {
    workspaceText: '{"maxRounds": 2}',
    homeText: '{"maxRounds": 9}',
    env: { ACUVO_MAX_ROUNDS: '11' },
  };
  const seen = [
    resolveConfig({ argv: ['t'] }).values.maxRounds,
    resolveConfig({ argv: ['t'], workspaceText: layers.workspaceText }).values.maxRounds,
    resolveConfig({ argv: ['t'], ...layers, env: {} }).values.maxRounds,
    resolveConfig({ argv: ['t'], ...layers }).values.maxRounds,
    applyConfig(parseArgv(['--max-rounds', '4', 't']).options, resolveConfig({ argv: ['--max-rounds', '4', 't'], ...layers })).maxRounds,
  ];
  assert.deepEqual(seen, [DEFAULT_MAX_ROUNDS, 2, 9, 11, 4]);
});

// ══ rcfile: a hostile workspace ════════════════════════════════════════════

test('⚠️⚠️ a hostile workspace cannot RAISE the round budget', () => {
  const r = resolveConfig({ argv: ['t'], workspaceText: `{"maxRounds": ${MAX_ROUNDS_LIMIT}}` });
  assert.equal(r.ok, true);
  assert.equal(r.values.maxRounds, DEFAULT_MAX_ROUNDS, 'a repository widened the round budget');
  assert.ok(r.notes.some((n) => /may only tighten/.test(n)), 'it was clamped in silence');
});

test('⚠️⚠️ a hostile workspace cannot RAISE or REMOVE the spend ceiling', () => {
  const raised = resolveConfig({ argv: ['t'], workspaceText: '{"budget": "5.00"}' });
  assert.equal(raised.values.budget, DEFAULT_BUDGET_USD, 'a repository raised the spend ceiling');

  const removed = resolveConfig({ argv: ['t'], workspaceText: '{"budget": "none"}' });
  assert.equal(removed.values.budget, DEFAULT_BUDGET_USD, '"none" is +infinity and must lose to every number');

  // ⭐ and lowering it — the legitimate direction — works.
  const lowered = resolveConfig({ argv: ['t'], workspaceText: '{"budget": "1c"}' });
  assert.ok(lowered.values.budget < DEFAULT_BUDGET_USD, 'a repository may always tighten');
});

test('⚠️⚠️ a hostile workspace cannot unlock --until-done by supplying the budget', () => {
  const ws = resolveConfig({ argv: ['t'], workspaceText: '{"budget": "0.001"}' });
  assert.equal(ws.options.budgetExplicit, undefined, 'a repository must never satisfy the ceiling --until-done demands');

  const home = resolveConfig({ argv: ['t'], homeText: '{"budget": "0.50"}' });
  assert.equal(home.options.budgetExplicit, true, 'a number the user typed in their own file IS explicit');
  assert.equal(home.options.budgetUsd, 0.5);
});

test('⚠️⚠️ a hostile workspace cannot turn off the undo, the leases, or pick the model', () => {
  for (const key of ['checkpoint', 'autoLease', 'model', 'json', 'unattended', 'holder', 'refute', 'bestOf']) {
    const value = key === 'model' ? '"acuvo-pro"' : key === 'holder' ? '"t1"' : key === 'bestOf' ? '5' : 'false';
    const r = resolveConfig({ argv: ['t'], workspaceText: `{"${key}": ${value}}` });
    assert.equal(r.ok, false, `a repository was allowed to set ${key}`);
    assert.match(r.error, /may only be set in your own config/, `${key}: the refusal does not say where it belongs`);
    assert.match(r.error, /workspaceConfig/, `${key}: the refusal names no way out`);
  }
});

test('⚠️⚠️ NOTHING may turn on --shell, and the refusal teaches the alias', () => {
  for (const [label, layer] of [['workspace', 'workspaceText'], ['home', 'homeText']]) {
    const r = resolveConfig({ argv: ['t'], [layer]: '{"shell": true}' });
    assert.equal(r.ok, false, `${label} config was allowed to grant --shell`);
    assert.match(r.error, /alias acuvo='acuvo --shell'/, `${label}: the refusal does not name the way out`);
  }
  // Even asking for `false` is refused — one rule, not a value-dependent one.
  assert.equal(resolveConfig({ argv: ['t'], homeText: '{"shell": false}' }).ok, false);
});

test('⚠️ the boolean lattice: a repository may tighten but never loosen', () => {
  // allowRun: `false` is the strict side.
  assert.equal(resolveConfig({ argv: ['t'], workspaceText: '{"allowRun": false}' }).values.allowRun, false);
  assert.equal(
    resolveConfig({ argv: ['t'], homeText: '{"allowRun": false}', env: { ACUVO_ALLOW_RUN: 'true' }, untrustedEnvNames: ['ACUVO_ALLOW_RUN'] }).values.allowRun,
    false,
    'an untrusted layer turned execution back on',
  );

  // dryRun: `true` is the strict side.
  assert.equal(resolveConfig({ argv: ['t'], workspaceText: '{"dryRun": true}' }).values.dryRun, true);
  assert.equal(
    resolveConfig({ argv: ['t'], homeText: '{"dryRun": true}', env: { ACUVO_DRY_RUN: 'false' }, untrustedEnvNames: ['ACUVO_DRY_RUN'] }).values.dryRun,
    true,
    'an untrusted layer let the agent write to disk again',
  );
});

test('⚠️ the tier ladder narrows too — solo < fresh < best-of', () => {
  const r = resolveConfig({
    argv: ['t'],
    homeText: '{"maxTier": "solo"}',
    env: { ACUVO_MAX_TIER: 'best-of' },
    untrustedEnvNames: ['ACUVO_MAX_TIER'],
  });
  assert.equal(r.values.maxTier, 'solo', 'an untrusted layer climbed the escalation ladder');

  // Trusted, the same variable simply wins — precedence, as specified.
  const trusted = resolveConfig({ argv: ['t'], homeText: '{"maxTier": "solo"}', env: { ACUVO_MAX_TIER: 'best-of' } });
  assert.equal(trusted.values.maxTier, 'best-of');
});

test('⚠️⚠️ an env var that came out of the repo\'s .env is treated as the repo, not the user', () => {
  /**
   * ⚠️ THE NUMBER MUST BE A RAISE AGAINST THE CURRENT DEFAULT, AND IT STOPPED
   * BEING ONE. This was `16` against a default of 5. When the default rose to
   * 24 the same fixture became a REDUCTION, which `reduce: 'min'` permits by
   * design — so the test failed against correct code while no longer exercising
   * the escalation it exists to catch.
   *
   * ⭐ Derived from the constant rather than hardcoded, so it can never quietly
   * stop being an escalation again.
   */
  const hostile = { ACUVO_MODEL: 'acuvo-pro', ACUVO_MAX_ROUNDS: String(DEFAULT_MAX_ROUNDS + 16) };
  const r = resolveConfig({ argv: ['t'], env: hostile, untrustedEnvNames: ['ACUVO_MODEL', 'ACUVO_MAX_ROUNDS'] });

  assert.equal(r.ok, true, 'and it must never be an error — .env may still be carrying a real export');
  assert.equal(r.values.model, null, 'a repository chose the model through .env');
  assert.equal(r.values.maxRounds, DEFAULT_MAX_ROUNDS, 'a repository raised the round budget through .env');
  assert.equal(r.notes.length, 2, `both overreaches must be reported, got: ${r.notes.join(' | ')}`);

  // ⭐ The same two variables, exported by the human, are honoured in full.
  const trusted = resolveConfig({ argv: ['t'], env: hostile });
  assert.equal(trusted.values.maxRounds, DEFAULT_MAX_ROUNDS + 16);
  assert.match(trusted.values.model, /deepseek-v4-pro/);
});

test('⚠️ a repository may LOWER the round budget, and that is deliberate — but it is a real edge', () => {
  /**
   * `maxRounds` is `trust: 'any', reduce: 'min'`: an untrusted layer may make a
   * run cheaper or smaller, never larger. The module header argues it — the
   * alternative default (distrust everything) *"silently clamps a legitimate
   * `export ACUVO_MAX_ROUNDS=12`"* for everyone.
   *
   * ⚠️ WORTH KNOWING WHAT IT PERMITS: a hostile repository can set
   * `ACUVO_MAX_ROUNDS=1`, which the README defines as "one completion and
   * nothing executed" — i.e. it can stop the agent from ever RUNNING what it
   * wrote. That is a downgrade in verification, not in permission, so it is
   * within the stated model; this test exists so the behaviour is a decision on
   * record rather than something discovered during an incident.
   */
  const r = resolveConfig({
    argv: ['t'],
    env: { ACUVO_MAX_ROUNDS: '1' },
    untrustedEnvNames: ['ACUVO_MAX_ROUNDS'],
  });
  assert.equal(r.values.maxRounds, 1, 'reduce:min means a repository may lower it');
});

test('⭐ {"workspaceConfig": false} switches the repository layer off entirely', () => {
  const r = resolveConfig({
    argv: ['t'],
    homeText: '{"workspaceConfig": false}',
    workspaceText: '{"maxRounds": 1}',
  });
  assert.equal(r.ok, true);
  assert.equal(r.values.maxRounds, DEFAULT_MAX_ROUNDS, 'the workspace layer was still read');
  assert.ok(r.sources.some((s) => s.ignored), 'and the fact that it was ignored is not visible');

  // ⚠️ It is home-only — a repository must not be able to answer this one.
  assert.equal(resolveConfig({ argv: ['t'], workspaceText: '{"workspaceConfig": true}' }).ok, false);
});

// ══ rcfile: parsing ════════════════════════════════════════════════════════

test('⚠️ a misspelled key stops the run rather than quietly meaning "the default"', () => {
  const r = parseConfigDocument('{"maxRoundz": 2}', { label: 'x.json', trusted: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown setting "maxRoundz"/);
  assert.match(r.error, /maxRounds/, 'the refusal does not list what IS known');
});

test('⚠️ booleans are not truthiness — "false" is a string and a mistake', () => {
  const r = parseConfigDocument('{"checkpoint": "false"}', { label: 'x.json', trusted: true });
  assert.equal(r.ok, false, '"false" was read as true, which is the dangerous direction for every boolean here');
  assert.match(r.error, /must be true or false/);
});

test('⚠️ an empty file, invalid JSON and a JSON array are all refused by name', () => {
  assert.match(parseConfigDocument('', { trusted: true }).error, /empty/);
  assert.match(parseConfigDocument('   ', { trusted: true }).error, /empty/);
  assert.match(parseConfigDocument('{"a":}', { trusted: true }).error, /not valid JSON/);
  assert.match(parseConfigDocument('[1,2]', { trusted: true }).error, /must be a JSON object/);
  // ⭐ and `{}` is legal — the refusal for an empty file promises it works.
  assert.deepEqual(parseConfigDocument('{}', { trusted: true }).config, {});
});

test('⭐ a model name means the same thing in a file as on the flag', () => {
  const r = resolveConfig({ argv: ['t'], homeText: '{"model": "acuvo-pro"}' });
  const viaFlag = parseArgv(['--model', 'acuvo-pro', 't']);
  assert.equal(r.options.model, viaFlag.options.model);

  // ⚠️ And the internal reviewer is refused here exactly as it is there.
  const internal = resolveConfig({ argv: ['t'], homeText: '{"model": "acuvo-review"}' });
  assert.equal(internal.ok, false);
  assert.match(internal.error, /self-review/);
});

test('⭐ seconds in the file, milliseconds in the options — one conversion, stated once', () => {
  const r = resolveConfig({ argv: ['t'], homeText: '{"timeout": 60, "commandTimeout": 30}' });
  assert.equal(r.options.timeoutMs, 60_000);
  assert.equal(r.options.commandTimeoutMs, 30_000);

  const merged = applyConfig(parseArgv(['t']).options, r);
  assert.equal(merged.timeoutMs, 60_000);
  assert.notEqual(merged.timeoutMs, DEFAULT_TIMEOUT_MS);

  // Out of range is refused with both bounds.
  assert.match(resolveConfig({ argv: ['t'], homeText: '{"timeout": 4}' }).error, /between 5 and 900/);
});

test('⚠️ a malformed ENVIRONMENT variable is a note, not a stopped run', () => {
  const r = resolveConfig({ argv: ['t'], env: { ACUVO_MAX_ROUNDS: 'lots' } });
  assert.equal(r.ok, true, 'a stranger\'s malformed variable must not stop a correct run');
  assert.equal(r.values.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.ok(r.notes.some((n) => /ACUVO_MAX_ROUNDS/.test(n)), 'and it must say so');
});

test('⭐ the legacy variable still names the model, and ACUVO_MODEL wins over it', () => {
  const legacy = resolveConfig({ argv: ['t'], env: { OPENROUTER_CODEGEN_MODEL: 'acuvo-pro' } });
  assert.match(legacy.options.model, /deepseek-v4-pro/);

  const both = resolveConfig({ argv: ['t'], env: { ACUVO_MODEL: 'acuvo-flash', OPENROUTER_CODEGEN_MODEL: 'acuvo-pro' } });
  assert.match(both.options.model, /deepseek-v4-flash/);
});

test('⭐ an empty variable is not a value — it is an unset variable spelled badly', () => {
  const r = resolveConfig({ argv: ['t'], env: { ACUVO_MODEL: '', ACUVO_HOLDER: '   ' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.options, {});
});

// ══ rcfile: explicitness ═══════════════════════════════════════════════════

test('⚠️ a flag\'s VALUE is never mistaken for a flag', () => {
  assert.deepEqual([...explicitKeysFromArgv(['--holder', '--json'])], ['holder'],
    '"--json" was a holder name, not a request for JSON output');
  assert.deepEqual([...explicitKeysFromArgv(['--model', '--shell', 't'])], ['model']);
});

test('⭐ the negative spellings count as the user deciding', () => {
  assert.ok(explicitKeysFromArgv(['--no-checkpoint']).has('checkpoint'));
  assert.ok(explicitKeysFromArgv(['--no-auto-lease']).has('autoLease'));
  assert.ok(explicitKeysFromArgv(['--no-run']).has('allowRun'));
  assert.ok(!explicitKeysFromArgv(['a task']).has('allowRun'));
});

test('⚠️ --no-checkpoint on the command line survives a home config that says otherwise', () => {
  const argv = ['--no-checkpoint', 'a task'];
  const r = resolveConfig({ argv, homeText: '{"checkpoint": true}' });
  const merged = applyConfig(parseArgv(argv).options, r);
  assert.equal(merged.checkpoint, false, 'a config file overrode a flag the user typed');
});

// ══ rcfile: the disk ═══════════════════════════════════════════════════════

const enoent = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };

test('⭐ absent files are the common case and mean "nothing said here"', () => {
  const r = readConfigSources('/ws', { env: {}, home: '/home/u', readFileImpl: enoent });
  assert.equal(r.ok, true);
  assert.equal(r.homeText, null);
  assert.equal(r.workspaceText, null);
});

test('⚠️ an unreadable-but-present file stops the run — fail closed, not fail quiet', () => {
  const eacces = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
  const r = readConfigSources('/ws', { env: {}, home: '/home/u', readFileImpl: eacces });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be read/);
});

test(`⚠️ ${CONFIG_FILE_ENV} pointing at nothing is an error; an absent ${HOME} is not`, () => {
  const r = readConfigSources('/ws', { env: { [CONFIG_FILE_ENV]: '/tmp/typo.json' }, home: '/home/u', readFileImpl: enoent });
  assert.equal(r.ok, false);
  assert.match(r.error, /typo\.json/);
});

test('⭐ the two paths are the ones documented, and ACUVO_HOME relocates the home one', () => {
  const seen = [];
  const reader = (p) => { seen.push(p); return '{}'; };
  readConfigSources('/ws', { env: {}, home: '/home/u', readFileImpl: reader });
  assert.deepEqual(seen, [`/home/u/.acuvo/${HOME_CONFIG_FILE}`, `/ws/${WORKSPACE_CONFIG_FILE}`]);

  seen.length = 0;
  readConfigSources('/ws', { env: { ACUVO_HOME: '/elsewhere' }, home: '/home/u', readFileImpl: reader });
  assert.equal(seen[0], `/elsewhere/${HOME_CONFIG_FILE}`);
});

test('⚠️ only .env files INSIDE the workspace are the repository\'s to write', () => {
  const files = { '/ws/.env': 'ACUVO_MAX_ROUNDS=16\nexport ACUVO_MODEL=x/y\n', '/.env': 'ACUVO_BUDGET=5\n' };
  const names = readWorkspaceEnvNames('/ws', {
    candidatesImpl: () => Object.keys(files),
    readImpl: (p) => files[p],
  });
  assert.deepEqual([...names].sort(), ['ACUVO_MAX_ROUNDS', 'ACUVO_MODEL']);
  assert.ok(!names.has('ACUVO_BUDGET'), 'a .env above the workspace is outside the agent\'s reach and stays trusted');
});

test('⚠️ readWorkspaceEnvNames never throws — an unreadable .env must not stop a run', () => {
  const names = readWorkspaceEnvNames('/ws', {
    candidatesImpl: () => { throw new Error('boom'); },
    readImpl: () => '',
  });
  assert.deepEqual([...names], []);
  assert.deepEqual([...readWorkspaceEnvNames('/ws', {})], [], 'and with no impls at all');
});

// ══ rcfile: the shape of the table itself ══════════════════════════════════

test('⭐ every key maps to a real CLI option, and every default agrees with the parser', () => {
  const parsed = parseArgv(['a task']);
  assert.equal(parsed.ok, true);
  const defaults = defaultConfig();

  const wrong = [];
  for (const [name, spec] of Object.entries(CONFIG_KEYS)) {
    if (!spec.option) continue;
    if (!(spec.option in parsed.options)) { wrong.push(`${name} → ${spec.option} (no such option)`); continue; }
    if (parsed.options[spec.option] !== defaults[name]) {
      wrong.push(`${name}: config default ${defaults[name]} but the parser produces ${parsed.options[spec.option]}`);
    }
  }
  assert.deepEqual(wrong, [], `the config layer disagrees with the parser it is merging into: ${wrong.join('; ')}`);
});

test('⭐ every key states its trust, and only reduce-carrying keys are workspace-writable', () => {
  const wrong = [];
  for (const [name, spec] of Object.entries(CONFIG_KEYS)) {
    if (!['any', 'home', 'never'].includes(spec.trust)) wrong.push(`${name}: trust ${spec.trust}`);
    if (spec.trust === 'any' && !spec.reduce) wrong.push(`${name}: writable by a repository with no way to narrow it`);
  }
  assert.deepEqual(wrong, []);
  assert.ok(KEY_NAMES.length > 12);
});

test('⚠️ narrow() with no reducer keeps the current value — an omission must not be a hole', () => {
  const { value, clamped } = narrow({ trust: 'any' }, 5, 16);
  assert.equal(value, 5, 'a key whose reducer was forgotten silently widened');
  assert.equal(clamped, true);
});

test('⭐ describeConfig says what is in force, and stays quiet when nothing is', () => {
  assert.deepEqual(describeConfig(resolveConfig({ argv: ['t'] })), []);
  const lines = describeConfig(resolveConfig({ argv: ['t'], homeText: '{"maxRounds": 9}' }));
  assert.ok(lines.length >= 2);
  assert.ok(lines.some((l) => l.includes('maxRounds = 9')), lines.join('\n'));
  assert.ok(lines[0].includes(HOME_CONFIG_FILE));
});

test('⭐ a whole realistic config, applied end to end, changes exactly what it says', () => {
  const argv = ['--budget', '1.00', 'ship the thing'];
  const resolved = resolveConfig({
    argv,
    homeText: JSON.stringify({ model: 'acuvo-pro', maxRounds: 8, holder: 'roman', budget: '5.00' }),
    workspaceText: JSON.stringify({ maxRounds: 4, allowRun: false }),
    env: {},
  });
  assert.equal(resolved.ok, true);

  const merged = applyConfig(parseArgv(argv).options, resolved);
  assert.match(merged.model, /deepseek-v4-pro/, 'home chose the model');
  assert.equal(merged.maxRounds, 8, 'home beat the workspace');
  assert.equal(merged.holder, 'roman');
  assert.equal(merged.budgetUsd, 1, 'the flag beat the home file');
  assert.equal(merged.budgetExplicit, true);
  assert.equal(merged.allowRun, false, 'a repository tightening its own run — the legitimate direction — was dropped');
  assert.equal(merged.task, 'ship the thing', 'the task survived the merge');
});
