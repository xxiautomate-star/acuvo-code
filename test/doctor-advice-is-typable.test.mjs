import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { KNOWN_COMMAND_WORDS, KNOWN_FLAG_SPELLINGS } from '../lib/cli-args.mjs';

// ⚠️ HERMETIC HOME (2026-09-26). The doctor renders its `acuvo lsp install` advice only when
// ~/.acuvo holds no managed TypeScript, so on a developer machine that had run it, that advice
// was never in this test's universe — green on the owner's laptop, red on a clean one. An empty
// home means every machine checks the SAME advice, including the line that was hidden.
{
  const emptyHome = mkdtempSync(join(tmpdir(), 'acuvo-doctor-advice-'));
  process.env.HOME = emptyHome;
  process.env.USERPROFILE = emptyHome;
  delete process.env.ACUVO_HOME;
}

/**
 * ── ⚠️⚠️ EVERY FLAG THE DOCTOR TELLS YOU TO TYPE MUST EXIST ────────────────
 *
 * It advised "raise the round budget (--rounds N)" in TWO places. There is no
 * `--rounds` flag — it is `--max-rounds` — so `parseArgv` refuses it with
 * "unknown option" and the person is left with a tool that gave advice it then
 * rejected.
 *
 * ⭐ WORSE THAN SAYING NOTHING. The doctor's whole job is to be the one surface
 * you can trust when nothing else works; a fix line that fails turns the last
 * reliable thing into another dead end.
 *
 * ── ⚠️ SCOPED TO THE DOCTOR'S `fix:` LINES, AND THE FIRST VERSION WAS NOT ───
 * My first attempt scanned every string in `lib/` and flagged `--eval`,
 * `--ignore-scripts` and `--always-make` — node's, npm's and make's flags, named
 * legitimately in `command.mjs`'s allowlist. That is a check that fails correct
 * work, which this repo has shipped four times in one day before. A guard is
 * only worth having if the thing it points at is always wrong.
 */
const ROOT = join(import.meta.dirname, '..');

test('⚠️⚠️ every --flag in a doctor fix line can actually be typed', () => {
  const cli = readFileSync(join(ROOT, 'lib', 'cli-args.mjs'), 'utf8')
    + readFileSync(join(ROOT, 'bin', 'acuvo.mjs'), 'utf8');
  const known = new Set([...cli.matchAll(/'(--[a-z][a-z-]*)'/g)].map((m) => m[1]));
  assert.ok(known.size > 15, 'the flag list failed to parse — this test would pass vacuously');

  const doctor = readFileSync(join(ROOT, 'lib', 'doctor.mjs'), 'utf8');
  // Every `fix: '...'` / `fix: "..."` string — the lines we hand a user to type.
  const fixes = [...doctor.matchAll(/fix:\s*(['"`])((?:\.|(?!\1).)*)\1/g)].map((m) => m[2]);
  assert.ok(fixes.length > 5, `expected several fix lines, found ${fixes.length}`);

  const offenders = [];
  for (const fix of fixes) {
    for (const m of fix.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) {
      if (!known.has(m[1])) offenders.push(`${m[1]}  (in: ${fix.slice(0, 70)})`);
    }
  }
  assert.deepEqual(offenders, [], 'the doctor advises flags the CLI would refuse');
});

/**
 * ── 🚨⭐⭐ THE GUARD ABOVE WAS RIGHT AND ITS UNIVERSE WAS TOO SMALL ─────────
 *
 * It asks "does every `--flag` in a fix line exist". **`acuvo login` contains no
 * flag**, so eight doctor lines telling a stranger to *"run `acuvo login`"*
 * sailed straight through it — and `parseArgv` refuses that word by name:
 *
 *     `login` is not a command — did you mean `acuvo --login`?
 *     Without the dashes, acuvo would take `login` as the TASK to work on…
 *
 * So the doctor — *"the one surface you can trust when nothing else works"*, in
 * this file's own words — handed out a command the same binary rejects, in the
 * MEDIA section, which is the section a new paying customer reads first.
 *
 * ⭐ THE LESSON IS THE ONE THIS REPO KEEPS PAYING FOR: a guard fails by SCOPE
 * far more often than by assertion. The shape of wrongness here was not a
 * misspelled flag, it was a word with no dashes at all, and the original pattern
 * could not see it however correct its assertion was.
 *
 * ⚠️ DERIVED FROM THE PARSER'S OWN LISTS, never retyped — a second copy of the
 * command list is a second thing to forget, which is the defect one level up.
 */
/**
 * ── ⚠️⚠️⚠️ AND THE SOURCE REGEX ABOVE SEES BARELY HALF THE FIX LINES ────────
 *
 * Counted 2026-09-18: `lib/doctor.mjs` has **88** `fix:` sites and
 * `/fix:\s*(['"`])…/` captures **48**. The other 40 are ternaries — `fix:
 * explicitlyOff ? … : (cred?.mode !== 'account' ? …)` — where the character
 * after `fix:` is a variable name, not a quote. The MEDIA fixes, the ones that
 * carried this defect, are all in that invisible 40.
 *
 * ⭐ SO THE FIRST VERSION OF THIS TEST PASSED WHILE CHECKING NOTHING, and I only
 * learned that by mutating the defect back in and watching it stay green. That
 * is CLAUDE.md's rule landing on the guard I had just written for it: *"a guard
 * can pass — or FAIL — while checking nothing. Mutate it and prove it bites."*
 *
 * ⭐⭐ THE FIX IS TO DRIVE THE PRODUCT, not to write a cleverer regex. `runDoctor`
 * is fully injectable, so this runs the real reporter over real environment
 * shapes and reads the advice it ACTUALLY renders. A regex can only prove the
 * source text changed; this proves what a user is told.
 */
async function everyRenderedFix() {
  const { runDoctor } = await import('../lib/doctor.mjs');
  /**
   * ⚠️ TWO SHAPES, BECAUSE THE ADVICE BRANCHES ON THE ACCOUNT. The media lines
   * that carried the defect are only reachable when there is NO account — with
   * one, the route exists and the branch is never taken. A single fixture would
   * have re-created the blind spot in a new place.
   */
  const shapes = [
    { name: 'no account, nothing configured', env: {}, credential: { mode: 'unconfigured', token: '', url: null, email: null } },
    { name: 'byok, nothing configured', env: { OPENROUTER_API_KEY: `sk-or-v1-${'0'.repeat(64)}` }, credential: { mode: 'byok', token: 'x', url: null, email: null } },
    { name: 'signed in', env: {}, credential: { mode: 'account', token: `xxi_live_${'0'.repeat(64)}`, url: 'https://acuvo.xxiautomate.com', email: 'a@b.c' } },
  ];

  const fixes = [];
  for (const shape of shapes) {
    const report = await runDoctor({
      env: shape.env,
      credential: shape.credential,
      skipNetwork: true,
      fetchImpl: () => { throw new Error('this guard must not touch the network'); },
      gitStatusImpl: () => ({ ok: false, error: 'not a repo' }),
      mcpConfigImpl: () => ({ ok: true, file: null, servers: [] }),
    });
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      if (typeof node.fix === 'string' && node.fix) fixes.push({ shape: shape.name, fix: node.fix });
      Object.values(node).forEach(walk);
    };
    walk(report);
  }
  return fixes;
}

test('🚨 every `acuvo <word>` the doctor RENDERS is a real command', async () => {
  const commands = new Set(KNOWN_COMMAND_WORDS);
  const flags = new Set(KNOWN_FLAG_SPELLINGS);
  assert.ok(commands.size > 5 && flags.size > 15, 'the parser lists failed to load — this test would pass vacuously');

  const fixes = await everyRenderedFix();
  /**
   * ⚠️ THE VACUITY FLOOR IS THE POINT OF THIS LINE. The version of this test
   * that read the source found 48 strings and checked the wrong 48; a count
   * assertion on RENDERED advice is the only thing that notices if the reporter
   * stops producing any.
   */
  assert.ok(fixes.length > 20, `expected the doctor to render plenty of advice, got ${fixes.length}`);

  /**
   * ⚠️ ONLY `acuvo <word>` — not every word in the sentence. A fix line saying
   * "run `git init` here" is correct advice about a DIFFERENT program, and a
   * pattern wide enough to flag it is the "fails correct work" mistake the test
   * above already documents having made once.
   *
   * ⭐ `[a-z]` FIRST, SO `acuvo --login` NEVER MATCHES — the pattern hunts the
   * DASHLESS spelling specifically, which is what keeps it from flagging the
   * cure alongside the disease.
   */
  const offenders = [];
  for (const { shape, fix } of fixes) {
    // ⚠️ `(?<![\w./~-])` — the PROGRAM name, not the directory: "puts a TypeScript 5 under
    // ~/.acuvo and never touches…" matched as the command `acuvo and`.
    for (const m of fix.matchAll(/(?<![\w./~-])acuvo\s+([a-z][a-z-]*)/g)) {
      const word = m[1];
      if (commands.has(word)) continue;
      offenders.push(
        `acuvo ${word}`
        + (flags.has(`--${word}`) ? `  ← that is a FLAG: write \`acuvo --${word}\`` : '')
        + `  [${shape}] ${fix.slice(0, 80)}`,
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the doctor tells the user to type a bare word the CLI refuses as "not a command" — '
    + 'it is almost always a flag missing its dashes',
  );
});

test('⚠️ advice that names a destination must give one you can open', async () => {
  /**
   * ── ⚠️ "Settings → API keys" NAMED NO DESTINATION ────────────────────────
   *
   * Settings of what, reached how? Five messages in this package said it and
   * not one located it — on the front door of the paid path. A reader who has
   * never seen the console cannot act on it, and "I could not find where to get
   * a key" is where an evaluation ends.
   *
   * ⚠️⚠️ THE FIRST VERSION OF THIS TEST WALKED THE DOCTOR'S REPORT AND PASSED
   * VACUOUSLY, because not one of those five messages is rendered by the
   * doctor — they live in `login.mjs` and `model.mjs`, reached by `--whoami`,
   * by a rejected key, and by running with no key at all. **Same session, same
   * mistake, second time: the assertion was right and the universe was empty.**
   * Caught only by mutating the text back and watching the suite stay green.
   *
   * ⭐ SO IT NOW DRIVES THE ACTUAL EMITTERS. Every string a keyless or
   * badly-keyed user can be shown, collected from the functions that produce
   * them, not from a file they do not live in.
   */
  const { describeAuth, validateTokenShape } = await import('../lib/login.mjs');
  const { MISSING_KEY_MESSAGE } = await import('../lib/model.mjs');

  const shown = [
    ['no key at all', MISSING_KEY_MESSAGE],
    ['--whoami, not logged in', describeAuth({ mode: 'unconfigured' }).line],
    ['--whoami, byok', describeAuth({ mode: 'byok' }).line],
    ['--login with nothing', validateTokenShape('').reason],
    ['--login with a provider key', validateTokenShape('sk-or-v1-abc').reason],
    ['--login with a wrong prefix', validateTokenShape('nope-abc').reason],
    ['--login with a header', validateTokenShape('Bearer xxi_live_abc').reason],
    ['--login truncated', validateTokenShape('xxi_live_short').reason],
    ...(await everyRenderedFix()).map(({ shape, fix }) => [`doctor · ${shape}`, fix]),
  ].filter(([, text]) => typeof text === 'string' && text);

  assert.ok(shown.length > 25, `expected plenty of user-facing text, got ${shown.length}`);

  const offenders = shown
    .filter(([, text]) => /Settings\s*(→|->)\s*API keys/i.test(text) && !/https?:\/\//.test(text))
    .map(([where, text]) => `[${where}] ${text.slice(0, 110)}`);
  assert.deepEqual(offenders, [], 'this advice names a page but never says where it is');
});
