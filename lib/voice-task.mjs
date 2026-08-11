/**
 * ── ⭐⭐ TALK TO YOUR TERMINAL — the two voice directions ─────────────────────
 *
 * AUDIO IN:  record a memo on your phone, drop the file in the repo,
 *            `acuvo --task-audio note.m4a` — it transcribes it, SHOWS you what
 *            it heard, and only then codes what you said.
 * AUDIO OUT: `acuvo --say "<task>"` — walk away from a long run and come back
 *            to a one-sentence verdict you can hear instead of read.
 *
 * Both halves were proven end to end against the live Modal endpoints on
 * 2026-08-11: `speak` produced a real 211,244-byte WAV, and `transcribe`
 * returned the exact sentence back. This module is assembly, not research; the
 * work is entirely in the two places assembly goes wrong.
 *
 * ── ⚠️⚠️ FILE IN, FILE OUT. THIS MODULE DOES NOT RECORD AND DOES NOT PLAY. ──
 *
 * Say it plainly because the feature invites the assumption. There is NO
 * zero-dependency way to capture a microphone in Node — no built-in audio API
 * exists, and every option (`node-record-lpcm16`, `naudiodon`, a bundled
 * `sox`/`ffmpeg`) is either an npm package or a shipped binary. This package's
 * headline enterprise property is zero dependencies forever, and that property
 * is worth more than live capture. Playback is the same argument in reverse:
 * we write a WAV into the workspace and hand back the ONE command that plays it
 * on your OS (`playbackHint`), rather than spawning an audio player ourselves.
 *
 * ⭐ IF ANYONE REVISITS LIVE CAPTURE, this is what it costs, so the trade is
 * argued rather than rediscovered: (a) an OS binary reached through
 * `command.mjs`'s allowlist — `ffmpeg -f dshow` on Windows, `-f avfoundation`
 * on macOS, `arecord` on Linux — which is three platform paths, a permissions
 * prompt on macOS, and a dependency on software we do not ship; or (b) an
 * optional peer dependency, which ends the zero-dependency claim the moment it
 * is documented. The honest middle is what is built here: any recorder the user
 * already has produces a file, and a file is a first-class input.
 *
 * ── ⚠️⚠️ A TRANSCRIPT IS A MODEL INSTRUCTION THAT NOBODY PROOFREAD ──────────
 *
 * This is the whole reason `taskFromAudio` does not simply return a string and
 * let the caller run it. Whisper mishears — "the server" becomes "the sensor",
 * "don't delete" becomes "do delete" — and on silence it does something worse:
 * it INVENTS. "Thanks for watching!" is its most famous hallucination and an
 * empty room reliably produces it. Handing that to a file-writing agent is the
 * same class of mistake as executing a command you never read.
 *
 * ⭐ SO THE SEAM IS: transcribe → SHOW → decide → run. `taskFromAudio` always
 * returns `needsConfirmation: true` and never acts. `decideTranscript` is a
 * pure function of (what was heard, what the user answered, is this a terminal,
 * is this --json) and returns whether to run and WITH WHAT TEXT — so the
 * confirmation policy is one reviewable table instead of branching inside a
 * CLI. Under `--json` or on a non-TTY there is nobody to ask, so the answer is
 * a REFUSAL naming `--yes`, never a silent yes.
 *
 * ⭐⭐ AND A CORRECTION IS NOT A REFUSAL. "no, the server not the sensor" is the
 * commonest real answer to a mis-heard task, and treating it as "n" would throw
 * the user's own fix away and make them retype the whole thing. Answering with
 * anything substantive amends or replaces the task in one line.
 *
 * ── ⚠️ AUDIO THAT PLAYS UNASKED IS HOSTILE, AND A DIFF READ ALOUD IS A
 *      PUNISHMENT ─────────────────────────────────────────────────────────────
 * `speakSummary` is silent by default and returns `{ ok: true, spoken: false }`
 * for it — silence is a correct outcome, not a failure. When it is asked for,
 * it speaks the VERDICT: what was asked, how much changed, did it verify. Never
 * the file list. Sixty seconds of paths read by a synthesiser is worse than no
 * feature, so `summariseOutcome` is hard-capped at `MAX_SPOKEN_CHARS` and names
 * a file only when exactly one changed.
 *
 * ── ⚠️ AND IT DEGRADES BY BEING ABSENT, NOT BY BEING BROKEN ────────────────
 * No `MODAL_TRANSCRIBE_URL` → `--task-audio` reports that it is unavailable and
 * reaches no network. No `MODAL_TTS_URL` → the same for `--say`. Nothing here
 * is ever offered-and-broken; `mediaToolSchemas` in media.mjs settled that rule
 * for the model-facing tools and this is the human-facing half of it.
 */

import { speak, transcribe, mediaConfig } from './media.mjs';

/**
 * The ceiling on a SPOKEN task. An hour-long podcast transcribes to tens of
 * thousands of characters, and handing that to the model as one instruction is
 * a real bill for a request nobody made — a voice memo that turns into a
 * 68,000-character prompt is a mis-drop, not a task.
 *
 * ⚠️ REFUSED, NOT TRUNCATED. Cutting it at 4,000 would run the first minute of
 * what was said and silently discard the rest, which is the worst of the three
 * options: the user believes their whole instruction was heard.
 */
export const MAX_TASK_CHARS = 4000;

/** One or two sentences. Anything longer stops being a verdict. */
export const MAX_SPOKEN_CHARS = 320;

/**
 * What this install can hear and say.
 *
 * ⚠️ READ AT CALL TIME from `env`, never captured at import — same rule as
 * `mediaConfig`, for the same reason: a variable that changed mid-session must
 * be seen, and a module-level snapshot is how a capability stays dark after it
 * was fixed. Delegated to `mediaConfig` rather than re-reading the variables,
 * so the two can never disagree about whether a service is configured.
 */
export function voiceConfig(env = process.env) {
  const cfg = mediaConfig(env);
  return {
    canListen: Boolean(cfg.transcribe),
    canSpeak: Boolean(cfg.speak),
    listenUrl: cfg.transcribe ?? null,
    speakUrl: cfg.speak ?? null,
  };
}

/**
 * Tidy a transcript into one line of instruction.
 *
 * ⚠️ WHITESPACE ONLY. It normalises CRLF, collapses runs of space and strips a
 * BOM — and it does NOT touch a single word. Non-ASCII survives byte for byte,
 * because most of the world does not dictate in English and a "cleaner" that
 * mangles `健康チェック` or `santé` has corrupted the instruction it was meant
 * to prepare. Emoji included: `ship it 🚀` is a real thing people say.
 */
export function cleanTranscript(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ── ⚠️⚠️ WHISPER INVENTS WORDS WHEN THERE IS NOTHING TO HEAR ────────────────
 *
 * These strings are its documented hallucinations on silence or noise — they
 * come from the YouTube captions it was trained on, so a quiet room produces
 * "Thanks for watching!" with full confidence. That phrase reaching a coding
 * agent as an instruction is not a hypothetical.
 *
 * ⭐ FLAGGED, NEVER STRIPPED. Editing the transcript under the user is a second
 * mis-hearing on top of the first; the honest move is to show the words AND the
 * doubt, and let a human spend one keystroke.
 */
const HALLUCINATIONS = [
  /^thanks? for watching/i,
  /^thank you\.?$/i,
  /^thanks\.?$/i,
  /^subtitles?\b.*\b(by|provided)/i,
  /amara\.org/i,
  /^\s*[♪♫]/,
  /^bye[.!]?$/i,
  /^you\.?$/i,
];

/**
 * Reasons to look twice before running this. Pure — takes the text and the
 * segments the service returned, returns sentences.
 *
 * ⚠️ IT MUST NOT FIRE ON A GOOD TRANSCRIPT. A check that flags correct work
 * trains people to press through the warning, which is strictly worse than no
 * warning at all — this repo has been bitten by that four times in one day.
 */
export function transcriptWarnings(text, segments = []) {
  const out = [];
  const t = cleanTranscript(text);
  if (!t) return ['nothing was heard — the transcript is empty'];

  if (HALLUCINATIONS.some((re) => re.test(t))) {
    out.push('⚠️ that looks like what the transcriber says when it hears SILENCE — it hallucinates stock captions on quiet audio. Check the recording before running this.');
  }

  const words = t.split(' ').filter(Boolean);
  if (words.length < 3 || t.length < 12) {
    out.push(`⚠️ only ${words.length} word${words.length === 1 ? '' : 's'} was heard — one mis-heard word would be the entire task`);
  }

  /**
   * `avg_logprob` is the model's own confidence; below about -1.0 it is
   * guessing. `no_speech_prob` above 0.5 means it half-believes the clip is
   * silent — while still returning words for it.
   */
  const segs = Array.isArray(segments) ? segments.filter((s) => s && typeof s === 'object') : [];
  const unsure = segs.filter((s) => (typeof s.avg_logprob === 'number' && s.avg_logprob < -1.0)
    || (typeof s.no_speech_prob === 'number' && s.no_speech_prob > 0.5));
  if (unsure.length > 0) {
    const worst = unsure.map((s) => (typeof s.text === 'string' ? s.text.trim() : '')).filter(Boolean)[0];
    out.push(`⚠️ low confidence on ${unsure.length} segment${unsure.length === 1 ? '' : 's'}${worst ? ` (e.g. "${worst.slice(0, 60)}")` : ''} — read it before you run it`);
  }

  return out;
}

/**
 * ── ⭐ AUDIO IN — a voice memo becomes a task ────────────────────────────────
 *
 * ⚠️⚠️ IT NEVER ACTS. It returns `needsConfirmation: true` and the words it
 * heard. Running is the caller's decision, made through `decideTranscript`.
 *
 * ⚠️ `transcribeImpl` DEFAULTS TO THE REAL ONE and `fetchImpl` is threaded
 * through it, on purpose: the tests exercise the genuine payload contract with
 * an injected fetch rather than stubbing the media module. That contract is not
 * theoretical — this endpoint reads `audio_b64`, and one underscore cost this
 * package the entire voice loop once already.
 */
export async function taskFromAudio(root, audioPath, { env = process.env, fetchImpl = fetch, transcribeImpl = transcribe } = {}) {
  const cfg = voiceConfig(env);
  if (!cfg.canListen) {
    return {
      ok: false,
      error: 'no transcription service is configured (MODAL_TRANSCRIBE_URL), so --task-audio is unavailable on this machine. Set it in your .env and the flag starts working; nothing else changes.',
    };
  }

  const heard = await transcribeImpl(root, audioPath, { env, fetchImpl });
  if (!heard.ok) return { ok: false, error: heard.error };

  const task = cleanTranscript(heard.text);
  const where = heard.path ?? audioPath;
  if (!task) {
    return {
      ok: false,
      error: `no speech was found in ${where} — the transcript came back empty, so there is nothing to run. Check the file actually contains audio.`,
    };
  }
  if (task.length > MAX_TASK_CHARS) {
    return {
      ok: false,
      error: `${where} transcribes to ${task.length} characters, over the ${MAX_TASK_CHARS}-character limit for a spoken task. That is a recording, not an instruction — refused rather than truncated, because running the first minute and silently dropping the rest is worse than refusing.`,
    };
  }

  return {
    ok: true,
    path: where,
    task,
    transcript: task,
    segments: Array.isArray(heard.segments) ? heard.segments : [],
    warnings: transcriptWarnings(task, heard.segments),
    /**
     * ⚠️ ALWAYS TRUE, never conditional on the warnings being empty. A
     * confidently-transcribed wrong word is the dangerous case, not the
     * flagged one — "delete the sensor cache" arrives at full confidence.
     */
    needsConfirmation: true,
  };
}

/**
 * The lines to SHOW before acting. Pure, and total: a partial result must still
 * render, because the one moment this is called is the moment something is
 * about to be run.
 */
export function confirmationLines(result) {
  const r = result ?? {};
  const lines = [''];
  lines.push(`  heard in ${r.path ?? 'the audio file'}:`);
  lines.push('');
  lines.push(`    "${typeof r.task === 'string' && r.task ? r.task : '(nothing)'}"`);
  lines.push('');
  for (const w of Array.isArray(r.warnings) ? r.warnings : []) lines.push(`  ${w}`);
  if (Array.isArray(r.warnings) && r.warnings.length > 0) lines.push('');
  lines.push('  run it? [y = yes · Enter = no · or type a correction]');
  return lines;
}

/** Single-word answers that mean "run it as heard". */
const AFFIRM = new Set(['y', 'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'go', 'run', 'do']);
/** Single-word answers that mean "do not". */
const DENY = new Set(['n', 'no', 'nope', 'nah', 'q', 'quit', 'cancel', 'abort', 'stop']);
/**
 * ⚠️ A SEPARATE, SMALLER SET, and the difference matters. A multi-word answer
 * beginning with a pure yes/no PARTICLE is a correction to the transcript
 * ("no, the server not the sensor"). A multi-word answer beginning with a VERB
 * that merely happens to be in AFFIRM — "run the test suite and report the
 * failures" — is a whole new instruction, and amending the mis-heard one onto
 * it would smuggle the mistake back in.
 */
const AMEND_PREFIX = new Set(['y', 'yes', 'yeah', 'yep', 'n', 'no', 'nope', 'nah', 'ok', 'okay']);

/**
 * ── ⭐⭐ THE CONFIRMATION POLICY, AS ONE PURE TABLE ─────────────────────────
 *
 * Inputs: what was heard, what the human typed, whether there IS a human
 * (`tty`), whether the caller promised a machine one JSON object (`json`), and
 * whether they pre-authorised with `--yes`. Output: run or not, and with what.
 *
 * ⚠️⚠️ NO TTY AND NO `--yes` MEANS REFUSE. Under `--json`, in a pipe, in cron
 * or in CI there is nobody to show the transcript to — and "nobody was there to
 * object" is not consent. The refusal names `--yes`, so a script that genuinely
 * wants unattended voice tasking says so once, out loud, in its own source.
 */
export function decideTranscript(input) {
  const { task = '', answer = null, tty = false, json = false, assumeYes = false } = input ?? {};
  const base = typeof task === 'string' ? task.trim() : '';

  if (assumeYes) {
    return { run: true, task: base, edited: false, how: 'accepted', why: '--yes was passed, so the transcript was pre-authorised' };
  }
  if (json) {
    return { run: false, task: base, edited: false, how: 'refused', why: '--json emits one object and cannot stop to ask whether the transcript is right. Pass --yes if you have decided in advance, or drop --json and confirm in the terminal.' };
  }
  if (!tty) {
    return { run: false, task: base, edited: false, how: 'refused', why: 'this is not an interactive terminal, so there is nobody to show the transcript to — and nobody objecting is not the same as somebody agreeing. Pass --yes to run a transcript unattended.' };
  }

  const raw = typeof answer === 'string' ? answer.trim() : '';
  if (raw === '') {
    return { run: false, task: base, edited: false, how: 'cancelled', why: 'no answer given — the default is not to act' };
  }

  const tokens = raw.split(/\s+/);
  const first = tokens[0].toLowerCase().replace(/[^a-z]/g, '');

  if (tokens.length === 1 && AFFIRM.has(first)) {
    return { run: true, task: base, edited: false, how: 'accepted', why: 'confirmed as heard' };
  }
  if (tokens.length === 1 && DENY.has(first)) {
    return { run: false, task: base, edited: false, how: 'cancelled', why: 'declined' };
  }

  if (AMEND_PREFIX.has(first)) {
    const rest = tokens.slice(1).join(' ').replace(/^[,;:.\-—]+\s*/, '').trim();
    if (rest) {
      return {
        run: true,
        /**
         * ⭐ THE ORIGINAL WORDS ARE KEPT AND THE CORRECTION IS MARKED AS
         * WINNING. Replacing the transcript outright would lose everything the
         * user said that was heard CORRECTLY, which is nearly all of it.
         */
        task: `${base}\n\nCorrection from the user — this wins wherever it disagrees with the line above: ${rest}`,
        edited: true,
        how: 'amended',
        why: 'the transcript was corrected rather than rejected',
      };
    }
    return AFFIRM.has(first)
      ? { run: true, task: base, edited: false, how: 'accepted', why: 'confirmed as heard' }
      : { run: false, task: base, edited: false, how: 'cancelled', why: 'declined' };
  }

  return { run: true, task: raw, edited: true, how: 'replaced', why: 'the user typed a different task, so the transcript was discarded' };
}

/**
 * ── ⚠️ MAKE A STRING SPEAKABLE ──────────────────────────────────────────────
 * A synthesiser reads `**fix** the \`parser\`` as punctuation. Markdown, ANSI
 * and brackets go; every letter — including non-ASCII — stays.
 */
function speakable(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[*`_#[\]<>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The last path segment. A deep path read aloud is noise; the filename is the fact. */
function basename(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * ── ⭐⭐ THE VERDICT — pure, and the only thing that gets spoken ─────────────
 *
 * Three facts and no more: what was asked, how much changed, whether it
 * verified. Everything else belongs in the terminal, where it can be scrolled
 * back and read at your own speed.
 *
 * ⚠️⚠️ THE FAILING CASE MUST NEVER FLATTER. `verification.ran` and
 * `verification.passed` stay separate here exactly as they do everywhere else
 * in this codebase — collapsing them is how a run whose suite exits 1 gets
 * narrated as a success, and speech is the worst possible medium for that lie
 * because nobody re-reads it.
 *
 * ⚠️ AND "NOTHING WAS RUN" IS SAID OUT LOUD. Omitting the verification clause
 * when nothing was checked leaves a sentence that SOUNDS like success.
 */
export function summariseOutcome(outcome, { task = null, maxChars = MAX_SPOKEN_CHARS } = {}) {
  if (outcome == null) return 'There is no result to report.';

  if (outcome.ok === false) {
    const why = speakable(outcome.error ?? outcome.stage ?? 'no reason was given').slice(0, 160);
    return speakable(`The run did not finish: ${why}.`).slice(0, maxChars);
  }

  const executed = Array.isArray(outcome.executed) ? outcome.executed.filter(Boolean) : [];
  const writes = executed.filter((e) => e && (e.mutated === true || e.name === 'write_file') && e.result?.ok === true);

  let changePart;
  if (writes.length === 0) {
    changePart = 'No files changed.';
  } else if (writes.length === 1) {
    // ⭐ ONE name is worth hearing. Twelve is a punishment, so above one it is a
    // count — the terminal already printed the list.
    changePart = `Changed ${speakable(basename(writes[0].result?.path ?? writes[0].path ?? 'one file'))}.`;
  } else {
    changePart = `Changed ${writes.length} files.`;
  }

  const v = outcome.verification ?? {};
  const cmd = speakable(v.command ?? 'the check').slice(0, 40);
  let verifyPart;
  if (v.ran !== true) {
    verifyPart = 'Nothing was run to check it.';
  } else if (v.passed === true) {
    verifyPart = `${cmd} passed.`;
  } else {
    verifyPart = `${cmd} still fails${typeof v.exitCode === 'number' ? ` with exit code ${v.exitCode}` : ''}.`;
  }

  const tail = `${changePart} ${verifyPart}`;
  const asked = speakable(task);
  if (!asked) return speakable(tail).slice(0, maxChars);

  // The verdict is the point, so it gets the budget first and the request is
  // trimmed to whatever is left rather than the other way round.
  const budget = maxChars - tail.length - 'Asked to  . '.length;
  const shortAsked = asked.length > budget && budget > 12 ? `${asked.slice(0, budget - 1).trim()}…` : asked;
  if (budget <= 12) return speakable(tail).slice(0, maxChars);
  return speakable(`Asked to ${shortAsked}. ${tail}`).slice(0, maxChars);
}

/**
 * ── ⭐ AUDIO OUT — narrate the verdict ──────────────────────────────────────
 *
 * ⚠️⚠️ SILENT BY DEFAULT, and that silence is `ok: true`. A run that was not
 * asked to speak has not failed to speak. Only an explicit `enabled` (the
 * `--say` flag) makes a request, which is also what keeps this from quietly
 * spending money on every run.
 *
 * ⚠️ ASKED-BUT-UNCONFIGURED IS `ok: false`, WITH THE VARIABLE NAMED. Staying
 * quiet there would be the "offered and broken" failure inverted: the user
 * pressed the button and heard nothing, with no way to learn why.
 *
 * ⚠️ IT CAN NEVER FAIL THE RUN. The caller prints `reason` to stderr and moves
 * on — the code is already written and the exit code is a verification verdict,
 * not a bookkeeping one. `text` is returned even on failure so the verdict it
 * could not say can still be printed.
 */
export async function speakSummary(root, outcome, {
  env = process.env,
  fetchImpl = fetch,
  speakImpl = speak,
  task = null,
  enabled = false,
  dryRun = false,
  outPath = null,
  now = Date.now,
} = {}) {
  const text = summariseOutcome(outcome, { task });

  if (!enabled) return { ok: true, spoken: false, reason: 'not asked for — pass --say to hear the verdict', text };
  // `--help` promises a dry run touches nothing, and a WAV is something.
  if (dryRun) return { ok: true, spoken: false, reason: 'dry run — nothing was written and nothing was spoken', text };

  const cfg = voiceConfig(env);
  if (!cfg.canSpeak) {
    return {
      ok: false,
      spoken: false,
      reason: 'no speech service is configured (MODAL_TTS_URL), so the verdict was not spoken. Set it in your .env and --say starts working.',
      text,
    };
  }

  const target = outPath || `.acuvo/verdict-${now()}.wav`;
  const res = await speakImpl(root, text, target, { env, fetchImpl });
  if (!res.ok) return { ok: false, spoken: false, reason: res.error, text };

  return { ok: true, spoken: true, path: res.path, bytes: res.bytes, text, hint: playbackHint(res.path) };
}

/**
 * ⚠️ WE WROTE A FILE; WE DID NOT PLAY IT — see the header. This returns the one
 * command that plays it on this OS, which is honest, zero-dependency, and
 * copy-pasteable. It never claims the sound came out.
 */
export function playbackHint(relPath, platform = process.platform) {
  const p = String(relPath ?? '');
  const q = `"${p.replace(/"/g, '\\"')}"`;
  /**
   * ── ⚠️⚠️ THE QUOTING HAS TO NEST, AND THE FIRST VERSION DID NOT ────────────
   *
   * It used `JSON.stringify(p)` — a DOUBLE-quoted string — inside an argument
   * that is itself double-quoted, producing:
   *
   *   powershell -c "(New-Object Media.SoundPlayer ".acuvo/v.wav").PlaySync()"
   *
   * where the inner `"` closes the outer one. cmd then sees three arguments and
   * PowerShell never receives a string at all. Found by RUNNING the live round
   * trip and reading what it printed; the test that "covered" this asserted
   * only that the word `powershell` appeared, and passed against a command that
   * could never work.
   *
   * ⭐ SINGLE quotes inside, and they are also the right choice on their own
   * merits: a PowerShell single-quoted string is a LITERAL, so a Windows path
   * full of backslashes needs no escaping. The one character that can break out
   * is a single quote, and PowerShell escapes it by doubling.
   */
  if (platform === 'win32') return `powershell -c "(New-Object Media.SoundPlayer '${p.replace(/'/g, "''")}').PlaySync()"`;
  if (platform === 'darwin') return `afplay ${q}`;
  if (platform === 'linux') return `aplay ${q}   (or paplay / ffplay -nodisp -autoexit)`;
  return `play ${q} with any audio player`;
}

/**
 * ── ⭐ THE FLAGS, LIFTED OUT OF ARGV BEFORE `parseArgv` SEES THEM ────────────
 *
 * Exactly the shape `bin/acuvo.mjs` already uses for its lifecycle flags, and
 * for the same reason: `parseArgv` refuses any `--flag` it does not know, which
 * is the right default and is why these come out first.
 *
 * ⚠️ TOTAL, NOT PERMISSIVE. Anything unrecognised is passed through untouched,
 * so `parseArgv` still produces its own sentence for a typo — two parsers both
 * guessing is how `--sayy` gets silently ignored.
 */
export function extractVoiceFlags(argv) {
  const flags = { taskAudio: null, say: false, yes: false };
  const rest = [];
  const need = '--task-audio needs the path to an audio file in the workspace, e.g. --task-audio note.m4a';
  for (let i = 0; i < (argv?.length ?? 0); i += 1) {
    const arg = argv[i];
    if (arg === '--say') { flags.say = true; continue; }
    if (arg === '--yes' || arg === '-y') { flags.yes = true; continue; }
    if (arg === '--task-audio') {
      const value = argv[i + 1];
      // ⚠️ A missing value must not eat the next flag: `--task-audio --json`
      // silently transcribing a file called "--json" is a confusing failure two
      // steps later, and refusing here is one step.
      if (value === undefined || value.startsWith('--')) return { ok: false, error: need };
      flags.taskAudio = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--task-audio=')) {
      const value = arg.slice('--task-audio='.length);
      if (value === '') return { ok: false, error: need };
      flags.taskAudio = value;
      continue;
    }
    rest.push(arg);
  }
  return { ok: true, flags, argv: rest };
}

/** Documented where people look. A capability only the changelog knows about is
 *  the "built but unreachable" failure this whole package exists to end. */
export const VOICE_USAGE = [
  '',
  'Voice (file in, file out — acuvo does not record and does not play):',
  '  --task-audio <file>   Transcribe an audio file in the workspace and run what it says.',
  '                        It SHOWS you the transcript first and waits: press Enter to',
  '                        cancel, y to run it, or type a correction ("no, the server not',
  '                        the sensor") to fix a mis-heard word without retyping the task.',
  '                        Needs MODAL_TRANSCRIBE_URL.',
  '  --say                 Speak the verdict when the run ends — what was asked, how much',
  '                        changed, whether it verified. Writes a .wav into .acuvo/ and',
  '                        prints the command to play it. Silent unless you pass this.',
  '                        Needs MODAL_TTS_URL.',
  '  --yes, -y             Run a transcribed task without confirming. Required with --json',
  '                        or in a pipe/cron/CI, where there is nobody to ask.',
].join('\n');
