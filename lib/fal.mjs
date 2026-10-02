/**
 * ── ⭐⭐⭐ THE RENTED HALF, WIRED WHILE THE BILL IS UNPAID ───────────────────
 *
 * Roman, 2026-08-24: *"any APIs (like FAL) even if not topped up, APIs should be
 * wired."* And the standing instruction from the Studio doctrine: **prepare,
 * don't provision** — *"we can plug the actual key in when ready."*
 *
 * So this is the path, complete, gated, and refusing honestly. Funding the
 * account is then a variable, not a build.
 *
 * ── ⚠️⚠️ THE ACCOUNT IS LOCKED, AND THAT IS A MEASUREMENT ───────────────────
 *
 * `POST queue.fal.run/fal-ai/flux/schnell` with a valid 69-character key:
 *
 *     403 {"detail": "User is locked. Reason: Exhausted balance."}
 *
 * ⭐ WHICH IS THE ENTIRE REASON THIS MODULE EXISTS RATHER THAN A ONE-LINE FETCH.
 * The console's own adapter turns that into *"rejected the request (HTTP 403)"*
 * — a sentence that sends the reader to check the key, the slug, the region and
 * the payload, none of which is wrong. Fifty-one engines are dark for ONE
 * unpaid bill, and the refusal has to say so in the words that name the remedy.
 * A generic 4xx is how a $0 top-up becomes a week of debugging.
 *
 * ── ⚠️ NOTHING HERE IS A FALLBACK, AND THAT IS DELIBERATE ───────────────────
 *
 * `creative-engines.mjs` holds the rule "UNLOCKED, NEVER DEFAULTED": software
 * does not silently escalate to a dearer provider. FAL is a NAMED backend —
 * `backend: "fal"` — and when it is not named, nothing in this file is called.
 * An automatic fall-through to a rented model would spend somebody's money on a
 * decision they did not make, and would do it precisely when our own GPU was
 * having a bad day.
 *
 * ── THE RULES THIS INHERITS ─────────────────────────────────────────────────
 * · Zero dependencies. Plain HTTPS to `queue.fal.run`, submit → poll → fetch.
 * · Never throws. A failure is a returned value the model can reason about.
 * · Never returns a fake artifact. No bytes, no success.
 * · BYOK = NEVER: `FAL_KEY` is OUR account key behind OUR deployment, the same
 *   way `ACUVO_MEDIA_SECRET` is. It is not a way for a customer to bring their
 *   own capacity, and no argument here accepts a user-supplied key.
 */

/** Fal's queue API. Submit here, poll for status, fetch the result. */
export const QUEUE_BASE = 'https://queue.fal.run';

/** One leg of the conversation — submit, one poll, or the result fetch. */
export const LEG_TIMEOUT_MS = 30_000;

/**
 * Total wall clock for a whole job. Matches the console adapter's ceiling
 * deliberately: they disagreed by 3× once, and the shorter one gave up while
 * the render was still running AND already charged for.
 */
export const TOTAL_TIMEOUT_MS = 15 * 60_000;

export const POLL_INTERVAL_MS = 2_500;

/** Below this a "file" is an error page wearing a content-type. */
export const MIN_PLAUSIBLE_BYTES = 2_048;

/** A remote service is not trusted to be reasonable about response size. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * ── ⭐ THE SLUGS, AS DATA ───────────────────────────────────────────────────
 *
 * Mirrored from `console/lib/model-registry.ts`, which is the catalogue of
 * record. Only the capabilities this CLI has a verb for are listed — a slug for
 * something nothing can call is a row that rots unnoticed.
 *
 * ⚠️ THESE HAVE NEVER BEEN RUN. No key has ever had a balance, so every slug
 * here is a best-known identifier and not a verified one. A wrong slug fails
 * honestly (HTTP 404, surfaced as "fal has no model at this address") rather
 * than quietly producing something else — which is the only property that makes
 * shipping unverified data acceptable.
 */
export const FAL_MODELS = Object.freeze({
  /**
   * ⭐ WAN 2.2 5B, NOT SEEDANCE (2026-09-28) — the same engine the builder's
   * `generate_video` rents first (`console/lib/videogen.ts` `cheapestRentedVideo`
   * → `fal-wan22-5b`): Apache-2.0 weights, $0.15 a clip, and PROVEN by a real
   * render (`console/lib/engine-proof.ts`). Seedance was the one slug here that
   * had never run, and at several times the price. ⚠️ Never LTX: its licence has
   * a "directly competing products" clause (`fal-ltx-23` is `restricted`).
   */
  video: Object.freeze({
    slug: 'fal-ai/wan/v2.2-5b/text-to-video',
    what: 'text to video',
  }),
  'image-to-video': Object.freeze({
    slug: 'fal-ai/kling-video/v2/master/image-to-video',
    what: 'animate a still',
  }),
  lipsync: Object.freeze({
    slug: 'fal-ai/sync-lipsync/v3/image-to-video',
    what: 'a talking head from a photo and audio',
  }),
  image: Object.freeze({
    slug: 'fal-ai/flux/schnell',
    what: 'text to image',
  }),
  'image-edit': Object.freeze({
    slug: 'fal-ai/nano-banana/edit',
    what: 'instruction-based image editing',
  }),
});

/**
 * ── ⚠️⚠️ TWO GATES, AND CONFLATING THEM IS THE BUG WE ALREADY SHIPPED ──────
 *
 * `capability-liveness.ts` recorded it: the product told an owner *"needs
 * FAL_KEY"* on a deployment where `FAL_KEY` was present and 69 characters long.
 * The real gate was funding. An owner reading "needs FAL_KEY" goes and sets a
 * key that is already set, and concludes the product is broken.
 *
 *   key      — is there a credential at all?
 *   funded   — has a human ASSERTED the account has a balance?
 *
 * ⭐ `FAL_ACCOUNT_FUNDED` DEFAULTS TO OFF, AND THAT IS EVIDENCE-BASED, not
 * pessimism: we measured the 403. The same default lives in
 * `console/lib/model-registry.ts:falAccountFunded`, and the two must agree or
 * the CLI and the browser will disagree about what the same account can do.
 *
 * ⚠️ AND THE FLAG IS A STRING IN A FILE — it cannot notice that the balance ran
 * out again. It buys us a clear refusal before the request, not a guarantee;
 * `classifyFalFailure` is what handles being wrong about it.
 */
export function falConfig(env = process.env) {
  const key = env.FAL_KEY?.trim() || null;
  const funded = /^(1|true|yes)$/i.test(String(env.FAL_ACCOUNT_FUNDED ?? '').trim());
  return { key, funded, usable: Boolean(key) && funded };
}

/**
 * Why FAL cannot be used, in the words that name the remedy — or null when it
 * can.
 *
 * ⚠️ THE THREE STATES GET THREE DIFFERENT SENTENCES AND THREE DIFFERENT CODES,
 * for the reason `creative-engines.mjs` gives about plan-versus-balance: the
 * next action differs, and one of them costs money.
 */
export function falUnavailable(capability, env = process.env) {
  const cfg = falConfig(env);
  const model = FAL_MODELS[capability];

  if (!model) {
    return {
      ok: false,
      code: 'fal_no_model',
      remedy: 'use-our-gpu',
      error: `there is no FAL model wired for "${capability}" in this package. `
        + `The wired ones are: ${Object.keys(FAL_MODELS).join(', ')}.`,
    };
  }
  if (!cfg.key) {
    return {
      ok: false,
      code: 'fal_no_key',
      remedy: 'set-fal-key',
      error: 'FAL is not configured here — set FAL_KEY. Nothing was generated and nothing was charged. '
        + 'FAL is the rented half of the catalogue; our own GPU verbs need no key and are unaffected.',
    };
  }
  if (!cfg.funded) {
    return {
      ok: false,
      code: 'fal_out_of_balance',
      remedy: 'top-up-fal',
      /**
       * ⭐⭐ THE SENTENCE THIS WHOLE MODULE IS FOR. Not "not configured", not
       * "HTTP 403" — the account is out of balance, the key is fine, and the
       * remedy is a payment. Measured: `403 {"detail":"User is locked. Reason:
       * Exhausted balance."}` with a valid key in place.
       */
      error: 'the FAL account is OUT OF BALANCE, so nothing was generated and nothing was charged. '
        + 'The key is present and the wiring is complete — FAL answers a valid key with '
        + '403 "User is locked. Reason: Exhausted balance." Top the account up, then set '
        + 'FAL_ACCOUNT_FUNDED=1. This is a bill, not a bug, and no amount of retrying will change it.',
    };
  }
  return null;
}

/**
 * ── ⭐⭐ READ WHAT FAL ACTUALLY SAID ────────────────────────────────────────
 *
 * The funded flag is an assertion by a human and can be stale, so the live
 * refusal has to be classified too — otherwise the day the balance runs out we
 * are back to "rejected the request (HTTP 403)".
 *
 * ⚠️ 401 AND 403 ARE OPPOSITE PROBLEMS. 401 is a bad key (fix the credential);
 * 403 with "locked"/"exhausted" is a good key with no money (pay the bill).
 * Telling somebody to check their key when the account is empty is the same
 * class of misdirection as telling them to top up when the plan is wrong.
 */
export function classifyFalFailure(status, bodyText = '') {
  const body = String(bodyText ?? '').slice(0, 400);
  const looksLocked = /exhausted\s+balance|user is locked|insufficient|quota/i.test(body);

  if (status === 403 || looksLocked) {
    return {
      ok: false,
      code: 'fal_out_of_balance',
      remedy: 'top-up-fal',
      error: `FAL refused with HTTP ${status}: the account is out of balance. `
        + `Its own words: ${body || '(no body)'}. `
        + 'Nothing was generated. The key works; the balance does not. Top up the FAL account.',
    };
  }
  if (status === 401) {
    return {
      ok: false,
      code: 'fal_bad_key',
      remedy: 'set-fal-key',
      error: `FAL refused with HTTP 401 — the key itself is rejected, which is a DIFFERENT problem `
        + `from an empty balance. Check FAL_KEY. Its own words: ${body || '(no body)'}.`,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      code: 'fal_no_such_model',
      remedy: 'fix-the-slug',
      error: 'FAL has no model at that address (HTTP 404). ⚠ The slugs in this package are mirrored '
        + 'from the console catalogue and have NEVER been run against a funded account, so a wrong '
        + 'one is expected rather than surprising. Correct it in lib/fal.mjs FAL_MODELS.',
    };
  }
  if (status === 429) {
    return {
      ok: false,
      code: 'fal_rate_limited',
      remedy: 'wait',
      error: `FAL rate-limited us (HTTP 429). This one IS worth retrying, unlike a balance refusal. `
        + `Its own words: ${body || '(no body)'}.`,
    };
  }
  return {
    ok: false,
    code: 'fal_failed',
    remedy: 'read-the-body',
    error: `FAL answered HTTP ${status}: ${body || '(no body)'}`,
  };
}

/**
 * Pull the first usable asset URL out of a FAL result payload.
 *
 * ⚠️ FAL RETURNS A DIFFERENT SHAPE PER MODEL FAMILY — `{images:[{url}]}`,
 * `{video:{url}}`, `{audio:{url}}`, sometimes a bare `{url}`. A branch per model
 * would rot the moment a model is added, so this walks the payload. The same
 * tolerance the console adapter settled on, and for the same reason: the
 * catalogue is meant to grow by config.
 */
export function extractAssetUrl(payload, depth = 0) {
  if (depth > 6 || payload == null) return null;
  if (typeof payload === 'string') return /^https?:\/\//.test(payload) ? payload : null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractAssetUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload !== 'object') return null;

  // Prefer an explicit url before descending, or an unrelated link deeper in the
  // payload can win over the artifact.
  if (typeof payload.url === 'string' && /^https?:\/\//.test(payload.url)) return payload.url;
  for (const key of ['images', 'image', 'video', 'audio', 'output', 'data']) {
    if (key in payload) {
      const found = extractAssetUrl(payload[key], depth + 1);
      if (found) return found;
    }
  }
  for (const value of Object.values(payload)) {
    const found = extractAssetUrl(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Is a queue status terminal, and did it work? */
export function readQueueStatus(body) {
  const status = String(body?.status ?? '').toUpperCase();
  if (status === 'COMPLETED') return { state: 'done' };
  if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') return { state: 'running' };
  if (!status) return { state: 'failed', error: 'fal returned a status response with no status' };
  return { state: 'failed', error: `fal reported ${status}` };
}

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function leg(url, init, fetchImpl, timeoutMs = LEG_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return { ok: true, res: await fetchImpl(url, { ...init, signal: controller.signal }) };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? `fal did not answer within ${timeoutMs / 1000}s` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ── ⭐⭐ SUBMIT → POLL → FETCH, THE WHOLE PATH ──────────────────────────────
 *
 * @returns {{ok:true, base64:string, contentType:string, slug:string, bytes:number}
 *          |{ok:false, code:string, remedy?:string, error:string}}
 *
 * ⚠️ IT RETURNS BASE64, NOT A FILE. Writing the artifact is the caller's job,
 * exactly as it is for a Modal job, so the two backends deliver the same shape
 * and `deliver()` does not have to know which one answered.
 */
export async function runFalJob({
  capability,
  input,
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = nap,
  budgetMs = TOTAL_TIMEOUT_MS,
  pollMs = POLL_INTERVAL_MS,
} = {}) {
  const blocked = falUnavailable(capability, env);
  if (blocked) return blocked;

  const { key } = falConfig(env);
  const { slug } = FAL_MODELS[capability];
  const headers = { authorization: `Key ${key}`, 'content-type': 'application/json' };

  const submitted = await leg(`${QUEUE_BASE}/${slug}`, {
    method: 'POST', headers, body: JSON.stringify(input ?? {}),
  }, fetchImpl);
  if (!submitted.ok) return { ok: false, code: 'fal_unreachable', error: submitted.error };

  if (!submitted.res?.ok) {
    const text = await submitted.res.text().catch(() => '');
    return classifyFalFailure(submitted.res.status, text);
  }

  const queued = await submitted.res.json().catch(() => null);
  const requestId = queued?.request_id;
  if (!requestId) {
    return { ok: false, code: 'fal_no_request_id', error: 'fal accepted the job and returned no request_id' };
  }
  const statusUrl = queued.status_url ?? `${QUEUE_BASE}/${slug}/requests/${requestId}/status`;
  const responseUrl = queued.response_url ?? `${QUEUE_BASE}/${slug}/requests/${requestId}`;

  const startedAt = now();
  for (;;) {
    if (now() - startedAt >= budgetMs) {
      return {
        ok: false,
        code: 'fal_timeout',
        /**
         * ⚠️ THE REQUEST ID TRAVELS WITH THE TIMEOUT, for the same reason the
         * Modal `callId` does: the render usually carries on and has already
         * been charged. Silence would read as money vanishing.
         */
        error: `fal was still working after ${Math.round(budgetMs / 60000)} minutes — it may yet finish. `
          + `request_id: ${requestId}`,
      };
    }
    await sleep(pollMs);

    const polled = await leg(statusUrl, { headers }, fetchImpl);
    if (!polled.ok) return { ok: false, code: 'fal_unreachable', error: polled.error };
    if (!polled.res?.ok) {
      const text = await polled.res.text().catch(() => '');
      return classifyFalFailure(polled.res.status, text);
    }
    const state = readQueueStatus(await polled.res.json().catch(() => null));
    if (state.state === 'running') continue;
    if (state.state === 'failed') return { ok: false, code: 'fal_failed', error: state.error };
    break;
  }

  const finished = await leg(responseUrl, { headers }, fetchImpl);
  if (!finished.ok) return { ok: false, code: 'fal_unreachable', error: finished.error };
  if (!finished.res?.ok) {
    const text = await finished.res.text().catch(() => '');
    return classifyFalFailure(finished.res.status, text);
  }
  const payload = await finished.res.json().catch(() => null);
  const assetUrl = extractAssetUrl(payload);
  if (!assetUrl) {
    return {
      ok: false,
      code: 'fal_no_artifact',
      error: 'fal reported the job COMPLETED and the payload carried no asset URL — '
        + 'a done with no artifact is a failure, not an empty success.',
    };
  }

  const fetched = await leg(assetUrl, {}, fetchImpl, budgetMs > LEG_TIMEOUT_MS ? LEG_TIMEOUT_MS * 4 : LEG_TIMEOUT_MS);
  if (!fetched.ok) return { ok: false, code: 'fal_unreachable', error: fetched.error };
  if (!fetched.res?.ok) return { ok: false, code: 'fal_asset_gone', error: `the finished asset returned HTTP ${fetched.res.status}` };

  const declared = Number(fetched.res.headers?.get?.('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    return { ok: false, code: 'fal_too_big', error: `the asset declares ${declared} bytes, over the ${MAX_RESPONSE_BYTES} ceiling` };
  }
  const buf = Buffer.from(await fetched.res.arrayBuffer());
  if (buf.length > MAX_RESPONSE_BYTES) {
    return { ok: false, code: 'fal_too_big', error: `the asset is ${buf.length} bytes, over the ${MAX_RESPONSE_BYTES} ceiling` };
  }
  /**
   * ⚠️ A SHORT FILE IS AN ERROR PAGE, NOT A RENDER. This package has already
   * shipped a zero-byte PNG and called it a success; the floor is what stops
   * the same mistake arriving through a different provider.
   */
  if (buf.length < MIN_PLAUSIBLE_BYTES) {
    return {
      ok: false,
      code: 'fal_artifact_too_small',
      error: `the asset is only ${buf.length} bytes — too small to be a real render, so it is treated as a failure`,
    };
  }

  return {
    ok: true,
    base64: buf.toString('base64'),
    bytes: buf.length,
    contentType: fetched.res.headers?.get?.('content-type') ?? 'application/octet-stream',
    slug,
  };
}
