/**
 * ── ⚠️⚠️⭐ THE DIRECTION NO TEST CHECKED: PARSED → DOCUMENTED ───────────────
 *
 * `test/cli-flags-parse.test.mjs` already asserts that every flag `--help`
 * ADVERTISES is one the parser accepts. That is the documented→reachable
 * direction, and it cannot see the failure that actually shipped.
 *
 * Measured against the real `node bin/acuvo.mjs --help` output on 2026-08-19,
 * on a clean tree:
 *
 *   grep -c login   →  0
 *   grep -c logout  →  0
 *   grep -c whoami  →  0
 *   grep -c version →  0
 *
 * All four flags worked. `acuvo --version` printed "acuvo-code 0.2.0".
 * `acuvo --whoami` printed "Using OPENROUTER_API_KEY from your environment
 * (BYOK) … Run `acuvo --login` with an Acuvo key to use your credits instead."
 *
 * ⚠️ SO `--whoami` INSTRUCTED THE USER TO RUN A COMMAND `--help` DID NOT LIST,
 * while the Environment section called OPENROUTER_API_KEY "required — the only
 * one needed to write code". The single route off BYOK — the mode the whole
 * business depends on NOT being the default — was invisible to anyone who read
 * the front door end to end. A capability nobody can find has not shipped.
 *
 * ── ⭐ THE LIST IS DERIVED, NOT TYPED OUT ───────────────────────────────────
 * This file reads the flag names out of `extractLifecycleFlags` and
 * `VALUED_LIFECYCLE_FLAGS` in bin/acuvo.mjs — the parse sites themselves. Add a
 * fourteenth lifecycle flag and forget the help text, and this goes red without
 * anyone editing this file. That is the same principle item 14 applied to
 * `/help`, which generates itself from `SLASH_COMMANDS` precisely so a second
 * hand-maintained copy cannot go stale.
 *
 * ── ⚠️ AND IT ASSERTS ITS OWN EXTRACTION IS NOT VACUOUS ─────────────────────
 * A source-slicing guard whose anchors have drifted matches nothing, finds
 * nothing missing, and reports green forever. Every anchor is asserted found
 * and the flag count is floored before anything else is checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'acuvo.mjs');

/** U+FFFD REPLACEMENT CHARACTER — bytes EF BF BD. */
const REPLACEMENT_CHAR = '�';

/**
 * The lifecycle + auth flags bin/acuvo.mjs actually parses, read out of the two
 * places it parses them. `--login=<token>` collapses to `--login`, which is
 * correct: it is one flag with two spellings, and the help text names one.
 */
function parsedLifecycleFlags() {
  /**
   * ── ⚠️⚠️ CRLF NORMALISED, AND THIS IS THE WINDOWS CI FAILURE ───────────────
   *
   * The anchors below search for `'\n}\n'`. On Windows the working copy has
   * CRLF terminators, so the file actually contains `\r\n}\r\n` and that search
   * NEVER matches — the test fails with "could not find the end of
   * extractLifecycleFlags", which reads like the function was renamed rather
   * than like a line-ending problem.
   *
   * ⭐ THIS IS THREE OF THE EIGHT WINDOWS-ONLY CI FAILURES, and they were being
   * carried as "undiagnosed" while the same suite ran green on a checkout with
   * LF endings. A guard that slices source text has to be agnostic about how
   * the checkout stored its newlines, or it is asserting something about git
   * configuration rather than about the code.
   */
  const src = readFileSync(BIN, 'utf8').replace(/\r\n/g, '\n');

  const start = src.indexOf('const VALUED_LIFECYCLE_FLAGS = new Map([');
  assert.notEqual(
    start, -1,
    'VALUED_LIFECYCLE_FLAGS is gone or renamed — this guard is slicing source and its anchor moved. Fix the anchor; do not delete the test.',
  );

  const fnAt = src.indexOf('function extractLifecycleFlags', start);
  assert.notEqual(
    fnAt, -1,
    'extractLifecycleFlags is gone or renamed — same reason as above.',
  );

  const end = src.indexOf('\n}\n', fnAt);
  assert.notEqual(end, -1, 'could not find the end of extractLifecycleFlags');

  const slice = src.slice(start, end);
  return [...new Set([...slice.matchAll(/'(--[a-z][a-z-]*)/g)].map((m) => m[1]))].sort();
}

/** The front door exactly as a user sees it. */
function renderedHelp() {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `--help must exit 0 with nothing configured; got ${r.status}: ${r.stderr?.slice(0, 300)}`);
  assert.ok(r.stdout.length > 2000, `--help printed ${r.stdout.length} chars — that is not the help text`);
  return r.stdout;
}

/** The check itself, as a pure function, so the mutation test can drive it. */
function flagsMissingFrom(helpText, flags) {
  return flags.filter((flag) => !helpText.includes(flag));
}

test('the extraction is not vacuous — it finds the flags that certainly exist', () => {
  const flags = parsedLifecycleFlags();
  assert.ok(
    flags.length >= 13,
    `only extracted ${flags.length} lifecycle flags (${flags.join(', ')}) — the slice is wrong, not the CLI`,
  );
  for (const known of ['--login', '--logout', '--whoami', '--sessions', '--resume', '--replay']) {
    assert.ok(flags.includes(known), `the extraction missed ${known}, which is parsed on the very line it slices`);
  }
});

test('⚠️⚠️ EVERY lifecycle flag the CLI parses is named in --help', () => {
  const flags = parsedLifecycleFlags();
  const help = renderedHelp();
  const missing = flagsMissingFrom(help, flags);

  assert.deepEqual(
    missing, [],
    `these flags work and --help never mentions them: ${missing.join(', ')}. `
    + 'A user cannot run what they cannot find. Document them where people look.',
  );
});

test('⭐ --version too — parsed in cli-args, and it is how you check the install worked', () => {
  const help = renderedHelp();
  assert.ok(help.includes('--version'), '--version is parsed above the key check and was absent from --help');

  const r = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, '--version must work with nothing configured');
  assert.match(r.stdout, /^acuvo-code \d+\.\d+\.\d+/, `--version printed: ${JSON.stringify(r.stdout)}`);
});

test('⭐ the interactive prompt exists, so --help says so and names /help', () => {
  const help = renderedHelp();
  assert.ok(help.includes('/help'), 'six slash commands ship and the front door never mentioned the prompt they live at');
});

test('⚠️ no U+FFFD in the help text — two were committed into SOURCE, not rendered', () => {
  const help = renderedHelp();
  const count = [...help].filter((c) => c === REPLACEMENT_CHAR).length;
  assert.equal(
    count, 0,
    `${count} U+FFFD replacement characters in --help. They were bytes EF BF BD in lib/cli-args.mjs, `
    + 'where a `·` separator belongs — a mojibake round-trip, not a terminal artifact.',
  );
});

/**
 * ── ⚠️⚠️ THE MUTATION TESTS ────────────────────────────────────────────────
 *
 * A guard that cannot fail is worse than no guard: it reports green and proves
 * nothing. Each of these breaks the input the real assertion above reads, and
 * asserts FIRST that the break actually landed — a mutation that silently
 * matches nothing is exactly the failure shape being defended against.
 */
test('MUTATION: drop --whoami from the help and the flag check goes red', () => {
  const flags = parsedLifecycleFlags();
  const help = renderedHelp();

  assert.ok(help.includes('--whoami'), 'precondition: the real help names --whoami');

  const mutated = help.split('\n').filter((line) => !line.includes('--whoami')).join('\n');

  // ⚠️ ASSERT THE MUTATION APPLIED. Without this the next assertion could pass
  // because nothing changed rather than because the guard works.
  assert.notEqual(mutated, help, 'the mutation changed nothing — it matched no line');
  assert.ok(!mutated.includes('--whoami'), 'the mutation did not remove every mention');

  const missing = flagsMissingFrom(mutated, flags);
  assert.deepEqual(missing, ['--whoami'], `the guard did not notice the removal; it reported ${JSON.stringify(missing)}`);
});

test('MUTATION: put a U+FFFD back and the mojibake check goes red', () => {
  const help = renderedHelp();
  const mutated = help.replace('--since 7d', `--since 7d ${REPLACEMENT_CHAR}`);

  assert.notEqual(mutated, help, 'the mutation changed nothing — the anchor text moved');

  const count = [...mutated].filter((c) => c === REPLACEMENT_CHAR).length;
  assert.equal(count, 1, 'the injected replacement character is the only one, and the check counts it');
});

/**
 * ⭐ THE ONE THAT NAMES THE DOCTRINE. BYOK is the fallback, not the product
 * (memory: `project_acuvo_cli_byok_never_and_licence` — Roman, twice). The help
 * text used to say OPENROUTER_API_KEY was "required — the only one needed to
 * write code", which is the opposite sentence. Keyed off identifiers, not
 * prose, so the paragraph can be rewritten freely.
 */
test('⚠️ --help does not present OPENROUTER_API_KEY as the only way in', () => {
  const help = renderedHelp();

  assert.ok(
    help.includes('OPENROUTER_API_KEY'),
    'the BYOK fallback still exists and must still be documented',
  );
  assert.ok(
    !/OPENROUTER_API_KEY\s+required — the only one/.test(help),
    'the help text still calls the BYOK key the only way to write code',
  );

  /**
   * ⚠️ NOT A POSITIONAL ASSERTION. My first version demanded `--login` appear
   * before `OPENROUTER_API_KEY` in the byte stream, which is an accident of
   * which array is concatenated first and would fire on any reordering. What
   * actually matters is that the person reading the BYOK entry — the one about
   * to go export a provider key — is told there is another way, right there.
   */
  const keyAt = help.indexOf('OPENROUTER_API_KEY');
  assert.notEqual(keyAt, -1, 'precondition: the BYOK variable is documented');

  const entry = help.slice(keyAt, keyAt + 400);
  assert.ok(
    entry.includes('--login'),
    `the OPENROUTER_API_KEY entry never names the way off BYOK. It reads:\n${entry.split('\n').slice(0, 6).join('\n')}`,
  );
});
