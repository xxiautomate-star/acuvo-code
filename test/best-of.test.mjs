/**
 * ── ⭐⭐ BEST-OF-N ───────────────────────────────────────────────────────────
 *
 * Run the same task N times, keep the one that actually PASSED. It is the one
 * capability our price makes possible and a competitor's forbids: a run costs
 * ~$0.001, so three attempts cost a third of a cent.
 *
 * ⚠️⚠️ MOST OF THIS FILE EXISTS TO PIN ONE RULE: **the winner is chosen by what
 * RAN, never by taste.** The tempting design — generate N answers, ask a model
 * which is best — is N chances to be confidently wrong aggregated by a judge
 * with the same blind spots, and this codebase has measured that exact failure
 * (a critic scoring five of six different pages identically).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runBestOf,
  pickWinner,
  scoreAttempt,
  applyAttempt,
  formatBestOf,
  measureWorkspace,
  COPY_SKIP_DIRS,
  MAX_ATTEMPTS,
} from '../lib/best-of.mjs';

/** The real verdict function's shape: true means the run failed. */
const failed = (o) => !o?.ok || (o.verification?.ran && o.verification.passed !== true);

const done = (over = {}) => ({
  ok: true,
  roundsUsed: 3,
  usage: { cost: 0.001 },
  executed: [],
  stoppedBecause: 'done',
  verification: { ran: true, passed: true, command: 'npm test' },
  ...over,
});

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-bo-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/* ── scoring: correctness first, and nothing can outrank it ──────────────── */

test('a verified attempt outranks every unverified one', () => {
  const pass = scoreAttempt({ outcome: done() }, { failed });
  const ranFailed = scoreAttempt({ outcome: done({ verification: { ran: true, passed: false, command: 'npm test' } }) }, { failed });
  const neverRan = scoreAttempt({ outcome: done({ ok: false, verification: { ran: false, passed: null, command: null } }) }, { failed });
  const crashed = scoreAttempt({ error: 'boom' }, { failed });

  assert.ok(pass.rank < ranFailed.rank);
  assert.ok(ranFailed.rank < neverRan.rank);
  assert.ok(neverRan.rank <= crashed.rank);
});

test('⚠️⚠️ a CHEAP failure never beats an expensive SUCCESS', () => {
  /**
   * ⚠️ THE FAILURE MODE THIS FORBIDS: rank by cost or rounds alone and the
   * agent learns that doing nothing is optimal — a run that writes no code,
   * runs nothing and stops immediately is always the cheapest attempt.
   */
  const cheapFail = { outcome: done({ roundsUsed: 1, usage: { cost: 0.0001 }, verification: { ran: true, passed: false, command: 'npm test' } }) };
  const dearPass = { outcome: done({ roundsUsed: 9, usage: { cost: 0.05 } }) };
  const { winner } = pickWinner([cheapFail, dearPass], { failed });
  assert.equal(winner.index, 1, 'the passing attempt must win however much more it cost');
});

test('⚠️⚠️ an attempt that DID NOTHING never outranks one that did the work', () => {
  /**
   * ⚠️ CAUGHT BY A REAL RUN, not by reasoning. An attempt that wrote no files
   * and ran no verification came back `ok: true` — so `failed()` said false, so
   * it scored as a WIN, and then beat the attempt that actually did the work
   * because the tie-break prefers fewer rounds and doing nothing takes the
   * fewest of all.
   *
   * ⭐ Same trap as the cheap-failure test, one level deeper: I closed "a cheap
   * FAILURE must not beat an expensive success" and missed "a cheap NO-OP beats
   * everything". An agent rewarded for that learns to do nothing quickly.
   */
  const didNothing = { outcome: done({ roundsUsed: 1, executed: [], verification: { ran: false, passed: null, command: null } }) };
  const didTheWork = { outcome: done({ roundsUsed: 5, executed: [{ mutated: true, args: { path: 'a.js' } }], verification: { ran: false, passed: null, command: null } }) };

  assert.equal(scoreAttempt(didNothing, { failed }).rank, 2, 'an empty run is not a success');
  assert.equal(scoreAttempt(didTheWork, { failed }).rank, 0);
  assert.equal(pickWinner([didNothing, didTheWork], { failed }).winner.index, 1);
});

test('among VERIFIED attempts, the most direct one wins', () => {
  const long = { outcome: done({ roundsUsed: 8 }) };
  const short = { outcome: done({ roundsUsed: 2 }) };
  const { winner } = pickWinner([long, short], { failed });
  assert.equal(winner.index, 1);
});

test('ties fall back to the first attempt, so the result is deterministic', () => {
  const a = { outcome: done() };
  const b = { outcome: done() };
  assert.equal(pickWinner([a, b], { failed }).winner.index, 0);
  assert.equal(pickWinner([a, b], { failed }).winner.index, 0);
});

/* ── applying the winner ─────────────────────────────────────────────────── */

test('⭐ only the files the attempt REPORTED writing are applied', () => {
  /**
   * ⚠️ Mirroring the whole directory would delete anything the user created
   * while the attempts ran, and resurrect files an attempt deliberately
   * deleted. The change list is the attempt's own account of what it did.
   */
  const from = workspace();
  const to = workspace();
  try {
    writeFileSync(join(from.root, 'wanted.txt'), 'new');
    writeFileSync(join(from.root, 'untouched.txt'), 'from-attempt');
    writeFileSync(join(to.root, 'untouched.txt'), 'from-user');

    const outcome = done({ executed: [{ mutated: true, args: { path: 'wanted.txt' } }] });
    const { applied, problems } = applyAttempt(from.root, to.root, outcome);

    assert.deepEqual(applied, ['wanted.txt']);
    assert.deepEqual(problems, []);
    assert.equal(readFileSync(join(to.root, 'wanted.txt'), 'utf8'), 'new');
    assert.equal(
      readFileSync(join(to.root, 'untouched.txt'), 'utf8'),
      'from-user',
      "a file the attempt did not report writing must not be overwritten",
    );
  } finally { from.cleanup(); to.cleanup(); }
});

test('a file the attempt DELETED is deleted here too', () => {
  const from = workspace();
  const to = workspace();
  try {
    writeFileSync(join(to.root, 'gone.txt'), 'old');
    const outcome = done({ executed: [{ mutated: true, args: { path: 'gone.txt' } }] });
    applyAttempt(from.root, to.root, outcome);
    assert.equal(existsSync(join(to.root, 'gone.txt')), false, 'apply must mean apply, including a deletion');
  } finally { from.cleanup(); to.cleanup(); }
});

test('⚠️ a path that climbs out of the workspace is REFUSED, not applied', () => {
  const from = workspace();
  const to = workspace();
  try {
    const outcome = done({
      executed: [
        { mutated: true, args: { path: '../escape.txt' } },
        { mutated: true, args: { path: '/etc/passwd' } },
        { mutated: true, args: { path: 'C:\\Windows\\x.txt' } },
      ],
    });
    const { applied, problems } = applyAttempt(from.root, to.root, outcome);
    assert.deepEqual(applied, []);
    assert.equal(problems.length, 3, 'every escaping path must be reported, not silently dropped');
    assert.ok(problems.every((p) => /leaves the workspace/.test(p)));
  } finally { from.cleanup(); to.cleanup(); }
});

/* ── the copy ────────────────────────────────────────────────────────────── */

test('⚠️ node_modules and .git are never copied', () => {
  assert.ok(COPY_SKIP_DIRS.has('node_modules'));
  assert.ok(COPY_SKIP_DIRS.has('.git'));
  assert.ok(COPY_SKIP_DIRS.has('.acuvo'), 'copying .acuvo would carry the attempt its own audit log and sessions');

  const w = workspace();
  try {
    mkdirSync(join(w.root, 'node_modules', 'big'), { recursive: true });
    writeFileSync(join(w.root, 'node_modules', 'big', 'blob.bin'), Buffer.alloc(200_000));
    writeFileSync(join(w.root, 'src.js'), 'x');
    const m = measureWorkspace(w.root);
    assert.equal(m.files, 1, 'node_modules must not be measured either');
    assert.ok(m.bytes < 1000);
  } finally { w.cleanup(); }
});

test('⚠️ an oversized workspace is refused BEFORE anything is copied', async () => {
  /**
   * ⚠️ MY FIRST VERSION OF THIS TEST WAS THE BUG. It wrote a 2MB file, left the
   * real 256MB limit in place, and then asserted `ok === true || refused` — so
   * it could not fail for the right reason and blew up inside a stub instead.
   *
   * ⭐ The fix was to make the limit INJECTABLE, which is the real lesson: a
   * hardcoded threshold means the only way to exercise its branch is to build a
   * 256MB workspace, so nobody ever does — and the one guard protecting a laptop
   * from copying a dataset three times is the one branch never run.
   */
  const w = workspace();
  try {
    writeFileSync(join(w.root, 'big.bin'), Buffer.alloc(200_000));
    const r = await runBestOf({
      root: w.root,
      attempts: 3,
      failed,
      maxBytes: 50_000,
      runOne: () => { throw new Error('must not run'); },
      makeTempDir: () => { throw new Error('must not copy'); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /would have to be copied 3 times/);
    assert.match(r.error, /point --dir at the subdirectory/, 'a refusal without an alternative just stops the user');
  } finally { w.cleanup(); }
});

/* ── the whole loop ──────────────────────────────────────────────────────── */

test('⭐⭐ three attempts run, the verified one is kept, its file lands', async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.root, 'seed.txt'), 'seed');
    const outcomes = [
      done({ verification: { ran: true, passed: false, command: 'npm test' } }),
      done({ executed: [{ mutated: true, args: { path: 'fix.js' } }] }),
      done({ ok: false, verification: { ran: false, passed: null, command: null } }),
    ];
    let i = 0;
    const r = await runBestOf({
      root: w.root,
      attempts: 3,
      failed,
      runOne: async ({ root }) => {
        const mine = outcomes[i++];
        if (mine.executed?.length) writeFileSync(join(root, 'fix.js'), 'the winning fix');
        return mine;
      },
    });

    assert.equal(r.ok, true);
    assert.equal(r.winnerIndex, 1, 'the only verified attempt must win');
    assert.equal(r.anyVerified, true);
    assert.deepEqual(r.applied, ['fix.js']);
    assert.equal(readFileSync(join(w.root, 'fix.js'), 'utf8'), 'the winning fix');
    assert.equal(readFileSync(join(w.root, 'seed.txt'), 'utf8'), 'seed');
  } finally { w.cleanup(); }
});

test('⚠️⚠️ when NOTHING verifies it still applies one, and says so in those words', async () => {
  /**
   * ⚠️ BEST-OF-N MUST NEVER BE WORSE THAN N=1. A single failing run still
   * leaves its files on disk; if three attempts left nothing, asking for more
   * attempts would be a downgrade — the kind of surprise that makes a feature
   * untrustworthy.
   */
  const w = workspace();
  try {
    const r = await runBestOf({
      root: w.root,
      attempts: 2,
      failed,
      runOne: async ({ root }) => {
        writeFileSync(join(root, 'attempt.js'), 'partial');
        return done({ verification: { ran: true, passed: false, command: 'npm test' }, executed: [{ mutated: true, args: { path: 'attempt.js' } }] });
      },
    });
    assert.equal(r.anyVerified, false);
    assert.deepEqual(r.applied, ['attempt.js'], 'a failing best-of must still leave something to look at');

    const text = formatBestOf(r);
    assert.match(text, /NONE of the attempts verified/);
    assert.match(text, /nothing here is proven/);
  } finally { w.cleanup(); }
});

test('a crashing attempt does not sink the run', async () => {
  const w = workspace();
  try {
    let i = 0;
    const r = await runBestOf({
      root: w.root,
      attempts: 2,
      failed,
      runOne: async () => {
        if (i++ === 0) throw new Error('provider exploded');
        return done();
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.winnerIndex, 1);
    assert.match(formatBestOf(r), /attempt 1: the attempt crashed/);
  } finally { w.cleanup(); }
});

test('⚠️ every temp copy is removed, even when an attempt throws', async () => {
  const w = workspace();
  const made = [];
  try {
    await runBestOf({
      root: w.root,
      attempts: 2,
      failed,
      runOne: async () => { throw new Error('always fails'); },
      makeTempDir: () => { const d = mkdtempSync(join(tmpdir(), 'acuvo-bo-tmp-')); made.push(d); return d; },
    });
    assert.equal(made.length, 2);
    for (const d of made) assert.equal(existsSync(d), false, `${d} was left behind`);
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
    w.cleanup();
  }
});

test('the attempt count is clamped to something affordable', async () => {
  const w = workspace();
  try {
    const r = await runBestOf({ root: w.root, attempts: 99, failed, runOne: async () => done() });
    assert.equal(r.attempts, MAX_ATTEMPTS);
    const low = await runBestOf({ root: w.root, attempts: 1, failed, runOne: async () => done() });
    assert.ok(low.attempts >= 2, 'best-of-1 is just a run — clamp up rather than pretend');
  } finally { w.cleanup(); }
});

test('the report names the total spent across ALL attempts, not just the winner', async () => {
  const w = workspace();
  try {
    const r = await runBestOf({ root: w.root, attempts: 3, failed, runOne: async () => done({ usage: { cost: 0.002 } }) });
    const text = formatBestOf(r);
    assert.match(text, /total spend across all attempts: \$0\.0060/, `three attempts at $0.002 is $0.006, not $0.002:\n${text}`);
  } finally { w.cleanup(); }
});
