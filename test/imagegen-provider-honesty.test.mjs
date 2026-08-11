/**
 * ── ⚠️ THE DEFAULT IMAGE PROVIDER DIED AND NOTHING FAILED LOUDLY ─────────────
 *
 * Measured live 2026-08-11, three times:
 *   verifyUser -> {"status":"failed_verification","reason":"token_required"}
 * Perchance has closed anonymous access. Our HTTP/2 fingerprint still WORKS —
 * we reach their API and get a real JSON answer rather than a Cloudflare wall —
 * but there is now a token gate, and it is a policy change, not an outage.
 *
 * Every test in this file is about what the chain does with a provider that is
 * reachable and permanently says no. That case is nowhere near the breaker's
 * original one (a service that does not answer at all), and it is the one the
 * chain is actually living in today.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateThroughProviders, generateImage, imageToolSchema,
} from '../lib/imagegen.mjs';
import { resetBreakers } from '../lib/breaker.mjs';

const JPEG = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(5000, 9)]);
const ws = () => ({ root: mkdtempSync(join(tmpdir(), 'imghonesty-')) });
const servesJpeg = async () => ({ ok: true, status: 200, arrayBuffer: async () => JPEG });

/** The exact refusal the live service returns today. */
const TOKEN_GATE = 'verifyUser gave no usable key: {"status":"failed_verification","reason":"token_required"}';

const countingNative = (error) => {
  const fn = async () => { fn.calls += 1; return { ok: false, error }; };
  fn.calls = 0;
  return fn;
};

/**
 * ⭐ THE ONE THAT MATTERS. A gate refusal is prompt-independent and permanent
 * for the life of the process: the second ask gets the identical answer. Paying
 * for it on every image in a build is the same waste the breaker was written
 * for, arriving through a door the breaker was never pointed at.
 */
test('a token-gated provider is asked once per run, not once per image', async () => {
  resetBreakers();
  const nativeImpl = countingNative(TOKEN_GATE);
  const args = { executor: ws(), env: {}, fetchImpl: servesJpeg, nativeImpl };

  const first = await generateThroughProviders({ ...args, prompt: 'a quiet library' });
  const second = await generateThroughProviders({ ...args, prompt: 'a busy market' });
  const third = await generateThroughProviders({ ...args, prompt: 'a rainy street' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  assert.equal(nativeImpl.calls, 1, 'a closed door must be tried once a run, not once an image');
});

/**
 * ⚠️ AND THE GUARD MUST NOT FAIL CORRECT WORK. A refusal that names OUR bug or
 * a passing wobble is not a closed door — disabling the provider for the rest of
 * the run because one request went wrong is exactly the failure mode the breaker
 * module warns about in its own header.
 */
test('an ordinary failure does not disable the provider for the run', async () => {
  resetBreakers();
  const nativeImpl = countingNative('perchance returned 0 bytes that are not an image');
  const args = { executor: ws(), env: {}, fetchImpl: servesJpeg, nativeImpl };

  await generateThroughProviders({ ...args, prompt: 'one' });
  await generateThroughProviders({ ...args, prompt: 'two' });

  assert.equal(nativeImpl.calls, 2, 'a one-off failure must not cost the provider the whole run');
});

/**
 * ⚠️⭐ AN ERROR STRING IS AN INSTRUCTION, AND THIS ONE RIDES A SUCCESS.
 *
 * `fellBackFrom` is attached to a result where an image WAS produced. The
 * breaker's skip message ends "do not call this tool again in this run" — which
 * is right when the whole tool is dead and catastrophically wrong when it is
 * bolted to a working image, because the model reads it literally and stops
 * asking for imagery it could have had.
 */
test('the fallback note explains, it does not instruct', async () => {
  resetBreakers();
  const nativeImpl = countingNative(TOKEN_GATE);
  const args = { executor: ws(), env: {}, fetchImpl: servesJpeg, nativeImpl };

  await generateThroughProviders({ ...args, prompt: 'first' });
  const r = await generateThroughProviders({ ...args, prompt: 'second' });

  assert.equal(r.ok, true);
  assert.ok(r.fellBackFrom, 'a substitution must be declared');
  assert.doesNotMatch(
    r.fellBackFrom,
    /do not call this tool again/i,
    'a successful image must never carry a stop-calling-me instruction',
  );
});

/** The same trap on the self-hosted branch, which reaches the breaker directly. */
test('a dead self-hosted service does not tell a successful call to stop', async () => {
  resetBreakers();
  const timeout = async (url) => {
    if (String(url).includes('pollinations')) return servesJpeg();
    const e = new Error('aborted'); e.name = 'TimeoutError'; throw e;
  };
  const args = {
    executor: ws(),
    env: { PERCHANCE_IMAGE_URL: 'https://example.invalid' },
    fetchImpl: timeout,
  };

  await generateThroughProviders({ ...args, prompt: 'first' });
  const r = await generateThroughProviders({ ...args, prompt: 'second' });

  assert.equal(r.ok, true, 'the fallback still works when the primary is dead');
  assert.doesNotMatch(r.fellBackFrom, /do not call this tool again/i);
});

/**
 * ⭐ WHICH ENGINE DREW IT. Perchance and Pollinations are not the same product —
 * one was strong at lettering, the other is a free last resort — and today every
 * image silently comes from the second one. `note` is the string the model reads
 * and repeats to the user; if it never names the engine, nobody can tell.
 */
test('the note names the engine that actually drew the image', async () => {
  resetBreakers();
  const nativeImpl = countingNative(TOKEN_GATE);
  const r = await generateImage({
    prompt: 'a hero image',
    executor: ws(),
    env: {},            // no OPENROUTER_API_KEY: the critic is skipped
    fetchImpl: servesJpeg,
    nativeImpl,
  });

  assert.equal(r.ok, true);
  assert.equal(r.provider, 'pollinations');
  assert.match(r.note, /pollinations/i, 'the reader must be told whose model made this');
});

/**
 * ⚠️ THE SCHEMA IS READ BY THE MODEL ON EVERY SINGLE CALL, so a stale claim in
 * it is repeated forever. Two are stale, both measured today: the chain answers
 * in ~2.6s rather than "about a minute", and the file that lands is a `.jpg`,
 * because the provider that actually serves us returns JPEG.
 */
test('the tool schema does not promise a minute, or a .png it may not write', () => {
  const desc = imageToolSchema().function.description;
  assert.doesNotMatch(desc, /about a minute/i, 'measured 2.6s — a stale number teaches the model to avoid the tool');
  assert.doesNotMatch(desc, /as a \.png/i, 'the live provider returns JPEG; the extension follows the bytes');
  assert.match(desc, /\.jpg|\.png/, 'it should still say what kind of file appears');
});
