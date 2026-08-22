/**
 * ── ⭐⭐ ENGINE CHOICE: THE DEFAULT, THE TWO OPPOSITE REFUSALS, AND THE RULE
 *        THAT THIS PACKAGE MUST NOT KNOW A PRICE ──────────────────────────────
 *
 * Three things are under test and they are three different kinds of failure:
 *
 *   1. ⚠️ A PREMIUM ENGINE MUST NEVER FIRE BY ITSELF. At 585 credits a clip
 *      against Starter's 2,000, one silent escalation is a quarter of somebody's
 *      month — spent on a decision they did not make.
 *   2. ⚠️⚠️ "NOT ON YOUR PLAN" AND "OUT OF CREDITS" ARE OPPOSITE MESSAGES. One
 *      says buying more changes nothing; the other says buying more is exactly
 *      the fix. Blurring them either takes somebody's money and leaves them
 *      blocked, or tells a customer to upgrade when their balance was the issue.
 *   3. ⭐⭐⭐ THE CLI MUST NOT HOLD THE PRICE LIST. It is a published npm package
 *      (a price compiled in is pinned at install time and re-priced never
 *      reaches it) sitting in a directory the person being billed can edit.
 *      Test 3 reads the source file and fails if a credit price appears in it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CREATIVE_ENGINES,
  CREATIVE_MEDIA,
  defaultEngineFor,
  resolveEngineChoice,
  checkEngine,
  enginesEndpoint,
  cataloguePath,
  fetchCatalogue,
  listEngines,
  listEnginesToolSchema,
  setRunEngine,
  runEngineFor,
  resetRunEngines,
  CATALOGUE_REFUSAL_TTL_MS,
} from '../lib/creative-engines.mjs';
import { generateImage, resetImageState } from '../lib/imagegen.mjs';
import { speak } from '../lib/media.mjs';
import { parseArgv } from '../lib/cli-args.mjs';
import { TOOL_NAMES, toolNamesForRounds } from '../lib/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * ⚠️ EVERY TEST GETS ITS OWN `ACUVO_HOME`. The catalogue cache lives beside the
 * credential under HOME, so a test that used the real one would read the
 * developer's own account — and worse, could WRITE to it. `accountDir` already
 * honours this override, which is why it exists.
 */
function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-engines-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return { ACUVO_HOME: dir };
}

/** Put a catalogue on disk as though a previous `list_engines` had cached it. */
function seedCatalogue(env, { ageMs = 0, tier = 'starter', creditsRemaining = 2000, engines }) {
  mkdirSync(env.ACUVO_HOME, { recursive: true });
  const payload = {
    fetchedAt: Date.now() - ageMs,
    tier,
    creditsRemaining,
    engines: engines ?? [
      { id: 'acuvo-image', credits: 4, reachable: true, minTier: 'free' },
      { id: 'acuvo-image-ultra', credits: 48, reachable: true, minTier: 'starter' },
      { id: 'acuvo-video', credits: 117, reachable: true, minTier: 'starter' },
      { id: 'acuvo-video-ultra', credits: 585, reachable: false, minTier: 'growth' },
    ],
  };
  writeFileSync(cataloguePath(env), `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

/* ─────────────────── 1. UNLOCKED, NEVER DEFAULTED ──────────────────────── */

test('⭐⭐ no medium ever defaults to an Ultra engine', () => {
  for (const medium of CREATIVE_MEDIA) {
    const chosen = defaultEngineFor(medium);
    assert.ok(chosen, `${medium} has no default engine at all`);
    assert.notEqual(
      chosen.grade, 'ultra',
      `${medium} defaults to ${chosen.id}. A premium engine chosen by the software spends someone's credits on a decision they did not make.`,
    );
  }
});

test('⭐⭐ an unnamed request resolves to core and reports that nobody named it', () => {
  const r = resolveEngineChoice('image', undefined);
  assert.equal(r.ok, true);
  assert.equal(r.engine.id, 'acuvo-image');
  assert.equal(r.named, false, '`named` is what tells the spend layer a human chose this — it must be false when nobody did');

  const named = resolveEngineChoice('image', 'ultra');
  assert.equal(named.engine.id, 'acuvo-image-ultra');
  assert.equal(named.named, true);
});

test("⭐ the words Roman uses resolve — 'basic' and 'premium', not just the ids", () => {
  assert.equal(resolveEngineChoice('image', 'basic').engine.id, 'acuvo-image');
  assert.equal(resolveEngineChoice('image', 'premium').engine.id, 'acuvo-image-ultra');
  assert.equal(resolveEngineChoice('video', 'Acuvo Video Ultra').engine.id, 'acuvo-video-ultra');
});

test('⚠️ a misspelled engine is refused BY NAME and told the choices', () => {
  const r = resolveEngineChoice('image', 'acuvo-image-max');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_engine');
  assert.match(r.error, /acuvo-image-ultra/, 'a refusal that does not say what to type instead is just an obstacle');
});

test("⚠️ naming another medium's engine gets its own sentence, not \"unknown\"", () => {
  const r = resolveEngineChoice('voice', 'acuvo-image');
  assert.equal(r.ok, false);
  assert.match(r.error, /is a image engine and this is a voice verb/);
});

/* ─────── 2. THE REFUSALS: OPPOSITE MESSAGES, AND THEY MUST STAY OPPOSITE ── */

test('⚠️⚠️ "not on your plan" and "out of credits" never share a code, a remedy or a remedy sentence', (t) => {
  const env = tempHome(t);

  // Entitlement: the server says this tier cannot reach it at all.
  seedCatalogue(env, { engines: [{ id: 'acuvo-image', credits: 4, reachable: false, minTier: 'growth' }] });
  const plan = checkEngine('image', 'acuvo-image', { env });

  // Balance: reachable, simply unaffordable.
  seedCatalogue(env, { creditsRemaining: 1, engines: [{ id: 'acuvo-image', credits: 4, reachable: true, minTier: 'free' }] });
  const money = checkEngine('image', 'acuvo-image', { env });

  assert.equal(plan.ok, false);
  assert.equal(money.ok, false);
  assert.equal(plan.code, 'engine_not_on_plan');
  assert.equal(money.code, 'insufficient_credits');
  assert.notEqual(plan.remedy, money.remedy, 'two refusals with the same remedy are one refusal wearing two hats');

  /**
   * ⚠️ THE CROSS-CONTAMINATION CHECK, AND IT IS THE POINT OF THIS TEST. Telling
   * someone to buy credits when the answer is a plan gate takes their money and
   * leaves them exactly as blocked.
   */
  assert.doesNotMatch(plan.error, /credit|top up|balance/i, `the plan refusal must not mention credits: ${plan.error}`);
  assert.doesNotMatch(money.error, /not included|higher tier|upgrade/i, `the balance refusal must not read as a plan gate: ${money.error}`);

  // Both must say plainly that no money moved — a refusal that leaves that open
  // is one the user has to go and check the ledger for.
  assert.match(plan.error, /nothing was charged/i);
  assert.match(money.error, /nothing was charged/i);
});

test('⚠️⭐ a STALE catalogue never refuses — a check that fails correct work is worse than no check', (t) => {
  const env = tempHome(t);
  seedCatalogue(env, {
    ageMs: CATALOGUE_REFUSAL_TTL_MS + 1_000,
    creditsRemaining: 0,
    engines: [{ id: 'acuvo-image', credits: 4, reachable: false, minTier: 'enterprise' }],
  });

  const r = checkEngine('image', 'acuvo-image', { env });
  assert.equal(
    r.ok, true,
    'a cached zero balance older than the TTL blocked a render. Someone who topped up a minute ago would be refused from a stale number — the gateway charges, so the gateway refuses.',
  );

  // …and the same answer inside the TTL does refuse, so the guard above is not
  // vacuous: it is the AGE doing the work, not a broken check.
  seedCatalogue(env, {
    ageMs: 1_000,
    creditsRemaining: 0,
    engines: [{ id: 'acuvo-image', credits: 4, reachable: false, minTier: 'enterprise' }],
  });
  assert.equal(checkEngine('image', 'acuvo-image', { env }).ok, false);
});

test('⚠️ "this CLI cannot run it" is a THIRD refusal and never poses as a plan gate', (t) => {
  const env = tempHome(t);
  // A catalogue that says the account CAN reach it — so any refusal here is
  // about the software, and must say so.
  seedCatalogue(env, { tier: 'scale', engines: [{ id: 'acuvo-video-ultra', credits: 585, reachable: true, minTier: 'growth' }] });

  const r = checkEngine('video', 'acuvo-video-ultra', { env });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'engine_unreachable_here');
  assert.match(r.error, /gap in this tool, not in your account/);
  assert.doesNotMatch(r.error, /not included in the|top up/i, 'a fact about the software dressed as a fact about the account sends people to buy an upgrade that changes nothing');
});

test('⚠️ `speak` refuses "acuvo-voice" and explains that it is a DIFFERENT model', async (t) => {
  const env = tempHome(t);
  const r = await speak('/nowhere', 'hello', null, {
    env: { ...env, MODAL_TTS_URL: 'https://example.invalid/tts' },
    engine: 'acuvo-voice',
    fetchImpl: async () => { throw new Error('speak must refuse before it calls anything'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'engine_unreachable_here');
  assert.match(r.error, /cloning/i);
  assert.match(r.error, /Kokoro/, 'the whole point of this refusal is naming the model it actually runs');
});

test('⭐ generate_image refuses an unreachable engine BEFORE spending one of the four image slots', async (t) => {
  const env = tempHome(t);
  resetImageState();
  t.after(() => resetImageState());

  const r = await generateImage({
    prompt: 'a red bicycle',
    engine: 'acuvo-image-ultra',
    env,
    executor: { root: '/nowhere' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'engine_unreachable_here');

  /**
   * ⚠️ THE SECOND HALF IS THE ONE THAT WOULD HAVE BITTEN. If the refusal
   * consumed a slot, four bad engine names would silently exhaust the run's
   * image budget and the FIFTH call — a perfectly good one — would fail for a
   * completely different and unexplainable reason.
   */
  for (let i = 0; i < 4; i += 1) {
    const bad = await generateImage({ prompt: 'x', engine: 'acuvo-video', env, executor: { root: '/nowhere' } });
    assert.equal(bad.ok, false);
  }
  const after = await generateImage({
    prompt: 'a red bicycle',
    env,
    executor: { root: '/nowhere' },
    // No provider is configured in this env, so it fails at the PROVIDERS — the
    // proof that it got past the cap, which is what is being asserted.
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.doesNotMatch(String(after.error ?? ''), /already generated 4 images/, 'refusals consumed the image budget');
});

/* ───── 3. THE ARCHITECTURAL RULE: THE PACKAGE DOES NOT KNOW A PRICE ─────── */

test('⭐⭐⭐ no credit price is compiled into this package', () => {
  /**
   * ⚠️ WHY A SOURCE-TEXT TEST AND NOT A BEHAVIOURAL ONE: the failure this
   * guards against is somebody adding `credits: 585` "just as a fallback so the
   * picker looks finished". That change would pass every behavioural test in
   * this file — it only breaks ten weeks later, on the day we re-price a rented
   * model and every installed copy quotes the old number.
   *
   * The four prices are the ones derived in `console/lib/plan-catalog.ts`:
   * image 4 · image ultra 48 · video 117 · video ultra 585 credits.
   */
  const source = readFileSync(join(HERE, '..', 'lib', 'creative-engines.mjs'), 'utf8');
  const code = source
    // Comments are allowed to quote prices — that is how the reasoning stays
    // readable. What must not exist is a price the CODE can read.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  /**
   * ⚠️ TWO CHECKS, BECAUSE ONE OF THEM WAS WRONG AND THE FAILURE TAUGHT ME THE
   * SHAPE. My first version banned the digits `48` anywhere in the code and went
   * RED on `if (h < 48)` inside `describeAge` — a plain hours-in-two-days
   * constant. A guard that fires on a number's DIGITS rather than its MEANING
   * fails correct work, which this repo holds to be worse than no guard.
   *
   * So: 585 and 117 are banned outright (they are unambiguous — nothing else in
   * a CLI is those numbers), and everything else is caught by BINDING THE NUMBER
   * TO ITS NOUN: no property called credits/price/cost may be assigned a
   * literal, whatever the literal is.
   */
  for (const price of ['585', '117']) {
    assert.doesNotMatch(
      code, new RegExp(`\\b${price}\\b`),
      `the credit price ${price} appears in executable code. Prices are account facts served by the gateway — a number here is pinned at install time and editable by the person being billed.`,
    );
  }
  assert.doesNotMatch(
    code, /\b(credits?|creditCost|price|cost|costMicros|costUsd)\s*[:=]\s*[0-9]/i,
    'a credit/price/cost property is assigned a literal number. That number ships inside an npm package: it is pinned at the version the customer installed, and it lives in a file they can edit.',
  );
  assert.doesNotMatch(code, /costMicros|USD_PER_CREDIT|creditsForCostAtFloor/, 'the cost model belongs to the server, not to a published npm package');
});

test('⭐ with no answer from anywhere, it says PRICES UNAVAILABLE and prints no number', async (t) => {
  const env = tempHome(t);
  const r = await listEngines({ env, fetchImpl: async () => { throw new Error('the network must not even be tried without an account'); } });

  assert.equal(r.pricesKnown, false);
  assert.equal(r.pricesFrom, 'unknown');
  assert.match(r.text, /PRICES UNAVAILABLE/);
  for (const e of r.engines) {
    assert.equal(e.credits, null, `${e.id} produced a credit number with nothing to derive it from`);
  }
  assert.doesNotMatch(r.text, /\d+ cr\//, 'a made-up price is worse than no price, because a user acts on it');
});

test('⭐⭐ it ASKS the gateway, sends the account token, and caches what it hears', async (t) => {
  const env = tempHome(t);
  writeFileSync(join(env.ACUVO_HOME, 'credentials.json'), JSON.stringify({ token: 'acu_test_123' }), 'utf8');
  mkdirSync(env.ACUVO_HOME, { recursive: true });

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init?.headers?.authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tier: 'growth',
        creditsRemaining: 8000,
        engines: [
          { id: 'acuvo-image', credits: 4, reachable: true, minTier: 'free' },
          { id: 'acuvo-video-ultra', credits: 585, reachable: true, minTier: 'growth' },
        ],
      }),
    };
  };

  const r = await listEngines({ env, fetchImpl });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://acuvo.xxiautomate.com/api/cli/v1/engines');
  assert.equal(seen[0].auth, 'Bearer acu_test_123');
  assert.equal(r.pricesFrom, 'live');
  assert.equal(r.tier, 'growth');
  assert.equal(r.engines.find((e) => e.id === 'acuvo-image').credits, 4);

  // ⭐ Cached under HOME, beside the credential — never in the workspace, where
  // the agent could write it. A price list the agent can write is one it can lower.
  const cached = JSON.parse(readFileSync(cataloguePath(env), 'utf8'));
  assert.equal(cached.tier, 'growth');
  assert.equal(cached.engines.length, 2);

  // …and a later read with the network down reports the CACHE, with its age.
  const offline = await listEngines({ env, fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(offline.pricesFrom, 'cache');
  assert.match(offline.text, /585 cr\/clip/);
  assert.match(offline.text, /cached \d+s ago/);
});

test('⚠️ a 200 that is not a catalogue is a FAILURE, not an empty catalogue', async (t) => {
  const env = tempHome(t);
  writeFileSync(join(env.ACUVO_HOME, 'credentials.json'), JSON.stringify({ token: 'acu_test_123' }), 'utf8');

  const r = await fetchCatalogue({
    env,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ engines: [] }) }),
  });
  /**
   * ⚠️ An empty list rendered as a catalogue would present as "you can reach
   * nothing" — a refusal we invented ourselves out of a malformed response.
   * `res.ok` answers a question about the HTTP conversation, never about
   * whether the work happened.
   */
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('⭐ the engines endpoint is the gateway\'s sibling, so there is only ever one host', () => {
  assert.equal(
    enginesEndpoint('https://acuvo.xxiautomate.com/api/cli/v1/chat/completions'),
    'https://acuvo.xxiautomate.com/api/cli/v1/engines',
  );
  assert.equal(enginesEndpoint('https://example.test/gw/'), 'https://example.test/gw/engines');
  assert.equal(enginesEndpoint(''), null);
});

/* ──────────────────────── 4. THE SURFACES ARE REACHABLE ─────────────────── */

test('⭐ --engine is parsed, validated, and refuses a name that is not an engine', () => {
  const ok = parseArgv(['--engine', 'acuvo-image-ultra', 'build a page']);
  assert.equal(ok.ok, true);
  assert.equal(ok.options.engine, 'acuvo-image-ultra');

  const bad = parseArgv(['--engine', 'gpt-image-2', 'build a page']);
  assert.equal(bad.ok, false, 'a typo must cost a message, not a round trip and a confusing refusal mid-render');
  assert.match(bad.error, /acuvo-image-ultra/);

  /**
   * ⚠️ THE PARSER MUST NOT HAVE SIDE EFFECTS. It validated the id; it did not
   * commit it. A parser that wrote to module state could not be called twice in
   * one test file without the second call inheriting the first one's choice.
   */
  assert.equal(runEngineFor('image'), null);
});

test('⭐ the run-level choice is per MEDIUM and cannot leak sideways', (t) => {
  resetRunEngines();
  t.after(() => resetRunEngines());
  const r = setRunEngine('acuvo-image-ultra');
  assert.equal(r.ok, true);
  assert.equal(runEngineFor('image'), 'acuvo-image-ultra');
  assert.equal(runEngineFor('voice'), null, 'choosing an image engine must not change what speak does');
  assert.equal(setRunEngine('nonsense').ok, false);
});

test('⭐ `list_engines` is a real verb: in the registry, in the multi-round offer, and NOT single-shot', () => {
  assert.ok(TOOL_NAMES.includes('list_engines'), 'a capability nothing offers is unreachable in the way that matters');
  assert.ok(toolNamesForRounds(5, { env: {}, root: process.cwd() }).includes('list_engines'));
  assert.ok(
    !toolNamesForRounds(1, { env: {}, root: process.cwd() }).includes('list_engines'),
    'its answer exists to change the NEXT call — with no next call it burns the only round on a price it cannot use',
  );
  const schema = listEnginesToolSchema();
  assert.match(schema.function.description, /NEVER used unless the user asked for it/, 'the schema is re-read by the model on every call; the rule has to be in it');
});

test('⚠️⭐ the ids mirror the console catalogue, or the picker silently loses a row', (t) => {
  /**
   * ⚠️ `console/lib/creative-engines.ts` IS THE CATALOGUE OF RECORD — it owns
   * `costMicros`, `minTier` and which upstream model actually runs. This file
   * is a client that has to be able to NAME what it is asking for. When an id
   * drifts, the server answers with an engine this CLI has never heard of and
   * the row simply vanishes from the picker with no error anywhere.
   */
  const consoleDir = join(HERE, '..', '..', 'console');
  const consoleFile = join(consoleDir, 'lib', 'creative-engines.ts');

  /**
   * ── ⚠️⚠️ TWO DIFFERENT ABSENCES, AND ONLY ONE IS A BUG ──────────────────────
   *
   * This package is published to npm and mirrored to a PUBLIC repo, where there
   * is no sibling `console/` and never will be. Failing there made the suite red
   * for every person who cloned it — while the README invites them to "read it,
   * audit it, run it". A guard that fails on a machine where the thing it guards
   * cannot exist is not protecting anything; it is just calling honest clones
   * broken.
   *
   * ⭐ THE ORIGINAL REASONING STILL HOLDS AND IS KEPT. A drift guard that
   * disappears when its other half MOVES reports green for the exact thing it
   * was written to catch. So the two cases are separated rather than collapsed:
   *
   *   · no `console/` directory at all  → standalone clone. Skip, and say so.
   *   · `console/` exists, file missing → it MOVED. Fail, loudly, as before.
   */
  if (!existsSync(consoleDir)) {
    t.skip('standalone checkout — no sibling console/ to compare against');
    return;
  }

  let text;
  try {
    text = readFileSync(consoleFile, 'utf8');
  } catch {
    assert.fail(`the catalogue of record is missing at ${consoleFile} — if it moved, point this test at the new path rather than deleting it`);
  }
  const theirs = [...text.matchAll(/^\s{4}id: '([a-z0-9-]+)',$/gm)].map((m) => m[1]).sort();
  const ours = CREATIVE_ENGINES.map((e) => e.id).sort();
  assert.deepEqual(ours, theirs, 'the CLI and the console disagree about which engines exist');
});
