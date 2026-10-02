/**
 * ── ⭐⭐⭐ THE MOAT, REACHABLE FROM THE TERMINAL ─────────────────────────────
 *
 * Roman, 2026-08-22: *"does it have all our GPU Modal integrations, the 4
 * related to face and voice… even if it's not paid just wire in the endpoints
 * to CLI."*
 *
 * ⚠️ MEASURED THE SAME DAY: the CLI had **9 of the console's 20** Modal
 * endpoints, and every one of the missing eleven was a moat capability —
 * `MODAL_AVATAR_URL` (the face), `MODAL_CHARACTER_LOCK_URL` (identity),
 * `MODAL_VOICE_CLONE_URL`, `MODAL_VOICE_DESIGN_URL`, `MODAL_VIDEO_URL`. The CLI
 * shipped generic TTS and transcription: the two things anybody can rent. The
 * cloned voice and the talking head — the parts no competitor can draw, running
 * on GPUs we already pay for — were console-only.
 *
 * `lib/media.mjs`'s own `speak` tool said it out loud: *"voice cloning
 * ('acuvo-voice') is not reachable from the CLI and will be refused."* That was
 * an honest description of a gap, not a design.
 *
 * ── ⚠️ THE RULES THIS FILE INHERITS AND MUST NOT BREAK ──────────────────────
 *
 * · **Zero dependencies, and never import from `console/`.** Plain HTTPS to
 *   endpoints named by the environment. The moment this imports upward the CLI
 *   stops being installable on its own.
 * · **A tool is OFFERED only when its endpoint is configured.** Advertising a
 *   verb that cannot run teaches the model to promise things the product then
 *   refuses — the most expensive kind of lie a tool schema can tell.
 * · **These are LONG jobs.** A talking head is minutes, not seconds; the API is
 *   start-then-poll, and `running` is the healthy answer for most of a render's
 *   life. Treating it as failure is what made our own working GPU look dead for
 *   days.
 */

import { priceGpuCall, DEFAULT_BUDGET_USD } from './budget.mjs';
import { falConfig } from './fal.mjs';

/** Renders are minutes long; this is the ceiling on the whole job, not one poll. */
/**
 * ── ⚠️⚠️ DECLARED HERE BECAUSE IT WAS USED 193 LINES BEFORE IT EXISTED ───────
 *
 * This `const` sat at line 660 and `avatarToolSchemas` reads it at line 467. A
 * `const` is hoisted into a TEMPORAL DEAD ZONE, not initialised, so reading it
 * before its declaration line has EVALUATED is a ReferenceError — not undefined,
 * a throw. Measured: `every declared tool has a handler` failed with
 * `ReferenceError: SPEND_APPROVAL_ARG is not defined`, which reads like a
 * missing export and is actually an ordering bug.
 *
 * ⭐ AND THE FILE'S OWN COMMENT PREDICTED THE CAUSE. The declaration is
 * duplicated from `media-pipeline.mjs` deliberately, to avoid the cycle
 * `media-pipeline → imagegen → creative-engines → avatar` — and a cycle is
 * exactly the condition under which a module body is entered PARTIALLY
 * evaluated, so a late `const` is unreachable while an early one is fine. The
 * duplication argument was right; the placement made it fragile.
 *
 * ⚠️ THE DUPLICATION STAYS, and `avatar-approval-arg-matches-media-pipeline`
 * still pins the two strings equal. Importing it here is what the comment below
 * warns would make the module graph unloadable.
 */
const SPEND_APPROVAL_ARG = 'approve_spend';

export const DEFAULT_JOB_BUDGET_MS = 12 * 60 * 1000;
/** How often to ask. Modal charges per container-second, not per poll. */
export const POLL_INTERVAL_MS = 5_000;

/**
 * ── ⭐⭐⭐ THE ADDRESSES SHIP WITH THE PACKAGE. THIS IS THE WHOLE FIX. ───────
 *
 * Roman, 2026-08-24: *"everything GPU should be native, everything. So MODAL
 * CONNECTION IS KEY."*
 *
 * ⚠️⚠️ MEASURED 2026-08-25 AND IT IS THE FINDING OF THIS LANE: this module was
 * the ONLY creative module in the package with no built-in endpoint. Compare —
 *
 *     media.mjs        DEFAULT_TTS_URL · DEFAULT_TRANSCRIBE_URL · DEFAULT_PRESS_URL
 *                      DEFAULT_DOC_READ_URL · DEFAULT_TABLE_READ_URL
 *     image-edit.mjs   DEFAULT_SELECT_URL · DEFAULT_FLUX_URL
 *     imagegen.mjs     DEFAULT_IMAGE_URL · DEFAULT_ENGINE_URL
 *     avatar.mjs       ← nothing. Five moat verbs, zero addresses.
 *
 * ⭐ WHICH MEANT THE MOAT WAS DARK ON EVERY INSTALL THAT WAS NOT OURS. The URLs
 * lived in `console/.env.local` — a file that ships to nobody — and
 * `avatarToolSchemas` only offers a verb whose URL is set. So `clone_voice`,
 * `design_voice`, `character_lock`, `talking_head` and `generate_video` were
 * never even OFFERED to the model outside the console working directory, while
 * `speak` and `edit_image` (the two things anybody can rent) worked everywhere.
 * The capability was built, fixed twice, credit-priced — and unreachable in the
 * one way that matters. Exactly the failure this repo has paid for repeatedly.
 *
 * ⚠️ THESE ARE ADDRESSES, NOT CREDENTIALS. Publishing a URL grants nothing: the
 * services read `item.get("secret")` from the body and answer `{"ok":false,
 * "error":"unauthorised"}` without it. The secret stays out of the package, and
 * it remains the one gate — which is why `avatarConfig` still returns null for
 * everything when there is no secret, exactly as before.
 */
export const DEFAULT_AVATAR_URL = 'https://xxiautomate-star--acuvo-avatar-avatar.modal.run';
export const DEFAULT_AVATAR_RESULT_URL = 'https://xxiautomate-star--acuvo-avatar-avatar-result.modal.run';
export const DEFAULT_VOICE_CLONE_URL = 'https://xxiautomate-star--acuvo-voice-clone-voice-clone.modal.run';
export const DEFAULT_VOICE_DESIGN_URL = 'https://xxiautomate-star--acuvo-voice-design-voice.modal.run';
export const DEFAULT_CHARACTER_LOCK_URL = 'https://xxiautomate-star--acuvo-character-lock-character-lock.modal.run';
export const DEFAULT_VIDEO_URL = 'https://xxiautomate-star--acuvo-video-render.modal.run';
export const DEFAULT_VIDEO_RESULT_URL = 'https://xxiautomate-star--acuvo-video-result.modal.run';

/**
 * Resolve one start/result PAIR.
 *
 * ⚠️ THREE STATES, NOT TWO, and collapsing them is how a deliberate opt-out
 * becomes a surprise network call — `mediaConfig` argues the same point and this
 * copies its rule rather than inventing a second one:
 *
 *   unset            → use ours
 *   set to a value   → use theirs
 *   set to EMPTY     → OFF. Somebody on an air-gapped box turned it off on purpose.
 *
 * ⚠️ AND A CUSTOM START URL NEVER INHERITS *OUR* RESULT URL. If an operator
 * points `MODAL_VIDEO_URL` at their own deployment and sets no result URL, the
 * poll has to go back to THEIR host — polling ours would ask our service about a
 * callId it has never issued, and the honest-looking answer would be a failure
 * on a job that is running fine somewhere else.
 */
function endpointPair(env, secret, startKey, resultKey, defaultStart, defaultResult) {
  const off = startKey in env && (env[startKey] ?? '').trim() === '';
  if (off || !secret) return { start: null, result: null };
  const customStart = env[startKey]?.trim() || null;
  const customResult = env[resultKey]?.trim() || null;
  const start = customStart || defaultStart;
  const result = customResult || (customStart ? customStart : defaultResult);
  return { start, result };
}

/**
 * Which of the five are reachable here.
 *
 * ⚠️ EVERY ONE NEEDS THE SECRET AS WELL AS THE URL. A URL with no secret is a
 * 401 wearing the costume of a working integration, and it would be reported as
 * "configured" by any check that only looked for the address. That is now the
 * ONLY thing an install has to supply — which is the point.
 */
export function avatarConfig(env = process.env) {
  const secret = env.ACUVO_MEDIA_SECRET?.trim() || env.MODAL_VIDEO_SECRET?.trim() || null;
  const pair = (a, b, c, d) => endpointPair(env, secret, a, b, c, d);

  /** The talking head — an image plus audio becomes a person speaking. */
  const face = pair('MODAL_AVATAR_URL', 'MODAL_AVATAR_RESULT_URL', DEFAULT_AVATAR_URL, DEFAULT_AVATAR_RESULT_URL);
  /** Text or image to video. */
  const video = pair('MODAL_VIDEO_URL', 'MODAL_VIDEO_RESULT_URL', DEFAULT_VIDEO_URL, DEFAULT_VIDEO_RESULT_URL);
  /**
   * The voice services and the character lock are SYNCHRONOUS — they hand the
   * artifact back in the start response — so their "result" URL is themselves.
   * `runJob` never polls them, and `readImmediate` is why.
   */
  const voiceClone = pair('MODAL_VOICE_CLONE_URL', 'MODAL_VOICE_CLONE_URL', DEFAULT_VOICE_CLONE_URL, DEFAULT_VOICE_CLONE_URL);
  const voiceDesign = pair('MODAL_VOICE_DESIGN_URL', 'MODAL_VOICE_DESIGN_URL', DEFAULT_VOICE_DESIGN_URL, DEFAULT_VOICE_DESIGN_URL);
  const characterLock = pair('MODAL_CHARACTER_LOCK_URL', 'MODAL_CHARACTER_LOCK_URL', DEFAULT_CHARACTER_LOCK_URL, DEFAULT_CHARACTER_LOCK_URL);

  return {
    face: face.start,
    faceResult: face.result,
    voiceClone: voiceClone.start,
    voiceDesign: voiceDesign.start,
    /**
     * The same person, again. A locked character keeps ONE identity across
     * every render, which is the difference between a stock photo and an
     * employee somebody recognises.
     */
    characterLock: characterLock.start,
    video: video.start,
    videoResult: video.result,
    secret,
  };
}

/**
 * Read a start-job response.
 *
 * ⚠️ PURE, SO THE CONTRACT IS TESTABLE WITHOUT A GPU. Everything that decides
 * whether a job succeeded lives in these two functions; the network is only a
 * transport around them. The console's client got this shape right and the
 * reasoning is worth restating rather than re-deriving.
 */
export function readStart(body) {
  const callId = body?.callId ?? body?.call_id;
  if (body?.ok !== true || typeof callId !== 'string' || !callId) {
    return { ok: false, error: String(body?.error ?? 'the endpoint returned no callId') };
  }
  return { ok: true, callId };
}

/**
 * The artifact, whichever key this service calls it by.
 *
 * ── ⚠️⚠️ OUR OWN SERVICES DISAGREE ABOUT THE FIELD NAME ───────────────
 *
 * Measured 2026-08-23: the voice services return the WAV under `audio`, while
 * this module asked for `audio_b64` — the name the face service uses for its
 * INPUT. So a completed, paid-for render was discarded for being under the
 * wrong key, and the CLI reported it as a missing artifact.
 *
 * ⭐ A LIST, NOT A RENAME. Renaming to `audio` would have fixed voice and left
 * the next service to break the same way. Accepting the handful of names our
 * own fleet actually uses costs one loop and makes the reader immune to a
 * naming choice made in a Python file it never sees.
 */
export function pickArtifact(body, field) {
  const names = Array.isArray(field) ? field : [field];
  for (const name of names) {
    const v = body?.[name];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Did the endpoint just ANSWER, rather than queue?
 *
 * ── ⚠️⚠️⚠️ HALF OUR GPU SERVICES ARE SYNCHRONOUS AND WE ASSUMED NONE WERE ──
 *
 * Measured 2026-08-23. The face renderer is asynchronous — it answers
 * `{ok:true,status:"queued",callId}` and you poll for the mp4. But the VOICE
 * services hand back the finished audio in the very first response, with no
 * `status` and no `callId` at all:
 *
 *     {"ok":true,"audio_b64":"…","contentType":"audio/wav","sampleRate":24000}
 *
 * ⚠️ `readStart` demands a `callId`, so against a synchronous endpoint it
 * reported **"the endpoint returned no callId"** — while holding the completed
 * audio in its hand. The work was done, paid for on our GPU, and thrown away
 * one line before it would have been written to disk.
 *
 * ⭐ CHECKED BEFORE `readStart`, never instead of it. An async endpoint has no
 * artifact in its start response, so this returns null for it and the poll loop
 * runs exactly as before.
 *
 * @returns the finished artifact, or null if this response is a queue ticket.
 */
export function readImmediate(body, { field = 'video_b64', minBytes = 1000 } = {}) {
  if (body?.ok !== true) return null;
  const artifact = pickArtifact(body, field);
  if (typeof artifact !== 'string' || artifact.length < minBytes) return null;
  return {
    status: 'done',
    base64: artifact,
    bytes: Number(body?.bytes ?? 0),
    seconds: Number(body?.seconds ?? 0),
    usd: Number(body?.usd ?? 0),
  };
}

/**
 * Read a poll response.
 *
 * ⚠️⚠️ `running` IS SUCCESS-IN-PROGRESS, NOT FAILURE, and it is the answer for
 * most of a render's life. This distinction is why our own working GPU was
 * reported dead for days.
 *
 * ⚠️ AND A `done` CARRYING NO ARTIFACT IS A FAILURE, not an empty success. An
 * empty string is a valid field and silence is a valid WAV; this repo has
 * shipped both mistakes, and each time it surfaced as a file the user could not
 * play rather than as an error they could act on.
 */
export function readPoll(body, { field = 'video_b64', minBytes = 1000 } = {}) {
  if (body?.ok !== true) return { status: 'failed', error: String(body?.error ?? 'poll failed') };
  const status = String(body?.status ?? '');
  if (status === 'running' || status === 'pending' || status === 'queued') return { status: 'running' };
  if (status !== 'done') return { status: 'failed', error: String(body?.error ?? `unexpected status ${status}`) };

  const artifact = pickArtifact(body, field);
  if (typeof artifact !== 'string' || artifact.length < minBytes) {
    return { status: 'failed', error: `the job reported done but returned no ${[field].flat().join(' / ')}` };
  }
  return {
    status: 'done',
    base64: artifact,
    bytes: Number(body?.bytes ?? 0),
    seconds: Number(body?.seconds ?? 0),
    usd: Number(body?.usd ?? 0),
  };
}

/**
 * Should we keep waiting?
 *
 * ⚠️ THE BUDGET IS ON WALL CLOCK, NOT ON POLL COUNT. A poll count silently
 * becomes a different timeout the moment the interval changes, and the number
 * that matters to a user — and to a Modal bill — is minutes.
 */
export function keepPolling({ startedAt, now, budgetMs = DEFAULT_JOB_BUDGET_MS }) {
  return now - startedAt < budgetMs;
}

/**
 * ── ⭐ THE BACKEND CHOICE, DESCRIBED ONLY WHEN THERE IS A CHOICE ───────────
 *
 * ⚠️ AN ENUM OF ONE IS A TRAP. If FAL is unusable, offering `backend: "fal"`
 * would let the model pick a route that always refuses, and it would read as the
 * product being broken rather than as a bill being unpaid. When our GPU is the
 * only route the property is omitted entirely; when FAL is the only route it is
 * still named, because then it is the ONLY way the verb works and the model has
 * to ask for it.
 */
function backendProperty(ownGpu, rented, whichModels) {
  if (!rented) return undefined;
  const choices = ownGpu ? ['acuvo', 'fal'] : ['fal'];
  return {
    type: 'string',
    enum: choices,
    description: ownGpu
      ? `Where to render. "acuvo" (default) is our own GPU and is metered by --budget. `
        + `"fal" rents ${whichModels} — it is NEVER chosen for you, its per-call price is unknown to this `
        + 'package, and it always asks for approve_spend first.'
      : `Only "fal" is available here (${whichModels}) — our own GPU is not configured on this install, `
        + 'so this must be named explicitly. Its per-call price is unknown to this package.',
  };
}

/**
 * The tool schemas, offered only for endpoints that exist.
 *
 * ⚠️ THE DESCRIPTIONS SAY WHAT THESE COST AND HOW LONG THEY TAKE. A model with
 * no sense of price will call a 7-minute GPU render to put a talking head on a
 * placeholder page, and the user finds out when the bill arrives. Naming the
 * cost in the schema is the cheapest guardrail available.
 */
export function avatarToolSchemas(env = process.env) {
  const cfg = avatarConfig(env);
  /**
   * ── ⭐ A VERB IS OFFERED WHEN *EITHER* BACKEND CAN RUN IT ──────────────────
   *
   * Roman: *"any APIs (like FAL) even if not topped up, APIs should be wired."*
   * A deployment with a FAL key and no Modal secret can genuinely render a clip,
   * so hiding the verb from it would be the same dead-end as hiding it from a
   * Modal deployment — the capability is present, only the route differs.
   *
   * ⚠️ AND FAL IS "USABLE" ONLY WHEN A HUMAN HAS ASSERTED A BALANCE. A key with
   * an exhausted account offers a verb that refuses every call, which is worse
   * than a missing verb: it teaches the model to keep promising the thing.
   */
  const rented = falConfig(env).usable;
  const out = [];

  if (cfg.voiceClone) {
    out.push({
      type: 'function',
      function: {
        name: 'clone_voice',
        description: [
          'Clone a voice from a short audio sample, then speak arbitrary text in it.',
          'Runs on our own GPU. A 10-30 second clean sample is enough.',
          '⚠️ Only use a voice the user owns or has permission to use — ask if it is not obviously theirs.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            sample: { type: 'string', description: 'Workspace-relative path to the reference audio (wav/mp3).' },
            text: { type: 'string', description: 'What the cloned voice should say.' },
            path: { type: 'string', description: 'Optional output path, e.g. "audio/vo.wav".' },
          },
          required: ['sample', 'text'],
        },
      },
    });
  }

  if (cfg.voiceDesign) {
    out.push({
      type: 'function',
      function: {
        name: 'design_voice',
        description: [
          'Create a NEW voice from a description ("warm Australian woman, mid 30s, unhurried")',
          'without needing a sample, then speak text in it. Use when there is nobody to clone.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What the voice should sound like.' },
            text: { type: 'string', description: 'What it should say.' },
            path: { type: 'string', description: 'Optional output path.' },
          },
          required: ['description', 'text'],
        },
      },
    });
  }

  if (cfg.characterLock) {
    out.push({
      type: 'function',
      function: {
        name: 'character_lock',
        description: [
          'Render the SAME PERSON again in a new scene, from reference photos of them.',
          'Use when a character must stay recognisable across several images — an employee, a mascot, a cast.',
          '⚠️ Needs at least TWO reference photos of the same person: one reference copies the photograph rather than the person.',
          '⚠️ Only for a face the user has the right to use.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            references: {
              type: 'array',
              items: { type: 'string' },
              description: 'Workspace-relative paths to 2-4 photos of the SAME person.',
            },
            prompt: { type: 'string', description: 'What they should be doing — scene, pose, lighting, wardrobe.' },
            path: { type: 'string', description: 'Optional output path, e.g. "images/rachel-desk.png".' },
            seed: { type: 'number', description: 'Optional seed, to reproduce an earlier render exactly.' },
          },
          required: ['references', 'prompt'],
        },
      },
    });
  }

  if (cfg.face || rented) {
    out.push({
      type: 'function',
      function: {
        name: 'talking_head',
        description: [
          'Turn a photo plus an audio file into a video of that person speaking — our own GPU,',
          'measured at about a third of what HeyGen charges.',
          '⚠️ SLOW AND NOT FREE: minutes per render, priced per video-second. Do not use it for a',
          'placeholder; generate the final audio first and render once.',
          '⚠️ Only for a face the user has the right to use.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            image: { type: 'string', description: 'Workspace-relative path to a portrait image.' },
            audio: { type: 'string', description: 'Workspace-relative path to the speech audio.' },
            path: { type: 'string', description: 'Optional output path, e.g. "video/intro.mp4".' },
            backend: backendProperty(cfg.face, rented, 'sync-lipsync'),
          },
          required: ['image', 'audio'],
        },
      },
    });
  }

  if (cfg.video || rented) {
    out.push({
      type: 'function',
      function: {
        name: 'generate_video',
        description: [
          'Generate a short video from a text prompt, or animate a still image.',
          '⚠️ THE MOST EXPENSIVE THING HERE — minutes of GPU per clip. Ask before using it on a',
          'plan that does not include video, and never call it speculatively.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What should happen in the clip — subject, motion, camera, mood.' },
            image: { type: 'string', description: 'Optional workspace-relative still to animate instead of generating from scratch.' },
            seconds: { type: 'number', description: 'Clip length. Keep it short; cost is per second.' },
            path: { type: 'string', description: 'Optional output path, e.g. "video/hero.mp4".' },
            backend: backendProperty(cfg.video, rented, 'Wan 2.2 / Kling'),
          },
          required: ['prompt'],
        },
      },
    });
  }

  /**
   * ── ⭐⭐ THE HANDSHAKE IS ADDED WHERE THE PRICE EARNS IT, BY ARITHMETIC ─────
   *
   * ⚠️ A PARAMETER THAT DOES NOTHING IS NOISE, and noise in a schema is head
   * bytes on every round of every run. So `approve_spend` appears only on the
   * verbs whose warm estimate crosses `APPROVAL_THRESHOLD_USD` — not on a list
   * of names somebody typed, which would drift the first time a card or a model
   * changed. `needsApproval` is the single source, here and in `preflight`, so
   * the schema cannot advertise a handshake the runner does not enforce, or
   * hide one it does.
   */
  for (const tool of out) {
    /**
     * ⚠️ `backendProperty` RETURNS undefined WHEN THERE IS NO CHOICE, and an
     * `undefined` value still leaves a KEY on the object. `JSON.stringify` drops
     * it on the wire, so the model never sees it — but `Object.keys` does, and
     * anything auditing the schema shape would report a parameter that does not
     * exist. Deleting it keeps the in-memory object and the serialised one
     * telling the same story.
     */
    for (const [k, v] of Object.entries(tool.function.parameters.properties)) {
      if (v === undefined) delete tool.function.parameters.properties[k];
    }
    if (!needsApproval(tool.function.name)) continue;
    const warm = estimateJobUsd(tool.function.name, { cold: false });
    tool.function.parameters.properties[SPEND_APPROVAL_ARG] = {
      type: 'boolean',
      description: `Set true ONLY after telling the user the price. Without it this verb refuses and `
        + `spends nothing. Roughly $${warm.usd.toFixed(3)} per call on a warm container `
        + `(a floor, not a quote) — over the $${APPROVAL_THRESHOLD_USD} bar at which this package stops and asks.`,
    };
  }

  return out;
}

export function avatarToolNames(env = process.env) {
  return avatarToolSchemas(env).map((t) => t.function.name);
}

/**
 * Why a verb is missing, in words a user can act on.
 *
 * ⚠️ "UNKNOWN TOOL" IS THE WRONG ANSWER AND WE HAVE SHIPPED IT. When the model
 * reaches for a capability the product genuinely has but this deployment has not
 * configured, the user needs to know WHICH variable is missing — not that the
 * feature does not exist. One says "set this"; the other says "we cannot do
 * that", and only one of them is true.
 */
export const AVATAR_ENV = Object.freeze({
  clone_voice: 'MODAL_VOICE_CLONE_URL',
  design_voice: 'MODAL_VOICE_DESIGN_URL',
  character_lock: 'MODAL_CHARACTER_LOCK_URL',
  talking_head: 'MODAL_AVATAR_URL',
  generate_video: 'MODAL_VIDEO_URL',
});

export function whyUnavailable(name, env = process.env) {
  const cfg = avatarConfig(env);
  const needs = AVATAR_ENV[name];
  if (!needs) return null;
  /**
   * ⭐ SINCE THE ADDRESSES SHIP, THE SECRET IS ALMOST ALWAYS THE WHOLE ANSWER —
   * and one sentence naming ONE variable is worth more than a paragraph. This
   * used to say "as well as MODAL_…_URL", which sent people to set two things
   * when only one was ever missing.
   */
  if (!cfg.secret) {
    return `${name} runs on our own GPU and needs ACUVO_MEDIA_SECRET (or MODAL_VIDEO_SECRET) — `
      + 'the endpoint address ships with this package, but without the secret the service answers '
      + '"unauthorised". That one variable turns on cloned voice, designed voice, character lock, '
      + 'the talking head and video together.';
  }
  /**
   * ⚠️ A "WHY IS THIS MISSING" FUNCTION MUST NOT INVENT A REASON FOR SOMETHING
   * THAT IS PRESENT. With the addresses shipping, a secret alone means every
   * verb works — so the honest answer for a configured verb is "nothing is
   * wrong", not a plausible sentence about a variable nobody has touched. A
   * red-herring is worse than silence: it sends somebody to edit config that was
   * already correct.
   */
  const gate = { clone_voice: 'voiceClone', design_voice: 'voiceDesign', character_lock: 'characterLock', talking_head: 'face', generate_video: 'video' }[name];
  if (cfg[gate]) return null;

  /**
   * The only way to be here with a secret is an explicit `MODAL_…_URL=` — the
   * documented opt-out. Saying "not configured" would be false; it IS
   * configured, to off.
   */
  return `${name} is switched off here: ${needs} is set to an empty value, which this package reads as `
    + '"do not call it". Unset it to use the built-in endpoint, or point it at your own.';
}

/* ────────────────────── WHAT IT COSTS, BEFORE IT RUNS ───────────────────── */

/**
 * ── ⭐⭐⭐ THE PRICE HAS TO BE SAID *BEFORE* THE MONEY MOVES ────────────────
 *
 * Roman's rule for this lane, verbatim: *"Each verb must state its estimated
 * cost before running and respect --budget and --approve."*
 *
 * ⚠️⚠️ AND MEASURED 2026-08-25, THESE FIVE WERE THE ONLY GPU VERBS IN THE
 * PACKAGE THAT CHARGED NOTHING AT ALL. `chargeGpu` is called by `imagegen.mjs`
 * and by `media.mjs`, and by nothing in `avatar-run.mjs` — so a seven-minute
 * A100 talking-head render reported **$0.0000** to `--budget`, to
 * `--fleet-budget` and to `acuvo spend`, while a two-second TTS line was
 * counted to four decimal places. The cheapest verbs were metered and the
 * dearest ones were free. A budget that cannot see the expensive half of the
 * product is not a budget.
 *
 * ── ⚠️ HOW LONG EACH ONE TAKES, AND WHICH NUMBERS ARE REAL ─────────────────
 *
 * `measured: true` means somebody ran it and timed it, and the source is named.
 * Everything else is an ASSUMPTION and says so — an estimate whose provenance
 * is invisible becomes a fact the next reader quotes.
 */
export const JOB_SECONDS = Object.freeze({
  clone_voice: Object.freeze({
    warm: 8.8, cold: 75.3, measured: true,
    source: 'measured 2026-08-23 against the live service (see avatar-run.mjs POST_TIMEOUT_MS)',
  }),
  design_voice: Object.freeze({
    warm: 26.9, cold: 50.9, measured: true,
    source: 'measured 2026-08-23 against the live service',
  }),
  talking_head: Object.freeze({
    warm: 330, cold: 400, measured: true,
    source: 'measured 396.9s / 332.2s / 398.0s on A100-80GB (console model-registry, `avatar` capability)',
  }),
  character_lock: Object.freeze({
    warm: 25, cold: 90, measured: false,
    source: 'ASSUMED — a diffusion pass with 2-4 references, timed by nobody yet',
  }),
  generate_video: Object.freeze({
    warm: 120, cold: 190, measured: false,
    source: 'ASSUMED — Wan at the default 61 frames, timed by nobody yet',
  }),
});

/**
 * ── ⚠️⚠️ THIS IS A FLOOR, AND CALLING IT ANYTHING ELSE WOULD BE A LIE ──────
 *
 * `priceGpuCall` is the package's ONE price function and this uses it rather
 * than inventing a second table — media-pipeline.mjs makes that argument and it
 * has already been paid for once. But its published rate is the **A10G**
 * ($0.000306/s), and the talking-head renderer is measured on an **A100-80GB**,
 * which costs several times more per second.
 *
 * ⭐ SO THE NUMBER IS DELIBERATELY THE LOW END, AND THE WORD "floor" TRAVELS
 * WITH IT. That is the safe direction for a gate: a refusal fires only when even
 * the optimistic figure does not fit, so this can never fail correct work —
 * which is the failure this repo holds to be worse than not checking at all.
 * The honest fix is an A100 rate in `budget.mjs`, and that file is not this
 * lane's to edit; it is named here rather than papered over.
 *
 * @returns {{usd: number, seconds: number, cold: boolean, measured: boolean, basis: string}}
 */
export function estimateJobUsd(verb, { cold = true, seconds = null, priceImpl = priceGpuCall } = {}) {
  const row = JOB_SECONDS[verb];
  const wall = Number.isFinite(seconds) && seconds > 0
    ? Number(seconds)
    : (cold ? row?.cold : row?.warm) ?? 60;
  const priced = priceImpl({ verb, seconds: wall, cold });
  return {
    usd: priced.usd,
    seconds: wall,
    cold,
    measured: row?.measured === true,
    basis: `${priced.basis}. ⚠ A FLOOR, not a quote: ${row?.source ?? 'no timing on record'}`
      + (verb === 'talking_head' ? ', and it is priced at the published A10G rate while the render runs on an A100.' : '.'),
  };
}

/**
 * ── ⭐ WHERE THE HANDSHAKE STARTS, AND WHY IT IS A NUMBER NOT A LIST ───────
 *
 * Requiring a two-call approval for every creative call would double the round
 * cost of reading one line of text aloud, and a confirmation people always say
 * yes to is a confirmation nobody reads. Requiring none would let one JSON
 * object start a seven-minute A100 render nobody was shown a price for.
 *
 * ⭐ SO THE GATE IS THE ESTIMATE ITSELF. At today's table that puts
 * `talking_head` and `generate_video` behind the handshake and lets the three
 * sub-cent verbs through — but nothing is hard-coded to those names, so a verb
 * that gets slower, or a card that gets dearer, starts asking on its own.
 *
 * ⚠️ IT IS DERIVED FROM `DEFAULT_BUDGET_USD`, NOT TYPED. Half of a default run's
 * entire budget, in ONE call, is exactly the question worth stopping for — and
 * deriving it means the two numbers can never drift into disagreeing about what
 * "expensive" means.
 *
 * ── ⚠️⚠️ AND IT IS MEASURED ON THE *WARM* FIGURE, WHICH IS NOT THE OBVIOUS ONE ─
 *
 * The first call of a process carries 120 billed seconds of cold start and
 * scaledown tail — the SAME 120 seconds for a 9-second voice clone as for a
 * 400-second render. Judging on the cold figure therefore pushed all five verbs
 * over the line and made the handshake universal, which is the outcome this
 * threshold exists to avoid: a confirmation people always say yes to is a
 * confirmation nobody reads.
 *
 * ⭐ The warm figure is what the CALL costs, as opposed to what the container
 * costs, and "is this request expensive" is a question about the request.
 */
export const APPROVAL_THRESHOLD_USD = DEFAULT_BUDGET_USD / 2;

/**
 * ── ⚠️ THE SAME WORD AS `media-pipeline.mjs`, DECLARED SEPARATELY ON PURPOSE ─
 *
 * `viral` and `podcast` already own a spend handshake and it is called
 * `approve_spend`. Two words for one handshake is how a model learns to guess,
 * so this is deliberately not a new one.
 *
 * ⚠️ AND IT IS NOT IMPORTED, BECAUSE THAT WOULD BE A CYCLE:
 * `media-pipeline → imagegen → creative-engines → avatar`. A copied string with
 * a test that compares the two is the cheap way out; an import here would make
 * the module graph unloadable, which is a worse failure than duplication.
 * `avatar-approval-arg-matches-media-pipeline` is that test.
 */
/* ⚠️ MOVED — see the declaration near the top of this file, and why it had to
 * move. The reasoning above about DUPLICATING rather than importing is unchanged
 * and still correct; only the position changed. */

/**
 * Does this verb need `approve_spend: true` before it may run?
 *
 * At today's table this is `talking_head` and `generate_video` and nothing else
 * — but no name is written down here, so a verb that gets slower starts asking
 * on its own.
 */
export function needsApproval(verb) {
  const warm = estimateJobUsd(verb, { cold: false });
  return warm.usd >= APPROVAL_THRESHOLD_USD;
}
