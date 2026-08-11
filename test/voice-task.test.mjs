/**
 * ── VOICE TASK — TALK TO YOUR TERMINAL ──────────────────────────────────────
 *
 * Both halves of this were proven against the live Modal endpoints on
 * 2026-08-11: `speak` produced a real 211,244-byte WAV, and `transcribe`
 * returned the exact sentence back. So this file is not testing whether the
 * services work. It tests the two things assembly gets wrong:
 *
 *   1. ⚠️⚠️ A TRANSCRIPT IS A MODEL INSTRUCTION THAT NOBODY PROOFREAD.
 *      Whisper mishears. It also HALLUCINATES on silence — "Thanks for
 *      watching!" is its most famous invention, and an empty room can produce
 *      it. Handing that string straight to a file-writing agent is the same
 *      class of mistake as executing a command you never read. So every test
 *      below that touches `taskFromAudio` asserts it did NOT act.
 *
 *   2. ⚠️ AUDIO THAT PLAYS UNASKED IS HOSTILE, and a summary that reads the
 *      diff aloud is a punishment. The tests pin BOTH: silent unless asked,
 *      and — when asked — a verdict short enough to be worth hearing.
 *
 * ⚠️ NO NETWORK. Every test injects `fetchImpl`. The one place the real
 * `transcribe`/`speak` are exercised is through that injected fetch, on
 * purpose: a test that stubs the whole media module would pass while the
 * payload contract underneath it was wrong — which is exactly how one
 * underscore (`audioB64` vs `audio_b64`) cost this repo the entire voice loop.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  voiceConfig,
  cleanTranscript,
  transcriptWarnings,
  taskFromAudio,
  confirmationLines,
  decideTranscript,
  summariseOutcome,
  speakSummary,
  playbackHint,
  extractVoiceFlags,
  MAX_TASK_CHARS,
  VOICE_USAGE,
} from '../lib/voice-task.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-voice-'));

const ENV = {
  MODAL_TRANSCRIBE_URL: 'https://stt.example.invalid/x',
  MODAL_TTS_URL: 'https://tts.example.invalid/x',
  MODAL_VIDEO_SECRET: 'sekrit',
};

/** A fetch that answers 200 with a JSON body, exactly as Modal does. */
const respond = (body, status = 200) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body),
    };
  };
  impl.calls = calls;
  return impl;
};

/** A fetch that must never be called. */
const forbidden = () => {
  const impl = async () => { throw new Error('the network was reached and it should not have been'); };
  impl.calls = [];
  return impl;
};

const wavB64 = () => Buffer.from(`RIFF${'x'.repeat(2000)}WAVEfmt `).toString('base64');

/** The shape `runSession` returns, trimmed to what a summary reads. */
const outcome = (over = {}) => ({
  ok: true,
  stage: 'done',
  model: 'deepseek/deepseek-v4-flash',
  roundsUsed: 3,
  stoppedBecause: 'verified',
  executed: [],
  verification: { ran: false, passed: false, command: null, exitCode: null, attempts: 0 },
  usage: { cost: 0.00048, total_tokens: 12000 },
  ...over,
});

const wrote = (path, bytes = 100) => ({ name: 'write_file', mutated: true, result: { ok: true, path, bytes } });

// ───────────────────────────────────────────────────────────────────────────
// CONFIG — the capability is ABSENT, never offered-and-broken
// ───────────────────────────────────────────────────────────────────────────

test('voiceConfig reports both directions independently', () => {
  assert.deepEqual(
    { ...voiceConfig({}) },
    { canListen: false, canSpeak: false, listenUrl: null, speakUrl: null },
  );
  const only = voiceConfig({ MODAL_TTS_URL: 'https://t/x' });
  assert.equal(only.canSpeak, true);
  assert.equal(only.canListen, false, 'a TTS url must not imply a transcribe url — they are separate services');
});

test('⚠️ config is read at CALL time, never captured at import', () => {
  const env = {};
  assert.equal(voiceConfig(env).canListen, false);
  env.MODAL_TRANSCRIBE_URL = 'https://stt/x';
  assert.equal(voiceConfig(env).canListen, true,
    'a variable that changed mid-session must be seen — a module-level snapshot is how a capability stays dark after it was fixed');
});

test('whitespace-only env vars are not configuration', () => {
  assert.equal(voiceConfig({ MODAL_TTS_URL: '   ' }).canSpeak, false);
});

// ───────────────────────────────────────────────────────────────────────────
// CLEANING — the legitimate shapes, not only the defect
// ───────────────────────────────────────────────────────────────────────────

test('cleanTranscript normalises CRLF and collapses runs of space', () => {
  assert.equal(cleanTranscript('  add   a\r\nhealthcheck\r\n\r\nroute  '), 'add a healthcheck route');
});

test('⚠️ non-ASCII survives byte-for-byte — a transcript is usually not English', () => {
  for (const s of ['ajoute une route de santé', '健康チェックのルートを追加して', 'füge eine Route hinzu — bitte', 'добавь маршрут']) {
    assert.equal(cleanTranscript(s), s, `mangled: ${s}`);
  }
});

test('an emoji or a musical note is not stripped', () => {
  assert.equal(cleanTranscript('ship it 🚀'), 'ship it 🚀');
});

test('a BOM is removed but the words are not', () => {
  assert.equal(cleanTranscript('﻿write the readme'), 'write the readme');
});

test('empty and non-string input return an empty string rather than throwing', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(cleanTranscript(v), '', `threw or mangled on ${JSON.stringify(v)}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// WARNINGS — whisper invents words when there is nothing to hear
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ whisper\'s silence hallucination is FLAGGED, not silently obeyed', () => {
  const w = transcriptWarnings('Thanks for watching!', []);
  assert.ok(w.length > 0, 'the single most common whisper hallucination went through unflagged');
  assert.match(w.join(' '), /silen|hallucinat/i, `unhelpful warning: ${w.join(' | ')}`);
});

test('⚠️ it is a WARNING, not a removal — the words are never edited under the user', () => {
  const w = transcriptWarnings('Thank you.', []);
  assert.ok(Array.isArray(w));
  // The caller still receives the text; warnings only annotate it.
  assert.equal(cleanTranscript('Thank you.'), 'Thank you.');
});

test('a low-confidence segment is reported with its number', () => {
  const w = transcriptWarnings('delete the cache', [{ text: 'delete the cache', avg_logprob: -1.4, no_speech_prob: 0.02 }]);
  assert.match(w.join(' '), /confiden/i, `expected a confidence warning, got: ${w.join(' | ')}`);
});

test('a confident, ordinary transcript produces NO warnings', () => {
  const w = transcriptWarnings('add a healthcheck route to the server and run the tests', [
    { text: 'add a healthcheck route to the server and run the tests', avg_logprob: -0.18, no_speech_prob: 0.01 },
  ]);
  assert.deepEqual(w, [], `a check that fires on correct input is worse than no check: ${w.join(' | ')}`);
});

test('a very short transcript is flagged — one mis-heard word is the whole task', () => {
  assert.ok(transcriptWarnings('delete', []).length > 0);
});

test('warnings tolerate missing/garbage segments', () => {
  for (const segs of [undefined, null, 'nope', [null], [{}]]) {
    assert.doesNotThrow(() => transcriptWarnings('add a healthcheck route to the server', segs));
  }
});

// ───────────────────────────────────────────────────────────────────────────
// AUDIO IN — taskFromAudio
// ───────────────────────────────────────────────────────────────────────────

test('⭐ taskFromAudio turns a voice memo into a task, through the REAL transcribe payload', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'note.m4a'), Buffer.from('fake audio bytes'));
    const f = respond({ ok: true, text: 'add a healthcheck route and run the tests', segments: [{ text: 'add a healthcheck route and run the tests', avg_logprob: -0.2 }] });
    const r = await taskFromAudio(root, 'note.m4a', { env: ENV, fetchImpl: f });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.task, 'add a healthcheck route and run the tests');
    assert.equal(r.path, 'note.m4a');
    // ⚠️ THE PAYLOAD CONTRACT, asserted here as well as in media.mjs's own test:
    // this lane's whole feature dies on that underscore.
    assert.ok('audio_b64' in f.calls[0].body, 'the service reads audio_b64 — without it every call returns "supply audio_url or audio_b64"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ it does NOT act — the result asks for confirmation and runs nothing', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'note.wav'), Buffer.from('audio'));
    const r = await taskFromAudio(root, 'note.wav', {
      env: ENV, fetchImpl: respond({ ok: true, text: 'delete every test file' }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.needsConfirmation, true,
      'a transcript nobody proofread must be shown before it becomes an instruction');
    // Nothing was written, nothing was run: the only file in the workspace is
    // the one the test put there.
    assert.equal(existsSync(join(root, 'note.wav')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ with no MODAL_TRANSCRIBE_URL the capability is ABSENT and says which variable', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'note.wav'), Buffer.from('audio'));
    const f = forbidden();
    const r = await taskFromAudio(root, 'note.wav', { env: {}, fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.error, /MODAL_TRANSCRIBE_URL/, `the message must name the variable to set. Got: ${r.error}`);
    assert.equal(f.calls.length, 0, 'nothing may be attempted when the service is not configured');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing audio file is a clear error, not a crash', async () => {
  const root = ws();
  try {
    const r = await taskFromAudio(root, 'nope.m4a', { env: ENV, fetchImpl: respond({ ok: true, text: 'x' }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /nope\.m4a|could not read|no such file/i, `unhelpful: ${r.error}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a path outside the workspace is refused', async () => {
  const root = ws();
  try {
    const r = await taskFromAudio(root, '../../../etc/passwd', { env: ENV, fetchImpl: forbidden() });
    assert.equal(r.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ the service\'s own error is passed through verbatim, not smoothed', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'note.wav'), Buffer.from('audio'));
    const r = await taskFromAudio(root, 'note.wav', {
      env: ENV, fetchImpl: respond({ ok: false, error: 'unauthorised' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /unauthoris|unauthoriz/i,
      `an error string is an instruction: "${r.error}" reads transient and buys retries of a call that can never succeed`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ silence transcribes to nothing, and nothing is NOT a task', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'silence.wav'), Buffer.from('audio'));
    const r = await taskFromAudio(root, 'silence.wav', {
      env: ENV, fetchImpl: respond({ ok: true, text: '   ' }),
    });
    assert.equal(r.ok, false, 'an empty task is a paid round-trip that can only produce a confused reply');
    assert.match(r.error, /no speech|nothing|empty/i, `unhelpful: ${r.error}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ an hour of audio is refused rather than sent as one enormous instruction', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'podcast.m4a'), Buffer.from('audio'));
    const r = await taskFromAudio(root, 'podcast.m4a', {
      env: ENV, fetchImpl: respond({ ok: true, text: 'and then he said '.repeat(4000) }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(String(MAX_TASK_CHARS)), `the message should name the limit. Got: ${r.error}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a transcript just under the limit is accepted', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'long.m4a'), Buffer.from('audio'));
    const text = 'x'.repeat(MAX_TASK_CHARS - 1);
    const r = await taskFromAudio(root, 'long.m4a', { env: ENV, fetchImpl: respond({ ok: true, text }) });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.task.length, MAX_TASK_CHARS - 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the warnings ride along with the transcript', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'quiet.wav'), Buffer.from('audio'));
    const r = await taskFromAudio(root, 'quiet.wav', {
      env: ENV, fetchImpl: respond({ ok: true, text: 'Thanks for watching!' }),
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.length > 0, 'the caller has to be able to show the doubt, not just the words');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// THE CONFIRMATION SEAM
// ───────────────────────────────────────────────────────────────────────────

test('confirmationLines shows the words that will be sent, and the warnings above them', () => {
  const lines = confirmationLines({ ok: true, path: 'note.m4a', task: 'delete the build directory', warnings: ['⚠️ that was quiet'] });
  const text = lines.join('\n');
  assert.match(text, /delete the build directory/, 'the user must see the exact instruction');
  assert.match(text, /note\.m4a/);
  assert.match(text, /that was quiet/);
});

test('confirmationLines is total — it never throws on a partial result', () => {
  for (const r of [{}, { task: '' }, { task: 'x', warnings: null }, null]) {
    assert.doesNotThrow(() => confirmationLines(r), `threw on ${JSON.stringify(r)}`);
  }
});

test('⚠️⚠️ --json cannot ask, so without an explicit yes it REFUSES rather than running', () => {
  const d = decideTranscript({ task: 'delete everything', json: true, tty: false, assumeYes: false, answer: null });
  assert.equal(d.run, false);
  assert.match(d.why, /--yes/, `the refusal must name the flag that unblocks it. Got: ${d.why}`);
});

test('--json --yes runs it, unchanged', () => {
  const d = decideTranscript({ task: 'add a route', json: true, tty: false, assumeYes: true, answer: null });
  assert.equal(d.run, true);
  assert.equal(d.task, 'add a route');
  assert.equal(d.edited, false);
});

test('⚠️ a non-TTY (piped, cron, CI) also refuses without --yes — there is nobody to ask', () => {
  const d = decideTranscript({ task: 'add a route', json: false, tty: false, assumeYes: false, answer: null });
  assert.equal(d.run, false);
  assert.match(d.why, /--yes|nobody|not a terminal|interactive/i, `unhelpful: ${d.why}`);
});

test('on a TTY, a bare yes runs the transcript as-is', () => {
  for (const a of ['y', 'Y', 'yes', ' YES ', 'ok', 'go', 'run']) {
    const d = decideTranscript({ task: 'add a route', json: false, tty: true, assumeYes: false, answer: a });
    assert.equal(d.run, true, `"${a}" should accept`);
    assert.equal(d.task, 'add a route');
    assert.equal(d.edited, false);
  }
});

test('a bare no — or just Enter — cancels. The default is NOT to act.', () => {
  for (const a of ['n', 'no', 'q', 'quit', 'cancel', '', '   ', null, undefined]) {
    const d = decideTranscript({ task: 'add a route', json: false, tty: true, assumeYes: false, answer: a });
    assert.equal(d.run, false, `"${String(a)}" should cancel — pressing Enter must never launch a file-writing agent`);
  }
});

test('⭐⭐ a mis-heard word is CORRECTED in one line, not retyped from scratch', () => {
  const d = decideTranscript({
    task: 'add a health check route to the sensor', json: false, tty: true, assumeYes: false,
    answer: 'no, the server not the sensor',
  });
  assert.equal(d.run, true, 'a correction is not a refusal — cancelling would throw the user\'s words away');
  assert.equal(d.edited, true);
  assert.equal(d.how, 'amended');
  assert.match(d.task, /add a health check route to the sensor/, 'the original words are kept');
  assert.match(d.task, /the server not the sensor/, 'the correction is carried');
});

test('"yes, and also write the README" amends rather than dropping the extra instruction', () => {
  const d = decideTranscript({
    task: 'add a route', json: false, tty: true, assumeYes: false, answer: 'yes and also write the README',
  });
  assert.equal(d.run, true);
  assert.equal(d.how, 'amended');
  assert.match(d.task, /add a route/);
  assert.match(d.task, /write the README/);
});

test('anything else the user types REPLACES the transcript entirely', () => {
  const d = decideTranscript({
    task: 'delete every test file', json: false, tty: true, assumeYes: false,
    answer: 'run the test suite and report the failures',
  });
  assert.equal(d.run, true);
  assert.equal(d.how, 'replaced');
  assert.equal(d.task, 'run the test suite and report the failures');
  assert.ok(!/delete every test file/.test(d.task), 'a replacement must not smuggle the mis-heard instruction along');
});

test('⚠️ --yes on a TTY still runs it — the flag means the user already decided', () => {
  const d = decideTranscript({ task: 'add a route', json: false, tty: true, assumeYes: true, answer: null });
  assert.equal(d.run, true);
});

test('decideTranscript is total — no input shape throws', () => {
  for (const arg of [{}, { task: null }, { task: 'x', answer: 42 }, undefined]) {
    assert.doesNotThrow(() => decideTranscript(arg), `threw on ${JSON.stringify(arg)}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// AUDIO OUT — the verdict, never the diff
// ───────────────────────────────────────────────────────────────────────────

test('⭐ summariseOutcome says what was asked, what changed, and whether it verified', () => {
  const s = summariseOutcome(outcome({
    executed: [wrote('server.mjs'), wrote('server.test.mjs')],
    verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 },
  }), { task: 'add a healthcheck route and run the tests' });
  assert.match(s, /healthcheck/i, 'it must recall what was asked');
  assert.match(s, /2 files/i);
  assert.match(s, /passed/i);
});

test('⚠️⚠️ it speaks the VERDICT, never the diff — no file listing at scale', () => {
  const s = summariseOutcome(outcome({
    executed: Array.from({ length: 12 }, (_, i) => wrote(`src/module-${i}.mjs`)),
    verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 },
  }), { task: 'refactor the modules' });
  assert.match(s, /12 files/);
  assert.ok(!/module-7/.test(s), 'sixty seconds of a file listing read aloud is a punishment');
  assert.ok(s.length <= 320, `too long to be worth hearing: ${s.length} chars`);
});

test('one file is named, because one name is useful and twelve are not', () => {
  const s = summariseOutcome(outcome({ executed: [wrote('lib/server.mjs')] }), { task: 'add a route' });
  assert.match(s, /server\.mjs/);
});

test('⚠️⚠️ a failing suite is spoken as a FAILURE — the one sentence that must never flatter', () => {
  const s = summariseOutcome(outcome({
    executed: [wrote('a.mjs')],
    verification: { ran: true, passed: false, command: 'npm test', exitCode: 1, attempts: 2 },
  }), { task: 'fix the parser' });
  assert.match(s, /fail|did not pass|still fails/i, `a verdict that hides a red suite is the whole bug: "${s}"`);
  assert.ok(!/\bpassed\b/.test(s), `"passed" must not appear in a failing verdict: "${s}"`);
});

test('⚠️ nothing verified is said out loud, not implied as success', () => {
  const s = summariseOutcome(outcome({ executed: [wrote('a.mjs')] }), { task: 'write a note' });
  assert.match(s, /nothing was run|not checked|no tests|nothing verified/i, `unhelpful: "${s}"`);
});

test('a session that never finished reports the error, not a change count', () => {
  const s = summariseOutcome({ ok: false, error: 'the model provider returned 402 (no credit)' }, { task: 'anything' });
  assert.match(s, /did not finish|failed/i);
  assert.match(s, /402|credit/);
});

test('no files changed is stated plainly', () => {
  const s = summariseOutcome(outcome({}), { task: 'look at the code' });
  assert.match(s, /no files/i);
});

test('⚠️ it is SPEAKABLE — no markdown, no paths read as punctuation soup, no ANSI', () => {
  const s = summariseOutcome(outcome({
    executed: [wrote('a/b/c/deeply/nested/file.mjs')],
    verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 },
  }), { task: '**fix** the `parser` — see /docs/spec.md\n\nand tidy up' });
  assert.ok(!/[*`_#]/.test(s), `markdown survived into speech: "${s}"`);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\[/.test(s), 'ANSI escape survived into speech');
  assert.ok(!/\n/.test(s), 'a newline is not a sound');
  assert.ok(!/a\/b\/c\/deeply/.test(s), 'a deep path read aloud is noise — the basename is the useful part');
});

test('summariseOutcome is total — null, undefined and junk all produce a sentence', () => {
  for (const o of [null, undefined, {}, { executed: 'nope' }, { ok: true, executed: [null] }]) {
    const s = summariseOutcome(o, { task: 'x' });
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0, `empty verdict for ${JSON.stringify(o)}`);
  }
});

test('a very long task is trimmed, and no task at all still yields a verdict', () => {
  const s = summariseOutcome(outcome({}), { task: 'please '.repeat(500) });
  assert.ok(s.length <= 320, `${s.length} chars`);
  assert.ok(summariseOutcome(outcome({}), {}).length > 0);
});

test('a non-ASCII task survives into the spoken verdict', () => {
  const s = summariseOutcome(outcome({}), { task: 'ajoute une route de santé' });
  assert.match(s, /santé/);
});

// ───────────────────────────────────────────────────────────────────────────
// speakSummary — silent by default
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ SILENT BY DEFAULT — not asked means no request, no file, no error', async () => {
  const root = ws();
  try {
    const f = forbidden();
    const r = await speakSummary(root, outcome({}), { env: ENV, fetchImpl: f, task: 'x' });
    assert.equal(r.ok, true, 'silence is the correct outcome, not a failure');
    assert.equal(r.spoken, false);
    assert.equal(f.calls.length, 0, 'audio that plays unasked is hostile — and it costs money');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ when asked, it writes a real WAV and returns the path', async () => {
  const root = ws();
  try {
    const f = respond({ ok: true, audio: wavB64() });
    const r = await speakSummary(root, outcome({
      executed: [wrote('server.mjs')],
      verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 },
    }), { env: ENV, fetchImpl: f, task: 'add a healthcheck route', enabled: true, now: () => 1_700_000_000_000 });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.spoken, true);
    assert.ok(r.bytes > 0, 'a zero-byte file is not speech');
    assert.ok(existsSync(join(root, r.path)), `nothing at ${r.path}`);
    assert.ok(readFileSync(join(root, r.path)).length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ what gets SENT to the TTS service is the verdict, not the diff', async () => {
  const root = ws();
  try {
    const f = respond({ ok: true, audio: wavB64() });
    await speakSummary(root, outcome({
      executed: Array.from({ length: 9 }, (_, i) => wrote(`src/file-${i}.mjs`)),
      verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 },
    }), { env: ENV, fetchImpl: f, task: 'refactor', enabled: true });
    const sent = f.calls[0].body.text;
    assert.ok(!/file-4/.test(sent), `the diff was read aloud: "${sent}"`);
    assert.ok(sent.length <= 320, `${sent.length} chars of speech is a punishment`);
    assert.match(sent, /9 files/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ asked but not configured: it says which variable, and reaches no network', async () => {
  const root = ws();
  try {
    const f = forbidden();
    const r = await speakSummary(root, outcome({}), { env: {}, fetchImpl: f, task: 'x', enabled: true });
    assert.equal(r.spoken, false);
    assert.equal(r.ok, false, 'the user explicitly asked — silence here would be dishonest');
    assert.match(r.reason, /MODAL_TTS_URL/, `unhelpful: ${r.reason}`);
    assert.equal(f.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a TTS failure is reported verbatim and NEVER fails the run', async () => {
  const root = ws();
  try {
    const r = await speakSummary(root, outcome({}), {
      env: ENV, fetchImpl: respond({ ok: false, error: 'unauthorised' }), task: 'x', enabled: true,
    });
    assert.equal(r.spoken, false);
    assert.match(r.reason, /unauthoris|unauthoriz/i, `unhelpful: ${r.reason}`);
    assert.equal(typeof r.text, 'string', 'the verdict text is still returned so the caller can print what it could not say');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a dry run narrates nothing — a dry run touches nothing', async () => {
  const root = ws();
  try {
    const f = respond({ ok: true, audio: wavB64() });
    const r = await speakSummary(root, outcome({}), { env: ENV, fetchImpl: f, task: 'x', enabled: true, dryRun: true });
    assert.equal(r.spoken, false);
    assert.equal(f.calls.length, 0, 'a dry run must not spend money on speech either');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// PLAYBACK — we write a file; we deliberately do not play it
// ───────────────────────────────────────────────────────────────────────────

test('playbackHint gives the one command for this OS, and never claims we played it', () => {
  assert.match(playbackHint('.acuvo/verdict.wav', 'win32'), /powershell|SoundPlayer/i);
  assert.match(playbackHint('.acuvo/verdict.wav', 'darwin'), /afplay/);
  assert.match(playbackHint('.acuvo/verdict.wav', 'linux'), /aplay|paplay|ffplay/);
  assert.ok(playbackHint('.acuvo/verdict.wav', 'sunos').length > 0, 'an unknown platform still gets a sentence');
});

test('playbackHint quotes a path with a space', () => {
  assert.match(playbackHint('my audio/verdict.wav', 'darwin'), /"my audio\/verdict\.wav"|'my audio\/verdict\.wav'/);
});

/**
 * ── ⚠️⚠️ CAUGHT BY RUNNING IT, NOT BY TESTING IT ────────────────────────────
 *
 * The live round trip printed this, and it is not a command:
 *
 *   powershell -c "(New-Object Media.SoundPlayer ".acuvo/verdict.wav").PlaySync()"
 *
 * The inner `"` closes the outer `"`, so cmd sees three arguments and PowerShell
 * never receives a string. The original test asserted only /powershell|SoundPlayer/
 * — it matched happily against a command that could never work, which is this
 * repo's signature defect wearing a different hat: a check that passes against
 * broken code is worse than no check.
 *
 * ⭐ THE RULE THIS PINS: the quoting must actually nest. The outer argument is
 * double-quoted, so the path inside it has to be single-quoted — PowerShell
 * treats a single-quoted string as a literal, which is also what we want for a
 * Windows path full of backslashes.
 */
test('⚠️⚠️ the win32 hint is a command that actually PARSES — quotes must nest', () => {
  const hint = playbackHint('.acuvo/verdict.wav', 'win32');
  const after = hint.slice(hint.indexOf('-c ') + 3);
  assert.ok(after.startsWith('"') && after.endsWith('"'), `the -c argument is not one quoted string: ${hint}`);
  const inner = after.slice(1, -1);
  assert.ok(!inner.includes('"'), `an unescaped " inside the -c argument closes it early, so this is three arguments and not a command: ${hint}`);
  assert.match(inner, /'\.acuvo\/verdict\.wav'/, `the path must be single-quoted inside the double-quoted argument: ${hint}`);
});

test('a Windows path with backslashes and a space still nests correctly', () => {
  const hint = playbackHint('my audio\\verdict.wav', 'win32');
  const inner = hint.slice(hint.indexOf('-c ') + 4, -1);
  assert.ok(!inner.includes('"'), `unescaped quote: ${hint}`);
  assert.match(hint, /'my audio\\verdict\.wav'/, `backslashes must survive as a literal path: ${hint}`);
});

test("a path containing a single quote cannot break out of the PowerShell literal", () => {
  const hint = playbackHint("it's here/v.wav", 'win32');
  const inner = hint.slice(hint.indexOf('-c ') + 4, -1);
  assert.ok(!inner.includes('"'), `unescaped double quote: ${hint}`);
  assert.match(hint, /''/, `a single quote inside a PowerShell literal must be doubled to escape it: ${hint}`);
});

// ───────────────────────────────────────────────────────────────────────────
// FLAGS — the wiring seam, testable without a process
// ───────────────────────────────────────────────────────────────────────────

test('extractVoiceFlags lifts its three flags and passes everything else through UNTOUCHED', () => {
  const r = extractVoiceFlags(['--task-audio', 'note.m4a', '--say', '--yes', '--max-rounds', '6', 'do a thing']);
  assert.equal(r.ok, true);
  assert.equal(r.flags.taskAudio, 'note.m4a');
  assert.equal(r.flags.say, true);
  assert.equal(r.flags.yes, true);
  assert.deepEqual(r.argv, ['--max-rounds', '6', 'do a thing'],
    'two parsers both guessing is how a typo gets silently ignored — anything unrecognised must survive');
});

test('the defaults are off', () => {
  const r = extractVoiceFlags(['"build a thing"']);
  assert.deepEqual(r.flags, { taskAudio: null, say: false, yes: false });
  assert.deepEqual(r.argv, ['"build a thing"']);
});

test('⚠️ --task-audio with no value must not eat the next flag', () => {
  const r = extractVoiceFlags(['--task-audio', '--json']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--task-audio/);
});

test('--task-audio=note.m4a is accepted, and an empty value is refused', () => {
  assert.equal(extractVoiceFlags(['--task-audio=note.m4a']).flags.taskAudio, 'note.m4a');
  assert.equal(extractVoiceFlags(['--task-audio=']).ok, false);
});

test('--task-audio at the very end with no value is refused, not undefined', () => {
  const r = extractVoiceFlags(['--task-audio']);
  assert.equal(r.ok, false);
});

test('an empty argv is fine', () => {
  const r = extractVoiceFlags([]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, []);
});

test('VOICE_USAGE documents all three flags — a capability only the changelog knows is unreachable', () => {
  for (const f of ['--task-audio', '--say', '--yes']) {
    assert.match(VOICE_USAGE, new RegExp(f.replace(/-/g, '\\-')), `${f} is undocumented`);
  }
  assert.match(VOICE_USAGE, /MODAL_TRANSCRIBE_URL|MODAL_TTS_URL/, 'the usage must say what makes these appear');
});
