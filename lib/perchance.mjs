/**
 * ── ⭐⭐ PERCHANCE, NATIVELY. NO BROWSER, NO MODAL, NO DEPENDENCY. ───────────
 *
 * Until today this capability needed a headless Chromium: either running on the
 * user's machine or hosted on Modal, where it took 49s at best and returned
 * "no finished image within 300s" at worst. Both are gone.
 *
 * ⚠️ AND I SAID THIS WAS IMPOSSIBLE. I tried `fetch()` once, got Cloudflare's
 * "Just a moment...", and concluded a native path needed curl_cffi. Roman did
 * not accept that. The measurement that followed is in `h2.mjs`: it takes
 * HTTP/2 **and** Safari's cipher ordering, both in `node:http2`, and neither
 * alone is enough. Three trials per cell, 200 200 200 against 403 403 403.
 *
 * ── THE PROTOCOL, CAPTURED FROM THE REAL CLIENT ─────────────────────────────
 * Reverse-engineered by intercepting the generator's own requests, because the
 * parameter shape is not documented anywhere and guessing it produced exactly
 * one useful signal: `{"status":"invalid_parameter"}`.
 *
 *   1. GET  /api/verifyUser                     -> { userKey }
 *   2. POST /api/generate?userKey&requestId…    -> { status }
 *      ⚠️ A POST WITH A JSON BODY. My first attempt used a GET with query
 *      params — every field in the right place, and completely wrong.
 *   3. GET  /api/getUserQueuePosition?…         -> poll until status:"success"
 *   4. GET  /api/downloadTemporaryImageViaProxy -> the bytes
 *
 * ⚠️ FRAGILE BY CONSTRUCTION, AND THAT IS STATED RATHER THAN HIDDEN. This is an
 * undocumented private API reached through a fingerprint that a CDN may stop
 * honouring at any time. It has no SLA and owes us nothing. Everything that uses
 * it must keep a fallback that does not depend on it — which is why the image
 * chain still has a second provider.
 */

import { h2Request, h2Json } from './h2.mjs';

const HOST = 'https://image-generation.perchance.org';
const CHANNEL = 'ai-text-to-image-generator';

/** The generator's own cadence: it polls about once a second. */
const POLL_INTERVAL_MS = 1_200;
/** Total budget for one image. Beyond this an interactive loop has been abandoned. */
const DEFAULT_BUDGET_MS = 90_000;

/** Perchance uses a bare `Math.random()` string for both of these. Match it. */
const randomId = () => String(Math.random());

/**
 * Get a userKey. No browser: the endpoint answers a plain h2 GET.
 *
 * ⚠️ THE KEY IS NOT A SECRET AND MUST NOT BE TREATED AS ONE — it is a
 * rate-limiting handle the site hands to anyone who asks. It is never written to
 * disk here, because a value that looks like a credential eventually gets
 * committed by someone who assumed it was one.
 */
export async function verifyUser({ requestImpl = h2Json } = {}) {
  const r = await requestImpl(`${HOST}/api/verifyUser`, { headers: { origin: HOST, referer: `${HOST}/` } });
  if (!r.ok) return { ok: false, error: r.error ?? `verifyUser returned ${r.status}`, challenged: r.challenged === true };
  const key = r.json?.userKey;
  if (typeof key !== 'string' || key.length < 16) {
    return { ok: false, error: `verifyUser gave no usable key: ${JSON.stringify(r.json).slice(0, 140)}` };
  }
  return { ok: true, userKey: key, status: r.json.status ?? null };
}

/** Ask for an image. Returns the requestId the queue is polled with. */
export async function requestGeneration({
  prompt, userKey, resolution = '768x768', negativePrompt = '', guidanceScale = 7, seed = -1,
  requestImpl = h2Json,
}) {
  const requestId = randomId();
  const query = new URLSearchParams({ userKey, requestId, adAccessCode: '', __cacheBust: randomId() });
  const body = JSON.stringify({
    prompt: String(prompt), negativePrompt, seed, resolution, guidanceScale,
    channel: CHANNEL, subChannel: 'public', userKey, adAccessCode: '', requestId,
  });

  const r = await requestImpl(`${HOST}/api/generate?${query}`, {
    method: 'POST',
    headers: { origin: HOST, referer: `${HOST}/`, 'content-type': 'text/plain;charset=UTF-8' },
    body,
  });
  if (!r.ok) return { ok: false, error: r.error ?? `generate returned ${r.status}`, challenged: r.challenged === true };

  const status = r.json?.status;
  /**
   * ⚠️ `invalid_parameter` IS OUR BUG, NOT AN OUTAGE, and saying so saves the
   * next person the afternoon it cost me. It means the body shape drifted — the
   * endpoint is reachable and answering.
   */
  if (status === 'invalid_parameter') {
    return { ok: false, error: 'perchance rejected the request shape (invalid_parameter) — the private API changed and lib/perchance.mjs needs re-capturing; this is not a transient failure and retrying will not help' };
  }
  /**
   * ⚠️⭐ THE REQUEST IS SYNCHRONOUS AND I BUILT A QUEUE FOR NOTHING.
   *
   * The browser capture showed `getUserQueuePosition` being polled, so I wrote a
   * poller — and it sat there reading `not_in_queue` for ninety seconds while
   * the image had been ready the whole time. The POST itself returns
   * `{ status:"success", imageId, imageDownloadUrl, seed, width, height,
   * maybeNsfw }` in **2.7 seconds**. The queue only appears when a previous
   * request of yours is still running, which is why the browser hit it and a
   * fresh caller does not.
   *
   * ⭐ Reading the capture is not the same as reading the RESPONSE. I had every
   * field I needed in the first reply and threw all but one of them away.
   */
  return {
    ok: true,
    requestId,
    status: status ?? null,
    imageId: r.json?.imageId ?? null,
    downloadPath: r.json?.imageDownloadUrl ?? null,
    seed: r.json?.seed ?? null,
    // Surfaced, not swallowed: the caller is writing this into someone's page.
    maybeNsfw: r.json?.maybeNsfw === true,
    fileExtension: r.json?.fileExtension ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the image exists.
 *
 * ⚠️ BOUNDED BY WALL CLOCK, NOT BY ATTEMPTS. A queue that says "position 4"
 * forever is indistinguishable from a broken one, and an unbounded poll inside a
 * coding agent's round is how a session disappears.
 */
export async function awaitImage({ userKey, requestId, budgetMs = DEFAULT_BUDGET_MS, requestImpl = h2Json, sleepImpl = sleep }) {
  const deadline = Date.now() + budgetMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    const q = new URLSearchParams({ userKey, requestId });
    const r = await requestImpl(`${HOST}/api/getUserQueuePosition?${q}`, { headers: { origin: HOST, referer: `${HOST}/` } });
    if (!r.ok) return { ok: false, error: r.error ?? `queue poll returned ${r.status}` };

    lastStatus = r.json?.status ?? null;
    if (lastStatus === 'success') return { ok: true, imageId: r.json?.imageId ?? null, raw: r.json };
    if (r.json?.havingTechnicalDifficulties === true) {
      return { ok: false, error: 'perchance reports technical difficulties on its own side — not our request; use another provider for now' };
    }
    await sleepImpl(POLL_INTERVAL_MS);
  }
  return { ok: false, error: `no image within ${Math.round(budgetMs / 1000)}s (last status: ${lastStatus ?? 'none'}) — use another provider rather than waiting again` };
}

/**
 * Fetch the finished bytes.
 *
 * ⚠️ THE PATH COMES FROM THE RESPONSE, NOT FROM US. `imageDownloadUrl` carries a
 * signed token; reconstructing the URL from an imageId gets a rejection, and
 * hand-building URLs for someone else's private API is how this breaks silently
 * the next time they rotate the signing scheme.
 */
export async function downloadImage({ downloadPath, requestImpl = h2Request }) {
  if (!downloadPath) return { ok: false, error: 'no download path in the generate response' };
  const url = downloadPath.startsWith('http') ? downloadPath : `${HOST}${downloadPath}`;
  const r = await requestImpl(url, { headers: { origin: HOST, referer: `${HOST}/` } });
  if (!r.ok) return { ok: false, error: r.error ?? `download returned ${r.status}` };

  const bytes = r.body;
  /**
   * ⚠️ MAGIC BYTES, NOT STATUS. The same rule the Pollinations path had to
   * learn: a 200 carrying an error page written to disk as `hero.jpg` is worse
   * than an outage, because the page looks built and is broken.
   */
  const isJpeg = bytes?.[0] === 0xff && bytes?.[1] === 0xd8;
  const isPng = bytes?.subarray(0, 4).toString('hex') === '89504e47';
  if (!bytes || bytes.length < 1000 || (!isJpeg && !isPng)) {
    return { ok: false, error: `perchance returned ${bytes?.length ?? 0} bytes that are not an image` };
  }
  return { ok: true, bytes, mimeType: isJpeg ? 'image/jpeg' : 'image/png' };
}

/** The whole flow, start to bytes. */
export async function generateNative({ prompt, resolution = '768x768', budgetMs = DEFAULT_BUDGET_MS, userKey = null } = {}) {
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'an image needs a prompt' };

  let key = userKey;
  if (!key) {
    const v = await verifyUser();
    if (!v.ok) return v;
    key = v.userKey;
  }

  const started = await requestGeneration({ prompt, userKey: key, resolution });
  if (!started.ok) return started;

  /**
   * ⭐ THE COMMON PATH IS SYNCHRONOUS — the image is ready in the POST reply.
   * The queue is the exception, entered only when a previous request of this
   * userKey is still running, so it is a fallback rather than the main road.
   */
  let downloadPath = started.downloadPath;
  let { maybeNsfw, seed } = started;

  if (!downloadPath) {
    const waited = await awaitImage({ userKey: key, requestId: started.requestId, budgetMs });
    if (!waited.ok) return waited;
    downloadPath = waited.raw?.imageDownloadUrl ?? null;
    if (!downloadPath) return { ok: false, error: 'perchance reported success without a download url — the response shape changed' };
    maybeNsfw = waited.raw?.maybeNsfw === true;
    seed = waited.raw?.seed ?? null;
  }

  const got = await downloadImage({ downloadPath });
  if (!got.ok) return got;

  return { ok: true, bytes: got.bytes, mimeType: got.mimeType, provider: 'perchance-native', userKey: key, seed, maybeNsfw };
}
