/**
 * ── ⚠️⚠️ A FLAG CAN BE WRITTEN, DOCUMENTED, AND COMPLETELY UNREACHABLE ───────
 *
 * `--no-auto-lease` shipped on 2026-08-13 with a row in the README options
 * table, five lines of `--help`, a lib module behind it and a passing suite —
 * and typing it answered:
 *
 *     Unknown option --no-auto-lease. Run with --help.
 *
 * It had been written into the branch that handles flags TAKING A VALUE, which
 * is only entered for names in `FLAGS_WITH_VALUES`. The line was there. It was
 * never reached.
 *
 * ⭐ AND THE GUARD THAT EXISTS FOR EXACTLY THIS REPORTED GREEN. "every flag the
 * parser accepts has a row in the README options table" greps the SOURCE for
 * flag strings and compares them to the docs. Both sides said `--no-auto-lease`,
 * so both agreed — about a flag that did not work. A test that reads code
 * cannot see behaviour.
 *
 * So this file does the only thing that settles it: it takes the flags out of
 * `--help` and drives every one of them through the real parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, USAGE } from '../lib/cli-args.mjs';

/**
 * Every long flag `--help` advertises, read from the help text itself so a new
 * flag is covered the moment it is documented — which is the moment it starts
 * making a promise to a user.
 */
function documentedFlags() {
  return [...new Set([...String(USAGE).matchAll(/^\s{2}(--[a-z][a-z-]*)/gm)].map((m) => m[1]))];
}

test('the help text actually lists flags — otherwise this whole file is vacuous', () => {
  const flags = documentedFlags();
  assert.ok(flags.length > 15, `only found ${flags.length} flags in USAGE — the regex is wrong, not the CLI`);
  assert.ok(flags.includes('--budget'), 'the scan missed a flag that certainly exists');
});

test('⚠️⚠️ EVERY documented flag is REACHABLE — not merely present in the source', () => {
  /**
   * A value-taking flag is given a plausible value; a boolean is passed bare.
   * Either way the only thing asserted is that the parser does not answer
   * "Unknown option", because that is the failure that shipped.
   */
  const values = {
    '--dir': '.', '--model': 'x/y', '--max-tokens': '1000', '--timeout': '60',
    '--max-rounds': '3', '--command-timeout': '30', '--budget': '0.10',
    '--fleet-budget': '1.00', '--lease': 'src/a.ts', '--holder': 't1',
    '--since': '7d', '--max-tier': 'solo', '--best-of': '2', '--issue': '1',
    '--concurrency': '2', '--resume': 'x', '--tasks': 'a',
  };

  const unreachable = [];
  for (const flag of documentedFlags()) {
    const argv = values[flag] !== undefined ? [flag, values[flag], 'a task'] : [flag, 'a task'];
    const r = parseArgv(argv);
    if (r.ok === false && /Unknown option/.test(r.error)) unreachable.push(flag);
  }

  assert.deepEqual(
    unreachable, [],
    `these flags are documented and the parser rejects them outright: ${unreachable.join(', ')}`,
  );
});

test('⭐ the two that shipped broken, pinned by name', () => {
  const a = parseArgv(['--no-auto-lease', 'a task']);
  assert.equal(a.ok, true, `--no-auto-lease: ${a.ok === false ? a.error : ''}`);
  assert.equal(a.options.autoLease, false, 'the flag parsed but changed nothing');

  const b = parseArgv(['--claim', '--holder', 't1']);
  assert.equal(b.ok, true, `--claim: ${b.ok === false ? b.error : ''}`);
  assert.equal(b.options.claim, true);
});

test('⚠️ and the defaults are still the defaults — a flag that fires unasked is worse', () => {
  const r = parseArgv(['just a task']);
  assert.equal(r.ok, true);
  assert.equal(r.options.autoLease, true, 'auto-leasing is on by default');
  assert.equal(r.options.claim, false, 'nothing may claim board work unless asked');
  assert.equal(r.options.command, null, 'an ordinary task must not be read as a command');
});

test('⭐ `board` takes arguments, and "board" in a sentence is still a task', () => {
  const bare = parseArgv(['board']);
  assert.equal(bare.options.command, 'board');

  const added = parseArgv(['board', 'add', 'make the suite pass']);
  assert.equal(added.options.command, 'board');
  assert.deepEqual(added.options.boardArgs, ['add', 'make the suite pass']);

  const sentence = parseArgv(['the board is rendering wrong']);
  assert.equal(sentence.options.command, null, 'an instruction that mentions a board is not the board command');
  assert.equal(sentence.options.task, 'the board is rendering wrong');
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE LONG-HORIZON CEILING
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐⭐ the long-horizon ceiling is GONE when money is bounding the run', () => {
  /**
   * Roman, 2026-08-23: *"yes we need long horizon ceiling gone."*
   *
   * A budget is in force on every ordinary run (`DEFAULT_BUDGET_USD`), and
   * `turn.mjs` refuses the round it cannot afford BEFORE starting it. So the
   * round count was never what protected the bill — it was a backstop against a
   * bug in the governor, pinned at a number that had begun deciding benchmark
   * scores rather than bounding spend.
   */
  const ok = parseArgv(['--max-rounds', '500', 'do the thing']);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.options.maxRounds, 500);
});

test('⚠️⚠️ --budget none KEEPS the low ceiling — both nets must not vanish at once', () => {
  /**
   * `--budget none` deliberately removes the money governor. Had the ceiling
   * risen at the same moment, NOTHING would bound the run — which is precisely
   * what raising a single constant would have done, silently.
   */
  const no = parseArgv(['--max-rounds', '500', '--budget', 'none', 'do the thing']);
  assert.equal(no.ok, false);
  assert.match(no.error, /needs a budget to bound it/);

  const fine = parseArgv(['--max-rounds', '64', '--budget', 'none', 'x']);
  assert.equal(fine.ok, true, fine.error);
});

test('⚠️⚠️ FLAG ORDER MUST NOT DECIDE WHETHER A RUN IS ALLOWED', () => {
  /**
   * The ceiling depends on the budget, and the budget can be typed AFTER
   * --max-rounds. Validating only inside the parse loop would accept one
   * ordering and refuse the other — a bug nobody ever reproduces.
   */
  const a = parseArgv(['--budget', 'none', '--max-rounds', '500', 'x']);
  const b = parseArgv(['--max-rounds', '500', '--budget', 'none', 'x']);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.error, b.error, 'the same mistake must get the same answer either way round');
});

test('⚠️ the DEFAULT does not move — a ceiling rising must cost nobody anything', () => {
  const d = parseArgv(['do the thing']);
  assert.equal(d.ok, true, d.error);
  assert.equal(d.options.maxRounds, 24, 'DEFAULT_MAX_ROUNDS must be untouched by this change');
});
