/**
 * ── ⭐ THE EXECUTION HALF OF THE MOAT VERBS ─────────────────────────────────
 *
 * `avatar.mjs` decides; this runs. Everything that makes a JUDGEMENT — is this
 * configured, is `running` a failure, is a `done` with no artifact a success —
 * lives next door and is tested without a GPU. What is here is transport, files
 * and a clock.
 *
 * ⚠️ THE ONE RULE BOTH HALVES SHARE: a failure is a RETURNED VALUE, never a
 * throw. A GPU that is down must read as a tool result the model can reason
 * about and recover from, not a stack trace that ends somebody's session.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveInWorkspace } from './workspace.mjs';
import {
  avatarConfig, readStart, readPoll, readImmediate, keepPolling, whyUnavailable,
  estimateJobUsd, needsApproval, APPROVAL_THRESHOLD_USD,
  DEFAULT_JOB_BUDGET_MS, POLL_INTERVAL_MS,
} from './avatar.mjs';
import { chargeGpu } from './budget.mjs';
/**
 * ── ⚠️⚠️ DECLARED, NOT IMPORTED — AND THE REASON IS MEASURED ─────────────────
 *
 * This was `import { SPEND_APPROVAL_ARG } from './media-pipeline.mjs'`, and it
 * threw at CALL time: `ReferenceError: SPEND_APPROVAL_ARG is not defined`, from
 * `cloneVoice` — because the constant is a COMPUTED PROPERTY KEY in a
 * destructured default parameter (`{ …, [SPEND_APPROVAL_ARG]: approved } = {}`),
 * so it is read on every invocation.
 *
 * ⚠️ IT DID NOT REPRODUCE UNDER NODE. I loaded the module directly and drove all
 * 77 tools through `executeToolCall` — in both import orders — and got zero
 * failures. It only fails under vitest, where a `.mjs` is pulled across the
 * package boundary from a `.ts` test, and the imported binding is not
 * initialised by the time the computed key is evaluated. That is a bundler
 * interop difference, not a bug in either file's logic — which is exactly why it
 * survived: `npm test` in this package is green and the guard that catches it
 * lives in the OTHER repo.
 *
 * ⭐ SO IT IS DECLARED LOCALLY, which is the pattern `avatar.mjs` already uses
 * for this same constant and for a related reason (it avoids the
 * `media-pipeline → imagegen → creative-engines → avatar` cycle). Duplicating a
 * 15-character string beats a cross-module binding that only resolves under one
 * of two loaders. `avatar-approval-arg-matches-media-pipeline` pins them equal,
 * and now covers this copy too.
 */
const SPEND_APPROVAL_ARG = 'approve_spend';
import { runFalJob, falUnavailable } from './fal.mjs';

/** Inputs are voice samples and portraits, not archives. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

function loadAsset(root, path, what) {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, error: `${what} is required` };
  const target = resolveInWorkspace(root, path, 'read');
  if (!target.ok) return { ok: false, error: target.reason };
  let buf;
  try { buf = readFileSync(target.absolute); } catch (err) {
    return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` };
  }
  if (buf.length > MAX_INPUT_BYTES) {
    return { ok: false, error: `${target.relative} is ${(buf.length / 1e6).toFixed(1)} MB, over the ${MAX_INPUT_BYTES / 1e6} MB input limit` };
  }
  return { ok: true, relative: target.relative, b64: buf.toString('base64') };
}

function writeArtifact(root, rawPath, base64, dryRun) {
  const target = resolveInWorkspace(root, rawPath, 'write');
  if (!target.ok) return { ok: false, error: target.reason };
  const buf = Buffer.from(base64, 'base64');
  if (!dryRun) {
    mkdirSync(dirname(target.absolute), { recursive: true });
    writeFileSync(target.absolute, buf);
  }
  return { ok: true, path: target.relative, bytes: buf.length, dryRun };
}

/**
 * POST JSON. Never throws.
 *
 * ⚠️ THE TIMEOUT IS PER REQUEST, NOT PER JOB. A start call answers in seconds
 * even when the render behind it runs for minutes; giving this the whole job
 * budget would turn an unreachable endpoint into a twelve-minute hang.
 */
/**
 * ── ⚠️⚠️ 30 SECONDS WAS SHORTER THAN A COLD START ──────────────────
 *
 * Measured 2026-08-23 against the live services: a COLD voice clone takes
 * **75.3s** and a cold voice design **50.9s**, of which about 60 seconds is
 * purely loading weights into a fresh container. Warm, the same calls are 8.8s
 * and 26.9s.
 *
 * ⚠️ SO THE FIRST CALL OF THE DAY ALWAYS FAILED, and it failed with "no answer
 * within 30s" — which reads as a broken endpoint rather than a container that
 * is still starting. The second call, moments later, would have worked. That is
 * the worst shape a timeout can have: it punishes exactly the first impression.
 *
 * ⭐ 180s covers the slowest cold start measured with room to spare, and the
 * overall job budget (DEFAULT_JOB_BUDGET_MS, 12 minutes) is still the real
 * ceiling — this only stops us hanging up on a container that is on its way.
 */
export const POST_TIMEOUT_MS = 180_000;

async function postJson(url, body, { secret, fetchImpl = fetch, timeoutMs = POST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      /**
       * ── ⚠️⚠️⚠️ THE SECRET GOES IN THE BODY. A HEADER IS REJECTED. ─────────
       *
       * Measured against the live services 2026-08-23: every one of them reads
       * `item.get("secret")` from the JSON BODY. Sent as `authorization:
       * Bearer` — which is what this function did, and what every sane person
       * would write — the endpoint sees no secret and answers:
       *
       *     {"ok":false,"error":"unauthorised"}
       *
       * ⚠️⚠️ SO ALL FOUR CREATIVE VERBS HAD NEVER WORKED. `clone_voice`,
       * `design_voice`, `talking_head` and `generate_video` were wired,
       * documented, schema'd, credit-priced and shipped — and every real call
       * was refused at the door. The tests never saw it because they inject a
       * fake `fetchImpl`, so they proved the payload SHAPE against a stub that
       * has no opinion about auth.
       *
       * ⭐ AND "unauthorised" READS EXACTLY LIKE A DEAD DEPLOYMENT, which is how
       * this survived: the natural conclusion from that string is "the GPU is
       * down / the key is wrong", not "we are putting the key in the wrong
       * place". A 200 carrying `unauthorised` is a LIVE service refusing us.
       *
       * The header is kept as well — harmless, and it costs nothing to satisfy
       * a future endpoint that prefers it.
       */
      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(secret ? { ...body, secret } : body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }
    if (!res.ok) return { ok: false, error: `${res.status} ${String(text).slice(0, 200)}` };
    if (!parsed) return { ok: false, error: `the endpoint returned a non-JSON body: ${String(text).slice(0, 120)}` };
    return parsed;
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? `no answer within ${timeoutMs / 1000}s` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a job and wait for it, on a wall-clock budget.
 *
 * ⚠️ A TIMEOUT REPORTS THE `callId`. The render usually carries on running on
 * Modal after we stop waiting, so the honest message is "it may yet finish" plus
 * the handle — not silence that reads as money vanishing.
 */
export async function runJob({
  startUrl, resultUrl, payload, secret, field,
  fetchImpl = fetch, budgetMs = DEFAULT_JOB_BUDGET_MS,
  now = () => Date.now(), sleep = nap, pollMs = POLL_INTERVAL_MS,
}) {
  const startBody = await postJson(startUrl, payload, { secret, fetchImpl });

  /**
   * ⭐ A SYNCHRONOUS SERVICE HAS ALREADY FINISHED. The voice endpoints return
   * the audio inline; only the face renderer queues. Checking here means one
   * code path serves both instead of the caller having to know which kind of
   * service it is talking to.
   */
  const immediate = readImmediate(startBody, { field });
  if (immediate) return { ok: true, ...immediate, callId: null };

  const started = readStart(startBody);
  if (!started.ok) return { ok: false, error: started.error };

  const startedAt = now();
  for (;;) {
    if (!keepPolling({ startedAt, now: now(), budgetMs })) {
      return {
        ok: false,
        error: `still rendering after ${Math.round(budgetMs / 60000)} minutes — it may yet finish on the GPU`,
        callId: started.callId,
      };
    }
    await sleep(pollMs);
    const poll = readPoll(await postJson(resultUrl, { callId: started.callId }, { secret, fetchImpl }), { field });
    if (poll.status === 'running') continue;
    if (poll.status === 'failed') return { ok: false, error: poll.error, callId: started.callId };
    return { ok: true, ...poll, callId: started.callId };
  }
}

/* ─────────────── THE GATE EVERY GPU VERB PASSES THROUGH FIRST ───────────── */

/**
 * ⚠️ MIRRORS `chargeGpu`'s COLD RULE RATHER THAN ASKING IT.
 *
 * The ledger decides cold/warm from its own private `meter.warm` set and exposes
 * no way to query it, so an estimate computed BEFORE the call has to keep the
 * same book. `media-pipeline.mjs` does the identical thing with `cold: i === 0`.
 * It is duplication, and the alternative — a getter on the meter — is a change
 * to `budget.mjs`, which this lane does not own. Named here so it is a known
 * seam and not a surprise.
 */
const seenEndpoints = new Set();

/** Test seam — a warm endpoint must not leak between test files. */
export function resetGpuWarmth() {
  seenEndpoints.clear();
}

/**
 * ── ⭐⭐⭐ PRICE IT, SHOW IT, *THEN* SPEND IT ────────────────────────────────
 *
 * Roman: *"Each verb must state its estimated cost before running and respect
 * --budget and --approve."* Four refusals, in the order that costs least:
 *
 *   1. NOT CONFIGURED — free, local, names the one missing variable.
 *   2. DRY RUN        — ⚠️ and this was a REAL LEAK. `--dry-run` promises
 *      "touch nothing", and until now these five verbs ran the whole GPU render
 *      and merely skipped the `writeFileSync` at the end. A dry run of a
 *      talking head paid for a 400-second A100 job and threw the mp4 away. That
 *      is the most expensive possible way to honour a flag.
 *   3. NOT APPROVED   — only above `APPROVAL_THRESHOLD_USD`, so the cheap verbs
 *      are not made annoying to buy the expensive ones a confirmation.
 *   4. OVER BUDGET    — arithmetic. Starting a run we can already prove will not
 *      finish is how a session dies half-way with the money gone.
 *
 * ⚠️ EVERY REFUSAL CARRIES THE ESTIMATE. A "no" without the number is a "no" the
 * user cannot act on — they cannot tell whether to raise the budget by a cent or
 * abandon the idea.
 */
export function preflight({ verb, endpoint, dryRun = false, approved = false, budget = null }) {
  const cold = !seenEndpoints.has(endpoint ?? verb);
  const estimate = estimateJobUsd(verb, { cold });
  const money = {
    estimateUsd: Number(estimate.usd.toFixed(6)),
    estimateBasis: estimate.basis,
    estimateIsMeasured: estimate.measured,
  };

  if (dryRun) {
    return {
      go: false,
      ...money,
      ok: false,
      code: 'dry_run',
      error: `this is a --dry-run, so ${verb} was NOT sent to the GPU and nothing was charged. `
        + `It would have cost about $${money.estimateUsd.toFixed(4)} (${estimate.basis})`,
    };
  }

  if (needsApproval(verb) && approved !== true) {
    return {
      go: false,
      ...money,
      ok: false,
      code: 'needs_approval',
      error: `nothing was generated and nothing was charged. ${verb} is estimated at about `
        + `$${money.estimateUsd.toFixed(4)} — over the $${APPROVAL_THRESHOLD_USD} bar at which this package `
        + `stops and asks. Tell the user the price, then call ${verb} again with ${SPEND_APPROVAL_ARG}: true `
        + `and the identical arguments. Basis: ${estimate.basis}`,
    };
  }

  /**
   * ⚠️ `remainingUsd` MAY BE `undefined` (no budget object) OR `Infinity`
   * (`--budget none`). Neither is a refusal, and treating a missing number as
   * zero would make these verbs unusable in exactly the runs that opted out of
   * budgeting on purpose.
   */
  const left = budget?.canContinue?.()?.remainingUsd;
  if (Number.isFinite(left) && money.estimateUsd > left) {
    return {
      go: false,
      ...money,
      ok: false,
      code: 'over_budget',
      error: `nothing was generated and nothing was charged. ${verb} is estimated at about `
        + `$${money.estimateUsd.toFixed(4)} and only $${Number(left).toFixed(4)} is left in the budget. `
        + 'Raise --budget, or ask for something shorter. ⚠ The estimate is a FLOOR, so the real call would '
        + 'have overrun by at least this much.',
    };
  }

  return { go: true, ...money, cold };
}

/**
 * ── ⭐⭐ THE SAME GATE FOR A RENTED BACKEND, WITH ONE HONEST DIFFERENCE ─────
 *
 * ⚠️ WE DO NOT KNOW WHAT A FAL CALL COSTS, AND WE MUST NOT PRETEND TO.
 * `priceGpuCall` prices OUR container-seconds; a rented model is priced per call
 * by somebody else's tariff, and `creative-engines.mjs` spends a page arguing
 * why a price list must never be compiled into a published npm package. So the
 * estimate here is `null` — the state a user can act on — rather than a number
 * that would look authoritative and be invented.
 *
 * ⭐ WHICH MAKES THE HANDSHAKE UNCONDITIONAL FOR FAL. `--budget` cannot gate an
 * unknown, so the human does: an unpriced spend is exactly the case where "ask
 * first" is worth a round trip, and it is the opposite of the mistake where a
 * silent escalation to a dearer provider spends money nobody agreed to.
 */
export function preflightRented({ verb, capability, dryRun = false, approved = false, env = process.env }) {
  /**
   * ── ⭐ THE CHEAPEST CHECK FIRST, AND IT OUTRANKS THE HANDSHAKE ────────────
   *
   * Asking somebody to approve a spend on an account that has no balance is a
   * question with only one possible outcome, and it buries the real answer one
   * round trip deep. "The FAL account is out of balance" is free, local, and
   * cannot be wrong — so it is said first. Same ordering argument
   * `creative-engines.mjs` makes for `refuseUnreachableHere`.
   */
  const blocked = falUnavailable(capability, env);
  if (blocked) return { go: false, ...blocked };

  const money = {
    estimateUsd: null,
    estimateBasis: 'FAL is a RENTED model: it is priced per call by the provider, and this package '
      + 'deliberately ships no price list (see creative-engines.mjs — a compiled-in price is the price '
      + 'that shipped, on a file the person being billed can edit). Unknown, therefore said so.',
    estimateIsMeasured: false,
    backend: 'fal',
    capability,
  };
  if (dryRun) {
    return {
      go: false, ...money, ok: false, code: 'dry_run',
      error: `this is a --dry-run, so ${verb} was NOT sent to FAL and nothing was charged.`,
    };
  }
  if (approved !== true) {
    return {
      go: false, ...money, ok: false, code: 'needs_approval',
      error: `nothing was generated and nothing was charged. ${verb} with backend "fal" spends on a `
        + 'RENTED model whose per-call price this package does not know, so it always asks first. '
        + `Tell the user it is unpriced here, then call again with ${SPEND_APPROVAL_ARG}: true.`,
    };
  }
  return { go: true, ...money };
}

/**
 * Turn a finished FAL job into the same shape a Modal job produces, so the
 * caller never has to know which backend answered.
 *
 * ⚠️ NOTHING IS CHARGED TO THE GPU LEDGER. A FAL render costs us nothing in
 * Modal container-seconds, and writing a container price for somebody else's
 * machine would corrupt the one number `acuvo spend` is supposed to mean. The
 * spend is real and it lands on the FAL invoice, which this package cannot see —
 * said out loud rather than papered over with a guess.
 */
function deliverFal(root, out, job, dryRun, gate) {
  if (!job.ok) return job;
  const written = writeArtifact(root, out, job.base64, dryRun);
  if (!written.ok) return written;
  return {
    ok: true,
    path: written.path,
    bytes: written.bytes,
    dryRun: written.dryRun,
    backend: 'fal',
    model: job.slug,
    usd: null,
    estimateUsd: gate.estimateUsd,
    estimateBasis: gate.estimateBasis,
    note: 'Rendered on a RENTED model through FAL. The cost lands on the FAL invoice, not in `acuvo spend` — '
      + 'this package meters our own GPU and cannot see a provider bill.',
  };
}

/** Turn a finished job into a written file, with what it cost attached. */
function deliver(root, out, job, dryRun, { verb, endpoint, estimate = null } = {}) {
  /**
   * ── ⚠️⚠️ THE LEDGER IS WRITTEN EVEN WHEN THE JOB FAILED ───────────────────
   *
   * A Modal container that ANSWERED — with `{ok:false}`, with a 500, with
   * "unauthorised" — booted, ran and billed. `media.mjs` learned this the same
   * way and charges after a RESPONSE rather than after a SUCCESS. Charging only
   * on success would make a run of failures free in the ledger and expensive on
   * the invoice, which is the direction that ends in a surprise.
   *
   * ⚠️ AND IT WAS CHARGING NOTHING AT ALL. Measured 2026-08-25: `chargeGpu`
   * appeared in `imagegen.mjs` and `media.mjs` and nowhere in this file, so the
   * five dearest verbs in the package reported $0.00 to `--budget`,
   * `--fleet-budget` and `acuvo spend` while a two-second TTS line was metered
   * to four decimal places.
   */
  if (endpoint) {
    seenEndpoints.add(endpoint);
    /**
     * ⭐ THE SERVICE'S OWN `seconds` WHEN IT REPORTS ONE, the estimate's when it
     * does not. A reported figure always beats a table — but a table beats
     * nothing, which is what was here before.
     */
    const seconds = Number.isFinite(job?.seconds) && job.seconds > 0
      ? job.seconds
      : (estimate?.seconds ?? 0);
    chargeGpu({ verb, seconds, endpoint });
  }

  if (!job.ok) return job;
  const written = writeArtifact(root, out, job.base64, dryRun);
  if (!written.ok) return written;
  return {
    ok: true,
    path: written.path,
    bytes: written.bytes,
    dryRun: written.dryRun,
    seconds: job.seconds || null,
    /**
     * ⚠️ THE COST IS RETURNED, NEVER SWALLOWED. These are the only verbs in the
     * CLI that spend real money per call, and a user learning the number from a
     * bill instead of from the tool result is exactly what this field prevents.
     */
    usd: Number.isFinite(job.usd) && job.usd > 0 ? job.usd : null,
    ...(estimate ? { estimateUsd: estimate.estimateUsd, estimateBasis: estimate.estimateBasis } : {}),
  };
}

export async function cloneVoice(root, { sample, text, path, [SPEND_APPROVAL_ARG]: approved } = {}, opts = {}) {
  const { env = process.env, fetchImpl = fetch, dryRun = false, budget = null, now, sleep } = opts;
  const cfg = avatarConfig(env);
  if (!cfg.voiceClone) return { ok: false, error: whyUnavailable('clone_voice', env) };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'say what the cloned voice should read' };

  const ref = loadAsset(root, sample, 'a reference audio sample');
  if (!ref.ok) return ref;

  const gate = preflight({ verb: 'clone_voice', endpoint: cfg.voiceClone, dryRun, approved, budget });
  if (!gate.go) return gate;

  const job = await runJob({
    startUrl: cfg.voiceClone, resultUrl: cfg.voiceClone,
    /**
     * ⚠️ `reference_audio_b64`, NOT `reference_b64`. The endpoint reads the
     * long name (chatterbox_voice.py:203) and answers "no reference audio
     * supplied — a clone needs a voice to copy" for the short one. A SECOND
     * independent break on the same verb: even once the auth was fixed, this
     * would still have failed, and the message would have sounded like the
     * user forgot to pass a sample.
     */
    payload: { reference_audio_b64: ref.b64, text: text.trim() },
    secret: cfg.secret, field: ['audio', 'audio_b64'], fetchImpl, now, sleep,
  });
  return deliver(root, path || 'audio/cloned.wav', job, dryRun, { verb: 'clone_voice', endpoint: cfg.voiceClone, estimate: gate });
}

export async function designVoice(root, { description, text, path, [SPEND_APPROVAL_ARG]: approved } = {}, opts = {}) {
  const { env = process.env, fetchImpl = fetch, dryRun = false, budget = null, now, sleep } = opts;
  const cfg = avatarConfig(env);
  if (!cfg.voiceDesign) return { ok: false, error: whyUnavailable('design_voice', env) };
  if (typeof description !== 'string' || !description.trim()) return { ok: false, error: 'describe the voice you want' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'say what it should read' };

  const gate = preflight({ verb: 'design_voice', endpoint: cfg.voiceDesign, dryRun, approved, budget });
  if (!gate.go) return gate;

  const job = await runJob({
    startUrl: cfg.voiceDesign, resultUrl: cfg.voiceDesign,
    payload: { description: description.trim(), text: text.trim() },
    secret: cfg.secret, field: ['audio', 'audio_b64'], fetchImpl, now, sleep,
  });
  return deliver(root, path || 'audio/designed.wav', job, dryRun, { verb: 'design_voice', endpoint: cfg.voiceDesign, estimate: gate });
}

/**
 * -- THE SAME PERSON, AGAIN --------------------------------------------------
 *
 * Live on our own GPU since it was written, credit-priced at 2 credits an image
 * on 2026-08-23, and reachable from NOTHING. `MODAL_CHARACTER_LOCK_URL` was
 * read by `whyUnavailable` and by no verb. A capability nobody can call scores
 * zero however good it is.
 */
export async function characterLock(root, { references, prompt, path, seed, [SPEND_APPROVAL_ARG]: approved } = {}, opts = {}) {
  const { env = process.env, fetchImpl = fetch, dryRun = false, budget = null, now, sleep } = opts;
  const cfg = avatarConfig(env);
  if (!cfg.characterLock) return { ok: false, error: whyUnavailable('character_lock', env) };
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, error: 'say what the character should be doing - the scene, the pose, the lighting' };
  }

  /**
   * TWO IS THE ENGINE'S OWN FLOOR, and the reason is worth repeating rather
   * than discovering: it answers "a character lock needs at least 2 reference
   * images of the same person - one reference copies the photograph rather than
   * the person". Refusing here turns a wasted round trip into a sentence.
   */
  const paths = Array.isArray(references) ? references.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (paths.length < 2) {
    return { ok: false, error: 'a character lock needs at least TWO photos of the same person - one copies the photograph, not the person' };
  }

  const refs = [];
  for (const p of paths.slice(0, 4)) {
    const loaded = loadAsset(root, p, 'a reference photo');
    if (!loaded.ok) return loaded;
    refs.push(loaded.b64);
  }

  const gate = preflight({ verb: 'character_lock', endpoint: cfg.characterLock, dryRun, approved, budget });
  if (!gate.go) return gate;

  const job = await runJob({
    startUrl: cfg.characterLock, resultUrl: cfg.characterLock,
    payload: {
      prompt: prompt.trim(),
      references_b64: refs,
      ...(Number.isFinite(seed) ? { seed: Number(seed) } : {}),
    },
    /**
     * The engine returns `image_b64`; the list also accepts `image` for the
     * same reason the voice verbs accept two names - our own services disagree
     * about the key, and a rename must never discard a paid render again.
     */
    secret: cfg.secret, field: ['image_b64', 'image'], fetchImpl, now, sleep,
  });
  return deliver(root, path || 'images/character.png', job, dryRun, { verb: 'character_lock', endpoint: cfg.characterLock, estimate: gate });
}

export async function talkingHead(root, { image, audio, path, backend, [SPEND_APPROVAL_ARG]: approved } = {}, opts = {}) {
  const { env = process.env, fetchImpl = fetch, dryRun = false, budget = null, now, sleep } = opts;
  const cfg = avatarConfig(env);

  const portrait = loadAsset(root, image, 'a portrait image');
  if (!portrait.ok) return portrait;
  const speech = loadAsset(root, audio, 'the speech audio');
  if (!speech.ok) return speech;

  /**
   * ⭐ NAMED, NEVER DEFAULTED. Our own GPU is the default and FAL only runs when
   * a human or a model asked for it by name — the rule `creative-engines.mjs`
   * exists to enforce. An automatic fall-through to a rented model would spend
   * money on a decision nobody made, precisely when our GPU was having a bad day.
   */
  if (String(backend ?? '').toLowerCase() === 'fal') {
    const rented = preflightRented({ verb: 'talking_head', capability: 'lipsync', dryRun, approved, env });
    if (!rented.go) return rented;
    const job = await runFalJob({
      capability: 'lipsync',
      input: { image_url: `data:image/png;base64,${portrait.b64}`, audio_url: `data:audio/wav;base64,${speech.b64}` },
      env, fetchImpl, now, sleep,
    });
    return deliverFal(root, path || 'video/talking-head.mp4', job, dryRun, rented);
  }

  if (!cfg.face) return { ok: false, error: whyUnavailable('talking_head', env) };

  const gate = preflight({ verb: 'talking_head', endpoint: cfg.face, dryRun, approved, budget });
  if (!gate.go) return gate;

  const job = await runJob({
    startUrl: cfg.face, resultUrl: cfg.faceResult,
    payload: { image_b64: portrait.b64, audio_b64: speech.b64, image_suffix: '.png', audio_suffix: '.wav' },
    secret: cfg.secret, field: ['video_b64', 'video'], fetchImpl, now, sleep,
  });
  return deliver(root, path || 'video/talking-head.mp4', job, dryRun, { verb: 'talking_head', endpoint: cfg.face, estimate: gate });
}

export async function generateVideo(root, { prompt, image, seconds, path, backend, [SPEND_APPROVAL_ARG]: approved } = {}, opts = {}) {
  const { env = process.env, fetchImpl = fetch, dryRun = false, budget = null, now, sleep } = opts;
  const cfg = avatarConfig(env);
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, error: 'describe the clip — subject, motion, camera, mood' };
  }

  let still = null;
  if (image) {
    const loaded = loadAsset(root, image, 'the still to animate');
    if (!loaded.ok) return loaded;
    still = loaded.b64;
  }

  /** Named, never defaulted — see `talkingHead` above for the argument. */
  if (String(backend ?? '').toLowerCase() === 'fal') {
    /**
     * ⚠️ TEXT-TO-VIDEO AND ANIMATE-A-STILL ARE DIFFERENT MODELS ON FAL, not one
     * model with an optional argument. Sending a still to a text-to-video slug
     * is how a picture gets silently ignored — the exact bug this file already
     * carries a note about on the Modal side (`image`, not `image_b64`).
     */
    const capability = still ? 'image-to-video' : 'video';
    const rented = preflightRented({ verb: 'generate_video', capability, dryRun, approved, env });
    if (!rented.go) return rented;
    const job = await runFalJob({
      capability,
      input: {
        prompt: prompt.trim(),
        ...(still ? { image_url: `data:image/png;base64,${still}` } : {}),
        ...(Number.isFinite(seconds) ? { duration: Math.max(1, Math.round(Number(seconds))) } : {}),
      },
      env, fetchImpl, now, sleep,
    });
    return deliverFal(root, path || 'video/clip.mp4', job, dryRun, rented);
  }

  if (!cfg.video) return { ok: false, error: whyUnavailable('generate_video', env) };

  const gate = preflight({ verb: 'generate_video', endpoint: cfg.video, dryRun, approved, budget });
  if (!gate.go) return gate;

  const job = await runJob({
    startUrl: cfg.video, resultUrl: cfg.videoResult,
    /**
     * ⚠️ `image`, NOT `image_b64` — wan_video.py reads `item.get("image")`, so
     * every animate-a-still request silently became text-to-video and ignored
     * the picture the user supplied. The clip came back looking wrong rather
     * than failing, which is the worse way to be broken.
     *
     * ⚠️ AND THE ENGINE HAS NO `seconds` — it takes `frames`. The old payload
     * sent a key nothing reads, so asking for a 2-second clip and a 10-second
     * clip both produced the engine default (61 frames). Converted here at the
     * default `wan` engine's 16 fps.
     *
     * ⚠️ HONEST LIMIT: a deployment pinned to a 24 fps engine (ltx, wan22-720p)
     * will render this many frames at ITS rate, so the clip comes out shorter
     * than asked. Still strictly better than the length being ignored entirely,
     * and the engine clamps rather than failing.
     */
    payload: {
      prompt: prompt.trim(),
      ...(still ? { image: still } : {}),
      ...(seconds ? { frames: Math.max(1, Math.round(Number(seconds) * 16)) } : {}),
    },
    secret: cfg.secret, field: ['video_b64', 'video'], fetchImpl, now, sleep,
  });
  return deliver(root, path || 'video/clip.mp4', job, dryRun, { verb: 'generate_video', endpoint: cfg.video, estimate: gate });
}
