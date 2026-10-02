/**
 * ── 🚪⭐⭐⭐ `--say` AND `--task-audio` WERE DEAD FOR EVERY PAYING USER ───────
 *
 * MEASURED 2026-08-26, and it is `--design`'s bug repeating twice in the same
 * file. `mediaConfig()` hands out a baked-in `DEFAULT_TTS_URL` and
 * `DEFAULT_TRANSCRIBE_URL` — so the two capabilities LOOK configured — and then
 * gates both on `secret`, which resolves only from `ACUVO_MEDIA_SECRET` or
 * `MODAL_VIDEO_SECRET`. Those are OUR internal Modal credentials.
 *
 * So for a customer with a paid plan and no such variable:
 *   voiceConfig({}).canSpeak   === false
 *   voiceConfig({}).canListen  === false
 * and both flags printed a message naming an environment variable that would
 * never help them.
 *
 * ⭐ The capability was never missing; the door was. `<gateway>/speak` and
 * `<gateway>/transcribe` now exist beside `/render` and `/engines`, and the
 * shared Modal secret never leaves the server.
 *
 * ── ⚠️⚠️ AN ISOLATED HOME ON EVERY CASE, AND THE REASON IS A REAL LEAK ──────
 *
 * `render-reaches-the-customer.test.mjs` records it: a version of these tests
 * that passed only an `env` let `readAccount` fall through to
 * `~/.acuvo/credentials.json`, read the REAL account, and printed a live
 * `xxi_live_…` token into node's failure output. Test output goes into CI logs
 * and pasted terminal dumps.
 *
 * ⭐ It also makes the tests mean what they say: "a signed-in account" is a fact
 * these tests CREATE, not one inherited from whoever happens to be logged in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  speakVia, transcribeVia, speak, transcribe, mediaConfig,
  MAX_GATEWAY_TRANSCRIBE_BYTES,
} from '../lib/media.mjs';
import { speakEndpoint, transcribeEndpoint, renderEndpoint, enginesEndpoint } from '../lib/creative-engines.mjs';
import { voiceConfig, taskFromAudio, speakSummary } from '../lib/voice-task.mjs';

const GATEWAY = 'https://acuvo.xxiautomate.com/api/cli/v1/chat/completions';

function homeWith(credentials) {
  const home = mkdtempSync(join(tmpdir(), 'acuvo-voice-test-'));
  if (credentials) {
    mkdirSync(join(home, '.acuvo'), { recursive: true });
    writeFileSync(join(home, '.acuvo', 'credentials.json'), JSON.stringify(credentials));
  }
  return home;
}

const signedIn = () => homeWith({ token: 'xxi_live_test', gatewayUrl: GATEWAY });

/** A fetch that records what it was given and answers like the live worker. */
function recorder(payload) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body), headers: init.headers ?? {} });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(payload),
    };
  };
  return { calls, impl };
}

// ───────────────────────────────────────────────────────────────────────────
// THE DERIVATION — four doors, one host
// ───────────────────────────────────────────────────────────────────────────

test('⭐ the speak and transcribe endpoints are derived exactly as render and engines are', () => {
  assert.equal(speakEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/speak');
  assert.equal(transcribeEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/transcribe');
  /**
   * ⚠️ PINNED TOGETHER ON PURPOSE. Four functions that each decide separately
   * what "the gateway" means is four chances to disagree about the host; they
   * now share one derivation, and this asserts the four answers still line up.
   */
  assert.equal(renderEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/render');
  assert.equal(enginesEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/engines');
});

test('⚠️ a gateway URL that is not the chat route still yields the leaf, and empty yields null', () => {
  assert.equal(speakEndpoint('https://gw.example.com/api/cli/v1/'), 'https://gw.example.com/api/cli/v1/speak');
  assert.equal(transcribeEndpoint('https://gw.example.com/api/cli/v1/'), 'https://gw.example.com/api/cli/v1/transcribe');
  assert.equal(speakEndpoint(''), null);
  assert.equal(transcribeEndpoint(null), null);
});

// ───────────────────────────────────────────────────────────────────────────
// THE ROUTE — local first, account second, null third
// ───────────────────────────────────────────────────────────────────────────

test('⭐ a local worker still wins, and never touches the gateway', () => {
  const home = signedIn();
  const speakRoute = speakVia({ speak: 'https://mine.modal.run/tts' }, {}, home);
  assert.equal(speakRoute.direct, true);
  assert.equal(speakRoute.url, 'https://mine.modal.run/tts');
  // ⚠️ No token is resolved on this path — it must not read the account at all.
  assert.equal(speakRoute.token, undefined);

  const hearRoute = transcribeVia({ transcribe: 'https://mine.modal.run/stt' }, {}, home);
  assert.equal(hearRoute.direct, true);
  assert.equal(hearRoute.url, 'https://mine.modal.run/stt');
});

test('⭐⭐⭐ with no local worker, a signed-in account routes both directions to the gateway', () => {
  const home = signedIn();
  const speakRoute = speakVia({ speak: null }, {}, home);
  assert.ok(speakRoute, 'a signed-in customer must have a way to speak');
  assert.equal(speakRoute.direct, false);
  assert.match(speakRoute.url, /\/api\/cli\/v1\/speak$/);
  assert.equal(speakRoute.token, 'xxi_live_test');

  const hearRoute = transcribeVia({ transcribe: null }, {}, home);
  assert.ok(hearRoute, 'a signed-in customer must have a way to listen');
  assert.equal(hearRoute.direct, false);
  assert.match(hearRoute.url, /\/api\/cli\/v1\/transcribe$/);
});

test('⚠️ with neither, both return null rather than attempting an unauthenticated call', () => {
  const home = homeWith(null);
  assert.equal(speakVia({ speak: null }, {}, home), null);
  assert.equal(transcribeVia({ transcribe: null }, {}, home), null);
});

test('⚠️⚠️ THE BUG ITSELF: our own secret is what made these look configured', () => {
  /**
   * `mediaConfig` with no secret yields no URL at all, even though the default
   * is compiled in — which is correct and fail-shut, and is exactly why a
   * customer saw nothing. With OUR secret the very same env lights up.
   */
  assert.equal(mediaConfig({}).speak, null);
  assert.equal(mediaConfig({}).transcribe, null);
  assert.ok(mediaConfig({ MODAL_VIDEO_SECRET: 's' }).speak, 'our secret alone reveals the baked-in URL');
  assert.ok(mediaConfig({ MODAL_VIDEO_SECRET: 's' }).transcribe);
});

// ───────────────────────────────────────────────────────────────────────────
// WHAT ACTUALLY GOES ON THE WIRE
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ the gateway leg carries a bearer token and NO shared secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-voice-ws-'));
  try {
    const { calls, impl } = recorder({ ok: true, audio: Buffer.from('RIFFfake').toString('base64') });
    const res = await speak(root, 'hello there', 'out.wav', {
      env: {}, fetchImpl: impl, home: signedIn(),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/cli\/v1\/speak$/);
    assert.equal(calls[0].headers.authorization, 'Bearer xxi_live_test');
    /**
     * ⚠️⚠️ THE WHOLE SECURITY ARGUMENT IN ONE ASSERTION. Handing the CLI the
     * shared Modal secret after it authenticates is BYOK wearing a different
     * hat — the same secret for every tenant, sitting in a customer's shell
     * history and CI logs. One leak opens every GPU endpoint we own.
     */
    assert.equal('secret' in calls[0].body, false, 'the shared Modal secret must never leave the server');
    assert.equal(calls[0].body.text, 'hello there');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ the DIRECT leg is byte-identical to what it always sent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-voice-ws-'));
  try {
    const { calls, impl } = recorder({ ok: true, audio: Buffer.from('RIFFfake').toString('base64') });
    await speak(root, 'hello there', 'out.wav', {
      env: { MODAL_TTS_URL: 'https://mine.modal.run/tts', MODAL_VIDEO_SECRET: 'shh' },
      fetchImpl: impl,
      home: homeWith(null),
    });
    assert.equal(calls[0].url, 'https://mine.modal.run/tts');
    assert.equal(calls[0].body.secret, 'shh', 'the local path must keep sending the secret in the body');
    assert.equal(calls[0].headers.authorization, undefined, 'a local worker gets no Acuvo token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ the gateway transcribe leg sends ONE copy of the audio, the direct leg still sends both keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-voice-ws-'));
  writeFileSync(join(root, 'note.wav'), Buffer.from(`RIFF____WAVEfmt ${'x'.repeat(400)}`));
  try {
    const gw = recorder({ ok: true, text: 'ship it', segments: [] });
    await transcribe(root, 'note.wav', { env: {}, fetchImpl: gw.impl, home: signedIn() });
    assert.match(gw.calls[0].url, /\/api\/cli\/v1\/transcribe$/);
    assert.equal(typeof gw.calls[0].body.audio_b64, 'string');
    /**
     * ⚠️ NOT A WEAKENING OF THE "SEND BOTH KEYS" RULE — a relocation of it. The
     * body is the largest thing this CLI posts and it rides against a request
     * limit that is the binding constraint on the whole path; the console route
     * puts both keys back on the upstream call, where the bytes are already in
     * memory and the duplication is free.
     */
    assert.equal('audioB64' in gw.calls[0].body, false, 'doubling the body would halve the largest file that fits');
    assert.equal('secret' in gw.calls[0].body, false);

    const direct = recorder({ ok: true, text: 'ship it', segments: [] });
    await transcribe(root, 'note.wav', {
      env: { MODAL_TRANSCRIBE_URL: 'https://mine.modal.run/stt', MODAL_VIDEO_SECRET: 'shh' },
      fetchImpl: direct.impl,
      home: homeWith(null),
    });
    assert.equal(direct.calls[0].body.audio_b64, direct.calls[0].body.audioB64,
      'one underscore cost this package the entire voice loop once — both keys stay on the direct leg');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// THE CEILING THAT IS NOT OURS TO CHOOSE
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ a recording too big for one request is refused HERE, with the number and the alternative', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-voice-ws-'));
  writeFileSync(join(root, 'long.wav'), Buffer.alloc(MAX_GATEWAY_TRANSCRIBE_BYTES + 1024, 0x41));
  try {
    let called = false;
    const res = await transcribe(root, 'long.wav', {
      env: {},
      fetchImpl: async () => { called = true; throw new Error('must not be called'); },
      home: signedIn(),
    });
    assert.equal(res.ok, false);
    assert.equal(called, false, 'the platform would have refused this with an empty body — say it before paying for the round trip');
    assert.match(res.error, /3MB/, `the refusal must name the limit. Got: ${res.error}`);
    assert.match(res.error, /MODAL_TRANSCRIBE_URL/, 'and the way around it');

    /**
     * ⭐ AND THE SAME FILE IS FINE ON A LOCAL WORKER. The ceiling belongs to the
     * serverless hop, not to the audio — pinning that keeps someone from
     * "tidying" the two limits into one.
     */
    const direct = recorder({ ok: true, text: 'long one', segments: [] });
    const ok = await transcribe(root, 'long.wav', {
      env: { MODAL_TRANSCRIBE_URL: 'https://mine.modal.run/stt', MODAL_VIDEO_SECRET: 'shh' },
      fetchImpl: direct.impl,
      home: homeWith(null),
    });
    assert.equal(ok.ok, true, ok.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// THE FLAGS THEMSELVES
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ voiceConfig reports REACHABLE, not merely configured', () => {
  const out = homeWith(null);
  assert.deepEqual(
    { ...voiceConfig({}, out) },
    { canListen: false, canSpeak: false, listenUrl: null, speakUrl: null, viaAccount: false },
  );

  const inn = voiceConfig({}, signedIn());
  assert.equal(inn.canSpeak, true, '--say must work for somebody who paid for a plan');
  assert.equal(inn.canListen, true, 'and so must --task-audio');
  assert.equal(inn.viaAccount, true, 'the bill goes to their credits, and a message may need to say so');
});

test('⚠️ the refusals point at `acuvo --login`, not only at an env var a customer cannot use', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-voice-ws-'));
  writeFileSync(join(root, 'note.wav'), Buffer.from('RIFF'));
  const out = homeWith(null);
  try {
    const heard = await taskFromAudio(root, 'note.wav', {
      env: {}, fetchImpl: async () => { throw new Error('no network'); }, home: out,
    });
    assert.equal(heard.ok, false);
    assert.match(heard.error, /--login/, `the first move for a customer is signing in. Got: ${heard.error}`);
    assert.match(heard.error, /MODAL_TRANSCRIBE_URL/, 'and the self-hosted route is still named');

    const said = await speakSummary(root, { ok: true, executed: [] }, {
      env: {}, fetchImpl: async () => { throw new Error('no network'); }, enabled: true, home: out,
    });
    assert.equal(said.ok, false);
    assert.match(said.reason, /--login/);
    assert.match(said.reason, /MODAL_TTS_URL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ --say now produces a real file for a signed-in customer with no Modal credentials at all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-voice-ws-'));
  try {
    const { calls, impl } = recorder({ ok: true, audio: Buffer.alloc(2048, 7).toString('base64') });
    const res = await speakSummary(root, { ok: true, executed: [], verification: { ran: true, passed: true, command: 'npm test' } }, {
      env: {}, fetchImpl: impl, enabled: true, task: 'add a healthcheck', home: signedIn(),
    });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.spoken, true);
    assert.equal(res.bytes, 2048);
    assert.match(calls[0].url, /\/api\/cli\/v1\/speak$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
