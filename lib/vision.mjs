/**
 * ── ⭐⭐ EYES — THE SENSE THE AGENT NEVER HAD ────────────────────────────────
 *
 * This CLI could MAKE a picture and could not LOOK at one. Everything good that
 * came out of this codebase this week came from someone looking: a watermark
 * that rendered as "ΛACUVO", a banner printing a 100-character absolute path, a
 * change list printed twice, six generated images judged good enough to ship.
 * A model that cannot see can verify that code RAN. It can never verify that
 * the result was GOOD — and for anything with a screen, those are different
 * questions with different answers.
 *
 * ── ⚠️⚠️ THE CODER MODEL CANNOT SEE, AND THIS IS NOT A PASSTHROUGH ─────────
 *
 * The default model here is `deepseek-v4-flash`, which is text-only. Attaching
 * an image to it does not fail loudly — it either drops the attachment or,
 * far worse, answers the question anyway from the filename and the surrounding
 * conversation, in fluent confident prose. A hallucinated "the layout looks
 * clean and balanced" about a page nobody rendered is strictly worse than "I
 * cannot see it": it ENDS the investigation with a false all-clear, which is
 * exactly the bug `see_page` had to be fixed for once already.
 *
 * ⭐ So this makes its own call, to a model chosen because it can actually see.
 * `qwen3.7-flash` is measured at **$0.042/M** — a 1024×1024 image is ~1,400
 * tokens, so a look costs about **$0.00006**. Cheap enough that "check before
 * you claim" stops being a budget decision.
 *
 * ⚠️ AND IT ABSTAINS RATHER THAN GUESSES. Every failure path returns ok:false
 * with a reason. The one behaviour this module must never have is producing a
 * plausible sentence about an image it did not receive.
 */

import { readFileSync, statSync } from 'node:fs';

import { resolveInWorkspace } from './workspace.mjs';

export const DEFAULT_VISION_MODEL = 'qwen/qwen3.7-flash';
export const VISION_TIMEOUT_MS = 60_000;

/**
 * ⚠️ A CEILING IN BYTES, BECAUSE WE CANNOT RESIZE. There is no image library
 * here (zero dependencies is the product), so an oversized screenshot cannot be
 * scaled down on the way out — it can only be sent whole or refused. Refusing
 * with the number and a way forward beats silently sending 40MB.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PIXELS_PER_TOKEN = 750;
export const MAX_LOOKS_PER_PROCESS = 12;

let looksThisProcess = 0;

/** Test seam — the per-run cap must not leak between test files. */
export function resetVisionState() {
  looksThisProcess = 0;
}

/**
 * ⚠️ SNIFFED FROM THE BYTES, NOT THE EXTENSION. A `.png` that is really a JPEG
 * is common (every "save as" dialog produces some), and declaring the wrong
 * mime type to the API is a 400 that reads like the image being rejected on its
 * merits rather than on its label.
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Width and height without decoding the image.
 *
 * ⭐ THIS EXISTS SO THE COST CAN BE STATED RATHER THAN GUESSED. Vision billing
 * is per pixel, so "this look will cost about $0.00006" is only honest if the
 * dimensions are read from the file. Returns null when the format hides them,
 * and the caller then says "unknown" instead of inventing a number.
 */
export function imageSize(buf) {
  const mime = sniffImage(buf);
  try {
    if (mime === 'image/png') {
      // IHDR is always the first chunk: width at byte 16, height at 20.
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') {
      /**
       * ⚠️ JPEG HIDES ITS SIZE BEHIND A SEGMENT WALK. There is no fixed offset:
       * the dimensions live in whichever SOF marker appears, after any number of
       * EXIF/comment segments of arbitrary length. Guessing an offset is how you
       * report a 6000×4000 photo as 2×19029.
       */
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        // SOF0..SOF15, excluding the non-frame markers C4 (DHT), C8, CC.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (mime === 'image/webp') {
      // Only the simple VP8X form carries dimensions at a fixed offset.
      if (buf.slice(12, 16).toString('latin1') === 'VP8X') {
        return {
          width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
          height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
        };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export function estimateLookTokens(size) {
  if (!size?.width || !size?.height) return null;
  return Math.ceil((size.width * size.height) / PIXELS_PER_TOKEN);
}

const DEFAULT_QUESTION = [
  'Describe this image precisely and factually.',
  'State what is actually visible — layout, text (quote it exactly), colours, objects, and anything that looks wrong,',
  'broken, misaligned, garbled or misspelled.',
  'Do not speculate about anything you cannot see, and do not be polite about defects.',
].join(' ');

/**
 * Look at an image file in the workspace and answer a question about it.
 *
 * ⚠️ EVERY FAILURE ABSTAINS. `ok:false` with a reason, never a sentence that
 * could be mistaken for an observation.
 */
export async function readImage(params = {}) {
  const root = params.root ?? params.executor?.root;
  const path = String(params.path ?? '').trim();
  const question = String(params.question ?? '').trim() || DEFAULT_QUESTION;
  const apiKey = params.apiKey ?? process.env.OPENROUTER_API_KEY;
  const model = params.model ?? process.env.ACUVO_VISION_MODEL ?? DEFAULT_VISION_MODEL;
  const fetchImpl = params.fetchImpl ?? fetch;

  if (!path) return { ok: false, error: 'read_image needs a `path` to an image file in the workspace.' };
  if (!root) return { ok: false, error: 'read_image has no workspace root to resolve the path against.' };
  if (!apiKey) {
    return {
      ok: false,
      error: 'no OPENROUTER_API_KEY, so there is nothing that can look at this image. Do not describe it from its filename — say you could not see it.',
    };
  }
  if (looksThisProcess >= MAX_LOOKS_PER_PROCESS) {
    return {
      ok: false,
      error: `this run has already looked at ${MAX_LOOKS_PER_PROCESS} images, which is the cap. Looking again at the same thing will not tell you something new — act on what you saw.`,
    };
  }

  const resolved = resolveInWorkspace(root, path, 'read');
  if (!resolved.ok) return { ok: false, error: resolved.reason };

  let stat;
  try {
    stat = statSync(resolved.absolute);
  } catch {
    return { ok: false, error: `no such file: ${path}. Check the path with list_dir — an image you just generated is written under the name the tool reported, not the one you asked for.` };
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `${path} is ${(stat.size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit. This agent has no image library and cannot resize it — render or export a smaller version and look at that.`,
    };
  }

  const bytes = readFileSync(resolved.absolute);
  const mime = sniffImage(bytes);
  if (!mime) {
    /**
     * ⚠️ NAMED BY WHAT IT IS, NOT BY WHAT IT IS NOT. "unsupported format" sends
     * the model round the same loop; saying the first bytes do not match any
     * image format tells it the file is probably HTML, an error page, or empty.
     */
    return {
      ok: false,
      error: `${path} does not begin with PNG, JPEG, GIF or WEBP magic bytes, so it is not an image this can look at — it may be an error page, a text file, or a truncated download. Read the first bytes with read_file if you need to know which.`,
    };
  }

  const size = imageSize(bytes);
  const tokens = estimateLookTokens(size);
  looksThisProcess += 1;

  let res;
  try {
    res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        /**
         * ⚠️ REASONING OFF. Measured on this account: a reasoning model charges
         * its thinking budget against max_tokens and can spend ALL of it —
         * 15,999 reasoning tokens and an empty reply. An empty reply from a
         * vision model is indistinguishable from "I saw nothing".
         */
        reasoning: { enabled: false },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? `no answer in ${VISION_TIMEOUT_MS / 1000}s` : String(err?.message || err);
    return { ok: false, error: `could not reach the vision model (${why}). Say you were unable to look at the image rather than describing it.` };
  }

  if (!res.ok) {
    const snippet = await res.text().catch(() => '');
    return { ok: false, error: `the vision model returned HTTP ${res.status}${snippet ? `: ${String(snippet).slice(0, 200)}` : ''}` };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'the vision model returned a body that was not JSON' };
  }

  const text = json?.choices?.[0]?.message?.content;
  /**
   * ⚠️⚠️ AN EMPTY REPLY IS A FAILURE, NOT AN EMPTY IMAGE. This is the same 200
   * that meant failure in model.mjs, media.mjs and the image engine — four
   * places now. `res.ok` answers a question about the HTTP conversation, never
   * about whether the work happened.
   */
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'the vision model answered with nothing at all, so the image was not read. Do not describe it.' };
  }

  return {
    ok: true,
    path,
    text: text.trim(),
    model,
    mime,
    ...(size ? { width: size.width, height: size.height } : {}),
    ...(tokens ? { approxImageTokens: tokens } : {}),
    costUsd: json?.usage?.cost ?? null,
  };
}

export function visionToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'read_image',
        description: [
          'LOOK at an image file in the workspace and get back a factual description.',
          'Use it on anything visual you produced or were given: a screenshot, a generated image, a chart, a photo, a design mock.',
          'You cannot see images yourself — this makes a separate call to a model that can, so it is the ONLY way',
          'to know what is actually in a picture.',
          'Ask a specific question when you have one ("is the heading text spelled correctly?", "does the button overlap the image?");',
          'with no question it describes the image and names anything that looks broken.',
          'If it cannot see the image it says so — in that case tell the user you could not look, and never describe the image from its filename.',
          `At most ${MAX_LOOKS_PER_PROCESS} looks per run.`,
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the image inside the workspace, e.g. "shot.png" or "public/hero.jpg".' },
            question: { type: 'string', description: 'What you want to know about it. Leave out for a general description with defects called out.' },
          },
          required: ['path'],
        },
      },
    },
  ];
}
