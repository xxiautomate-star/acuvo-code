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
 * ── ⭐⭐ IT IS NOW 3 SECONDS, AND IT USED TO BE 54 ────────────────────────────
 * This block used to argue that ~54s was inherent and not a bug to fix, because
 * "Perchance is a real browser driving a real web app". That was true of our
 * IMPLEMENTATION, not of Perchance. `lib/perchance.mjs` now talks to the service
 * directly over HTTP/2 — measured 3.0s end to end through this file, with no
 * browser, no Modal and no dependency.
 *
 * ⚠️ The lesson is worth more than the speed: the constraint everyone accepted
 * was an artefact of the first thing that worked. Nobody re-measured it for
 * months, and the comment defending it made it look decided.
 *
 * ⭐ At 3s the old advice inverts. It is still not free, so it should not be
 * called speculatively in a tight loop — but it is now fast enough to belong in
 * an ordinary build, which is the whole reason a coding agent can hand you a
 * page with a real hero on it.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInWorkspace } from './workspace.mjs';
import { throughBreaker, deadReason, skipMessage } from './breaker.mjs';
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
  if (alreadyDead) return { ok: false, error: skipMessage('The image service', endpoint) };

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
 * ── ⭐⭐ THE FLOOR: A KEYLESS IMAGE PROVIDER THAT NEEDS NO ACCOUNT ───────────
 *
 * Pollinations serves an image from a plain GET with no key, no signup and no
 * quota to configure. Measured today: HTTP 200, a 40KB JPEG of a genuinely
 * usable product photograph, in **2.2 seconds** — against the 180-second
 * timeout the primary service was spending to return nothing.
 *
 * ⭐ WHY THIS IS STRATEGIC AND NOT A STOPGAP. It makes image generation work on
 * EVERY install with zero configuration: clone, set one model key, and the agent
 * can put real imagery in a page. A capability that needs a second account is a
 * capability most people never see — the same trap `DEFAULT_IMAGE_URL` was
 * written to escape, one level deeper.
 *
 * ⚠️ AND IT IS A FALLBACK, NOT A REPLACEMENT. The primary is ours: our prompt
 * handling, our model choice, our terms. This runs when ours cannot answer, and
 * the caller is TOLD which one produced the file, because a user debugging a
 * disappointing image has to know whose model made it.
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
  if (deadReason(url)) return { ok: false, error: skipMessage('The fallback image service', url) };

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
async function generateViaNativePerchance({ prompt, width = 1200, height = 800, executor }) {
  /**
   * ⚠️ THE SERVICE TAKES A SQUARE-ISH `resolution` STRING, not our width/height.
   * Snapped to what it actually offers rather than passed through, because an
   * unsupported value comes back as `invalid_parameter` and reads like an
   * outage.
   */
  const longest = Math.max(Number(width) || 0, Number(height) || 0);
  const resolution = longest >= 1024 ? '1024x1024' : longest >= 768 ? '768x768' : '512x512';

  const r = await generateNative({ prompt, resolution });
  if (!r.ok) return { ok: false, error: `perchance: ${r.error}` };

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

export async function generateThroughProviders(args) {
  const env = args.env ?? process.env;
  const cfg = imageConfig(env);

  /**
   * ⚠️ AN EXPLICIT `PERCHANCE_IMAGE_URL=` STILL MEANS OFF, for the whole
   * Perchance path — someone who disabled it did so deliberately and must not be
   * handed the native route as a surprise substitute.
   */
  const perchanceDisabled = IMAGE_URL_ENV in env && (env[IMAGE_URL_ENV] || '').trim() === '';
  let primaryError = 'the primary image service is switched off in this environment';

  if (!perchanceDisabled) {
    // A configured URL means "use my server"; unset means "go direct".
    const useOwnServer = Boolean((env[IMAGE_URL_ENV] || '').trim());
    const primary = useOwnServer ? await generateViaService(args) : await generateViaNativePerchance(args);
    if (primary.ok) return primary;
    primaryError = primary.error;
  }

  const fallback = await generateViaPollinations(args);
  if (fallback.ok) {
    // ⭐ Said out loud. The model should know it did not get our engine, because
    // it may want to mention that to the user — and because a silent substitution
    // is how "our image model" becomes an unverifiable claim.
    return { ...fallback, fellBackFrom: primaryError };
  }

  return {
    ok: false,
    error: `both image providers failed. Primary: ${primaryError} Fallback: ${fallback.error} `
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
   * ⚠️ THE SCORE TRAVELS BACK TO THE MODEL. Without it the agent writes
   * `<img src="hero.jpg">` and moves on regardless — which is precisely the
   * behaviour that put a garbled label on four pages. With it, a low score is a
   * fact it can act on or mention.
   */
  const note = directed.score === null
    ? 'This image was NOT reviewed (no critic available), so nothing confirms it looks right.'
    : directed.accepted
      ? `Reviewed and accepted (${directed.score}/10).`
      : `⚠️ Reviewed and NOT accepted (${directed.score}/10): ${(directed.problems ?? []).slice(0, 2).join('; ')}. `
        + 'It is the best of the attempts and it is on disk. Use it if imagery matters less than shipping, '
        + 'or choose a different subject — re-running the same request will not help.';

  return { ...directed, note };
}

/** The tool schema, offered only when the service is configured. */
export function imageToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'generate_image',
      description: [
        'Generate a real image from a text prompt and save it into the workspace as a .png.',
        'Use it when the user asks for imagery, or when a page you are building needs a hero',
        'or illustration — reference the returned path from your HTML.',
        '⚠️ It takes about a minute per image, so ask for one only when it is genuinely wanted;',
        'never generate images speculatively while iterating on code.',
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
