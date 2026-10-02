// ⭐ A flag AFTER the script path is the program's, and run_command's refusal
// must name the door that passes it through (2026-09-26, a real run: `node
// wc2.mjs --json a.txt` was refused as "not an allowed node flag" with no way
// out, and the model hand-rolled spawnSync inside `evaluate` instead).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../lib/command.mjs';

test('a program flag after the script is still refused, but the refusal names run_program with the argv', () => {
  const v = validateCommand('node wc2.mjs --json test/a.txt');
  assert.equal(v.ok, false, 'the string door stays strict — background-argv.test.mjs pins that');
  assert.match(v.error, /--json is not an allowed node flag/, 'the original sentence is kept as a prefix');
  assert.match(v.error, /AFTER the script wc2\.mjs/);
  assert.match(v.error, /run_program/);
  assert.ok(v.error.includes('{"program":"node","args":["wc2.mjs","--json","test/a.txt"]}'), v.error);
});

test('a refused flag BEFORE the script gets no way-out — it really is node\'s', () => {
  const v = validateCommand('node --json wc2.mjs');
  assert.equal(v.ok, false);
  assert.doesNotMatch(v.error, /run_program/);
});

test('an allowed command is untouched', () => {
  assert.equal(validateCommand('node wc2.mjs test/a.txt').ok, true);
  assert.equal(validateCommand('node --test test/a.test.mjs').ok, true);
});
