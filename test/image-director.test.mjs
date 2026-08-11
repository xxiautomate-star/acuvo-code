/**
 * ── THE ART DIRECTOR ────────────────────────────────────────────────────────
 *
 * A generator without a critic is a slot machine, and today's own coffee site
 * proved it: a hero with an illegible smeared label, referenced confidently
 * across four pages, because the agent cannot see.
 *
 * ⚠️ THE TWO WAYS THIS FEATURE CAN BE WORTHLESS, both tested below:
 *   · a critic that accepts everything — then it is decoration;
 *   · a critic that rejects everything — then it triples the cost and helps
 *     nobody, and the accept path is the one that never gets exercised in
 *     manual testing because bad output is what you go looking for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cinematicPrompt, parseVerdict, directImage, ACCEPT_SCORE } from '../lib/image-director.mjs';

test('direction is appended, and the subject survives it', () => {
  const r = cinematicPrompt('a red bicycle against a stone wall');
  assert.match(r.prompt, /^a red bicycle against a stone wall,/);
  assert.match(r.prompt, /cinematic still/);
  assert.match(r.prompt, /35mm/);
});

test('an empty prompt stays empty rather than becoming pure direction', () => {
  // Otherwise a blank request generates a beautiful photograph of nothing.
  assert.equal(cinematicPrompt('   ').prompt, '');
});

/**
 * ⚠️ Diffusion models cannot spell, and garbled glyphs are the single defect a
 * viewer clocks instantly as machine-made. The critic named it as the
 * disqualifier on a real image today.
 */
test('a request for text is removed, not honoured', () => {
  const r = cinematicPrompt('a shop sign with the words Fresh Bread and a logo');
  assert.equal(r.strippedText, true);
  assert.doesNotMatch(r.prompt, /\bwords\b/);
  assert.doesNotMatch(r.prompt, /\blogo\b/);
  assert.match(r.prompt, /no text/);
});

/**
 * ⚠️⭐ MEASURED, NOT ASSUMED: the negative prompt DOES NOT WORK on the live
 * provider — three shots with "no text, no lettering" all came back with a
 * garbled label. So a packaged subject gets a COMPOSITION instruction, which
 * models obey, rather than a prohibition, which they ignore.
 */
test('a packaged subject is re-composed so the printed surface is out of frame', () => {
  const r = cinematicPrompt('a bag of coffee on a table');
  assert.equal(r.recomposed, true);
  assert.match(r.prompt, /label turned away or cropped out of frame/);
});

test('a subject with nothing printable on it is not re-composed', () => {
  const r = cinematicPrompt('roasted coffee beans spilling across dark slate');
  assert.equal(r.recomposed, false);
  assert.doesNotMatch(r.prompt, /cropped out of frame/);
});

test('flat mode exists for when cinema is wrong — a plain catalogue shot', () => {
  const r = cinematicPrompt('a white ceramic mug', { mode: 'flat' });
  assert.match(r.prompt, /clean product photography/);
  assert.doesNotMatch(r.prompt, /film grain/);
});

test('a fenced or prefaced verdict still parses', () => {
  const v = parseVerdict('Sure!\n```json\n{"usable":true,"score":8,"problems":[],"betterPrompt":"x"}\n```');
  assert.equal(v.usable, true);
  assert.equal(v.score, 8);
});

/**
 * ⚠️ AN UNREADABLE OPINION MUST NOT READ AS APPROVAL. The entire purpose is to
 * catch bad assets; defaulting to "usable" on a parse failure would disable the
 * mechanism exactly when it misbehaves.
 */
test('an unparseable verdict is not approval', () => {
  assert.equal(parseVerdict('I think it looks pretty good honestly'), null);
  const v = parseVerdict('{"score":9}');
  assert.equal(v.usable, false, 'usable must be explicit, never inferred from a score');
});

test('a score outside 0-10 is clamped rather than trusted', () => {
  assert.equal(parseVerdict('{"usable":true,"score":99}').score, 10);
  assert.equal(parseVerdict('{"usable":true,"score":-4}').score, 0);
});

// ── the loop ────────────────────────────────────────────────────────────────

/** A generator that always succeeds, recording what it was asked for. */
function stubGenerator(scores) {
  const asked = [];
  let i = 0;
  return {
    asked,
    generate: async ({ prompt }) => { asked.push(prompt); return { ok: true, path: `shot-${++i}.jpg`, bytes: 5000 }; },
    critic: () => scores.shift() ?? 0,
  };
}

/** Stub the OpenRouter call so the loop is exercised without network or spend. */
function criticFetch(nextScore) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        usable: nextScore() >= ACCEPT_SCORE, score: nextScore(true), problems: ['something'], betterPrompt: 'a better prompt',
      }) } }],
    }),
  });
}

function scorer(list) {
  let idx = 0;
  let pending = null;
  return (consume) => {
    if (pending === null) pending = list[Math.min(idx, list.length - 1)];
    if (consume) { const v = pending; pending = null; idx += 1; return v; }
    return pending;
  };
}

test('a good first shot is accepted and nothing more is spent', async () => {
  const g = stubGenerator([]);
  const r = await directImage({
    prompt: 'a lighthouse at dusk',
    generate: g.generate,
    readBytes: () => Buffer.alloc(5000, 1),
    apiKey: 'test',
    fetchImpl: criticFetch(scorer([9])),
  });
  assert.equal(r.ok, true);
  assert.equal(r.accepted, true);
  assert.equal(r.attempts.length, 1, 'an accepted shot must not trigger a re-shoot');
  assert.equal(g.asked.length, 1);
});

/**
 * ⚠️⭐ THE PLATEAU. Measured live: three attempts scored 2, 2, 2 — the critic's
 * own rewritten prompt each time, and 100 seconds of wall clock to arrive back
 * where it started. A structural defect does not re-prompt away.
 */
test('a re-shoot that does not improve stops the loop', async () => {
  const g = stubGenerator([]);
  const r = await directImage({
    prompt: 'a bag of coffee',
    generate: g.generate,
    readBytes: () => Buffer.alloc(5000, 1),
    maxAttempts: 3,
    apiKey: 'test',
    fetchImpl: criticFetch(scorer([2, 2, 2])),
  });
  assert.equal(r.attempts.length, 2, 'one wasted re-shoot proves the plateau; two is paying to be told again');
  assert.match(r.attempts[1].stoppedBecause, /plateau/);
  assert.equal(r.accepted, false);
});

test('the best attempt is returned even when none is accepted', async () => {
  const r = await directImage({
    prompt: 'a bag of coffee',
    generate: stubGenerator([]).generate,
    readBytes: () => Buffer.alloc(5000, 1),
    maxAttempts: 3,
    apiKey: 'test',
    fetchImpl: criticFetch(scorer([2, 5, 3])),
  });
  // A page with a mediocre hero is a page; a page with no hero is a bug.
  assert.equal(r.ok, true);
  assert.equal(r.score, 5);
  assert.equal(r.accepted, false, 'and the caller is told, so it can say so');
});

/**
 * ⚠️ NO EYES MUST NOT MEAN AUTOMATIC APPROVAL — that is precisely the failure
 * shape that let a blind render audit issue all-clears for eighteen commits.
 */
test('with no API key it shoots once and reports that it could not look', async () => {
  const g = stubGenerator([]);
  const r = await directImage({
    prompt: 'a lighthouse',
    generate: g.generate,
    readBytes: () => Buffer.alloc(5000, 1),
    apiKey: '',
    maxAttempts: 3,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.score, null);
  assert.equal(r.accepted, false, 'unlooked-at is not accepted');
  assert.match(r.attempts[0].criticError, /not looked at/);
});

test('a generator failure stops immediately rather than burning the budget', async () => {
  let calls = 0;
  const r = await directImage({
    prompt: 'x',
    generate: async () => { calls += 1; return { ok: false, error: 'the image service is not responding this session' }; },
    readBytes: () => null,
    maxAttempts: 3,
    apiKey: 'test',
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1, 'a dead provider must not be asked three times');
});
