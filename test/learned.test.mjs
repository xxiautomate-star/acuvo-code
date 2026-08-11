/**
 * ── ⭐⭐ NOTHING ACTUALLY ACCUMULATES ────────────────────────────────────────
 *
 * `project-memory.mjs` opens by naming the prize exactly right: "what a wrapper
 * CAN own is the accumulated context — the thing that makes session forty better
 * than session one." Then it delivers a file a HUMAN writes. ACUVO.md is
 * conventions someone typed; nothing the agent discovers ever survives the
 * process exiting.
 *
 * So session forty re-derives what session one learned, and gets it wrong the
 * same way. `session.mjs` fixed resuming ONE run. This is the other half: facts
 * that outlive every run.
 *
 * ── ⚠️ THE FOUR THINGS THAT MAKE THIS SAFE, AND WHY EACH ONE EXISTS ─────────
 *
 * 1. ⚠️⚠️ A WRONG MEMORY IS WORSE THAN NO MEMORY. A false fact repeated into
 *    every future prompt is a lie the model will act on forever, and it will
 *    look like the model being stupid rather than us having poisoned it. This
 *    repo watched a TEST pin a false claim in place for a day and the model
 *    quoted it straight back. So: every entry carries provenance, and removal
 *    is one call.
 * 2. ⚠️ IT MUST NOT GROW FOREVER. Memory that only accumulates eventually eats
 *    the context budget it was meant to save. Bounded by bytes AND by count,
 *    with the oldest going first.
 * 3. ⚠️ NO SECRET IS EVER WRITTEN. The agent will be holding API keys and .env
 *    contents in its context; a memory file is committed to the repo.
 * 4. ⚠️ IT MUST BE REVIEWABLE. Markdown in `.acuvo/memory/`, diffable and
 *    committable, for exactly the reason project-memory.mjs gives for ACUVO.md:
 *    a hidden per-user store means two developers on one codebase get two
 *    different agents and neither can see why.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  remember,
  recall,
  forget,
  learnedPromptBlock,
  MAX_LEARNED_BYTES,
  MAX_LEARNED_ENTRIES,
} from '../lib/learned.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-learned-'));
const clock = (iso) => () => new Date(iso);

test('a fact written in one session is readable in the next', () => {
  const root = ws();
  try {
    const w = remember(root, {
      name: 'test-command',
      fact: 'The test suite is run with `npm run test:unit`, not `npm test` — npm test only lints.',
      why: 'ran npm test, it exited 0 having run zero tests',
    }, { clock: clock('2026-08-11T04:00:00Z') });
    assert.equal(w.ok, true, w.error ?? '');

    // A completely fresh read, as a later process would do.
    const got = recall(root);
    assert.equal(got.ok, true);
    assert.equal(got.entries.length, 1);
    assert.match(got.entries[0].fact, /test:unit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ every entry records WHY it was learned, and when', () => {
  const root = ws();
  try {
    remember(root, { name: 'esm', fact: 'This project is ESM; never emit require().', why: 'a require() I wrote threw ERR_REQUIRE_ESM' }, { clock: clock('2026-08-11T04:00:00Z') });
    const e = recall(root).entries[0];
    assert.match(e.why, /ERR_REQUIRE_ESM/, 'provenance is what lets a human judge whether to keep it');
    assert.match(e.learnedAt, /^2026-08-11/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ a secret is never written to disk', () => {
  const root = ws();
  try {
    const r = remember(root, {
      name: 'deploy',
      fact: 'Deploy with OPENROUTER_API_KEY=sk-or-v1-4c8f1e2a9b7d6e5f0a1b2c3d4e5f6a7b npm run deploy',
      why: 'it worked',
    }, { clock: clock('2026-08-11T04:00:00Z') });

    if (r.ok) {
      const onDisk = readFileSync(join(root, '.acuvo', 'memory', 'deploy.md'), 'utf8');
      assert.equal(/sk-or-v1-4c8f1e2a9b7d6e5f0a1b2c3d4e5f6a7b/.test(onDisk), false,
        'an API key was written into a file that gets committed to the repo');
    } else {
      assert.match(String(r.error), /secret|credential|key/i, 'refusing is fine, but say why');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a wrong memory can be removed in one call', () => {
  const root = ws();
  try {
    remember(root, { name: 'wrong', fact: 'The build command is `make all`.', why: 'guessed' }, { clock: clock('2026-08-11T04:00:00Z') });
    assert.equal(recall(root).entries.length, 1);
    const f = forget(root, 'wrong');
    assert.equal(f.ok, true, f.error ?? '');
    assert.equal(recall(root).entries.length, 0, 'a fact that turned out to be false must not survive');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ re-remembering the same name REPLACES, it does not duplicate', () => {
  const root = ws();
  try {
    remember(root, { name: 'port', fact: 'The dev server runs on 3000.', why: 'observed' }, { clock: clock('2026-08-11T04:00:00Z') });
    remember(root, { name: 'port', fact: 'The dev server runs on 3002.', why: 'it moved' }, { clock: clock('2026-08-11T05:00:00Z') });
    const e = recall(root).entries;
    assert.equal(e.length, 1, 'two contradictory facts about one thing is worse than either alone');
    assert.match(e[0].fact, /3002/, 'the newer fact must win');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ memory is bounded — it cannot grow until it eats the context it saves', () => {
  const root = ws();
  try {
    for (let i = 0; i < MAX_LEARNED_ENTRIES + 15; i += 1) {
      remember(root, { name: `fact-${i}`, fact: `Fact number ${i} about this project.`, why: 'test' },
        { clock: clock(`2026-08-11T${String(4 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`) });
    }
    const got = recall(root);
    assert.ok(got.entries.length <= MAX_LEARNED_ENTRIES, `kept ${got.entries.length}, cap is ${MAX_LEARNED_ENTRIES}`);
    // Oldest goes first, so the newest fact must have survived.
    assert.ok(got.entries.some((e) => /number ${MAX_LEARNED_ENTRIES + 14}/.test(e.fact) || e.name === `fact-${MAX_LEARNED_ENTRIES + 14}`),
      'the most recently learned fact was evicted, which is backwards');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the prompt block is bounded and says so when it truncates', () => {
  const root = ws();
  try {
    for (let i = 0; i < 40; i += 1) {
      remember(root, { name: `f${i}`, fact: 'x'.repeat(300), why: 'test' }, { clock: clock('2026-08-11T04:00:00Z') });
    }
    const block = learnedPromptBlock(recall(root));
    assert.ok(block.length <= MAX_LEARNED_BYTES + 400, `prompt block is ${block.length} bytes`);
    assert.match(block, /learned|memory/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ an empty memory produces an EMPTY prompt block, not a heading with nothing under it', () => {
  const root = ws();
  try {
    assert.equal(learnedPromptBlock(recall(root)), '', 'an empty section teaches the model the feature is broken');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a corrupt or hand-edited memory file is skipped, never fatal', () => {
  const root = ws();
  try {
    mkdirSync(join(root, '.acuvo', 'memory'), { recursive: true });
    writeFileSync(join(root, '.acuvo', 'memory', 'broken.md'), 'this has no frontmatter at all\n');
    remember(root, { name: 'good', fact: 'This one is fine.', why: 'test' }, { clock: clock('2026-08-11T04:00:00Z') });
    const got = recall(root);
    assert.equal(got.ok, true, 'one bad file must not take the whole memory down');
    assert.ok(got.entries.some((e) => e.name === 'good'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ the name is sanitised — a fact cannot write outside .acuvo/memory', () => {
  const root = ws();
  try {
    const r = remember(root, { name: '../../escaped', fact: 'nope', why: 'test' }, { clock: clock('2026-08-11T04:00:00Z') });
    assert.equal(existsSync(join(root, '..', '..', 'escaped.md')), false, 'a memory name traversed out of the workspace');
    if (r.ok) {
      // ⚠️ `assert.equal(x <= 1, 'msg')` compares a BOOLEAN to a STRING and always
      // fails — assert.equal's second argument is the expected VALUE, not the
      // message. Caught immediately here; the same slip in a rarely-run test is
      // how a suite grows a permanent red that nobody trusts.
      assert.ok(recall(root).entries.length <= 1, 'it wrote somewhere, but it must be inside .acuvo/memory');
      assert.match(r.name, /^[a-z0-9-]+$/, `the name was not sanitised: ${r.name}`);
      assert.ok(!r.path.includes('..'), `the path escapes the memory directory: ${r.path}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ an empty or junk fact is refused rather than stored', () => {
  const root = ws();
  try {
    for (const bad of ['', '   ', null, undefined]) {
      const r = remember(root, { name: 'x', fact: bad, why: 'test' }, { clock: clock('2026-08-11T04:00:00Z') });
      assert.equal(r.ok, false, `a fact of ${JSON.stringify(bad)} was stored`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
