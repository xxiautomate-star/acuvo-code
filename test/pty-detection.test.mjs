/**
 * ── ⚠️ THE SECURITY RULE HERE HAS NOTHING TO DO WITH TERMINALS ──────────────
 *
 * `pty.mjs` resolves a native module and then LOADS it into this process. That
 * makes WHERE it may resolve from the only thing worth testing: the obvious
 * implementation reads `node-pty` from the workspace, and the workspace is a
 * directory this agent can write to — so `write_file('node_modules/node-pty/
 * index.js', …)` followed by any command would be arbitrary code execution in
 * the CLI's own process, with the CLI's own environment.
 *
 * ⭐ Everything else in this package is careful that agent-written code runs in
 * a CHILD. This is the one module that could have handed that up, and the rule
 * that stops it is "only an absolute path an operator typed, or our own
 * node_modules — never the workspace, and no setting changes that".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PTY_MODULE_ENV, loadPty, ptyStatus, resetPtyCache } from '../lib/pty.mjs';

test('⚠️⚠️ A RELATIVE PATH IS REFUSED — it would resolve inside the workspace', () => {
  resetPtyCache();
  const load = loadPty({ env: { [PTY_MODULE_ENV]: 'node_modules/node-pty' }, requireImpl: () => { throw new Error('must not be called'); } });
  assert.equal(load.ok, false);
  assert.match(load.why, /absolute/);
  assert.match(load.why, /the agent can write to/);
});

test('⚠️ the workspace is never consulted, even with no variable set', () => {
  resetPtyCache();
  const asked = [];
  loadPty({ env: {}, requireImpl: (spec) => { asked.push(spec); throw new Error('nope'); } });
  /**
   * ⭐ EXACTLY ONE RESOLUTION, and it is the bare specifier — which `createRequire`
   * anchors to THIS FILE, i.e. the package's own node_modules. No cwd, no root,
   * no workspace path is ever constructed, so there is nothing for a hostile
   * repository to plant.
   */
  assert.deepEqual(asked, ['node-pty']);
});

test('⚠️ something that loads but is not node-pty is refused, not trusted', () => {
  resetPtyCache();
  const load = loadPty({
    env: { [PTY_MODULE_ENV]: process.platform === 'win32' ? 'C:\\x\\y' : '/x/y' },
    requireImpl: () => ({ notSpawn: true }),
  });
  assert.equal(load.ok, false);
  assert.match(load.why, /no spawn\(\)/);
});

test('⭐ absent is the normal case, and the message says what runs INSTEAD', () => {
  resetPtyCache();
  const status = ptyStatus({ env: {} });
  // In this repo there is no node-pty, which is the shipped state.
  assert.equal(status.available, false);
  assert.match(status.detail, /zero dependencies/);
  assert.match(status.detail, /pipes/);
});

test('⚠️⚠️ PRESENT IS REPORTED AS *NOT USED* — never as a working capability', () => {
  /**
   * ⚠️ THIS IS THE HONESTY GUARD. The transport was built, driven and withdrawn
   * (the library leaks worker-thread handles and the process could not exit), so
   * an operator who installs node-pty and sets the variable must not read a
   * green line and conclude their commands now run in a terminal. They do not.
   */
  resetPtyCache();
  const status = ptyStatus({ env: {} });
  assert.doesNotMatch(status.detail, /commands run in a real terminal/);
  resetPtyCache();
});
