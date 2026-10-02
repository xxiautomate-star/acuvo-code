/**
 * ── ⭐⭐⭐ `acuvo-rules.json` — A CONSTRAINT, NOT AN INSTRUCTION ─────────────
 *
 * Roman, 2026-08-27: *"Studio leads will not trust an AI that can modify any
 * file it wants. They need hard, mathematical restrictions."*
 *
 * The claim this file has to prove is narrow and total: a path the project
 * locked cannot be written **through the executor the model is handed**, by any
 * spelling, and the lock cannot be edited away by the thing it is restraining.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProjectRules, writeRefusal, describeProjectRules, loadProjectRules, globToRegExp, MAX_PATTERNS,
} from '../lib/project-rules.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const rules = (doc) => parseProjectRules(JSON.stringify(doc));

test('no policy file means nothing changes for anybody', () => {
  assert.equal(parseProjectRules(null).kind, 'none');
  assert.equal(parseProjectRules('').kind, 'none');
  assert.equal(parseProjectRules('   \n ').kind, 'none');
  assert.equal(writeRefusal(parseProjectRules(null), 'anything/at/all.ts'), null);
});

test('⭐ a protected directory refuses every file beneath it', () => {
  const r = rules({ protect: ['Core/GraphicsEngine'] });
  assert.match(writeRefusal(r, 'Core/GraphicsEngine/renderer.cpp'), /protected by "Core\/GraphicsEngine"/);
  assert.match(writeRefusal(r, 'Core/GraphicsEngine/vk/device.h'), /cannot be modified/);
  // ...and nothing outside it.
  assert.equal(writeRefusal(r, 'Gameplay/Scripts/Health.cs'), null);
  assert.equal(writeRefusal(r, 'Core/Audio/mixer.cpp'), null);
});

test('⚠️⚠️ the lock survives every spelling of the same path', () => {
  /**
   * ⭐ THIS IS THE TEST THAT MATTERS. A lock a model walks past by writing
   * `./Core/x` instead of `Core/x` is theatre. `createLocalExecutor` checks the
   * RESOLVED relative path for exactly this reason; these assert the parser
   * half is not the weak link either.
   */
  const r = rules({ protect: ['Core/**'] });
  for (const spelling of ['Core/x.cpp', './Core/x.cpp', 'Core\\x.cpp', '/Core/x.cpp', 'core/x.cpp', 'CORE/X.CPP']) {
    assert.notEqual(writeRefusal(r, spelling), null, `${spelling} slipped through the lock`);
  }
});

test('⭐ allowWrite is exhaustive — anything unlisted is refused', () => {
  const r = rules({ allowWrite: ['Gameplay/Scripts/**', 'Assets/UI/**'] });
  assert.equal(writeRefusal(r, 'Gameplay/Scripts/Player.cs'), null);
  assert.equal(writeRefusal(r, 'Assets/UI/hud.uxml'), null);
  assert.match(writeRefusal(r, 'Core/engine.cpp'), /outside the paths/);
  // ⭐ And it NAMES where writing is permitted, so the model's next move is right.
  assert.match(writeRefusal(r, 'Core/engine.cpp'), /Gameplay\/Scripts\/\*\*, Assets\/UI\/\*\*/);
});

test('⚠️ protect beats allowWrite — the more specific rule is the stronger one', () => {
  const r = rules({ allowWrite: ['Gameplay/**'], protect: ['Gameplay/Netcode/**'] });
  assert.equal(writeRefusal(r, 'Gameplay/Player.cs'), null);
  assert.match(writeRefusal(r, 'Gameplay/Netcode/replication.cs'), /protected by/);
});

test('⚠️⚠️ the policy file cannot edit itself out of existence', () => {
  /**
   * Without this the obvious first move after a refusal is to rewrite the
   * rules — which would make the entire feature decorative.
   */
  const r = rules({ protect: ['Core/**'] });
  assert.match(writeRefusal(r, 'acuvo-rules.json'), /grant permission rather than do the task/);
  assert.match(writeRefusal(r, '.acuvo/rules.json'), /grant permission rather than do the task/);
});

test('⚠️⚠️ a malformed policy fails CLOSED, loudly, with the parse error', () => {
  const broken = parseProjectRules('{ "protect": ["Core/**"], }');
  assert.equal(broken.kind, 'broken');
  assert.match(writeRefusal(broken, 'anything.txt'), /not valid JSON/);
  // Every write, not just the locked ones — that is what "closed" means.
  assert.notEqual(writeRefusal(broken, 'README.md'), null);
});

test('⚠️ a policy of the wrong SHAPE is broken too, not silently ignored', () => {
  assert.equal(parseProjectRules('{"protect":"Core/**"}').kind, 'broken');
  assert.equal(parseProjectRules('{"protect":[""]}').kind, 'broken');
  assert.equal(parseProjectRules('[]').kind, 'broken');
  assert.equal(parseProjectRules('{"protect":' + JSON.stringify(Array.from({ length: MAX_PATTERNS + 1 }, () => 'a')) + '}').kind, 'broken');
});

test('⭐ the reason a lead wrote is passed to the model', () => {
  const r = rules({ protect: ['Core/**'], reason: 'the render team owns this, ask #graphics' });
  assert.match(writeRefusal(r, 'Core/x.cpp'), /the render team owns this, ask #graphics/);
});

test('globs: ** crosses separators, * does not', () => {
  assert.ok(globToRegExp('*.uasset').test('Hero.uasset'));
  assert.ok(!globToRegExp('*.uasset').test('Art/Hero.uasset'));
  assert.ok(globToRegExp('**/*.uasset').test('Art/Chars/Hero.uasset'));
  // ⭐ A regex metacharacter in a real directory name is matched literally.
  assert.ok(globToRegExp('Graphics(v2)/**').test('Graphics(v2)/a.cpp'));
  assert.ok(!globToRegExp('Graphics(v2)/**').test('Graphicsv2/a.cpp'));
});

test('a human-readable summary exists, because a silent guard gets blamed', () => {
  assert.match(describeProjectRules(rules({ protect: ['a', 'b'] })), /2 protected/);
  assert.match(describeProjectRules(parseProjectRules('{')), /^⚠️/);
  assert.equal(describeProjectRules(parseProjectRules(null)), null);
});

test('the committed root file wins over the private one', () => {
  const seen = [];
  const read = (name) => { seen.push(name); return name === 'acuvo-rules.json' ? '{"protect":["A"]}' : '{"protect":["B"]}'; };
  const loaded = loadProjectRules(read);
  assert.equal(loaded.source, 'acuvo-rules.json');
  assert.deepEqual(seen, ['acuvo-rules.json']);
});

/**
 * ── ⭐⭐⭐ THE END-TO-END CLAIM: THE EXECUTOR REFUSES ON DISK ────────────────
 *
 * Everything above tests a decision. This tests the WIRE — that the decision
 * reaches `createLocalExecutor`, which is the only object the model can touch a
 * filesystem through. A rule that is correct and unwired is [[the pattern this
 * repo keeps finding]]: built, tested, reached by nothing.
 */
test('⭐⭐⭐ a locked file cannot be written or deleted through the real executor', () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-rules-'));
  try {
    mkdirSync(join(root, 'Core', 'GraphicsEngine'), { recursive: true });
    mkdirSync(join(root, 'Gameplay', 'Scripts'), { recursive: true });
    writeFileSync(join(root, 'Core', 'GraphicsEngine', 'renderer.cpp'), 'ORIGINAL', 'utf8');

    const policy = parseProjectRules(JSON.stringify({
      protect: ['Core/GraphicsEngine/**'],
      reason: 'owned by the render team',
    }));
    const exec = createLocalExecutor(root, { rules: policy });

    const wrote = exec.writeFile('Core/GraphicsEngine/renderer.cpp', 'HACKED');
    assert.equal(wrote.ok, false);
    assert.match(wrote.error, /protected by/);
    // ⚠️ THE FILE ON DISK IS THE PROOF, not the return value.
    assert.equal(readFileSync(join(root, 'Core', 'GraphicsEngine', 'renderer.cpp'), 'utf8'), 'ORIGINAL');

    // The dot-slash spelling, which is where a naive check would leak.
    assert.equal(exec.writeFile('./Core/GraphicsEngine/renderer.cpp', 'HACKED').ok, false);
    // And the traversal spelling, which resolves to the same file.
    assert.equal(exec.writeFile('Gameplay/../Core/GraphicsEngine/renderer.cpp', 'HACKED').ok, false);
    assert.equal(readFileSync(join(root, 'Core', 'GraphicsEngine', 'renderer.cpp'), 'utf8'), 'ORIGINAL');

    // Deleting is modifying.
    assert.equal(exec.deleteFile('Core/GraphicsEngine/renderer.cpp').ok, false);
    assert.ok(existsSync(join(root, 'Core', 'GraphicsEngine', 'renderer.cpp')));

    // ⭐ AND PERMITTED WORK STILL HAPPENS — a guard that blocks everything is
    // not a guard, it is an outage.
    const allowed = exec.writeFile('Gameplay/Scripts/Health.cs', 'class Health {}');
    assert.equal(allowed.ok, true);
    assert.ok(existsSync(join(root, 'Gameplay', 'Scripts', 'Health.cs')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ an executor with NO rules is byte-identical to before', () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-norules-'));
  try {
    const exec = createLocalExecutor(root);
    assert.equal(exec.writeFile('Core/GraphicsEngine/renderer.cpp', 'x').ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
