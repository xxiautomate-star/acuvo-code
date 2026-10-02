/**
 * ── ⭐⭐ THE RELEVANCE WIN WAS BUILT AND UNREACHABLE ─────────────────────────
 *
 * `lib/repo-map.mjs` shipped personalized PageRank — `parseMentions`,
 * `normaliseMentions`, `RANK_SEED_SHARE`, `MENTIONED_IDENT_WEIGHT`, a whole
 * seeded random walk — and documented the point of it at `buildRepoMap`:
 *
 *   *"⭐ `task` IS THE WHOLE POINT OF THE RANKING BEING *PERSONALIZED*. Pass
 *   the user's own request and the walk is seeded at the files they named; pass
 *   nothing and the ranking degrades to a static importance score, which is
 *   still strictly better than alphabetical but is the same for every
 *   question."*
 *
 * ⚠️⚠️ AND THE ONE CALL SITE IN THE PACKAGE PASSED NOTHING. `turn.mjs` read
 * `repoMapForExecutor(executor)`, so every real run got the degraded ordering
 * while `test/repo-map-rank.test.mjs` proved the feature worked — by calling
 * `buildRepoMap` directly with a `task` no production path ever supplied.
 *
 * ⭐ THAT IS WHY THIS FILE TESTS THE CALLER AND NOT THE MODULE. A module test
 * cannot fail on a missing argument; only a run through `runSession` can. It
 * costs $0.00 — the model is scripted and never called for real.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSession } from '../lib/turn.mjs';
import { repoMapForExecutor } from '../lib/repo-map.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

/**
 * ⚠️ BIG ENOUGH THAT THE MAP HAS TO CHOOSE, WHICH IS THE ONLY SIZE AT WHICH
 * PERSONALIZATION IS OBSERVABLE. Measured on this fixture: at 600 and at 930
 * files the map fits comfortably and renders identically for every task, so a
 * smaller tree would have produced a test that passes whether or not the
 * argument is forwarded. At 40 packages x 41 files the symbol budget binds and
 * the ranking decides which files get their exports shown.
 *
 * Each leaf imports its package hub, so there is a REAL symbol graph for the
 * walk to travel — with no edges, PageRank is uniform and seeding changes
 * nothing.
 */
const PACKAGES = 40;
const LEAVES = 40;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-repomap-task-'));
  made.push(root);
  for (let p = 0; p < PACKAGES; p += 1) {
    const dir = join(root, `pkg${String(p).padStart(2, '0')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hub.mjs'), `export function hub${p}Thing() { return ${p}; }\n`);
    for (let i = 0; i < LEAVES; i += 1) {
      writeFileSync(
        join(dir, `leaf${String(i).padStart(2, '0')}.mjs`),
        `import { hub${p}Thing } from './hub.mjs';\nexport const v${p}_${i} = hub${p}Thing();\n`,
      );
    }
  }
  return root;
}

/** Drive one real session and hand back the pre-read the model was actually sent. */
async function repoMapAsSent(root, task) {
  let firstUser = null;
  const callModelImpl = async (opts) => {
    if (firstUser === null) {
      const m = opts.messages.find((x) => x.role === 'user');
      firstUser = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    }
    return { ok: true, content: 'done', toolCalls: [], usage: { cost: 0, total_tokens: 10 }, finishReason: 'stop', model: 'fake/model' };
  };
  await runSession({
    task,
    executor: createLocalExecutor(root),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds: 1,
    allowRun: false,
    callModelImpl,
    onEvent: () => {},
  });
  assert.ok(firstUser, 'the session never sent a user message — the harness is broken, not the feature');
  return firstUser;
}

test('⭐⭐ the task REACHES the repo map through runSession — the SENT map is the personalized one', async () => {
  const root = workspace();
  const executor = createLocalExecutor(root);

  const taskOne = 'fix hub1Thing in pkg01/hub.mjs';
  const taskOther = 'fix hub39Thing in pkg39/hub.mjs';
  const askedAboutOne = await repoMapAsSent(root, taskOne);
  const askedAboutOther = await repoMapAsSent(root, taskOther);

  /**
   * ── ⚠️ THE OBVIOUS ASSERTION HERE IS VACUOUS, AND IT WAS WRITTEN FIRST ────
   *
   * `assert.notEqual(askedAboutOne, askedAboutOther)` PASSES even with the task
   * dropped — measured, not assumed. The first user message carries the user's
   * own request as well as the pre-read, so the two messages differ because the
   * two TASKS differ, whether or not the map ever saw one. A guard that cannot
   * fail is worse than no guard.
   *
   * ⭐ SO IT IS ANCHORED TO THE MODULE'S OWN OUTPUT INSTEAD: the map that was
   * SENT must be the one `repo-map.mjs` produces FOR THIS TASK, and must not be
   * the unpersonalized one it produces for no task. Both halves are needed —
   * the first alone would pass if the two happened to coincide.
   */
  const personalized = repoMapForExecutor(executor, { task: taskOne });
  const unpersonalized = repoMapForExecutor(executor);
  assert.notEqual(personalized, unpersonalized,
    'the fixture cannot tell the two rankings apart, so nothing below proves anything — grow the tree');

  assert.ok(askedAboutOne.includes(personalized),
    'the pre-read sent to the model is not the map ranked for this task');
  assert.equal(askedAboutOne.includes(unpersonalized), false,
    'the model was sent the STATIC ranking — turn.mjs is calling repoMapForExecutor without the task');

  /**
   * ⭐ AND IT IS PERSONALIZED IN THE RIGHT DIRECTION, not merely different.
   * The file the user named carries its exported symbols; the same file in the
   * other run does not. A test that only asserted "different" would pass on any
   * source of noise, including a timestamp.
   */
  const symbolsShownFor = (map, path) => map
    .split('\n')
    .some((line) => line.trim().startsWith(path) && line.includes('['));

  assert.ok(symbolsShownFor(askedAboutOne, 'pkg01/hub.mjs'),
    'the file named in the task did not earn its symbols — the seed is not landing on it');
  assert.ok(symbolsShownFor(askedAboutOther, 'pkg39/hub.mjs'),
    'the other run did not lift the file ITS task named');
  /**
   * ── ⚠️ THE NEGATIVE HALF NEEDED A NEW DISCRIMINATOR, BECAUSE THE OLD ONE
   *    STOPPED DISCRIMINATING ──────────────────────────────────────────────
   *
   * It used to be `symbolsShownFor(askedAboutOther, 'pkg01/hub.mjs') === false`
   * — "a file the task never mentioned must not carry symbols". That worked
   * only while the INVARIANT block could afford almost no symbol lists. Since
   * 2026-08-29 the allocator reserves `SYMBOL_RESERVE_SHARE` of the static
   * budget for them, so `pkg01/hub.mjs` and `pkg39/hub.mjs` — which are
   * perfectly symmetric under the static ranking — now both carry symbols in
   * BOTH runs. The assertion was not detecting personalization any more; it was
   * detecting a budget shortage, and it would have gone on "passing" for a
   * reason that had nothing to do with the feature.
   *
   * ⭐ WHAT STILL BITES IS THE DUPLICATE. A file the task NAMED is deliberately
   * rendered twice — once in the invariant listing and once again in the task
   * tranche (see `namedFiles` in repo-map.mjs) — and a file it did not name
   * appears exactly once. Measured on this fixture: pkg01/hub.mjs appears 2x in
   * its own run and 1x in the other, and pkg39/hub.mjs the mirror image. That
   * is a fact about the SEED landing, and it cannot be produced by any static
   * ranking, however much budget the symbols get.
   */
  const timesListed = (map, path) => map.split('\n').filter((line) => line.trim().startsWith(path)).length;

  assert.equal(timesListed(askedAboutOne, 'pkg01/hub.mjs'), 2,
    'the file this task named was not lifted into the task tranche — the seed is not landing on it');
  assert.equal(timesListed(askedAboutOther, 'pkg01/hub.mjs'), 1,
    'pkg01/hub.mjs was lifted into the task tranche of a run that never mentioned it — that is the static ranking, not a seeded one');
  assert.equal(timesListed(askedAboutOther, 'pkg39/hub.mjs'), 2, 'the mirror case does not hold — the fixture is not symmetric');
  assert.equal(timesListed(askedAboutOne, 'pkg39/hub.mjs'), 1);
});

test('⚠️⚠️ DETERMINISM — the same tree and the same task render byte-identical bytes', async () => {
  /**
   * The property the prompt cache is built on. `repo-map.mjs` earns it with a
   * code-point sort, a constant tolerance, a bounded iteration count and the
   * rank quantum; personalizing the walk must not put a foot through any of
   * them. If this fails, every resumed or retried run pays full price for a
   * prefix it should have reused.
   */
  const root = workspace();
  const task = 'fix hub7Thing in pkg07/hub.mjs';

  const first = await repoMapAsSent(root, task);
  const second = await repoMapAsSent(root, task);
  assert.equal(first, second, 'two runs of the SAME task over the SAME tree disagreed — the prefix cache is dead');

  // ...and the module agrees with the caller, byte for byte, so nothing is
  // being reshaped in transit between them.
  const direct = repoMapForExecutor(createLocalExecutor(root), { task });
  assert.ok(first.includes(direct),
    'the pre-read the model received is not the map the module produced for this task');
});

test('⭐ the CALL SITE itself passes the task — the seam, named, so it cannot silently unwire', async () => {
  /**
   * ⚠️ A BELT-AND-BRACES CHECK, DELIBERATELY INDEPENDENT OF THE FIXTURE ABOVE.
   * The behavioural tests only discriminate while the tree is big enough for
   * the symbol budget to bind; if a future change to `MAX_SYMBOL_READS` or the
   * budget moved that boundary, they would go red rather than silently stop
   * proving anything — but this one cannot stop proving it at all.
   */
  const src = readFileSync(join(HERE, '..', 'lib', 'turn.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')       // comments quote the old broken form
    .replace(/^\s*\/\/.*$/gm, '');
  const calls = src.match(/repoMapForExecutor\([^)]*\)/g) ?? [];
  assert.ok(calls.length > 0, 'turn.mjs no longer calls repoMapForExecutor at all');
  for (const call of calls) {
    assert.match(call, /\btask\b/,
      `${call} — the repo map is being built without the user's request, so the ranking is unpersonalized`);
  }
});
