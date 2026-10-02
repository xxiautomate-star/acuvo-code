/**
 * ── ⭐⭐⭐ `search_text` WAS 88.6% OF ALL TOOL WALL-CLOCK, AND IT BLOCKED ──────
 *
 * Measured 2026-09-01 across the 53 real rounds recorded in `.acuvo/sessions/`:
 * 8 `search_text` calls accounted for 22.4s of 25.2s of total tool time, and
 * ~98% of that was blocking `statSync` + `readFileSync` rather than matching.
 * Being synchronous, it also held the event loop for the whole call — so the
 * streaming printer stopped and **Ctrl-C did nothing** for up to 2.8s.
 *
 * Measured before and after, same query, same tree:
 *
 *     OLD (sync body)   473ms   event-loop ticks during the call: 0
 *     NEW (async)       421ms   event-loop ticks during the call: 84
 *
 * ⚠️ THE SPEEDUP IS NOT THE POINT AND IS DELIBERATELY NOT ASSERTED HERE. It is
 * about 1.1–1.4x depending on the query; concurrency-1 is actually SLOWER than
 * sync (0.61x — promise overhead is real), and the curve is flat from 8 onward.
 * A timing assertion would be flaky on a loaded machine and would pin the least
 * valuable of the three things this change bought.
 *
 * ⭐ THE THREE THINGS WORTH PINNING ARE BEHAVIOURAL:
 *   1. the loop stays live, so Ctrl-C and streaming work
 *   2. it is a real async function, which is what makes it eligible for the
 *      round scheduler's parallel hoisting — that only ever accepts verbs which
 *      are read-only AND genuinely async, and this was the single biggest cost
 *      that could not be hoisted
 *   3. the concurrency changed NOTHING a caller can observe — same matches,
 *      same skip list, same order
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { searchText } from '../lib/search.mjs';

/** A tree big enough that a search takes long enough to observe. */
function tree(files = 400) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-search-loop-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < files; i++) {
    const body = Array.from({ length: 120 }, (_, k) =>
      k === 61 ? `  const NEEDLE_${i} = ${k};` : `  // filler line ${k} ${'x'.repeat(60)}`).join('\n');
    writeFileSync(join(root, 'src', `mod-${i}.js`), `export function f${i}() {\n${body}\n}\n`);
  }
  return root;
}

test('⭐⭐⭐ the event loop stays LIVE during a search — Ctrl-C and streaming survive', async () => {
  const root = tree();
  try {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    let elapsed;
    try {
      const t0 = performance.now();
      const r = await searchText(root, 'NEEDLE_', {});
      elapsed = performance.now() - t0;
      assert.equal(r.ok, true);
      assert.ok(r.matches.length > 0, 'the fixture must actually match, or this measures nothing');
    } finally {
      clearInterval(timer);
    }

    /**
     * ⚠️ THE GUARD IS `ticks > 0`, NOT A RATIO. On a fast machine the search may
     * finish inside a couple of timer periods, and a ratio would make this
     * flaky for no extra signal — the defect being pinned is TOTAL starvation,
     * which is what a synchronous body produces. The old implementation scored
     * exactly 0 here every time.
     *
     * ⭐ It is skipped if the search was too quick to have contained a tick at
     * all, because then the test genuinely has nothing to say. Asserting
     * anyway would be a guard that passes for the wrong reason.
     */
    if (elapsed > 25) {
      assert.ok(ticks > 0, `the loop was starved for the whole ${elapsed.toFixed(0)}ms search — this is the sync regression`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ THIS IS THE HOISTING PRECONDITION, NOT A STYLE CHECK. `round-schedule.mjs`
 * will only run a verb beside another if it is read-only AND genuinely async —
 * a synchronous function wrapped in `Promise.all` is not concurrency, it is the
 * same serial work with extra allocation, measured at 1.01x for `read_file`.
 * If someone makes this sync again the scheduler silently stops helping, and
 * nothing else in the suite would notice.
 */
test('⭐ it is a real async function, which is what makes it hoistable', () => {
  assert.equal(searchText.constructor.name, 'AsyncFunction');
});

/**
 * ── ⚠️⚠️ TWO RUNS BEING EQUAL IS NOT ENOUGH, AND I PROVED THAT BY MUTATING ───
 *
 * The first version of this test asserted only that two searches return
 * byte-identical JSON. Then I reordered `plan` before phase C — a deliberate
 * scrambling of the output order — and **it stayed green**, because a
 * CONSISTENT reordering is still perfectly deterministic. A determinism test
 * cannot see a bug that happens the same way every time.
 *
 * ⭐ So it also pins the ORDER ITSELF against the walk. `matches` must arrive in
 * ascending file order, which is what the sequential implementation produced
 * and what paging with `offset` silently depends on: a caller asking for page 2
 * of a reordered result set gets a different window over the same repo.
 */
test('⚠️⚠️ concurrency changed nothing observable — same bytes, and still in WALK ORDER', async () => {
  const root = tree(120);
  try {
    const a = await searchText(root, 'NEEDLE_', {});
    const b = await searchText(root, 'NEEDLE_', {});
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'completion order leaked into the reply');

    /**
     * ⚠️ `rankMatches` reorders the returned PAGE deliberately, so the assertion
     * is on the file INDEX gathered from the match text, not on the array
     * position — the fixture writes `NEEDLE_<i>` inside `mod-<i>.js`, so the set
     * of files that made the page is what a reordering actually changes.
     */
    const seen = a.matches.map((m) => Number(m.path.match(/mod-(\d+)\.js/)?.[1] ?? -1));
    assert.ok(seen.every((n) => n >= 0), 'fixture drifted — every match should come from a mod-N.js');

    /**
     * The walk reaches `mod-0`, `mod-1`, `mod-10`… in directory order, and the
     * scan stops at the match cap. So the page must be drawn from the FRONT of
     * that order: the largest index on the page cannot exceed the number of
     * files the scan could possibly have reached to fill it.
     */
    assert.ok(seen.length > 8, 'the page must span more than one read batch or this proves nothing');

    /**
     * ⚠️⚠️ THE EXACT PAGE COMPOSITION, NOT A LOOSE PREFIX CHECK. My first version
     * asserted only that most matches came from low-numbered files, and a
     * `plan.reverse()` inside each batch sailed straight through it — the batch
     * is 8 contiguous walk entries, so reversing it leaves the SET almost
     * untouched except where the match cap cuts a batch in half.
     *
     * ⭐ That cut is precisely where a reordering becomes observable: page 1
     * holds one match per file, so the files on it must be the first N the walk
     * reaches, and `readdirSync` here is the same order the walk itself uses.
     * Comparing the sets catches any permutation that crosses the boundary.
     */
    const walkOrder = readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js'));
    const expected = walkOrder.slice(0, a.matches.length).sort();
    const got = a.matches.map((m) => m.path.split('/').pop()).sort();
    assert.deepEqual(
      got, expected,
      'page 1 is not the first N files of the walk — the read plan was reordered',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ── ⚠️⚠️⚠️ THE ONE THAT MUST NEVER GO GREEN BY ACCIDENT ─────────────────────
 *
 * A credential file is refused in PHASE A, before any read is scheduled —
 * refusing it after the read would mean the bytes were already in this process,
 * which is most of what the refusal is for. This is the property the batching
 * rewrite was most likely to break, because the obvious implementation reads
 * the whole batch first and filters afterwards.
 *
 * ⭐ WITHHELD, NOT DROPPED: the path is named so the model knows the file
 * exists and does not go and write a duplicate config.
 */
/**
 * ⚠️ THE TITLE USED TO SAY "REFUSED BEFORE IT IS READ" AND THE TEST DID NOT
 * CHECK THAT. I moved the refusal from phase A to phase C — so the bytes WERE
 * read and then discarded — and this stayed green, because dropping the
 * contents late looks identical from the outside. A title claiming a property
 * nobody verifies is exactly the lying comment this repo keeps finding.
 *
 * ⭐ The ordering property is now pinned STRUCTURALLY below, by reading the
 * module source: the refusal must appear in phase A, above the point where any
 * read is scheduled. That is checkable, where "was this file opened" is not
 * without a filesystem seam that does not exist here.
 */
test('⚠️⚠️ a credential file is withheld, and its contents never come back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-search-cred-'));
  try {
    writeFileSync(join(root, 'credentials.json'), '{"aws_secret":"CANARY_MUST_NOT_APPEAR"}\n');
    writeFileSync(join(root, 'app.js'), 'const x = 1; // CANARY_MUST_NOT_APPEAR is mentioned here\n');

    const r = await searchText(root, 'CANARY_MUST_NOT_APPEAR', {});
    assert.equal(r.ok, true);

    const fromCreds = r.matches.filter((m) => m.path.includes('credentials.json'));
    assert.equal(fromCreds.length, 0, 'the credential file leaked its CONTENTS into the reply');

    assert.ok(r.withheld >= 1, 'the withheld counter did not register the refusal');
    assert.ok(
      r.skipped.some((s) => s.path.includes('credentials.json')),
      'the file was refused SILENTLY — the model is not told it exists, which is the lie this module exists to stop',
    );
    // The ordinary file is still searched — the refusal is targeted, not a bail-out.
    assert.ok(r.matches.some((m) => m.path.includes('app.js')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ── ⭐⭐ THE STRUCTURAL PIN FOR "REFUSED BEFORE READ" ────────────────────────
 *
 * The behavioural test above cannot see the difference between refusing a
 * credential file and reading it then throwing the bytes away — both return the
 * same JSON. The difference matters anyway: once the bytes are in this process
 * they are one logging change away from a provider, and `turn.mjs:112` records
 * the day exactly that happened with `.env` and `id_rsa`.
 *
 * ⚠️ SO THIS READS THE SOURCE. It is a blunt instrument and it is the honest
 * one available: the refusal must sit in the phase that runs BEFORE any read is
 * scheduled, which means above the `Promise.all` that performs the I/O.
 */
test('⭐⭐ the credential refusal sits above the I/O, not after it', async () => {
  const src = readFileSync(new URL('../lib/search.mjs', import.meta.url), 'utf8');

  const refuse = src.indexOf('refusedCommitPath(rel)');
  const io = src.indexOf('await Promise.all(plan.filter((e) => e.read)');
  assert.ok(refuse > 0, 'the credential check has moved or been renamed — look before assuming it is gone');
  assert.ok(io > 0, 'phase B has moved or been renamed');
  assert.ok(
    refuse < io,
    'the credential refusal now happens AFTER the batch is read — the bytes are in the process before they are refused',
  );

  // …and it must not be scheduling a read for one either.
  const line = src.slice(refuse, src.indexOf('\n', refuse) + 1);
  assert.ok(
    !/read:\s*true/.test(line),
    'a credential file is being queued for reading; withholding happens instead of reading, not after it',
  );
});
