/**
 * ── "NEVER SINGLE" APPLIED TO IMAGES, AND THE TRAPS IN DOING IT ─────────────
 *
 * The model chain has had a fallback since the beginning; image generation
 * quietly did not, so when one provider went down the capability went down with
 * it and took nine minutes of a real session with it.
 *
 * ⚠️ A FALLBACK IS ONLY A FALLBACK IF IT REFUSES RUBBISH. A provider that
 * answers 200 with an HTML error page, written to disk as `hero.jpg`, is worse
 * than the outage it replaced: the page looks built and is broken. Most of these
 * tests are about what the fallback DECLINES to write.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollinationsUrl, generateViaPollinations, generateImage } from '../lib/imagegen.mjs';
import { resetBreakers } from '../lib/breaker.mjs';

const JPEG = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(5000, 9)]);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5000, 9)]);

const ws = () => ({ root: mkdtempSync(join(tmpdir(), 'imgtest-')) });
const respond = (bytes, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => bytes,
});

test('the url encodes the prompt and carries the dimensions', () => {
  const u = pollinationsUrl('a cat & a dog / together', 800, 600);
  assert.ok(u.startsWith('https://image.pollinations.ai/prompt/'));
  assert.ok(u.includes('%26'), 'ampersand must be encoded or it becomes a query param');
  assert.ok(u.includes('%2F'), 'slash must be encoded or it becomes a path segment');
  assert.match(u, /width=800/);
  assert.match(u, /height=600/);
  assert.match(u, /nologo=true/);
});

test('a real JPEG is written with a .jpg extension, not .png', async () => {
  resetBreakers();
  const executor = ws();
  const r = await generateViaPollinations({ prompt: 'a hero image', executor, fetchImpl: respond(JPEG) });
  assert.equal(r.ok, true);
  assert.match(r.path, /\.jpg$/, 'JPEG bytes in a .png file is a mismatch nobody finds until it matters');
  assert.equal(r.provider, 'pollinations');
  assert.ok(existsSync(join(executor.root, r.path)));
});

test('a real PNG keeps .png', async () => {
  resetBreakers();
  const r = await generateViaPollinations({ prompt: 'a hero image', executor: ws(), fetchImpl: respond(PNG) });
  assert.equal(r.ok, true);
  assert.match(r.path, /\.png$/);
});

/**
 * ⚠️ THE ONE THAT MATTERS MOST. This provider really does serve error pages with
 * status 200. Writing that to disk produces a broken file that the page happily
 * references and the summary happily calls a success.
 */
test('a 200 that is not an image is refused, and nothing is written', async () => {
  resetBreakers();
  const executor = ws();
  const html = Buffer.from('<html><body>Rate limited, please wait</body></html>'.repeat(40));
  const r = await generateViaPollinations({ prompt: 'x', executor, fetchImpl: respond(html) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an image/);
  assert.deepEqual(readdirSync(executor.root), [], 'a refused image must leave no file behind');
});

test('a suspiciously tiny 200 is refused too', async () => {
  resetBreakers();
  const executor = ws();
  const r = await generateViaPollinations({ prompt: 'x', executor, fetchImpl: respond(Buffer.alloc(120)) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no image/);
  assert.deepEqual(readdirSync(executor.root), []);
});

test('an HTTP error is reported with its status', async () => {
  resetBreakers();
  const r = await generateViaPollinations({ prompt: 'x', executor: ws(), fetchImpl: respond(Buffer.alloc(0), 503) });
  assert.equal(r.ok, false);
  assert.match(r.error, /503/);
});

/**
 * ⭐ THE CHAIN. The primary is switched off with an explicit empty env var, which
 * is the documented way to disable it, so this exercises the real branch rather
 * than a mocked one.
 */
test('when the primary is off, the fallback answers and says so', async () => {
  resetBreakers();
  const r = await generateImage({
    prompt: 'a hero image',
    executor: ws(),
    env: { PERCHANCE_IMAGE_URL: '' },
    fetchImpl: respond(JPEG),
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'pollinations');
  assert.ok(r.fellBackFrom, 'the caller must be told it did not get the primary engine');
});

/**
 * ⚠️ AND THE ERROR MUST NOT INVITE A RETRY. Three retries against a dead image
 * service is precisely the failure that started this work; an error string is an
 * instruction to whatever reads it, and the reader is a model with a budget.
 */
test('when both fail, the error names both and closes the door', async () => {
  resetBreakers();
  const r = await generateImage({
    prompt: 'a hero image',
    executor: ws(),
    env: { PERCHANCE_IMAGE_URL: '' },
    fetchImpl: respond(Buffer.alloc(10)),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Primary:/);
  assert.match(r.error, /Fallback:/);
  assert.match(r.error, /do not call this tool again in this run/i);
  assert.doesNotMatch(r.error, /try (again|once more)/i);
});

test('the fallback honours the breaker rather than waiting twice', async () => {
  resetBreakers();
  let calls = 0;
  const timeout = async () => {
    calls += 1;
    const e = new Error('aborted');
    e.name = 'TimeoutError';
    throw e;
  };
  const args = { prompt: 'same prompt', executor: ws(), fetchImpl: timeout };
  await generateViaPollinations(args);
  const second = await generateViaPollinations(args);
  assert.equal(calls, 1, 'a dead fallback must not be waited on a second time');
  assert.equal(second.ok, false);
  assert.match(second.error, /not responding this session/);
});
