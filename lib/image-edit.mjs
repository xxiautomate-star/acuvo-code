/**
 * ── ⭐⭐ CHANGING PART OF A PICTURE, INSTEAD OF THROWING IT AWAY ─────────────
 *
 * Until now this agent had exactly one image verb: make a new one. So "the hero
 * is great, just lose the sign on the van" meant regenerating the whole
 * photograph and losing everything that was already right about it. That is not
 * an edit, it is a re-roll, and it is why generated pages drift.
 *
 * Two engines that were deployed, healthy, paid for, and called by nothing:
 *
 *   acuvo-select       name a thing in words -> a pixel-accurate mask of it
 *   acuvo-flux-studio  inpaint (fill a masked region) · outpaint (extend a frame)
 *
 * ⭐ NEITHER IS USEFUL ALONE, WHICH IS PROBABLY WHY BOTH STAYED DARK. Inpainting
 * needs a mask, and in a terminal there is no brush and no canvas — so the
 * inpaint verb had no door on it. `select_mask.py` says this outright in its own
 * header: it exists to BE that door. This file is the sentence that joins them.
 *
 * ── ⚠️⚠️ THE ONE THING THAT MUST NOT BE FORGOTTEN ABOUT THE SELECTOR ────────
 *
 * **It cannot tell you whether the thing is there.** Grounding DINO returns a
 * confident box for an object that is absent — the score localises, it does not
 * confirm. The worker ships `presence_verified: false` and a caveat in every
 * payload precisely so a caller cannot look at 0.95 and conclude the sofa exists.
 *
 * ⭐ SO THE SAFETY HERE IS STRUCTURAL, NOT STATISTICAL: **the source image is
 * never overwritten.** The edit lands in a new file, always, and asking to write
 * over the original is refused. A wrong selection then costs a render — about a
 * cent — instead of costing the picture. No threshold could have given that
 * guarantee, because the number being thresholded is the wrong number.
 *
 * ⚠️ AND THE CAVEAT IS PASSED THROUGH TO THE MODEL VERBATIM rather than being
 * absorbed here. The agent can LOOK at what it made (`read_image`, `see_page`) —
 * it is the only participant that can actually check, so it is the one that has
 * to be told.
 *
 * ── ⚠️ WHY THIS IS ITS OWN FILE AND NOT MORE OF `media.mjs` ─────────────────
 * media.mjs is the request/response half of five services already. This is a
 * CHAIN — select, then spawn, then poll — with its own failure modes, and a
 * second terminal is editing media.mjs in the same worktree today. A new file
 * costs one import and cannot collide.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveInWorkspace } from './workspace.mjs';
import { throughBreaker, deadReason, skipMessage } from './breaker.mjs';

export const DEFAULT_SELECT_URL = 'https://xxiautomate-star--acuvo-select-select.modal.run';
export const DEFAULT_FLUX_URL = 'https://xxiautomate-star--acuvo-flux-studio-studio.modal.run';

/**
 * ⚠️ THE POLL URL IS DERIVED, AND THE DERIVATION IS THE RISKY PART. Both
 * endpoints belong to one Modal app and differ only in the function name, so a
 * custom `MODAL_FLUX_URL` with no matching poll URL would otherwise poll the
 * spawn endpoint forever. `RENDER_AUDIT_URL` -> drive uses the same trick and
 * carries the same escape hatch: set `MODAL_FLUX_RESULT_URL` when the guess is
 * wrong, rather than discovering it as a hang.
 */
export function fluxResultUrl(studioUrl) {
  if (!studioUrl) return null;
  return studioUrl.includes('-studio.modal.run')
    ? studioUrl.replace('-studio.modal.run', '-result.modal.run')
    : null;
}

/** 12 MB. A generated hero is ~1.5 MB; anything past this is not a web image. */
const MAX_IMAGE_MB = 12;
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;

/**
 * ⚠️ SIX MINUTES, AND IT IS NOT PESSIMISM. The first call after a scale-to-zero
 * loads 34 GB of weights; the worker is async for exactly this reason and says
 * so ("HTTP 500 after 306.7s, which was the door closing, not the render
 * failing"). A warm render is ~3s, so this ceiling is only ever reached cold.
 */
const RENDER_TIMEOUT_MS = 360_000;
const POLL_EVERY_MS = 3_000;
/** The selector is ~900M parameters doing fixed work: ~2s warm, under a minute cold. */
const SELECT_TIMEOUT_MS = 120_000;

/** The aspects `flux_studio.py` accepts. Kept here so a wrong one is refused
 *  before a container is paid for, and named in the refusal. */
export const ASPECTS = ['16:9', '9:16', '4:5', '5:4', '1:1', '3:2', '2:3', '2:1', '21:9'];

/**
 * ── ⚠️⚠️ MEASURED BY LOOKING, 2026-08-12 — OUTPAINT DEGRADES WITH DISTANCE ───
 *
 * One 1200x800 photograph of a living room, widened three ways, then opened and
 * looked at rather than trusted because the call returned `ok: true`:
 *
 *   3:2 -> 16:9   +16% new width   clean. Sofa extended plausibly, faint seam.
 *   3:2 -> 2:1    +25%             the outer ~190px is a smeared red/white blur
 *   3:2 -> 21:9   +36%             both edges are vertical streaks. Unusable.
 *
 * ⭐ AND IT FAILS AS SMEAR, NOT AS AN ERROR — every one of those returned
 * `ok: true` in about the same time. The worker has a flatness guard for a
 * *blank* extension; a streak has plenty of variance and sails through it. So
 * nothing in the stack below this line can tell the difference, and a caller who
 * trusts the status code ships the streaks.
 *
 * ⚠️ THE ANSWER IS NOT TO REFUSE. 21:9 from a square is a legitimate thing to
 * want, and a capability that refuses what it can attempt is worse than one that
 * says how it will go. The number is reported, the warning names the fix, and
 * the caller is told to look.
 */
export const OUTPAINT_SAFE_ADDED = 0.20;

/**
 * Width and height from the file's own header — PNG (IHDR) and JPEG (SOFn).
 * ⚠️ NO DEPENDENCY, and no decode: this reads about twelve bytes. Bringing in an
 * image library to learn a picture's shape would break the zero-dependency rule
 * this package's whole install story rests on.
 */
export function imageDimensions(buf) {
  if (buf.length > 24 && buf.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      // SOFn carries the size; the three exceptions are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** How much of the new frame is invented, 0..1. Null when the source is unreadable. */
export function addedFraction(source, target) {
  if (!source?.width || !source?.height || !target?.width || !target?.height) return null;
  const a = source.width / source.height;
  const b = target.width / target.height;
  if (!(a > 0) || !(b > 0)) return null;
  return Math.max(0, 1 - Math.min(a, b) / Math.max(a, b));
}

export function editConfig(env = process.env) {
  const secret = env.ACUVO_MEDIA_SECRET?.trim() || env.MODAL_VIDEO_SECRET?.trim() || null;
  // Same three-state rule as media.mjs: unset -> ours · set -> theirs ·
  // explicitly empty -> off. A paid GPU service must fail shut with no secret.
  const withDefault = (k, fallback) => {
    if (k in env && (env[k] ?? '').trim() === '') return null;
    return env[k]?.trim() || (secret ? fallback : null);
  };
  const flux = withDefault('MODAL_FLUX_URL', DEFAULT_FLUX_URL);
  return {
    select: withDefault('MODAL_SELECT_URL', DEFAULT_SELECT_URL),
    flux,
    fluxResult: env.MODAL_FLUX_RESULT_URL?.trim() || fluxResultUrl(flux),
    secret,
  };
}

/** POST JSON through the breaker. Never throws — a failure is data. */
async function post(url, body, { fetchImpl = fetch, timeoutMs, label }) {
  const already = deadReason(url);
  if (already) return { ok: false, error: skipMessage(label, url) };
  try {
    const res = await throughBreaker(url, label, () => fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep the text */ }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(json?.error ?? text ?? '').toString().slice(0, 400)}` };
    // A 200 whose body says ok:false is a failure — the lesson media.mjs paid
    // four retries to learn. The service's own words go through verbatim.
    if (json && json.ok === false) {
      const detail = String(json.error ?? 'the service reported a failure with no reason').slice(0, 400);
      const auth = /unauthoris|unauthoriz|forbidden|invalid secret|401|403/i.test(detail)
        ? ' — set MODAL_VIDEO_SECRET to the value this endpoint expects (retrying will not help)'
        : '';
      return { ok: false, error: `${label} refused the request: ${detail}${auth}` };
    }
    return { ok: true, json: json ?? {} };
  } catch (err) {
    const code = err?.cause?.code || err?.name || 'unknown';
    return { ok: false, error: `could not reach ${label}: ${code}` };
  }
}

/** Read an image out of the workspace as base64, bounded. */
function loadImage(root, path) {
  const target = resolveInWorkspace(root, path, 'read');
  if (!target.ok) return { ok: false, error: target.reason };
  let buf;
  try { buf = readFileSync(target.absolute); }
  catch (err) { return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` }; }
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `${target.relative} is ${(buf.length / 1e6).toFixed(1)} MB, over the ${MAX_IMAGE_MB} MB limit for an image edit` };
  }
  return { ok: true, relative: target.relative, b64: buf.toString('base64'), dimensions: imageDimensions(buf) };
}

/**
 * ⚠️⚠️ THE OUTPUT PATH IS NEVER THE INPUT PATH. This is the whole safety model
 * of this file (see the header): the selector cannot verify presence, so the
 * only honest guarantee is that a wrong edit cannot destroy the original.
 * Refused explicitly rather than silently renamed — a caller who asked to
 * overwrite must learn that it did not happen.
 */
function outputPath(sourceRelative, requested, suffix) {
  if (requested && requested.trim()) {
    const want = requested.trim();
    if (want.replace(/\\/g, '/') === sourceRelative.replace(/\\/g, '/')) {
      return { ok: false, error: `refusing to overwrite ${sourceRelative} — an edit built on an unverified selection must not be able to destroy the original. Choose a different output path.` };
    }
    return { ok: true, path: want };
  }
  const dot = sourceRelative.lastIndexOf('.');
  const stem = dot > 0 ? sourceRelative.slice(0, dot) : sourceRelative;
  return { ok: true, path: `${stem}-${suffix}.png` };
}

function writeImage(root, rawPath, base64, dryRun) {
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
 * Spawn a flux task and wait for the picture.
 *
 * ⚠️ A POLL LOOP NEEDS A CLOCK IT DOES NOT OWN. `now` and `sleep` are injected
 * so a test can drive six minutes of polling in a millisecond — otherwise the
 * timeout branch, which is the one that matters, is the one nothing ever covers.
 */
export async function runFluxTask(task, payload, {
  env = process.env, fetchImpl = fetch,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const cfg = editConfig(env);
  if (!cfg.flux) return { ok: false, error: 'no image studio is configured (MODAL_FLUX_URL)' };
  if (!cfg.fluxResult) {
    return { ok: false, error: 'MODAL_FLUX_URL does not look like a Modal studio endpoint, so the poll URL cannot be derived — set MODAL_FLUX_RESULT_URL as well' };
  }

  const started = now();
  const queued = await post(cfg.flux, { ...payload, task, secret: cfg.secret ?? undefined }, {
    fetchImpl, timeoutMs: 60_000, label: 'the image studio',
  });
  if (!queued.ok) return queued;

  const callId = queued.json?.callId;
  if (!callId) return { ok: false, error: 'the image studio accepted the job but returned no callId, so there is nothing to poll' };

  for (;;) {
    if (now() - started > RENDER_TIMEOUT_MS) {
      return { ok: false, error: `the ${task} did not finish within ${Math.round(RENDER_TIMEOUT_MS / 1000)}s — the job may still be running on the GPU (callId ${callId})` };
    }
    await sleep(POLL_EVERY_MS);
    const poll = await post(cfg.fluxResult, { callId, secret: cfg.secret ?? undefined }, {
      fetchImpl, timeoutMs: 60_000, label: 'the image studio',
    });
    // ⚠️ A FAILED POLL IS NOT A FAILED RENDER. One dropped request must not
    // abandon a job that is still running — but a poll that says `failed` IS
    // the answer, and `post` has already turned that into ok:false.
    if (!poll.ok) return poll;
    const status = poll.json?.status;
    if (status === 'done') {
      const data = poll.json?.data;
      if (!data) return { ok: false, error: 'the image studio reported done and returned no image' };
      return { ok: true, data, seconds: Math.round((now() - started) / 1000), width: queued.json?.width ?? null, height: queued.json?.height ?? null };
    }
    if (status && status !== 'running' && status !== 'queued') {
      return { ok: false, error: `the ${task} ended as "${status}"` };
    }
  }
}

/**
 * Name a thing in an image and get a mask of it back.
 * Exported on its own because a caller may want the mask (or a cutout) without
 * an edit — and because it is the half that can be wrong.
 */
export async function selectRegion(root, path, text, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = editConfig(env);
  if (!cfg.select) return { ok: false, error: 'no selection service is configured (MODAL_SELECT_URL)' };
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'name the thing to select, e.g. "the sofa" or "the sign on the van"' };
  }
  const img = loadImage(root, path);
  if (!img.ok) return img;

  const res = await post(cfg.select, { image: img.b64, text: text.trim(), secret: cfg.secret ?? undefined }, {
    fetchImpl, timeoutMs: SELECT_TIMEOUT_MS, label: 'the selection service',
  });
  if (!res.ok) return res;

  const matched = Number(res.json?.matched ?? 0);
  if (!matched || !res.json?.mask) {
    /**
     * ⭐ NOTHING MATCHED IS AN ANSWER, AND IT IS THE GOOD FAILURE. The selector's
     * dangerous mode is the confident box for an absent object; a plain "no
     * match" is the case where it behaved. Say what was searched for, so the
     * next move is a different phrase rather than a repeat of the same one.
     */
    return { ok: false, error: `nothing in ${img.relative} matched "${text.trim()}" — try naming it differently, or more simply ("the van", not "the white delivery van on the left")` };
  }

  return {
    ok: true,
    path: img.relative,
    mask: res.json.mask,
    matched,
    labels: res.json?.labels ?? [],
    scores: res.json?.scores ?? [],
    coverage: res.json?.coverage ?? null,
    presenceVerified: false,
    caveat: res.json?.caveat ?? 'score is localisation confidence, not presence',
  };
}

/**
 * Replace a named thing in an image with something else.
 * select (mask) -> flux inpaint (fill) -> a NEW file in the workspace.
 */
export async function editImage(root, path, target, replacement, {
  env = process.env, fetchImpl = fetch, dryRun = false, out = null, now, sleep,
} = {}) {
  if (typeof replacement !== 'string' || !replacement.trim()) {
    return { ok: false, error: 'say what should be there instead — the replacement description is what gets painted in' };
  }

  const selection = await selectRegion(root, path, target, { env, fetchImpl });
  if (!selection.ok) return selection;

  const dest = outputPath(selection.path, out, 'edited');
  if (!dest.ok) return dest;

  const img = loadImage(root, path);
  if (!img.ok) return img;

  const render = await runFluxTask('inpaint', {
    image: img.b64, mask: selection.mask, prompt: replacement.trim(),
  }, { env, fetchImpl, now, sleep });
  if (!render.ok) return render;

  const written = writeImage(root, dest.path, render.data, dryRun);
  if (!written.ok) return written;

  /**
   * ── ⚠️⚠️ MEASURED BY LOOKING: A BIG MASK REPAINTS ITS NEIGHBOURS ──────────
   *
   * "the red sofa" -> "a green velvet armchair" on a real photograph, 2026-08-12.
   * The armchair arrived and was good. The left third of the room ALSO changed —
   * a wooden staircase and a glass balustrade appeared where a plain wall had
   * been, because the L-shaped sofa ran to the frame edge and the inpainter,
   * given that whole region, furnished it.
   *
   * ⭐ Coverage was 12.8%, so this is not an outlier at 50% — it is the ordinary
   * behaviour of a mask that spans a lot of frame, and it returns `ok: true`.
   * A tighter phrase ("the sofa cushions") is the fix, and it is only findable
   * if the number reaches the caller.
   */
  const coverage = Number(selection.coverage ?? 0);
  const spread = coverage > 0.10
    ? `the selection covers ${Math.round(coverage * 100)}% of the frame; inpainting a region this large routinely repaints its surroundings too (measured: a 13% mask invented a staircase). A more specific phrase gives a safer edit.`
    : null;

  return {
    ...written,
    source: selection.path,
    replaced: String(target).trim(),
    with: replacement.trim(),
    coverage: selection.coverage,
    labels: selection.labels,
    ...(spread ? { warning: spread } : {}),
    seconds: render.seconds,
    /**
     * ⚠️ CARRIED ALL THE WAY OUT TO THE MODEL, not absorbed here. The selector
     * cannot confirm the thing was ever in the picture, and the agent is the
     * only participant that can LOOK. Telling it the original is untouched is
     * what makes "check it" a cheap instruction rather than an alarming one.
     */
    presenceVerified: false,
    note: `the selector localises but cannot confirm presence — look at ${written.path} with read_image before using it. ${selection.path} is unchanged.`,
  };
}

/**
 * Extend an image to a new aspect ratio by PAINTING what would have been there,
 * instead of cropping away what is.
 */
export async function expandImage(root, path, aspect, {
  env = process.env, fetchImpl = fetch, dryRun = false, out = null, prompt = '', now, sleep,
} = {}) {
  const want = String(aspect || '16:9').trim();
  if (!ASPECTS.includes(want)) {
    return { ok: false, error: `unknown aspect "${want}" — have ${ASPECTS.join(', ')}` };
  }
  const img = loadImage(root, path);
  if (!img.ok) return img;

  const dest = outputPath(img.relative, out, want.replace(':', 'x'));
  if (!dest.ok) return dest;

  /**
   * ⚠️ THE PROMPT IS NOT OPTIONAL TO THE SERVICE, ONLY TO THE CALLER. An
   * outpaint with no prompt has nothing to condition the new edges on and drifts
   * into invention — the worker's own note records an outpaint that grew a
   * SECOND VAN. Defaulting to "continue the scene" states the intent that a
   * caller who omitted it obviously had.
   */
  const render = await runFluxTask('outpaint', {
    image: img.b64,
    prompt: prompt?.trim() || 'continue the existing scene naturally to the edges of the frame',
    aspect: want,
  }, { env, fetchImpl, now, sleep });
  if (!render.ok) return render;

  const written = writeImage(root, dest.path, render.data, dryRun);
  if (!written.ok) return written;

  /**
   * ⭐ THE NUMBER THAT PREDICTS THE FAILURE, COMPUTED AND REPORTED. See
   * OUTPAINT_SAFE_ADDED: this fails as smear, and smear returns ok:true. The one
   * thing a caller can act on is how far it was asked to reach.
   */
  const added = addedFraction(img.dimensions, { width: render.width, height: render.height });
  const warning = added !== null && added > OUTPAINT_SAFE_ADDED
    ? `${Math.round(added * 100)}% of this frame is invented. Measured on a real photograph: 16% was clean, 25% smeared the outer edge, 36% was unusable — and all three returned success. Look at ${written.path}; if the edges are streaked, widen in two smaller steps or pick a nearer aspect.`
    : null;

  return {
    ...written,
    source: img.relative,
    aspect: want,
    sourceSize: img.dimensions,
    width: render.width,
    height: render.height,
    invented: added === null ? null : Math.round(added * 100) / 100,
    ...(warning ? { warning } : {}),
    seconds: render.seconds,
    note: `${img.relative} is unchanged — the wider frame is a new file.`,
  };
}

/** Offered only where the services are configured. A dead button costs a round. */
export function imageEditToolSchemas(env = process.env) {
  const cfg = editConfig(env);
  const out = [];

  // ⚠️ edit_image needs BOTH services. Offering it with only flux configured
  // would present a verb that cannot produce a mask, which is the "dead button"
  // this package refuses to ship.
  if (cfg.select && cfg.flux) {
    out.push({
      type: 'function',
      function: {
        name: 'edit_image',
        description: [
          'Change ONE THING in an image instead of regenerating it: name what to replace in plain words',
          'and what should be there instead. "the sign on the van" -> "plain white panel".',
          'Use it whenever an image is nearly right — regenerating loses everything that already worked.',
          'Writes a NEW file; the original is never overwritten.',
          'Name the thing as TIGHTLY as you can — a mask that spans a lot of the frame repaints its surroundings too.',
          'The selector localises but CANNOT confirm the thing is present, so look at the result with read_image.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path to the image to edit.' },
            target: { type: 'string', description: 'The thing to replace, named simply: "the sofa", "the sky", "the sign".' },
            replacement: { type: 'string', description: 'What should be there instead, described as you would describe a photograph.' },
            out: { type: 'string', description: 'Optional output path. Defaults to <name>-edited.png.' },
          },
          required: ['path', 'target', 'replacement'],
        },
      },
    });
  }

  if (cfg.flux) {
    out.push({
      type: 'function',
      function: {
        name: 'expand_image',
        description: [
          'Widen or lengthen an image to a new aspect ratio by PAINTING the new edges, rather than cropping.',
          'Use it to turn a picture you already have into a 16:9 hero, a 9:16 story or a 4:5 post',
          'without throwing away a third of the composition. Writes a NEW file.',
          'QUALITY FALLS OFF WITH DISTANCE: a small change of aspect is clean, a large one smears the new edges',
          'and still reports success. Prefer the nearest aspect that works, and look at the result.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path to the image.' },
            aspect: { type: 'string', enum: ASPECTS, description: 'Target aspect ratio.' },
            prompt: { type: 'string', description: 'Optional hint for what the new edges contain. Defaults to continuing the scene.' },
            out: { type: 'string', description: 'Optional output path.' },
          },
          required: ['path', 'aspect'],
        },
      },
    });
  }

  return out;
}

/** Names only — the offer list needs these without building the schemas twice. */
export function imageEditToolNames(env = process.env) {
  return imageEditToolSchemas(env).map((t) => t.function.name);
}
