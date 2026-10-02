/**
 * ── ⭐⭐⭐ WHICH ENGINE DREW IT, AND WHO DECIDED — THE CLI HALF ──────────────
 *
 * Roman, 2026-08-16: *"in the CLI and in the builder the AI will ask which
 * Acuvo image model or video model they want, basic or premium, because how
 * else are we going to do this."* And on the people paying the most:
 * *"they might not always want that."*
 *
 * ── ⚠️ THE RULE, AND IT IS THE WHOLE FILE: UNLOCKED, NEVER DEFAULTED ────────
 *
 * Every medium's default is its CORE engine. An Ultra engine runs only when a
 * human named it. A premium engine that fires on its own spends somebody's
 * credits on a decision they did not make — and at **585 credits a clip against
 * Starter's 2,000**, one silent escalation is a quarter of their month.
 * `defaultEngineFor` therefore has no path that can return an `ultra` engine,
 * the same way `console/lib/creative-engines.ts` has none.
 *
 * ── ⭐⭐⭐ AND THE ARCHITECTURAL CONSTRAINT THAT SHAPES EVERYTHING BELOW ─────
 *
 * **THIS PACKAGE MUST NOT HOLD THE PRICE LIST.** Two reasons, and both are
 * fatal rather than untidy:
 *
 *   1. ⚠️ IT IS PUBLISHED. `acuvo-code` is an npm package on somebody else's
 *      disk. A price compiled into it is the price that shipped on the day they
 *      installed — so the day we re-price a rented model, every un-upgraded
 *      copy quotes the old number and we either honour a price we no longer
 *      have, or we quote one figure and charge another. Neither is survivable
 *      and both are silent.
 *   2. ⚠️⚠️ IT IS EDITABLE. `node_modules/acuvo-code/lib/creative-engines.mjs`
 *      is a text file the customer owns. A credit cost held here is a number
 *      the person being billed can change. Entitlement and price are facts
 *      about an ACCOUNT and they live on the server, next to the balance they
 *      are subtracted from.
 *
 * ⭐ SO THIS FILE HOLDS IDENTITY AND NOTHING ELSE: ids, display names, which
 * medium, core-or-ultra, and what one unit is called. Those are LABELS — a
 * forged label buys nothing, because the gateway is the thing that charges.
 * Every number comes from `GET …/engines`, is cached under HOME, and is
 * reported with its age. When there is no answer the honest output is
 * "prices unavailable", never a plausible guess: a made-up price is worse than
 * no price, because a user acts on it.
 *
 * ⚠️ THE IDS MIRROR `console/lib/creative-engines.ts` EXACTLY. That file is the
 * catalogue of record (it owns `costMicros`, `minTier` and the upstream model);
 * this one is a client that has to be able to name what it is asking for. If an
 * id here has no counterpart there, the server answers with an engine this CLI
 * has never heard of and the picker silently loses a row — which is why
 * `mirrorsConsoleCatalogue` in the test compares the two lists by hand.
 *
 * ── ⚠️ BYOK = NEVER, AND THERE IS NO CREATIVE PATH THAT TAKES A USER KEY ────
 *
 * Roman, twice. Nothing in this file reads a provider key, and no engine here
 * can be pointed at one. `ACUVO_IMAGE_SECRET` (imagegen.mjs) is OUR shared
 * secret for OUR Modal GPU — the opposite of BYOK — and is not a way to buy
 * capacity with your own OpenAI account. If a future engine needs a vendor key,
 * that key belongs behind the gateway with all the others.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { accountDir, readAccount } from './account.mjs';
import { avatarConfig } from './avatar.mjs';

/**
 * ── IDENTITY ONLY. NO MONEY. ────────────────────────────────────────────────
 *
 * `unit` is here because a refusal has to say "585 credits a CLIP" rather than
 * "585 credits" — a number without its unit is the second half of a sentence.
 * It is a noun, not a price.
 *
 * ⚠️ `localReach` IS THE FIELD THAT KEEPS THIS FILE HONEST. It says whether
 * THIS BINARY can run the engine at all, and it is `false` for four of the six
 * because it genuinely is: there is no video module and no face module in this
 * package (measured 2026-08-16 — `ls lib/` has neither), and no image path to
 * gpt-image-2. Offering a picker that lists four engines nothing can run would
 * be the dead-button failure this repo has already paid for twice.
 */
export const CREATIVE_ENGINES = Object.freeze([
  Object.freeze({
    id: 'acuvo-image',
    name: 'Acuvo Image',
    medium: 'image',
    grade: 'core',
    unit: 'image',
    /**
     * ⭐ REACHABLE, and it is the chain `generate_image` already runs: our own
     * A10G first, then Perchance, then Pollinations.
     *
     * ⚠️ WHICH MEANS "Acuvo Image" IS SOMETIMES THE FREE FALLBACK. When our GPU
     * is dark the picture comes from Pollinations — a shared free service — and
     * `generateImage` already says so in its `note`. The brand names the SLOT a
     * user chose, not a guarantee about which machine answered, and that
     * distinction has to survive into the report or the note stops being true.
     */
    localReach: true,
  }),
  Object.freeze({
    id: 'acuvo-image-ultra',
    name: 'Acuvo Image Ultra',
    medium: 'image',
    grade: 'ultra',
    unit: 'image',
    /**
     * ⚠️ NOT REACHABLE FROM HERE, and it is not a config problem. gpt-image-2
     * is a rented model behind OUR account; reaching it means a gateway render
     * endpoint, and there is none (`acuvo-gateway/lib/handler.mjs` is a chat
     * completions proxy and nothing else — read 2026-08-16). Writing a client
     * for an endpoint that cannot be called once is how this package grows
     * another capability that is built and unproven, which imagegen.mjs's own
     * header already refuses to do for the flux studio.
     */
    localReach: false,
  }),
  /**
   * ⭐ REACHABLE SINCE 2026-08-22 — `generate_video` (avatar-run.mjs) drives our
   * own `acuvo-video` Modal app. See `reachedBy` below for why the boolean above
   * is no longer the whole answer.
   */
  Object.freeze({ id: 'acuvo-video', name: 'Acuvo Video', medium: 'video', grade: 'core', unit: 'clip', localReach: true }),
  Object.freeze({ id: 'acuvo-video-ultra', name: 'Acuvo Video Ultra', medium: 'video', grade: 'ultra', unit: 'clip', localReach: false }),
  Object.freeze({
    id: 'acuvo-voice',
    name: 'Acuvo Voice',
    medium: 'voice',
    grade: 'sole',
    unit: 'line',
    /**
     * ── ⚠️⚠️ `speak` IS NOT THIS ENGINE, AND ASSUMING IT WAS WOULD MISPRICE IT ─
     *
     * The obvious wiring is `speak` → "Acuvo Voice", and it is wrong. The
     * catalogue's Acuvo Voice is **chatterbox-tts**: clone a voice from a few
     * seconds of audio, then speak in it, measured at $0.00167 a line. What
     * `lib/media.mjs` actually calls is `MODAL_TTS_URL` running **Kokoro**
     * (Apache-2.0) — a fixed-voice reader that clones nothing.
     *
     * They are different models doing different jobs, so mapping one onto the
     * other would have quoted a cloning price for a capability that cannot
     * clone. `speak` therefore keeps its own unbranded default and naming
     * `acuvo-voice` is refused as unreachable, with the difference spelled out.
     * ⭐ This is the one finding in the lane I would not have got from reading
     * either catalogue alone — it needed both files open at once.
     *
     * ── ⭐⭐ AND IT IS NOW HALF WRONG, WHICH IS WHY `reachedBy` EXISTS ────────
     *
     * Everything above is still true about `speak`. What changed is that the CLI
     * GREW the cloning verb: `clone_voice` (avatar-run.mjs, 2026-08-22) drives
     * the real chatterbox service on our own GPU. So "Acuvo Voice is not
     * reachable from Acuvo Code" became FALSE while "speak cannot clone" stayed
     * TRUE — two different sentences that one boolean was being asked to carry.
     */
    localReach: true,
  }),
  /**
   * ⭐ REACHABLE SINCE 2026-08-22 via `talking_head`. The comment this replaces
   * read "this package has no face module", which was true when it was written
   * and false the day `avatar.mjs` landed.
   */
  Object.freeze({ id: 'acuvo-face', name: 'Acuvo Face', medium: 'face', grade: 'sole', unit: 'second', localReach: true }),
]);

/**
 * ── ⭐⭐⭐ WHICH VERB REACHES WHICH ENGINE, AND WHAT SWITCHES IT ON ─────────
 *
 * ⚠️⚠️ MEASURED 2026-08-25: `list_engines` — the one verb whose entire job is
 * answering *"what can I do and what will it cost"* — printed **"not in the
 * CLI"** against `acuvo-video`, `acuvo-voice` and `acuvo-face`, three days after
 * `generate_video`, `clone_voice` and `talking_head` shipped and were fixed
 * twice. The frozen booleans above were written on 2026-08-16 and nothing made
 * them wrong out loud when the verbs arrived. A stale honesty check reads
 * exactly like an honest one, which is what makes it expensive.
 *
 * ⭐ SO REACH IS TWO FACTS, NOT ONE, AND A BOOLEAN COULD ONLY EVER HOLD ONE:
 *
 *   `localReach` — does a code path exist AT ALL in this package? A fact about
 *                  the software. `acuvo-image-ultra` and `acuvo-video-ultra` are
 *                  false and stay false: they are rented models behind a gateway
 *                  render endpoint that still does not exist.
 *   `reachedBy`  — WHICH verb, and which environment variable turns it on. A
 *                  fact about this INSTALL, which is why it cannot be frozen
 *                  into a constant.
 *
 * ⚠️ AND `verb` IS LOAD-BEARING, not decoration. `speak` asking for
 * `acuvo-voice` must still be refused — that engine is chatterbox cloning and
 * `speak` runs Kokoro, so accepting it would quote a cloning price for something
 * that cannot clone. The engine IS reachable; it is reachable by a DIFFERENT
 * VERB, and that is the sentence the user needs.
 */
export const ENGINE_REACHED_BY = Object.freeze({
  'acuvo-image': Object.freeze({ verb: 'generate_image', gate: null }),
  'acuvo-video': Object.freeze({ verb: 'generate_video', gate: 'video' }),
  'acuvo-voice': Object.freeze({ verb: 'clone_voice', gate: 'voiceClone' }),
  'acuvo-face': Object.freeze({ verb: 'talking_head', gate: 'face' }),
});

export const CREATIVE_MEDIA = Object.freeze(['image', 'video', 'voice', 'face']);

export function engineById(id) {
  return CREATIVE_ENGINES.find((e) => e.id === id) ?? null;
}

export function enginesFor(medium) {
  return CREATIVE_ENGINES.filter((e) => e.medium === medium);
}

/**
 * ⭐ THE ENFORCEMENT OF "UNLOCKED, NEVER DEFAULTED": there is deliberately no
 * argument that makes this return an `ultra` engine. If you want Ultra you name
 * Ultra, everywhere, always.
 */
export function defaultEngineFor(medium) {
  return CREATIVE_ENGINES.find((e) => e.medium === medium && e.grade !== 'ultra') ?? null;
}

/**
 * ── ⭐ WHAT A HUMAN AND A MODEL ARE BOTH ALLOWED TO TYPE ────────────────────
 *
 * A model writes `"engine": "ultra"` and a person types `--engine premium`. Both
 * mean the same thing and neither is the id. Accepting the shorthands costs one
 * lookup table and saves a refusal that reads like a spelling test.
 *
 * ⚠️ `basic` IS ACCEPTED BECAUSE ROMAN USES THAT WORD — *"basic or premium"* —
 * and the product word is `core`. A vocabulary the person who specified the
 * feature would fail is not a vocabulary.
 */
const SHORTHAND = Object.freeze({
  core: 'core', basic: 'core', standard: 'core', default: 'core',
  ultra: 'ultra', premium: 'ultra', best: 'ultra', pro: 'ultra',
});

/**
 * Resolve what the caller asked for into exactly one engine.
 *
 * @returns {{ ok: true, engine: object, named: boolean }
 *          |{ ok: false, code: 'unknown_engine', error: string }}
 *   `named` says whether a HUMAN OR MODEL CHOSE IT, as opposed to it being the
 *   default. Every spend decision downstream needs to know that, because
 *   "the user asked for the expensive one" and "we picked the expensive one"
 *   are the two sides of the rule this file exists to enforce.
 */
export function resolveEngineChoice(medium, requested) {
  const options = enginesFor(medium);
  if (options.length === 0) {
    return { ok: false, code: 'unknown_engine', error: `there are no ${medium} engines` };
  }

  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) {
    const engine = defaultEngineFor(medium);
    return { ok: true, engine, named: false };
  }

  const lower = raw.toLowerCase();
  const grade = SHORTHAND[lower];
  if (grade) {
    const byGrade = options.find((e) => e.grade === grade)
      // ⭐ A medium with ONE engine (voice, face) answers `--engine basic` with
      // that engine rather than a refusal. "core" on a single-engine medium is
      // not ambiguous, it is emphatic.
      ?? (options.length === 1 ? options[0] : null);
    if (byGrade) return { ok: true, engine: byGrade, named: true };
    return {
      ok: false,
      code: 'unknown_engine',
      error: `there is no ${grade} ${medium} engine. ${namesSentence(options)}`,
    };
  }

  const byId = options.find((e) => e.id.toLowerCase() === lower)
    ?? options.find((e) => e.name.toLowerCase() === lower);
  if (byId) return { ok: true, engine: byId, named: true };

  /**
   * ⚠️ NAMING THE OTHER MEDIUM'S ENGINE IS ITS OWN MISTAKE AND GETS ITS OWN
   * SENTENCE. `speak` with `engine: "acuvo-image"` is a wiring bug in whatever
   * called it, and "unknown engine" would send the reader looking for a typo
   * that is not there.
   */
  const elsewhere = engineById(lower) ?? CREATIVE_ENGINES.find((e) => e.name.toLowerCase() === lower);
  if (elsewhere) {
    return {
      ok: false,
      code: 'unknown_engine',
      error: `${elsewhere.name} is a ${elsewhere.medium} engine and this is a ${medium} verb. ${namesSentence(options)}`,
    };
  }

  return {
    ok: false,
    code: 'unknown_engine',
    error: `"${raw}" is not an Acuvo ${medium} engine. ${namesSentence(options)}`,
  };
}

function namesSentence(options) {
  return `The ${options.length === 1 ? 'only one is' : 'choices are'}: ${options.map((e) => e.id).join(', ')}.`;
}

/* ───────────────────────────── PRICES: ASK, DO NOT KNOW ─────────────────── */

/**
 * ── ⭐ WHERE THE ANSWER COMES FROM, AND WHERE IT IS KEPT ────────────────────
 *
 * The gateway URL already lives on the account (`account.mjs`), and it is the
 * chat-completions endpoint. The engines endpoint is its sibling. Deriving it
 * rather than adding a second configurable URL means there is exactly one host
 * an account can point at — a second one would be a second thing to get wrong,
 * and `account.mjs` argues at length about why that host is a deployment knob
 * and not a free-form target.
 */
/**
 * ── 🚪⭐⭐⭐ THE SAME DERIVATION, FOR THE RENDERER ──────────────────────────
 *
 * ⚠️ MEASURED 2026-08-26. `acuvo --design page.html` works and is good — on a
 * deliberately weak page it reported *"unreadable text (contrast 1.14:1, needs
 * 4.5)"* — but ONLY after `RENDER_AUDIT_URL` and `MODAL_VIDEO_SECRET` were
 * exported from our own env. Those are OUR internal Modal credentials, so for
 * every paying customer `--design` printed "no render service is configured"
 * and stopped.
 *
 * ⭐ The capability was never missing; the door was. The gateway had exactly
 * three route groups — chat, device, engines — which is the identical shape of
 * the bug this file's own header records about `/engines`.
 */
/**
 * ⚠️ ONE DERIVATION, FOUR DOORS. `renderEndpoint` and `enginesEndpoint` were
 * byte-identical apart from the last path segment, and adding `speak` and
 * `transcribe` by the same copy-paste would have made four places that each
 * decide, separately, what "the gateway" means. They must never disagree about
 * the host, so they are not allowed to state it separately.
 */
function gatewaySibling(gatewayUrl, leaf) {
  const base = String(gatewayUrl ?? '').trim();
  if (!base) return null;
  if (base.endsWith('/chat/completions')) return `${base.slice(0, -'/chat/completions'.length)}/${leaf}`;
  return `${base.replace(/\/$/, '')}/${leaf}`;
}

export function renderEndpoint(gatewayUrl) {
  return gatewaySibling(gatewayUrl, 'render');
}

export function enginesEndpoint(gatewayUrl) {
  return gatewaySibling(gatewayUrl, 'engines');
}

/**
 * ── 🚪⭐⭐⭐ AND THE SAME AGAIN FOR THE TWO VOICE DIRECTIONS ─────────────────
 *
 * ⚠️ MEASURED 2026-08-26. `--say` and `--task-audio` both resolve through
 * `mediaConfig()`, which hands out a baked-in Modal URL and then gates it on
 * `MODAL_VIDEO_SECRET` — OUR credential. So `voiceConfig()` reported
 * `canSpeak: false, canListen: false` for every paying customer, and both flags
 * printed "not configured on this machine" naming a variable they could never
 * usefully set.
 *
 * ⭐ Same shape as `/engines` and `/render` before them. The capability was
 * finished and the door was missing.
 */
export function speakEndpoint(gatewayUrl) {
  return gatewaySibling(gatewayUrl, 'speak');
}

export function transcribeEndpoint(gatewayUrl) {
  return gatewaySibling(gatewayUrl, 'transcribe');
}

/**
 * ── 🚪⭐⭐⭐ AND THE THREE THE MODEL REACHES FOR, WHICH THE FLAGS NEVER DID ──
 *
 * ⚠️ MEASURED 2026-08-26. The previous pass shipped `render`, `speak` and
 * `transcribe` — the three HUMAN-typed flags — and stopped there on purpose:
 * `make_document`, `read_document` and `read_table` are MODEL-facing tools with
 * no gateway route, so making their offer account-aware would have handed a
 * customer's agent three verbs that could only fail. Building the doors first is
 * what lets `mediaToolSchemas` gate PER TOOL instead of on one global boolean.
 *
 * ⚠️ THE LEAVES ARE HYPHENATED BECAUSE THE ROUTE DIRECTORIES ARE. `doc-read` and
 * `table-read`, not `docRead` — a leaf that disagrees with `app/api/cli/v1/<dir>`
 * is a 404 that looks exactly like a service being down.
 */
export function documentEndpoint(gatewayUrl) {
  return gatewaySibling(gatewayUrl, 'document');
}

export function docReadEndpoint(gatewayUrl) {
  return gatewaySibling(gatewayUrl, 'doc-read');
}

export function tableReadEndpoint(gatewayUrl) {
  return gatewaySibling(gatewayUrl, 'table-read');
}

/**
 * ⭐ THE MEDIA-CHAIN DOOR (2026-09-28) — captions, dubbing, long video → shorts.
 * Gateway-only: the chain spends FAL and OpenRouter money, whose keys live on
 * the server, so there is no "direct" local-worker leg for it at all.
 */
export function mediaChainEndpoint(gatewayUrl) {
  return gatewaySibling(gatewayUrl, 'media-chain');
}

/**
 * ⚠️ THE CACHE LIVES UNDER HOME WITH THE CREDENTIAL, NOT IN THE WORKSPACE, AND
 * THE REASON IS THE SAME ONE `account.mjs` gives: `WRITE_FORBIDDEN_ROOTS` does
 * not cover `.acuvo/`, so an agent CAN write a workspace file. A price list the
 * agent can write is a price list the agent can lower — and this one is used to
 * decide whether a render may proceed. Nothing in `lib/tools.mjs` can reach a
 * path outside the workspace root, by construction and already tested, so under
 * HOME it is out of the agent's hands.
 */
export function cataloguePath(env = process.env, home = homedir()) {
  return join(accountDir(env, home), 'engines.json');
}

/**
 * ── ⚠️⚠️ HOW LONG A PRICE MAY BE USED TO *REFUSE* SOMEBODY ─────────────────
 *
 * Not how long it may be SHOWN — a shown price is stamped with its age and the
 * reader can judge it. This is how stale an answer may be and still be allowed
 * to stop a render.
 *
 * ⭐ FIVE MINUTES, AND THE ASYMMETRY IS DELIBERATE. This repo's own rule is
 * that **a check which fails correct work is worse than no check** (four
 * instances in one day, 2026-08-16). A user who tops up and is refused from a
 * cached zero balance is exactly that failure. Five minutes is short enough
 * that a top-up is never blocked for long, and long enough that a session of
 * renders does not re-ask on every call.
 *
 * ⚠️ AND AN OLDER ANSWER NEVER REFUSES — it does not "probably" refuse or
 * "warn and refuse". It is shown with its age and the render proceeds, because
 * the gateway is the thing that actually charges and it is the authority. This
 * client's job is to save a wasted round, not to be the enforcement.
 */
export const CATALOGUE_REFUSAL_TTL_MS = 5 * 60 * 1000;

/** How long the fetch may take before the answer is simply "unavailable". */
export const CATALOGUE_TIMEOUT_MS = 8_000;

/**
 * Read whatever the last successful ask returned.
 *
 * ⚠️ NEVER THROWS, for the reason `readAccount` never throws: a corrupt cache
 * must degrade to "prices unavailable" and let the run continue. Crashing a
 * render because a JSON file has a stray byte would be a worse failure than the
 * one it is reporting, and one the user cannot diagnose.
 */
export function readCachedCatalogue(env = process.env, home = homedir()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cataloguePath(env, home), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.engines)) return null;
  const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : null;
  if (fetchedAt === null) return null;
  return {
    fetchedAt,
    tier: typeof parsed.tier === 'string' ? parsed.tier : null,
    creditsRemaining: Number.isFinite(parsed.creditsRemaining) ? parsed.creditsRemaining : null,
    engines: parsed.engines,
  };
}

export function writeCachedCatalogue(payload, env = process.env, home = homedir()) {
  try {
    mkdirSync(accountDir(env, home), { recursive: true });
    writeFileSync(cataloguePath(env, home), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    // ⚠️ A cache that cannot be written is not an error the user needs to act
    // on — the next call simply asks again. Reporting it would train people to
    // ignore the messages that matter.
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * ── ⭐⭐ THE ASK ────────────────────────────────────────────────────────────
 *
 * `GET <gateway>/engines`, `Authorization: Bearer <acuvo account token>`.
 * Expected shape, and every field of it is the SERVER's to decide:
 *
 *   { tier: 'starter', creditsRemaining: 1840,
 *     engines: [ { id, credits, reachable, minTier } ] }
 *
 * ⚠️⚠️ AND THE ENDPOINT DOES NOT EXIST YET — SAY IT OUT LOUD RATHER THAN
 * IMPLY IT. Measured 2026-08-16: `acuvo-gateway/lib/handler.mjs` exports one
 * `createHandler` that proxies chat completions and does no path routing at
 * all, and `console/app/api/cli/v1/` contains only `chat/`. So today this
 * function returns `unavailable` for everybody, the CLI prints "prices
 * unavailable", and no verb is refused on entitlement.
 *
 * ⭐ THAT IS THE CORRECT FAILURE AND IT IS WHY THE CLIENT IS SHAPED THIS WAY.
 * The alternative — shipping the numbers inside the package so the picker looks
 * finished — is precisely the thing the header forbids, and it would have to be
 * unshipped from every installed copy later. A client that degrades honestly is
 * finished work; the endpoint is a separate lane's file and is named here so
 * nobody has to go looking for what is missing.
 */
export async function fetchCatalogue({
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  now = () => Date.now(),
  cache = true,
} = {}) {
  const account = readAccount(env, home);
  /**
   * ⚠️ NO ACCOUNT MEANS NO QUESTION TO ASK, not a failed request. There is
   * nothing to authenticate with and no tenant whose prices could be returned —
   * and firing an unauthenticated request would produce a 401 that reads like a
   * broken service rather than "you are not signed in".
   */
  if (!account) {
    return { ok: false, reason: 'no-account', error: 'not signed in to an Acuvo account, so there is nothing to price against' };
  }

  const url = enginesEndpoint(account.gatewayUrl);
  if (!url) return { ok: false, reason: 'no-endpoint', error: 'this account has no gateway URL' };

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${account.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? `no answer in ${CATALOGUE_TIMEOUT_MS / 1000}s` : String(err?.message || err);
    return { ok: false, reason: 'unreachable', error: `could not reach ${url}: ${why}` };
  }

  if (!res?.ok) {
    return { ok: false, reason: 'http', error: `${url} answered HTTP ${res?.status ?? '?'}` };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'not-json', error: `${url} answered with something that was not JSON` };
  }

  /**
   * ⚠️ A 200 THAT IS NOT A CATALOGUE IS A FAILURE, NOT AN EMPTY CATALOGUE.
   * `res.ok` answers a question about the HTTP conversation and never about
   * whether the work happened — the lesson imagegen.mjs learned by writing a
   * zero-byte PNG and calling it a render. An empty engine list here would
   * present as "you can reach nothing", which is a refusal we would have
   * invented ourselves.
   */
  if (!Array.isArray(json?.engines) || json.engines.length === 0) {
    return { ok: false, reason: 'empty', error: `${url} returned no engines` };
  }

  const payload = {
    fetchedAt: now(),
    tier: typeof json.tier === 'string' ? json.tier : null,
    creditsRemaining: Number.isFinite(json.creditsRemaining) ? json.creditsRemaining : null,
    engines: json.engines,
  };
  if (cache) writeCachedCatalogue(payload, env, home);
  return { ok: true, catalogue: payload };
}

/**
 * ── ⭐ THE THREE HONEST STATES, AND THERE IS NO FOURTH ──────────────────────
 *
 *   live    — asked just now, this is the truth
 *   cache   — a previous answer, and its AGE travels with it
 *   unknown — nobody has ever answered; prices are unavailable and we say so
 *
 * ⚠️ `fetchImpl` DEFAULTS TO `null`, WHICH MEANS "DO NOT GO TO THE NETWORK".
 * That default is what keeps a render verb from adding a round trip before
 * every picture: `generate_image` reads the cache and never asks, while
 * `list_engines` — the verb whose entire job is answering "what will this cost
 * me" — passes a real `fetch`. The question is asked by the verb that exists to
 * ask it, and the expensive verbs read the answer.
 */
export function loadCatalogue({ env = process.env, home = homedir(), now = () => Date.now() } = {}) {
  const cached = readCachedCatalogue(env, home);
  if (!cached) return { source: 'unknown', ageMs: null, catalogue: null };
  return { source: 'cache', ageMs: Math.max(0, now() - cached.fetchedAt), catalogue: cached };
}

/**
 * ── ⭐⭐⭐ THE PLAN WAS ALREADY ON THE WIRE AND ONLY THE PICTURES READ IT ─────
 *
 * `cost-units.mjs` says the coding meter is *"one field in one server response"*
 * away from firing, and names the field: a `plan` on the login response.
 *
 * ⚠️⚠️ THE GATEWAY HAS BEEN SENDING IT FOR WEEKS, JUST THROUGH THE OTHER DOOR.
 * `/engines` returns `{ tier, creditsRemaining, engines }`; `fetchCatalogue`
 * caches all three under HOME, and `checkEngine` already REFUSES a render on
 * `tier` — `acuvo engines` prints `plan: free` today and correctly turns down
 * video as "needs starter". Measured on this machine 2026-09-06,
 * `~/.acuvo/engines.json`: `"tier": "free"`. So the creative half of the product
 * has been metered against a real plan the whole time, and the coding half —
 * the one the 85% margin floor is computed for — has been unmetered because
 * nothing outside this file ever read the field.
 *
 * ⭐ THIS IS THE READ, AND IT IS ALL IT IS. No fetch, no new endpoint, no new
 * cache: one accessor over an answer already on disk, so the meter's plan source
 * and the renderer's entitlement source are the same fact rather than two.
 *
 * ── ⚠️ WHY IT EXPIRES, AND WHY EXPIRY MEANS *UNMETERED* ─────────────────────
 *
 * An allowance exists to REFUSE, and the only way this can be wrong in the
 * expensive direction is by refusing somebody who has upgraded. This file
 * already settles that asymmetry for prices — *"a check which fails correct work
 * is worse than no check"* — and the same rule decides it here: past the window
 * we return `''`, which resolves to UNMETERED. That is byte-for-byte today's
 * behaviour for every user, so a stale tier can never be a regression, only a
 * missed enforcement.
 *
 * ⚠️ THE WINDOW IS LONGER THAN `CATALOGUE_REFUSAL_TTL_MS` ON PURPOSE, and the
 * difference is what the two numbers govern. Five minutes is how stale a
 * CREDIT BALANCE may be — it moves with every render and a top-up must be seen
 * at once. A PLAN moves once a month at most, and it is re-read on every login
 * and every creative command.
 */
export const PLAN_FROM_CATALOGUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The account's plan id according to the gateway's last `/engines` answer, or
 * `''` when we do not know — never a guess.
 *
 * @returns {string}
 */
export function tierFromCatalogue({
  env = process.env,
  home = homedir(),
  now = () => Date.now(),
  maxAgeMs = PLAN_FROM_CATALOGUE_MAX_AGE_MS,
} = {}) {
  const cached = readCachedCatalogue(env, home);
  const tier = typeof cached?.tier === 'string' ? cached.tier.trim() : '';
  if (!tier) return '';
  const age = now() - cached.fetchedAt;
  /**
   * ⚠️ A NEGATIVE AGE IS ALSO UNKNOWN. A file stamped in the future is a clock
   * that moved or a file that was edited, and `pruneStale` in
   * `warm-provider.mjs` resolves the identical case the same way for the same
   * reason: unknown age must fail the safe way.
   */
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return '';
  return tier;
}

/** The server's row for one engine, or null when we have no catalogue at all. */
export function rowFor(catalogue, engineId) {
  if (!catalogue) return null;
  return catalogue.engines.find((e) => e?.id === engineId) ?? null;
}

/* ─────────────────────────────── THE REFUSALS ───────────────────────────── */

/**
 * ── ⚠️⚠️ "NOT ON YOUR PLAN" AND "OUT OF CREDITS" ARE OPPOSITE MESSAGES ─────
 *
 * They must never share a sentence, a remedy or a code, because the two things
 * the reader should do next are different and one of them costs money:
 *
 *   entitlement — the engine is not sold on this tier. Buying credits changes
 *                 NOTHING. The remedy is a different plan, or the core engine.
 *   balance     — the engine IS yours. You simply have none left this month.
 *                 The remedy is a top-up, or waiting for the reset.
 *
 * ⭐ Telling someone to top up when the answer is a plan gate takes their money
 * and leaves them exactly as blocked — which is the failure worth writing a
 * test against, and `refusals-do-not-share-a-remedy` is that test.
 *
 * Each refusal carries a machine `code` so a caller never has to match on
 * English, and a `remedy` so the sentence a human reads cannot drift from the
 * action a program would take.
 */
export function refuseNotOnPlan({ engine, tier, minTier, alternative = null }) {
  const alt = alternative
    ? ` ${alternative.name} is on your plan and does its job.`
    : '';
  return {
    ok: false,
    code: 'engine_not_on_plan',
    remedy: 'change-plan',
    error: `${engine.name} is not included in the ${tier ?? 'current'} plan — it starts at ${minTier ?? 'a higher tier'}.`
      + ` Nothing was generated and nothing was charged.${alt}`
      + ' This is what your subscription includes, so buying more will not unlock it.',
  };
}

export function refuseOutOfCredits({ engine, credits, remaining, ageMs = null, alternative = null }) {
  const alt = alternative
    ? ` ${alternative.name} costs less per ${alternative.unit}.`
    : '';
  /**
   * ⚠️ THE BALANCE IS STAMPED WITH ITS AGE. A number read from a cache is a
   * number that was true a moment ago, and somebody who topped up ten seconds
   * ago has to be able to see why we still said no.
   */
  const asOf = ageMs === null ? '' : ` (balance as of ${describeAge(ageMs)} — run \`acuvo engines\` to re-check)`;
  return {
    ok: false,
    code: 'insufficient_credits',
    remedy: 'add-credits',
    error: `${engine.name} costs ${credits} credits per ${engine.unit} and this account has ${remaining}${asOf}.`
      + ` Nothing was generated and nothing was charged. Your subscription includes this engine — you have run the balance down.${alt}`,
  };
}

/**
 * ── ⭐ THE THIRD REFUSAL, AND IT IS NOT A BUSINESS ONE ──────────────────────
 *
 * "This binary has no path to that engine." It outranks the other two and is
 * checked FIRST, which is the opposite of what I first wrote and the reason is
 * worth keeping: telling a Growth customer "not on your plan" for an engine
 * that runs for NOBODY is a false explanation, and they would go and buy an
 * upgrade that changes nothing. A fact about the software must not be dressed
 * up as a fact about the account.
 *
 * ⚠️ It also costs no network call, so the cheapest check is also the one that
 * cannot be wrong.
 */
export function refuseUnreachableHere({ engine, detail }) {
  return {
    ok: false,
    code: 'engine_unreachable_here',
    remedy: 'use-another-surface',
    error: `${engine.name} cannot be run from Acuvo Code yet: ${detail}`
      + ' Nothing was generated and nothing was charged. This is a gap in this tool, not in your account.',
  };
}

/** Why each engine with NO code path at all has none. */
const UNREACHABLE_DETAIL = Object.freeze({
  'acuvo-image-ultra': 'it is a rented model behind the Acuvo gateway, and this package has no render endpoint to call — only the browser Studio reaches it today.',
  'acuvo-video-ultra': 'it is a rented premium video model behind the Acuvo gateway, and this package has no render endpoint to call — the core `acuvo-video` engine runs on our own GPU and is reachable from `generate_video`.',
});

/**
 * ── ⭐⭐ THE ONE PLACE THAT ANSWERS "WOULD THIS RUN, HERE, TODAY" ───────────
 *
 * @returns {{state: 'ok'}
 *          |{state: 'no-path', detail: string}
 *          |{state: 'wrong-verb', verb: string, detail: string}
 *          |{state: 'not-configured', verb: string, gate: string, detail: string}}
 *
 * ⚠️ THREE WAYS TO BE UNREACHABLE, AND THEY ARE THREE DIFFERENT NEXT ACTIONS —
 * the same argument this file already makes about plan-versus-balance. "Nothing
 * can run it" is a gap in the product; "another verb runs it" is a redirect;
 * "you have not set the secret" is one line in a file. Collapsing them into
 * "not in the CLI" sent a user looking for a feature that was sitting right
 * there, switched off.
 */
export function engineReach(engine, { env = process.env, verb = null, configImpl = avatarConfig } = {}) {
  if (!engine.localReach) {
    return { state: 'no-path', detail: UNREACHABLE_DETAIL[engine.id] ?? 'it is not wired into this package.' };
  }
  const route = ENGINE_REACHED_BY[engine.id];
  if (!route) return { state: 'ok' };

  if (verb && verb !== route.verb) {
    /**
     * ⭐ THE SENTENCE THAT USED TO BE A LIE. It said the engine was not in the
     * CLI; it is, and naming the verb turns a dead end into an instruction.
     * ⚠️ The `speak`/`acuvo-voice` wording is kept verbatim because the MODEL
     * difference — cloning versus Kokoro — is the part that stops a mispriced
     * call, and it is not derivable from the verb names alone.
     */
    const extra = engine.id === 'acuvo-voice' && verb === 'speak'
      ? ' It is voice CLONING (chatterbox); `speak` runs the plain fixed-voice TTS endpoint (Kokoro) instead — a different model, so it is not offered under this name.'
      : '';
    return {
      state: 'wrong-verb',
      verb: route.verb,
      detail: `${engine.name} IS reachable from Acuvo Code, but by \`${route.verb}\`, not by \`${verb}\`.${extra}`,
    };
  }

  if (route.gate && !configImpl(env)[route.gate]) {
    /**
     * ── ⚠️⚠️⭐ THIS SENTENCE TOLD A PAYING CUSTOMER TO SET *OUR* CREDENTIAL ──
     *
     * `ACUVO_MEDIA_SECRET` / `MODAL_VIDEO_SECRET` is the shared secret for OUR
     * Modal workers. A customer cannot obtain it, will never obtain it, and
     * `doctor.mjs` already records what happens when this package forgets that:
     * *"sent a customer who had already paid us off to buy a competitor's
     * key"*. That file fixed its own media advice — *"run `acuvo login` — a
     * plan turns on <verb> through the gateway with nothing to configure"* —
     * and this one kept the old sentence.
     *
     * ⚠️⚠️ AND COPYING THE DOCTOR'S FIX WOULD HAVE BEEN A *WORSE* LIE, which is
     * the finding. `media.mjs`'s `mediaRoutes` opens SIX gateway doors —
     * render, speak, transcribe, document, doc-read, table-read — and
     * `creative-engines.mjs` derives exactly those leaves. **There is no
     * `video`, `voice-clone` or `avatar` leaf.** `avatar-run.mjs`, which serves
     * all three of these verbs, reads `avatarConfig(env)` and nothing else: it
     * has no account path at all. So `acuvo login` genuinely does not open
     * them, and telling a customer it would is advice that cannot work.
     *
     * ⭐ SO THE HONEST SENTENCE NAMES BOTH AUDIENCES AND LIES TO NEITHER: an
     * operator running their own Modal workers sets the secret; a customer on a
     * plan is told the truth, which is that this door is not built yet and the
     * browser Studio is where the engine lives today. Writing the gateway
     * client here instead would be a client for an endpoint that cannot be
     * called once — the thing this file's own header refuses to ship.
     */
    return {
      state: 'not-configured',
      verb: route.verb,
      gate: route.gate,
      detail: `${engine.name} runs on our own GPU through \`${route.verb}\`, and this install cannot reach it. `
        + 'If you run the Modal workers yourself, set ACUVO_MEDIA_SECRET (or MODAL_VIDEO_SECRET) — the endpoint '
        + 'address ships with this package, so the secret is the only thing missing. '
        + '⚠️ If you are on an Acuvo plan there is nothing you can set: unlike speech, transcription and documents, '
        + 'this engine has no gateway route yet, so signing in does not open it. Use it in the browser Studio for now.',
    };
  }
  return { state: 'ok' };
}

/**
 * ── ⭐⭐ THE ONE GATE EVERY CREATIVE VERB GOES THROUGH ──────────────────────
 *
 * Order, and every step of it is argued above:
 *   1. is it an engine at all          — free, local, cannot be wrong
 *   2. can this binary run it           — free, local, outranks the account
 *   3. does the plan include it         — needs a FRESH answer, else skipped
 *   4. is there a balance for it        — needs a FRESH answer, else skipped
 *
 * ⚠️ STEPS 3 AND 4 ARE SKIPPED WHEN THE ANSWER IS OLD OR ABSENT, and that is
 * the fail-SAFE direction: the gateway charges, so it refuses. A client that
 * blocks a paid-up customer from a stale cache has failed correct work, which
 * this repo holds to be worse than not checking at all.
 *
 * @returns {{ ok: true, engine, named: boolean, credits: number|null,
 *             priceKnown: boolean, source: string, ageMs: number|null }
 *          |{ ok: false, code: string, remedy?: string, error: string }}
 */
export function checkEngine(medium, requested, { env = process.env, home = homedir(), now = () => Date.now(), verb = null } = {}) {
  const choice = resolveEngineChoice(medium, requested);
  if (!choice.ok) return choice;
  const { engine, named } = choice;

  /**
   * ⚠️ STEP 2 NOW ASKS THE ENVIRONMENT, NOT A FROZEN BOOLEAN. It is still free
   * and local — `avatarConfig` reads env and nothing else — and it still
   * outranks the account, for the reason `refuseUnreachableHere` gives: a fact
   * about the software dressed as a fact about the account sends people to buy
   * an upgrade that changes nothing.
   */
  const reach = engineReach(engine, { env, verb });
  if (reach.state !== 'ok') {
    return refuseUnreachableHere({ engine, detail: reach.detail });
  }

  const { source, ageMs, catalogue } = loadCatalogue({ env, home, now });
  const row = rowFor(catalogue, engine.id);
  const fresh = source === 'cache' && ageMs !== null && ageMs <= CATALOGUE_REFUSAL_TTL_MS && row !== null;
  const credits = Number.isFinite(row?.credits) ? row.credits : null;

  if (fresh) {
    const alternative = CREATIVE_ENGINES.find((e) => e.medium === medium && e.grade === 'core' && e.id !== engine.id) ?? null;
    if (row.reachable === false) {
      return refuseNotOnPlan({ engine, tier: catalogue.tier, minTier: row.minTier ?? null, alternative });
    }
    if (credits !== null && Number.isFinite(catalogue.creditsRemaining) && catalogue.creditsRemaining < credits) {
      return refuseOutOfCredits({ engine, credits, remaining: catalogue.creditsRemaining, ageMs, alternative });
    }
  }

  return { ok: true, engine, named, credits, priceKnown: credits !== null, source, ageMs };
}

/* ─────────────────────────────── THE LISTING ────────────────────────────── */

export function describeAge(ms) {
  if (!Number.isFinite(ms)) return 'an unknown time ago';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * ── ⭐⭐ "WHAT WILL THIS COST ME", ANSWERED BEFORE ANY MONEY MOVES ──────────
 *
 * ⚠️ EVERY QUANTITY IS "OR", NEVER "AND" — Roman: *"when you say 5 videos, and
 * however many images, users need to know their credits cover that amount, not
 * give both."* Each row says what the WHOLE balance buys if it all went on that
 * one engine, so the lines are alternatives. A comma between them would read as
 * "and" and promise several allowances that do not exist, which is why the word
 * "or" is printed in the header rather than left to the reader.
 *
 * ⚠️ AND A MISSING PRICE PRINTS AS `—`, NOT AS A GUESS. "prices unavailable" is
 * a state a user can act on; an invented number is one they cannot detect.
 */
export function formatEngineList({ source, ageMs, catalogue, fetchError = null, env = process.env } = {}) {
  const lines = [];

  if (source === 'live') lines.push('Engines — prices from your account, just now.');
  else if (source === 'cache') lines.push(`Engines — prices from your account, cached ${describeAge(ageMs)}.`);
  else {
    lines.push('Engines — ⚠ PRICES UNAVAILABLE.');
    lines.push(`  ${fetchError ?? 'nothing has ever answered, so no credit cost can be shown'}.`);
    lines.push('  The prices are your account\'s, not this package\'s — it asks the gateway rather than shipping a price list,');
    lines.push('  so that a re-price reaches you without an upgrade and nobody can edit their own bill.');
  }

  if (catalogue?.tier) {
    const bal = Number.isFinite(catalogue.creditsRemaining) ? `${catalogue.creditsRemaining} credits left` : 'balance unknown';
    lines.push(`  plan: ${catalogue.tier} · ${bal}`);
  }
  lines.push('');

  for (const medium of CREATIVE_MEDIA) {
    const options = enginesFor(medium);
    if (options.length === 0) continue;
    lines.push(`  ${medium}`);
    for (const engine of options) {
      const row = rowFor(catalogue, engine.id);
      const credits = Number.isFinite(row?.credits) ? row.credits : null;
      const price = credits === null ? '—' : `${credits} cr/${engine.unit}`;
      /**
       * ⚠️ THE STATUS COLUMN ANSWERS "WOULD THIS RUN", and it distinguishes the
       * three reasons it might not — plan, package, and default-vs-named —
       * because they are three different next actions.
       */
      /**
       * ⚠️⚠️ THIS COLUMN PRINTED "not in the CLI" FOR THREE ENGINES THAT WERE
       * WIRED. It read a boolean frozen on 2026-08-16 and nothing told it that
       * `generate_video`, `clone_voice` and `talking_head` had landed. The
       * status is now derived from `engineReach`, which asks the environment,
       * so it cannot go stale independently of the code it describes.
       */
      const reach = engineReach(engine, { env });
      let status;
      if (reach.state === 'no-path') status = 'not in the CLI';
      /**
       * ── ⚠️⚠️⭐ THIS COLUMN TOLD A PAYING CUSTOMER TO SET *OUR* CREDENTIAL ──
       *
       * It read `set ACUVO_MEDIA_SECRET` — the shared secret for OUR Modal
       * workers, which a customer cannot obtain and will never obtain. That is
       * the exact sentence `refuseUnreachableHere` above was corrected for, and
       * it survived HERE, four hundred lines away, in the command a new user
       * runs to find out what they can do. **A second copy of a fact does not
       * get fixed when the first one does** — this file's own footer note makes
       * the same point about the Ultra rows.
       *
       * ⭐ THREE WORDS CANNOT HOLD THE TRUTH, SO THEY POINT AT IT. The column
       * says what is true for everyone — this needs a worker you run yourself —
       * and the footnote below, derived from the same predicate, names both
       * audiences and lies to neither.
       */
      else if (reach.state === 'not-configured') status = 'needs your own worker';
      else if (row && row.reachable === false) status = `needs ${row.minTier ?? 'a higher plan'}`;
      else if (engine.grade === 'ultra') status = 'opt in by name';
      else if (ENGINE_REACHED_BY[engine.id]?.gate) status = `via \`${ENGINE_REACHED_BY[engine.id].verb}\``;
      else status = 'default';

      const many = credits !== null && Number.isFinite(catalogue?.creditsRemaining)
        ? `  (or ${Math.floor(catalogue.creditsRemaining / credits)} of these with the whole balance)`
        : '';
      lines.push(`    ${engine.id.padEnd(18)} ${price.padEnd(14)} ${status}${many}`);
    }
    lines.push('');
  }

  lines.push('  Every quantity above is ONE WAY to spend the whole balance — read them as "or", never "and".');

  /**
   * ── ⭐ THE FOOTNOTE THE STATUS COLUMN POINTS AT ────────────────────────────
   *
   * ⚠️ DERIVED FROM `engineReach`, exactly like the Ultra footer below and for
   * the reason that footer records: *"prose beside a derived value is just an
   * undeclared second opinion."* If these engines ever gain a gateway route,
   * this paragraph turns itself off.
   *
   * ⚠️ IT NAMES BOTH AUDIENCES BECAUSE THERE ARE TWO. An operator running the
   * Modal workers sets the secret and it works. A customer on a plan has
   * nothing they can set — `mediaRoutes` opens six gateway doors (render,
   * speak, transcribe, document, doc-read, table-read) and there is **no
   * `video`, `voice-clone` or `avatar` leaf**, so "run `acuvo --login`" would be
   * a worse lie than the one this replaces.
   */
  const unconfigured = CREATIVE_ENGINES.filter((e) => engineReach(e, { env }).state === 'not-configured');
  if (unconfigured.length > 0) {
    const names = unconfigured.map((e) => e.id).join(', ');
    lines.push('');
    lines.push(`  ⚠ ${names} run on our own GPU and this install cannot reach them.`);
    lines.push('    Running the Modal workers yourself? Set ACUVO_MEDIA_SECRET — the endpoint addresses ship');
    lines.push('    with this package, so the secret is the only missing piece.');
    lines.push('    On an Acuvo plan there is nothing you can set: unlike speech, transcription and documents,');
    lines.push('    these have no gateway route yet. Use them in the browser Studio for now.');
  }

  /**
   * ── ⚠️⚠️⭐ THIS FOOTER CONTRADICTED THE COLUMN TWO LINES ABOVE IT ───────────
   *
   * Driven 2026-09-07, `acuvo engines` printed `acuvo-image-ultra … not in the
   * CLI` and then, four lines later, *"pass --engine (CLI) or engine (tool) to
   * ask for one."* Both ultra engines carry `localReach: false` — deliberately,
   * and this file explains why at length: they are rented models behind our own
   * account and reaching them needs a gateway RENDER endpoint, which does not
   * exist. So the sentence promised, unconditionally, the one thing no user of
   * this package can do, in the same breath as saying so.
   *
   * ⭐ THE SAME DEFECT THIS FILE ALREADY RECORDS, RUNNING THE OTHER WAY. The
   * status column once printed "not in the CLI" for three engines that were
   * wired, because it read a frozen boolean; the cure was to derive it from
   * `engineReach`. The footer was left as prose and went stale in the opposite
   * direction. **Prose beside a derived value is just an undeclared second
   * opinion** — so it is derived from the same predicate now, and an Ultra that
   * gains a path turns this line back on without anyone remembering to.
   */
  const ultras = CREATIVE_ENGINES.filter((e) => e.grade === 'ultra');
  const runnable = ultras.filter((e) => engineReach(e, { env }).state !== 'no-path');
  if (runnable.length > 0) {
    lines.push('  An Ultra engine is never chosen for you: pass --engine (CLI) or engine (tool) to ask for one.');
  } else if (ultras.length > 0) {
    /**
     * ⚠️ PRICED IS NOT OFFERED, AND SAYING SO IS THE POINT. The rows stay —
     * they are your account's real prices and they tell you what an upgrade
     * buys — but a reader must not be sent hunting for a flag that does not
     * work. Naming the reason keeps it from reading as a bug in their install.
     */
    lines.push('  The Ultra rows are priced for your account but cannot be run from this package: they need a');
    lines.push('  gateway render endpoint, and there is not one yet. Nothing you can set will turn them on.');
  }
  return lines;
}

/**
 * ── ⭐ THE VERB, SO A MODEL CAN ASK THE SAME QUESTION A HUMAN CAN ───────────
 *
 * Without it the model's only way to find out what an engine costs is to spend
 * it, which is the one thing a budgeted agent must never have to do.
 */
export function listEnginesToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'list_engines',
      description: [
        'List the Acuvo creative engines this account can reach and what each one COSTS IN CREDITS,',
        'before you spend anything. Use it when the user asks what an image or a video will cost,',
        'when they ask for "the best" or "premium" quality, or before you choose a non-default engine.',
        'The prices come from the account, not from this package, so they may be unavailable — if they are,',
        'say so plainly rather than guessing a number.',
        'An Ultra engine is NEVER used unless the user asked for it by name.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          medium: {
            type: 'string',
            enum: ['image', 'video', 'voice', 'face', 'all'],
            description: 'Which kind of engine to list. Default "all".',
          },
        },
        required: [],
      },
    },
  };
}

/**
 * The `list_engines` implementation. Asks the gateway (this is the verb whose
 * job is asking), falls back to the cache, and says "unavailable" when there is
 * neither.
 */
export async function listEngines({
  medium = 'all',
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const live = await fetchCatalogue({ env, home, fetchImpl, now });
  let state;
  if (live.ok) {
    state = { source: 'live', ageMs: 0, catalogue: live.catalogue, fetchError: null };
  } else {
    const loaded = loadCatalogue({ env, home, now });
    state = { ...loaded, fetchError: live.error };
  }

  const wanted = medium === 'all' || !CREATIVE_MEDIA.includes(medium) ? CREATIVE_MEDIA : [medium];
  const engines = CREATIVE_ENGINES.filter((e) => wanted.includes(e.medium)).map((e) => {
    const row = rowFor(state.catalogue, e.id);
    const reach = engineReach(e, { env });
    return {
      id: e.id,
      name: e.name,
      medium: e.medium,
      grade: e.grade,
      unit: e.unit,
      credits: Number.isFinite(row?.credits) ? row.credits : null,
      /**
       * ⚠️ `runsFromTheCli` USED TO BE THE FROZEN BOOLEAN, so it answered "false"
       * for engines this binary had verbs for. It is now the live answer, and
       * `reachedBy` / `whyNot` carry the two things the model needs next: which
       * verb to call, and what to tell the user if it cannot.
       */
      runsFromTheCli: reach.state === 'ok',
      reachedBy: ENGINE_REACHED_BY[e.id]?.verb ?? null,
      ...(reach.state === 'ok' ? {} : { whyNot: reach.detail }),
      onYourPlan: row ? row.reachable !== false : null,
    };
  });

  return {
    ok: true,
    pricesFrom: state.source,
    pricesKnown: state.source !== 'unknown',
    ...(state.source === 'cache' ? { pricedAt: describeAge(state.ageMs) } : {}),
    ...(state.source === 'unknown' ? { whyNoPrices: state.fetchError ?? 'no account has ever answered' } : {}),
    tier: state.catalogue?.tier ?? null,
    creditsRemaining: Number.isFinite(state.catalogue?.creditsRemaining) ? state.catalogue.creditsRemaining : null,
    engines,
    note: 'Quantities are alternatives, not a combined allowance. An Ultra engine runs only when it is named.',
    text: formatEngineList({ ...state, env }).join('\n'),
  };
}

/* ───────────────────── THE RUN-LEVEL CHOICE (`--engine`) ─────────────────── */

/**
 * ── ⭐ `--engine` IS A DEFAULT FOR THE RUN, PER MEDIUM ──────────────────────
 *
 * `acuvo --engine acuvo-image-ultra "build the landing page"` says: when you
 * make an image this run, make it with that one. It is set per MEDIUM, so
 * choosing an image engine cannot quietly change what `speak` does.
 *
 * ⚠️ MODULE STATE, LIKE `imagesThisProcess` — and like it, with a reset seam,
 * because a per-run choice that leaks between test files is a test that passes
 * for the wrong reason.
 *
 * ⚠️ AND IT IS STILL "NAMED BY A HUMAN". A flag the user typed is exactly the
 * consent this file requires; what is forbidden is the SOFTWARE choosing Ultra.
 */
const runEngines = new Map();

export function setRunEngine(engineId) {
  const engine = engineById(String(engineId ?? '').trim().toLowerCase());
  if (!engine) return { ok: false, error: `"${engineId}" is not an Acuvo engine. Choices: ${CREATIVE_ENGINES.map((e) => e.id).join(', ')}.` };
  runEngines.set(engine.medium, engine.id);
  return { ok: true, engine };
}

export function runEngineFor(medium) {
  return runEngines.get(medium) ?? null;
}

export function resetRunEngines() {
  runEngines.clear();
}
