/**
 * ── ⚠️⚠️ THE ARGV IS THE CONTRACT, SO THE ARGV IS WHAT IS ASSERTED ──────────
 *
 * Nothing in this file generates anything. There is no TTS call, no render, no
 * ffmpeg process and no network — every producer is mocked and the ffmpeg legs
 * are pure functions returning a string array. That is not a limitation of the
 * test: it is the shape of the code being tested. `viral` and `podcast` exist to
 * ASSEMBLE, and the assembly is where they break.
 *
 * ⭐ AND A WRONG ffmpeg FLAG IS THE LIKELIEST DEFECT. Two of them are silent —
 * `-t` after `-i` instead of before it produces a one-scene video, and
 * exponential notation in a duration makes ffmpeg read `1e-7` as one second.
 * Neither throws, both are invisible without playing the file, and both are
 * pinned below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readWavInfo, buildWavHeader, concatWav, silenceOf, WAV_PCM_FORMAT,
  detectFfmpeg, runFfmpeg, ffmpegInstallHint, FFMPEG_BIN_ENV,
  slideshowArgv, audioEncodeArgv, formatSeconds, ASPECTS, DEFAULT_ASPECT,
  srtTime, toSrt, estimateSpeechSeconds, estimateSpend, spendGate, SPEND_APPROVAL_ARG, MAX_SEGMENT_SECONDS,
  writeWorkspaceBinary, readWorkspaceBinary,
} from '../lib/media-pipeline.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * FIXTURES — real WAV bytes, built here, so nothing is downloaded or recorded
 * ──────────────────────────────────────────────────────────────────────────── */

/** A PCM WAV of `seconds` of a constant value. Real bytes, real header. */
function wavFixture(seconds, { sampleRate = 24_000, channels = 1, bitsPerSample = 16, fill = 7 } = {}) {
  const blockAlign = channels * (bitsPerSample / 8);
  const body = Buffer.alloc(Math.round(seconds * sampleRate) * blockAlign, fill);
  return Buffer.concat([buildWavHeader({ sampleRate, channels, bitsPerSample, dataBytes: body.length }), body]);
}

test('⭐ a WAV built here reads back with the numbers it was built from', () => {
  const buf = wavFixture(1.5);
  const info = readWavInfo(buf);
  assert.equal(info.ok, true, info.error);
  assert.equal(info.sampleRate, 24_000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataOffset, 44);
  assert.equal(Number(info.seconds.toFixed(3)), 1.5);
});

/**
 * ⚠️ THE REGRESSION THIS FUNCTION EXISTS FOR. Slicing at a hard-coded 44 bytes
 * works on the file you tested with and silently truncates the next one — and
 * `LIST`/`fact` chunks between `fmt ` and `data` are emitted by real encoders,
 * including ffmpeg's own.
 */
test('⚠️⭐ a WAV with an extra chunk before `data` is still read correctly', () => {
  const plain = wavFixture(0.5);
  const info = readWavInfo(plain);
  const head = plain.subarray(0, info.dataOffset - 8);          // RIFF + fmt
  const body = plain.subarray(info.dataOffset - 8);              // 'data' + size + payload

  // A 6-byte LIST chunk (odd payload ⇒ one pad byte), inserted between them.
  const extra = Buffer.alloc(8 + 6);
  extra.write('LIST', 0, 'ascii');
  extra.writeUInt32LE(5, 4);
  const spliced = Buffer.concat([head, extra, body]);
  spliced.writeUInt32LE(spliced.length - 8, 4);

  const got = readWavInfo(spliced);
  assert.equal(got.ok, true, got.error);
  assert.equal(got.dataBytes, info.dataBytes, 'the payload was truncated by the extra chunk');
  assert.equal(got.dataOffset, info.dataOffset + extra.length);
});

test('⚠️ a non-PCM WAV is refused by name rather than joined into noise', () => {
  const buf = wavFixture(0.2);
  buf.writeUInt16LE(3, 20);   // IEEE float, not PCM
  const info = readWavInfo(buf);
  assert.equal(info.ok, false);
  assert.match(info.error, /not uncompressed PCM \(format 3\)/);
  assert.match(info.error, /ffmpeg/, 'the refusal must name the way out');
});

test('⚠️ a truncated file does not report more audio than it holds', () => {
  const buf = wavFixture(2).subarray(0, 44 + 1000);
  const info = readWavInfo(buf);
  assert.equal(info.ok, true, info.error);
  assert.equal(info.dataBytes, 1000, 'it believed the header over the file');
});

test('⭐ joining WAVs adds their lengths, and the timeline is the caption clock', () => {
  const joined = concatWav([
    { buf: wavFixture(1), label: 'a' },
    { buf: wavFixture(2), label: 'b', gapSeconds: 0.5 },
  ]);
  assert.equal(joined.ok, true, joined.error);
  assert.equal(Number(joined.seconds.toFixed(3)), 3.5);
  assert.equal(readWavInfo(joined.buffer).ok, true);
  assert.deepEqual(
    joined.timeline.map((t) => [t.label, Number(t.start.toFixed(2)), Number(t.end.toFixed(2))]),
    [['a', 0, 1], ['b', 1.5, 3.5]],
    'the second segment must start AFTER the gap, or every caption after it is early',
  );
});

test('⚠️ the leading gap of the first segment is not inserted', () => {
  const joined = concatWav([{ buf: wavFixture(1), label: 'a', gapSeconds: 5 }]);
  assert.equal(Number(joined.seconds.toFixed(3)), 1, 'silence was prepended that the plan never promised');
});

test('⚠️⭐ a sample-rate mismatch is REFUSED, not silently played at the wrong speed', () => {
  const joined = concatWav([
    { buf: wavFixture(1), label: 'line 1' },
    { buf: wavFixture(1, { sampleRate: 48_000 }), label: 'line 2' },
  ]);
  assert.equal(joined.ok, false);
  assert.match(joined.error, /line 2 is 48000Hz.*episode is 24000Hz/);
});

test('silence is the right number of bytes for the format it joins', () => {
  assert.equal(silenceOf(1, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 }).length, 48_000);
  assert.equal(silenceOf(0.5, { sampleRate: 8_000, channels: 2, bitsPerSample: 8 }).length, 8_000);
});

test('the header we write says PCM, and says it in the field readers look at', () => {
  const head = buildWavHeader({ sampleRate: 24_000, channels: 1, bitsPerSample: 16, dataBytes: 100 });
  assert.equal(head.readUInt16LE(20), WAV_PCM_FORMAT);
  assert.equal(head.readUInt32LE(4), 136, 'RIFF size must be dataBytes + 36');
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE ARGV
 * ──────────────────────────────────────────────────────────────────────────── */

const twoScenes = [{ file: '01.png', seconds: 3.5 }, { file: '02.jpg', seconds: 4.25 }];

test('⚠️⚠️ `-t` comes BEFORE `-i`, or the video is one scene long', () => {
  const argv = slideshowArgv({ scenes: twoScenes, audio: 'voice.wav', captions: null, out: 'x.mp4' });
  const i = argv.indexOf('-i');
  assert.equal(argv[i - 2], '-t', 'the duration must bound the INPUT; after -i it trims the OUTPUT');
  assert.equal(argv[i - 4], '-loop', 'a still needs -loop 1 or it contributes a single frame');
  assert.equal(argv[i - 1], '3.500');
});

test('⚠️ every scene gets its own input leg, so mixed png/jpg cannot break the mux', () => {
  const argv = slideshowArgv({ scenes: twoScenes, audio: 'voice.wav', captions: null, out: 'x.mp4' });
  assert.equal(argv.filter((a) => a === '-loop').length, 2);
  assert.ok(argv.includes('01.png') && argv.includes('02.jpg'));
  assert.ok(!argv.includes('-f'), 'the concat DEMUXER would require one codec for every scene');
});

test('⭐ the filter graph scales, pads, squares the pixels and concatenates in order', () => {
  const { width, height } = ASPECTS[DEFAULT_ASPECT];
  const argv = slideshowArgv({ scenes: twoScenes, audio: 'voice.wav', captions: null, out: 'x.mp4' });
  const graph = argv[argv.indexOf('-filter_complex') + 1];
  assert.ok(graph.startsWith(`[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease`));
  assert.match(graph, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black/);
  assert.match(graph, /setsar=1/, 'a non-square SAR makes concat refuse the join outright');
  assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vc\]/);
});

test('⭐ soft captions become a real mov_text track; the audio map points at the right input', () => {
  const argv = slideshowArgv({ scenes: twoScenes, audio: 'voice.wav', captions: 'captions.srt', out: 'x.mp4', captionMode: 'soft' });
  // 2 scenes ⇒ audio is input 2, captions input 3.
  assert.deepEqual(argv.slice(argv.indexOf('-map')), [
    '-map', '[v]', '-map', '2:a:0', '-map', '3:s:0', '-c:s', 'mov_text',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'x.mp4',
  ]);
});

test('⚠️ burned captions are applied AFTER the scale, and add no subtitle INPUT', () => {
  const argv = slideshowArgv({ scenes: twoScenes, audio: 'voice.wav', captions: 'captions.srt', out: 'x.mp4', captionMode: 'burn' });
  const graph = argv[argv.indexOf('-filter_complex') + 1];
  assert.match(graph, /concat=n=2:v=1:a=0\[vc\];\[vc\]subtitles=captions\.srt\[v\]/);
  assert.ok(!argv.includes('-c:s'), 'burning must not also mux a soft track');
  assert.equal(argv.filter((a) => a === '-i').length, 3, 'burn mode takes the srt as a FILTER, not as an input');
});

test('captions: none produces neither a track nor a filter', () => {
  const argv = slideshowArgv({ scenes: twoScenes, audio: 'voice.wav', captions: null, out: 'x.mp4', captionMode: 'none' });
  assert.ok(!argv.join(' ').includes('subtitles='));
  assert.ok(!argv.includes('-c:s'));
});

/**
 * ⚠️ `String(0.0000001)` is `"1e-7"`, and ffmpeg parses that as ONE SECOND — it
 * stops reading at the `e`. A scene that should flash becomes a second long and
 * every caption after it is out of sync.
 */
test('⚠️⚠️ a duration is never written in exponential notation', () => {
  assert.equal(formatSeconds(0.0000001), '0.000');
  assert.equal(formatSeconds(-3), '0.000');
  assert.equal(formatSeconds(undefined), '0.000');
  assert.equal(formatSeconds(Infinity), '0.000');
  /**
   * ⚠️ THE HIGH END TOO, AND THIS ONE WAS A REAL BUG THIS ASSERTION FOUND:
   * `toFixed` returns exponential notation at and above 1e21 no matter how many
   * digits it is asked for, so the low-side guard alone left the same defect
   * open at the other end. It is now clamped.
   */
  assert.equal(formatSeconds(1e21), `${MAX_SEGMENT_SECONDS}.000`);
  for (const n of [0.0000001, 1e21, 1e30, 3.5]) assert.ok(!formatSeconds(n).includes('e'), `${n} rendered exponentially`);
});

test('the audio conversion argv names the codec and the output', () => {
  assert.deepEqual(
    audioEncodeArgv({ input: 'episode.wav', out: 'episode.mp3', codec: 'libmp3lame' }),
    ['-y', '-i', 'episode.wav', '-c:a', 'libmp3lame', '-b:a', '128k', 'episode.mp3'],
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * SRT
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️ SRT timestamps use a COMMA, and pad every field', () => {
  assert.equal(srtTime(0), '00:00:00,000');
  assert.equal(srtTime(3661.5), '01:01:01,500');
  assert.equal(srtTime(-1), '00:00:00,000');
  const srt = toSrt([{ start: 0, end: 1.25, text: 'one' }, { start: 1.25, end: 3, text: 'two' }]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,250\none\n\n2\n00:00:01,250 --> 00:00:03,000\ntwo\n');
});

/* ────────────────────────────────────────────────────────────────────────────
 * ffmpeg DETECTION — and the degrade
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ ffmpeg is detected by RUNNING it, not by looking for a filename', () => {
  const calls = [];
  const got = detectFfmpeg({
    env: {},
    spawnImpl: (bin, argv, opts) => { calls.push([bin, argv, opts]); return { status: 0, stdout: 'ffmpeg version 7.1 Copyright…' }; },
  });
  assert.equal(got.ok, true);
  assert.deepEqual(calls[0][0], 'ffmpeg');
  assert.deepEqual(calls[0][1], ['-version'], 'a name on PATH that will not execute is the case this catches');
  assert.match(got.version, /^ffmpeg version 7\.1/);
});

test('⚠️ a missing ffmpeg names the platform install command, and never throws', () => {
  const got = detectFfmpeg({ env: {}, spawnImpl: () => ({ error: { code: 'ENOENT' }, status: null }), platform: 'darwin' });
  assert.equal(got.ok, false);
  assert.match(got.reason, /is not on this machine's PATH/);
  assert.match(got.reason, /brew install ffmpeg/);
  assert.match(got.reason, new RegExp(FFMPEG_BIN_ENV), 'the override must be discoverable from the failure');
});

test('⚠️ "installed but broken" and "not installed" are DIFFERENT sentences', () => {
  const broken = detectFfmpeg({ env: {}, spawnImpl: () => ({ status: 1, stdout: '', stderr: 'illegal instruction' }) });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /exited 1, so this build is not usable/);

  const unrunnable = detectFfmpeg({ env: {}, spawnImpl: () => ({ error: { code: 'EACCES' }, status: null }) });
  assert.match(unrunnable.reason, /could not be run \(EACCES\)/);
});

test(`⭐ ${FFMPEG_BIN_ENV} points at a build that is not on PATH`, () => {
  const seen = [];
  const got = detectFfmpeg({ env: { [FFMPEG_BIN_ENV]: '/opt/ff/bin/ffmpeg' }, spawnImpl: (bin) => { seen.push(bin); return { status: 0, stdout: 'ffmpeg version n7' }; } });
  assert.equal(got.bin, '/opt/ff/bin/ffmpeg');
  assert.deepEqual(seen, ['/opt/ff/bin/ffmpeg']);
});

test('every platform gets an install line somebody can paste', () => {
  assert.match(ffmpegInstallHint('win32'), /winget install/);
  assert.match(ffmpegInstallHint('darwin'), /brew install/);
  assert.match(ffmpegInstallHint('linux'), /apt install/);
});

test('⚠️ a non-zero ffmpeg exit reports the TAIL of stderr, not just the number', () => {
  const ran = runFfmpeg({
    bin: 'ffmpeg', argv: ['-y'], cwd: '/tmp',
    spawnImpl: () => ({ status: 1, stderr: 'noise\nmore noise\n[AVFilter] No such filter: \'subtitles\'\n' }),
  });
  assert.equal(ran.ok, false);
  assert.match(ran.error, /No such filter: 'subtitles'/, 'the one actionable line was discarded');
});

test('runFfmpeg passes the cwd through — every path in the argv is a bare filename', () => {
  let opts = null;
  runFfmpeg({ bin: 'ffmpeg', argv: ['-y', 'out.mp4'], cwd: '/w/video/short', spawnImpl: (b, a, o) => { opts = o; return { status: 0, stderr: '' }; } });
  assert.equal(opts.cwd, '/w/video/short');
  assert.equal(opts.windowsHide, true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE PRICE, AND THE GATE
 * ──────────────────────────────────────────────────────────────────────────── */

test('speech seconds scale with the text, with a floor for a two-word line', () => {
  assert.ok(estimateSpeechSeconds('a'.repeat(1375)) > 99);
  assert.equal(estimateSpeechSeconds('hi'), 1, 'a short line still pays a minimum');
  assert.equal(estimateSpeechSeconds(''), 1);
});

test('⭐ the first call is priced cold and the rest warm — the ledger\'s own rule', () => {
  const one = estimateSpend({ speakSeconds: [10], env: {} });
  const two = estimateSpend({ speakSeconds: [10, 10], env: {} });
  assert.ok(two.usd > one.usd, 'a second call must cost something');
  assert.ok(two.usd < one.usd * 2, 'a second call must NOT re-pay the cold start');
  assert.match(one.basis, /not a quote/, 'an estimate presented as a figure is how this repo has been wrong four times');
});

/**
 * ⚠️⚠️ THE FREE CHAIN IS FREE, AND SAYING OTHERWISE TEACHES A USER TO AVOID A
 * CAPABILITY THAT COSTS NOTHING. `generateThroughProviders` only reaches our own
 * GPU when the engine URL AND a secret are both present; otherwise Perchance and
 * Pollinations answer and neither bills us.
 */
test('⭐ images are priced at zero when the free chain will serve them', () => {
  const free = estimateSpend({ speakSeconds: [], imageCount: 4, env: {} });
  assert.equal(free.usd, 0);
  assert.equal(free.imagesAreCharged, false);
  assert.match(free.lines.join(' '), /free chain/);

  const paid = estimateSpend({ speakSeconds: [], imageCount: 4, env: { ACUVO_IMAGE_ENGINE_URL: 'https://x.invalid', ACUVO_IMAGE_SECRET: 's' } });
  assert.ok(paid.usd > 0);
  assert.equal(paid.imagesAreCharged, true);
});

test('⚠️⚠️ nothing runs until the caller has been shown the price', () => {
  const held = spendGate({ approved: false, estimateUsd: 0.2, verb: 'viral' });
  assert.equal(held.go, false);
  assert.match(held.why, new RegExp(SPEND_APPROVAL_ARG));
  assert.match(held.why, /identical arguments/);
  assert.equal(spendGate({ approved: true, estimateUsd: 0.2 }).go, true);
});

test('⚠️ a --dry-run does not spend even when approved', () => {
  const held = spendGate({ approved: true, dryRun: true, estimateUsd: 0.2 });
  assert.equal(held.go, false);
  assert.match(held.why, /--dry-run/);
});

test('⭐ --budget is arithmetic, and "no budget" is not a refusal', () => {
  const over = spendGate({ approved: true, estimateUsd: 0.5, budget: { canContinue: () => ({ remainingUsd: 0.1 }) } });
  assert.equal(over.go, false);
  assert.equal(over.overBudget, true);
  assert.match(over.why, /\$0\.5000.*\$0\.1000/);

  assert.equal(spendGate({ approved: true, estimateUsd: 0.5, budget: null }).go, true, 'no budget object must not read as zero');
  assert.equal(
    spendGate({ approved: true, estimateUsd: 0.5, budget: { canContinue: () => ({ remainingUsd: Infinity }) } }).go,
    true,
    '--budget none must not be refused',
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE WORKSPACE, FOR BYTES
 * ──────────────────────────────────────────────────────────────────────────── */

test('bytes go in and come out through the workspace rules, and --dry-run writes nothing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const wrote = writeWorkspaceBinary(root, 'a/b/one.wav', wavFixture(0.25), false);
  assert.equal(wrote.ok, true, wrote.error);
  assert.equal(readFileSync(wrote.absolute).length, wrote.bytes);
  assert.equal(readWorkspaceBinary(root, 'a/b/one.wav').buf.length, wrote.bytes);

  const dry = writeWorkspaceBinary(root, 'a/b/two.wav', wavFixture(0.25), true);
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(readWorkspaceBinary(root, 'a/b/two.wav').ok, false, 'a dry run left a file behind');

  const escape = writeWorkspaceBinary(root, '../outside.wav', Buffer.from('x'), false);
  assert.equal(escape.ok, false, 'bytes must not reach anywhere write_file could not');
});
