/**
 * ── ⚠️⚠️ NOTHING HERE GENERATES A SYLLABLE ──────────────────────────────────
 *
 * Every producer is a stub that writes a real PCM WAV built in-process, so the
 * join, the timeline, the transcript and the manifest are exercised end to end
 * for $0.00 and with no network. The two things this verb could get expensively
 * wrong are BOTH pinned here: spending before the caller has seen the price, and
 * silently dropping half a script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalExecutor } from '../lib/workspace.mjs';
import { buildWavHeader, writeWorkspaceBinary, SPEND_APPROVAL_ARG } from '../lib/media-pipeline.mjs';
import {
  podcast, parseScreenplay, assignVoices, readDirection, looksLikeSpeaker,
  podcastToolNames, podcastToolSchemas, runPodcastTool,
  MAX_CUES, MAX_LINE_CHARS, MAX_PAUSE_SECONDS, DEFAULT_PAUSE_SECONDS,
} from '../lib/podcast.mjs';

/** The one environment in which this verb is reachable at all. */
const TTS_ENV = Object.freeze({ ACUVO_MEDIA_SECRET: 'test-secret' });
/** …plus a designable voice, for the multi-voice half. */
const FULL_ENV = Object.freeze({ ...TTS_ENV, MODAL_VOICE_DESIGN_URL: 'https://example.invalid/design' });

const SCRIPT = `# Two people talking

HOST: Welcome back to the show.
GUEST: Glad to be here.

[pause 2s]

HOST: So tell me how it started.
GUEST: It started with a spreadsheet
and it got out of hand from there.
`;

function wav(seconds, { sampleRate = 24_000 } = {}) {
  const body = Buffer.alloc(Math.round(seconds * sampleRate) * 2, 3);
  return Buffer.concat([buildWavHeader({ sampleRate, channels: 1, bitsPerSample: 16, dataBytes: body.length }), body]);
}

/**
 * ⭐ THE STUB WRITES A REAL FILE, because that is what the real producers do —
 * `speak` and `designVoice` both write the audio themselves and hand back a
 * path. A stub that only returned `{ok:true}` would leave the read-back, the
 * join and every duration in this file untested.
 */
function producers({ seconds = 1, sampleRate = 24_000 } = {}) {
  const calls = [];
  const write = (root, path) => {
    const w = writeWorkspaceBinary(root, path, wav(seconds, { sampleRate }), false);
    return { ok: true, path: w.path, bytes: w.bytes };
  };
  return {
    calls,
    speakImpl: async (root, text, path) => { calls.push({ via: 'speak', text, path }); return write(root, path); },
    designImpl: async (root, { description, text, path }) => { calls.push({ via: 'design_voice', description, text, path }); return write(root, path); },
  };
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'podcast-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE PARSE
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ a screenplay becomes cues, a title, and a record of what was not spoken', () => {
  const p = parseScreenplay(SCRIPT);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.title, 'Two people talking');
  assert.deepEqual(p.speakers, ['HOST', 'GUEST']);
  assert.equal(p.cues.length, 4);
  assert.equal(p.cues[3].text, 'It started with a spreadsheet and it got out of hand from there.',
    'a wrapped line must belong to the cue above it');
  assert.equal(p.cues[2].pauseBefore, 2, 'the [pause 2s] was lost');
  assert.equal(p.cues[0].pauseBefore, 0);
});

/**
 * ⚠️⚠️ THE FAILURE THIS GUARD IS FOR IS NOT A CRASH. It is a production note
 * being read aloud in a stranger's voice — and `Note: cut this bit` is exactly
 * the shape that "anything before a colon is a speaker" would happily narrate.
 */
test('⚠️⚠️ a sentence with a colon in it is not a character', () => {
  assert.equal(looksLikeSpeaker('HOST'), true);
  assert.equal(looksLikeSpeaker('Dr. Okafor'), true);
  assert.equal(looksLikeSpeaker('GUEST 2'), true);
  assert.equal(looksLikeSpeaker('One thing I keep coming back to is this'), false, 'a whole sentence became a character');
  assert.equal(looksLikeSpeaker(''), false);
  assert.equal(looksLikeSpeaker('9:30'), false);
});

test('⭐ [pause] is understood in every spelling, and an absurd one is clamped', () => {
  assert.deepEqual(readDirection('[pause]'), { kind: 'pause', seconds: DEFAULT_PAUSE_SECONDS, clamped: false });
  assert.equal(readDirection('[pause 2s]').seconds, 2);
  assert.equal(readDirection('[pause 1.5]').seconds, 1.5);
  assert.equal(readDirection('[pause 300]').seconds, MAX_PAUSE_SECONDS);
  assert.equal(readDirection('[pause 300]').clamped, true);
  assert.deepEqual(readDirection('[they both laugh]'), { kind: 'note', text: 'they both laugh' });
});

test('⚠️ a stage direction is RECORDED, never spoken and never silently dropped', () => {
  const p = parseScreenplay('HOST: hello\n\n[they both laugh]\n\nHOST: goodbye');
  assert.equal(p.cues.length, 2);
  assert.match(p.notes.join(' '), /stage direction "they both laugh" is recorded but not spoken/);
});

/**
 * ⚠️⚠️ THE EXPENSIVE FAILURE IS A CONFIDENT SHORT EPISODE. A prose document that
 * happens to contain two dialogue lines must not become a two-line podcast that
 * reports success — the user finds out when they play it.
 */
test('⚠️⚠️ a file that is mostly prose is REFUSED, not quietly half-read', () => {
  const p = parseScreenplay([
    'This is a memo about the quarter.', '', 'It has several paragraphs.', '',
    'Here is another one entirely.', '', 'And one more for good measure.', '',
    'HOST: hello',
  ].join('\n'));
  assert.equal(p.ok, false);
  assert.match(p.error, /4 lines could not be read as dialogue and only 1 could/);
  assert.match(p.error, /SPEAKER: /);
});

test('⚠️ an empty script names the format rather than saying "invalid"', () => {
  const p = parseScreenplay('# Just a heading\n');
  assert.equal(p.ok, false);
  assert.match(p.error, /SPEAKER: what they say/);
  assert.match(p.error, /\[pause 2s\]/);
});

test('⚠️ the bounds refuse with the line number, and never truncate', () => {
  const long = parseScreenplay(`HOST: ${'x'.repeat(MAX_LINE_CHARS + 1)}`);
  assert.equal(long.ok, false);
  assert.match(long.error, new RegExp(`over the ${MAX_LINE_CHARS}`));

  const many = parseScreenplay(Array.from({ length: MAX_CUES + 1 }, (_, i) => `HOST: line ${i}`).join('\n\n'));
  assert.equal(many.ok, false);
  assert.match(many.error, new RegExp(`past the ${MAX_CUES}-line ceiling`));
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE VOICES
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ THE HEADLINE DEFECT OF A "MULTI-VOICE" VERB IS ONE VOICE. `speak` is a
 * FIXED reader; two speakers routed through it is one person arguing with
 * themselves, and nothing in the finished audio says why.
 */
test('⚠️⚠️ two speakers on the one fixed voice is a WARNING, before anything is spent', () => {
  const { map, warnings } = assignVoices(['HOST', 'GUEST'], {}, TTS_ENV);
  assert.equal(map.get('HOST').via, 'speak');
  assert.match(warnings.join(' '), /HOST, GUEST will all be read by the SAME fixed voice/);
  assert.match(warnings.join(' '), /voices/, 'the warning must name the fix');
});

test('⭐ a described voice routes to design_voice where it is reachable', () => {
  const { map, warnings } = assignVoices(['HOST', 'GUEST'], { HOST: 'warm, unhurried', GUEST: 'clipped, fast' }, FULL_ENV);
  assert.equal(map.get('HOST').via, 'design_voice');
  assert.equal(map.get('GUEST').description, 'clipped, fast');
  assert.deepEqual(warnings, []);
});

test('⚠️ a described voice with no design endpoint DOWNGRADES loudly and names the variable', () => {
  /**
   * ── ⭐ THE ENV MOVED, THE CONTRACT DID NOT (2026-08-25) ────────────────────
   *
   * `TTS_ENV` used to mean "a secret and no design endpoint", because
   * `avatar.mjs` shipped no addresses and a URL had to be typed. It now ships
   * them, so a bare secret means voice DESIGN IS available — which is the whole
   * point of that change, and this assertion started failing with
   * `design_voice` where it expected `speak`.
   *
   * ⭐ THE DOWNGRADE IS STILL WORTH PINNING, so the setup moves to the case that
   * genuinely has no design endpoint: the documented `MODAL_VOICE_DESIGN_URL=`
   * opt-out. Deleting the test would have thrown away coverage of a path that
   * still exists; changing the expectation to `design_voice` would have thrown
   * away the downgrade entirely.
   */
  const optedOut = { ...TTS_ENV, MODAL_VOICE_DESIGN_URL: '' };
  const { map, warnings } = assignVoices(['HOST'], { HOST: 'warm, unhurried' }, optedOut);
  assert.equal(map.get('HOST').via, 'speak');
  assert.equal(map.get('HOST').downgraded, true);
  assert.match(warnings.join(' '), /MODAL_VOICE_DESIGN_URL/);
});

test('⭐⭐ a bare secret now REACHES voice design — the addresses ship with the package', () => {
  /**
   * The other half of the inversion above, asserted rather than assumed. Before
   * 2026-08-25 this returned `speak` on every install that was not our own
   * console directory, because the endpoint URLs lived in a file that ships to
   * nobody.
   */
  const { map, warnings } = assignVoices(['HOST'], { HOST: 'warm, unhurried' }, TTS_ENV);
  assert.equal(map.get('HOST').via, 'design_voice');
  assert.notEqual(map.get('HOST').downgraded, true);
  assert.deepEqual(warnings, []);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE VERB
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ THE FIRST CALL PRICES THE RUN AND GENERATES NOTHING', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await podcast(createLocalExecutor(root), { script: SCRIPT, title: 'Ep 1' },
    { env: TTS_ENV, ...p, detectImpl: () => ({ ok: false, reason: 'no ffmpeg here.' }) });

  assert.equal(res.ok, true);
  assert.equal(res.spent, false);
  assert.equal(p.calls.length, 0, 'a producer ran before anybody saw the price');
  assert.ok(res.estimatedUsd > 0, 'the estimate must be a number the user can act on');
  assert.equal(res.lines, 4);
  assert.match(res.next, new RegExp(SPEND_APPROVAL_ARG));
  assert.equal(existsSync(join(root, 'audio')), false, 'the priced call wrote a file');
  assert.match(res.costBasis.join(' '), /not a quote/);
});

test('⚠️ a --dry-run prices it and still touches nothing, even when approved', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await podcast(createLocalExecutor(root, { dryRun: true }),
    { script: SCRIPT, [SPEND_APPROVAL_ARG]: true }, { env: TTS_ENV, ...p });
  assert.equal(res.spent, false);
  assert.equal(res.dryRun, true);
  assert.equal(p.calls.length, 0);
  assert.match(res.next, /--dry-run/);
});

test('⚠️ --budget refuses a run it can already prove will not finish', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await podcast(createLocalExecutor(root), { script: SCRIPT, [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p, budget: { canContinue: () => ({ remainingUsd: 0.000001 }) },
  });
  assert.equal(res.spent, false);
  assert.equal(res.overBudget, true);
  assert.equal(p.calls.length, 0, 'money moved after the budget said no');
});

test('⭐⭐ approved, it produces one file per line, one episode, and a MEASURED transcript', async (t) => {
  const root = workspace(t);
  const p = producers({ seconds: 2 });
  const res = await podcast(createLocalExecutor(root), {
    script: SCRIPT, title: 'Ep 1', voices: { HOST: 'warm', GUEST: 'clipped' }, [SPEND_APPROVAL_ARG]: true,
  }, { env: FULL_ENV, ...p, detectImpl: () => ({ ok: false, reason: 'no ffmpeg here.' }) });

  assert.equal(res.ok, true, res.error);
  assert.equal(res.spent, true);
  assert.equal(p.calls.length, 4);
  assert.deepEqual([...new Set(p.calls.map((c) => c.via))], ['design_voice'], 'the described voices were not used');

  assert.equal(res.episode, 'audio/ep-1/episode.wav');
  for (const f of res.files) assert.ok(existsSync(join(root, f)), `${f} is in the manifest and not on disk`);

  /**
   * ⭐ 4 lines × 2s + 3 gaps: one 0.4s default, one 0.4+2s from the [pause 2s],
   * one 0.4s. The arithmetic is asserted because a caption clock that is a
   * second out by the end is the classic subtitle failure, and it is invisible
   * to any test that does not do this sum.
   */
  assert.equal(res.seconds, 11.2);

  const srt = readFileSync(join(root, 'audio/ep-1/transcript.srt'), 'utf8');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nHOST: Welcome back to the show\./);
  /**
   * Line 2 ends at 4.400. The gap before line 3 is 0.4 + the script's 2s pause,
   * so line 3 starts at 6.800. ⚠️ THAT SUM IS THE ASSERTION: a transcript that
   * ignores the pause is out by two seconds from here to the end of the episode,
   * and nothing about the file looks wrong.
   */
  assert.match(srt, /00:00:06,800 --> 00:00:08,800\nHOST: So tell me how it started\./,
    'the third line must start after the 2-second pause');
});

test('⚠️ with no ffmpeg an mp3 request still ships the episode, and names the command', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await podcast(createLocalExecutor(root), { script: SCRIPT, format: 'mp3', [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p, detectImpl: () => ({ ok: false, reason: '`ffmpeg` is not on this machine\'s PATH.' }),
  });
  assert.equal(res.ok, true, res.error);
  assert.ok(existsSync(join(root, res.episode)), 'the WAV must survive a missing ffmpeg');
  assert.equal(res.converted, undefined);
  assert.match(res.conversionNote, /not on this machine's PATH/);
  assert.match(res.conversionNote, /ffmpeg -y -i episode\.wav -c:a libmp3lame -b:a 128k episode\.mp3/);
});

test('⭐ with ffmpeg, the conversion runs from inside the episode folder', async (t) => {
  const root = workspace(t);
  const p = producers();
  let ran = null;
  const res = await podcast(createLocalExecutor(root), { script: SCRIPT, format: 'm4a', title: 'Ep 1', [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p,
    detectImpl: () => ({ ok: true, bin: 'ffmpeg', version: 'ffmpeg version 7.1' }),
    runImpl: (opts) => { ran = opts; return { ok: true }; },
  });
  assert.equal(res.converted, 'audio/ep-1/episode.m4a');
  assert.deepEqual(ran.argv, ['-y', '-i', 'episode.wav', '-c:a', 'aac', '-b:a', '128k', 'episode.m4a']);
  assert.ok(ran.cwd.endsWith(join('audio', 'ep-1')), `ran in ${ran.cwd}, not in the episode folder`);
});

test('⚠️ --no-run starts no process, and says so instead of failing', async (t) => {
  const root = workspace(t);
  const p = producers();
  let started = false;
  const res = await podcast(createLocalExecutor(root), { script: SCRIPT, format: 'mp3', [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p, allowRun: false,
    detectImpl: () => ({ ok: true, bin: 'ffmpeg', version: 'x' }),
    runImpl: () => { started = true; return { ok: true }; },
  });
  assert.equal(started, false);
  assert.match(res.conversionNote, /--no-run is in force/);
  assert.ok(existsSync(join(root, res.episode)));
});

/**
 * ⚠️ A MID-RUN FAILURE MUST SAY WHICH LINE AND WHAT WAS ALREADY PAID FOR.
 * "the speech service returned no audio" with no line number is what buys four
 * useless retries — this package has the receipt for that one.
 */
test('⚠️ a failed line names the line, and admits the earlier ones were paid for', async (t) => {
  const root = workspace(t);
  const p = producers();
  let n = 0;
  const res = await podcast(createLocalExecutor(root), { script: SCRIPT, [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p,
    speakImpl: async (r, text, path) => (++n === 3 ? { ok: false, error: 'unauthorised' } : p.speakImpl(r, text, path)),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /line 8 \(HOST\): unauthorised/);
  assert.equal(res.spent, true);
  assert.equal(res.produced.length, 2);
});

test('⚠️ a mismatched sample rate is reported as a join failure, with the audio still on disk', async (t) => {
  const root = workspace(t);
  const p = producers();
  let n = 0;
  const odd = producers({ sampleRate: 48_000 });
  const res = await podcast(createLocalExecutor(root), { script: SCRIPT, [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p,
    speakImpl: async (r, text, path) => (++n === 2 ? odd.speakImpl(r, text, path) : p.speakImpl(r, text, path)),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /could not be joined/);
  assert.equal(res.produced.length, 4, 'the per-line files must survive so nothing paid for is lost');
});

/**
 * ── ⚠️⚠️ REWRITTEN 2026-08-31 — see the same note in `viral.test.mjs` ───────
 *
 * It demanded the refusal name `ACUVO_MEDIA_SECRET`, one of OUR Modal
 * credentials, so the test was pinning a message that could only ever waste a
 * customer's time. And it left `home` to chance, which made the assertion a
 * question about whether the developer running it happens to be signed in.
 */
const NO_ACCOUNT_HOME = '/acuvo-podcast-test-no-such-home';

test('⚠️ with no worker AND no account the verb refuses, naming the route a customer HAS', async (t) => {
  const root = workspace(t);
  const res = await podcast(createLocalExecutor(root), { script: SCRIPT }, { env: {}, home: NO_ACCOUNT_HOME });
  assert.equal(res.ok, false);
  assert.match(res.error, /acuvo --login/);
  assert.match(res.error, /MODAL_TTS_URL/);
  assert.ok(!/ACUVO_MEDIA_SECRET|MODAL_VIDEO_SECRET/.test(res.error),
    'the refusal names one of OUR credentials, which a customer can never obtain');
});

test('the script can come from a file in the workspace', async (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);
  ex.writeFile('script.md', SCRIPT);
  const p = producers();
  const res = await podcast(ex, { script_path: 'script.md' }, { env: TTS_ENV, ...p });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.lines, 4);
});

/* ────────────────────────────────────────────────────────────────────────────
 * REGISTRATION
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ offered only where there is a speech service, and never on a single-shot turn', () => {
  // ⚠️ `home` NAMED IN EVERY CALL — the gate is account-aware since 2026-08-31.
  const h = { home: NO_ACCOUNT_HOME };
  assert.deepEqual(podcastToolNames({}, { maxRounds: 16, ...h }), [], 'offered on a machine that cannot speak');
  assert.deepEqual(podcastToolNames(TTS_ENV, { maxRounds: 1, ...h }), [], 'offered on a turn with no round to check it');
  assert.deepEqual(podcastToolNames(TTS_ENV, { maxRounds: 16, ...h }), ['podcast']);
});

test('the schema tells the model the script format and the spend handshake', () => {
  const [s] = podcastToolSchemas();
  assert.equal(s.function.name, 'podcast');
  assert.match(s.function.description, /SPEAKER: what they say/);
  assert.match(s.function.description, new RegExp(SPEND_APPROVAL_ARG));
  assert.ok(Object.prototype.hasOwnProperty.call(s.function.parameters.properties, SPEND_APPROVAL_ARG));
});

test('the dispatcher refuses a name that is not this verb', async () => {
  const r = await runPodcastTool('viral', {}, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown podcast tool "viral"/);
});
