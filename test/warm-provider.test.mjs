/**
 * ── ⚠️⚠️ 59% CACHE ON A LIVE RUN, BECAUSE ONE ROUND LANDED ON THE SECOND NAME ─
 *
 * The measured cost of that: 98.3% cached and $0.000172 on the first choice
 * against 0.0% cached and $0.000791 on the second — 4.6× for byte-identical
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
  loadWarmth, saveWarmth, warmthPath, routingNote,
} from '../lib/warm-provider.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const PIN = ['StreamLake', 'Baidu', 'GMICloud'];

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
  const s = rememberWarm(freshWarmth(), FLASH, 'StreamLake');
  const r = routeFor(s, FLASH, PIN);
  assert.deepEqual(r.order, ['StreamLake']);
  assert.equal(r.strict, true);
  assert.match(r.reason, /holds this session's prompt cache/);
});

test('⚠️⚠️ it locks to who ACTUALLY served, not to the first name', () => {
  /**
   * The live failure: Baidu served a round. The cache is now on Baidu, so
   * chasing StreamLake would be cold too. Follow the bytes, not the config.
   */
  const s = rememberWarm(freshWarmth(), FLASH, 'Baidu');
  assert.deepEqual(routeFor(s, FLASH, PIN).order, ['Baidu']);
});

test('⚠️ a single name is sent ALONE — a list is a preference, not a lock', () => {
  // `[warm, ...rest]` would be the same preference list that let a round land
  // on Baidu while StreamLake sat first. That is the bug, not the fix.
  const s = rememberWarm(freshWarmth(), FLASH, 'StreamLake');
  assert.equal(routeFor(s, FLASH, PIN).order.length, 1);
});

test('⚠️⚠️ a failure gives the lock back immediately', () => {
  const s = rememberWarm(freshWarmth(), FLASH, 'StreamLake');
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
  const s = rememberWarm(freshWarmth(), FLASH, 'StreamLake');
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
  assert.match(code, /rememberWarm\(warmth, config\.model, reply\.provider\)/, 'nothing learns who served');
  assert.match(code, /forgetWarm\(warmth, config\.model\)/, 'a failure never releases the lock');
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
    const saved = rememberWarm(freshWarmth(), FLASH, 'GMICloud');
    assert.equal(saveWarmth(saved, env), true);

    const loaded = loadWarmth(env);
    assert.equal(warmProviderFor(loaded, FLASH), 'GMICloud');
    // …and the very first call of the NEXT run is therefore already pinned.
    assert.deepEqual(routeFor(loaded, FLASH, PIN).order, ['GMICloud']);
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
