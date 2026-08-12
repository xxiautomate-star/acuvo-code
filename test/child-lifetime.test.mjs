/**
 * ── ⚠️⚠️ THE FOURTH TIME IS WHY THIS FILE EXISTS ────────────────────────────
 *
 * On 2026-08-12 the same defect was found in four unrelated modules in one
 * night: a spawned helper with piped stdio, never unref'd, silently holding its
 * owner's event loop open forever. It presented differently every time — a
 * "slow" test suite, a file-level timeout, a fresh clone of the public repo
 * exiting 1 — and each instance was diagnosed from scratch because nothing
 * asserted the RULE.
 *
 * ⭐ So the first test here is STRUCTURAL: it reads lib/ and fails when any
 * module spawns a long-lived child without detaching it. A per-instance test
 * would have caught one of the four. This catches the fifth, in a module nobody
 * has written yet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detachChild, deleteIfCurrent } from '../lib/child-lifetime.mjs';

const LIB = fileURLToPath(new URL('../lib', import.meta.url));

/**
 * A module spawns a LONG-LIVED helper if it calls spawn with piped stdio.
 * `stdio: 'ignore'` (the taskkill reaper) and one-shot command execution that
 * awaits 'close' are deliberately not in scope — those end on their own.
 */
/**
 * ⚠️ COMMENTS MUST BE STRIPPED FIRST, and this is not fussiness. The first
 * version of this file tested the raw source, so commenting the call out —
 * `// detachChild(child)` — still satisfied it. The mutation check passed the
 * bug straight through, which made this a test that could not fail.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments, including the doc blocks above each call
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, without eating the // in a URL
}

function longLivedSpawners() {
  const out = [];
  for (const name of readdirSync(LIB)) {
    if (!name.endsWith('.mjs') || name === 'child-lifetime.mjs') continue;
    const code = stripComments(readFileSync(join(LIB, name), 'utf8'));
    if (!/spawnImpl\(|spawn\(/.test(code)) continue;
    if (!/stdio:\s*\[\s*'pipe'/.test(code)) continue;
    out.push({ name, src: code });
  }
  return out;
}

test('⭐⭐ every module that spawns a piped child detaches it — the rule, not the instances', () => {
  const spawners = longLivedSpawners();

  // ⚠️ If this trips, the detection above broke, and a green suite would then be
  // asserting nothing at all. That is the failure mode this package forbids.
  assert.ok(
    spawners.length >= 4,
    `expected at least 4 modules spawning piped children, found ${spawners.length} (${spawners.map((s) => s.name).join(', ')}) — the detector is broken, not the code`,
  );

  const offenders = spawners.filter((s) => !/detachChild\s*\(/.test(s.src));
  assert.deepEqual(
    offenders.map((o) => o.name),
    [],
    'these spawn a long-lived child with piped stdio and never call detachChild() — '
      + 'each one can hold acuvo open forever after the work is done. See lib/child-lifetime.mjs.',
  );
});

test('detachChild unrefs the process AND all three pipes — three of four is still a hang', () => {
  const calls = [];
  const pipe = (n) => ({ unref: () => calls.push(n) });
  const fake = {
    unref: () => calls.push('child'),
    stdin: pipe('stdin'),
    stdout: pipe('stdout'),
    stderr: pipe('stderr'),
  };

  assert.equal(detachChild(fake), true);
  assert.deepEqual(calls.sort(), ['child', 'stderr', 'stdin', 'stdout']);
});

test('detachChild survives a stub, a dead child and being called twice', () => {
  assert.equal(detachChild(null), false, 'null is not an error');
  assert.equal(detachChild(undefined), false);
  assert.equal(detachChild({}), false, 'a stubbed child with no handles reports nothing done');

  const thrower = {
    unref() { throw new Error('already gone'); },
    stdin: { unref() { throw new Error('closed'); } },
    stdout: null,
    stderr: undefined,
  };
  assert.doesNotThrow(() => detachChild(thrower), 'a dying child must not take the caller with it');

  const twice = { unref: () => {}, stdin: { unref: () => {} }, stdout: null, stderr: null };
  assert.equal(detachChild(twice), true);
  assert.equal(detachChild(twice), true, 'idempotent');
});

test('⭐ deleteIfCurrent refuses to evict a SUCCESSOR registered under the same key', () => {
  /**
   * This is the exact bug: the dead session's late exit handler runs after a
   * replacement has been registered, and an unconditional delete removes the
   * live one — after which nothing can ever find it to release it.
   */
  const registry = new Map();
  const dead = { id: 'first' };
  const live = { id: 'second' };

  registry.set('/ws', dead);
  assert.equal(deleteIfCurrent(registry, '/ws', dead), true, 'its own entry goes');
  assert.equal(registry.has('/ws'), false);

  registry.set('/ws', live);
  assert.equal(
    deleteIfCurrent(registry, '/ws', dead), false,
    'the DEAD session must not be able to delete the LIVE one',
  );
  assert.equal(registry.get('/ws'), live, 'the successor is still reachable, so reset can still release it');
});

test('deleteIfCurrent is safe on a missing key and a non-registry', () => {
  const registry = new Map();
  assert.equal(deleteIfCurrent(registry, '/nope', { id: 'x' }), false);
  assert.equal(deleteIfCurrent(null, '/ws', {}), false);
  assert.equal(deleteIfCurrent(undefined, '/ws', {}), false);
  assert.equal(deleteIfCurrent({}, '/ws', {}), false, 'an object that is not a Map is not a crash');
});
