/**
 * ── ⭐⭐ podcast — A SCREENPLAY IN, A MULTI-VOICE EPISODE OUT ────────────────
 *
 * Roman's backlog: *"podcast — multi-voice audio from a screenplay-shaped
 * markdown."* And his rule for this wave, verbatim: *"generic verbs, none may
 * hardcode for games."* This one knows about exactly three things — a speaker
 * label, a pause, and a gap between lines. It has no idea what the show is about
 * and there is nowhere for it to acquire an opinion.
 *
 * ── ⚠️⚠️ IT GENERATES NO SPEECH OF ITS OWN, AND THAT IS THE DESIGN ──────────
 *
 * `speak` (media.mjs, Kokoro on our GPU) and `designVoice` (avatar-run.mjs,
 * a voice built from a description) already exist, are already metered, and
 * already fail shut without a secret. This file calls them. If you find a TTS
 * client being written in here, something has gone wrong: the expensive half was
 * built months ago and a second copy of it is a second thing to keep in step
 * with a Modal endpoint neither module controls.
 *
 * ── ⭐⭐ AND IT NEEDS NO ffmpeg TO PRODUCE AN EPISODE ────────────────────────
 *
 * Both voice services return uncompressed PCM WAV, so the join is arithmetic on
 * a byte array — `concatWav` in media-pipeline.mjs does it with no dependency
 * and no subprocess. ffmpeg is consulted for exactly one optional thing: turning
 * the finished `episode.wav` into an `.mp3` or `.m4a`. Absent, you still get the
 * episode; you get a sentence naming the install command and the exact argv that
 * would have converted it.
 *
 * ── ⚠️ THE PART THAT IS ACTUALLY HARD IS THE PARSE, AND IT REFUSES RATHER THAN
 *    GUESSING ──────────────────────────────────────────────────────────────
 *
 * A screenplay-shaped markdown file is mostly `NAME: line`, and the failure mode
 * is not "it crashed" — it is that a synopsis paragraph, a heading, or a stage
 * direction gets read aloud in a stranger's voice, or that half the script is
 * silently skipped and the episode is short by three minutes with nothing to
 * say why. So: every line is classified, the ignored ones are COUNTED AND
 * REPORTED with their line numbers, and a file where more lines were ignored
 * than understood is refused outright — that is not a parse, it is a misreading.
 */

import { dirname } from 'node:path';

/**
 * ── 🚪⭐⭐⭐ `speakVia`, NOT `mediaConfig().speak` ───────────────────────────
 *
 * ⚠️⚠️ Same defect, same day, same fix as `viral.mjs` — see the long note at
 * the head of that file's imports. `mediaConfig(env).speak` needs OUR Modal
 * secret, so this verb was offered to nobody outside our own working directory
 * while `speak`, which it is built on, had already been given an account route.
 * The gate was asking a question the runtime had stopped asking.
 */
import { speak, mediaConfig, speakVia } from './media.mjs';
import { designVoice } from './avatar-run.mjs';
import { avatarConfig, whyUnavailable } from './avatar.mjs';
import { slugify } from './syndicate.mjs';
import {
  concatWav, readWorkspaceBinary, writeWorkspaceBinary,
  detectFfmpeg, runFfmpeg, audioEncodeArgv, AUDIO_FORMATS,
  toSrt, estimateSpeechSeconds, estimateSpend, spendGate, SPEND_APPROVAL_ARG,
  ffmpegInstallHint,
} from './media-pipeline.mjs';

export const PODCAST_TOOL_NAMES = Object.freeze(['podcast']);

/** Bounds. Each one is a refusal with a sentence, never a silent truncation. */
export const MAX_CUES = 120;
export const MAX_SPEAKERS = 8;
/**
 * ⚠️ WELL UNDER `speak`'s OWN 5,000-CHARACTER CEILING. A single 5,000-character
 * "line" is not a line, it is a chapter, and it produces six minutes of
 * unbroken audio that nothing downstream can cut. Refusing at 1,200 with the
 * line number is a fix the caller can make; a 5,000-character success is not.
 */
export const MAX_LINE_CHARS = 1_200;

/** Silence inserted between consecutive lines, unless the script asks otherwise. */
export const DEFAULT_GAP_SECONDS = 0.4;
/** What a bare `[pause]` means. */
export const DEFAULT_PAUSE_SECONDS = 1.0;
export const MAX_PAUSE_SECONDS = 15;

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE PARSE — pure, and testable without a syllable of audio
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ A SPEAKER LABEL IS NOT "ANYTHING BEFORE A COLON". `Note: remember to cut
 * this` would become a character called "Note" reading a production note aloud.
 * A label is short, starts with a letter, and is at most four words — which is
 * every real screenplay convention (`HOST`, `GUEST 2`, `Dr. Okafor`) and almost
 * no ordinary sentence.
 */
const SPEAKER_RE = /^([A-Za-z][A-Za-z0-9 ._'’-]{0,39}):\s*(\S.*)$/;

export function looksLikeSpeaker(label) {
  const s = String(label ?? '').trim();
  if (!s || s.length > 40) return false;
  if (!/^[A-Za-z]/.test(s)) return false;
  return s.split(/\s+/).length <= 4;
}

/** `[pause]` · `[pause 2s]` · `[pause 1.5]` — anything else is a stage direction. */
export function readDirection(raw) {
  const inner = String(raw ?? '').trim().replace(/^\[|\]$/g, '').trim();
  const m = /^pause(?:\s+([0-9]*\.?[0-9]+)\s*s?)?$/i.exec(inner);
  if (!m) return { kind: 'note', text: inner };
  const seconds = m[1] === undefined ? DEFAULT_PAUSE_SECONDS : Number(m[1]);
  return {
    kind: 'pause',
    // A pause longer than the ceiling is almost always a typo (`[pause 300]`),
    // and 300 seconds of silence in the middle of an episode is indistinguishable
    // from a broken file.
    seconds: Math.min(Math.max(seconds, 0), MAX_PAUSE_SECONDS),
    clamped: seconds > MAX_PAUSE_SECONDS,
  };
}

/**
 * Turn screenplay-shaped markdown into cues.
 *
 * @param {string} source
 * @returns {{ok: true, title: string|null, cues: Array<{n: number, speaker: string, text: string, gapBefore: number, line: number}>,
 *            speakers: string[], ignored: Array<{line: number, text: string}>, notes: string[]}
 *          | {ok: false, error: string}}
 */
export function parseScreenplay(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  const ignored = [];
  const notes = [];
  let title = null;
  /** Silence owed to the NEXT cue, accumulated from `[pause]` directions. */
  let pending = 0;
  let current = null;

  const close = () => { current = null; };

  for (const [i, raw] of lines.entries()) {
    const lineNo = i + 1;
    const text = raw.trim();

    if (!text) { close(); continue; }
    if (text.startsWith('<!--')) continue;

    if (text.startsWith('#')) {
      const heading = text.replace(/^#+\s*/, '').trim();
      if (!title && heading) title = heading;
      else if (heading) notes.push(`line ${lineNo}: heading "${heading}" is not spoken`);
      close();
      continue;
    }

    if (/^\[.*\]$/.test(text)) {
      const d = readDirection(text);
      if (d.kind === 'pause') {
        pending += d.seconds;
        if (d.clamped) notes.push(`line ${lineNo}: the pause was clamped to ${MAX_PAUSE_SECONDS}s`);
      } else {
        notes.push(`line ${lineNo}: stage direction "${d.text}" is recorded but not spoken`);
      }
      close();
      continue;
    }

    const m = SPEAKER_RE.exec(text);
    if (m && looksLikeSpeaker(m[1])) {
      const speaker = m[1].trim();
      current = {
        n: cues.length + 1,
        speaker,
        text: m[2].trim(),
        /**
         * ⚠️ ONLY THE EXPLICIT `[pause]`, NOT THE ROUTINE GAP BETWEEN LINES.
         * The parse reports what the SCRIPT asked for; the verb adds its own
         * `gap_seconds` on top. Baking the default in here would make the
         * caller's `gap_seconds: 0` unreachable and the arithmetic unreadable.
         */
        pauseBefore: pending,
        line: lineNo,
      };
      pending = 0;
      cues.push(current);
      continue;
    }

    /**
     * ⭐ A CONTINUATION LINE BELONGS TO THE CUE ABOVE IT. Screenplays wrap;
     * treating every wrapped line as unparseable would report a perfectly
     * ordinary script as 60% ignored and refuse it.
     */
    if (current) { current.text = `${current.text} ${text}`.trim(); continue; }

    ignored.push({ line: lineNo, text: text.slice(0, 80) });
  }

  if (!cues.length) {
    return {
      ok: false,
      error: 'no spoken lines were found. This verb reads a SCREENPLAY: one line per '
        + '`SPEAKER: what they say`, blank lines between beats, `# Title` for the episode name and '
        + '`[pause 2s]` where you want silence. Nothing else is read aloud.',
    };
  }
  /**
   * ⚠️⚠️ MORE IGNORED THAN UNDERSTOOD IS A MISREAD FILE, NOT A SPARSE ONE. The
   * expensive failure here is not a crash — it is producing a confident
   * four-minute episode from a twelve-minute script and reporting success.
   */
  if (ignored.length > cues.length) {
    return {
      ok: false,
      error: `${ignored.length} lines could not be read as dialogue and only ${cues.length} could, so this is `
        + `probably not a screenplay — nothing was generated. The first unreadable line is ${ignored[0].line}: `
        + `"${ignored[0].text}". Every spoken line needs a \`SPEAKER: \` prefix.`,
    };
  }
  if (cues.length > MAX_CUES) {
    return { ok: false, error: `${cues.length} spoken lines is past the ${MAX_CUES}-line ceiling for one episode — split the script.` };
  }

  const long = cues.find((c) => c.text.length > MAX_LINE_CHARS);
  if (long) {
    return {
      ok: false,
      error: `line ${long.line} (${long.speaker}) is ${long.text.length} characters, over the ${MAX_LINE_CHARS} `
        + 'ceiling for one spoken line. Break it into several lines by the same speaker — one unbroken block of '
        + 'audio that long cannot be cut or re-recorded in isolation.',
    };
  }

  const speakers = [...new Set(cues.map((c) => c.speaker))];
  if (speakers.length > MAX_SPEAKERS) {
    return { ok: false, error: `${speakers.length} distinct speakers is past the ${MAX_SPEAKERS}-voice ceiling: ${speakers.join(', ')}` };
  }

  for (const c of ignored) notes.push(`line ${c.line}: not dialogue, not spoken — "${c.text}"`);
  return { ok: true, title, cues, speakers, ignored, notes };
}

/**
 * Which producer reads each speaker, and what that means for the listener.
 *
 * ⚠️⚠️ TWO SPEAKERS ON THE SAME FIXED VOICE IS THE DEFECT THIS FUNCTION EXISTS
 * TO SHOUT ABOUT. `speak` is Kokoro — a FIXED reader that clones nothing, which
 * media.mjs's own schema says out loud. Route a host and a guest through it and
 * the "multi-voice podcast" is one person having an argument with themselves,
 * and nothing in the finished file explains why. Naming it before a single GPU
 * second is spent is the difference between a warning and a refund.
 */
export function assignVoices(speakers, voices = {}, env = process.env) {
  const cfg = avatarConfig(env);
  const map = new Map();
  const warnings = [];
  const asked = voices && typeof voices === 'object' ? voices : {};

  for (const s of speakers) {
    const description = typeof asked[s] === 'string' ? asked[s].trim() : '';
    if (description && cfg.voiceDesign) map.set(s, { via: 'design_voice', description });
    else if (description) {
      map.set(s, { via: 'speak', description, downgraded: true });
      warnings.push(`"${s}" asked for a designed voice and this install cannot reach one: ${whyUnavailable('design_voice', env)}`);
    } else map.set(s, { via: 'speak' });
  }

  const onFixed = [...map.entries()].filter(([, v]) => v.via === 'speak').map(([s]) => s);
  if (onFixed.length > 1) {
    warnings.push(
      `${onFixed.join(', ')} will all be read by the SAME fixed voice, so they will be indistinguishable. `
      + 'Give each one a `voices` description (e.g. {"HOST":"warm Australian woman, unhurried"}) — that routes '
      + 'them through design_voice instead.',
    );
  }
  return { map, warnings };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE VERB
 * ──────────────────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(3, '0');

/**
 * @param {object} executor  workspace executor (root · readFile · writeFile · dryRun)
 * @param {Record<string, any>} args
 * @param {object} [deps]  every producer is injectable, because the suite must
 *   prove the plan, the writes and the argv WITHOUT generating a syllable.
 */
export async function podcast(executor, args = {}, {
  env = process.env, budget = null, allowRun = true,
  speakImpl = speak, designImpl = designVoice,
  detectImpl = detectFfmpeg, runImpl = runFfmpeg, spawnImpl,
  // ⚠️ The gate and the call must read the SAME account — see `viral`.
  home = undefined,
} = {}) {
  if (!executor || typeof executor.writeFile !== 'function' || typeof executor.readFile !== 'function' || !executor.root) {
    return { ok: false, error: 'no workspace is available, so there is nowhere to write the episode' };
  }

  const cfg = mediaConfig(env);
  // ⚠️ The old message named OUR Modal secret, which a paying customer cannot
  // obtain — see `viral`'s note. The route they have is their account.
  if (!speakVia(cfg, env, home)) {
    return {
      ok: false,
      error: 'no speech service is available, so nothing can be read aloud — sign in with `acuvo --login` so this '
        + 'runs on your plan, or set MODAL_TTS_URL to point at your own speech worker.',
    };
  }

  /* ── the script ────────────────────────────────────────────────────────── */
  let source = typeof args.script === 'string' ? args.script : '';
  let scriptPath = null;
  if (!source) {
    scriptPath = String(args.script_path ?? '').trim();
    if (!scriptPath) {
      return { ok: false, error: 'pass the screenplay as `script` (inline markdown) or `script_path` (a file in the workspace)' };
    }
    const read = executor.readFile(scriptPath);
    if (!read.ok) return { ok: false, error: `could not read ${scriptPath}: ${read.error}` };
    source = read.content ?? read.text ?? '';
  }

  const parsed = parseScreenplay(source);
  if (!parsed.ok) return parsed;

  const { map: voiceMap, warnings } = assignVoices(parsed.speakers, args.voices, env);

  /* ── where it lands ────────────────────────────────────────────────────── */
  const title = String(args.title ?? parsed.title ?? 'episode').trim() || 'episode';
  const slug = args.slug ? slugify(args.slug) : slugify(title);
  const parent = String(args.out_dir ?? 'audio').trim().replace(/[\\/]+$/, '');
  const dir = `${parent}/${slug}`;

  const format = String(args.format ?? 'wav').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(AUDIO_FORMATS, format)) {
    return { ok: false, error: `format must be one of ${Object.keys(AUDIO_FORMATS).join(', ')} — got "${args.format}"` };
  }

  const gap = Number.isFinite(Number(args.gap_seconds)) && Number(args.gap_seconds) >= 0
    ? Number(args.gap_seconds) : DEFAULT_GAP_SECONDS;

  /* ── the plan, and what it will cost ───────────────────────────────────── */
  const plan = parsed.cues.map((c) => ({
    n: c.n,
    speaker: c.speaker,
    via: voiceMap.get(c.speaker).via,
    chars: c.text.length,
    estimatedSeconds: Number(estimateSpeechSeconds(c.text).toFixed(2)),
    // ⚠️ The first line gets none: `concatWav` inserts silence only BETWEEN
    // segments, so a leading gap would be a number in the plan that the audio
    // does not contain — a report that disagrees with the artefact.
    gapBefore: c.n === 1 ? 0 : Number((gap + c.pauseBefore).toFixed(2)),
    path: `${dir}/lines/${pad(c.n)}-${slugify(c.speaker, 24)}.wav`,
  }));

  const estimate = estimateSpend({ speakSeconds: plan.map((p) => p.estimatedSeconds), env });
  const estimatedSeconds = plan.reduce((n, p) => n + p.estimatedSeconds + p.gapBefore, 0);

  const ffmpeg = format === 'wav' ? null : detectImpl({ env, spawnImpl });
  const episodeRel = `${dir}/episode.${AUDIO_FORMATS[format].ext}`;
  const encodeArgv = format === 'wav' ? null : audioEncodeArgv({
    input: 'episode.wav', out: `episode.${AUDIO_FORMATS[format].ext}`, codec: AUDIO_FORMATS[format].codec,
  });

  const preamble = {
    title,
    dir,
    lines: plan.length,
    speakers: [...voiceMap.entries()].map(([speaker, v]) => ({ speaker, via: v.via })),
    estimatedSeconds: Number(estimatedSeconds.toFixed(1)),
    estimatedUsd: Number(estimate.usd.toFixed(4)),
    costBasis: [...estimate.lines, estimate.basis],
    warnings,
    notes: parsed.notes,
    plan,
    ...(encodeArgv ? { ffmpeg: { needed: 'only to convert episode.wav to .' + format, argv: encodeArgv, available: ffmpeg?.ok === true } } : {}),
  };

  const gate = spendGate({
    approved: args[SPEND_APPROVAL_ARG] === true,
    dryRun: executor.dryRun === true,
    estimateUsd: estimate.usd,
    budget,
    verb: 'podcast',
  });
  if (!gate.go) {
    return { ok: true, spent: false, dryRun: executor.dryRun === true, ...preamble, next: gate.why, ...(gate.overBudget ? { overBudget: true } : {}) };
  }

  /* ── produce ───────────────────────────────────────────────────────────── */
  const segments = [];
  for (const [i, cue] of parsed.cues.entries()) {
    const step = plan[i];
    const voice = voiceMap.get(cue.speaker);
    const made = voice.via === 'design_voice'
      ? await designImpl(executor.root, { description: voice.description, text: cue.text, path: step.path }, { env })
      : await speakImpl(executor.root, cue.text, step.path, { env, home });
    if (!made.ok) {
      return {
        ok: false,
        error: `line ${cue.line} (${cue.speaker}): ${made.error}`,
        spent: i > 0,
        produced: segments.map((s) => s.path),
        ...preamble,
      };
    }
    const back = readWorkspaceBinary(executor.root, made.path);
    if (!back.ok) return { ok: false, error: `line ${cue.line}: ${back.error}`, spent: true, ...preamble };
    segments.push({ path: made.path, buf: back.buf, label: `line ${cue.line} (${cue.speaker})`, gapSeconds: step.gapBefore, speaker: cue.speaker, text: cue.text });
  }

  /* ── join ──────────────────────────────────────────────────────────────── */
  const joined = concatWav(segments);
  if (!joined.ok) {
    return {
      ok: false,
      error: `the lines were generated but could not be joined: ${joined.error}`,
      spent: true,
      produced: segments.map((s) => s.path),
      ...preamble,
    };
  }

  const wav = writeWorkspaceBinary(executor.root, `${dir}/episode.wav`, joined.buffer, false);
  if (!wav.ok) return { ok: false, error: wav.error, spent: true, produced: segments.map((s) => s.path), ...preamble };

  /**
   * ⭐ A TRANSCRIPT WITH REAL TIMINGS, FOR FREE. The join already measured every
   * segment from its own WAV header, so the timeline is exact rather than
   * estimated — and a podcast without chapter timings is one nobody can quote.
   */
  const srt = toSrt(joined.timeline.map((t, i) => ({
    start: t.start, end: t.end, text: `${segments[i].speaker}: ${segments[i].text}`,
  })));
  const transcript = executor.writeFile(`${dir}/transcript.srt`, srt);

  /* ── the optional conversion ───────────────────────────────────────────── */
  let converted = null;
  let conversionNote = null;
  if (format !== 'wav') {
    if (!allowRun) {
      conversionNote = `--no-run is in force, so episode.wav was NOT converted to .${format}. `
        + `Run this yourself in ${dir}:  ffmpeg ${encodeArgv.join(' ')}`;
    } else if (!ffmpeg.ok) {
      conversionNote = `${ffmpeg.reason} episode.wav is finished and playable; to get a .${format}, run this in ${dir}:  `
        + `ffmpeg ${encodeArgv.join(' ')}`;
    } else {
      /**
       * ⚠️ RUN FROM INSIDE THE EPISODE FOLDER, so every path in the argv is a
       * bare filename. See `runFfmpeg`'s note: it is what makes the argv
       * platform-independent instead of a Windows quoting problem waiting to
       * happen.
       */
      const ran = runImpl({ bin: ffmpeg.bin, argv: encodeArgv, cwd: dirname(wav.absolute), spawnImpl });
      if (ran.ok) converted = episodeRel;
      else conversionNote = `episode.wav is finished, but the conversion to .${format} failed: ${ran.error}`;
    }
  }

  const manifest = [
    `# ${title}`, '',
    `- ${plan.length} spoken lines · ${parsed.speakers.length} speaker${parsed.speakers.length === 1 ? '' : 's'}`,
    `- ${joined.seconds.toFixed(1)}s (${(joined.seconds / 60).toFixed(1)} min), ${joined.sampleRate}Hz ${joined.channels}ch ${joined.bitsPerSample}-bit`,
    `- \`episode.wav\` — the finished episode${converted ? `\n- \`episode.${format}\` — the same episode, converted` : ''}`,
    '- `transcript.srt` — every line with its real start and end, measured from the audio',
    '- `lines/` — one file per spoken line, so any single line can be re-recorded without redoing the episode',
    '',
    ...(warnings.length ? ['## Warnings', '', ...warnings.map((w) => `- ${w}`), ''] : []),
    ...(parsed.notes.length ? ['## Not spoken', '', ...parsed.notes.map((n) => `- ${n}`), ''] : []),
    ...(conversionNote ? ['## ffmpeg', '', conversionNote, `Install it with:  ${ffmpegInstallHint()}`, ''] : []),
  ].join('\n');
  executor.writeFile(`${dir}/README.md`, manifest);

  return {
    ok: true,
    spent: true,
    ...preamble,
    episode: wav.path,
    ...(converted ? { converted } : {}),
    transcript: transcript.ok ? transcript.path : null,
    seconds: Number(joined.seconds.toFixed(2)),
    sampleRate: joined.sampleRate,
    files: [wav.path, ...(converted ? [converted] : []), `${dir}/transcript.srt`, `${dir}/README.md`, ...segments.map((s) => s.path)],
    ...(conversionNote ? { conversionNote } : {}),
    next: 'listen to episode.wav before publishing — synthetic speech mispronounces names and acronyms, and the '
      + 'per-line files in lines/ mean one bad line can be fixed without regenerating the episode',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. REGISTRATION
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ OFFERED ONLY WHERE THERE IS A SPEECH SERVICE, and never on a single-shot
 * turn. Both halves matter: a verb advertised on a machine with no TTS teaches
 * the model to promise an episode the product then refuses, and a verb this
 * expensive on a one-round turn would buy the audio with no round left to check
 * it — paying for the expensive half of a loop and skipping the half that makes
 * it correct.
 */
export function podcastToolNames(env = process.env, { maxRounds = 2, home = undefined } = {}) {
  if (maxRounds <= 1) return [];
  // ⚠️ `home` threaded, never defaulted here — see `viralToolNames`.
  return speakVia(mediaConfig(env), env, home) ? [...PODCAST_TOOL_NAMES] : [];
}

export function podcastToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'podcast',
        /**
         * ⚠️ EVERY BYTE HERE IS PAID FOR ON EVERY ROUND OF EVERY TASK THAT
         * SELECTS THE `media` GROUP. It says what the caller cannot guess — the
         * script format, the two-call spend handshake, and that voices need
         * describing — and nothing else. The reasoning is in this file's header,
         * which costs nothing.
         */
        description: [
          'Turn a SCREENPLAY into a finished multi-voice audio episode: one file per line, joined with',
          'real gaps, plus a timed transcript. Script format: `# Title`, then `SPEAKER: what they say`',
          'per line, `[pause 2s]` for silence. Anything else is not read aloud.',
          '⚠️ SPENDS on our GPUs: it prices the run and generates NOTHING on the first call —',
          `read the estimate back to the user, then call again with ${SPEND_APPROVAL_ARG}: true.`,
          'Give every speaker a `voices` description or they all share ONE fixed voice and sound identical.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            script: { type: 'string', description: 'The screenplay inline. Use this or script_path.' },
            script_path: { type: 'string', description: 'Workspace-relative path to the screenplay markdown.' },
            title: { type: 'string', description: 'Episode name. Defaults to the script\'s first heading.' },
            out_dir: { type: 'string', description: 'Parent folder. Default "audio"; the episode gets its own slug folder inside it.' },
            voices: {
              type: 'object',
              description: 'Speaker label → what that voice sounds like, e.g. {"HOST":"warm Australian woman, mid 30s, unhurried"}. Any speaker left out shares the one fixed voice.',
              additionalProperties: { type: 'string' },
            },
            format: { type: 'string', enum: Object.keys(AUDIO_FORMATS), description: 'Default wav, which needs no ffmpeg. mp3/m4a convert with ffmpeg if it is installed.' },
            gap_seconds: { type: 'number', description: 'Silence between lines. Default 0.4.' },
            [SPEND_APPROVAL_ARG]: { type: 'boolean', description: 'Set true ONLY after the user has seen the estimate from a first call.' },
          },
        },
      },
    },
  ];
}

/** Dispatch. Mirrors the shape every other tool module in this package uses. */
export async function runPodcastTool(name, args = {}, deps = {}) {
  if (name !== 'podcast') return { ok: false, error: `unknown podcast tool "${name}"` };
  const { executor, ...rest } = deps;
  return podcast(executor, args, rest);
}
