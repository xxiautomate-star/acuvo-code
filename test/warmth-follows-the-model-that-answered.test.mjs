/**
 * ── ⭐⭐⭐ CLI ACCEPTANCE ITEM #1, THE ROUTING HALF ──────────────────────────
 *
 * Roman's six-point definition of CLI-done-as-MVP opens with *"caching works
 * solidly, EVEN WHEN MODELS SWITCH"*.
 * `cache-survives-model-switch.test.mjs` covers the BYTES half — our prompt does
 * not move when the model changes. This file covers the half that was never
 * checked: **where the next round is ROUTED after a switch.**
 *
 * ── ⚠️⚠️ THE DEFECT, MEASURED 2026-09-01 ────────────────────────────────────
 *
 * `turn.mjs` recorded the round's upstream against `config.model` — the model
 * the user configured — while `chain.mjs` is free to answer from a different
 * one. Driven through the real `runSession` with a scripted chain, `$0.00`:
 *
 *     configured  deepseek/deepseek-v4-flash-0731   pin: DeepInfra, Ambient, Relace
 *     answered    z-ai/glm-4.6                      pin: Venice, DeepInfra
 *     served by   DeepInfra
 *     ~/.acuvo/warm-providers.json -> {"deepseek/deepseek-v4-flash-0731":"DeepInfra"}
 *     routeFor(configured)         -> {order:["DeepInfra"], strict:true}
 *
 * ⭐ `DeepInfra` IS IN BOTH PIN LISTS, which is exactly why the existing
 * membership guard could not see it: the name really is one we chose and priced.
 * It simply has never served THIS model's prefix. So the next round asked for it
 * with `allow_fallbacks: false` — a cold cache with the fallback removed — and
 * `saveWarmth` wrote it under `$HOME`, where it governs every workspace on the
 * machine until something FAILS.
 *
 * ⚠️ THE LOSS IS DOUBLE, and the second half is the quiet one: the model that
 * actually answered, and that the rest of the session keeps using, learned
 * NOTHING — so every later round re-routed on the preference list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { runSession, formatSummary, renderEvent } from '../lib/turn.mjs';
import { toJson } from '../lib/report.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import {
  freshWarmth, rememberWarm, warmProviderFor, routeFor, learnFromRound,
  loadWarmth, saveWarmth, pruneStale, WARMTH_TTL_MS,
} from '../lib/warm-provider.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const GLM = 'z-ai/glm-4.6';
/** ⚠️ The whole trap in one constant: chosen and priced for BOTH models. */
const SHARED_UPSTREAM = 'DeepInfra';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

function workspace() {
  const root = tempDir('acuvo-warmswitch-ws-');
  writeFileSync(join(root, 'package.json'), '{"name":"c","version":"1.0.0"}\n');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  return root;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE RULE, ON THE PURE FUNCTION
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐⭐ a fallback ANSWER never teaches the configured model an upstream', () => {
  const s = freshWarmth();
  const out = learnFromRound(s, { asked: FLASH, served: GLM, provider: SHARED_UPSTREAM, ok: true });

  assert.equal(out.switched, true, 'the switch was not even noticed');
  assert.equal(
    warmProviderFor(s, FLASH),
    null,
    `${FLASH} was pinned to ${SHARED_UPSTREAM} on the evidence of a round ${GLM} served. `
    + 'The next round asks for it with allow_fallbacks:false against a cache that does not exist.',
  );
  assert.equal(
    warmProviderFor(s, GLM),
    SHARED_UPSTREAM,
    'the model that actually answered learned nothing, so every later round re-routes on the preference list',
  );
  assert.match(out.note, /answered this round, not/);
});

test('⭐ the ordinary case is unchanged — same model in, same model out, warmth learned', () => {
  const s = freshWarmth();
  const out = learnFromRound(s, { asked: FLASH, served: FLASH, provider: SHARED_UPSTREAM, ok: true });
  assert.equal(out.switched, false);
  assert.equal(warmProviderFor(s, FLASH), SHARED_UPSTREAM);
  assert.equal(out.note, null, 'a healthy round must say nothing — noise teaches people to ignore the line');
});

test('⚠️ a transport that does not name a model is NOT treated as a switch', () => {
  /**
   * The alternative — "unknown means different" — would forget a perfectly good
   * pin on every round of every adapter that omits the field, i.e. it would
   * disable the feature quietly rather than fix it.
   */
  const s = freshWarmth();
  const out = learnFromRound(s, { asked: FLASH, served: null, provider: SHARED_UPSTREAM, ok: true });
  assert.equal(out.switched, false);
  assert.equal(warmProviderFor(s, FLASH), SHARED_UPSTREAM);
});

test('⚠️ a failed round still releases the lock, exactly as before', () => {
  const s = rememberWarm(freshWarmth(), FLASH, SHARED_UPSTREAM);
  assert.equal(warmProviderFor(s, FLASH), SHARED_UPSTREAM);
  learnFromRound(s, { asked: FLASH, served: null, provider: null, ok: false });
  assert.equal(warmProviderFor(s, FLASH), null, 'one outage would cost the whole session, not one round');
});

test('⚠️ landing on the pin\'s SECOND name still forgets and re-learns', () => {
  // The original defect this module was written for — it must survive the change.
  const s = rememberWarm(freshWarmth(), FLASH, 'Ambient');
  const out = learnFromRound(s, { asked: FLASH, served: FLASH, provider: 'Relace', ok: true, expected: 'Ambient' });
  assert.equal(out.switched, false);
  assert.match(out.note, /Relace served this round instead of Ambient/);
  assert.equal(warmProviderFor(s, FLASH), 'Relace');
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ REACH — through the real session loop and onto the real disk shape
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐⭐ END TO END: a chain fallback does not write a cross-model pin to disk', async () => {
  const home = tempDir('acuvo-warmswitch-home-');
  const root = workspace();
  const previous = process.env.ACUVO_HOME;
  process.env.ACUVO_HOME = home;
  try {
    const outcome = await runSession({
      task: 'say hello',
      executor: createLocalExecutor(root),
      config: { apiKey: 'x', model: FLASH },
      maxRounds: 1,
      allowRun: false,
      /** The exact shape `callChain` returns when the primary died and it recovered. */
      callModelImpl: async () => ({
        ok: true,
        content: 'done',
        toolCalls: [],
        usage: { cost: 0, total_tokens: 10 },
        finishReason: 'stop',
        model: GLM,
        provider: SHARED_UPSTREAM,
        usedFallback: true,
        chainTried: [FLASH, GLM],
        attempts: 2,
      }),
      onEvent: () => {},
    });
    assert.equal(outcome.ok, true, 'the session has to complete or nothing was persisted and this proves nothing');

    const path = join(home, 'warm-providers.json');
    assert.ok(existsSync(path), 'nothing was written at all — this test would pass on an empty disk');
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(
      onDisk.byModel?.[FLASH],
      undefined,
      `${FLASH} was written a warm upstream it never earned. This file is a machine-wide, `
      + 'fallback-free provider lock that only releases on a FAILURE.',
    );
    assert.equal(onDisk.byModel?.[GLM], SHARED_UPSTREAM, 'the model that answered learned nothing');

    /** ⭐ The chain is now visible to a script, which is what `--json` publishes. */
    assert.deepEqual(outcome.modelsAnswered, [GLM]);
    assert.equal(outcome.model, FLASH, 'the requested model must still be reported as requested');
  } finally {
    if (previous === undefined) delete process.env.ACUVO_HOME;
    else process.env.ACUVO_HOME = previous;
  }
});

test('⭐ and the summary/event surface says a different model answered', async () => {
  const home = tempDir('acuvo-warmswitch-ev-');
  const root = workspace();
  const previous = process.env.ACUVO_HOME;
  process.env.ACUVO_HOME = home;
  const events = [];
  try {
    await runSession({
      task: 'say hello',
      executor: createLocalExecutor(root),
      config: { apiKey: 'x', model: FLASH },
      maxRounds: 1,
      allowRun: false,
      callModelImpl: async () => ({
        ok: true, content: 'done', toolCalls: [], usage: { cost: 0, total_tokens: 10 },
        finishReason: 'stop', model: GLM, provider: SHARED_UPSTREAM, usedFallback: true,
      }),
      onEvent: (e) => events.push(e),
    });
  } finally {
    if (previous === undefined) delete process.env.ACUVO_HOME;
    else process.env.ACUVO_HOME = previous;
  }
  const switched = events.filter((e) => e?.type === 'model-switch');
  assert.equal(switched.length, 1, 'a silent downgrade is the dishonest version of the chain (chain.mjs, line 1)');
  assert.equal(switched[0].asked, FLASH);
  assert.equal(switched[0].answered, GLM);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ THE TTL — the third property that made the original incident permanent
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ a remembered upstream EXPIRES — it was evidence of a cache, and caches end', () => {
  const home = tempDir('acuvo-warmth-ttl-');
  const env = { ACUVO_HOME: home };
  assert.equal(saveWarmth(rememberWarm(freshWarmth(), FLASH, SHARED_UPSTREAM), env), true);

  // Fresh enough: still honoured, and still strict.
  const fresh = loadWarmth(env);
  assert.equal(warmProviderFor(fresh, FLASH), SHARED_UPSTREAM);
  assert.equal(routeFor(fresh, FLASH, ['DeepInfra', 'Ambient']).strict, true);

  // One millisecond past the window: gone, and the next round routes normally.
  const aged = loadWarmth(env);
  pruneStale(aged, { now: Date.now() + WARMTH_TTL_MS + 1 });
  assert.equal(
    warmProviderFor(aged, FLASH),
    null,
    'an entry older than the cache it describes is not warmth, it is only reachability — '
    + 'and reachability does not justify allow_fallbacks:false',
  );
});

test('⚠️ an UNSTAMPED entry (every file written before this) is dropped, not trusted', () => {
  const home = tempDir('acuvo-warmth-legacy-');
  const env = { ACUVO_HOME: home };
  // Exactly the legacy on-disk shape: a bare string, no `seenAt` key at all.
  writeFileSync(join(home, 'warm-providers.json'), JSON.stringify({ byModel: { [FLASH]: SHARED_UPSTREAM } }));
  assert.equal(
    warmProviderFor(loadWarmth(env), FLASH),
    null,
    'an entry of unknowable age was honoured. Unknown age must resolve the safe way — the cost is '
    + 'one cold round, once, per machine that upgrades.',
  );
});

test('⚠️ a stamp from the FUTURE is garbage, not eternal warmth', () => {
  const s = rememberWarm(freshWarmth(), FLASH, SHARED_UPSTREAM, { now: Date.now() + 60 * 60 * 1000 });
  pruneStale(s);
  assert.equal(warmProviderFor(s, FLASH), null, 'a clock skew or a hand-edited file would never expire');
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ THE INSTRUMENT — every assertion above is worthless if it cannot go RED
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ MUTATION: keying warmth on the ASKED model reproduces the bug this file exists for', () => {
  /**
   * This repo has shipped four guards that passed while checking nothing. The
   * cheapest proof that a guard bites is to perform the defect by hand with the
   * primitives the fixed code uses, and show the assertion fails on it.
   */
  const buggy = freshWarmth();
  // The old line, verbatim in effect: learn the provider against config.model.
  rememberWarm(buggy, FLASH, SHARED_UPSTREAM);
  assert.equal(
    warmProviderFor(buggy, FLASH),
    SHARED_UPSTREAM,
    'the membership guard alone would have to reject this for the fix to be unnecessary — it does not, '
    + `because ${SHARED_UPSTREAM} is a chosen, priced endpoint for ${FLASH}`,
  );
  assert.equal(routeFor(buggy, FLASH, ['DeepInfra', 'Ambient']).strict, true,
    'and it is a fallback-free lock, not a preference');
});

test('⚠️⚠️ MUTATION: a TTL that never expires is detected by the same assertion', () => {
  const s = rememberWarm(freshWarmth(), FLASH, SHARED_UPSTREAM);
  // An infinite window is the "no TTL" state the module shipped with.
  pruneStale(s, { now: Date.now() + 365 * 24 * 60 * 60 * 1000, ttlMs: Number.POSITIVE_INFINITY });
  assert.equal(warmProviderFor(s, FLASH), SHARED_UPSTREAM,
    'the age check is not reading ttlMs at all, so the expiry test above passes for the wrong reason');
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ THE DOWNGRADE IS SAID OUT LOUD — on screen, and in the machine document
 *
 * `chain.mjs` line 1 of its result contract: *"THE RESULT SAYS WHICH MODEL
 * ANSWERED. A silent downgrade that returns a weaker model's output without
 * saying so is the dishonest version of this feature."* It said it in
 * `usedFallback`, and `grep -rn usedFallback lib/ bin/` had **no consumer**.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The minimum shape `formatSummary` needs to reach the fallback line. */
function outcomeWith(modelsAnswered) {
  return {
    ok: true, model: FLASH, modelsAnswered, roundsUsed: 1, rounds: [], executed: [],
    changed: [], note: 'done', stoppedBecause: 'stop', verification: { ran: false, passed: false },
  };
}

test('⭐⭐ the SUMMARY names the model that answered when it is not the one asked for', () => {
  const text = formatSummary(outcomeWith([GLM])).join('\n');
  assert.match(text, new RegExp(`${GLM.replace('/', '\/')} answered this run`),
    'the run silently used a different model and a different price');
  assert.match(text, /chain fallback/i);
});

test('⚠️ and it is SILENT when the configured model answered every round', () => {
  const text = formatSummary(outcomeWith([FLASH])).join('\n');
  assert.doesNotMatch(text, /chain fallback/i,
    'a warning on the healthy path teaches the reader to skip it, and then it cannot do its job at all');
});

test('⚠️ absent modelsAnswered says nothing rather than reassuring', () => {
  const o = outcomeWith(undefined);
  delete o.modelsAnswered;
  assert.doesNotMatch(formatSummary(o).join('\n'), /chain fallback/i);
});

test('⭐ `--json` carries the chain, and `model` still means "requested"', () => {
  const doc = toJson(outcomeWith([GLM]), { task: 't' });
  assert.equal(doc.model, FLASH, 'changing what an existing key means is worse than the omission');
  assert.deepEqual(doc.modelsAnswered, [GLM]);
  // ⚠️ Omitted, never `[]` — an empty array reads as "nothing answered".
  const quiet = outcomeWith(undefined);
  delete quiet.modelsAnswered;
  assert.equal(Object.prototype.hasOwnProperty.call(toJson(quiet, { task: 't' }), 'modelsAnswered'), false);
});

test('⚠️⚠️ the model-switch event is actually RENDERED, not merely emitted', () => {
  /**
   * `prefix-drift` has been emitted by the loop since it was written and has no
   * `renderEvent` case, so it prints nothing — an event nobody prints is not a
   * feature. This asserts the new one does not join it.
   */
  const lines = renderEvent({ type: 'model-switch', round: 3, asked: FLASH, answered: GLM, text: 'x' });
  assert.equal(lines.length, 1, 'the event falls through to a renderer that drops it');
  assert.match(lines[0], new RegExp(GLM.replace('/', '\/')));
  assert.match(lines[0], /round 3/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️⚠️ THE WRITE IS READ BY OTHER PROCESSES WHILE IT HAPPENS
 *
 * `~/.acuvo/warm-providers.json` is machine-global: every `acuvo` on the box
 * writes it, and CLAUDE.md's documented working shape is 2-3 terminals at once.
 * `writeFileSync` truncates then fills, so a concurrent reader sees the middle.
 *
 * MEASURED before the fix — six writers, one reader, one home:
 *     17,775 reads · 5,343 UNPARSEABLE · 30.06%
 * and after write-then-rename: 20,827 reads · 0 torn.
 *
 * ⚠️ THE SYMPTOM IS SILENCE, WHICH IS WHY IT SURVIVED. `loadWarmth` catches the
 * parse error on purpose ("unknown is a valid answer"), so a torn read is not an
 * error — it is cross-run warmth switched OFF, which costs the entire round-one
 * cache. Measured on DeepInfra: a warm head reads 96.1% cached, a cold one 0%.
 * ──────────────────────────────────────────────────────────────────────────── */
test('⚠️⚠️ concurrent writers never leave a half-written warmth file', async () => {
  const { spawn } = await import('node:child_process');
  const home = tempDir('acuvo-warmth-race-');
  const worker = join(home, 'w.mjs');
  const lib = new URL('../lib/warm-provider.mjs', import.meta.url).href;
  writeFileSync(worker, `
import { freshWarmth, rememberWarm, saveWarmth } from ${JSON.stringify(lib)};
const env = { ACUVO_HOME: process.argv[2] };
const until = Date.now() + 1500;
while (Date.now() < until) {
  const s = freshWarmth();
  rememberWarm(s, ${JSON.stringify(FLASH)}, process.argv[3]);
  rememberWarm(s, ${JSON.stringify(GLM)}, 'Venice');
  saveWarmth(s, env);
}
`);

  /**
   * ⚠️ `spawn`, NOT `spawnSync`. The first version of this harness used
   * `spawnSync`, which BLOCKS — so the four "concurrent" writers ran strictly
   * one after another and it reported a clean file every time. A concurrency
   * test that serialises its own workers is a guard checking nothing.
   */
  const kids = ['DeepInfra', 'Ambient', 'Relace', 'DeepInfra']
    .map((n) => spawn(process.execPath, [worker, home, n], { stdio: 'ignore' }));

  const path = join(home, 'warm-providers.json');

  /**
   * ── ⚠️⚠️ THE WINDOW WAS FIXED AT 1500ms AND THE CHILDREN TAKE LONGER THAN
   *          THAT TO BOOT ON A BUSY MACHINE ──────────────────────────────────
   *
   * MEASURED 2026-09-18, on this laptop with other work running: four spawned
   * node processes took **4,356ms** of wall time, so a parent that watched for
   * 1500ms from `spawn` saw the file appear **never** and the guard failed with
   * its own vacuity message, *"only 0 reads happened — this guard is checking
   * nothing."* The library was fine — the same worker run by hand writes a
   * valid file every time. Node starts in ~0.5s here when idle, which is why
   * this passed for as long as the machine was quiet.
   *
   * ⭐ THE SELF-CHECK BELOW IS WHY THIS WAS DIAGNOSABLE AT ALL, and it stays:
   * it turned an invisible vacuous pass into a loud, specific red. What was
   * wrong was the clock, not the assertion — so the clock is now measured
   * rather than assumed.
   *
   * ⚠️ WAIT FOR THE WRITERS, THEN READ FOR A FIXED WINDOW. The read window has
   * to overlap the period when several children are writing AT ONCE, which is
   * the only condition that can produce a torn read; starting it when the file
   * first appears is exactly that moment, because each child writes for 1500ms
   * after its own boot.
   */
  const APPEAR_TIMEOUT_MS = 30_000;
  const READ_WINDOW_MS = 1_000;
  const spawnedAt = Date.now();
  while (!existsSync(path) && Date.now() - spawnedAt < APPEAR_TIMEOUT_MS) { /* spin until a writer lands */ }
  assert.ok(
    existsSync(path),
    `no writer produced ${path} within ${APPEAR_TIMEOUT_MS}ms — the harness never started, so nothing below is meaningful`,
  );

  let reads = 0;
  let torn = 0;
  const until = Date.now() + READ_WINDOW_MS;
  while (Date.now() < until) {
    let raw = null;
    try { raw = readFileSync(path, 'utf8'); } catch { continue; }
    reads += 1;
    try { JSON.parse(raw); } catch { torn += 1; }
  }
  await Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r))));

  // ⭐ The harness proves itself: zero reads would make the assertion vacuous.
  assert.ok(reads > 100, `only ${reads} reads happened — this guard is checking nothing`);
  assert.equal(torn, 0,
    `${torn} of ${reads} reads (${(torn / reads * 100).toFixed(1)}%) saw a half-written file. `
    + 'loadWarmth swallows that as "unknown", so it is cross-run warmth silently switched off.');
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ THE LAST PERSISTENT RECORD THAT STILL NAMED THE WRONG MODEL
 *
 * `audit.mjs` and `report.mjs` both widened their model field deliberately and
 * said why. `saveSession` did not — it wrote only `model`, which is
 * `config.model`, the REQUESTED one. And because it always wrote a string,
 * `replay.mjs`'s `auditInfo?.model?.answered` fallback was DEAD CODE: the replay
 * header printed the requested model on every run, including the ones where a
 * fallback answered.
 * ──────────────────────────────────────────────────────────────────────────── */
test('⚠️⚠️ the saved session record carries the model that ANSWERED, not only the one asked for', async () => {
  const { saveSession, loadSession } = await import('../lib/session.mjs');
  const root = tempDir('acuvo-sessrec-');
  const saved = saveSession(root, {
    ok: true, model: FLASH, answeredModel: GLM, modelsAnswered: [GLM],
    roundsUsed: 2, maxRounds: 4, stoppedBecause: 'stop', rounds: [], executed: [],
  }, { task: 't' });
  assert.ok(saved?.id, 'nothing was saved, so this guard is checking nothing');

  const record = loadSession(root, saved.id).session;
  assert.equal(record.model, FLASH, 'the requested id must still be reported as requested');
  assert.equal(record.answeredModel, GLM,
    'the record names only the model that was asked for — on a rate-limited day it swears the '
    + 'configured model did work a fallback did');
  assert.deepEqual(record.modelsAnswered, [GLM]);
});

test('⚠️ a run where nothing named a model omits the fields rather than writing null', async () => {
  const { saveSession, loadSession } = await import('../lib/session.mjs');
  const root = tempDir('acuvo-sessrec2-');
  const saved = saveSession(root, {
    ok: true, model: FLASH, roundsUsed: 1, stoppedBecause: 'stop', rounds: [], executed: [],
  }, { task: 't' });
  const record = loadSession(root, saved.id).session;
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'answeredModel'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'modelsAnswered'), false);
});
