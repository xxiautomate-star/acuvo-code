/**
 * ── ⭐⭐ THE AGENT COULD NOT RUN A PYTHON TEST, AND THAT WAS THE WHOLE BENCH
 *    FAILURE ─────────────────────────────────────────────────────────────────
 *
 * One task of thirteen failed — `polyglot` — and it failed because `pytest` is
 * not a program this agent may run. The model was right; the allowlist was the
 * ceiling. `command.mjs` says as much in its own words.
 *
 * ⚠️ AND THE PRESET THAT ALREADY EXISTS DOES NOT CLOSE IT. Measured against
 * `COMMAND_PRESETS.python` with the preset enabled:
 *
 *     python -m pytest      →  allowed
 *     python -m pytest -q   →  REFUSED: "-q is not an allowed python flag"
 *     python -m unittest -v →  REFUSED: "-v is not an allowed python flag"
 *
 * So this file pins the fix in four directions, and the ones that matter most
 * are 2 and 4:
 *
 *   1. the invocations a real Python repo runs are ALLOWED;
 *   2. ⚠️ the ones that execute a string, install, listen or prompt are REFUSED
 *      — a guard is worth exactly what it refuses;
 *   3. ⚠️ a refusal NAMES THE WAY OUT, because the reader is a model that gets
 *      another round and an obstacle with no alternative ends the run;
 *   4. ⚠️ THE DEFAULT SURFACE DOES NOT MOVE. Nothing here is reachable until a
 *      human enables the preset, and that is asserted rather than assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePythonArgv,
  applyPythonEnvPlan,
  PYTHON_TEST_INVOCATIONS,
  PYTHON_REFUSED_INVOCATIONS,
  PYTHON_ENV_PLAN,
  PYTHON_PRESET_GRAMMAR,
  PYTHON_BINARIES,
  VENV_WRITE_GUARD,
  VENV_INTERPRETER_PATHS,
} from '../lib/python.mjs';
import { ALLOWED_BINARIES, DEFAULT_ALLOWLIST, validateCommand, COMMAND_PRESETS } from '../lib/command.mjs';

const ok = (argv, opts) => {
  const v = validatePythonArgv(argv, opts);
  assert.equal(v.ok, true, `${argv.join(' ')} should be allowed: ${v.ok ? '' : v.error}`);
  return v;
};
const no = (argv, opts) => {
  const v = validatePythonArgv(argv, opts);
  assert.equal(v.ok, false, `${argv.join(' ')} should be refused`);
  return v;
};

// ── 1. the reach: what a real Python repository actually runs ───────────────

test('⭐⭐ every invocation in PYTHON_TEST_INVOCATIONS is allowed — the fixture IS the claim', () => {
  assert.ok(PYTHON_TEST_INVOCATIONS.length >= 20, 'a reach fixture with a handful of entries proves nothing');
  for (const { argv, why } of PYTHON_TEST_INVOCATIONS) {
    const v = validatePythonArgv(argv);
    assert.equal(v.ok, true, `${argv.join(' ')} (${why}) should be allowed: ${v.ok ? '' : v.error}`);
  }
});

test('⭐⭐ THE MEASURED DEFECT IS CLOSED — `python -m pytest -q` is allowed BY THE SHIPPED PRESET', async () => {
  // The regression itself. If this ever goes red the file has stopped solving
  // the thing it was written for.
  ok(['python', '-m', 'pytest', '-q']);
  ok(['python', '-m', 'unittest', '-v']);

  /**
   * ── ⭐ THIS ASSERTION INVERTED, AND IT SAID IT WOULD ──────────────────────
   *
   * It used to assert that the SHIPPED preset refuses `-q` — proving the defect
   * was real rather than remembered — and closed with *"if the shipped preset
   * gains -q on the interpreter, this file's premise needs rewriting."*
   *
   * The premise changed on 2026-08-20: `command.mjs` now routes every python
   * binary through `validatePythonArgv` instead of a flag table, so there is no
   * "interpreter flag list" for `-q` to be missing from. This module stopped
   * being an unreached proposal and became the grammar.
   *
   * ⚠️ SO THE ASSERTION IS NOW END TO END, not against the table. What matters
   * was never which set holds `-q`; it is whether the command a real Python
   * project types is allowed by the thing that actually gates commands.
   */
  const { validateCommand, buildAllowlist } = await import('../lib/command.mjs');
  const allowlist = buildAllowlist({ presets: ['python'] });
  for (const cmd of ['python -m pytest -q', 'pytest -q', 'py -m pytest -q', 'python -m unittest -v']) {
    const v = validateCommand(cmd, { allowlist });
    assert.equal(v.ok, true, `the shipped preset still refuses "${cmd}": ${v.ok ? '' : v.error}`);
  }

  // ⚠️ And the refusals still hold through the same door — a grammar that
  // allows everything would pass the line above just as well.
  for (const cmd of ['python -m pip install requests', 'python -m http.server', 'pytest --pdb', 'python -m pytest --pdb']) {
    assert.equal(validateCommand(cmd, { allowlist }).ok, false, `"${cmd}" must still be refused`);
  }
});

test('⭐ ARGUMENT AUTHORITY FOLLOWS THE PROGRAM — the same flag means different things either side of -m', () => {
  // `-c` is "execute this string" to python and "catch interrupt" to unittest.
  // Both verdicts below are correct, and only a validator that hands authority
  // over at `-m` can produce both.
  assert.match(no(['python', '-c', 'print(1)']).error, /never written to disk/);
  ok(['python', '-m', 'unittest', '-c']);

  // `-m` is python's module switch and pytest's marker switch.
  ok(['python', '-m', 'pytest', '-m', 'slow']);
});

test('⭐ pytest gets ONE grammar whichever door it comes through', () => {
  for (const prefix of [['pytest'], ['python', '-m', 'pytest']]) {
    ok([...prefix, '-q', '-x']);
    assert.match(no([...prefix, '--pdb']).error, /interactive/);
    assert.match(no([...prefix, '-p', 'evil_plugin']).error, /preloads code/);
  }
});

test('⭐ a dotted module is not a path, and a pytest node id is not a filename', () => {
  ok(['python', '-m', 'unittest', 'tests.test_add.TestAdd.test_one']);
  ok(['pytest', 'tests/test_a.py::test_add']);
  ok(['pytest', 'tests/test_a.py::TestClass::test_add']);
  ok(['pytest', 'tests/test_*.py']);
});

test('⭐ the script\'s own flags are the SCRIPT\'S — python stops parsing at the first non-flag', () => {
  ok(['python', 'manage.py', 'test', '--verbosity', '2']);
  // `-c` here is passed to app.py; python never reads it, so refusing it would
  // refuse correct work on the strength of a flag nobody interprets.
  ok(['python', 'app.py', '-c', 'config.json']);
});

test('`-mpytest` — the attached form is the same command as `-m pytest`', () => {
  const v = ok(['python', '-mpytest', '-q']);
  assert.equal(v.module, 'pytest');
});

test('py, python3.12 and the Windows launcher selector all reach the same place', () => {
  ok(['py', '-3', '-m', 'pytest', '-q']);
  ok(['py', '-3.12-64', '-m', 'pytest']);
  ok(['python3.12', '-m', 'pytest', '-q']);
  ok(['python3', '-m', 'pytest']);
});

// ── 2. the refusals — a guard is worth what it refuses ─────────────────────

test('⚠️⭐ every entry in PYTHON_REFUSED_INVOCATIONS is refused, WITH THE STATED REASON', () => {
  for (const { argv, match } of PYTHON_REFUSED_INVOCATIONS) {
    const v = validatePythonArgv(argv);
    assert.equal(v.ok, false, `${argv.join(' ')} must be refused`);
    assert.match(v.error, match, `${argv.join(' ')} was refused for the wrong reason: ${v.error}`);
  }
});

test('⚠️ `python -c` is refused for EXACTLY the reason `node --eval` is', () => {
  const v = no(['python', '-c', 'import os']);
  assert.match(v.error, /never written to disk/);
  // ⭐ and it names the way out, which is the half that decides whether the
  // model recovers or gives up.
  assert.match(v.error, /Write the code to a \.py file/);
});

test('⚠️ the installers are refused in every spelling', () => {
  for (const argv of [
    ['python', '-m', 'pip', 'install', 'requests'],
    ['python3', '-m', 'pip', 'install', 'requests'],
    ['python', '-m', 'pip3', 'install', 'requests'],
    ['python', '-m', 'ensurepip'],
    ['python', '-m', 'easy_install', 'x'],
    ['python', '-mpip', 'install', 'requests'],
  ]) {
    const v = no(argv);
    assert.ok(/downloads and executes code|see the pip refusal/.test(v.error), `${argv.join(' ')}: ${v.error}`);
  }
});

test('⚠️⭐ `-W` IS AN IMPORT — the module field is refused, the action word is not', () => {
  // This is the one the existing preset allows: `-W` is on its flag list, and
  // -W's fourth field is imported at startup by the warnings machinery.
  assert.match(no(['python', '-W', 'ignore::Warning:evilmod', '-m', 'pytest']).error, /IMPORTED at startup/);
  assert.match(no(['python', '-W=ignore::Warning:evilmod', '-m', 'pytest']).error, /IMPORTED at startup/);
  ok(['python', '-W', 'ignore', '-m', 'pytest']);
  ok(['python', '-W=error', '-m', 'pytest']);
});

test('⚠️ an OPEN module list would be `python -c "import x"` with extra steps', () => {
  const v = no(['python', '-m', 'antigravity']);
  assert.match(v.error, /top-level code runs on import/);
  assert.match(v.error, /pytest/, 'the refusal must list what IS allowed');
});

test('⚠️ the module slot is not a path slot', () => {
  for (const m of ['./evil', '../evil', '/etc/evil', 'evil.py']) {
    const v = no(['python', '-m', m]);
    assert.match(v.error, /not a module name|not allowed/);
  }
});

test('⚠️ containment survives every route into the validator', () => {
  assert.match(no(['python', '../../etc/x.py']).error, /escapes the workspace/);
  assert.match(no(['pytest', '../secrets']).error, /escapes the workspace/);
  assert.match(no(['python', 'app.py', '../../etc/passwd']).error, /escapes the workspace/);
  assert.match(no(['python', '-m', 'unittest', 'discover', '-s', '../..']).error, /escapes the workspace/);
  assert.match(no(['python', '-m', 'mypy', '/etc']).error, /absolute path/);
});

test('⚠️ the bare interpreter is a REPL and never exits', () => {
  assert.match(no(['python']).error, /interactive/);
  assert.match(no(['python', '-u']).error, /interactive/);
  ok(['python', '-V']);          // the one terminal flag
  ok(['python', '--version']);
});

test('⚠️ a non-.py operand is not a script, and the refusal says what to do instead', () => {
  const v = no(['python', 'pytest']);
  assert.match(v.error, /-m <module>/);
});

// ── 3. the virtualenv interpreter: off, and the reason is a real chain ──────

test('⚠️⭐ a venv interpreter PATH is refused by default, and the refusal names activation', () => {
  const v = no(['.venv/bin/python', '-m', 'pytest']);
  assert.match(v.error, /activate/);
  assert.match(v.error, /PATH/);
});

test('with the switch on, only the RECOGNISED venv layouts run, and the caller is told to check existence', () => {
  const v = ok(['.venv/bin/python', '-m', 'pytest', '-q'], { allowVenvInterpreter: true });
  assert.equal(v.interpreter, 'venv');
  assert.equal(v.mustExist, '.venv/bin/python');

  ok(['.venv\\Scripts\\python.exe', '-m', 'pytest'], { allowVenvInterpreter: true });

  // ⚠️ Not a general "run any file as a program" grant.
  assert.match(no(['tools/python', '-m', 'pytest'], { allowVenvInterpreter: true }).error, /not a virtualenv interpreter/);
  assert.match(no(['../.venv/bin/python', '-m', 'pytest'], { allowVenvInterpreter: true }).error, /not a virtualenv interpreter/);
});

test('⭐ VENV_WRITE_GUARD matches what a write tool must refuse, and nothing a project needs', () => {
  for (const p of VENV_INTERPRETER_PATHS) assert.match(p, VENV_WRITE_GUARD, `${p} must be write-guarded`);
  assert.match('.venv/bin/pytest', VENV_WRITE_GUARD);
  // ⚠️ A guard that fails correct work is worse than none: ordinary source must
  // not match, and neither must a directory that merely has "env" in its name.
  for (const p of ['src/env/config.py', 'tests/test_venv.py', 'environments/bin/x', 'src/main.py']) {
    assert.doesNotMatch(p, VENV_WRITE_GUARD, `${p} must NOT be write-guarded`);
  }
});

// ── 4. the default surface does not move ───────────────────────────────────

test('⚠️⚠️ NOTHING HERE IS REACHABLE UNTIL A HUMAN ENABLES IT — the four are still four', () => {
  assert.deepEqual(ALLOWED_BINARIES, ['node', 'npm', 'npx', 'tsc']);
  assert.deepEqual([...DEFAULT_ALLOWLIST.binaries].sort(), ['node', 'npm', 'npx', 'tsc']);
  for (const bin of PYTHON_BINARIES) {
    const v = validateCommand(`${bin} -V`);
    assert.equal(v.ok, false, `${bin} must stay refused on the default surface`);
  }
});

test('⭐ the module is PURE — same answer twice, no env read, no fs, and the input is not mutated', () => {
  const argv = ['python', '-m', 'pytest', '-q'];
  const before = JSON.stringify(argv);
  const a = validatePythonArgv(argv);
  const b = validatePythonArgv(argv);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(argv), before, 'the argv handed in must come back untouched');

  // The venv switch is INJECTED, not sniffed: flipping process.env changes nothing.
  process.env.ACUVO_TEST_VENV = '1';
  try {
    assert.equal(validatePythonArgv(['.venv/bin/python', '-V']).ok, false);
  } finally {
    delete process.env.ACUVO_TEST_VENV;
  }
});

test('bad input is refused as input, not as a command', () => {
  assert.match(validatePythonArgv('python -m pytest').error, /array of strings/);
  assert.match(validatePythonArgv(['python', 3]).error, /array of strings/);
  assert.match(validatePythonArgv([]).error, /empty argv/);
});

// ── 5. the environment — the flag allowlist's back door ────────────────────

test('⚠️⭐ the env plan drops what is CODE INJECTION and keeps what is load-bearing', () => {
  const env = {
    PYTHONHOME: '/tmp/evil',
    PYTHONWARNINGS: 'ignore::Warning:evilmod',
    PYTHONEXECUTABLE: '/tmp/evil/python',
    PYTHONUSERBASE: '/tmp/evil',
    PYTHONSTARTUP: '/tmp/evil.py',
    PYTHONPATH: 'src',
    PATH: '/usr/bin',
    VIRTUAL_ENV: '/w/.venv',
  };
  const out = applyPythonEnvPlan(env);

  /**
   * ⚠️⚠️ THESE NAMES ARE WRITTEN OUT LITERALLY, AND THE FIRST VERSION DID NOT —
   * it looped over `PYTHON_ENV_PLAN.drop` itself, which is a guard satisfied by
   * coincidence: deleting `PYTHONHOME` from the plan also deleted the assertion
   * about it, and the mutation SURVIVED a suite that looked like it covered it.
   * An expectation derived from the thing it is checking is not an expectation.
   */
  for (const name of ['PYTHONHOME', 'PYTHONEXECUTABLE', 'PYTHONUSERBASE', 'PYTHONWARNINGS', 'PYTHONSTARTUP']) {
    assert.equal(name in out, false, `${name} must not reach the child`);
    assert.ok(
      PYTHON_ENV_PLAN.drop.includes(name) || PYTHON_ENV_PLAN.alreadyDropped.includes(name),
      `${name} must stay named in the plan the lead wires, not only in the behaviour of this function`,
    );
  }
  // The plan is a contract with `command.mjs`'s INJECT_ENV_NAMES, so it is
  // pinned whole rather than sampled.
  assert.deepEqual([...PYTHON_ENV_PLAN.drop], ['PYTHONHOME', 'PYTHONEXECUTABLE', 'PYTHONUSERBASE', 'PYTHONWARNINGS']);
  assert.deepEqual([...PYTHON_ENV_PLAN.keep], ['PYTHONPATH', 'PATH', 'VIRTUAL_ENV']);
  // ⚠️ AND THE OTHER DIRECTION, which is the one that breaks real repositories:
  // PYTHONPATH=src is how a large fraction of Python projects import their own
  // code, and dropping it would be a guard that fails correct work.
  assert.equal(out.PYTHONPATH, 'src');
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.VIRTUAL_ENV, '/w/.venv');

  // ⭐ PYTHONWARNINGS is the environment spelling of the -W refusal above.
  // Refusing the flag and passing the variable would be the same door, open.
  assert.equal('PYTHONWARNINGS' in out, false);
});

test('⭐ PYTHONUNBUFFERED is forced, because a killed run must still show what it printed', () => {
  const out = applyPythonEnvPlan({});
  assert.equal(out.PYTHONUNBUFFERED, '1');
  assert.equal(out.PYTHONNOUSERSITE, '1');
  assert.equal(out.PYTHONDONTWRITEBYTECODE, '1');
  // An operator's own value does not win over a forced one — otherwise the
  // guarantee is "unless the environment says otherwise", which is no guarantee.
  assert.equal(applyPythonEnvPlan({ PYTHONUNBUFFERED: '' }).PYTHONUNBUFFERED, '1');
  assert.equal(applyPythonEnvPlan({ PYTHONNOUSERSITE: '0' }).PYTHONNOUSERSITE, '1');
});

// ── 6. what the lead wires in ──────────────────────────────────────────────

test('the exported preset grammar is complete enough to wire without reading this file', () => {
  assert.deepEqual([...PYTHON_PRESET_GRAMMAR.binaries], ['python', 'python3', 'py', 'pytest']);
  assert.equal(PYTHON_PRESET_GRAMMAR.validate, validatePythonArgv);
  for (const m of ['pytest', 'unittest']) assert.ok(PYTHON_PRESET_GRAMMAR.allowedModules.includes(m));
  for (const m of ['pip', 'venv', 'http.server', 'timeit']) assert.ok(PYTHON_PRESET_GRAMMAR.refusedModules.includes(m));
  // ⚠️ The two lists must not overlap, or the same name is both a capability
  // and a refusal and whichever is consulted first silently wins.
  for (const m of PYTHON_PRESET_GRAMMAR.allowedModules) {
    assert.ok(!PYTHON_PRESET_GRAMMAR.refusedModules.includes(m), `${m} is on both lists`);
  }
  assert.ok(!PYTHON_PRESET_GRAMMAR.refusedInterpreterFlags.includes('-m'), '-m is a route, not a refusal');
});

test('⭐ EVERY REFUSAL NAMES A WAY THROUGH — an obstacle with no alternative ends the run', () => {
  /**
   * ⚠️ MEASURED IN THIS PACKAGE ALREADY: a refusal that named a rule and not an
   * alternative cost a whole task, because the model concluded the capability
   * was absent and stopped. So this is asserted mechanically over the refusal
   * surface rather than spot-checked on the two messages someone remembered.
   */
  const surface = [
    ...PYTHON_REFUSED_INVOCATIONS.map((r) => r.argv),
    ['python', '-m', 'antigravity'],
    ['python', '--frobnicate'],
    ['pytest', '--frobnicate'],
    ['python', 'notpython'],
    ['java', '-version'],
  ];
  /**
   * ⚠️ THIS REGEX IS A HEURISTIC AND ITS FIRST VERSION WAS TOO NARROW — it went
   * red on a refusal that DID name a way out ("Put the code in a .py file and
   * run the file") purely because that sentence used verbs the pattern had not
   * thought of. A check that fails correct work is worse than no check, so the
   * pattern was widened rather than the message reworded to please it. It is
   * still a real check: mutating any way-out sentence out of `python.mjs` turns
   * this test red, which is the property that was verified rather than assumed.
   */
  const wayOut = /instead|\buse\b|\bUse\b|allowed|Allowed|accepted|activate|\bwrite\b|\bWrite\b|go after|Put |Run |run the file|Name |ask a human|Ask a human|belongs to the human/;
  for (const argv of surface) {
    const v = validatePythonArgv(argv);
    assert.equal(v.ok, false);
    assert.match(v.error, wayOut, `refusal of "${argv.join(' ')}" names no way through: ${v.error}`);
    assert.ok(v.error.length > 40, `refusal of "${argv.join(' ')}" is too short to be a decision: ${v.error}`);
  }
});
