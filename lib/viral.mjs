/**
 * ── ⭐⭐ viral — SCRIPT → VO → IMAGES → CUT → A CAPTIONED MP4 ────────────────
 *
 * Roman's backlog: *"viral — script → VO → images → ffmpeg cut → captioned
 * mp4."* And his rule for this wave, verbatim: *"generic verbs, none may
 * hardcode for games."* This one knows about a scene, a line of narration, a
 * picture and an aspect ratio. It has no idea what the video is FOR, and there
 * is nowhere in it for that opinion to live.
 *
 * ── ⚠️⚠️ THE MODEL COMPOSES; THIS VERB ASSEMBLES ────────────────────────────
 *
 * The obvious build takes `topic: "our new pricing"` and calls a model to write
 * the script. `syndicate.mjs` argues that case at length and every word of it
 * applies here: the agent calling this verb has the whole conversation and a
 * nested generation throws it away; a generating verb cannot be tested without a
 * mock that drifts; and a verb that writes copy has to know what the copy is
 * for, which is exactly the hardcoding Roman's rule forbids.
 *
 * ⭐ SO THE CONTRACT IS: you write the scenes, this owns the timeline. It owns
 * the per-scene durations MEASURED from the audio it made, the caption timings
 * derived from those, the canvas geometry, the file layout, and the one ffmpeg
 * invocation that turns all of it into a file a phone will play.
 *
 * ── ⚠️⚠️ WHAT IT COSTS, BEFORE IT COSTS IT ─────────────────────────────────
 *
 * This is the widest-fanning verb in the package: one call can be six TTS
 * requests and four renders. Every other paid verb here spends ONE unit per
 * call. So the first call ALWAYS plans, prices and generates nothing — see
 * `spendGate` in media-pipeline.mjs for the full argument. A verb that can spend
 * without saying so is the defect this repo has paid for repeatedly, and this
 * one is shaped so it cannot.
 *
 * ── ⚠️ ffmpeg IS OPTIONAL, AND THE DEGRADE STILL SHIPS SOMETHING ────────────
 *
 * With no ffmpeg you still get: every scene image, the full narration track as
 * one WAV (joined in pure Node — no binary involved), the caption file, and the
 * exact argv that would have produced the mp4. Spending the GPU money and then
 * returning "install ffmpeg" would be the worst of both.
 */

import { dirname } from 'node:path';

/**
 * ── 🚪⭐⭐⭐ `speakVia`, NOT `mediaConfig().speak` — AND THE DIFFERENCE IS THE
 *    WHOLE VERB ─────────────────────────────────────────────────────────────
 *
 * ⚠️⚠️ MEASURED 2026-08-31, and it is `--design`'s bug repeating for the third
 * time. `mediaConfig(env).speak` resolves to a baked-in Modal URL gated on
 * `ACUVO_MEDIA_SECRET` / `MODAL_VIDEO_SECRET` — OUR internal credentials, which
 * a paying customer cannot obtain and must never receive. So `viralToolNames`
 * answered `[]` on every machine that was not ours: the verb existed, was
 * classified, was priced, and was **offered to nobody who had paid for it**.
 *
 * ⭐ `media.mjs` HAD ALREADY FIXED THIS FOR `speak` ITSELF and the note there
 * says so in as many words — a local worker wins, otherwise the signed-in Acuvo
 * account routes through `<gateway>/speak` with a bearer token and the shared
 * secret stays on the server. `viral` calls that exact function; only its GATE
 * was still asking the older question. One import closes it.
 *
 * ⚠️ AND THE GATE STILL FAILS SHUT. No local worker and no account still means
 * no verb — `speakVia` returns null and nothing is offered, which is the
 * property `tools.mjs` requires: *"a tool whose service is absent is never
 * mentioned."*
 */
import { speak, mediaConfig, speakVia } from './media.mjs';
import { designVoice } from './avatar-run.mjs';
import { avatarConfig } from './avatar.mjs';
import { generateImage, MAX_IMAGES_PER_PROCESS } from './imagegen.mjs';
import { slugify } from './syndicate.mjs';
import {
  ASPECTS, DEFAULT_ASPECT, DEFAULT_FPS, CAPTION_MODES, DEFAULT_CAPTION_MODE,
  slideshowArgv, detectFfmpeg, runFfmpeg, ffmpegInstallHint,
  concatWav, readWorkspaceBinary, writeWorkspaceBinary,
  toSrt, estimateSpeechSeconds, estimateSpend, spendGate, SPEND_APPROVAL_ARG,
} from './media-pipeline.mjs';

export const VIRAL_TOOL_NAMES = Object.freeze(['viral']);

/**
 * ⚠️ A SHORT IS SHORT. Twelve scenes at four seconds each is already past the
 * length anything described as "viral" survives, and every extra scene is
 * another paid render plus another `-loop 1 -i` leg in the filter graph.
 */
export const MAX_SCENES = 12;
/** One scene's narration. `speak`'s own ceiling is 5,000; this is a beat, not a chapter. */
export const MAX_NARRATION_CHARS = 600;
/** A burned-in caption that does not fit on a phone screen is not a caption. */
export const MAX_CAPTION_CHARS = 120;

const pad = (n) => String(n).padStart(2, '0');

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE PLAN — pure, so the whole contract is testable for $0.00
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Validate the scenes and lay out every file, before anything is produced.
 *
 * ⚠️⚠️ THE IMAGE CAP IS IMPORTED, NEVER TYPED. `generateImage` refuses after
 * `MAX_IMAGES_PER_PROCESS` renders in one process — and it refuses by RETURNING
 * an error mid-run, which for this verb means four scenes rendered, the fifth
 * refused, and the money for the first four already spent. Checking it here, up
 * front, turns a half-spent failure into a refusal that costs nothing. If that
 * constant ever moves, this moves with it.
 *
 * @returns {{ok: true, scenes: Array<object>, needsGeneration: number} | {ok: false, error: string}}
 */
export function planScenes(rawScenes, { dir, aspect = DEFAULT_ASPECT } = {}) {
  const list = Array.isArray(rawScenes) ? rawScenes : [];
  if (!list.length) {
    return {
      ok: false,
      error: 'this verb ASSEMBLES a video; it does not write one. Pass `scenes`: an ordered array of '
        + '{ narration, image_prompt } — you compose the script and the shot descriptions, and it owns the '
        + 'voiceover, the durations, the caption timings and the cut.',
    };
  }
  if (list.length > MAX_SCENES) {
    return { ok: false, error: `${list.length} scenes is past the ${MAX_SCENES}-scene ceiling for a short — that is a film, not a clip.` };
  }
  if (!Object.prototype.hasOwnProperty.call(ASPECTS, aspect)) {
    return { ok: false, error: `aspect must be one of ${Object.keys(ASPECTS).join(', ')} — got "${aspect}"` };
  }

  const scenes = [];
  let needsGeneration = 0;

  for (const [i, raw] of list.entries()) {
    const n = i + 1;
    const scene = raw && typeof raw === 'object' ? raw : {};
    const narration = String(scene.narration ?? '').trim();
    if (!narration) return { ok: false, error: `scene ${n} has no narration — every scene is a line that gets spoken` };
    if (narration.length > MAX_NARRATION_CHARS) {
      return { ok: false, error: `scene ${n}'s narration is ${narration.length} characters, over the ${MAX_NARRATION_CHARS} ceiling for one beat. Split it into two scenes.` };
    }

    const existing = String(scene.image ?? '').trim();
    const prompt = String(scene.image_prompt ?? '').trim();
    if (!existing && !prompt) {
      return { ok: false, error: `scene ${n} has neither \`image_prompt\` (draw one) nor \`image\` (a picture already in the workspace)` };
    }
    if (!existing) needsGeneration += 1;

    /**
     * ⚠️ THE CAPTION DEFAULTS TO THE NARRATION AND IS THEN LENGTH-CHECKED, so a
     * long line fails as a CAPTION problem with a caption fix, rather than
     * silently producing a subtitle nobody can read. The narration ceiling is
     * five times the caption ceiling on purpose: a beat can be a sentence, a
     * caption has to fit on a phone.
     */
    const caption = String(scene.caption ?? narration).trim();
    if (caption.length > MAX_CAPTION_CHARS) {
      return {
        ok: false,
        error: `scene ${n}'s caption is ${caption.length} characters and the ceiling is ${MAX_CAPTION_CHARS} — `
          + 'it would not fit on a phone screen. Pass a shorter `caption` for this scene (the narration can stay long).',
      };
    }

    scenes.push({
      n,
      narration,
      caption,
      imagePrompt: prompt || null,
      /** ⭐ `.png` is a PLACEHOLDER for the plan only — see `imageFor` below. */
      image: existing || null,
      imagePath: existing || `${dir}/scenes/${pad(n)}.png`,
      audioPath: `${dir}/scenes/${pad(n)}.wav`,
      estimatedSeconds: Number(estimateSpeechSeconds(narration).toFixed(2)),
    });
  }

  if (needsGeneration > MAX_IMAGES_PER_PROCESS) {
    return {
      ok: false,
      error: `${needsGeneration} scenes need a picture drawn and this run may generate at most `
        + `${MAX_IMAGES_PER_PROCESS} images (generate_image's per-process cap). Nothing was generated — the `
        + `refusal would otherwise arrive after ${MAX_IMAGES_PER_PROCESS} were already paid for. `
        + 'Supply the extra shots as `image` paths, or cut scenes.',
    };
  }

  return { ok: true, scenes, needsGeneration };
}

/**
 * Caption cues from the durations the audio actually had.
 *
 * ⚠️ MEASURED, NOT ESTIMATED. `estimateSpeechSeconds` exists to price a run, and
 * it is wrong by whatever the TTS engine's real pace is. A caption timed from an
 * estimate drifts a little on scene 1 and is a full sentence out by scene 6 —
 * the classic subtitle failure, and one that is invisible in every test that
 * does not play the file.
 *
 * @param {Array<{label: string, start: number, end: number}>} timeline
 * @param {string[]} captions
 */
export function captionCues(timeline, captions) {
  return timeline.map((t, i) => ({ start: t.start, end: t.end, text: captions[i] ?? '' }))
    .filter((c) => c.text.trim());
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE VERB
 * ──────────────────────────────────────────────────────────────────────────── */

export async function viral(executor, args = {}, {
  env = process.env, budget = null, allowRun = true,
  speakImpl = speak, designImpl = designVoice, imageImpl = generateImage,
  detectImpl = detectFfmpeg, runImpl = runFfmpeg, spawnImpl,
  /**
   * ⚠️ THREADED SO THE GATE AND THE CALL READ THE SAME ACCOUNT. `speak` takes
   * `home` and resolves the credential itself; if the gate above said yes on a
   * signed-in account and the call below then looked somewhere else, the verb
   * would be offered and fail — the exact "offered and always refuses" shape
   * `tools.mjs` forbids.
   */
  home = undefined,
} = {}) {
  if (!executor || typeof executor.writeFile !== 'function' || !executor.root) {
    return { ok: false, error: 'no workspace is available, so there is nowhere to write the video' };
  }

  const cfg = mediaConfig(env);
  /**
   * ⚠️⚠️ THE OLD MESSAGE NAMED TWO VARIABLES A CUSTOMER CAN NEVER USEFULLY SET.
   * `MEDIA_SECRET_ENV_NAMES` are our own Modal credentials; telling a paying
   * user to export one is the same defect `speakVia`'s note records about
   * `--say` and `--task-audio`, which "printed a message naming a variable they
   * could never usefully set". The route they actually have is their account.
   */
  if (!speakVia(cfg, env, home)) {
    return {
      ok: false,
      error: 'no speech service is available, so there can be no voiceover — sign in with `acuvo --login` so this '
        + 'runs on your plan, or set MODAL_TTS_URL to point at your own speech worker.',
    };
  }

  const title = String(args.title ?? '').trim() || 'short';
  const slug = args.slug ? slugify(args.slug) : slugify(title);
  const parent = String(args.out_dir ?? 'video').trim().replace(/[\\/]+$/, '');
  const dir = `${parent}/${slug}`;

  const aspect = String(args.aspect ?? DEFAULT_ASPECT);
  const captionMode = String(args.captions ?? DEFAULT_CAPTION_MODE);
  if (!CAPTION_MODES.includes(captionMode)) {
    return { ok: false, error: `captions must be one of ${CAPTION_MODES.join(', ')} — got "${args.captions}"` };
  }

  const planned = planScenes(args.scenes, { dir, aspect });
  if (!planned.ok) return planned;
  const { scenes, needsGeneration } = planned;

  const { width, height } = ASPECTS[aspect];
  const fps = Number.isFinite(Number(args.fps)) && Number(args.fps) > 0 ? Math.round(Number(args.fps)) : DEFAULT_FPS;

  /**
   * ⭐ ONE VOICE FOR THE WHOLE VIDEO, and it is a `voice` DESCRIPTION rather
   * than a per-scene choice. A short with a different narrator every four
   * seconds is not a style, it is a bug — and the per-speaker case already has a
   * verb: `podcast`.
   */
  const voice = String(args.voice ?? '').trim();
  const canDesign = Boolean(avatarConfig(env).voiceDesign);
  const via = voice && canDesign ? 'design_voice' : 'speak';
  const warnings = [];
  if (voice && !canDesign) {
    warnings.push('a voice was described but this install cannot reach design_voice (MODAL_VOICE_DESIGN_URL), '
      + 'so the fixed reader narrates it instead');
  }

  /* ── what it will cost ─────────────────────────────────────────────────── */
  const estimate = estimateSpend({
    speakSeconds: scenes.map((s) => s.estimatedSeconds),
    imageCount: needsGeneration,
    env,
  });

  const ffmpeg = detectImpl({ env, spawnImpl });
  const captionFile = captionMode === 'none' ? null : 'captions.srt';
  const outName = `${slug}.mp4`;
  /**
   * ⚠️ THE ARGV IS BUILT FROM THE PLAN, NOT FROM WHAT HAPPENED, so it is present
   * and correct in the un-approved preview — which is the point. A user deciding
   * whether to spend can read the exact command that will run, and a user with
   * no ffmpeg can run it themselves later.
   */
  const argvPreview = slideshowArgv({
    scenes: scenes.map((s) => ({ file: `scenes/${pad(s.n)}.png`, seconds: s.estimatedSeconds })),
    audio: 'voice.wav', captions: captionFile, out: outName,
    width, height, fps, captionMode,
  });

  const preamble = {
    title,
    dir,
    aspect,
    canvas: `${width}x${height}`,
    scenes: scenes.map((s) => ({
      n: s.n, narration: s.narration, caption: s.caption,
      image: s.image ?? `(to draw) ${s.imagePrompt}`,
      estimatedSeconds: s.estimatedSeconds,
    })),
    imagesToDraw: needsGeneration,
    narratedBy: via,
    estimatedSeconds: Number(scenes.reduce((n, s) => n + s.estimatedSeconds, 0).toFixed(1)),
    estimatedUsd: Number(estimate.usd.toFixed(4)),
    costBasis: [...estimate.lines, estimate.basis],
    ffmpeg: {
      available: ffmpeg.ok,
      ...(ffmpeg.ok ? { version: ffmpeg.version } : { reason: ffmpeg.reason }),
      /**
       * ⚠️ THE DURATIONS IN THIS PREVIEW ARE ESTIMATES. The argv that actually
       * runs is rebuilt from the MEASURED audio, and saying so here stops
       * anybody diffing the two and reporting a bug.
       */
      argv: argvPreview,
      note: 'run this with the working directory set to the output folder — every path in it is a bare filename',
    },
    warnings,
  };

  const gate = spendGate({
    approved: args[SPEND_APPROVAL_ARG] === true,
    dryRun: executor.dryRun === true,
    estimateUsd: estimate.usd,
    budget,
    verb: 'viral',
  });
  if (!gate.go) {
    return { ok: true, spent: false, dryRun: executor.dryRun === true, ...preamble, next: gate.why, ...(gate.overBudget ? { overBudget: true } : {}) };
  }

  /* ── produce ───────────────────────────────────────────────────────────── */
  const produced = [];
  const segments = [];

  for (const scene of scenes) {
    /**
     * ⚠️ THE PICTURE FIRST, AND ON PURPOSE. Image generation is the leg most
     * likely to refuse (a per-process cap, a throttled free provider, a closed
     * door), and failing there before the TTS call means one fewer paid request
     * thrown away.
     */
    let imageRel = scene.image;
    if (!imageRel) {
      const drawn = await imageImpl({
        prompt: scene.imagePrompt, executor, env,
        /**
         * ⚠️ EVERY SCENE IS RENDERED AT THE FINAL CANVAS SIZE. Mixed input
         * resolutions are survivable — the per-scene `scale`/`pad` handles them
         * — but asking for the right shape means the pad bars are absent rather
         * than merely correct, and a 9:16 picture composed as 16:9 has its
         * subject cropped out of frame.
         */
        width, height,
      });
      if (!drawn.ok) {
        return { ok: false, error: `scene ${scene.n}: ${drawn.error}`, spent: produced.length > 0, produced, ...preamble };
      }
      imageRel = drawn.path;
      produced.push(drawn.path);
    }

    const spoken = via === 'design_voice'
      ? await designImpl(executor.root, { description: voice, text: scene.narration, path: scene.audioPath }, { env })
      : await speakImpl(executor.root, scene.narration, scene.audioPath, { env, home });
    if (!spoken.ok) {
      return { ok: false, error: `scene ${scene.n} narration: ${spoken.error}`, spent: true, produced, ...preamble };
    }
    produced.push(spoken.path);

    const back = readWorkspaceBinary(executor.root, spoken.path);
    if (!back.ok) return { ok: false, error: `scene ${scene.n}: ${back.error}`, spent: true, produced, ...preamble };

    scene.image = imageRel;
    segments.push({ buf: back.buf, label: `scene ${scene.n}` });
  }

  /* ── the narration track, joined without a binary ──────────────────────── */
  const joined = concatWav(segments);
  if (!joined.ok) {
    return {
      ok: false,
      error: `every scene was produced but the narration could not be joined: ${joined.error}`,
      spent: true, produced, ...preamble,
    };
  }
  const voiceTrack = writeWorkspaceBinary(executor.root, `${dir}/voice.wav`, joined.buffer, false);
  if (!voiceTrack.ok) return { ok: false, error: voiceTrack.error, spent: true, produced, ...preamble };
  produced.push(voiceTrack.path);

  /* ── captions, timed from the audio that exists ────────────────────────── */
  let captionsWritten = null;
  if (captionFile) {
    const cues = captionCues(joined.timeline, scenes.map((s) => s.caption));
    const w = executor.writeFile(`${dir}/${captionFile}`, toSrt(cues));
    if (!w.ok) return { ok: false, error: `${dir}/${captionFile}: ${w.error}`, spent: true, produced, ...preamble };
    captionsWritten = w.path;
    produced.push(w.path);
  }

  /**
   * ⭐ THE ARGV THAT ACTUALLY RUNS, REBUILT FROM MEASURED DURATIONS. Every scene
   * is shown for exactly as long as its own narration lasts, so the picture and
   * the words cannot drift apart — which is the one thing a viewer notices
   * immediately and no test that skips playback can see.
   */
  const argv = slideshowArgv({
    scenes: scenes.map((s, i) => ({
      // ⚠️ THE ENGINE'S OWN EXTENSION, not the `.png` the plan guessed:
      // `generate_image` returns .png OR .jpg depending on which provider
      // answered, and a filename written before the render is wrong every time
      // the free fallback serves you. `pipe_to_asset` exists for this exact bug.
      file: relativeTo(dir, s.image),
      seconds: joined.timeline[i].seconds,
    })),
    audio: 'voice.wav', captions: captionFile, out: outName,
    width, height, fps, captionMode,
  });

  /* ── the cut ───────────────────────────────────────────────────────────── */
  let video = null;
  let ffmpegNote = null;
  const workdir = dirname(voiceTrack.absolute);
  if (!allowRun) {
    ffmpegNote = '--no-run is in force, so no process was started and the mp4 was NOT cut. Everything it needs is '
      + `on disk; run this in ${dir}:  ffmpeg ${argv.join(' ')}`;
  } else if (!ffmpeg.ok) {
    ffmpegNote = `${ffmpeg.reason} Every asset is on disk and the narration track is finished — run this in ${dir} `
      + `once ffmpeg is installed:  ffmpeg ${argv.join(' ')}`;
  } else {
    const ran = runImpl({ bin: ffmpeg.bin, argv, cwd: workdir, spawnImpl });
    if (ran.ok) { video = `${dir}/${outName}`; produced.push(video); }
    else ffmpegNote = `the assets are all on disk, but the cut failed: ${ran.error}`;
  }

  const manifest = [
    `# ${title}`, '',
    `- ${scenes.length} scenes · ${aspect} (${width}×${height}) · ${joined.seconds.toFixed(1)}s`,
    video ? `- \`${outName}\` — the finished video` : '- the mp4 has NOT been cut yet (see below)',
    '- `voice.wav` — the full narration, joined',
    ...(captionsWritten ? ['- `captions.srt` — timed from the real audio, not estimated'] : []),
    '- `scenes/` — one image and one narration file per scene, so a single beat can be redone',
    '',
    '## The cut', '',
    'Run from inside this folder — every path in the command is a bare filename:', '',
    '```', `ffmpeg ${argv.join(' ')}`, '```', '',
    ...(ffmpegNote ? [ffmpegNote, '', `Install ffmpeg with:  ${ffmpegInstallHint()}`, ''] : []),
    ...(warnings.length ? ['## Warnings', '', ...warnings.map((w) => `- ${w}`), ''] : []),
  ].join('\n');
  executor.writeFile(`${dir}/README.md`, manifest);

  return {
    ok: true,
    spent: true,
    ...preamble,
    /**
     * ⚠️ THE PREAMBLE'S SCENE LIST SAYS "(to draw) …" AND THAT MUST NOT SURVIVE
     * INTO A FINISHED RESULT. The pictures exist now, at paths the caller needs
     * in order to reuse or replace one. A summary still describing intentions
     * after the work is done is the report nobody checks twice.
     */
    scenes: scenes.map((s, i) => ({
      n: s.n, narration: s.narration, caption: s.caption,
      image: s.image, audio: s.audioPath, seconds: Number(joined.timeline[i].seconds.toFixed(2)),
    })),
    // ⚠️ Overwrites the preamble's estimate-built copy with what really ran.
    ffmpeg: { available: ffmpeg.ok, ...(ffmpeg.ok ? { version: ffmpeg.version } : { reason: ffmpeg.reason }), argv, cwd: dir },
    video,
    voiceTrack: voiceTrack.path,
    captions: captionsWritten,
    seconds: Number(joined.seconds.toFixed(2)),
    sceneSeconds: joined.timeline.map((t) => Number(t.seconds.toFixed(2))),
    files: produced,
    ...(ffmpegNote ? { ffmpegNote } : {}),
    next: video
      ? 'watch it before publishing — synthetic narration mispronounces names, and the per-scene files mean one bad beat can be redone without paying for the rest'
      : 'every asset is on disk; the mp4 is the one step left and the exact command is above',
  };
}

/**
 * A path inside `dir`, expressed from `dir`.
 *
 * ⚠️ ffmpeg RUNS WITH `cwd` SET TO THE OUTPUT FOLDER, so an image that lives
 * inside it must be named relative to it — and one the caller supplied from
 * somewhere else in the workspace must be reached by going up. Getting this
 * backwards produces "No such file or directory" after every GPU second is
 * already spent.
 */
export function relativeTo(dir, workspacePath) {
  const from = String(dir ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
  const to = String(workspacePath ?? '').replace(/^\.\//, '');
  if (from && to.startsWith(`${from}/`)) return to.slice(from.length + 1);
  const up = from ? from.split('/').map(() => '..').join('/') : '';
  return up ? `${up}/${to}` : to;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. REGISTRATION
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ OFFERED ONLY WHERE THERE IS A SPEECH SERVICE — a video verb with no
 * voiceover is a slideshow, and advertising it teaches the model to promise
 * something the product refuses. ⚠️ AND NEVER ON A SINGLE-SHOT TURN: this is the
 * most expensive verb in the package, and one round is enough to buy the render
 * and not enough to look at it.
 */
export function viralToolNames(env = process.env, { maxRounds = 2, home = undefined } = {}) {
  if (maxRounds <= 1) return [];
  /**
   * ⚠️ `home` IS THREADED, NOT DEFAULTED HERE, for the reason `mediaToolNames`
   * gives: without it, WHICH TOOLS A RUN OFFERS would depend on whether the
   * person executing it happens to be signed in, so a test asserting the tool
   * list would pass on one laptop and fail on another.
   */
  return speakVia(mediaConfig(env), env, home) ? [...VIRAL_TOOL_NAMES] : [];
}

export function viralToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'viral',
        description: [
          'Cut a short vertical video: you supply ordered scenes (narration + a shot description),',
          'it draws each image, narrates each line, times the captions from the REAL audio and muxes one mp4.',
          '⚠️ SPENDS on our GPUs and fans out — it prices the whole run and generates NOTHING on the first',
          `call; read the estimate back to the user, then call again with ${SPEND_APPROVAL_ARG}: true.`,
          'ffmpeg is optional: without it you still get every image, the narration track and the exact command.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Names the output folder and the mp4.' },
            scenes: {
              type: 'array',
              description: `Ordered beats, ${MAX_SCENES} max. Each scene is one spoken line and one picture.`,
              items: {
                type: 'object',
                properties: {
                  narration: { type: 'string', description: `What is said over this beat. Max ${MAX_NARRATION_CHARS} characters.` },
                  image_prompt: { type: 'string', description: 'What to draw for this beat — subject, style, lighting, composition.' },
                  image: { type: 'string', description: 'Instead of drawing: a picture already in the workspace. Does not count against the image cap.' },
                  caption: { type: 'string', description: `On-screen text. Defaults to the narration. Max ${MAX_CAPTION_CHARS} characters.` },
                },
                required: ['narration'],
              },
            },
            aspect: { type: 'string', enum: Object.keys(ASPECTS), description: 'Default 9:16 (vertical).' },
            captions: { type: 'string', enum: CAPTION_MODES, description: 'soft (default, a real caption track), burn (needs an ffmpeg built with libass; what social autoplay needs), or none.' },
            voice: { type: 'string', description: 'What the narrator sounds like, e.g. "warm Australian woman, unhurried". Ignored where design_voice is unreachable.' },
            out_dir: { type: 'string', description: 'Parent folder. Default "video".' },
            [SPEND_APPROVAL_ARG]: { type: 'boolean', description: 'Set true ONLY after the user has seen the estimate from a first call.' },
          },
          required: ['scenes'],
        },
      },
    },
  ];
}

export async function runViralTool(name, args = {}, deps = {}) {
  if (name !== 'viral') return { ok: false, error: `unknown viral tool "${name}"` };
  const { executor, ...rest } = deps;
  return viral(executor, args, rest);
}
