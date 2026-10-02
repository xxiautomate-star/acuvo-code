// ⭐ `node --test test/` must run the tests in test/ (2026-09-26, a real run).
// Node 22 loads a directory operand as a MODULE ("Cannot find module
// '<ws>\test'"), so a correct run was reported NOT VERIFIED when the final
// check re-ran that command. `buildInvocation` now expands the directory to the
// files Node's own discovery would pick — and leaves it alone when there are none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildInvocation, expandTestDirectories, validateCommand } from '../lib/command.mjs';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-testdir-'));
  mkdirSync(join(root, 'test', 'fixtures'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'test', 'a.test.mjs'), "import {test} from 'node:test'; test('a', () => {});\n");
  writeFileSync(join(root, 'test', 'fixtures', 'data.txt'), 'x\n');
  writeFileSync(join(root, 'src', 'lib.mjs'), 'export const x = 1;\n');
  writeFileSync(join(root, 'src', 'lib.test.mjs'), "import {test} from 'node:test'; test('b', () => {});\n");
  return root;
}

test('a directory after --test becomes the test files inside it', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(expandTestDirectories(['--test', 'test/'], root), ['--test', 'test/a.test.mjs']);
  // Outside a `test/` segment only test-named files count — src/lib.mjs is not a test.
  assert.deepEqual(expandTestDirectories(['--test', 'src'], root), ['--test', 'src/lib.test.mjs']);
  assert.deepEqual(expandTestDirectories(['--test', '.'], root), ['--test', 'src/lib.test.mjs', 'test/a.test.mjs']);
});

test('files, globs, flags, a script and an empty directory pass through untouched', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'empty'));
  assert.deepEqual(expandTestDirectories(['--test', 'test/a.test.mjs'], root), ['--test', 'test/a.test.mjs']);
  assert.deepEqual(expandTestDirectories(['--test', 'test/*.test.mjs'], root), ['--test', 'test/*.test.mjs']);
  assert.deepEqual(expandTestDirectories(['--test', 'empty'], root), ['--test', 'empty'], 'no tests → still fails loudly, never a vacuous green');
  assert.deepEqual(expandTestDirectories(['app.mjs', '--test', 'test'], root), ['app.mjs', '--test', 'test'], 'after a script, --test is the program\'s');
  assert.deepEqual(expandTestDirectories(['test/a.test.mjs'], root), ['test/a.test.mjs']);
});

test('end to end: the invocation for `node --test test/` really runs the test', (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const valid = validateCommand('node --test test/');
  assert.equal(valid.ok, true);
  const inv = buildInvocation(valid, root, { env: { ACUVO_SANDBOX: 'off' } });
  assert.equal(inv.ok, true);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const r = spawnSync(inv.file, inv.args, { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /# pass 1/);
});
