/**
 * ── ⚠️ THE WHOLE VOICE LOOP FAILED ON ONE UNDERSCORE ────────────────────────
 *
 * `transcribe` encoded the file correctly and posted it under `audioB64`. The
 * service wants `audio_b64` and says so plainly: `supply audio_url or
 * audio_b64`. So the CLI could SPEAK (a real 211 KB WAV) and could never HEAR
 * its own output, and the round trip that proves the multimodal half works was
 * broken by a naming convention.
 *
 * MEASURED 2026-08-11 against the live endpoint, same 211 KB WAV both times:
 *   { audioB64 }  -> 200 {"ok":false,"error":"supply audio_url or audio_b64"}
 *   { audio_b64 } -> 200 {"ok":true,"text":"The quick brown fox jumps over the
 *                          lazy dog near the riverbank.","segments":[…]}
 *
 * ⭐ IT WAS ONLY DIAGNOSABLE BECAUSE OF THE ERROR-PASSTHROUGH FIX. Before it,
 * every one of these came back as a generic message and the agent retried
 * blindly four times. After it, the service's own words reached the model and it
 * named the cause in three rounds. That is the difference between an error
 * string as noise and an error string as an instruction.
 *
 * ⚠️ BOTH KEYS ARE SENT. Two deployments of this service exist in the wild and
 * an ignored extra key costs nothing, while guessing wrong costs the capability.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { transcribe } from '../lib/media.mjs';

const ENV = { MODAL_TRANSCRIBE_URL: 'https://stt.example.invalid/x', MODAL_VIDEO_SECRET: 's' };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-stt-'));
  writeFileSync(join(root, 'a.wav'), Buffer.from('RIFF____WAVEfmt ' + 'x'.repeat(200)));
  return root;
}

test('⚠️ transcribe posts audio_b64 — the key the service actually reads', async () => {
  const root = fixture();
  let sent = null;
  try {
    await transcribe(root, 'a.wav', {
      env: ENV,
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ ok: true, text: 'hi', segments: [] }) };
      },
    });
    assert.ok(sent, 'no request was made');
    assert.ok(
      typeof sent.audio_b64 === 'string' && sent.audio_b64.length > 0,
      `the payload has no audio_b64 — the live service replies "supply audio_url or audio_b64" to exactly this. Sent keys: ${Object.keys(sent).join(', ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the legacy camelCase key is still sent, so an older deployment keeps working', async () => {
  const root = fixture();
  let sent = null;
  try {
    await transcribe(root, 'a.wav', {
      env: ENV,
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ ok: true, text: 'hi' }) };
      },
    });
    assert.equal(typeof sent.audioB64, 'string', 'dropping the old key would break any deployment still reading it');
    assert.equal(sent.audio_b64, sent.audioB64, 'the two keys must carry identical bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a successful transcription still returns text and segments', async () => {
  const root = fixture();
  try {
    const r = await transcribe(root, 'a.wav', {
      env: ENV,
      fetchImpl: async () => ({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ ok: true, text: 'the quick brown fox', segments: [{ start: 0, end: 2, text: 'the quick brown fox' }] }),
      }),
    });
    assert.equal(r.ok, true, r.error ?? '');
    assert.equal(r.text, 'the quick brown fox');
    assert.equal(r.segments.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
