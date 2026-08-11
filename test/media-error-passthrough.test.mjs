/**
 * ── ⚠️⚠️ A 200 THAT MEANS FAILURE, AND THE MESSAGE THAT GOT THROWN AWAY ─────
 *
 * The Modal media services answer HTTP 200 and put the verdict in the BODY:
 * `{ ok: false, error: "unauthorised" }`. `postJson` only inspects `res.ok`,
 * which is the HTTP status, so it returns `{ ok: true, json: {...} }` and the
 * caller then looks for its payload key, does not find one, and invents a
 * generic message of its own.
 *
 * MEASURED 2026-08-11 against the live endpoint:
 *   POST {text}                  -> 200 {"ok":false,"error":"unauthorised"}
 *   POST {text, secret}          -> 200 {"ok":true,"audio":"UklGRlRWAQBXQVZF…"}  (116 KB of real WAV)
 *
 * So the service said exactly what was wrong — one missing credential — and the
 * agent was told "the speech service returned no audio". It then retried FOUR
 * times, burned six rounds and $0.0023, and correctly concluded it was blocked.
 *
 * ⭐ THIS IS THE SAME DEFECT SHAPE AS THE TRANSPORT LAYER'S DEGENERATE 200,
 * found the same day in lib/model.mjs: an HTTP success carrying an application
 * failure, believed because the status line was 200. Worth naming as a class —
 * "res.ok" answers a question about the HTTP conversation, never about whether
 * the work happened.
 *
 * ⚠️ AND IT IS ALSO "AN ERROR STRING IS AN INSTRUCTION" AGAIN. "returned no
 * audio" reads like a transient fault, so retrying is the rational response.
 * "unauthorised" reads like a configuration fault, and no model retries that.
 * The wrong string did not just fail to inform — it actively bought four
 * retries of a call that could never succeed.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { speak, transcribe, makeDocument } from '../lib/media.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-media-err-'));

/** A fetch that answers 200 with an application-level failure, as Modal does. */
const respond = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(body),
});

const ENV = {
  MODAL_TTS_URL: 'https://tts.example.invalid/x',
  MODAL_TRANSCRIBE_URL: 'https://stt.example.invalid/x',
  MODAL_PRESS_URL: 'https://press.example.invalid/x',
  MODAL_VIDEO_SECRET: 'wrong-secret',
};

test('⚠️⚠️ speak surfaces the service\'s OWN error, not a generic one', async () => {
  const root = ws();
  try {
    const r = await speak(root, 'hello', 'out.wav', {
      env: ENV,
      fetchImpl: respond({ ok: false, error: 'unauthorised' }),
    });
    assert.equal(r.ok, false);
    assert.match(
      String(r.error),
      /unauthoris|unauthoriz/i,
      `the service said "unauthorised" and the agent was told: "${r.error}". A wrong error string bought four retries of a call that could never succeed.`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcribe surfaces it too — this is postJson\'s job, not one tool\'s', async () => {
  const root = ws();
  try {
    const r = await transcribe(root, 'a.wav', {
      env: ENV,
      fetchImpl: respond({ ok: false, error: 'unauthorised' }),
    });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /unauthoris|unauthoriz|no such file|not found/i,
      `unexpected message: ${r.error}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('make_document surfaces it as well', async () => {
  const root = ws();
  try {
    /**
     * ⚠️ THE SIGNATURE IS (root, htmlPath, outPath, format, opts). An earlier
     * draft of this test passed an options OBJECT as `htmlPath`, so `opts` fell
     * back to `process.env`, MODAL_PRESS_URL was absent, and the assertion
     * failed with "no document service is configured" — a red that accused
     * correct code. Caught by reading the signature instead of trusting the
     * failure message. Sixth instance of that shape in this repo.
     */
    writeFileSync(join(root, 'in.html'), '<!doctype html><html><body><h1>hi</h1></body></html>\n');
    const r = await makeDocument(root, 'in.html', 'o.pdf', 'pdf', {
      env: ENV,
      fetchImpl: respond({ ok: false, error: 'quota exceeded for this workspace' }),
    });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /quota exceeded/i, `unexpected message: ${r.error}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ THE REGRESSION HALF. A 200 whose body has no `ok` field at all is the
 * ordinary success shape for several of these services, and must keep working —
 * a guard that treats "no ok field" as failure would take every media tool down.
 */
test('a normal success is untouched by the guard', async () => {
  const root = ws();
  try {
    const wav = Buffer.from('RIFF....WAVEfmt ' + 'x'.repeat(400)).toString('base64');
    const r = await speak(root, 'hello', 'out.wav', {
      env: ENV,
      fetchImpl: respond({ ok: true, audio: wav, contentType: 'audio/wav' }),
    });
    assert.equal(r.ok, true, `a valid reply was refused: ${r.error ?? ''}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a success WITHOUT an explicit ok field still works', async () => {
  const root = ws();
  try {
    const wav = Buffer.from('RIFF....WAVEfmt ' + 'x'.repeat(400)).toString('base64');
    const r = await speak(root, 'hello', 'out.wav', {
      env: ENV,
      fetchImpl: respond({ audio: wav, contentType: 'audio/wav' }),
    });
    assert.equal(r.ok, true, `a reply with no ok field was refused: ${r.error ?? ''}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⭐ The message must also be actionable. "unauthorised" alone does not tell a
 * user WHICH credential; the one that matters here is MODAL_VIDEO_SECRET, and
 * naming it turns a dead end into a fix.
 */
test('an auth failure names the credential to set', async () => {
  const root = ws();
  try {
    const r = await speak(root, 'hello', 'out.wav', {
      env: ENV,
      fetchImpl: respond({ ok: false, error: 'unauthorised' }),
    });
    assert.match(String(r.error), /MODAL_VIDEO_SECRET/,
      `the message should name the credential to set, so the user can act on it. Got: "${r.error}"`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
