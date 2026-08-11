/**
 * These tests are the four false ticks, written down.
 *
 * Every fixture below is the verbatim criterion sentence from the probe that
 * produced a green banner on unfinished work, 2026-08-10. They are not
 * illustrations — if one of them stops extracting the command the user named,
 * the exact defect is back, and it is back silently, because the run still
 * exits 0.
 *
 * The two rules with the most weight on them:
 *   · an `evaluate` record can never satisfy a criterion (probes 1, 2 and 3);
 *   · a different command exiting 0 is not the criterion (probe 1 run 1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveAcceptance,
  declareAcceptance,
  loadAcceptance,
  checkAcceptance,
  evaluateAcceptance,
  formatVerdict,
  acceptanceToolSchemas,
  ACCEPTANCE_FILE,
  MAX_CRITERIA,
} from '../lib/acceptance.mjs';
import { validateNpmScriptChain } from '../lib/command.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-accept-'));

/** A tool-execution record in the shape `turn.mjs` pushes into `executed`. */
const ran = (command, exitCode) => ({
  name: 'run_command',
  args: { command },
  result: { ok: true, command, exitCode, passed: exitCode === 0 },
});
const evaluated = (exitCode = 0) => ({
  name: 'evaluate',
  args: { source: 'console.log(1)' },
  result: { ok: true, exitCode, passed: exitCode === 0 },
});

/* ────────────────────────────────────────────────────────────────────────────
 * deriveAcceptance — the four probe prompts
 * ──────────────────────────────────────────────────────────────────────────── */

test('probe 1: "It MUST pass: npm test" yields exactly `npm test`', () => {
  const got = deriveAcceptance('Build a small JSON API with tests. It MUST pass: npm test');
  assert.deepEqual(got.map((c) => c.command), ['npm test']);
  assert.equal(got[0].kind, 'bare');
});

test("probe 2: \"'npm test' must pass\" yields exactly `npm test`, as a quoted criterion", () => {
  const got = deriveAcceptance("Refactor the module. 'npm test' must pass afterwards.");
  assert.deepEqual(got.map((c) => c.command), ['npm test']);
  assert.equal(got[0].kind, 'quoted');
});

test('probe 3: a backticked command with a printed-output claim is still one command', () => {
  const got = deriveAcceptance('Write the CLI. `node bin/todo.js help` must print usage and exit 0.');
  assert.deepEqual(got.map((c) => c.command), ['node bin/todo.js help']);
  assert.equal(got[0].kind, 'backticked');
});

test('probe 4: the trailing English after a bare command is not part of the command', () => {
  const got = deriveAcceptance('Finish the migration. npm test must pass at the end with all 16 tests green.');
  // ⚠️ "npm test must pass at the end with all 16 tests green" is a sentence.
  // The criterion is the first two tokens; anything longer would never run.
  assert.deepEqual(got.map((c) => c.command), ['npm test']);
});

test('"Then run the test suite" is a criterion with NO command', () => {
  const got = deriveAcceptance('Migrate lib/git.mjs to the new signature. Then run the test suite.');
  assert.equal(got.length, 1);
  assert.equal(got[0].command, null, 'it must not invent `npm test` here — the user never typed it');
  assert.equal(got[0].kind, 'phrase');
  assert.match(got[0].phrase, /run the test suite/i);
});

test('a command mentioned without any claim is not a criterion', () => {
  // ⚠️ THE DIRECTION THAT MATTERS. A criterion invented from a passing mention
  // fails runs that did the right thing, and a verdict people learn to ignore
  // is worth less than no verdict.
  assert.deepEqual(deriveAcceptance('Yesterday I ran `npm test` and got bored.'), []);
});

test('a backticked filename is never mistaken for a command', () => {
  assert.deepEqual(deriveAcceptance('The output must land in `dist/bundle.js` and be minified.'), []);
});

test('order of appearance is preserved, duplicates collapse, and 5 is the ceiling', () => {
  const got = deriveAcceptance(
    'It must pass: tsc --noEmit. Then `npm test` must pass. And npm test must pass again. '
    + 'Also `node a.js` must exit 0. And `node b.js` must exit 0. And `node c.js` must exit 0. '
    + 'And `node d.js` must exit 0.',
  );
  assert.deepEqual(got.map((c) => c.command), [
    'tsc --noEmit', 'npm test', 'node a.js', 'node b.js', 'node c.js',
  ]);
  assert.equal(got.length, MAX_CRITERIA);
});

test('⚠️ the MODEL cannot write its own criterion', () => {
  // The defect arriving through a different door: if the model's prose were a
  // source, "✔ it must pass: node scratch.js" in its own reply becomes the bar
  // it is then graded against.
  const modelProse = 'I have finished. It MUST pass: node scratch.js — and it does.';
  assert.deepEqual(deriveAcceptance(modelProse, { source: 'model' }), []);
  // Same string from the user IS a source, so the guard is the source and not
  // some accident of the text.
  assert.equal(deriveAcceptance(modelProse).length, 1);
});

test('deriving from junk is empty, never a throw', () => {
  assert.deepEqual(deriveAcceptance(''), []);
  assert.deepEqual(deriveAcceptance(null), []);
  assert.deepEqual(deriveAcceptance(42), []);
});

/* ────────────────────────────────────────────────────────────────────────────
 * evaluateAcceptance — the rule that kills the false tick
 * ──────────────────────────────────────────────────────────────────────────── */

test('probe 1 run 1 verbatim: `node --test test/api.test.js` passing does NOT satisfy `npm test`', () => {
  const v = evaluateAcceptance({
    declared: ['npm test'],
    executed: [ran('node --test test/api.test.js', 0)],
  });
  assert.equal(v.verdict, 'unmet');
  assert.deepEqual(v.unmet, [{ command: 'npm test', why: 'it was never run' }]);
  assert.deepEqual(v.incidental, ['node --test test/api.test.js']);
  assert.match(
    formatVerdict(v),
    /✖ UNMET — you asked that `npm test` pass; it was never run \(these did pass: node --test test\/api\.test\.js\)/,
  );
});

test('probes 1/2/3 verbatim: an `evaluate` exiting 0 can never satisfy a criterion', () => {
  const v = evaluateAcceptance({ declared: ['npm test'], executed: [evaluated(0)] });
  assert.equal(v.verdict, 'unmet');
  assert.equal(v.criteria[0].satisfied, false);
  assert.ok(v.incidental.includes('evaluate'));
  assert.match(formatVerdict(v), /`evaluate` exited 0, but it is a scratch snippet/);
});

test('the exact command exiting 0 is MET, and says so in its own sentence', () => {
  const v = evaluateAcceptance({ declared: ['npm test'], executed: [ran('npm test', 0)] });
  assert.equal(v.verdict, 'met');
  assert.equal(formatVerdict(v), '✔ MET — `npm test` exited 0');
});

test('nothing declared is its own sentence, and is never a tick', () => {
  const v = evaluateAcceptance({ declared: [], executed: [ran('npm test', 0)] });
  assert.equal(v.verdict, 'none-declared');
  assert.equal(formatVerdict(v), '— nothing was declared, so nothing here is a criterion');
});

test('the three sentences are distinct — no verdict can be mistaken for another', () => {
  const met = formatVerdict(evaluateAcceptance({ declared: ['npm test'], executed: [ran('npm test', 0)] }));
  const unmet = formatVerdict(evaluateAcceptance({ declared: ['npm test'], executed: [ran('node x.js', 0)] }));
  const none = formatVerdict(evaluateAcceptance({ declared: [], executed: [] }));
  assert.equal(new Set([met, unmet, none]).size, 3);
  assert.ok(met.startsWith('✔ MET'));
  assert.ok(unmet.startsWith('✖ UNMET'));
  assert.ok(none.startsWith('—'));
});

test('the declared command exiting 1 is UNMET, and the reason distinguishes it from never-run', () => {
  const v = evaluateAcceptance({ declared: ['npm test'], executed: [ran('npm test', 1)] });
  assert.equal(v.verdict, 'unmet');
  assert.deepEqual(v.unmet, [{ command: 'npm test', why: 'it ran and exited 1' }]);
});

test('a run that executed nothing at all is not-run, not unmet-by-failure', () => {
  const v = evaluateAcceptance({ declared: ['npm test'], executed: [{ name: 'write_file', result: { ok: true } }] });
  assert.equal(v.verdict, 'not-run');
  assert.match(formatVerdict(v), /nothing was executed in this run/);
});

test('a later red overrides an earlier green on the SAME command', () => {
  // The mirror of turn.mjs's own lesson: a green that has since been
  // invalidated is not a verdict, it is a memory.
  const v = evaluateAcceptance({ declared: ['npm test'], executed: [ran('npm test', 0), ran('npm test', 1)] });
  assert.equal(v.verdict, 'unmet');
});

test('red then green on the same command DOES clear — that is the normal fix loop', () => {
  const v = evaluateAcceptance({ declared: ['npm test'], executed: [ran('npm test', 1), ran('npm test', 0)] });
  assert.equal(v.verdict, 'met');
});

test('whitespace is normalised, case is not', () => {
  assert.equal(evaluateAcceptance({ declared: ['npm test'], executed: [ran('npm   test', 0)] }).verdict, 'met');
  assert.equal(evaluateAcceptance({ declared: ['npm test'], executed: [ran('NPM TEST', 0)] }).verdict, 'unmet');
});

test('no tool except run_command/run_program can satisfy a criterion', () => {
  const impostors = [
    { name: 'see_page', args: {}, result: { ok: true, command: 'npm test', exitCode: 0 } },
    { name: 'git_commit', args: {}, result: { ok: true, command: 'npm test', exitCode: 0 } },
    { name: 'speak', args: {}, result: { ok: true, command: 'npm test', exitCode: 0 } },
  ];
  for (const record of impostors) {
    const v = evaluateAcceptance({ declared: ['npm test'], executed: [record] });
    assert.equal(v.verdict, 'not-run', `${record.name} must not count as verification`);
  }
});

test('run_program (the browser client\'s verb) does satisfy one', () => {
  const v = evaluateAcceptance({
    declared: ['npm test'],
    executed: [{ name: 'run_program', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 0 } }],
  });
  assert.equal(v.verdict, 'met');
});

test('a REFUSED run_command is not an execution', () => {
  const v = evaluateAcceptance({
    declared: ['npm test'],
    executed: [{ name: 'run_command', args: { command: 'npm test' }, result: { ok: false, error: 'refused' } }],
  });
  assert.equal(v.verdict, 'not-run');
});

test('a phrase-only criterion is unrunnable, and says so instead of ticking', () => {
  const declared = deriveAcceptance('Then run the test suite.');
  const v = evaluateAcceptance({ declared, executed: [ran('node x.js', 0)] });
  assert.equal(v.verdict, 'unrunnable');
  assert.match(formatVerdict(v), /cannot be run here/);
  assert.ok(!formatVerdict(v).startsWith('✔'), 'an unrunnable criterion must never render as a tick');
});

test('all five criteria must pass for MET; four of five is UNMET', () => {
  const declared = ['npm test', 'tsc --noEmit'];
  assert.equal(evaluateAcceptance({ declared, executed: [ran('npm test', 0), ran('tsc --noEmit', 0)] }).verdict, 'met');
  const partial = evaluateAcceptance({ declared, executed: [ran('npm test', 0), ran('tsc --noEmit', 2)] });
  assert.equal(partial.verdict, 'unmet');
  assert.equal(partial.satisfiedCount, 1);
});

test('two unmet criteria each carry their OWN reason, not a pair of lists', () => {
  const v = evaluateAcceptance({
    declared: ['npm test', 'tsc --noEmit'],
    executed: [ran('tsc --noEmit', 2)],
  });
  const s = formatVerdict(v);
  assert.match(s, /`npm test` \(it was never run\)/);
  assert.match(s, /`tsc --noEmit` \(it ran and exited 2\)/);
});

test('the unrunnable sentence never ends in a doubled full stop', () => {
  // Caught by RENDERING it, not by a unit assertion: the runner's own reason is
  // a sentence and already ends in "." about half the time.
  const s = formatVerdict(evaluateAcceptance({
    declared: [{ command: 'npm test', runnable: false, reason: 'the "test" script is not allowed: "*" is refused.' }],
    executed: [],
  }));
  assert.ok(!s.includes('..'), s);
  assert.ok(s.length < 320, 'the reason is capped — this line is read, not parsed');
});

/* ────────────────────────────────────────────────────────────────────────────
 * declareAcceptance — refusals and durability
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⭐ THIS TEST DID ITS JOB AND WENT RED. It previously asserted that a glob
 * script was NOT runnable, and its own comment predicted the change: *"If
 * command.mjs ever starts allowing globs (someone is working on exactly that),
 * this test goes red rather than quietly passing on a stale sentence."* It did.
 * That is what a good test looks like — it refused to keep describing a world
 * that no longer exists.
 *
 * The world it describes now: globs ARE runnable. `*` was never dangerous here
 * because there is no shell to expand it, node expands it itself (verified
 * live), and refusing it meant Acuvo Code could not run its own test suite.
 */
test('a script body with a glob is runnable — there is no shell, node expands it', () => {
  const root = ws();
  // The verbatim shape of a real delivered project, and of this package itself.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.js' } }));
  const r = declareAcceptance(root, { commands: ['npm test'] });
  assert.equal(r.ok, true);

  // Still asserted against the RUNNER's own verdict rather than a pasted
  // sentence, so this stays honest if the rule moves again.
  const runnersOwnVerdict = validateNpmScriptChain('test', readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(runnersOwnVerdict.ok, true, 'the runner must now accept a glob test script');
  assert.equal(r.criteria[0].runnable, true);

  // ⚠️ And it must never have been rewritten into something that merely happens
  // to run — the criterion the user declared is the criterion that is checked.
  assert.equal(r.criteria[0].command, 'npm test');
});

/**
 * ⚠️ The other half of the same rule, kept because the first version of this
 * change loosened the WRITE boundary by accident. A glob may appear in a command
 * argument; it may never smuggle a path out of the workspace.
 */
test('a glob still cannot escape the workspace', async () => {
  const { validateCommand } = await import('../lib/command.mjs');
  for (const evil of ['node --test ../*/secret.mjs', 'node --test /etc/*.conf', 'node --test C:/x/*.js']) {
    assert.equal(validateCommand(evil).ok, false, evil);
  }
});

test('a runnable script body is stored runnable:true', () => {
  const root = ws();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/unit.test.js' } }));
  const r = declareAcceptance(root, { commands: ['npm test'] });
  assert.equal(r.criteria[0].runnable, true);
  assert.equal(r.note, null);
});

test('`npm test` in a workspace with no package.json is unrunnable, and says why', () => {
  const r = declareAcceptance(ws(), { commands: ['npm test'] });
  assert.equal(r.criteria[0].runnable, false);
  assert.match(r.criteria[0].reason, /cannot run npm here/);
});

test('six criteria are refused, and the refusal says what to do instead', () => {
  const six = ['npm test', 'node a.js', 'node b.js', 'node c.js', 'node d.js', 'node e.js'];
  const r = declareAcceptance(ws(), { commands: six });
  assert.equal(r.ok, false);
  assert.match(r.error, /at most 5 are accepted/);
  assert.match(r.error, /whose failure means the task is not done/);
});

test('a 240+ character criterion is refused', () => {
  const r = declareAcceptance(ws(), { commands: [`node ${'a'.repeat(250)}.js`] });
  assert.equal(r.ok, false);
  assert.match(r.error, /over the 240 limit/);
});

test('an empty or non-array declaration is refused as data, never thrown', () => {
  assert.equal(declareAcceptance(ws(), { commands: [] }).ok, false);
  assert.equal(declareAcceptance(ws(), { commands: 'npm test' }).ok, false);
  assert.equal(declareAcceptance(ws(), { commands: [123] }).ok, false);
});

test('a memory workspace declares nothing and says so', () => {
  const r = declareAcceptance('(memory)', { commands: ['npm test'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /held in memory/);
});

test('a memory workspace checks to none-declared with a reason, never a tick', async () => {
  const r = await checkAcceptance({ root: '(memory)', runner: async () => ({ ok: true, exitCode: 0 }) });
  assert.equal(r.verdict.verdict, 'none-declared');
  assert.match(r.verdict.reason, /held in memory/);
});

test('a declaration survives into the next session, and writes ONLY inside .acuvo/', () => {
  const root = ws();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/u.test.js' } }));
  const before = readdirSync(root).sort();
  const r = declareAcceptance(root, { commands: ['npm test'] });
  assert.equal(r.path, ACCEPTANCE_FILE);
  assert.ok(existsSync(join(root, '.acuvo', 'acceptance.json')));
  // Nothing appeared at the root except the .acuvo directory itself.
  assert.deepEqual(readdirSync(root).sort().filter((n) => !before.includes(n)), ['.acuvo']);

  const loaded = loadAcceptance(root);
  assert.equal(loaded.found, true);
  assert.deepEqual(loaded.criteria.map((c) => c.command), ['npm test']);
  // And the resumed session's verdict uses the inherited criterion.
  assert.equal(evaluateAcceptance({ declared: loaded.criteria, executed: [evaluated(0)] }).verdict, 'unmet');
});

test('no declaration is "found: false", not an error', () => {
  const loaded = loadAcceptance(ws());
  assert.equal(loaded.ok, true);
  assert.equal(loaded.found, false);
});

test('a corrupt acceptance.json is an error, never a silent "nothing was declared"', () => {
  const root = ws();
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'acceptance.json'), '{not json');
  const loaded = loadAcceptance(root);
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /Delete it or declare the criteria again/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * checkAcceptance — everything runs through the INJECTED runner
 * ──────────────────────────────────────────────────────────────────────────── */

test('check runs exactly the declared string, through the injected runner, and nothing else', async () => {
  const root = ws();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/u.test.js' } }));
  declareAcceptance(root, { commands: ['npm test'] });

  const seen = [];
  const runner = async (command) => { seen.push(command); return { ok: true, exitCode: 0, stdout: '16 passing', stderr: '' }; };
  const r = await checkAcceptance({ root, runner });

  assert.deepEqual(seen, ['npm test'], 'the runner must be given the criterion verbatim');
  assert.equal(r.criteria[0].passed, true);
  assert.equal(r.verdict.verdict, 'met');
});

test('check reports a failing criterion as unmet with its exit code and tail output', async () => {
  const runner = async () => ({ ok: true, exitCode: 1, stdout: 'x'.repeat(5000), stderr: '1 failing' });
  const r = await checkAcceptance({ root: ws(), runner, declared: ['npm test'] });
  assert.equal(r.criteria[0].passed, false);
  assert.equal(r.criteria[0].exitCode, 1);
  assert.match(r.criteria[0].output, /characters omitted/, 'output must be capped — the model pays for it');
  assert.ok(r.criteria[0].output.length < 600);
  assert.equal(r.verdict.verdict, 'unmet');
});

test('a runner that REFUSES is not a failing criterion, and never a passing one', async () => {
  const runner = async () => ({ ok: false, error: 'npm install is refused' });
  const r = await checkAcceptance({ root: ws(), runner, declared: ['npm test'] });
  assert.equal(r.criteria[0].ran, false);
  assert.match(r.criteria[0].output, /refused/);
  assert.equal(r.verdict.verdict, 'not-run');
});

test('a runner that throws is reported as a wiring fault, not as a red test', async () => {
  const runner = async () => { throw new Error('spawn ENOENT'); };
  const r = await checkAcceptance({ root: ws(), runner, declared: ['npm test'] });
  assert.equal(r.criteria[0].ran, false);
  assert.match(r.criteria[0].output, /the runner threw: spawn ENOENT/);
});

test('⚠️ with no runner injected, check refuses — this module never starts a process', async () => {
  const r = await checkAcceptance({ root: ws(), declared: ['npm test'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /must inject one/);
  // ⚠️ AN ERROR STRING IS AN INSTRUCTION. Retrying cannot help a wiring fault,
  // so the sentence must not suggest it.
  assert.ok(!/try again/i.test(r.error));
});

test('an unrunnable criterion is not handed to the runner at all', async () => {
  let calls = 0;
  const runner = async () => { calls += 1; return { ok: true, exitCode: 0 }; };
  const declared = [{ command: 'npm test', runnable: false, reason: 'the script body contains a glob' }];
  const r = await checkAcceptance({ root: ws(), runner, declared });
  assert.equal(calls, 0);
  assert.equal(r.criteria[0].ran, false);
  assert.match(r.criteria[0].output, /glob/);
  assert.equal(r.verdict.verdict, 'unrunnable');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The tool surface
 * ──────────────────────────────────────────────────────────────────────────── */

test('both tools are declared, and the description forbids substitution', () => {
  const schemas = acceptanceToolSchemas();
  assert.deepEqual(schemas.map((s) => s.function.name), ['declare_acceptance', 'check_acceptance']);
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.equal(s.parameters, undefined);
    assert.equal(typeof s.function.parameters, 'object');
  }
  assert.match(schemas[0].function.description, /do not substitute an equivalent command/i);
});

test('the module writes nothing anywhere until declare is called', () => {
  const root = ws();
  loadAcceptance(root);
  evaluateAcceptance({ declared: ['npm test'], executed: [] });
  deriveAcceptance('npm test must pass');
  assert.deepEqual(readdirSync(root), []);
});

test('a stored declaration is JSON a human can read in review', () => {
  const root = ws();
  declareAcceptance(root, { commands: ['node build.js'] });
  const raw = JSON.parse(readFileSync(join(root, '.acuvo', 'acceptance.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.criteria[0].command, 'node build.js');
  assert.equal(typeof raw.declaredAt, 'string');
});
