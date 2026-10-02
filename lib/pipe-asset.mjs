/**
 * ── ⭐⭐ pipe_to_asset — MAKE THE ASSET *AND* WIRE IT IN, IN ONE CALL ────────
 *
 * Roman's backlog, verbatim: *"generate an asset AND write the code that uses
 * it."* Today `generate_image` produces a file and hands back a path, and the
 * agent then has to remember to spend another round editing the markup that
 * points at it. Two things go wrong there, constantly, and the second one is
 * not a memory problem:
 *
 *   1. The wiring round is simply skipped. The image is on disk, the page still
 *      references nothing, and the run reports "generated hero.jpg" — true, and
 *      useless.
 *   2. ⚠️⚠️ **THE EXTENSION IS NOT KNOWABLE IN ADVANCE.** `imagegen.mjs` says it
 *      in its own schema: *"The file is a .png or a .jpg — the extension follows
 *      whatever the engine returns, so use the exact path from the result rather
 *      than assuming one."* A model that writes `<img src="hero.png">` first and
 *      generates second is wrong roughly whenever the free fallback answers,
 *      because that engine returns JPEG. The page loads, the image is missing,
 *      and nothing in the run says so.
 *
 * ⭐ So this verb owns the ORDER: check the edit is possible → generate → put
 * the asset where the project wants it → write the reference using the extension
 * that actually came back. The reference and the file cannot disagree, because
 * one is derived from the other.
 *
 * ── ⚠️ GENERIC. NO FRAMEWORK, NO VERTICAL, NO GAME ──────────────────────────
 *
 * Roman's constraint on this whole wave: *"these are generic verbs; none may
 * hardcode for games"*. This one knows about exactly four things — a prompt, a
 * destination path, a file, and a unique span of text inside that file. There is
 * no `public/` rule, no `/assets` convention, no bundler, no sprite sheet and no
 * manifest. It never guesses which framework you are in, because the guess is
 * wrong often enough to be worse than the manual edit it replaces.
 *
 * ⚠️ THAT IS WHY THE DEFAULT REFERENCE IS A *RELATIVE PATH FROM THE FILE BEING
 * EDITED*, and why `reference` exists to override it. Relative is the one answer
 * that is correct without knowing anything about a server: it is what an HTML
 * `src=`, a CSS `url()` and a bundler import all resolve. A project that serves
 * a directory at a URL root needs `/img/hero.jpg` instead, and only the caller
 * knows that — so the caller says it, and `{file}` lets them say it without
 * having to know the extension first.
 *
 * ── ⚠️⚠️ AMBIGUITY IS A REFUSAL, AND IT IS REFUSED *BEFORE* THE RENDER ───────
 *
 * When the placeholder is missing from the file, or appears more than once, this
 * verb does NOT ask the user which one they meant. Three reasons, in the order
 * they bite:
 *
 *   1. ⭐ **A QUESTION CANNOT BE ASKED IN EVERY RUN THIS VERB RUNS IN.**
 *      `ask-user.mjs` allows `MAX_QUESTIONS = 3` for a WHOLE RUN, `--max-questions
 *      0` is a documented setting whose help text is "the agent never asks and
 *      states its assumptions instead", and over MCP `ask_user` is refused with
 *      *"there is no human on this end of a pipe"*. A verb that needs an answer
 *      to finish is a verb that is broken in every unattended context — and
 *      unattended is where a generate-and-wire loop is worth the most.
 *   2. ⭐ **IT IS A DETAIL, AND THE BUDGET IS FOR DECISIONS.** `ask-user.mjs`'s
 *      own schema says to spend the allowance "on decisions, not details".
 *      Which span of text to replace is not a decision about the task; it is
 *      something the model can settle for free with `read_file` and a longer
 *      quote. Burning a third of the run's human allowance on it would crowd out
 *      the questions that actually change what gets built.
 *   3. ⭐ **REFUSING EARLY IS FREE; REFUSING LATE COSTS A RENDER.** The whole
 *      pre-flight runs before a single GPU second is spent — the same rule
 *      `imagegen.mjs` writes down for its own destination check: *"resolved
 *      BEFORE the 54-second render. Discovering the destination is refused AFTER
 *      the wait is a minute of someone's life spent on nothing."*
 *
 * ⭐ And the refusal is ACTIONABLE rather than merely correct: `applyEdit` is
 * asked the question, so the sentence the caller gets back is the exact one
 * `edit_file` would have given it, including the match count. One matching
 * engine, one wording — a second copy here is the copy that goes stale, which
 * this package has been bitten by twice in one week.
 *
 * ── ⚠️ WHAT HAPPENS WHEN A HALF FAILS ───────────────────────────────────────
 *
 *   · pre-flight fails  → nothing generated, nothing written. The cheap half is
 *                         the one that can refuse, so it goes first.
 *   · generation fails  → THE CODE IS NOT TOUCHED. A dangling `src=` that points
 *                         at a file which was never drawn is worse than no edit
 *                         at all: it breaks a page that used to work, and it
 *                         looks like a successful wiring.
 *   · the move fails    → the asset stays where the generator put it and the
 *                         path is reported, so nothing is lost. The code is
 *                         still untouched.
 *   · the edit fails    → the asset is on disk at its final path, reported, and
 *                         the caller is handed the exact `edit_file` arguments
 *                         that would finish the job.
 *
 * ── ⚠️ IT ADDS NO NEW SPEND, AND NO NEW CAP ─────────────────────────────────
 *
 * The generator is `generateImage`, unchanged — so the per-run ceiling
 * (`MAX_IMAGES_PER_PROCESS`), the engine entitlement check, the critic, the
 * provider chain and the GPU ledger entry are all the ones that already exist.
 * This verb is a wrapper around a call the model could already make; it does not
 * become a second, unmetered door to the same GPU.
 */

import { existsSync, statSync } from 'node:fs';
import { posix } from 'node:path';

import { resolveInWorkspace } from './workspace.mjs';
/**
 * ⭐ IMPORTED, NOT RE-IMPLEMENTED — both of them.
 *
 * `applyEdit` is pure, which is what makes the pre-flight honest: the question
 * "would this edit apply?" is answered by the code that will apply it, not by a
 * second occurrence counter that agrees today and drifts next month. And
 * `editThroughExecutor` carries the CRLF tolerance, the strict UTF-8 decode, the
 * binary refusal and the checkpoint journal entry — none of which a fresh
 * `readFile`/`writeFile` pair here would have.
 */
import { applyEdit, editThroughExecutor } from './edit.mjs';
import { generateImage, imageConfig, suggestFilename } from './imagegen.mjs';

export const PIPE_ASSET_TOOL_NAMES = Object.freeze(['pipe_to_asset']);

/**
 * The extensions this verb will strip off a caller-supplied destination before
 * putting the engine's real one back on.
 *
 * ⚠️ A LIST, NOT `extname()`. `hero.v2` is a legitimate stem and `path.extname`
 * calls its suffix an extension — stripping it would silently rename the file
 * the caller asked for. Only endings that are plausibly an image extension the
 * caller GUESSED are replaced; anything else is kept as part of the name.
 */
const REPLACEABLE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);

/** Default when the engine's answer carries no usable extension at all. */
const FALLBACK_EXTENSION = '.png';

/**
 * A probe that stands in for the real reference during the pre-flight.
 *
 * ⚠️ IT MUST NOT BE ANYTHING A FILE COULD CONTAIN, and it must not equal the
 * placeholder — `applyEdit` refuses an edit whose two sides are identical, and
 * that refusal would be reported as an ambiguity the caller cannot fix. Its text
 * is never written anywhere: only the pre-flight verdict is read, and the probe
 * is thrown away with the string it produced.
 */
const PREFLIGHT_PROBE = 'acuvo-pipe-to-asset-probe';

/** Everything before the last `/`. `''` for a file in the workspace root. */
function dirOf(rel) {
  const at = rel.lastIndexOf('/');
  return at === -1 ? '' : rel.slice(0, at);
}

/** Everything after the last `/`. */
function baseOf(rel) {
  const at = rel.lastIndexOf('/');
  return at === -1 ? rel : rel.slice(at + 1);
}

/** The extension the ENGINE chose, lower-cased, or the fallback. */
export function extensionOf(generatedPath) {
  const base = baseOf(String(generatedPath ?? ''));
  const at = base.lastIndexOf('.');
  if (at <= 0 || at === base.length - 1) return FALLBACK_EXTENSION;
  return base.slice(at).toLowerCase();
}

/**
 * Split a caller's `asset_path` into the directory it lives in and the stem the
 * final filename is built from. The extension is deliberately NOT decided here —
 * it belongs to whichever engine answers.
 *
 * `isDirectory` is injected so the decision is testable without a filesystem,
 * and so the CLI can consult the real one.
 *
 * @param {unknown} raw          what the model asked for
 * @param {string} prompt        used for the stem when only a directory is named
 * @param {(rel: string) => boolean} isDirectory
 */
export function splitAssetTarget(raw, prompt, isDirectory = () => false) {
  const text = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!text) return { ok: false, error: 'asset_path is required — say where in the project the asset should live, e.g. "public/img/hero.png" or "public/img/".' };

  /** A slug of the prompt, minus the `.png` `suggestFilename` bolts on. */
  const fromPrompt = () => suggestFilename(prompt).replace(/\.png$/, '');

  // ⭐ An explicit trailing slash is the caller saying "a directory, you name
  // the file". So is a path that IS an existing directory — otherwise
  // `asset_path: "public"` quietly produces a file called `public.png`, which
  // is the kind of surprise that gets a verb switched off.
  const trailing = text.endsWith('/');
  const cleaned = trailing ? text.replace(/\/+$/, '') : text;
  if (trailing || (cleaned && isDirectory(cleaned))) {
    return { ok: true, dir: cleaned, stem: fromPrompt() };
  }

  const dir = dirOf(cleaned);
  const name = baseOf(cleaned);
  if (!name) return { ok: false, error: `asset_path "${text}" names no file` };

  const lower = name.toLowerCase();
  const guessed = REPLACEABLE_EXTENSIONS.find((e) => lower.endsWith(e) && lower.length > e.length);
  const stem = guessed ? name.slice(0, name.length - guessed.length) : name;
  return { ok: true, dir, stem };
}

/**
 * What the code should say, given where the asset landed.
 *
 * ⭐ `{file}` and `{path}` exist for ONE reason: the caller cannot know the
 * extension before the render, so a verbatim override would force them to guess
 * exactly the thing this verb was built to stop them guessing. `{file}` is the
 * final basename (`hero.jpg`), `{path}` the workspace-relative path
 * (`public/img/hero.jpg`).
 *
 * With no override the answer is the path FROM the file being edited, which is
 * what an `src=`, a `url()` and a relative import all resolve — and which needs
 * no knowledge of how the project is served.
 */
export function resolveReference(codeRel, assetRel, override) {
  const file = baseOf(assetRel);
  const raw = typeof override === 'string' ? override.trim() : '';
  if (raw) {
    return { text: raw.split('{file}').join(file).split('{path}').join(assetRel), style: 'given' };
  }
  const from = dirOf(codeRel);
  const rel = from ? posix.relative(from, assetRel) : assetRel;
  return { text: rel || assetRel, style: 'relative' };
}

/**
 * ── THE VERB ────────────────────────────────────────────────────────────────
 *
 * @param {object} executor   the workspace executor (root, readFile, moveFile, dryRun)
 * @param {object} args       the model's arguments
 * @param {{ producer?: Function, env?: Record<string, any> }} [deps]
 *   `producer` is the seam every test uses. ⚠️ It exists so the suite can prove
 *   the file writes and the code edit WITHOUT drawing anything: a test that
 *   really generated would cost money, take a minute, and be at the mercy of a
 *   free provider that throttles to 45s on its third call.
 */
export async function pipeToAsset(executor, args = {}, { producer = generateImage, env = process.env } = {}) {
  if (!executor || typeof executor.readFile !== 'function') {
    return { ok: false, error: 'pipe_to_asset needs a workspace to read and write' };
  }

  const prompt = String(args?.prompt ?? '').trim();
  if (!prompt) return { ok: false, error: 'prompt is required — describe the asset: subject, style, lighting, composition.' };

  const placeholder = typeof args?.placeholder === 'string' ? args.placeholder : '';
  if (!placeholder) {
    return {
      ok: false,
      error: 'placeholder is required — the exact, unique text in the code file that should become the asset reference. '
        + 'Write the file with a marker first (e.g. src="__HERO__"), then name that marker here.',
    };
  }

  /**
   * ⚠️ THE MOVE VERB IS CHECKED UP FRONT, NOT WHEN IT IS NEEDED. The browser
   * builder's executor has no `moveFile` (tools.mjs already guards `move_file`
   * for exactly this), and discovering that AFTER a render is a paid image with
   * nowhere to go.
   */
  if (typeof executor.moveFile !== 'function') {
    return { ok: false, error: 'this workspace cannot move files, so the asset cannot be placed where the project expects it' };
  }

  /* ── 1. THE CODE FILE. Cheap, and it can refuse — so it goes first. ─────── */
  const read = executor.readFile(args?.code_path);
  if (!read.ok) {
    return { ok: false, error: `${read.error} — nothing was generated, because the file that would reference the asset cannot be read.` };
  }
  const codeRel = read.path;

  /**
   * ⭐ THE AMBIGUITY GATE, ANSWERED BY THE ENGINE THAT WILL DO THE EDIT.
   * `applyEdit` is pure, so asking it with a throwaway replacement costs nothing
   * and produces the same sentence `edit_file` would — match counts included.
   */
  const preflight = applyEdit(read.content, placeholder, PREFLIGHT_PROBE);
  if (!preflight.ok) {
    return {
      ok: false,
      generated: false,
      error: `${codeRel}: ${preflight.error} Nothing was generated — the asset is only worth drawing once the code that will point at it is unambiguous. `
        + 'Read the file and quote a longer, unique span, then call this again. (This verb never asks you to choose; it refuses and hands the decision back.)',
    };
  }

  /* ── 2. WHERE THE ASSET GOES. Resolved before the render, same rule. ────── */
  const isDirectory = (rel) => {
    const r = resolveInWorkspace(executor.root, rel, 'write');
    if (!r.ok) return false;
    try { return statSync(r.absolute).isDirectory(); } catch { return false; }
  };
  const target = splitAssetTarget(args?.asset_path, prompt, isDirectory);
  if (!target.ok) return { ok: false, generated: false, error: target.error };

  /**
   * ⚠️ VALIDATED WITH A PLACEHOLDER EXTENSION. The real one is not known yet,
   * and every refusal `resolveInWorkspace` can produce — traversal, depth, a
   * reserved device name, a segment Windows cannot store — depends on the
   * SEGMENTS, not on the three characters after the dot. So the check is exact
   * for everything it is being asked, and it happens while it is still free.
   */
  const probePath = target.dir ? `${target.dir}/${target.stem}${FALLBACK_EXTENSION}` : `${target.stem}${FALLBACK_EXTENSION}`;
  const probe = resolveInWorkspace(executor.root, probePath, 'write');
  if (!probe.ok) return { ok: false, generated: false, error: `asset_path is refused: ${probe.reason}. Nothing was generated.` };

  /* ── 3. A DRY RUN STOPS HERE, AND THAT IS THE POINT OF THE FLAG. ────────── */
  /**
   * ⚠️ `--dry-run` PROMISES "NOTHING WRITTEN", AND A RENDER IS BOTH A WRITE AND
   * A BILL. Every check above has already run, so the preview reports exactly
   * the refusals a real run would — a dry run that skipped validation would be a
   * preview of a different command, which is the only way a dry run can lie.
   */
  if (executor.dryRun === true) {
    const planned = `${probePath} (extension follows the engine)`;
    const would = resolveReference(codeRel, probePath, args?.reference);
    return {
      ok: true,
      dryRun: true,
      generated: false,
      edited: false,
      assetPath: planned,
      codePath: codeRel,
      reference: would.text,
      referenceStyle: would.style,
      note: `Would generate "${prompt}", write it to ${planned}, and replace one occurrence of the placeholder in ${codeRel} with ${would.text}. Nothing was drawn and nothing was written.`,
    };
  }

  /* ── 4. THE EXPENSIVE HALF, once the cheap half is known to work. ──────── */
  const shot = await producer({
    prompt,
    width: args?.width,
    height: args?.height,
    engine: args?.engine ?? null,
    executor,
    env,
  });
  if (!shot?.ok) {
    return {
      ok: false,
      generated: false,
      edited: false,
      codePath: codeRel,
      /**
       * ⚠️ THE CODE IS DELIBERATELY UNTOUCHED. Writing the reference anyway
       * would leave a page pointing at a file that was never drawn — a broken
       * build wearing the costume of a completed wiring.
       */
      error: `${shot?.error ?? 'the asset could not be generated'} — ${codeRel} was left unchanged, so nothing now points at a file that does not exist.`,
    };
  }

  /* ── 5. PUT IT WHERE THE PROJECT EXPECTS IT. ───────────────────────────── */
  const ext = extensionOf(shot.path);
  const assetRel = target.dir ? `${target.dir}/${target.stem}${ext}` : `${target.stem}${ext}`;

  let moved = null;
  if (assetRel !== shot.path) {
    moved = executor.moveFile(shot.path, assetRel, { overwrite: args?.overwrite === true });
    if (!moved.ok) {
      return {
        ok: false,
        generated: true,
        edited: false,
        assetPath: shot.path,
        codePath: codeRel,
        error: `the asset was generated and is at ${shot.path}, but it could not be placed: ${moved.error} `
          + `${codeRel} was left unchanged. Move it yourself with move_file, then wire it in with edit_file.`,
      };
    }
  }

  /* ── 6. WRITE THE REFERENCE — using the extension that actually came back. */
  const reference = resolveReference(codeRel, assetRel, args?.reference);

  /**
   * ⚠️ ONE CASE THE PRE-FLIGHT CANNOT SEE, BECAUSE THE ANSWER DID NOT EXIST
   * YET: the placeholder may already BE the reference (the caller guessed the
   * extension and guessed right). `applyEdit` correctly refuses that as
   * "identical — nothing to do", which would read as a failure on a run where
   * everything worked. It is a success with no edit, and it is reported as one.
   */
  if (reference.text === placeholder) {
    return {
      ok: true,
      generated: true,
      edited: false,
      assetPath: assetRel,
      codePath: codeRel,
      reference: reference.text,
      referenceStyle: reference.style,
      provider: shot.provider ?? null,
      note: `Asset written to ${assetRel}. ${codeRel} already references it exactly, so no edit was needed.`,
    };
  }

  const edit = editThroughExecutor(executor, codeRel, placeholder, reference.text);
  if (!edit.ok) {
    return {
      ok: false,
      generated: true,
      edited: false,
      assetPath: assetRel,
      codePath: codeRel,
      reference: reference.text,
      error: `the asset is on disk at ${assetRel}, but the code edit failed: ${edit.error} `
        + `Finish it with edit_file on ${codeRel}, replacing ${JSON.stringify(placeholder)} with ${JSON.stringify(reference.text)}.`,
    };
  }

  return {
    ok: true,
    generated: true,
    edited: true,
    assetPath: assetRel,
    bytes: shot.bytes ?? null,
    codePath: codeRel,
    reference: reference.text,
    referenceStyle: reference.style,
    provider: shot.provider ?? null,
    /**
     * ⭐ CARRIED THROUGH, NOT SWALLOWED. `generate_image` returns a critic's
     * verdict and a "drawn by X, after the preferred engine was unavailable"
     * sentence; a wrapper that dropped them would make the same picture look
     * better than it does through the tool it wraps.
     */
    ...(shot.note ? { imageNote: shot.note } : {}),
    ...(shot.accepted === false ? { accepted: false } : {}),
    note: `Wrote ${assetRel} and pointed ${codeRel} at it as ${reference.text}`
      + (reference.style === 'relative' ? ' (a path relative to that file — pass `reference` if the project serves assets from a URL root instead).' : '.'),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * REGISTRATION
 * ──────────────────────────────────────────────────────────────────────────── */

export function pipeAssetToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'pipe_to_asset',
        description: [
          'Generate an image AND wire it into your code in one call: it writes the asset to the path you name and',
          'replaces a placeholder in a code file with the reference to it.',
          'USE THIS INSTEAD OF generate_image whenever the image is FOR something you are building — a hero, an icon,',
          'an illustration, an og:image, a texture.',
          '⚠️ The engine decides the extension (.png or .jpg), so writing the reference yourself first is a guess that is',
          'often wrong; this verb writes the reference from the file that was actually produced, so the two cannot disagree.',
          'Write the code first with a unique marker (src="__HERO__"), then call this and name that marker as `placeholder`.',
          'If the marker is missing or appears more than once it REFUSES and generates nothing — it never asks you to choose.',
          'It uses the same engine, the same per-run image cap and the same credits as generate_image.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'A rich, specific description — subject, style, lighting, lens, mood.' },
            asset_path: {
              type: 'string',
              description: 'Workspace-relative destination, e.g. "public/img/hero.png". Any extension you write is REPLACED '
                + 'by the one the engine returns. End with "/" (or name a directory) to have the filename derived from the prompt.',
            },
            code_path: { type: 'string', description: 'The EXISTING file that should reference the asset.' },
            placeholder: {
              type: 'string',
              description: 'The exact text in that file to replace with the reference. Must appear exactly once — quote '
                + 'surrounding context if a bare marker is not unique.',
            },
            reference: {
              type: 'string',
              description: 'Optional. What to write instead of a path relative to code_path — use it when assets are served '
                + 'from a URL root, e.g. "/img/{file}". "{file}" becomes the final filename, "{path}" the workspace path.',
            },
            width: { type: 'number', description: 'Pixels wide. Default 1200.' },
            height: { type: 'number', description: 'Pixels tall. Default 800.' },
            overwrite: { type: 'boolean', description: 'Allow replacing a file already at asset_path. Default false.' },
            engine: {
              type: 'string',
              description: 'Leave unset unless the USER named a premium engine. Ultra engines cost many times more per image.',
            },
          },
          required: ['prompt', 'asset_path', 'code_path', 'placeholder'],
        },
      },
    },
  ];
}

/**
 * ⚠️ THE SAME GATE `generate_image` USES, READ FROM THE SAME FUNCTION. This verb
 * cannot work where the image chain is switched off (`PERCHANCE_IMAGE_URL=`), and
 * offering it there would be a button whose only possible answer is "no image
 * service is set up" — a dead button by another name.
 *
 * ⭐ MULTI-ROUND ONLY, and it is not the usual "a read has nowhere to go"
 * argument. Its whole subject is a file that ALREADY EXISTS with a marker in it,
 * which in a one-round run is a file nothing has written yet.
 */
export function pipeAssetToolNames(env = process.env, { maxRounds = 2 } = {}) {
  if (maxRounds <= 1) return [];
  return imageConfig(env).configured ? [...PIPE_ASSET_TOOL_NAMES] : [];
}

/** Dispatch. Mirrors the shape every other tool module in this package uses. */
export async function runPipeAssetTool(name, args = {}, { executor, env = process.env, producer } = {}) {
  if (name !== 'pipe_to_asset') return { ok: false, error: `unknown pipe_to_asset tool "${name}"` };
  return pipeToAsset(executor, args, { env, ...(producer ? { producer } : {}) });
}
