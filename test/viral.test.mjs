/**
 * ── ⚠️⚠️ NOTHING HERE DRAWS OR SPEAKS ───────────────────────────────────────
 *
 * Every producer is stubbed, so the plan, the refusals, the file layout, the
 * caption clock and — above all — the ffmpeg argv are exercised end to end for
 * $0.00. The argv is the real contract: a wrong flag here does not throw, it
 * ships a video that is one scene long or has captions two seconds out, and
 * neither is visible to any test that does not do the arithmetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalExecutor } from '../lib/workspace.mjs';
import { buildWavHeader, writeWorkspaceBinary, SPEND_APPROVAL_ARG, ASPECTS } from '../lib/media-pipeline.mjs';
import { MAX_IMAGES_PER_PROCESS } from '../lib/imagegen.mjs';
import {
  viral, planScenes, captionCues, relativeTo,
  viralToolNames, viralToolSchemas, runViralTool,
  MAX_SCENES, MAX_NARRATION_CHARS, MAX_CAPTION_CHARS,
} from '../lib/viral.mjs';

const TTS_ENV = Object.freeze({ ACUVO_MEDIA_SECRET: 'test-secret' });

const SCENES = [
  { narration: 'Most teams price by the seat.', image_prompt: 'a wall of empty desks, cold light' },
  { narration: 'We price by the outcome.', image_prompt: 'one desk, one lamp, warm light' },
];

function wav(seconds, { sampleRate = 24_000 } = {}) {
  const body = Buffer.alloc(Math.round(seconds * sampleRate) * 2, 3);
  return Buffer.concat([buildWavHeader({ sampleRate, channels: 1, bitsPerSample: 16, dataBytes: body.length }), body]);
}

/**
 * ⭐ THE IMAGE STUB RETURNS `.jpg`, DELIBERATELY. `generate_image` returns a
 * .png OR a .jpg depending on which provider answered — `pipe_to_asset` exists
 * entirely because of it — so a stub that always returns the extension the plan
 * guessed would prove nothing about the one thing most likely to break the mux.
 */
function producers({ seconds = 2, extension = '.jpg' } = {}) {
  const calls = { images: [], speech: [] };
  return {
    calls,
    imageImpl: async ({ prompt, executor, width, height }) => {
      calls.images.push({ prompt, width, height });
      const path = `video/short/scenes/${String(calls.images.length).padStart(2, '0')}${extension}`;
      const w = writeWorkspaceBinary(executor.root, path, Buffer.from('not-really-a-picture'), false);
      return { ok: true, path: w.path, note: 'stub' };
    },
    speakImpl: async (root, text, path) => {
      calls.speech.push({ text, path });
      const w = writeWorkspaceBinary(root, path, wav(seconds), false);
      return { ok: true, path: w.path, bytes: w.bytes };
    },
    designImpl: async (root, { text, path }) => {
      calls.speech.push({ text, path, designed: true });
      const w = writeWorkspaceBinary(root, path, wav(seconds), false);
      return { ok: true, path: w.path, bytes: w.bytes };
    },
  };
}

const noFfmpeg = () => ({ ok: false, reason: '`ffmpeg` is not on this machine\'s PATH.' });
const haveFfmpeg = () => ({ ok: true, bin: 'ffmpeg', version: 'ffmpeg version 7.1' });

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'viral-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE PLAN
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ scenes become a plan with a path for every asset', () => {
  const p = planScenes(SCENES, { dir: 'video/short' });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.needsGeneration, 2);
  assert.equal(p.scenes[0].audioPath, 'video/short/scenes/01.wav');
  assert.equal(p.scenes[1].caption, 'We price by the outcome.', 'the caption defaults to the narration');
  assert.ok(p.scenes[0].estimatedSeconds > 1);
});

test('⚠️ no scenes is answered with the CONTRACT, not "missing argument"', () => {
  const p = planScenes([], { dir: 'v' });
  assert.equal(p.ok, false);
  assert.match(p.error, /ASSEMBLES a video; it does not write one/);
  assert.match(p.error, /you compose the script/);
});

/**
 * ⚠️⚠️ THE CAP IS THE EXPENSIVE ONE. `generate_image` refuses after
 * MAX_IMAGES_PER_PROCESS renders by returning an error MID-RUN — so without this
 * check the fifth scene fails after the first four have already been paid for.
 */
test('⚠️⚠️ too many pictures to draw is refused BEFORE the first one is paid for', () => {
  const many = Array.from({ length: MAX_IMAGES_PER_PROCESS + 1 }, (_, i) => ({ narration: `beat ${i}`, image_prompt: 'x' }));
  const p = planScenes(many, { dir: 'v' });
  assert.equal(p.ok, false);
  assert.match(p.error, new RegExp(`at most ${MAX_IMAGES_PER_PROCESS} images`));
  assert.match(p.error, /already paid for/);
});

test('⭐ a supplied image does not count against the draw cap', () => {
  const mixed = [
    ...Array.from({ length: MAX_IMAGES_PER_PROCESS }, (_, i) => ({ narration: `beat ${i}`, image_prompt: 'x' })),
    { narration: 'and one more', image: 'assets/hero.png' },
  ];
  const p = planScenes(mixed, { dir: 'v' });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.needsGeneration, MAX_IMAGES_PER_PROCESS);
  assert.equal(p.scenes.at(-1).imagePath, 'assets/hero.png');
});

test('⚠️ every bound refuses by naming the scene and the number', () => {
  assert.match(planScenes([{ image_prompt: 'x' }], { dir: 'v' }).error, /scene 1 has no narration/);
  assert.match(planScenes([{ narration: 'hi' }], { dir: 'v' }).error, /neither `image_prompt`.*nor `image`/);
  assert.match(
    planScenes([{ narration: 'x'.repeat(MAX_NARRATION_CHARS + 1), image_prompt: 'p' }], { dir: 'v' }).error,
    new RegExp(`over the ${MAX_NARRATION_CHARS} ceiling`),
  );
  assert.match(
    planScenes([{ narration: 'ok', image_prompt: 'p', caption: 'x'.repeat(MAX_CAPTION_CHARS + 1) }], { dir: 'v' }).error,
    /would not fit on a phone screen/,
  );
  assert.match(
    planScenes(Array.from({ length: MAX_SCENES + 1 }, () => ({ narration: 'x', image: 'a.png' })), { dir: 'v' }).error,
    new RegExp(`past the ${MAX_SCENES}-scene ceiling`),
  );
  assert.match(planScenes(SCENES, { dir: 'v', aspect: '3:2' }).error, /aspect must be one of/);
});

test('caption cues come from the measured timeline, and an empty caption is dropped', () => {
  const cues = captionCues([{ start: 0, end: 2 }, { start: 2, end: 5 }, { start: 5, end: 6 }], ['a', '', 'c']);
  assert.deepEqual(cues, [{ start: 0, end: 2, text: 'a' }, { start: 5, end: 6, text: 'c' }]);
});

/**
 * ⚠️ ffmpeg RUNS WITH `cwd` SET TO THE OUTPUT FOLDER. An image inside it is a
 * bare name; one the caller supplied from elsewhere has to be reached by going
 * up. Backwards, this is "No such file or directory" after every GPU second is
 * already spent.
 */
test('⚠️ a path is expressed from the folder ffmpeg will run in', () => {
  assert.equal(relativeTo('video/short', 'video/short/scenes/01.jpg'), 'scenes/01.jpg');
  assert.equal(relativeTo('video/short', 'assets/hero.png'), '../../assets/hero.png');
  assert.equal(relativeTo('', 'hero.png'), 'hero.png');
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE SPEND GATE
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ THE FIRST CALL PRICES THE RUN, SHOWS THE ARGV, AND DRAWS NOTHING', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root), { title: 'short', scenes: SCENES },
    { env: TTS_ENV, ...p, detectImpl: noFfmpeg });

  assert.equal(res.ok, true);
  assert.equal(res.spent, false);
  assert.equal(p.calls.images.length, 0, 'a picture was drawn before anybody saw the price');
  assert.equal(p.calls.speech.length, 0);
  assert.ok(res.estimatedUsd > 0);
  assert.match(res.next, new RegExp(SPEND_APPROVAL_ARG));
  assert.equal(existsSync(join(root, 'video')), false, 'the priced call wrote a file');
  /** ⭐ The argv is present in the PREVIEW — that is what makes the price legible. */
  assert.ok(res.ffmpeg.argv.includes('-filter_complex'));
  assert.equal(res.ffmpeg.available, false);
  assert.match(res.ffmpeg.reason, /not on this machine's PATH/);
});

test('⚠️ --budget refuses before anything is drawn', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, [SPEND_APPROVAL_ARG]: true }, {
    env: { ...TTS_ENV, ACUVO_IMAGE_ENGINE_URL: 'https://x.invalid', ACUVO_IMAGE_SECRET: 's' },
    ...p, detectImpl: noFfmpeg, budget: { canContinue: () => ({ remainingUsd: 0.000001 }) },
  });
  assert.equal(res.spent, false);
  assert.equal(res.overBudget, true);
  assert.equal(p.calls.images.length, 0);
});

test('⚠️ a --dry-run prices it and touches nothing, even when approved', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root, { dryRun: true }), { scenes: SCENES, [SPEND_APPROVAL_ARG]: true },
    { env: TTS_ENV, ...p, detectImpl: noFfmpeg });
  assert.equal(res.spent, false);
  assert.equal(res.dryRun, true);
  assert.equal(p.calls.images.length + p.calls.speech.length, 0);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE RUN, AND THE ARGV IT PRODUCES
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ approved, it draws, narrates, joins, captions and cuts — and the argv is exact', async (t) => {
  const root = workspace(t);
  const p = producers({ seconds: 2 });
  let ran = null;
  const res = await viral(createLocalExecutor(root), { title: 'short', scenes: SCENES, [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p, detectImpl: haveFfmpeg,
    /**
     * ⚠️ THE STUB WRITES THE mp4 IT CLAIMS TO HAVE WRITTEN. A zero-exit ffmpeg
     * really does leave the file behind, so a mock that returns `{ok:true}` and
     * writes nothing would force the "every file in the manifest is on disk"
     * assertion below to be weakened — and that assertion is the one that would
     * catch the verb reporting an output it never produced.
     */
    runImpl: (o) => {
      ran = o;
      writeWorkspaceBinary(root, 'video/short/short.mp4', Buffer.from('stub-mp4'), false);
      return { ok: true };
    },
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(res.spent, true);
  assert.equal(p.calls.images.length, 2);
  assert.equal(p.calls.speech.length, 2);
  assert.equal(res.video, 'video/short/short.mp4');
  assert.equal(res.seconds, 4);

  /**
   * ⚠️⚠️ EVERY SCENE IS ASKED FOR AT THE FINAL CANVAS SIZE. A 9:16 short whose
   * pictures were composed as 16:9 has its subject cropped out of frame, and the
   * pad bars hide it from anybody reading the code rather than watching it.
   */
  const { width, height } = ASPECTS['9:16'];
  assert.deepEqual(p.calls.images.map((c) => [c.width, c.height]), [[width, height], [width, height]]);

  /**
   * ⭐⭐ THE ARGV, ASSERTED WHOLE. Two things in it are the reason this test
   * exists: the file names carry the engine's OWN `.jpg` rather than the `.png`
   * the plan guessed, and every `-t` is a MEASURED duration rather than the
   * estimate the preview used.
   */
  assert.deepEqual(ran.argv, [
    '-y',
    '-loop', '1', '-t', '2.000', '-i', 'scenes/01.jpg',
    '-loop', '1', '-t', '2.000', '-i', 'scenes/02.jpg',
    '-i', 'voice.wav',
    '-i', 'captions.srt',
    '-filter_complex',
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[v0];`
    + `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[v1];`
    + '[v0][v1]concat=n=2:v=1:a=0[vc];[vc]null[v]',
    '-map', '[v]', '-map', '2:a:0', '-map', '3:s:0', '-c:s', 'mov_text',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'short.mp4',
  ]);
  assert.ok(ran.cwd.endsWith(join('video', 'short')), `ffmpeg ran in ${ran.cwd}, not the output folder`);

  const srt = readFileSync(join(root, 'video/short/captions.srt'), 'utf8');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nMost teams price by the seat\./);
  assert.match(srt, /2\n00:00:02,000 --> 00:00:04,000\nWe price by the outcome\./);

  for (const f of res.files) assert.ok(existsSync(join(root, f)), `${f} is in the manifest and not on disk`);
  assert.deepEqual(res.scenes.map((s) => s.image), ['video/short/scenes/01.jpg', 'video/short/scenes/02.jpg'],
    'the finished result still described the pictures as "(to draw)"');
});

/**
 * ⚠️⚠️ THE DURATIONS IN THE FINAL ARGV MUST BE MEASURED, NOT ESTIMATED. An
 * estimate is out by whatever the engine's real pace is; the drift is small on
 * scene 1 and a full sentence by scene 6, and no test that skips playback can
 * see it.
 */
test('⚠️⚠️ the scene durations come from the AUDIO, not from the estimate', async (t) => {
  const root = workspace(t);
  const p = producers({ seconds: 5 });   // five real seconds against a ~2s estimate
  let ran = null;
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p, detectImpl: haveFfmpeg, runImpl: (o) => { ran = o; return { ok: true }; },
  });
  assert.deepEqual(res.sceneSeconds, [5, 5]);
  assert.deepEqual(ran.argv.filter((a, i) => ran.argv[i - 1] === '-t'), ['5.000', '5.000']);
  assert.notEqual(res.ffmpeg.argv[3], String(res.scenes[0].estimatedSeconds));
});

test('⭐ burn mode adds a filter, not a subtitle input', async (t) => {
  const root = workspace(t);
  const p = producers();
  let ran = null;
  await viral(createLocalExecutor(root), { scenes: SCENES, captions: 'burn', [SPEND_APPROVAL_ARG]: true },
    { env: TTS_ENV, ...p, detectImpl: haveFfmpeg, runImpl: (o) => { ran = o; return { ok: true }; } });
  const graph = ran.argv[ran.argv.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[vc\]subtitles=captions\.srt\[v\]/);
  assert.ok(!ran.argv.includes('-c:s'));
});

test('⚠️ an unknown caption mode is refused before anything is spent', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, captions: 'hardcoded' }, { env: TTS_ENV, ...p });
  assert.equal(res.ok, false);
  assert.match(res.error, /captions must be one of soft, burn, none/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE DEGRADE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ SPENDING THE GPU MONEY AND THEN RETURNING "install ffmpeg" WOULD BE THE
 * WORST OF BOTH. Every asset has to survive, and the command has to be printed.
 */
test('⚠️⚠️ with no ffmpeg every asset still ships, and the exact command is handed over', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root), { title: 'short', scenes: SCENES, [SPEND_APPROVAL_ARG]: true },
    { env: TTS_ENV, ...p, detectImpl: noFfmpeg });

  assert.equal(res.ok, true, res.error);
  assert.equal(res.video, null);
  assert.ok(existsSync(join(root, 'video/short/voice.wav')), 'the narration track must survive');
  assert.ok(existsSync(join(root, 'video/short/captions.srt')));
  assert.ok(existsSync(join(root, 'video/short/scenes/01.jpg')));
  assert.match(res.ffmpegNote, /not on this machine's PATH/);
  assert.match(res.ffmpegNote, /-filter_complex/, 'the command has to be in the message, not just in a field');
  assert.match(readFileSync(join(root, 'video/short/README.md'), 'utf8'), /winget install|brew install|apt install/);
});

test('⚠️ --no-run starts no process and says so; everything else is still produced', async (t) => {
  const root = workspace(t);
  const p = producers();
  let started = false;
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p, allowRun: false, detectImpl: haveFfmpeg, runImpl: () => { started = true; return { ok: true }; },
  });
  assert.equal(started, false);
  assert.equal(res.video, null);
  assert.match(res.ffmpegNote, /--no-run is in force/);
  assert.ok(existsSync(join(root, 'video/short/voice.wav')));
});

test('⚠️ a failed cut keeps the assets and reports ffmpeg\'s own diagnosis', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p, detectImpl: haveFfmpeg,
    runImpl: () => ({ ok: false, error: "ffmpeg exited 1:\n[AVFilter] No such filter: 'subtitles'" }),
  });
  assert.equal(res.ok, true, 'a failed mux must not throw away the assets that were paid for');
  assert.equal(res.video, null);
  assert.match(res.ffmpegNote, /No such filter: 'subtitles'/);
});

test('⚠️ a scene that fails to draw names the scene, and says what was already spent', async (t) => {
  const root = workspace(t);
  const p = producers();
  let n = 0;
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, [SPEND_APPROVAL_ARG]: true }, {
    env: TTS_ENV, ...p, detectImpl: noFfmpeg,
    imageImpl: async (a) => (++n === 2 ? { ok: false, error: 'both image providers failed' } : p.imageImpl(a)),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /scene 2: both image providers failed/);
  assert.equal(res.spent, true);
  assert.ok(res.produced.length >= 2);
});

test('⚠️ a described voice with no design endpoint warns and narrates anyway', async (t) => {
  /**
   * ── ⭐ THE ENV MOVED, THE CONTRACT DID NOT (2026-08-25) ────────────────────
   *
   * `TTS_ENV` is a bare secret. That used to mean "no design endpoint", because
   * `avatar.mjs` shipped no addresses; it now means design IS reachable, which
   * is exactly the fix — the five moat verbs were dark on every install outside
   * our own console directory. The downgrade path still exists for the
   * documented `MODAL_VOICE_DESIGN_URL=` opt-out, so the setup moves there
   * rather than the assertion being softened.
   */
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, voice: 'warm Australian woman', [SPEND_APPROVAL_ARG]: true },
    { env: { ...TTS_ENV, MODAL_VOICE_DESIGN_URL: '' }, ...p, detectImpl: noFfmpeg });
  assert.equal(res.narratedBy, 'speak');
  assert.match(res.warnings.join(' '), /MODAL_VOICE_DESIGN_URL/);
  assert.ok(p.calls.speech.every((c) => !c.designed));
});

test('⭐⭐ a bare secret now narrates through design_voice — the addresses ship', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, voice: 'warm Australian woman', [SPEND_APPROVAL_ARG]: true },
    { env: TTS_ENV, ...p, detectImpl: noFfmpeg });
  assert.equal(res.narratedBy, 'design_voice',
    'one credential must reach the designed voice — before this it took a URL that shipped to nobody');
});

test('⭐ a described voice routes to design_voice where it is reachable', async (t) => {
  const root = workspace(t);
  const p = producers();
  const res = await viral(createLocalExecutor(root), { scenes: SCENES, voice: 'warm Australian woman', [SPEND_APPROVAL_ARG]: true }, {
    env: { ...TTS_ENV, MODAL_VOICE_DESIGN_URL: 'https://example.invalid/design' },
    ...p, detectImpl: noFfmpeg,
  });
  assert.equal(res.narratedBy, 'design_voice');
  assert.ok(p.calls.speech.every((c) => c.designed));
  assert.deepEqual(res.warnings, []);
});

/**
 * ── ⚠️⚠️ THIS TEST USED TO DEMAND THE WRONG SENTENCE (rewritten 2026-08-31) ──
 *
 * It asserted the refusal named `ACUVO_MEDIA_SECRET` — one of OUR internal
 * Modal credentials. A paying customer cannot obtain it, so the test was pinning
 * a message that sent every customer to set a variable they could never usefully
 * set. `speakVia`'s note in `media.mjs` records the same defect for `--say` and
 * `--task-audio`, one level down.
 *
 * ⭐ AND `home` IS NAMED NOW, WHICH IT WAS NOT. With the gate account-aware,
 * leaving the home to chance means this assertion measures whoever is logged in
 * — it passed on a signed-out laptop and failed on a signed-in one.
 */
const NO_ACCOUNT_HOME = '/acuvo-viral-test-no-such-home';

test('⚠️ with no worker AND no account the verb refuses, naming the route a customer HAS', async (t) => {
  const root = workspace(t);
  const res = await viral(createLocalExecutor(root), { scenes: SCENES }, { env: {}, home: NO_ACCOUNT_HOME });
  assert.equal(res.ok, false);
  assert.match(res.error, /acuvo --login/);
  assert.match(res.error, /MODAL_TTS_URL/);
  assert.ok(!/ACUVO_MEDIA_SECRET|MODAL_VIDEO_SECRET/.test(res.error),
    'the refusal names one of OUR credentials, which a customer can never obtain');
});

/* ────────────────────────────────────────────────────────────────────────────
 * REGISTRATION
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ offered only where there is a speech service, and never on a single-shot turn', () => {
  // ⚠️ `home` NAMED IN EVERY CALL. The gate is account-aware since 2026-08-31,
  // so an unnamed home makes this assertion a question about the developer.
  const h = { home: NO_ACCOUNT_HOME };
  assert.deepEqual(viralToolNames({}, { maxRounds: 16, ...h }), []);
  assert.deepEqual(viralToolNames(TTS_ENV, { maxRounds: 1, ...h }), []);
  assert.deepEqual(viralToolNames(TTS_ENV, { maxRounds: 16, ...h }), ['viral']);
});

test('the schema states the spend handshake and that ffmpeg is optional', () => {
  const [s] = viralToolSchemas();
  assert.equal(s.function.name, 'viral');
  assert.match(s.function.description, new RegExp(SPEND_APPROVAL_ARG));
  assert.match(s.function.description, /ffmpeg is optional/);
  assert.deepEqual(s.function.parameters.required, ['scenes']);
});

test('the dispatcher refuses a name that is not this verb', async () => {
  const r = await runViralTool('podcast', {}, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown viral tool "podcast"/);
});
