/**
 * ── ⚠️⚠️ `Python side` WAS AN ACCEPTANCE CRITERION ───────────────────────────
 *
 * `acceptance-english-leads.test.mjs` closed the `make`/`go` hole and signed off
 * with *"the other leads are untouched — only make and go are English verbs"*.
 * The reasoning was about VERBS. The hole that was left is a NOUN: `python` is
 * in `COMMAND_LEADS`, and it is also the name of the language, which appears in
 * ordinary prose constantly.
 *
 * MEASURED 2026-08-29 over the 64 distinct Terminal-Bench task strings archived
 * in `bench/terminal-bench/results/`. `deriveAcceptance` returned 7 criteria and
 * FIVE were prose — every one of them from this lead. The sentences below are
 * quoted from those tasks, not invented for the test.
 *
 * ⚠️ WHY IT IS WORSE THAN THE `make` HOLE. A phantom `make` at least names a real
 * binary. `Python side` cannot be executed by anything, so under `--done
 * acceptance` its verdict is `not-run` on every round forever and `doneDecision`
 * returns `continue` forever: the mode silently degenerates into `--done never`
 * and bills the whole round budget for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveAcceptance } from '../lib/acceptance.mjs';

const commands = (s) => deriveAcceptance(s, { source: 'user' }).map((c) => c.command).filter(Boolean);

/**
 * ⭐ THE FIVE REAL SENTENCES. Each one is a verbatim clause from a Terminal-Bench
 * task, with the criterion it used to mint named in the message so a regression
 * says what came back rather than just "not deepEqual".
 */
const ARCHIVE_PROSE = [
  ['The compiled extensions (chelpers, ccomplexity, and cinvariants) should work in their original context from Python side.', 'Python side'],
  ['You must create a new Python script located at /app/program.py, which performs the exact same operations as the COBOL program.', 'Python script located'],
  ['You should feel free to install/use any python packages as long as they are installed system-wide.', 'python packages as long as they'],
  ['You may install system-wide python packages or even use other languages, but the entrypoint must be a Python function in /app/eigen.py.', 'python packages'],
  ['For your submission to be successful, the results must exactly match the Python baseline within a tolerance.', 'Python baseline'],
];

test('⚠️⚠️ the five prose criteria the archive actually produced are all refused', () => {
  for (const [sentence, phantom] of ARCHIVE_PROSE) {
    assert.deepEqual(
      commands(sentence), [],
      `the phantom \`${phantom}\` is back — an unrunnable criterion that reports UNMET forever`,
    );
  }
});

test('⭐⭐ AND REAL python COMMANDS SURVIVE — refusing one the user typed is the same bug backwards', () => {
  assert.deepEqual(commands('python3 solve.py must pass'), ['python3 solve.py']);
  assert.deepEqual(commands('python ./run.py must pass'), ['python ./run.py']);
  assert.deepEqual(commands('python setup.py build must succeed'), ['python setup.py build']);
  /**
   * ⚠️ THE FLAG FORMS, which carry no dot or slash and would die to a
   * path-shaped rule alone.
   */
  assert.deepEqual(commands('python -m unittest must pass'), ['python -m unittest']);
  assert.deepEqual(commands('python3 -c "import numpy" must succeed'), ['python3 -c']);
});

/**
 * ⚠️ SIGNAL 1 IS ABOUT CASE AND IT IS NOT PYTHON-SPECIFIC. `normaliseCommand` is
 * documented case-SENSITIVE — "`NPM TEST` is not the command" — but the lead was
 * matched lowercased and STORED raw, so any capitalised lead minted a criterion
 * no case-sensitive OS can run.
 */
test('⚠️ a CAPITALISED lead is the language or the sentence, never the binary', () => {
  assert.deepEqual(commands('the results must match the Node baseline'), []);
  assert.deepEqual(commands('you should verify the Make targets are correct'), []);
  /**
   * ⚠️ SENTENCE-INITIAL TOO, DELIBERATELY. Exempting it keeps `Npm test` alive as
   * a criterion, and `Npm test` reports "✖ UNMET — it was never run" over work
   * that was correct. Both readings lose the intent; only one invents a failure.
   */
  assert.deepEqual(commands('Refactor the module. Npm test must pass.'), []);
  // …and the lowercase form in the same position is still perfectly fine.
  assert.deepEqual(commands('Refactor the module. npm test must pass.'), ['npm test']);
});

/**
 * ⭐⭐ THE BACKTICKED PATH NEVER REACHES `leadIsCommand`, AND THAT IS THE SAFETY
 * ARGUMENT FOR THE WHOLE CHANGE. Of the seven criteria the archive produced, the
 * two that were RIGHT were both backticked. A user who quotes their command is
 * untouched by construction — this only tightens the 0.6-confidence prose scan.
 */
test('⭐ quoting your command bypasses the prose rules entirely', () => {
  assert.deepEqual(commands('to verify the fix you can run: `pytest -rA`.'), ['pytest -rA']);
  assert.deepEqual(commands('implement it so that I can run `node vm.js` and it must work'), ['node vm.js']);
  /**
   * Even the shapes the bare scan now refuses survive when they are quoted —
   * because there the user has said "this is a command", not written a sentence.
   */
  assert.deepEqual(commands('`python packages` must pass'), ['python packages']);
});

/**
 * ⚠️ THE POPULATION TRAP. Asserting only "no prose criteria" would stay green if
 * `deriveAcceptance` were gutted to return [] for everything, and the make/go
 * suite next door would keep the total non-zero. So this pins the WHOLE archive
 * result: exactly two criteria, and exactly which two.
 */
test('⚠️ over the whole archive: 7 criteria before, exactly these 2 after', () => {
  const all = ARCHIVE_PROSE.map(([s]) => s).join('\n')
    + '\nto verify whether the vulnerability has been fixed correctly, you can run: `pytest -rA`.'
    + '\nPlease implement a MIPS interpreter called vm.js so that I can run `node vm.js` and this should run the MIPS binary.';
  assert.deepEqual(commands(all), ['pytest -rA', 'node vm.js']);
});
