/**
 * ── ⚠️⚠️ 59% CACHE ON A LIVE RUN, BECAUSE ONE ROUND LANDED ON THE SECOND NAME ─
 *
 * The measured cost of that: 98.3% cached on the first choice against 0.0% on
 * the second — 4.6× the cost for byte-identical
 * input. Roman's rule is that the cache must stay in the high 90s permanently,
 * so a ~5% scatter is not survivable on short tasks.
 *
 * These tests pin the two properties that make "learn, then lock" safe:
 * strictness is only ever applied to a provider we have SEEN SERVE, and any
 * failure gives the lock straight back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  freshWarmth, rememberWarm, forgetWarm, warmProviderFor, routeFor, describeRouting,
  loadWarmth, saveWarmth, warmthPath, routingNote, pruneUnchosen,
} from '../lib/warm-provider.mjs';
import { PROVIDER_PIN_BY_MODEL } from '../lib/model.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';
/**
 * ── ⚠️⚠️⚠️ DERIVED FROM THE PIN, NEVER TYPED — THIS FIXTURE WENT STALE TWICE ─
 *
 * It was `['StreamLake', 'Baidu', 'GMICloud']`, then hand-remapped 1:1 to
 * `['DeepInfra', 'Ambient', 'Relace']` on 2026-08-27 with a comment explaining
 * that the OLD names were no longer in `KNOWN_PROVIDERS_BY_MODEL`, so
 * `rememberWarm` refused every one of them and **silently hollowed out every
 * test below that named one**. On 2026-09-10 the pin moved again — flash now
 * leads with `Sail Research` and `Ambient` was dropped ("gone from the feed",
 * `model.mjs`) — and the same three tests went red for the same reason, in the
 * same file, for the second time.
 *
 * ⭐ THE HAND-REMAP WAS THE DEFECT, NOT THE NAMES. A test that types a provider
 * name is a SECOND OPINION about the pin, and the pin is the one that ships.
 * These read `PROVIDER_PIN_BY_MODEL` — the exact table `chosenProvidersFor`
 * consults — so a repin can never again hollow out a guard without failing it
 * loudly first, at the length assertion below.
 *
 * ⚠️ POSITION, NOT IDENTITY, IS WHAT THESE TESTS ARE ABOUT. `LEAD` is "the name
 * the config prefers" and `SECOND` is "a name that is NOT the lead" — the whole
 * point of `⚠️⚠️ it locks to who ACTUALLY served` is that those two differ.
 */
const PIN = PROVIDER_PIN_BY_MODEL[FLASH];
assert.ok(
  Array.isArray(PIN) && PIN.length >= 2,
  `flash has no pin of at least two providers (${JSON.stringify(PIN)}) — these tests distinguish the LEAD `
  + 'from a NON-LEAD upstream and cannot say anything with fewer than two names.',
);
const [LEAD, SECOND] = PIN;
/** The tail of the pin — used where the point is "any chosen name", not the lead. */
const LAST = PIN[PIN.length - 1];

/**
 * ── ⚠️⚠️ THE MOST EXPENSIVE BUG THIS MODULE HAS HAD ───────────────────────
 *
 * Measured 2026-08-25 from our own audit ledger. `~/.acuvo/warm-providers.json`
 * had learned an upstream ABSENT from the configured pin — one nobody had
 * chosen or priced — and it then served **6 of 6** recorded runs at a multiple
 * of the configured endpoints on CACHE READS, the exact token type the cache
 * strategy exists to maximise. It stuck because `routeFor` locks with
 * `allow_fallbacks: false`, so the pin only releases on a FAILURE — and an
 * expensive success is not one.
 */
test('⚠️⚠️ it REFUSES to learn a provider that is not in the configured pin', () => {
  const s = freshWarmth();
  rememberWarm(s, FLASH, 'Novita');
  assert.equal(warmProviderFor(s, FLASH), null,
    'Novita is not in the pin — learning it locks us onto an upstream we never chose, with fallbacks off');

  rememberWarm(s, FLASH, LEAD);
  assert.equal(warmProviderFor(s, FLASH), LEAD, 'a chosen provider must still be learned');
});

/**
 * ── ⚠️⚠️⚠️ THE THIRD TIME A TYPED FIXTURE WENT STALE IN THIS FILE (2026-09-20) ─
 *
 * The header above records the provider NAMES going stale twice and prescribes
 * the cure — derive from `PROVIDER_PIN_BY_MODEL`, never type. The test below
 * then typed a MODEL ID, `'deepseek/deepseek-chat'`, chosen because it had no
 * pin and so exercised the no-opinion branch. It gained one
 * (`['StreamLake', 'DeepInfra']`), the membership check acquired an opinion, and
 * the assertion went red for exactly the reason the header warns about, in the
 * same file, one layer down. A typed model id is the same second opinion about
 * the pin table that a typed provider name is.
 *
 * ⭐ SO THE UNPINNED MODEL IS DERIVED TOO — any id the table does not hold.
 */
const UNPINNED_MODEL = (() => {
  for (const candidate of ['zz/never-priced-model', 'deepseek/deepseek-chat']) {
    if (!PROVIDER_PIN_BY_MODEL[candidate]) return candidate;
  }
  return null;
})();

test('⚠️ a one-character provider name is garbage, not a provider', () => {
  // The real file held `P` for a model with no configured pin, so the membership
  // check had no opinion and would have honoured it forever.
  assert.ok(UNPINNED_MODEL, 'every candidate model id is now pinned — pick another unpinned id');
  const s = freshWarmth();
  rememberWarm(s, UNPINNED_MODEL, 'P');
  assert.equal(warmProviderFor(s, UNPINNED_MODEL), null);
  rememberWarm(s, UNPINNED_MODEL, LEAD);
  assert.equal(warmProviderFor(s, UNPINNED_MODEL), LEAD,
    'a model we never priced may still learn freely — we have no opinion, only a floor');
});

test('⭐ pruneUnchosen clears damage ALREADY on disk, not just future writes', () => {
  const s = freshWarmth();
  // Bypass rememberWarm the way loadWarmth does when reading an old file.
  s.byModel.set(FLASH, 'Novita');
  // ⚠️ UNPINNED ON PURPOSE. Against a model the table DOES hold, `P` would be
  // pruned for failing the membership check and this line would pass without
  // ever exercising the one-character floor it exists to prove.
  s.byModel.set(UNPINNED_MODEL, 'P');
  s.byModel.set('z-ai/glm-4.6', 'Venice');
  pruneUnchosen(s);
  assert.equal(warmProviderFor(s, FLASH), null, 'the unchosen pin must not survive a reload');
  assert.equal(warmProviderFor(s, UNPINNED_MODEL), null);
  assert.equal(warmProviderFor(s, 'z-ai/glm-4.6'), 'Venice', 'a legitimate entry survives');
});

test('round 1 routes exactly as it does today — full list, fallbacks ON', () => {
  /**
   * ⚠️ This is what keeps the pro model working. Its pin begins with `DeepSeek`,
   * which 404s for this account, so forcing a single name on round 1 would cost
   * every pro round a failed hop forever.
   */
  const r = routeFor(freshWarmth(), FLASH, PIN);
  assert.deepEqual(r.order, PIN);
  assert.equal(r.strict, false);
});

test('⭐ after a provider serves, later rounds ask for THAT ONE with fallbacks off', () => {
  const s = rememberWarm(freshWarmth(), FLASH, LEAD);
  const r = routeFor(s, FLASH, PIN);
  assert.deepEqual(r.order, [LEAD]);
  assert.equal(r.strict, true);
  assert.match(r.reason, /holds this session's prompt cache/);
});

test('⚠️⚠️ it locks to who ACTUALLY served, not to the first name', () => {
  /**
   * The live failure: Ambient served a round. The cache is now on Ambient, so
   * chasing DeepInfra would be cold too. Follow the bytes, not the config.
   */
  const s = rememberWarm(freshWarmth(), FLASH, SECOND);
  assert.deepEqual(routeFor(s, FLASH, PIN).order, [SECOND]);
});

test('⚠️ a single name is sent ALONE — a list is a preference, not a lock', () => {
  // `[warm, ...rest]` would be the same preference list that let a round land
  // on Ambient while DeepInfra sat first. That is the bug, not the fix.
  const s = rememberWarm(freshWarmth(), FLASH, LEAD);
  assert.equal(routeFor(s, FLASH, PIN).order.length, 1);
});

test('⚠️⚠️ a failure gives the lock back immediately', () => {
  const s = rememberWarm(freshWarmth(), FLASH, LEAD);
  forgetWarm(s, FLASH);
  const r = routeFor(s, FLASH, PIN);
  assert.deepEqual(r.order, PIN, 'a dead provider must cost one round, not the session');
  assert.equal(r.strict, false, '"never single" survives — we still fall back, just explicitly');
});

test('⭐ strict is NEVER true without a provider we watched serve', () => {
  /**
   * The whole safety argument. Strictness on a CONFIGURED name is a single point
   * of failure (`model.mjs` argues this at length and it is why
   * ACUVO_PROVIDER_STRICT is opt-in). Strictness on an OBSERVED name is just
   * "go back where the cache is".
   */
  for (const state of [freshWarmth(), forgetWarm(rememberWarm(freshWarmth(), FLASH, 'X'), FLASH)]) {
    assert.equal(routeFor(state, FLASH, PIN).strict, false);
  }
});

test('warmth is per MODEL — flash and pro do not share an upstream', () => {
  const s = rememberWarm(freshWarmth(), FLASH, LEAD);
  assert.equal(warmProviderFor(s, 'deepseek/deepseek-v4-pro-0813'), null);
  assert.deepEqual(routeFor(s, 'deepseek/deepseek-v4-pro-0813', ['DeepSeek', 'GMICloud']).order,
    ['DeepSeek', 'GMICloud']);
});

test('⚠️ never records a provider the response did not name', () => {
  // Guessing here pins us to a provider that never served — the cold-cache bug
  // with extra steps.
  for (const bad of [null, undefined, '', '   ']) {
    assert.equal(warmProviderFor(rememberWarm(freshWarmth(), FLASH, bad), FLASH), null);
  }
});

test('no pin configured stays no pin — this never invents routing', () => {
  const r = routeFor(freshWarmth(), FLASH, []);
  assert.deepEqual(r.order, []);
  assert.equal(r.strict, false);
});

describeRoutingTests();
function describeRoutingTests() {
  test('⭐ a cold landing is REPORTED, because the failure was invisible', () => {
    /**
     * Every layer of this CLI called a fallback `pinTook: 1`, so a 4.6× bill
     * read as healthy. Acting on it silently would repeat that mistake in the
     * other direction.
     */
    const d = describeRouting({ expected: 'StreamLake', served: 'Baidu' });
    assert.equal(d.warm, false);
    assert.match(d.note, /Baidu served this round instead of StreamLake/);
    assert.match(d.note, /4\.6/);
  });

  test('and a warm landing says nothing at all', () => {
    // Noise on the healthy path is how people learn to ignore the warning.
    assert.deepEqual(describeRouting({ expected: 'StreamLake', served: 'StreamLake' }), { warm: true, note: null });
  });

  test('unknown either side is unknown, not a false alarm', () => {
    assert.equal(describeRouting({ expected: null, served: 'Baidu' }).warm, null);
    assert.equal(describeRouting({ expected: 'StreamLake', served: null }).warm, null);
  });
}

// ── ⚠️⚠️ REACH: this must be WIRED, not merely written ──────────────────────

test('⚠️⚠️ the session loop actually uses it', async () => {
  /**
   * ⭐ THE WHOLE POINT. This repo has shipped seven capabilities that were built
   * end to end and connected to nothing, and two more (plan-coherence, python)
   * are orphaned right now. A cache fix nobody calls would be the most ironic
   * possible addition to that list.
   *
   * Comments stripped first — a guard that greps source otherwise matches the
   * comment explaining the feature.
   */
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, '..', 'lib', 'turn.mjs'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.match(code, /from '\.\/warm-provider\.mjs'/, 'turn.mjs does not import warm-provider');
  // ⚠️ `loadWarmth`, not `freshWarmth` — the session must START from what served
  // the last run, or round one is cold on every invocation forever.
  assert.match(code, /const warmth = loadWarmth\(\)/, 'the session starts cold every time');
  assert.match(code, /routeFor\(warmth, config\.model/, 'the route is never computed');
  assert.match(code, /routeOverride:/, 'the route never reaches the model call');
  /**
   * ⚠️⚠️ REWRITTEN 2026-09-01, AND THE OLD ASSERTION WAS PINNING THE BUG.
   *
   * It read `rememberWarm(warmth, config.model, reply.provider)` — i.e. it
   * required, in a guard, that the round's provider be learned against the model
   * that was ASKED FOR rather than the one that ANSWERED. `chain.mjs` falls back
   * across models, `DeepInfra` sits in both `deepseek-v4-flash-0731`'s pin and
   * `z-ai/glm-4.6`'s, and `rememberWarm`'s membership check therefore waved the
   * cross-model write straight through. Measured: one GLM round taught the
   * DeepSeek model a `strict: true` (`allow_fallbacks: false`) pin on an upstream
   * that had never held its prefix — and `saveWarmth` made it machine-wide.
   *
   * ⭐ A GUARD THAT PINS A DEFECT IS WORSE THAN NO GUARD, so this now pins the
   * RULE instead: warmth is keyed on the model that replied.
   */
  assert.match(code, /learnFromRound\(warmth, \{/, 'nothing learns who served');
  assert.match(code, /asked: config\.model,/, 'the round outcome does not say which model was asked for');
  assert.match(
    code,
    /served: reply\?\.model \?\? null,/,
    'warmth is not keyed on the model that ANSWERED — a chain fallback will teach the configured '
    + 'model an upstream that never served its prefix, and pin it fallback-free',
  );
  assert.match(code, /ok: reply\?\.ok === true,/, 'a failure never releases the lock');
});

test('⚠️ and the model layer honours an override', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const model = readFileSync(join(here, '..', 'lib', 'model.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.match(model, /routeOverride/, 'callModel does not accept a route override');
  assert.match(model, /allow_fallbacks: !effectiveStrict/, 'the override cannot turn fallbacks off');
});

// ── ⭐⭐⭐ ACROSS SESSIONS — where the last points of hit rate live ───────────

test('⭐⭐ what served the last run is remembered for the next one', async () => {
  /**
   * Round one is cold WITHIN a session by definition. But our prompt prefix is
   * byte-identical on every run and a provider's cache survives upstream for
   * minutes to hours, so round one only has to be cold ONCE on a machine.
   */
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'acuvo-warmth-'));
  try {
    const env = { ACUVO_HOME: home };
    // ⚠️ REPINNED 2026-08-27: 'GMICloud' is not in flash's corrected known-
    // provider set (it never was flash's — it was the third name on the OLD,
    // wrong pin). 'Relace' is the corrected pin's third name.
    const saved = rememberWarm(freshWarmth(), FLASH, LAST);
    assert.equal(saveWarmth(saved, env), true);

    const loaded = loadWarmth(env);
    assert.equal(warmProviderFor(loaded, FLASH), LAST);
    // …and the very first call of the NEXT run is therefore already pinned.
    assert.deepEqual(routeFor(loaded, FLASH, PIN).order, [LAST]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('⚠️ a missing or corrupt file is "unknown", never a crash', async () => {
  /**
   * A cache HINT that could break a run would be a far worse trade than the hit
   * rate it buys. Unknown is exactly the state a first run is in anyway.
   */
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'acuvo-warmth-bad-'));
  try {
    assert.equal(warmProviderFor(loadWarmth({ ACUVO_HOME: home }), FLASH), null, 'absent file');
    mkdirSync(home, { recursive: true });
    writeFileSync(warmthPath({ ACUVO_HOME: home }), 'not json at all');
    assert.equal(warmProviderFor(loadWarmth({ ACUVO_HOME: home }), FLASH), null, 'corrupt file');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('⚠️ it lives under HOME, never inside a workspace', () => {
  /**
   * Same argument `account.mjs` makes about the credential: `WRITE_FORBIDDEN_ROOTS`
   * does not cover `.acuvo`, so an agent can write `.acuvo/anything` in a
   * workspace — and a file the agent can write must not steer its own routing.
   */
  const p = warmthPath({ ACUVO_HOME: '/tmp/acuvo-home' });
  assert.match(p, /acuvo-home/);
  assert.match(p, /warm-providers\.json$/);
});

test('⚠️⚠️ the session loads it at the start and saves it at the end', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join: j } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(j(here, '..', 'lib', 'turn.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.match(code, /const warmth = loadWarmth\(\)/, 'the session starts cold every time');
  assert.match(code, /saveWarmth\(warmth\)/, 'nothing is handed to the next run');
});

/**
 * ── ⭐⭐ `/model` MUST ANSWER "WHY IS THIS COSTING MORE" ─────────────────────
 *
 * `aggregateProviders` counted routing per turn and `formatSummary` printed it
 * once, at the end. `/model` — the command someone types in the MIDDLE of a
 * session, which is when they ask — reported the configured name only.
 *
 * ⚠️ The case that matters is `pinFellBack`: a later name in the pin served the
 * round, so the prefix cache was cold and the same bytes cost up to 4.6x, with
 * no error raised anywhere. `pinTook` and `pinMissed` are both loud; the
 * expensive one is silent, so it gets the sentence.
 */
test('routingNote: a clean pin says the cache applied', () => {
  const note = routingNote({ pin: ['StreamLake'], served: { StreamLake: 6 }, pinTook: 6, pinFellBack: 0, pinMissed: 0 });
  assert.match(note, /StreamLake/);
  assert.match(note, /held every round/);
  assert.match(note, /cache applied/);
});

test('⚠️⚠️ routingNote: a FELL-BACK round is named as a cost, not a detail', () => {
  const note = routingNote({
    pin: ['StreamLake', 'Baidu'], served: { StreamLake: 4, Baidu: 2 },
    pinTook: 4, pinFellBack: 2, pinMissed: 0,
  });
  assert.match(note, /2 of 6 rounds did NOT land on StreamLake/);
  assert.match(note, /4\.6x/, 'the cost of the fallback is the reason to show it at all');
  /**
   * ⚠️ It must not read as success. The old `pinTook` semantics folded this
   * case into "the pin worked", which is precisely how it stayed invisible.
   */
  assert.doesNotMatch(note, /cache applied/);
});

test('routingNote: a pin nothing matched is diagnosed as a typo', () => {
  const note = routingNote({ pin: ['DeepSeek'], served: { Novita: 3 }, pinTook: 0, pinFellBack: 0, pinMissed: 3 });
  assert.match(note, /matched nothing/);
  assert.match(note, /typo/);
});

test('routingNote: no pin is stated plainly rather than dressed up', () => {
  const note = routingNote({ pin: null, served: { Novita: 3 } });
  assert.match(note, /no provider pin/);
  assert.doesNotMatch(note, /4\.6x/, 'unpinned is not a fault to warn about, just a fact');
});

test('⚠️⚠️ routingNote: UNKNOWN says nothing — it never reassures on no evidence', () => {
  /**
   * The rule `parseReply` follows when it leaves `provider` null rather than
   * "unpinned": a transport that reports no routing is unknown. Telling someone
   * their cache is fine on no evidence is worse than silence, and `renderModel`
   * omits an absent note entirely.
   */
  assert.equal(routingNote(null), null);
  assert.equal(routingNote({ pin: ['StreamLake'], served: {} }), null);
  assert.equal(routingNote({ served: {} }), null);
});

test('routingNote: the busiest upstream is listed first', () => {
  const note = routingNote({ pin: null, served: { Baidu: 1, StreamLake: 9 } });
  assert.ok(note.indexOf('StreamLake') < note.indexOf('Baidu'), `ordering is not by round count: ${note}`);
});
