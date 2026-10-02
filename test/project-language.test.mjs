import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPresets, describeDetected, LANGUAGE_MARKERS } from '../lib/project-language.mjs';
import { PRESET_NAMES } from '../lib/command.mjs';

test('⭐⭐⭐ a Python project can run its own tests', () => {
  /**
   * The bench failure this exists to fix: `polyglot` is a Python repo whose task
   * only closes if the agent can execute pytest, and out of the box it could
   * not — no presets are on by default.
   */
  assert.deepEqual(detectPresets(['pyproject.toml', 'stats.py']), ['python']);
  assert.deepEqual(detectPresets(['requirements.txt']), ['python']);
  assert.deepEqual(detectPresets(['setup.py']), ['python']);
});

test('⭐ Go, Rust and Ruby declare themselves the same way', () => {
  assert.deepEqual(detectPresets(['go.mod']), ['go']);
  assert.deepEqual(detectPresets(['Cargo.toml']), ['rust']);
  assert.deepEqual(detectPresets(['Gemfile']), ['ruby']);
});

test('⚠️⚠️ a SOURCE FILE is never evidence — only a manifest is', () => {
  /**
   * A stray build script or a vendored tool must not turn a whole grammar on
   * for somebody else's repo. A manifest states what the project IS; a file
   * extension states something about one file.
   */
  assert.deepEqual(detectPresets(['index.js', 'build.py', 'tool.rs', 'x.go']), []);
});

test('⚠️ nothing recognisable enables nothing — no guessing', () => {
  assert.deepEqual(detectPresets([]), []);
  assert.deepEqual(detectPresets(['README.md', 'LICENSE']), []);
  assert.deepEqual(detectPresets(undefined), []);
});

test('⭐ a polyglot repo gets both grammars, in a stable order', () => {
  const twice = [
    detectPresets(['Cargo.toml', 'Makefile', 'pyproject.toml']),
    detectPresets(['Makefile', 'pyproject.toml', 'Cargo.toml']),
  ];
  assert.deepEqual(twice[0], ['python', 'rust', 'make']);
  assert.deepEqual(twice[0], twice[1], 'order must not depend on directory listing order');
});

test('⚠️ make ADDS a grammar rather than identifying the project', () => {
  /**
   * A Makefile sits beside a Cargo.toml far more often than it stands alone, so
   * it must never suppress the language that is actually there.
   */
  assert.deepEqual(detectPresets(['Cargo.toml', 'Makefile']), ['rust', 'make']);
  assert.deepEqual(detectPresets(['Makefile']), ['make']);
});

test('⚠️⚠️ every preset this names must actually EXIST in the command module', () => {
  /**
   * A detector that enables `pyhton` fails silently: nothing turns on, the
   * agent refuses, and the reason looks like the user's project rather than our
   * typo. Checked against the real registry so a rename cannot leave this
   * pointing at a preset that is gone.
   */
  for (const { preset } of LANGUAGE_MARKERS) {
    assert.ok(PRESET_NAMES.includes(preset), `${preset} is not a real preset — detection would be a no-op`);
  }
});

test('⭐ the description names the EVIDENCE, not just the decision', () => {
  /**
   * "python enabled" reads as the tool deciding something about your machine.
   * "python (pyproject.toml)" shows the evidence, so a wrong call tells you
   * exactly which file to look at.
   */
  assert.equal(describeDetected(['pyproject.toml']), 'python (pyproject.toml)');
  assert.equal(describeDetected(['go.mod', 'Makefile']), 'go (go.mod) · make (Makefile)');
  assert.equal(describeDetected([]), null);
});

test('⭐⭐ a pytest suite with no manifest still gets Python', () => {
  /**
   * ⚠️ ADDED BECAUSE A BENCHMARK FAILED, which is the shape of overfitting — so
   * the rule has to stand on its own. It does: a stray `build.py` is somebody's
   * script, but `test_stats.py` or `conftest.py` is somebody declaring a suite
   * exists and is meant to run. Plenty of real Python projects carry no
   * pyproject.toml, and "run the failing test" is what this agent is FOR.
   */
  assert.deepEqual(detectPresets(['stats.py', 'test_stats.py']), ['python']);
  assert.deepEqual(detectPresets(['thing.py', 'thing_test.py']), ['python']);
  assert.deepEqual(detectPresets(['conftest.py']), ['python']);
});

test('⚠️ a lone source file is STILL not evidence — the line held', () => {
  assert.deepEqual(detectPresets(['index.js', 'build.py']), []);
  assert.deepEqual(detectPresets(['package.json', 'deploy.py']), []);
});

test('⚠️ a manifest is not counted twice when a test file is also present', () => {
  assert.deepEqual(detectPresets(['pyproject.toml', 'test_x.py']), ['python']);
});
