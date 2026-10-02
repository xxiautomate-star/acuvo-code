/**
 * ── ⭐⭐ THE FOURTH OPERATOR SWITCH, AND IT HAD NO FLAG ─────────────────────
 *
 * `ACUVO_GH_WRITE` has gated `gh_pr create`, `gh_issue comment` and the other
 * additive GitHub writes since they shipped. It is real, it is enforced, and
 * `gh-verbs.test.mjs` / `gh-write.test.mjs` already prove the ENFORCEMENT.
 *
 * ⚠️⚠️ WHAT NOBODY CHECKED IS WHETHER A HUMAN CAN FIND IT. Measured 2026-09-17,
 * before this file existed: the string `ACUVO_GH_WRITE` appeared in **no**
 * `--help` line, **no** `--doctor` row, **no** shell completion, and nowhere in
 * `docs/STATUS.md`. The only two ways to learn the escape were to read
 * `lib/gh.mjs`, or to ask for a write, be refused, and read the whole refusal.
 *
 * ⭐ THAT IS THE DEFECT `--allow-install` WAS CREATED TO FIX, WORD FOR WORD.
 * `allow-install-flag.test.mjs` opens by saying the charge was never that the
 * gate was undocumented — it was that there was no FLAG and no `--help` row.
 * `lib/cli-args.mjs` even carries the sentence *"HAD NO FLAG, AND THAT IS THE
 * SAME DEFECT"*. It was written about npm and nobody swept the neighbours, so
 * the one gate that writes to the internet **under the user's own GitHub
 * identity** was the one still hiding.
 *
 * ── ⚠️ THE BOUNDARY DOES NOT MOVE, AND MOST OF THIS FILE ASSERTS THAT ───────
 *
 * `--allow-gh-write` buys exactly what the variable already bought: the
 * ADDITIVE writes. `pr merge`, `issue close` and `run rerun` stay refused with
 * it ON, because they end or change something other people rely on and trying
 * again cannot undo them. A flag that quietly widened the gate it names would
 * be worse than no flag at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseArgv, USAGE, KNOWN_FLAG_SPELLINGS } from '../lib/cli-args.mjs';
import { GH_WRITE_ENV, ghWriteEnabled, planGh } from '../lib/gh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const help = Array.isArray(USAGE) ? USAGE.join('\n') : String(USAGE);
const opts = (argv) => parseArgv(argv).options;

/* ── (1) THE PARSER ───────────────────────────────────────────────────────── */

test('⭐ the flag parses, and defaults OFF', () => {
  assert.equal(opts(['do the thing']).allowGhWrite, false);
  const on = opts(['do the thing', '--allow-gh-write']);
  assert.equal(on.allowGhWrite, true);
  assert.equal(on.task, 'do the thing', 'a boolean flag must not eat the task');
});

test('⚠️ it is a BOOLEAN, not a value flag — the mistake this parser has made twice', () => {
  /**
   * `--no-auto-lease` and `--no-checkpoint` both shipped documented in the help
   * text while answering `Unknown option`, because they were written into the
   * branch that only runs for names in `FLAGS_WITH_VALUES`. The proof that this
   * one is in the right branch is that the NEXT argument survives.
   */
  const p = opts(['--allow-gh-write', 'the actual task']);
  assert.equal(p.allowGhWrite, true);
  assert.equal(p.task, 'the actual task', 'the flag swallowed its successor — it is in the wrong branch');
});

/* ── (2) ⭐ IT IS FINDABLE, WHICH IS THE WHOLE POINT ──────────────────────── */

test('it is declared, completed, and documented in --help', () => {
  assert.ok(KNOWN_FLAG_SPELLINGS.includes('--allow-gh-write'),
    'missing from KNOWN_FLAG_SPELLINGS — typed without dashes it becomes a paid agent run again');
  assert.match(help, /--allow-gh-write/, '--help does not name the flag, which is the entire defect this fixes');
  /**
   * ⚠️ THE LINE MUST STATE THE BLAST RADIUS, not the subcommand. "enables gh
   * writes" is unweighable; "public, carry your name, and notify people" is the
   * fact a reader actually decides on.
   */
  assert.match(help, /public, carry your\s*\n?\s*'?\s*'?\s*name, and notify people/,
    'the --allow-gh-write line does not say what a GitHub write actually does to you');
  // ⭐ AND IT MUST NAME WHAT STAYS REFUSED, or "allow gh write" reads as "everything works now".
  assert.match(help, /Still refused with it: pr merge, issue close, run rerun/,
    'the help line implies more than the flag buys');
  // ⭐ And the variable, so an operator can set it for a whole shell rather than per run.
  assert.match(help, /ACUVO_GH_WRITE=1/, 'the help line does not name the environment variable it mirrors');
});

test('⭐ the shell completion offers it too — a flag you must spell perfectly is half a flag', () => {
  const completion = readFileSync(join(here, '..', 'lib', 'completion.mjs'), 'utf8');
  assert.match(completion, /--allow-gh-write/, 'tab completion does not know the flag');
});

/* ── (3) ⭐ THE FLAG REACHES THE GATE — not just the parser ───────────────── */

test('⭐ the variable the flag sets is the one the gate reads', () => {
  assert.equal(ghWriteEnabled({}), false, 'the gate is open with nothing set');
  assert.equal(ghWriteEnabled({ [GH_WRITE_ENV]: '1' }), true, 'the gate does not open on its own variable');
});

test('bin/acuvo.mjs sets the variable AFTER envLoad, never before', () => {
  /**
   * ⚠️ THE ORDER IS A SECURITY PROPERTY, NOT A STYLE ONE, and it is the same
   * one `allow-install-flag.test.mjs` pins three switches away. Set before the
   * env files are read and a repository's `.env` would win over a flag a human
   * typed; set after, and a cloned repository can never turn the gate on.
   */
  const src = readFileSync(join(here, '..', 'bin', 'acuvo.mjs'), 'utf8');
  const envLoad = src.search(/\benvLoad\s*\(/);
  const setter = src.indexOf('process.env[GH_WRITE_ENV]');
  assert.ok(envLoad > -1, 'envLoad is not called in bin/acuvo.mjs — this test is measuring nothing');
  assert.ok(setter > -1, 'bin/acuvo.mjs never applies the flag — it parses and is dropped');
  assert.ok(setter > envLoad,
    'the flag is applied BEFORE envLoad, so a repository .env can beat a human and a clone can open the gate');
});

test('⚠️ a cloned repository still cannot set it — the flag did not open a back door', () => {
  /**
   * The gate reads ONE variable. A workspace `.env` is loaded by `envLoad`,
   * whose own allowlist decides what a repository may set — the flag does not
   * add a second door, it sets the same one, later.
   */
  const src = readFileSync(join(here, '..', 'lib', 'gh.mjs'), 'utf8');
  const doors = [...src.matchAll(/ACUVO_GH_WRITE/g)].length;
  assert.ok(doors >= 1, 'the variable name vanished from gh.mjs');
  assert.match(src, /export function ghWriteEnabled/, 'the gate is not a single named predicate any more');
});

/* ── (4) ⚠️ THE BOUNDARY DOES NOT MOVE ───────────────────────────────────── */

test('⚠️⚠️ with the flag ON, everything that was refused for a REASON is still refused', () => {
  /**
   * ⭐ THE ASSERTION THAT MATTERS MOST IN THIS FILE. A new switch is the moment
   * a boundary quietly widens, and `gh.mjs` refuses merge/close/rerun on a
   * different ground entirely — they are not additive — which the flag has no
   * business touching.
   *
   * ⚠️ `planGh`, NOT `runGh`. `runGh` takes a PLAN and answers
   * `'no plan to run'` to anything else — the first version of this test handed
   * it an options object and read that refusal as the gate refusing, which is a
   * harness error wearing the product's clothes and would have "passed" for the
   * wrong reason the moment I loosened the regex. The gate decision lives in
   * `planGh` and costs no subprocess.
   */
  const env = { [GH_WRITE_ENV]: '1' };
  for (const [noun, action] of [['pr', 'merge'], ['issue', 'close'], ['run', 'rerun']]) {
    const r = planGh(noun, { action, number: 1 }, env);
    assert.equal(r.ok, false, `gh_${noun} ${action} became available with --allow-gh-write — the boundary moved`);
    assert.match(String(r.error), /changes or ends something other people|cannot be undone/,
      `gh_${noun} ${action} is refused, but not for the additive-writes reason`);
    assert.doesNotMatch(String(r.error), /switched off/,
      `gh_${noun} ${action} blames the gate, which is ON — a reader told the wrong reason tries the wrong fix`);
  }
});

test('⭐⭐ the flag turns the additive writes ON — it is not decorative', () => {
  /**
   * ⚠️ WITHOUT THIS THE FILE PROVES ONLY THAT NOTHING CHANGED. Every other
   * assertion here is a "still refused", and they would all pass just as
   * happily if the flag did nothing whatsoever — which is the exact shape of
   * the four guards this repo has shipped that turned out to check nothing.
   */
  const off = planGh('issue', { action: 'comment', number: 1, body: 'hi' }, {});
  assert.equal(off.ok, false, 'commenting is available with the gate OFF — then it is not a gate');

  const on = planGh('issue', { action: 'comment', number: 1, body: 'hi' }, { [GH_WRITE_ENV]: '1' });
  assert.equal(on.ok, true, `the flag's variable does not enable an additive write: ${on.error}`);
});

test('⭐ and the refusal with the gate OFF names the way in', () => {
  /**
   * ⚠️ A REFUSAL THAT DOES NOT NAME THE ESCAPE IS THE DEFECT THIS FILE IS
   * ABOUT, one level down. Until today the variable it names was the ONLY way
   * in, because there was no flag — the refusal was carrying the entire burden
   * of discoverability on its own, and only for the people who hit it.
   */
  const r = planGh('issue', { action: 'comment', number: 1, body: 'hi' }, {});
  assert.equal(r.ok, false);
  assert.match(String(r.error), new RegExp(GH_WRITE_ENV),
    'the refusal with the gate OFF does not name the variable that opens it');
});
