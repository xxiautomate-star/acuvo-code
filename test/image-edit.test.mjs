/**
 * ── ⭐⭐ edit_image · expand_image — TWO DARK SERVICES JOINED ────────────────
 *
 * `acuvo-select` and `acuvo-flux-studio` were both deployed, healthy, paid for
 * and called by nothing. Neither is useful alone: inpainting needs a mask, and a
 * terminal has no brush — so the inpaint verb had no door, and the door had
 * nothing to open.
 *
 * ⚠️⚠️ THE ASSERTION THIS FILE EXISTS FOR IS THE OVERWRITE REFUSAL. The selector
 * cannot tell you whether the named thing is in the picture — it returns a
 * confident box for an absent object, and the worker ships
 * `presence_verified: false` saying so. No threshold fixes that, because the
 * number being thresholded is the wrong number. The only honest guarantee is
 * structural: a wrong edit costs a render, never the original.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  editImage, expandImage, selectRegion, runFluxTask,
  editConfig, fluxResultUrl, imageEditToolNames, ASPECTS,
  imageDimensions, addedFraction, OUTPAINT_SAFE_ADDED,
} from '../lib/image-edit.mjs';

const ENV = {
  MODAL_SELECT_URL: 'https://sel.example.invalid/select',
  MODAL_FLUX_URL: 'https://flux.example.invalid/studio',
  MODAL_FLUX_RESULT_URL: 'https://flux.example.invalid/result',
  MODAL_VIDEO_SECRET: 's',
};

const PNG = Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(64), 'latin1');
const MASK_B64 = Buffer.from('mask-bytes').toString('base64');
const OUT_B64 = Buffer.from('rendered-png-bytes').toString('base64');

function fixture(name = 'hero.png') {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-edit-'));
  writeFileSync(join(root, name), PNG);
  return root;
}

/** A stub standing in for select + studio + poll, recording every request. */
function services({ matched = 1, coverage = 0.12, status = 'done', selectFails = null } = {}) {
  const sent = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    const reply = (o) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(o) });
    if (url.includes('/select')) {
      if (selectFails) return reply({ ok: false, error: selectFails });
      return reply({ ok: true, matched, mask: MASK_B64, labels: ['sofa'], scores: [0.94], coverage, presence_verified: false, caveat: 'score is localisation confidence, not presence' });
    }
    if (url.includes('/studio')) return reply({ ok: true, status: 'queued', callId: 'fc-1', width: 1536, height: 864 });
    return reply({ ok: true, status, ...(status === 'done' ? { data: OUT_B64 } : {}) });
  };
  return { sent, impl, sleep: async () => {} };
}

/* ── 1. CONFIGURATION ────────────────────────────────────────────────────── */

test('both engines are reachable out of the box once a secret exists', () => {
  const cfg = editConfig({ MODAL_VIDEO_SECRET: 's' });
  assert.ok(cfg.select && cfg.flux, 'a dark default is how these stayed unreachable for weeks');
  assert.match(cfg.fluxResult, /-result\.modal\.run$/, 'the poll URL is derived from the studio URL');
});

test('⚠️ no secret means dark — these are L40S renders', () => {
  const cfg = editConfig({});
  assert.equal(cfg.select, null);
  assert.equal(cfg.flux, null);
});

test('⚠️ a custom studio URL that cannot yield a poll URL is named, not polled forever', async () => {
  assert.equal(fluxResultUrl('https://my.host/whatever'), null);
  const res = await runFluxTask('generate', { prompt: 'x' }, {
    env: { MODAL_FLUX_URL: 'https://my.host/whatever', MODAL_VIDEO_SECRET: 's' },
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /MODAL_FLUX_RESULT_URL/, 'a hang is the worst way to learn a URL was wrong');
});

test('edit_image is withheld unless BOTH services are configured', () => {
  const fluxOnly = imageEditToolNames({ MODAL_VIDEO_SECRET: 's', MODAL_SELECT_URL: '' });
  assert.ok(!fluxOnly.includes('edit_image'), 'without a mask engine the verb is impossible — a dead button costs a round');
  assert.ok(fluxOnly.includes('expand_image'), 'but outpainting needs no mask, so it survives');
  const both = imageEditToolNames({ MODAL_VIDEO_SECRET: 's' });
  assert.ok(both.includes('edit_image') && both.includes('expand_image'));
});

/* ── 2. ⚠️⚠️ THE SAFETY MODEL ────────────────────────────────────────────── */

test('⚠️⚠️ the source image is NEVER overwritten, and asking to is REFUSED', async () => {
  const root = fixture();
  const { impl, sleep } = services();
  try {
    const res = await editImage(root, 'hero.png', 'the sofa', 'a potted plant', { env: ENV, fetchImpl: impl, sleep, out: 'hero.png' });
    assert.equal(res.ok, false);
    assert.match(res.error, /refusing to overwrite/);
    assert.deepEqual(readFileSync(join(root, 'hero.png')), PNG, 'and the bytes on disk are untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the edit lands in a new file and the original survives', async () => {
  const root = fixture();
  const { impl, sleep } = services();
  try {
    const res = await editImage(root, 'hero.png', 'the sofa', 'a potted plant', { env: ENV, fetchImpl: impl, sleep });
    assert.equal(res.ok, true);
    assert.equal(res.path, 'hero-edited.png');
    assert.ok(existsSync(join(root, 'hero-edited.png')));
    assert.deepEqual(readFileSync(join(root, 'hero.png')), PNG);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ the result tells the model the selection was never verified', async () => {
  const root = fixture();
  const { impl, sleep } = services();
  try {
    const res = await editImage(root, 'hero.png', 'the sofa', 'a potted plant', { env: ENV, fetchImpl: impl, sleep });
    assert.equal(res.presenceVerified, false,
      'Grounding DINO returns a confident box for an object that is not there. A result that omits this reads as certainty.');
    assert.match(res.note, /read_image/, 'the agent is the only participant that can actually LOOK — name the verb');
    assert.match(res.note, /unchanged/, 'and knowing the original survived is what makes checking cheap rather than alarming');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 3. THE CHAIN ────────────────────────────────────────────────────────── */

test('select runs FIRST and its mask is what the inpaint is given', async () => {
  const root = fixture();
  const { sent, impl, sleep } = services();
  try {
    await editImage(root, 'hero.png', 'the sign on the van', 'plain white panel', { env: ENV, fetchImpl: impl, sleep });
    assert.match(sent[0].url, /select/, 'no mask, no inpaint — the order is the capability');
    assert.equal(sent[0].body.text, 'the sign on the van');
    const studio = sent.find((s) => s.url.includes('/studio'));
    assert.equal(studio.body.task, 'inpaint');
    assert.equal(studio.body.mask, MASK_B64, 'the mask must be the one select produced, not a re-derived guess');
    assert.equal(studio.body.prompt, 'plain white panel');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nothing matched stops the chain before a GPU is paid for', async () => {
  const root = fixture();
  const { sent, impl, sleep } = services({ matched: 0 });
  try {
    const res = await editImage(root, 'hero.png', 'the unicorn', 'a chair', { env: ENV, fetchImpl: impl, sleep });
    assert.equal(res.ok, false);
    assert.match(res.error, /matched "the unicorn"/, 'say what was searched for, or the next attempt is the same phrase');
    assert.equal(sent.some((s) => s.url.includes('/studio')), false, 'an empty mask must never reach the inpainter');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the service refusing a whole-frame selection is passed straight through', async () => {
  const root = fixture();
  // The worker refuses >97% coverage itself: handed to an inpaint, that replaces
  // the user's picture wholesale with a prompt.
  const { impl, sleep } = services({ selectFails: 'selection covers 99.2% of the image — that is the whole frame, not an object.' });
  try {
    const res = await editImage(root, 'hero.png', 'the background', 'a beach', { env: ENV, fetchImpl: impl, sleep });
    assert.equal(res.ok, false);
    assert.match(res.error, /whole frame/, 'the service named the problem exactly — smoothing it would cost a round to rediscover');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a replacement description is required — an empty inpaint prompt paints noise', async () => {
  const root = fixture();
  const { sent, impl, sleep } = services();
  try {
    const res = await editImage(root, 'hero.png', 'the sofa', '   ', { env: ENV, fetchImpl: impl, sleep });
    assert.equal(res.ok, false);
    assert.equal(sent.length, 0, 'and it is caught before the selector is paid for, not after');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 4. THE POLL LOOP ────────────────────────────────────────────────────── */

test('a running job is polled until it is done', async () => {
  const root = fixture();
  let polls = 0;
  const impl = async (url, init) => {
    const reply = (o) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(o) });
    if (url.includes('/studio')) return reply({ ok: true, status: 'queued', callId: 'fc-1' });
    polls += 1;
    return reply(polls < 3 ? { ok: true, status: 'running' } : { ok: true, status: 'done', data: OUT_B64 });
  };
  try {
    const res = await expandImage(root, 'hero.png', '16:9', { env: ENV, fetchImpl: impl, sleep: async () => {} });
    assert.equal(res.ok, true);
    assert.equal(polls, 3, '"running" is the healthy answer for most of a cold job\'s life');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a job that never finishes ends with the callId, not a silent hang', async () => {
  const root = fixture();
  let clock = 0;
  const impl = async (url) => {
    const reply = (o) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(o) });
    return url.includes('/studio') ? reply({ ok: true, status: 'queued', callId: 'fc-9' }) : reply({ ok: true, status: 'running' });
  };
  try {
    const res = await expandImage(root, 'hero.png', '16:9', {
      env: ENV, fetchImpl: impl,
      // ⭐ The clock is injected so six minutes of polling costs a millisecond.
      // Otherwise the timeout branch — the one that matters — is the one nothing
      // ever covers.
      now: () => (clock += 60_000), sleep: async () => {},
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /fc-9/, 'the job may still be running and billing — the id is how a human finds it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 5. expand_image ─────────────────────────────────────────────────────── */

test('an unknown aspect is refused with the list, before any spend', async () => {
  const root = fixture();
  let called = false;
  try {
    const res = await expandImage(root, 'hero.png', '7:3', { env: ENV, fetchImpl: async () => { called = true; } });
    assert.equal(res.ok, false);
    assert.match(res.error, /16:9/, 'naming the alternatives is what makes the next call right');
    assert.equal(called, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ an outpaint with no prompt still carries an intent', async () => {
  const root = fixture();
  const { sent, impl, sleep } = services();
  try {
    await expandImage(root, 'hero.png', '21:9', { env: ENV, fetchImpl: impl, sleep });
    const studio = sent.find((s) => s.url.includes('/studio'));
    assert.equal(studio.body.task, 'outpaint');
    assert.equal(studio.body.aspect, '21:9');
    assert.ok(studio.body.prompt.trim().length > 0,
      'an unconditioned outpaint invents — the worker recorded one that grew a SECOND VAN');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the widened frame is a new file named for the aspect', async () => {
  const root = fixture();
  const { impl, sleep } = services();
  try {
    const res = await expandImage(root, 'hero.png', '16:9', { env: ENV, fetchImpl: impl, sleep });
    assert.equal(res.path, 'hero-16x9.png', 'a colon is not a filename character on Windows');
    assert.ok(existsSync(join(root, 'hero.png')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every advertised aspect is one the worker actually accepts', () => {
  // ⚠️ Mirrors ASPECTS in gpu/modal/flux_studio.py. A schema enum the service
  // rejects is a control that looks live and refuses at spend time.
  assert.deepEqual([...ASPECTS].sort(), ['1:1', '16:9', '2:1', '2:3', '21:9', '3:2', '4:5', '5:4', '9:16'].sort());
});

/* ── 5b. ⚠️⚠️ THE TWO DEFECTS FOUND BY LOOKING, NOT BY THE STATUS CODE ───── */

test('a PNG and a JPEG both give up their size without a decoder', () => {
  const png = Buffer.alloc(32);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(png, 0);
  png.writeUInt32BE(1200, 16); png.writeUInt32BE(800, 20);
  assert.deepEqual(imageDimensions(png), { width: 1200, height: 800 });

  const jpg = Buffer.alloc(24, 0);
  jpg[0] = 0xff; jpg[1] = 0xd8; jpg[2] = 0xff; jpg[3] = 0xc0;
  jpg.writeUInt16BE(11, 4); jpg.writeUInt16BE(768, 7); jpg.writeUInt16BE(1536, 9);
  assert.deepEqual(imageDimensions(jpg), { width: 1536, height: 768 });

  assert.equal(imageDimensions(Buffer.from('not an image')), null, 'unknown must be null, not a guess');
});

test('the invented fraction matches what was measured on the real renders', () => {
  const src = { width: 1200, height: 800 };            // 3:2
  const near = addedFraction(src, { width: 1536, height: 864 });   // 16:9 — looked clean
  const mid = addedFraction(src, { width: 1536, height: 768 });    // 2:1  — outer edge smeared
  const far = addedFraction(src, { width: 1792, height: 768 });    // 21:9 — unusable
  assert.ok(near < OUTPAINT_SAFE_ADDED, `16:9 measured clean at ${(near * 100).toFixed(0)}%`);
  assert.ok(mid > OUTPAINT_SAFE_ADDED, `2:1 measured smeared at ${(mid * 100).toFixed(0)}%`);
  assert.ok(far > mid, 'and 21:9 reaches further still');
});

test('⚠️⚠️ a far outpaint carries a WARNING — it fails as smear and still returns ok', async () => {
  const root = fixture();
  // A 1200x800 source, asked for 21:9. Both the render and the source are stubbed;
  // what is under test is that the client NOTICES how far it reached.
  writeFileSync(join(root, 'src.png'), (() => {
    const b = Buffer.alloc(64); Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(b, 0);
    b.writeUInt32BE(1200, 16); b.writeUInt32BE(800, 20); return b;
  })());
  const impl = async (url) => {
    const reply = (o) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(o) });
    return url.includes('/studio')
      ? reply({ ok: true, status: 'queued', callId: 'fc-1', width: 1792, height: 768 })
      : reply({ ok: true, status: 'done', data: OUT_B64 });
  };
  try {
    const res = await expandImage(root, 'src.png', '21:9', { env: ENV, fetchImpl: impl, sleep: async () => {} });
    assert.equal(res.ok, true, 'it still succeeds — refusing what we can attempt would be worse');
    assert.ok(res.warning, 'but ok:true is exactly what made this defect invisible');
    assert.match(res.warning, /36%/, 'the number is the actionable part');
    assert.match(res.warning, /two smaller steps|nearer aspect/, 'and a warning without a fix is just worry');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a near outpaint carries no warning — noise trains people to ignore warnings', async () => {
  const root = fixture();
  writeFileSync(join(root, 'src.png'), (() => {
    const b = Buffer.alloc(64); Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(b, 0);
    b.writeUInt32BE(1200, 16); b.writeUInt32BE(800, 20); return b;
  })());
  const impl = async (url) => {
    const reply = (o) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(o) });
    return url.includes('/studio')
      ? reply({ ok: true, status: 'queued', callId: 'fc-1', width: 1536, height: 864 })
      : reply({ ok: true, status: 'done', data: OUT_B64 });
  };
  try {
    const res = await expandImage(root, 'src.png', '16:9', { env: ENV, fetchImpl: impl, sleep: async () => {} });
    assert.equal(res.warning, undefined);
    assert.equal(res.invented, 0.16, 'the number is reported either way — only the alarm is conditional');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a wide mask warns that the edit will spill — measured, a 13% mask invented a staircase', async () => {
  const root = fixture();
  const { impl, sleep } = services({ coverage: 0.128 });
  try {
    const res = await editImage(root, 'hero.png', 'the red sofa', 'a green armchair', { env: ENV, fetchImpl: impl, sleep });
    assert.equal(res.ok, true);
    assert.match(res.warning, /13%/);
    assert.match(res.warning, /specific phrase/, 'the fix is a tighter noun, and it belongs in the sentence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a tight mask does not warn', async () => {
  const root = fixture();
  const { impl, sleep } = services({ coverage: 0.03 });
  try {
    const res = await editImage(root, 'hero.png', 'the lamp', 'a plant', { env: ENV, fetchImpl: impl, sleep });
    assert.equal(res.warning, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 6. selectRegion on its own ─────────────────────────────────────────── */

test('selecting requires a noun', async () => {
  const root = fixture();
  const res = await selectRegion(root, 'hero.png', '  ', { env: ENV, fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(res.ok, false);
  rmSync(root, { recursive: true, force: true });
});

test('a mask comes back with the caveat attached to it', async () => {
  const root = fixture();
  const { impl } = services();
  try {
    const res = await selectRegion(root, 'hero.png', 'the sky', { env: ENV, fetchImpl: impl });
    assert.equal(res.ok, true);
    assert.equal(res.mask, MASK_B64);
    assert.equal(res.presenceVerified, false);
    assert.match(res.caveat, /presence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
