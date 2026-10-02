/**
 * ── ⚠️⚠️⭐ THE TYPO THAT BILLED: `acuvo doctor` ─────────────────────────────
 *
 * MEASURED 2026-08-25, on this package, with real money. `acuvo doctor` — no
 * dashes, the natural thing to type — was not refused. `parseArgv`'s only
 * refusal was `arg.startsWith('--')`, so a word without two leading dashes was
 * a POSITIONAL by construction: it became `out.task = 'doctor'` and started a
 * real agentic run at roughly $0.0045 a round. **It cost $0.0066 before it was
 * killed by hand.** There was no "unknown command" path at all.
 *
 * ⚠️ AND `--help` TAUGHT THE SHAPE. `mcp add`, `mcp list` and `completion
 * <shell>` were printed as bare words in the middle of the OPTIONS block, so
 * the front door demonstrated "a word with no dashes is a command here" — true
 * of nine words, and a paid run for every other one.
 *
 * ── ⭐ WHAT THIS FILE IS ACTUALLY DEFENDING ─────────────────────────────────
 *
 * Two things, and the SECOND one is the harder one:
 *
 *   1. the typo is refused, exits 64, and spends nothing;
 *   2. **a real task is still a real task.** A false refusal is worse than the
 *      bug — a typo costs half a cent, a rejected instruction costs the user
 *      their afternoon. The `NOT REFUSED` table below is the load-bearing half,
 *      and it is not decorative: an earlier draft of this rule matched flags by
 *      EDIT DISTANCE and this suite caught it refusing `acuvo clean`,
 *      `acuvo deploy` and `acuvo modal`. Those three cases are kept forever.
 *
 * ── ⚠️ NOT ONE TEST HERE SPENDS ANYTHING ────────────────────────────────────
 *
 * `parseArgv` is pure, so the boundary is driven directly. The two tests that
 * spawn the binary run `--help` (answered above the key check) and a REFUSED
 * invocation — which by definition returns before a model is reached. Nothing
 * in this file can start an agent turn even if the guard is deleted, because
 * the spawned refusals are also given `ACUVO_NO_UPDATE=1` and a workspace with
 * no credential; the assertion that would then fail is the exit code, not a bill.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseArgv,
  USAGE,
  KNOWN_FLAG_SPELLINGS,
  KNOWN_COMMAND_WORDS,
  nearestKnownFlag,
  mistypedArgument,
  unknownOptionMessage,
} from '../lib/cli-args.mjs';
import { allFlagNames } from '../lib/completion.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'acuvo.mjs');

/** `bin/acuvo.mjs` exits 64 on a usage error. Named, not repeated as a number. */
const EXIT_USAGE = 64;

/**
 * ⚠️ `ACUVO_NO_UPDATE=1` SO A TEST NEVER REACHES THE NPM REGISTRY, and no
 * credential of any kind is passed. A spawned run here has nothing to spend
 * even if every guard in this file were removed.
 */
const run = (args) => spawnSync(process.execPath, [BIN, ...args], {
  encoding: 'utf8',
  env: { ...process.env, ACUVO_NO_UPDATE: '1', ACUVO_JSON: '' },
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE REFUSALS
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⭐ THE MEASURED CASE FIRST. Everything else in this file exists because of
 * this one line of terminal history.
 */
test('⚠️⚠️ `acuvo doctor` is REFUSED and names `--doctor` — it used to start a paid run', () => {
  const r = parseArgv(['doctor']);
  assert.equal(r.ok, false, '`doctor` parsed as a task again — that is a paid agent run per invocation');
  assert.match(r.error, /--doctor/, 'the refusal must name the flag the user meant, or it is just an obstacle');
  assert.match(r.error, /paid run/i, 'the refusal must say WHY it refused: the alternative was billing them');
});

test('every bare word that names a flag is refused, and the suggestion is the real flag', () => {
  const cases = [
    ['doctor', '--doctor'],
    ['help', '--help'],
    ['version', '--version'],
    ['login', '--login'],
    ['logout', '--logout'],
    ['whoami', '--whoami'],
    ['sessions', '--sessions'],
    ['plan', '--plan'],
    ['shell', '--shell'],
    ['json', '--json'],
    ['design', '--design'],
    ['replay', '--replay'],
  ];
  for (const [word, flag] of cases) {
    const r = parseArgv([word]);
    assert.equal(r.ok, false, `\`acuvo ${word}\` was accepted as a task — that is a billable run`);
    assert.ok(
      r.error.includes(flag),
      `\`acuvo ${word}\` was refused without naming ${flag}. It said: ${r.error.split('\n')[0]}`,
    );
  }
});

/** Case is not a decision the user made — `DOCTOR` is the same typo. */
test('the bare-word rule is case-insensitive', () => {
  for (const spelling of ['DOCTOR', 'Doctor', 'dOcToR']) {
    const r = parseArgv([spelling]);
    assert.equal(r.ok, false, `\`acuvo ${spelling}\` was taken as a task`);
    assert.match(r.error, /--doctor/);
  }
});

/**
 * ⭐ THE SINGLE-DASH HOLE. `--doctro` was always refused ("Unknown option");
 * `-doctor` was NOT, because the test is `startsWith('--')` — so one missing
 * dash turned a flag into prose and a paid run.
 */
test('⚠️ a SINGLE-dash typo is refused too — `--` was the only thing ever checked', () => {
  const r = parseArgv(['-doctor']);
  assert.equal(r.ok, false, '`-doctor` became a task prompt; one dash short of the only guard there was');
  assert.match(r.error, /Unknown option -doctor/);
  assert.match(r.error, /--doctor/, 'and it must say what was meant');
});

test('a leading-dash typo is refused even when words follow it', () => {
  // Silently folding `-x` into the prompt is the same failure wearing a hat:
  // the flag is swallowed AND the model is asked a question nobody typed.
  const r = parseArgv(['-doctor', 'now']);
  assert.equal(r.ok, false, '`-doctor now` sent "-doctor now" to a model as an instruction');
});

test('⭐ `--doctro` now SUGGESTS, and still says "Unknown option" — two guards match that string', () => {
  const r = parseArgv(['--doctro']);
  assert.equal(r.ok, false);
  /**
   * ⚠️ `test/cli-flags-parse.test.mjs` and `test/terminal-ergonomics.test.mjs`
   * both find an unreachable-but-documented flag by matching /Unknown option/
   * on this parser's error. The suggestion is APPENDED for that reason;
   * rewording the prefix would silently disarm both.
   */
  assert.match(r.error, /Unknown option/, 'two other suites detect a broken flag by this exact string');
  assert.match(r.error, /Did you mean `--doctor`/);
});

test('a command word behind a flag is refused instead of billed — the `argv[0]` anchor defect', () => {
  /**
   * `lib/cli-args.mjs` has recorded this in a comment for days: *"`board`,
   * `verify`, `leases` and `spend` STILL USE THE `argv[0]` ANCHOR and so
   * `acuvo --dir <path> board` is still a paid task run."* With a flag in
   * front, the command word arrives as a lone positional — which is exactly
   * what rule 2 catches.
   */
  for (const word of ['board', 'verify', 'leases', 'spend', 'config', 'engines']) {
    const r = parseArgv(['--dir', '/tmp', word]);
    assert.equal(r.ok, false, `\`acuvo --dir /tmp ${word}\` still starts a paid run`);
    assert.match(r.error, /FIRST/, `the refusal for ${word} must say the command has to come first`);
  }
});

test('`acuvo mcp` with no verb is refused and shows the shape that works', () => {
  const r = parseArgv(['mcp']);
  assert.equal(r.ok, false, '`acuvo mcp` was sent to a model as the word "mcp"');
  assert.match(r.error, /acuvo mcp list/, 'a refusal that does not show the working invocation is an obstacle');
});

/* ══════════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE HALF THAT MATTERS MORE: A REAL TASK IS STILL A REAL TASK
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ NOT REFUSED — ordinary instructions still run, including one-word ones', () => {
  const tasks = [
    'fix the login bug',
    'doctor the config file',            // the refused WORD, inside a real sentence
    'add a health check to src/server.js',
    'the board is rendering wrong',
    'rewind the migration to the previous schema',
    'refactor',
    'lint',
    'docs',
    'build',
    'debug',
    'tests',
    'optimise',
    /**
     * ⚠️ THESE THREE ARE THE REGRESSION. An edit-distance version of this rule
     * refused all of them on 2026-08-25 — `clean`→`--plan` (distance 2),
     * `deploy`→`--replay` (2), `modal`→`--model` (1). Fuzzy matching is fine
     * for a token that is refused anyway; it is not fine when it DECIDES the
     * refusal. Delete these and the rule is free to become wrong again.
     */
    'clean',
    'deploy',
    'modal',
  ];
  for (const task of tasks) {
    const r = parseArgv([task]);
    assert.equal(r.ok, true, `\`acuvo "${task}"\` was REFUSED. A false refusal is worse than the bug: ${r.error}`);
    assert.equal(r.options.task, task, `the task text changed: ${JSON.stringify(r.options.task)}`);
  }
});

test('the real commands still dispatch — the guard must not eat them', () => {
  for (const word of ['leases', 'spend', 'engines', 'config', 'verify', 'board', 'rewind']) {
    const r = parseArgv([word]);
    assert.equal(r.ok, true, `\`acuvo ${word}\` stopped working: ${r.ok === false ? r.error : ''}`);
    assert.equal(r.options.command, word, `\`acuvo ${word}\` no longer dispatches as a command`);
    assert.equal(r.options.task, '', `\`acuvo ${word}\` left a task behind, which is a paid run`);
  }
});

test('⚠️ --help and --version survive a stray word after them', () => {
  // `acuvo --help doctor` refusing to print the help would be this guard
  // breaking the one command that explains it.
  const help = parseArgv(['--help', 'doctor']);
  assert.equal(help.ok, true, 'the guard swallowed --help');
  assert.equal(help.options.help, true);

  const version = parseArgv(['--version', 'doctor']);
  assert.equal(version.ok, true, 'the guard swallowed --version');
  assert.equal(version.options.version, true);
});

test('`-` alone stays a task — it is the conventional stdin placeholder, not a typo', () => {
  const r = parseArgv(['-']);
  assert.equal(r.ok, true);
});

test('--parallel is untouched: several quoted tasks are tasks', () => {
  const r = parseArgv(['--parallel', 'add tests', 'write the README']);
  assert.equal(r.ok, true, r.ok === false ? r.error : '');
  assert.deepEqual(r.options.tasks, ['add tests', 'write the README']);
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE NAME TABLE, AND THE DRIFT FENCE UNDER IT
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ THE SILENT-FAILURE DIRECTION IS THE DANGEROUS ONE. A name missing from
 * `KNOWN_FLAG_SPELLINGS` is not a crash — it is a word that quietly goes back
 * to costing money. So the table is checked against BOTH other places the
 * CLI's flag surface is written down.
 */
test('⚠️ every flag the completion scripts offer is in the refusal table', () => {
  const missing = allFlagNames().filter((f) => !KNOWN_FLAG_SPELLINGS.includes(f));
  assert.deepEqual(
    missing, [],
    `lib/completion.mjs offers these and KNOWN_FLAG_SPELLINGS does not know them: ${missing.join(', ')}. `
    + 'Each one is a word that, typed without dashes, becomes a paid agent run again.',
  );
});

test('⚠️⚠️ every flag the RENDERED --help teaches is in the refusal table', () => {
  /**
   * ⭐ THE RENDERED OUTPUT, NOT `USAGE`. `bin/acuvo.mjs` concatenates three
   * arrays — `USAGE`, `LIFECYCLE_USAGE` and `VOICE_USAGE` — and the last two
   * live in files this module cannot import (see the ESM-cycle note in
   * `lib/completion.mjs`). Spawning the binary is the only way to see the
   * surface a user actually reads, and `--help` is answered above the key
   * check, so it costs nothing.
   */
  const r = run(['--help']);
  assert.equal(r.status, 0, `--help must exit 0 with nothing configured; got ${r.status}: ${r.stderr?.slice(0, 300)}`);
  assert.ok(r.stdout.length > 2000, `--help printed ${r.stdout.length} chars — that is not the help text`);

  const taught = [...new Set([...r.stdout.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)].map((m) => m[0]))];
  assert.ok(taught.length > 25, `only found ${taught.length} flags in the rendered help — the regex is wrong, not the CLI`);

  const missing = taught.filter((f) => !KNOWN_FLAG_SPELLINGS.includes(f));
  assert.deepEqual(
    missing, [],
    `--help teaches these flags and the refusal table does not know them: ${missing.join(', ')}. `
    + 'Add them to KNOWN_FLAG_SPELLINGS in lib/cli-args.mjs.',
  );
});

test('the command words are the ones the parser and bin actually claim', () => {
  for (const word of ['leases', 'spend', 'engines', 'config', 'verify', 'board', 'rewind', 'mcp', 'completion']) {
    assert.ok(KNOWN_COMMAND_WORDS.includes(word), `${word} dispatches as a command and is not in KNOWN_COMMAND_WORDS`);
  }
});

/**
 * ⚠️ A GUARD THAT CANNOT FAIL IS WORSE THAN NO GUARD. Each of these breaks the
 * input the real assertion reads and asserts FIRST that the break landed.
 */
test('MUTATION: hide a flag from the table and the drift fence goes red', () => {
  const trimmed = KNOWN_FLAG_SPELLINGS.filter((f) => f !== '--doctor');
  assert.equal(trimmed.length, KNOWN_FLAG_SPELLINGS.length - 1, 'the mutation removed nothing — --doctor is not in the table');

  const missing = ['--doctor', '--json'].filter((f) => !trimmed.includes(f));
  assert.deepEqual(missing, ['--doctor'], 'the subset check does not notice a removed name');
});

test('MUTATION: an empty prompt list is not a refusal — a bare `acuvo` opens the prompt', () => {
  assert.equal(mistypedArgument([]), null, 'a bare `acuvo` must still open the interactive prompt');
  assert.equal(mistypedArgument(['']), null);
  const r = parseArgv([]);
  assert.equal(r.ok, true);
  assert.equal(r.options.task, '');
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE SUGGESTION ENGINE, ON ITS OWN
 * ══════════════════════════════════════════════════════════════════════════ */

test('nearestKnownFlag never answers with a one- or two-character alias', () => {
  /**
   * Every short name is within edit distance of everything, so without the
   * length floor `-h` wins by accident and the tool confidently tells a user
   * the wrong thing — the one behaviour a suggestion may never have.
   */
  for (const typo of ['-doctro', '-budgett', '-parallell']) {
    const near = nearestKnownFlag(typo, 3);
    assert.ok(near === null || near.length > 3, `${typo} was answered with ${near}`);
  }
});

test('nearestKnownFlag refuses to guess when nothing is close', () => {
  assert.equal(nearestKnownFlag('-zz', 3), null);
  assert.equal(nearestKnownFlag('-qwertyuiop', 3), null);
  assert.equal(nearestKnownFlag('', 3), null);
  assert.equal(nearestKnownFlag('--', 3), null);
});

test('unknownOptionMessage always points at --help, with or without a suggestion', () => {
  assert.match(unknownOptionMessage('--zzzzzzz'), /acuvo --help/);
  assert.match(unknownOptionMessage('--doctro'), /acuvo --help/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * ⭐ THE END-TO-END REACH — a pure function nothing calls is not a fix
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ SPAWNED: `acuvo doctor` exits 64, explains itself, and never reaches a model', () => {
  const r = run(['doctor']);

  assert.equal(
    r.status, EXIT_USAGE,
    `\`acuvo doctor\` exited ${r.status}, not ${EXIT_USAGE}. Anything else means it got past the parser: ${r.stdout.slice(0, 400)}`,
  );
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /--doctor/, 'the refusal did not name the flag the user meant');
  assert.match(out, /paid run/i, 'the refusal did not say why it refused');

  /**
   * ⚠️ THE TELL THAT IT NEVER STARTED. A real run prints the opening banner
   * (`Acuvo Code v…`, the workspace, the model, who is paying) before its first
   * round. If any of that appears here, the guard let it through and the exit
   * code is the wrong thing to have asserted.
   */
  assert.doesNotMatch(out, /Acuvo Code v/, 'the banner printed — a run started before the refusal');
  assert.doesNotMatch(out, /rounds ·/, 'the run header printed — the guard did not hold');
});

test('⭐ SPAWNED: the refusal is TERSE — the answer is not buried under the help text', () => {
  const r = run(['doctor']);
  const out = `${r.stdout}${r.stderr}`;
  /**
   * `bin/acuvo.mjs` prints all of USAGE under a parse error, which is right for
   * a structural mistake and wrong here: the sentence that answers the question
   * would scroll off the top of the terminal underneath 150 lines of options.
   */
  assert.ok(
    out.split('\n').length < 12,
    `the refusal is ${out.split('\n').length} lines — the suggestion is buried:\n${out.slice(0, 600)}`,
  );
  assert.ok(!out.includes('Write→run→fix rounds'), 'the whole help text was dumped under a one-line answer');
});

test('⭐ SPAWNED: --version and --help still work, with nothing configured', () => {
  const v = run(['--version']);
  assert.equal(v.status, 0, `--version exited ${v.status}: ${v.stderr.slice(0, 200)}`);
  assert.match(v.stdout, /^acuvo-code \d+\.\d+\.\d+/);

  const h = run(['--help']);
  assert.equal(h.status, 0, `--help exited ${h.status}: ${h.stderr.slice(0, 200)}`);
  assert.ok(h.stdout.includes('--doctor'), '--help no longer names --doctor');
});

test('⭐ SPAWNED: `acuvo --doctor` is still reached — the guard must not shadow the real flag', () => {
  /**
   * ⚠️ `--doctor` PROBES THE NETWORK, so this runs it `--offline`: no request
   * leaves the machine and no key is sent. What is being asserted is REACH —
   * that the flag still runs its own report — not what the report says, so the
   * exit code is deliberately not pinned (0 when nothing is broken, 1 when
   * something is, and on a bare test machine plenty is).
   */
  const r = run(['--doctor', '--offline']);
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(
    /MODEL CHAIN|MEDIA|live|dark|broken/i.test(out),
    `--doctor --offline printed nothing that looks like the report (exit ${r.status}):\n${out.slice(0, 500)}`,
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * ⭐ NO SUPPLIER NAMES IN THE SHIPPED SURFACE
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── ⚠️⚠️ WHY THIS IS A TEST AND NOT A COMMIT MESSAGE ────────────────────────
 *
 * `--help` printed "OpenRouter model id (default: $OPENROUTER_CODEGEN_MODEL,
 * else deepseek/deepseek-v4-flash-0731)" — who we buy from, an internal
 * variable, and a vendor model id, on every customer's machine. It also taught
 * "(from a clone, without installing: node bin/acuvo.mjs)", and an outside
 * reader followed exactly that route to conclude they never had to pay for the
 * product. Both survived a sanitisation sweep, which is precisely why the rule
 * now has a guard rather than a memory.
 *
 * ⚠️ `OPENROUTER_API_KEY` IS THE ONE DELIBERATE EXCEPTION and it is not a slip:
 * it is a variable a user may already have exported, `test/help-names-every-flag.test.mjs`
 * asserts it stays documented beside `--login`, and a credential you cannot
 * find the name of is a credential you cannot turn off. Everything else goes.
 */
test('⚠️⚠️ --help names no supplier, no vendor model id, and no clone path', () => {
  const help = run(['--help']).stdout;

  const banned = [
    ['OpenRouter model', 'the model row named our supplier'],
    ['openrouter.ai', 'a supplier hostname'],
    ['OPENROUTER_CODEGEN_MODEL', 'an internal supplier-named variable — --model and ACUVO_MODEL are the user-facing knobs'],
    ['deepseek/', 'a raw vendor model id — lib/acuvo-models.mjs exists so these never ship'],
    ['qwen/', 'a raw vendor model id'],
    ['node bin/acuvo.mjs', 'the clone path, which teaches a reader they need not pay'],
    ['from a clone', 'the clone path'],
  ];

  const found = banned.filter(([needle]) => help.includes(needle)).map(([needle, why]) => `${needle} (${why})`);
  assert.deepEqual(found, [], `--help leaks:\n  ${found.join('\n  ')}`);
});

test('⭐ --help teaches the install and the sign-in that actually exist', () => {
  const help = run(['--help']).stdout;
  assert.ok(help.includes('npm i -g acuvo-code'), '--help does not say how to install the thing being read');
  assert.ok(help.includes('acuvo --login'), '--help does not say how to sign in, which is the only route off BYOK');
});

test('⭐ the --model row names OUR models, and the default among them', () => {
  // Derived from `selectableModels()`, so re-pointing a name stays a one-line
  // change in lib/acuvo-models.mjs rather than a string hunt.
  assert.match(USAGE, /^ {2}--model <id> .*acuvo-flash/m, `the --model row does not offer our own names:\n${USAGE.split('\n').find((l) => l.startsWith('  --model')) ?? '(row missing)'}`);
});

test('⚠️ the mcp rows are spelled `acuvo mcp …`, not as bare words among the flags', () => {
  /**
   * Spelled `mcp add <server>` inside the OPTIONS block, they were three of the
   * rows teaching "dashes are optional here" — and `doctor`, the word that is
   * NOT a command, cost $0.0066 as a task prompt.
   */
  for (const verb of ['list', 'add', 'remove', 'search']) {
    assert.ok(
      USAGE.includes(`acuvo mcp ${verb}`),
      `the \`mcp ${verb}\` row is not prefixed \`acuvo \` — it reads as a flag-shaped bare word`,
    );
  }
  assert.doesNotMatch(USAGE, /^ {2}mcp (add|list|remove|search)/m, 'a bare `mcp …` row is back in the options block');
});
