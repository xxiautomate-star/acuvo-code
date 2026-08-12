/**
 * ── ⭐ IMAGERY IN THE LOOP, WITH NO SETUP AND NO ACCOUNT ─────────────────────
 *
 * Roman, 2026-08-09: *"make sure Perchance is real and working and is native to
 * Acuvo for CLI and browser builder… native abilities, as if we were a lab that
 * built out Acuvo AI."*
 *
 * This is `generate_image` for the terminal. Ask Acuvo Code for a landing page
 * and it writes the markup AND produces the hero shot, in the same session, into
 * your own repo — zero configuration, no account, no key.
 *
 * ── ⚠️ THIS BANNER USED TO READ "THE THING NO OTHER CODING AGENT CAN DO" ─────
 * It was struck 2026-08-11, for the same reason the README's "nobody else can
 * see" was struck the day before: it is FALSE and it dies on first contact.
 * Any agent with an MCP image server generates images, and the old text went
 * further — "Claude Code and Codex cannot do this at any price" — which a
 * customer disproves in one install. A claim that cannot survive a demo makes
 * every other claim in the file suspect, and this file has several that are
 * true.
 *
 * ⭐ WHAT IS ACTUALLY DEFENSIBLE, and it is not the GPU:
 *   1. ZERO SETUP. It works on a fresh clone with no key and no config, and a
 *      capability you have to discover and configure is one most people never
 *      see. That is a product decision, not a moat, and it is worth more here
 *      than either.
 *   2. ⭐⭐ THE CRITIC. The generator is wrapped in generate → LOOK → re-direct
 *      (`image-director.mjs`), so the image is scored before it is accepted and
 *      an unreviewed one is reported as unreviewed. A generator without a critic
 *      is a slot machine, and an agent that cannot see will reference a smeared
 *      illegible hero across four pages with total confidence — which is a thing
 *      that happened here, on our own coffee site.
 * Price and pitch on those two. Neither needs anyone else to be incapable.
 *
 * ── ⚠️ IT WRITES A FILE, IT DOES NOT RETURN AN IMAGE ─────────────────────────
 * The tool result handed back to the model is a PATH and a byte count, never the
 * image itself. Two reasons, and the second is the one that would actually hurt:
 *   1. A 200KB PNG is ~270KB of base64, which would blow the context window on
 *      one call.
 *   2. The model cannot see it anyway — `deepseek-v4-flash` is text-only. Handing
 *      it pixels would cost a fortune to be ignored. (The model that CAN see —
 *      qwen3.7-flash — is the critic in the browser builder's render loop, a
 *      different job on a different surface.)
 *
 * ── ⚠️⚠️ PERCHANCE CLOSED THE DOOR ON 2026-08-11. READ THIS FIRST. ───────────
 * This header used to say the default engine was Perchance, direct over HTTP/2,
 * 3 seconds. The transport claim is still true. The capability is not:
 *
 *     GET /api/verifyUser -> {"status":"failed_verification",
 *                            "reason":"token_required"}
 *
 * Four consecutive calls, seconds apart, identical every time. Anonymous
 * generation now needs an account token. ⭐ THIS IS A POLICY CHANGE, NOT A
 * TECHNICAL DEFEAT — our HTTP/2 + Safari-cipher fingerprint still gets us a real
 * JSON answer from their private API rather than a Cloudflare wall, which is the
 * hard part and it still works. They simply stopped serving strangers.
 *
 * ⚠️ AND NOTHING FAILED LOUDLY, WHICH IS THE PART TO LEARN FROM. Every test here
 * was mocked, so the suite stayed green for as long as it took someone to run
 * the real chain. A provider is the one dependency a mock cannot vouch for.
 *
 * ⭐ WHAT ACTUALLY DRAWS YOUR IMAGE TODAY: Pollinations, the keyless fallback.
 * It is free, lower quality, and notably weaker at lettering than the engine it
 * replaced — so a hero with a legible sign on it is no longer something this
 * chain can promise. Perchance stays in the chain because it costs one ~0.4s
 * probe per process to find out whether the door reopened, and the breaker makes
 * sure it is exactly one; it is not tried again after the first refusal.
 *
 * ⚠️ There is a better answer we own and cannot reach from here: the
 * `acuvo-flux-studio` Modal app (shuttle-3.1-aesthetic, Apache-2.0, ungated,
 * ~$0.0016 an image). It needs a URL and `ACUVO_SHARED_SECRET`, neither of which
 * exists on a fresh clone, and it is async (spawn a callId, poll `/result`). It
 * is deliberately NOT wired here yet, because plumbing a provider that cannot be
 * run even once is how this package ends up with another capability that is
 * built and unproven. It is also weak at text in images, so it would not restore
 * what Perchance was good at — do not let anyone swap it in and call the
 * capability unchanged.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInWorkspace } from './workspace.mjs';
import { throughBreaker, deadReason, skipMessage, markUnreachable } from './breaker.mjs';
import { directImage } from './image-director.mjs';
import { generateNative } from './perchance.mjs';

/** Where the service lives. Absent ⇒ the tool is not offered at all. */
export const IMAGE_URL_ENV = 'PERCHANCE_IMAGE_URL';
export const IMAGE_TOKEN_ENV = 'PERCHANCE_IMAGE_TOKEN';

/**
 * ── ⚠️⭐ SET BY MEASURED SUCCESS, NOT BY HOPE ───────────────────────────────
 *
 * This was 180s, justified as "generous". Measured 2026-08-10, both ends:
 *   · the LOCAL perchance-server returns a real image in **49s**
 *   · the HOSTED default returns **502 after 303s** — "no finished image
 *     within 300s"
 *
 * So 180s bought nothing in either direction. It is 3.6x longer than a success
 * needs, and it still gives up two minutes before the broken one admits defeat.
 * All that extra patience does is spend a coding agent's round budget waiting
 * for an answer that was never coming.
 *
 * ⭐ 90s is comfortably twice the measured success and short enough that a dead
 * provider costs one round instead of the session. The breaker then makes sure
 * we only pay it once. If a provider genuinely needs longer than 90 seconds to
 * draw a picture, it does not belong in an interactive loop.
 */
const FETCH_TIMEOUT_MS = 90_000;

/**
 * ── ⭐⭐ EVERYONE GETS PERCHANCE. IT IS BAKED IN, NOT CONFIGURED. ────────────
 *
 * Roman, 2026-08-10: *"perchance is our native image gen, it will be baked
 * inside of Acuvo CLI, it's a no brainer — like Gemini having their image model
 * activated when asked. Inside Gemini Code ours is perchance, and FAL for
 * premium users alongside perchance. Everyone gets perchance."*
 *
 * ⚠️ AND UNTIL NOW THAT WAS FALSE FOR EVERY INSTALLED COPY. `configured` was
 * `base.length > 0` against an env var, so `generate_image` was offered only on
 * a machine where somebody had already set `PERCHANCE_IMAGE_URL` — i.e. ours,
 * with a dev server on localhost:8080. Anyone who cloned the CLI got no image
 * capability at all and no indication that one existed. A native capability
 * that requires the user to know a URL is not native; it is a hidden feature.
 *
 * ⭐ THE DEFAULT IS NOW NATIVE — no URL at all. `generateThroughProviders` goes
 * straight to perchance.org over HTTP/2 when this variable is unset, and this
 * hosted endpoint is only used when someone points at it explicitly.
 *
 * ⚠️ RETIRED AS A DEFAULT BECAUSE IT WAS THREE PROBLEMS AT ONCE, all measured:
 * it returned 502 after 303 seconds (so it never worked for anybody who
 * installed this), it was an unauthenticated compute bill payable by us from
 * every installed copy, and it routed a stranger's prompt through OUR server.
 * Going direct removes all three, and it is 100x faster.
 *
 * Kept exported because `PERCHANCE_IMAGE_URL` may still point here, and because
 * deleting the constant would silently change what an existing config means.
 */
export const DEFAULT_IMAGE_URL = 'https://xxiautomate-star--acuvo-perchance-images-serve.modal.run';

export function imageConfig(env = process.env) {
  const override = (env[IMAGE_URL_ENV] || '').trim();
  /**
   * ⚠️ AN EXPLICIT EMPTY STRING IS NOT "USE THE DEFAULT" — but an UNSET variable
   * is. Someone who sets `PERCHANCE_IMAGE_URL=` is deliberately turning the
   * capability off (an air-gapped machine, a policy that forbids the call), and
   * silently reinstating our endpoint would override an intentional decision.
   */
  const disabled = IMAGE_URL_ENV in env && override === '';
  const base = disabled ? '' : (override || DEFAULT_IMAGE_URL);
  return {
    base,
    token: (env[IMAGE_TOKEN_ENV] || '').trim(),
    configured: base.length > 0,
    // ⭐ Reported so the CLI can say WHICH engine answered — a user debugging a
    // bad image needs to know whether it came from us or from their override.
    usingDefault: !disabled && !override,
  };
}

/**
 * The service's route is `POST /generate`. Accept the env var with or WITHOUT
 * the path — a bare host 404'd silently the first time this was wired in the
 * console, and repeating that here would produce the same ten-minute mystery.
 */
export function generateEndpoint(base) {
  const trimmed = base.replace(/\/$/, '');
  return trimmed.endsWith('/generate') ? trimmed : `${trimmed}/generate`;
}

/**
 * ⚠️ THE FILENAME IS DERIVED FROM THE PROMPT, NOT SUPPLIED BY THE MODEL, and
 * then passed through the executor's own path safety. A model choosing where to
 * write a binary is the same traversal risk as any other write, and giving it a
 * separate un-checked path parameter would quietly reopen the hole
 * `workspace.mjs` exists to close.
 */
export function suggestFilename(prompt) {
  const slug = String(prompt || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';
  return `${slug}.png`;
}

/**
 * Ask the service for one image and write it into the workspace.
 *
 * `executor` supplies the path safety — the bytes are written through
 * `resolveWritablePath` exactly like any other file, so an image cannot land
 * anywhere a `write_file` could not.
 */
export async function generateViaService(
  { prompt, width = 1200, height = 800, executor, env = process.env, fetchImpl = fetch },
) {
  const cfg = imageConfig(env);
  if (!cfg.configured) {
    return {
      ok: false,
      error:
        `No ${IMAGE_URL_ENV} in the environment, so there is no image service to ask.\n` +
        `Deploy it with:  modal deploy gpu/modal/perchance_images.py\n` +
        `then set ${IMAGE_URL_ENV} to the URL Modal returns.`,
    };
  }
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'an image needs a prompt' };

  const rel = suggestFilename(prompt);
  /**
   * ⚠️ RESOLVED THROUGH THE EXECUTOR'S OWN PATH SAFETY, and resolved BEFORE the
   * 54-second render. Discovering the destination is refused AFTER the wait is a
   * minute of someone's life spent on nothing, and reusing `resolveInWorkspace`
   * means an image can never land somewhere a `write_file` could not — one
   * safety rule, not a second one written for binaries.
   */
  const dest = resolveInWorkspace(executor.root, rel, 'write');
  if (!dest.ok) return { ok: false, error: dest.reason };

  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;

  /**
   * ⚠️ THE BREAKER GOES HERE, AND THIS EXACT CALL IS WHY IT EXISTS. Measured on
   * a real four-page website build: the service was down, every attempt waited
   * the full 180s, and the model tried three times across two rounds — six
   * minutes of a five-round budget — because the error below used to end with
   * "try once more". It read that as an instruction, which it is.
   */
  const endpoint = generateEndpoint(cfg.base);
  const alreadyDead = deadReason(endpoint);
  if (alreadyDead) {
    return {
      ok: false,
      error: skipMessage('The image service', endpoint),
      // ⚠️ See `reasonOf` below: the sentence above ENDS in an order, and this
      // failure may yet be followed by a successful fallback.
      reason: `the self-hosted image service did not answer earlier this run (${alreadyDead})`,
    };
  }

  let res;
  try {
    res = await throughBreaker(endpoint, 'The image service', () => fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: String(prompt).trim(), width, height }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }));
  } catch (err) {
    /**
     * ⚠️ NO LONGER "try once more". A cold container is still the likeliest
     * cause, but the advice has to be aimed at the reader — and the reader is a
     * model with a round budget, not a human who can wait and come back. The
     * breaker has already recorded this endpoint, so a second call in this run
     * returns instantly.
     */
    const why = err?.name === 'TimeoutError'
      ? `no response in ${FETCH_TIMEOUT_MS / 1000}s (it may be cold starting, but waiting again would cost another ${FETCH_TIMEOUT_MS / 1000}s)`
      : String(err?.message || err);
    return {
      ok: false,
      error: `image service unreachable: ${why}. Continue without the image — do not call this tool again in this run — and say in your summary that it was unavailable.`,
      reason: `the self-hosted image service was unreachable (${why})`,
    };
  }

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 200);
    return {
      ok: false,
      error: res.status === 401
        ? `image service returned 401 — ${IMAGE_TOKEN_ENV} must match the service's SHARED_TOKEN (same value, two different names)`
        : `image service returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
    };
  }

  let b64;
  try {
    const json = await res.json();
    b64 = json?.image_b64;
  } catch {
    return { ok: false, error: 'image service returned a body that was not JSON' };
  }
  // ⚠️ A 200 WITH NO IMAGE IS A FAILURE, NOT AN EMPTY IMAGE. Writing a zero-byte
  // PNG would leave a broken file on disk that looks like a successful result —
  // the same rule the render audit states about empty measurements.
  if (typeof b64 !== 'string' || b64.length < 100) {
    return { ok: false, error: 'image service returned no image' };
  }

  const bytes = Buffer.from(b64, 'base64');
  try {
    writeFileSync(dest.absolute, bytes);
  } catch (err) {
    return { ok: false, error: `could not write ${rel}: ${String(err?.message || err)}` };
  }
  return { ok: true, path: rel, bytes: bytes.length, width, height, provider: 'perchance' };
}

/**
 * ── ⭐⭐ OUR OWN GPU — THE ENGINE THAT CANNOT BE TAKEN AWAY ──────────────────
 *
 * Measured live 2026-08-12, three renders through this exact endpoint:
 *
 *   cold start  13.1s · then 10.5s · 8.9s · 8.8s   A10G, segmind/SSD-1B
 *   1024×1024 PNG, 1.0–1.8MB, and the pictures are GOOD — correct bicycle spoke
 *   and chain geometry, real depth of field, a usable corporate headshot.
 *
 * ⭐ WHY THIS IS THE PRIMARY AND NOT A THIRD OPTION. Every free image source we
 * have leaned on has closed: Perchance now answers `{"status":"not_verified"}`
 * behind a human verification wall — measured through our own headless browser,
 * which hung and had to be aborted at 150s — and Pollinations throttles from
 * 2.6s to 45s once you actually use it. This one is ours. Nobody can put a wall
 * in front of it, and at roughly $0.003 a render on an A10G there is no reason
 * to be renting the floor.
 *
 * ⚠️ IT FAILS SHUT WITHOUT A SECRET, and that is deliberate on a PAID GPU. A
 * missing credential must never mean "open to everyone" — the service itself
 * enforces this (it returns `{"ok":false,"error":"unauthorised"}`, verified),
 * and the client agrees rather than firing a request that cannot succeed. With
 * no secret this leg is DARK, not broken, and the chain moves on quietly.
 *
 * ⚠️ THE TIMEOUT IS 120s, NOT 60s, and that is the whole reason this capability
 * looked dead for a week. A cold container spends its first seconds pulling
 * 4.5GB of weights; the console's 60s budget aborted before the GPU had
 * finished waking, so a WORKING engine reported as unreachable. The failure was
 * never in the model — it was in the caller's patience.
 */
export const ENGINE_URL_ENV = 'ACUVO_IMAGE_ENGINE_URL';
export const ENGINE_SECRET_ENV = 'ACUVO_IMAGE_SECRET';
export const DEFAULT_ENGINE_URL = 'https://xxiautomate-star--acuvo-image-engine-engine-web.modal.run';
export const ENGINE_TIMEOUT_MS = 120_000;

export function engineConfig(env = process.env) {
  const override = (env[ENGINE_URL_ENV] || '').trim();
  const disabled = ENGINE_URL_ENV in env && override === '';
  const base = disabled ? '' : (override || DEFAULT_ENGINE_URL);
  const secret = (env[ENGINE_SECRET_ENV] || env.MODAL_VIDEO_SECRET || '').trim();
  return { base, secret, configured: base.length > 0 && secret.length > 0 };
}

export async function generateViaOwnEngine(
  { prompt, width = 1024, height = 1024, seed = null, executor, env = process.env, fetchImpl = fetch },
) {
  const cfg = engineConfig(env);
  if (!cfg.configured) {
    return {
      ok: false,
      error: `our own image engine is not configured — set ${ENGINE_SECRET_ENV} (the shared secret the Modal service expects).`,
      reason: `our own GPU engine is dark (no ${ENGINE_SECRET_ENV})`,
    };
  }
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'an image needs a prompt' };

  const rel = suggestFilename(prompt);
  const dest = resolveInWorkspace(executor.root, rel, 'write');
  if (!dest.ok) return { ok: false, error: dest.reason };

  const endpoint = `${cfg.base.replace(/\/$/, '')}/generate-image`;
  const alreadyDead = deadReason(endpoint);
  if (alreadyDead) {
    return {
      ok: false,
      error: skipMessage('Our image engine', endpoint),
      reason: `our own GPU engine did not answer earlier this run (${alreadyDead})`,
    };
  }

  let res;
  try {
    res = await throughBreaker(endpoint, 'Our image engine', () => fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.secret}` },
      /**
       * ⚠️ THE SECRET GOES IN THE BODY AS WELL AS THE HEADER, because the
       * service accepts either and a proxy that strips `Authorization` would
       * otherwise turn a working call into an unexplainable 401.
       */
      body: JSON.stringify({ prompt: String(prompt).trim(), width, height, ...(seed === null ? {} : { seed }), secret: cfg.secret }),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    }));
  } catch (err) {
    const why = err?.name === 'TimeoutError'
      ? `no response in ${ENGINE_TIMEOUT_MS / 1000}s`
      : String(err?.message || err);
    return {
      ok: false,
      error: `our image engine was unreachable: ${why}.`,
      reason: `our own GPU engine was unreachable (${why})`,
    };
  }

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 200);
    return {
      ok: false,
      error: `our image engine returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
      reason: `our own GPU engine returned HTTP ${res.status}`,
    };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'our image engine returned a body that was not JSON', reason: 'our own GPU engine returned non-JSON' };
  }

  /**
   * ⚠️⚠️ A 200 CARRYING `ok:false` IS A FAILURE. This service answers 200 with
   * `{"ok":false,"error":"unauthorised"}` — verified by sending the wrong
   * secret. Reading `res.ok` alone would have written a zero-byte PNG and
   * called it a render, which is the exact class of bug that has cost this
   * codebase more time than any other: **`res.ok` answers a question about the
   * HTTP conversation, never about whether the work happened.**
   */
  if (json?.ok === false) {
    const why = String(json.error || 'no reason given');
    return { ok: false, error: `our image engine refused: ${why}`, reason: `our own GPU engine refused (${why})` };
  }

  const b64 = json?.image_b64;
  if (typeof b64 !== 'string' || b64.length < 100) {
    return { ok: false, error: 'our image engine returned no image', reason: 'our own GPU engine returned no image' };
  }

  const bytes = Buffer.from(b64, 'base64');
  try {
    writeFileSync(dest.absolute, bytes);
  } catch (err) {
    return { ok: false, error: `could not write ${rel}: ${String(err?.message || err)}` };
  }
  return {
    ok: true,
    path: rel,
    bytes: bytes.length,
    width: json.width ?? width,
    height: json.height ?? height,
    provider: 'acuvo-gpu',
    model: json.model ?? null,
    renderMs: json.render_ms ?? null,
  };
}

/**
 * ── ⭐⭐ THE FLOOR: A KEYLESS IMAGE PROVIDER THAT NEEDS NO ACCOUNT ───────────
 *
 * Pollinations serves an image from a plain GET with no key and no signup.
 * Measured 2026-08-10: HTTP 200, a 40KB JPEG of a genuinely usable product
 * photograph, in **2.2 seconds**.
 *
 * ⭐ WHY THIS IS STRATEGIC AND NOT A STOPGAP. It makes image generation work on
 * EVERY install with zero configuration: clone, set one model key, and the agent
 * can put real imagery in a page. A capability that needs a second account is a
 * capability most people never see — the same trap `DEFAULT_IMAGE_URL` was
 * written to escape, one level deeper.
 *
 * ── ⚠️ IT IS FREE. IT IS NOT UNLIMITED, AND THIS COMMENT USED TO SAY IT WAS ──
 * The previous line read "no quota to configure", which is true and reads as
 * "no quota". Measured 2026-08-11 on three consecutive images through this exact
 * function: **2.6s, then 44.9s, then 45.9s.** Nothing changed but the call
 * count. It is a shared free service that throttles whoever leans on it, so a
 * build that wants six heroes should expect to wait, and nothing here may be
 * sold as unlimited free imagery. Infinite is a courtesy, not a contract.
 *
 * ⚠️ AND IT IS A FALLBACK, NOT A REPLACEMENT — a point that got sharper the day
 * the preferred engine closed its door, because "the fallback" has quietly
 * become the engine drawing nearly every image. The caller is TOLD which one
 * produced the file, because a user debugging a disappointing image has to know
 * whose model made it, and because a substitution nobody announces is how "our
 * image model" becomes a claim no one can check.
 */
export function pollinationsUrl(prompt, width, height, { seed = null } = {}) {
  const q = new URLSearchParams({ width: String(width), height: String(height), nologo: 'true' });
  if (seed !== null) q.set('seed', String(seed));
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(String(prompt).trim())}?${q}`;
}

/** Long enough for a real render, short enough that a failure is still a demo. */
const POLLINATIONS_TIMEOUT_MS = 90_000;

export async function generateViaPollinations(
  { prompt, width = 1200, height = 800, executor, fetchImpl = fetch },
) {
  const url = pollinationsUrl(prompt, width, height);
  const dead = deadReason(url);
  if (dead) {
    return {
      ok: false,
      error: skipMessage('The fallback image service', url),
      reason: `the fallback image service did not answer earlier this run (${dead})`,
    };
  }

  let res;
  try {
    res = await throughBreaker(url, 'The fallback image service', () => fetchImpl(url, {
      signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS),
    }));
  } catch (err) {
    return { ok: false, error: `fallback image service unreachable: ${err?.name ?? err}` };
  }
  if (!res.ok) return { ok: false, error: `fallback image service returned HTTP ${res.status}` };

  const bytes = Buffer.from(await res.arrayBuffer());
  /**
   * ⚠️ A 200 WITH NO IMAGE IS A FAILURE, NOT AN EMPTY IMAGE — the same rule the
   * primary follows. An error page served with status 200 is a real thing this
   * provider does, and writing it to disk as `hero.jpg` would put a broken file
   * in someone's page and call it success.
   */
  if (bytes.length < 1000) return { ok: false, error: 'fallback image service returned no image' };
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.subarray(0, 4).toString('hex') === '89504e47';
  if (!isJpeg && !isPng) return { ok: false, error: 'fallback image service returned something that is not an image' };

  /**
   * ⚠️ NAMED FOR WHAT IT ACTUALLY IS. This provider returns JPEG; writing those
   * bytes to a `.png` produces a file every browser still displays and every
   * image tool refuses — a mismatch nobody finds until it matters.
   */
  const rel = suggestFilename(prompt).replace(/\.png$/, isJpeg ? '.jpg' : '.png');
  const dest = resolveInWorkspace(executor.root, rel, 'write');
  if (!dest.ok) return { ok: false, error: dest.reason };
  try {
    writeFileSync(dest.absolute, bytes);
  } catch (err) {
    return { ok: false, error: `could not write ${rel}: ${String(err?.message || err)}` };
  }
  return { ok: true, path: rel, bytes: bytes.length, width, height, provider: 'pollinations' };
}

/**
 * ── ⭐ NEVER SINGLE. THIS FILE WAS THE LAST PLACE THAT WAS. ─────────────────
 *
 * "Never single" has been doctrine for the model chain since the beginning, and
 * image generation quietly ignored it — one provider, and when it went down the
 * capability went down with it, taking nine minutes of a session with it.
 *
 * ⚠️ ORDER MATTERS AND SO DOES THE BREAKER. When the primary is already known
 * dead this run, the fallback is reached in milliseconds rather than after
 * another 180-second wait — that combination is what turns "images are broken"
 * into "images took two seconds".
 */
/**
 * ── ⭐⭐ PERCHANCE, DIRECT. THE DEFAULT IS NOW NATIVE. ───────────────────────
 *
 * `lib/perchance.mjs` talks to perchance.org itself over HTTP/2 — no browser, no
 * Modal, no dependency, 5.2s for a real image. This is the wrapper that puts
 * those bytes into the workspace through the same path safety as any other write.
 *
 * ⭐ IT ALSO RETIRES THE HOSTED DEFAULT, WHICH WAS THREE PROBLEMS AT ONCE:
 * it returned 502 after 303 seconds (so it never worked for anyone who installed
 * this), it was an unauthenticated compute bill from every copy, and it meant a
 * stranger's prompt travelled to OUR server. Going direct removes all three.
 * `PERCHANCE_IMAGE_URL` still overrides, for anyone running their own instance.
 */
/**
 * The breaker keys on a URL. The native path never builds one — it is four calls
 * to four routes — so it gets a stable identity of its own. Naming the real host
 * matters: this string is what a later `skipMessage` puts in front of a user.
 */
export const NATIVE_PERCHANCE_ID = 'https://image-generation.perchance.org (native)';

/**
 * ── ⚠️⭐ A CLOSED DOOR IS NOT A BAD REQUEST, AND NOT AN OUTAGE EITHER ────────
 *
 * `breaker.mjs` says in its own header: *"IT TRIPS ON UNREACHABLE, NEVER ON A
 * REFUSAL"* — because an HTTP 400 means THIS request was wrong and the next may
 * be right, and disabling a working service over one bad prompt is worse than
 * the outage it imitates. That rule stands, and this function does not bend it.
 *
 * ⭐ THE DISTINCTION THE RULE WAS MISSING IS *WHOSE* REFUSAL IT IS. A refusal
 * can be about the REQUEST (retry may help) or about the CALLER (retry cannot).
 * Measured live 2026-08-11, four consecutive calls, seconds apart:
 *
 *     verifyUser -> {"status":"failed_verification","reason":"token_required"}
 *     verifyUser -> {"status":"failed_verification","reason":"token_required"}
 *     verifyUser -> {"status":"failed_verification","reason":"token_required"}
 *     verifyUser -> {"status":"failed_verification","reason":"token_required"}
 *
 * Identical every time, with four different prompts behind them. Perchance has
 * closed anonymous access — a POLICY change, not a fault. Nothing a later call
 * in this process can carry will change the answer, so paying 0.4s for it on
 * every image of a build buys precisely nothing.
 *
 * ⚠️ THE LIST IS DELIBERATELY SHORT, and everything on it is prompt-independent:
 *   · `token_required` / `failed_verification` — the gate, measured above.
 *   · a Cloudflare challenge — we are not being let in at all.
 *   · `invalid_parameter` — `perchance.mjs` already states this one is our own
 *     shape drift and *"retrying will not help"*; it is a fact about the client,
 *     which is the same request every time.
 * A short read, a bad byte count, a timeout — none of those are here. They are
 * ordinary failures, they may well succeed next time, and treating them as a
 * closed door would be the guard failing correct work.
 */
export function isProviderClosed({ error, challenged } = {}) {
  if (challenged === true) return true;
  return /token_required|failed_verification|invalid_parameter/i.test(String(error ?? ''));
}

async function generateViaNativePerchance({
  prompt, width = 1200, height = 800, executor, nativeImpl = generateNative,
}) {
  /**
   * ⚠️ THE BREAKER, ON THE PATH THAT DID NOT HAVE IT. When the hosted default
   * was retired for the direct route, the direct route was wired straight to
   * `generateNative` — no breaker, no skip, no memory. That was invisible while
   * Perchance worked and became the whole cost model the day it stopped.
   */
  const closed = deadReason(NATIVE_PERCHANCE_ID);
  if (closed) {
    return {
      ok: false,
      skipped: true,
      error: skipMessage('Perchance', NATIVE_PERCHANCE_ID),
      reason: `Perchance is not serving this run (${closed})`,
    };
  }

  /**
   * ⚠️ THE SERVICE TAKES A SQUARE-ISH `resolution` STRING, not our width/height.
   * Snapped to what it actually offers rather than passed through, because an
   * unsupported value comes back as `invalid_parameter` and reads like an
   * outage.
   */
  const longest = Math.max(Number(width) || 0, Number(height) || 0);
  const resolution = longest >= 1024 ? '1024x1024' : longest >= 768 ? '768x768' : '512x512';

  const r = await nativeImpl({ prompt, resolution });
  if (!r.ok) {
    if (isProviderClosed(r)) {
      markUnreachable(NATIVE_PERCHANCE_ID, 'it now requires a token we do not have');
      return {
        ok: false,
        error: `perchance: ${r.error}`,
        /**
         * ⭐ NAMED AS A POLICY CHANGE RATHER THAN A FAILURE, because the two want
         * opposite responses and the reader is a model. "Unreachable" invites a
         * retry and a bug report about our networking; "they closed the door"
         * invites neither. Our HTTP/2 fingerprint still works — we get a real
         * JSON answer back, not a Cloudflare wall — so this is not a defeat of
         * the transport and must not be reported as one.
         */
        reason: 'Perchance now requires an account token for image generation, so anonymous access is closed to us',
      };
    }
    return { ok: false, error: `perchance: ${r.error}`, reason: `Perchance could not draw it (${r.error})` };
  }

  const rel = suggestFilename(prompt).replace(/\.png$/, r.mimeType === 'image/png' ? '.png' : '.jpg');
  const dest = resolveInWorkspace(executor.root, rel, 'write');
  if (!dest.ok) return { ok: false, error: dest.reason };
  try {
    writeFileSync(dest.absolute, r.bytes);
  } catch (err) {
    return { ok: false, error: `could not write ${rel}: ${String(err?.message || err)}` };
  }
  return {
    ok: true, path: rel, bytes: r.bytes.length, width, height,
    provider: 'perchance', seed: r.seed,
    // ⚠️ Passed up, not dropped. The caller is about to put this in a page.
    ...(r.maybeNsfw ? { maybeNsfw: true } : {}),
  };
}

/**
 * ── ⚠️⭐ AN ERROR STRING IS AN INSTRUCTION, AND ONE OF THESE RIDES A SUCCESS ──
 *
 * A provider's `error` is written for the case where the whole tool failed, so
 * it ends in an order: *"do not call this tool again in this run"*. That is
 * exactly right when there is no image, and it is a bug the moment the FALLBACK
 * succeeds — because the same sentence gets bolted to `fellBackFrom` on a result
 * that contains a perfectly good picture, and the model reads it literally and
 * stops asking for imagery it could have had.
 *
 * ⭐ So every provider now carries a second string: `reason` states the FACT and
 * commands nothing. `error` is for the dead end, `reason` is for the footnote.
 * Splitting them beat trying to strip the imperative out of one string, which is
 * the kind of regex that works until someone rewords the sentence.
 */
function reasonOf(result, fallbackText) {
  return result?.reason || fallbackText || result?.error || 'it did not answer';
}

export async function generateThroughProviders(args) {
  const env = args.env ?? process.env;

  /**
   * ⚠️ AN EXPLICIT `PERCHANCE_IMAGE_URL=` STILL MEANS OFF, for the whole
   * Perchance path — someone who disabled it did so deliberately and must not be
   * handed the native route as a surprise substitute.
   */
  const perchanceDisabled = IMAGE_URL_ENV in env && (env[IMAGE_URL_ENV] || '').trim() === '';
  let primaryError = 'the primary image service is switched off in this environment';
  let primaryReason = primaryError;

  /**
   * ── ⭐⭐ OUR OWN GPU GOES FIRST ──────────────────────────────────────────
   *
   * It was third — behind a service now sitting behind a human verification
   * wall, and a free endpoint that throttles to 45s under real use. Measured
   * 2026-08-12: ours renders a 1024×1024 PNG in 8.8–10.5s warm, and the
   * pictures are good enough to ship.
   *
   * ⚠️ IT IS SKIPPED SILENTLY WHEN DARK, not reported as a failure. Without a
   * secret there is nothing broken to tell anyone about, and a chain that
   * announces every unconfigured leg trains the reader to ignore it.
   */
  const own = await generateViaOwnEngine(args);
  if (own.ok) return own;
  if (engineConfig(env).configured) {
    primaryError = own.error;
    primaryReason = reasonOf(own);
  }

  if (!perchanceDisabled) {
    // A configured URL means "use my server"; unset means "go direct".
    const useOwnServer = Boolean((env[IMAGE_URL_ENV] || '').trim());
    const primary = useOwnServer ? await generateViaService(args) : await generateViaNativePerchance(args);
    if (primary.ok) return primary;
    primaryError = primary.error;
    primaryReason = reasonOf(primary);
  }

  const fallback = await generateViaPollinations(args);
  if (fallback.ok) {
    // ⭐ Said out loud. The model should know it did not get the preferred
    // engine, because it may want to mention that to the user — and because a
    // silent substitution is how "our image model" becomes an unverifiable claim.
    return { ...fallback, fellBackFrom: primaryReason };
  }

  return {
    ok: false,
    error: `both image providers failed. Primary: ${primaryReason}. Fallback: ${reasonOf(fallback)}. `
      + 'Continue without the image — do not call this tool again in this run — and say in your summary that imagery was unavailable.',
  };
}

/**
 * ── ⭐⭐ THE TOOL NOW HAS TASTE, AND THE SCHEMA DID NOT CHANGE ───────────────
 *
 * `generate_image` used to be: one prompt, one shot, whatever came back, written
 * to disk and referenced in the page. The agent cannot see, so a smeared
 * illegible hero got shipped across four pages with total confidence — that
 * happened today, on our own coffee site.
 *
 * ⭐ Direction and criticism now wrap the provider chain: the prompt is composed
 * like a photograph rather than described like a noun, and the result is LOOKED
 * AT before it is accepted. The tool's name, parameters and return shape are
 * unchanged, so nothing downstream needed rewiring — the capability simply got
 * better underneath.
 *
 * ⚠️ TWO ATTEMPTS, NOT THREE. Measured: three attempts on a structurally
 * impossible subject scored 2, 2, 2 and cost 100 seconds. This is a coding
 * agent's round budget being spent, not an art department's afternoon.
 *
 * ⚠️ AND THE CRITIC IS SKIPPED WITHOUT A KEY rather than assumed to approve.
 * `accepted:false` on an unlooked-at image is the honest report, and the same
 * rule the render audit had to learn the hard way.
 */
export async function generateImage(args) {
  const env = args.env ?? process.env;
  const apiKey = env.OPENROUTER_API_KEY;

  const directed = await directImage({
    prompt: args.prompt,
    // Each attempt goes through the full provider chain, so a re-shoot still
    // gets primary-then-fallback rather than being pinned to whoever answered.
    generate: ({ prompt }) => generateThroughProviders({ ...args, prompt }),
    readBytes: (shot) => {
      try { return readFileSync(join(args.executor.root, shot.path)); } catch { return null; }
    },
    maxAttempts: 2,
    apiKey,
    fetchImpl: args.criticFetch ?? fetch,
  });

  if (!directed.ok) return directed;

  /**
   * ── ⭐ WHOSE MODEL DREW THIS. IT USED TO BE UNSAYABLE. ──────────────────────
   *
   * `provider` and `fellBackFrom` have always been on the returned object, and
   * `note` — the one string written to be read out loud — never mentioned
   * either. So a Perchance image and a Pollinations image produced word-for-word
   * identical reports, and on the day Perchance closed its door EVERY image
   * silently came from the free last resort with nothing in the text to say so.
   *
   * ⚠️ These are not interchangeable engines. The one we preferred was the one
   * that could put legible lettering in a picture; the one answering now is a
   * free shared service that throttles. Substituting is fine. Substituting
   * quietly is how a user spends an afternoon blaming their prompt.
   */
  const engine = PROVIDER_LABELS[directed.provider] ?? directed.provider ?? 'an unnamed engine';
  const drawnBy = directed.fellBackFrom
    ? `Drawn by ${engine}, after the preferred engine was unavailable: ${directed.fellBackFrom}.`
    : `Drawn by ${engine}.`;

  /**
   * ⚠️ THE SCORE TRAVELS BACK TO THE MODEL. Without it the agent writes
   * `<img src="hero.jpg">` and moves on regardless — which is precisely the
   * behaviour that put a garbled label on four pages. With it, a low score is a
   * fact it can act on or mention.
   */
  const review = directed.score === null
    ? 'This image was NOT reviewed (no critic available), so nothing confirms it looks right.'
    : directed.accepted
      ? `Reviewed and accepted (${directed.score}/10).`
      : `⚠️ Reviewed and NOT accepted (${directed.score}/10): ${(directed.problems ?? []).slice(0, 2).join('; ')}. `
        + 'It is the best of the attempts and it is on disk. Use it if imagery matters less than shipping, '
        + 'or choose a different subject — re-running the same request will not help.';

  return { ...directed, note: `${drawnBy} ${review}` };
}

/**
 * ⚠️ NAMED, NOT SLUGGED. `provider` is an identifier; this is the thing a human
 * reads in a summary, so it says what the engine IS — including, for the free
 * one, that it is the free one.
 */
const PROVIDER_LABELS = {
  perchance: 'Perchance',
  pollinations: 'Pollinations (the free fallback engine — shared, and it throttles under repeated use)',
};

/** The tool schema, offered only when the service is configured. */
export function imageToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'generate_image',
      /**
       * ── ⚠️ THIS TEXT IS RE-READ BY THE MODEL ON EVERY CALL ─────────────────
       * so a stale claim in it is repeated for as long as it stands. Two were
       * stale, both measured 2026-08-11:
       *   · "about a minute per image" — the chain answered in **2.6s**. A
       *     wildly pessimistic cost teaches the model to avoid a capability that
       *     is cheap, which is the same damage as an over-promise, pointed the
       *     other way.
       *   · "save it into the workspace as a .png" — the engine actually serving
       *     us returns JPEG, and the extension follows the bytes precisely so a
       *     `.png` full of JPEG never reaches someone's disk. The schema was
       *     promising the one thing the code deliberately refuses to do.
       * ⭐ The honest number is a RANGE, because the free engine throttles: 2.6s
       * for the first image of a run, 45s for the third. Both measured, minutes
       * apart, same function.
       */
      description: [
        'Generate a real image from a text prompt and save it into the workspace.',
        'The file is a .png or a .jpg — the extension follows whatever the engine returns,',
        'so use the exact path from the result rather than assuming one.',
        'Use it when the user asks for imagery, or when a page you are building needs a hero',
        'or illustration — reference the returned path from your HTML.',
        '⚠️ Usually a few seconds, but it runs on a shared free engine that throttles:',
        'the third image of a run can take ~45s. Ask for one only when it is genuinely wanted,',
        'and never generate images speculatively while iterating on code.',
        'Write GOOD prompts: subject, style, lighting, composition. The quality is on the prompt.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'A rich, specific description — subject, style, lighting, lens, mood.',
          },
          width: { type: 'number', description: 'Pixels wide. Default 1200.' },
          height: { type: 'number', description: 'Pixels tall. Default 800.' },
        },
        required: ['prompt'],
      },
    },
  };
}
