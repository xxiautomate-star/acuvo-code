/**
 * ── ⭐⭐ THE PLUMBING TWO ORCHESTRATORS SHARE — AND NOTHING IT INVENTS ────────
 *
 * `viral` and `podcast` are ORCHESTRATORS. Every expensive thing they do is done
 * by a capability this package already owns: `speak` (media.mjs), `designVoice`
 * (avatar-run.mjs) and `generateImage` (imagegen.mjs). This file holds only the
 * parts BOTH of them need and neither of them should own twice — the WAV
 * arithmetic, the ffmpeg argv, the price estimate and the spend gate.
 *
 * ⚠️⚠️ IF YOU FIND YOURSELF WRITING A TTS CLIENT IN HERE, STOP. That module
 * exists, it is metered, it fails shut without a secret, and a second copy of it
 * would be a second thing to keep in step with a Modal endpoint neither of them
 * controls. The whole reason these two verbs are cheap to build is that the
 * expensive halves were built and paid for months ago.
 *
 * ── ⚠️⚠️ ffmpeg IS A DETECTED BINARY, NEVER A DEPENDENCY ────────────────────
 *
 * `acuvo-code` has zero runtime dependencies and that property is worth more
 * than any feature in this file. So ffmpeg is:
 *
 *   · **detected by RUNNING it** (`ffmpeg -version`), not by looking for a file
 *     on PATH. A name on PATH that will not execute — a broken symlink, a
 *     Windows `.cmd` shim pointing at a deleted install, a 32-bit binary on an
 *     ARM box — is exactly the case a `which` answers wrong.
 *   · **never bundled and never installed.** When it is absent the verb says so
 *     in one sentence, NAMES the install command for the platform, and hands
 *     back the exact argv it would have run.
 *   · **not needed for most of what these verbs do.** This is the point of the
 *     pure-Node WAV concatenation below: a podcast episode assembles with no
 *     external binary at all, and `viral` still produces every image, the full
 *     narration track and the caption file. Only the final mux needs ffmpeg.
 *
 * ⭐ A DEGRADE THAT STILL SHIPS AN ARTEFACT IS THE DIFFERENCE BETWEEN "optional"
 * AND "optional in the release notes". Returning `{ok:false, "install ffmpeg"}`
 * after spending real GPU money on the narration would be the worst of both.
 *
 * ── ⚠️ AND THE MONEY RULE THESE TWO VERBS EXIST UNDER ───────────────────────
 *
 * Both orchestrate PAID capabilities, several calls at a time. Every other
 * expensive verb here spends ONE unit per call and the user sees it happen; a
 * verb that fans out to fourteen TTS calls from one line of JSON is a new shape
 * of risk for this package. So `estimateSpend` prices the whole run BEFORE the
 * first request, and `spendGate` refuses to start until the caller has seen that
 * number. See its own note — the two-call handshake is deliberate.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveInWorkspace } from './workspace.mjs';
import { priceGpuCall } from './budget.mjs';
import { engineConfig } from './imagegen.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. WAV — read it, measure it, join it. No dependency, no subprocess.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ PCM ONLY, AND IT SAYS SO. A WAV container can hold μ-law, ADPCM or a whole
 * MP3 stream, and concatenating those payloads byte-wise produces a file that
 * opens and plays garbage — the worst failure available, because it looks like
 * success until somebody listens. Our own TTS returns 16-bit PCM (measured: the
 * Modal endpoint answers `contentType: audio/wav, sampleRate: 24000`), so the
 * supported case is the case we produce, and anything else is refused by name.
 */
export const WAV_PCM_FORMAT = 1;

/** Enough for `RIFF____WAVE` plus the smallest useful chunk header. */
const MIN_WAV_BYTES = 44;

/**
 * Read a WAV's format and its audio payload.
 *
 * ⚠️ IT WALKS THE CHUNKS RATHER THAN ASSUMING A 44-BYTE HEADER. The canonical
 * layout is `RIFF · fmt · data`, and plenty of real encoders put `LIST`, `fact`
 * or `bext` in between — including several that ship in ffmpeg's own output.
 * Slicing at 44 works on the file you tested with and truncates the next one.
 *
 * @param {Buffer} buf
 * @returns {{ok: true, sampleRate: number, channels: number, bitsPerSample: number,
 *            dataOffset: number, dataBytes: number, seconds: number}
 *          | {ok: false, error: string}}
 */
export function readWavInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_WAV_BYTES) {
    return { ok: false, error: `not a WAV: only ${Buffer.isBuffer(buf) ? buf.length : 0} bytes` };
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: 'not a WAV: the file does not start with a RIFF/WAVE header' };
  }

  let fmt = null;
  let data = null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // ⚠️ CLAMPED TO WHAT IS ACTUALLY THERE. A truncated download carries a
      // header promising more than the file holds, and trusting it hands the
      // next stage a slice full of zeros it will happily encode.
      data = { offset: body, bytes: Math.min(size, Math.max(0, buf.length - body)) };
      break;
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    at = body + size + (size % 2);
  }

  if (!fmt) return { ok: false, error: 'this WAV has no fmt chunk, so its sample rate is unknowable' };
  if (!data) return { ok: false, error: 'this WAV has no data chunk — there is no audio in it' };
  if (fmt.audioFormat !== WAV_PCM_FORMAT) {
    return {
      ok: false,
      error: `this WAV is not uncompressed PCM (format ${fmt.audioFormat}). `
        + 'Joining compressed payloads byte-wise produces a file that plays noise, so it is refused. '
        + 'Convert it to PCM first, or install ffmpeg and let it do the join.',
    };
  }
  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  return {
    ok: true,
    ...fmt,
    dataOffset: data.offset,
    dataBytes: data.bytes,
    seconds: bytesPerSecond > 0 ? data.bytes / bytesPerSecond : 0,
  };
}

/**
 * A canonical 44-byte PCM WAV header for a payload of a known size.
 *
 * @param {{sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number}} spec
 */
export function buildWavHeader({ sampleRate, channels, bitsPerSample, dataBytes }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + dataBytes, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(WAV_PCM_FORMAT, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * blockAlign, 28);
  head.writeUInt16LE(blockAlign, 32);
  head.writeUInt16LE(bitsPerSample, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(dataBytes, 40);
  return head;
}

/** Silence, in the format of the track it is being inserted into. */
export function silenceOf(seconds, { sampleRate, channels, bitsPerSample }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  return Buffer.alloc(frames * blockAlign);
}

/**
 * Join PCM WAVs into one.
 *
 * ⚠️⚠️ IT REFUSES A FORMAT MISMATCH RATHER THAN RESAMPLING. Concatenating a
 * 24 kHz clip onto a 48 kHz one produces a file whose second half plays at half
 * speed — audible, obviously wrong, and impossible to attribute to this function
 * from the outside. Resampling correctly is a signal-processing job, which is
 * ffmpeg's, not ours. So: same format ⇒ join here for free; different formats ⇒
 * say which segment differs and how, and let the caller reach for ffmpeg.
 *
 * @param {Array<{buf: Buffer, label?: string, gapSeconds?: number}>} parts
 */
export function concatWav(parts) {
  const list = Array.isArray(parts) ? parts.filter(Boolean) : [];
  if (!list.length) return { ok: false, error: 'nothing to join — no audio segments were produced' };

  let spec = null;
  const payloads = [];
  const timeline = [];
  let at = 0;

  for (const [i, part] of list.entries()) {
    const label = part.label ?? `segment ${i + 1}`;
    const info = readWavInfo(part.buf);
    if (!info.ok) return { ok: false, error: `${label}: ${info.error}` };

    if (!spec) {
      spec = { sampleRate: info.sampleRate, channels: info.channels, bitsPerSample: info.bitsPerSample };
    } else if (info.sampleRate !== spec.sampleRate || info.channels !== spec.channels || info.bitsPerSample !== spec.bitsPerSample) {
      return {
        ok: false,
        error: `${label} is ${info.sampleRate}Hz/${info.channels}ch/${info.bitsPerSample}-bit but the episode is `
          + `${spec.sampleRate}Hz/${spec.channels}ch/${spec.bitsPerSample}-bit. Joining them here would play the `
          + 'mismatched part at the wrong speed, so it is refused. Install ffmpeg and it will resample.',
      };
    }

    const gap = Number(part.gapSeconds) > 0 ? Number(part.gapSeconds) : 0;
    if (gap > 0 && payloads.length) {
      const pad = silenceOf(gap, spec);
      payloads.push(pad);
      at += gap;
    }
    payloads.push(part.buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes));
    timeline.push({ label, start: at, end: at + info.seconds, seconds: info.seconds });
    at += info.seconds;
  }

  const body = Buffer.concat(payloads);
  return {
    ok: true,
    buffer: Buffer.concat([buildWavHeader({ ...spec, dataBytes: body.length }), body]),
    seconds: at,
    timeline,
    ...spec,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE WORKSPACE, FOR BYTES
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE EXECUTOR'S `writeFile` IS FOR TEXT. Audio and images are bytes, so they
 * go through `resolveInWorkspace` and raw `fs` — the same route `media.mjs`
 * takes for a WAV and for a screenshot, and for the same reason. The path safety
 * is identical; only the encoding differs.
 *
 * ⚠️ AND `dryRun` IS HONOURED HERE, not at the call site. Six verbs already got
 * this wrong once by gating the write and sending the request anyway.
 */
export function writeWorkspaceBinary(root, rawPath, buf, dryRun = false) {
  const target = resolveInWorkspace(root, rawPath, 'write');
  if (!target.ok) return { ok: false, error: target.reason };
  if (!dryRun) {
    mkdirSync(dirname(target.absolute), { recursive: true });
    writeFileSync(target.absolute, buf);
  }
  return { ok: true, path: target.relative, absolute: target.absolute, bytes: buf.length, dryRun };
}

/** Read bytes back out of the workspace, through the same rules. */
export function readWorkspaceBinary(root, rawPath) {
  const target = resolveInWorkspace(root, rawPath, 'read');
  if (!target.ok) return { ok: false, error: target.reason };
  try {
    return { ok: true, path: target.relative, absolute: target.absolute, buf: readFileSync(target.absolute) };
  } catch (err) {
    return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. ffmpeg — DETECTED, NEVER DEPENDED ON
 * ──────────────────────────────────────────────────────────────────────────── */

/** Point at a binary that is not on PATH. Read at call time, never captured. */
export const FFMPEG_BIN_ENV = 'ACUVO_FFMPEG';

/**
 * ⚠️ NAMED PER PLATFORM. "install ffmpeg" is advice nobody can paste. This is
 * the sentence a user can act on without leaving the terminal, and getting it
 * wrong for their OS is the same as not saying it.
 */
export function ffmpegInstallHint(platform = process.platform) {
  if (platform === 'win32') return 'winget install Gyan.FFmpeg   (or: choco install ffmpeg)';
  if (platform === 'darwin') return 'brew install ffmpeg';
  return 'sudo apt install ffmpeg   (or your distribution\'s package manager)';
}

/**
 * Is there a working ffmpeg here?
 *
 * ⚠️ IT RUNS THE BINARY. `existsSync` on a PATH entry answers "is there a file
 * with that name", which is a different question from "will this execute" —
 * and the difference is a broken shim, a wrong architecture, or a `.cmd` that
 * points at an uninstalled build. One 30ms `-version` call answers the question
 * that matters, and it also gives us the build string to report.
 *
 * @param {{env?: Record<string,string>, spawnImpl?: Function, platform?: string}} [opts]
 */
export function detectFfmpeg({ env = process.env, spawnImpl = spawnSync, platform = process.platform } = {}) {
  const bin = (env[FFMPEG_BIN_ENV] || '').trim() || 'ffmpeg';
  let res;
  try {
    res = spawnImpl(bin, ['-version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  } catch (err) {
    res = { error: err };
  }
  if (!res || res.error || res.status !== 0) {
    /**
     * ⚠️ THREE DIFFERENT FAILURES, THREE DIFFERENT SENTENCES. "not installed",
     * "installed but will not execute" and "ran and refused" send a user to
     * three different fixes, and collapsing them into "ffmpeg not available" is
     * how somebody spends an hour reinstalling software that was already there.
     */
    const code = res?.error?.code ?? null;
    const why = code === 'ENOENT' || !res
      ? `\`${bin}\` is not on this machine's PATH`
      : code
        ? `\`${bin}\` could not be run (${code})`
        : `\`${bin} -version\` exited ${res.status}, so this build is not usable`;
    return {
      ok: false,
      bin,
      reason: `${why}. ffmpeg is OPTIONAL here and is never bundled — install it with:  ${ffmpegInstallHint(platform)}`
        + `${bin === 'ffmpeg' ? `, or set ${FFMPEG_BIN_ENV} to the full path of an existing build.` : '.'}`,
    };
  }
  const first = String(res.stdout ?? '').split('\n')[0].trim();
  return { ok: true, bin, version: first || 'ffmpeg (version line not reported)' };
}

/**
 * Run ffmpeg with an explicit argv array.
 *
 * ⚠️ NO SHELL, EVER. Every value here — a filter graph, a caption filename, a
 * scene duration — is one argv slot, so nothing in it can be re-parsed as a
 * second command. This is the same argument `run_program` makes against
 * `run_command`, and it matters more here because the filter string is full of
 * characters a shell treats as syntax.
 *
 * ⭐ `cwd` IS THE OUTPUT DIRECTORY AND THAT IS LOAD-BEARING. ffmpeg's
 * `subtitles=` filter parses its argument as a filter option, where a Windows
 * `C:\…` is a colon-separated option list and a backslash is an escape. Running
 * from inside the folder means every path in the argv is a bare filename, and
 * that whole class of quoting bug cannot occur.
 */
export function runFfmpeg({ bin, argv, cwd, spawnImpl = spawnSync, timeoutMs = 10 * 60 * 1000 }) {
  let res;
  try {
    res = spawnImpl(bin, argv, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    return { ok: false, error: `could not start ${bin}: ${err?.message ?? err}` };
  }
  if (res?.error) return { ok: false, error: `${bin} failed to run: ${res.error.code ?? res.error.message}` };
  if (res?.status !== 0) {
    /**
     * ⚠️ ffmpeg PUTS EVERYTHING ON stderr, INCLUDING SUCCESS. So the tail of
     * stderr is the diagnosis and the status is the verdict — reporting only
     * "exit 1" throws away the one line that says which filter was rejected.
     */
    const tail = String(res?.stderr ?? '').trim().split('\n').slice(-6).join('\n');
    return { ok: false, error: `ffmpeg exited ${res?.status}:\n${tail.slice(0, 800)}` };
  }
  return { ok: true, stderr: String(res?.stderr ?? '') };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE ARGV — the real contract, so it is a pure function
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ EVEN DIMENSIONS, ALWAYS. H.264 with `yuv420p` chroma subsampling cannot
 * encode an odd width or height; ffmpeg fails with "width not divisible by 2"
 * after every other stage has already run.
 */
export const ASPECTS = Object.freeze({
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
});

export const DEFAULT_ASPECT = '9:16';
export const DEFAULT_FPS = 30;

/** How captions are delivered. Both produce a `.srt`; only one burns it in. */
export const CAPTION_MODES = Object.freeze(['soft', 'burn', 'none']);

/**
 * ⭐ `soft` IS THE DEFAULT AND THE REASON IS PORTABILITY, NOT TASTE. Burning
 * captions in uses the `subtitles=` filter, which needs ffmpeg built with
 * **libass** — widely present, and absent often enough that defaulting to it
 * would turn "captioned mp4" into a build-dependent coin flip. A `mov_text`
 * track needs no such build option, is a real caption track every player and
 * every platform reads, and the `.srt` sits beside the file either way.
 *
 * ⚠️ AND SOCIAL PLATFORMS MOSTLY DO NOT RENDER SOFT SUBTITLES ON AUTOPLAY, so a
 * caller shipping to TikTok or Reels genuinely wants `burn`. That is a decision
 * with a trade, which is why it is an argument and not a guess.
 */
export const DEFAULT_CAPTION_MODE = 'soft';

/**
 * Build the ONE ffmpeg invocation that turns stills plus a narration track into
 * a captioned mp4.
 *
 * ── ⚠️⚠️ WHY THIS IS `filter_complex` AND NOT THE CONCAT DEMUXER ────────────
 *
 * The obvious build is a `frames.txt` concat list, and it is wrong here for a
 * reason specific to this package: **`generate_image` returns a `.png` OR a
 * `.jpg` depending on which engine answered** (imagegen.mjs says so in its own
 * schema, and `pipe_to_asset` exists entirely because of it). The concat
 * demuxer requires every input to share a codec and a resolution, so a run where
 * the free fallback served scene 3 as JPEG fails at the mux — after every GPU
 * second has already been spent. `-loop 1 -t <seconds> -i <file>` per scene
 * decodes each one independently, and the per-scene `scale`/`pad` makes mixed
 * resolutions a non-event too.
 *
 * ⚠️ `setsar=1` IS NOT DECORATION. A still with a non-square pixel aspect ratio
 * makes `concat` refuse the join outright ("Input link parameters do not match"),
 * and generated JPEGs carry odd SAR metadata more often than anyone expects.
 *
 * @param {object} spec
 * @param {Array<{file: string, seconds: number}>} spec.scenes  basenames, in order
 * @param {string} spec.audio        basename of the narration track
 * @param {string|null} spec.captions basename of the .srt, or null
 * @param {string} spec.out          basename of the mp4
 * @returns {string[]} argv, to be run with `cwd` set to the folder holding them
 */
export function slideshowArgv({
  scenes, audio, captions = null, out,
  width = ASPECTS[DEFAULT_ASPECT].width, height = ASPECTS[DEFAULT_ASPECT].height,
  fps = DEFAULT_FPS, captionMode = DEFAULT_CAPTION_MODE, crf = 20, preset = 'medium',
}) {
  const argv = ['-y'];
  for (const s of scenes) {
    // ⚠️ THE DURATION IS ON THE INPUT, NOT THE OUTPUT. `-t` after `-i` trims the
    // OUTPUT to that length; before `-i` it bounds how much of that (infinite,
    // because of `-loop 1`) input is read. Swapping them yields a one-scene video.
    argv.push('-loop', '1', '-t', formatSeconds(s.seconds), '-i', s.file);
  }
  const audioIndex = scenes.length;
  argv.push('-i', audio);

  const soft = captions && captionMode === 'soft';
  if (soft) argv.push('-i', captions);

  const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease`
    + `,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`;
  const legs = scenes.map((_, i) => `[${i}:v]${scale}[v${i}]`).join(';');
  const joined = scenes.map((_, i) => `[v${i}]`).join('');
  let graph = `${legs};${joined}concat=n=${scenes.length}:v=1:a=0[vc]`;
  if (captions && captionMode === 'burn') {
    // ⚠️ AFTER the scale/pad, so the type is sized against the FINAL canvas.
    // Burned before it, the captions are scaled with the picture and come out
    // the wrong size on every aspect but the source's own.
    graph += `;[vc]subtitles=${captions}[v]`;
  } else {
    graph += ';[vc]null[v]';
  }

  argv.push('-filter_complex', graph, '-map', '[v]', '-map', `${audioIndex}:a:0`);
  if (soft) argv.push('-map', `${audioIndex + 1}:s:0`, '-c:s', 'mov_text');

  argv.push(
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    // ⚠️ The video is built to the audio's length by construction, but a
    // rounding difference of one frame leaves a black tail or a clipped word.
    '-shortest',
    // Puts the index at the front so the file streams before it has downloaded.
    '-movflags', '+faststart',
    out,
  );
  return argv;
}

/** Re-encode one audio file into a distribution format. */
export const AUDIO_FORMATS = Object.freeze({
  wav: { ext: 'wav', codec: null },
  mp3: { ext: 'mp3', codec: 'libmp3lame' },
  m4a: { ext: 'm4a', codec: 'aac' },
});

export function audioEncodeArgv({ input, out, codec, bitrate = '128k' }) {
  return ['-y', '-i', input, '-c:a', codec, '-b:a', bitrate, out];
}

/**
 * ⚠️⚠️ A HARD CEILING, BECAUSE `toFixed` IS EXPONENTIAL AT BOTH ENDS. This is
 * not a hypothetical: the first version of this function clamped only the low
 * side, and its own test caught `formatSeconds(1e21) === '1e+21'` — `toFixed`
 * gives up on fixed notation at 1e21 and returns exponential regardless of the
 * digits asked for. A day is longer than any legitimate scene by four orders of
 * magnitude, so anything past it is a corrupt number, not a long shot.
 */
export const MAX_SEGMENT_SECONDS = 86_400;

/**
 * ⚠️ THREE DECIMALS, AND NEVER EXPONENTIAL NOTATION. `String(0.0000001)` is
 * `"1e-7"`, which ffmpeg parses as a duration of one second (it stops reading at
 * the `e`). Fixed notation is the only spelling that survives, and it has to
 * survive at BOTH ends of the range — see the ceiling above.
 */
export function formatSeconds(n) {
  const raw = Number(n);
  const v = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_SEGMENT_SECONDS) : 0;
  return v.toFixed(3);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. CAPTIONS
 * ──────────────────────────────────────────────────────────────────────────── */

/** `HH:MM:SS,mmm` — SRT's own spelling, with a comma and not a period. */
export function srtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const whole = Math.floor(total);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)},${pad(ms, 3)}`;
}

/**
 * @param {Array<{start: number, end: number, text: string}>} cues
 */
export function toSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${String(c.text ?? '').trim()}\n`)
    .join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. WHAT IT WILL COST, BEFORE IT COSTS IT
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ AN ASSUMPTION, LABELLED. 150 words a minute at ~5.5 characters a word is
 * ~13.75 characters a second, and this is used for two different things: the
 * estimated GPU seconds of a `speak` call, and — only until the real WAV exists
 * — a caption's duration. Every real duration in the output is MEASURED from the
 * WAV header; this number never survives into a finished artefact.
 */
export const SPEECH_CHARS_PER_SECOND = 13.75;

export function estimateSpeechSeconds(text) {
  const chars = String(text ?? '').trim().length;
  // A floor, because a two-word line still pays a container's minimum attention.
  return Math.max(1, chars / SPEECH_CHARS_PER_SECOND);
}

/**
 * ⚠️ MEASURED, AND IT IS THE MOST OPTIMISTIC HALF OF THE ESTIMATE. imagegen.mjs
 * records 8.8–10.5s warm for our own engine. The free fallback costs us nothing
 * at all, which is why `imagesAreCharged` is a separate question below.
 */
export const IMAGE_SECONDS = 10;

/**
 * What this run will cost, before any of it happens.
 *
 * ⭐ IT USES `priceGpuCall`, THE SAME PURE FUNCTION THE LEDGER USES. An estimate
 * computed from a second, private price table is an estimate that stops matching
 * the bill — and this package has already paid for one of those. It also mirrors
 * `chargeGpu`'s cold/warm rule exactly: the first call to an endpoint carries the
 * cold start and the scaledown tail, the rest do not.
 *
 * ⚠️ IMAGES ARE PRICED AT ZERO WHEN THE FREE CHAIN WILL SERVE THEM, and that is
 * not optimism — it is what `generateThroughProviders` does. Our own GPU engine
 * runs FIRST but only when `ACUVO_IMAGE_ENGINE_URL` **and** a secret are both
 * present; otherwise Perchance and Pollinations answer, and neither bills us.
 * Quoting a GPU price for a free render would teach a user to avoid a capability
 * that costs nothing.
 *
 * @param {{speakSeconds?: number[], imageCount?: number, env?: Record<string,string>}} spec
 */
export function estimateSpend({ speakSeconds = [], imageCount = 0, env = process.env } = {}) {
  const lines = [];
  let usd = 0;

  speakSeconds.forEach((seconds, i) => {
    const priced = priceGpuCall({ verb: 'speak', seconds, cold: i === 0 });
    usd += priced.usd;
    if (i === 0) lines.push(`speech: ${speakSeconds.length} call${speakSeconds.length === 1 ? '' : 's'}, first one cold (${priced.basis})`);
  });

  const imagesAreCharged = engineConfig(env).configured;
  if (imageCount > 0) {
    if (imagesAreCharged) {
      for (let i = 0; i < imageCount; i++) {
        usd += priceGpuCall({ verb: 'generate_image', seconds: IMAGE_SECONDS, cold: i === 0 }).usd;
      }
      lines.push(`images: ${imageCount} on our own GPU engine at ~${IMAGE_SECONDS}s each`);
    } else {
      lines.push(`images: ${imageCount} on the free chain (Perchance / Pollinations) — $0.00 to us, but it throttles`);
    }
  }

  return {
    usd,
    lines,
    imagesAreCharged,
    /**
     * ⚠️ SAID OUT LOUD ON EVERY ESTIMATE. These are container-seconds against a
     * published rate, not an invoice, and a number presented without that
     * qualifier is the kind of figure this repo has had to correct four times.
     */
    basis: 'estimated from measured wall-clock assumptions at the published Modal rates — not a quote',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7. THE SPEND GATE
 * ──────────────────────────────────────────────────────────────────────────── */

/** The argument a caller sets once it has seen the price. */
export const SPEND_APPROVAL_ARG = 'approve_spend';

/**
 * May this run actually spend?
 *
 * ── ⚠️⚠️ THE TWO-CALL HANDSHAKE IS THE WHOLE POINT, SO IT IS ARGUED ─────────
 *
 * Every other paid verb in this package spends ONE unit per call, and the model
 * calls it because the user asked for that one thing. These two fan out: one
 * line of JSON can become fourteen TTS calls and four renders. That is a new
 * shape of risk, and the repo's own record on it is bad enough to be written
 * into CLAUDE.md — *"nothing stops a runaway bill today"*.
 *
 * ⭐ SO THE FIRST CALL IS ALWAYS FREE AND ALWAYS RETURNS THE PRICE. It plans, it
 * prices, it hands back the exact ffmpeg argv, and it spends nothing. The second
 * call — with `approve_spend: true` — does the work. The cost is one round; what
 * it buys is that no bill can arrive from this verb that nobody was shown first.
 *
 * ⚠️ `--dry-run` AND `--budget` ARE BOTH HONOURED, AND THEY ARE NOT THE SAME
 * QUESTION. A dry run must not spend even when approved, because the flag
 * promises "touch nothing". A budget refusal is arithmetic: we know the estimate
 * and we know what is left, and starting a run we can already prove will not
 * finish is how a session dies half-way with the money gone.
 */
export function spendGate({ approved, dryRun = false, estimateUsd = 0, budget = null, verb = 'this verb' }) {
  if (dryRun) {
    return { go: false, why: `this is a --dry-run, so nothing was generated. The plan and the estimate below are real.` };
  }
  if (approved !== true) {
    return {
      go: false,
      why: `nothing was generated. ${verb} spends real money on our GPUs, so it prices the run first and `
        + `waits: read the estimate below, tell the user, then call ${verb} again with ${SPEND_APPROVAL_ARG}: true `
        + 'and the identical arguments.',
    };
  }
  /**
   * ⚠️ `remainingUsd` MAY BE `undefined` (no budget object) OR `Infinity`
   * (`--budget none`). Neither is a refusal, and treating a missing number as
   * zero would make this verb unusable in exactly the runs that opted out of
   * budgeting on purpose.
   */
  const left = budget?.canContinue?.()?.remainingUsd;
  if (Number.isFinite(left) && estimateUsd > left) {
    return {
      go: false,
      overBudget: true,
      why: `this run is estimated at $${estimateUsd.toFixed(4)} and only $${Number(left).toFixed(4)} is left in `
        + 'the budget, so nothing was generated. Raise --budget, or cut the number of scenes/lines.',
    };
  }
  return { go: true };
}
