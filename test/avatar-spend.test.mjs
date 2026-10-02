/**
 * ── THE MONEY HALF OF THE MOAT VERBS ────────────────────────────────────────
 *
 * ⚠️ MEASURED 2026-08-25, BEFORE THIS: the five verbs that spend the most —
 * `clone_voice`, `design_voice`, `character_lock`, `talking_head`,
 * `generate_video` — charged the ledger NOTHING, consulted `--budget` NEVER, and
 * ran the full GPU render under `--dry-run` before discarding the result. A
 * two-second TTS line was metered to four decimal places while a 400-second
 * A100 job reported $0.0000.
 *
 * ⚠️ ZERO GPU CALLS HERE. Every endpoint is a stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JOB_SECONDS, estimateJobUsd, needsApproval, APPROVAL_THRESHOLD_USD, avatarToolSchemas,
} from '../lib/avatar.mjs';
import { preflight, preflightRented, resetGpuWarmth, talkingHead, cloneVoice, generateVideo } from '../lib/avatar-run.mjs';
import { gpuSpend, resetSpendMeter } from '../lib/budget.mjs';
import { SPEND_APPROVAL_ARG } from '../lib/media-pipeline.mjs';

const ENV = { MODAL_VIDEO_SECRET: 's3cret' };

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-avatar-spend-'));
  writeFileSync(join(root, 'face.png'), Buffer.alloc(4096, 1));
  writeFileSync(join(root, 'voice.wav'), Buffer.alloc(4096, 2));
  return root;
}

/** A stub that returns a finished artifact immediately, like the voice services do. */
function stubJob(field = 'video_b64') {
  let hits = 0;
  const impl = async () => {
    hits += 1;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, [field]: 'A'.repeat(4000), bytes: 3000, seconds: 12, usd: 0.02 }),
    };
  };
  return { impl, hits: () => hits };
}

/* ── the argument name ───────────────────────────────────────────────────── */

test('⭐ avatar-approval-arg-matches-media-pipeline — one handshake, one word', () => {
  /**
   * `avatar.mjs` cannot import `media-pipeline.mjs` (it would close the cycle
   * media-pipeline → imagegen → creative-engines → avatar), so the string is
   * copied. This is the test its comment names: two words for one handshake is
   * how a model learns to guess.
   */
  const schema = avatarToolSchemas(ENV).find((t) => t.function.name === 'talking_head');
  assert.ok(SPEND_APPROVAL_ARG in schema.function.parameters.properties);
});

/**
 * ── ⚠️⚠️ A THIRD COPY EXISTS NOW, AND THE SECOND ONE WAS FOUND BY A CRASH ────
 *
 * `avatar-run.mjs` used to IMPORT this constant from `media-pipeline.mjs`, and
 * it threw at call time — `ReferenceError: SPEND_APPROVAL_ARG is not defined`
 * from `cloneVoice`, because the constant is a COMPUTED PROPERTY KEY in a
 * destructured default parameter, so it is read on every invocation.
 *
 * ⚠️ IT DID NOT REPRODUCE UNDER NODE. Driving all 77 tools through
 * `executeToolCall` in both import orders gave zero failures. It only failed
 * under vitest, where a `.mjs` is pulled across the package boundary from a
 * `.ts` test — a loader interop difference, not a logic bug. That is precisely
 * why it survived: THIS package's suite was green and the guard that caught it
 * lives in the other repo.
 *
 * ⭐ So the string is now declared in three files, and this asserts all three
 * agree by reading the SOURCE rather than the module — a broken import is
 * exactly the failure mode being guarded, so importing to check it would beg
 * the question.
 */
test('⭐⭐ all three copies of the approval word are the same word', () => {
  const files = ['lib/media-pipeline.mjs', 'lib/avatar.mjs', 'lib/avatar-run.mjs'];
  const found = files.map((f) => {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const m = src.match(/SPEND_APPROVAL_ARG\s*=\s*'([^']+)'/);
    assert.ok(m, `${f} no longer declares SPEND_APPROVAL_ARG — if it went back to importing it, read the header there first`);
    return { file: f, value: m[1] };
  });
  for (const { file, value } of found) {
    assert.equal(value, SPEND_APPROVAL_ARG, `${file} spells the handshake differently — two words for one handshake is how a model learns to guess`);
  }
});

/* ── the estimate ────────────────────────────────────────────────────────── */

test('⭐⭐ every verb has a timing on record, and says whether anybody measured it', () => {
  for (const verb of ['clone_voice', 'design_voice', 'character_lock', 'talking_head', 'generate_video']) {
    const row = JOB_SECONDS[verb];
    assert.ok(row, `${verb} has no timing at all, so its estimate would be a bare default`);
    assert.ok(row.cold >= row.warm, 'a cold container cannot be faster than a warm one');
    assert.match(row.source, /measured|ASSUMED/, 'provenance travels with the number or it becomes a fact');
    if (!row.measured) assert.match(row.source, /ASSUMED/, 'an unmeasured number must SAY it is unmeasured');
  }
});

test('⚠️⚠️ the estimate calls itself a FLOOR, because the A100 is priced at the A10G rate', () => {
  const e = estimateJobUsd('talking_head');
  assert.match(e.basis, /FLOOR/);
  assert.match(e.basis, /A100/, 'the one verb whose card is dearer than the price table must say so');
  assert.ok(e.usd > 0);
});

test('⭐⭐ the approval bar is DERIVED, and lands on exactly the two expensive verbs', () => {
  /**
   * ⚠️ MEASURED ON THE WARM FIGURE ON PURPOSE. The first call of a process
   * carries the SAME 120 billed seconds of cold start whether it is a 9-second
   * voice clone or a 400-second render, so judging on the cold figure pushed all
   * five over the bar and made the handshake universal — the outcome a
   * confirmation nobody reads.
   */
  assert.equal(needsApproval('talking_head'), true);
  assert.equal(needsApproval('generate_video'), true);
  assert.equal(needsApproval('clone_voice'), false);
  assert.equal(needsApproval('design_voice'), false);
  assert.equal(needsApproval('character_lock'), false);

  /** And the schema advertises the handshake exactly where the runner enforces it. */
  for (const t of avatarToolSchemas(ENV)) {
    const advertised = SPEND_APPROVAL_ARG in t.function.parameters.properties;
    assert.equal(advertised, needsApproval(t.function.name),
      `${t.function.name}: a schema that advertises a handshake the runner does not enforce (or hides one it does) is the drift this pins`);
  }
});

/* ── the gate ────────────────────────────────────────────────────────────── */

test('⭐⭐⭐ a --dry-run does NOT reach the GPU — it used to render and throw the result away', async (t) => {
  resetGpuWarmth();
  resetSpendMeter();
  t.after(() => { resetGpuWarmth(); resetSpendMeter(); });

  const root = workspace();
  const stub = stubJob();
  const r = await talkingHead(root, { image: 'face.png', audio: 'voice.wav' }, {
    env: ENV, dryRun: true, fetchImpl: stub.impl, sleep: async () => {},
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'dry_run');
  assert.equal(stub.hits(), 0, 'a dry run that pays for a 400-second A100 render is the most expensive possible way to honour a flag');
  assert.ok(r.estimateUsd > 0, 'a refusal still has to say what it would have cost');
  assert.equal(gpuSpend().usd, 0);
});

test('⭐⭐ an expensive verb refuses without approval, and the refusal carries the price', async (t) => {
  resetGpuWarmth();
  t.after(() => resetGpuWarmth());
  const stub = stubJob();
  const r = await talkingHead(workspace(), { image: 'face.png', audio: 'voice.wav' }, {
    env: ENV, fetchImpl: stub.impl, sleep: async () => {},
  });
  assert.equal(r.code, 'needs_approval');
  assert.equal(stub.hits(), 0);
  assert.match(r.error, /nothing was charged/i);
  assert.match(r.error, new RegExp(SPEND_APPROVAL_ARG));
  assert.ok(r.estimateUsd >= APPROVAL_THRESHOLD_USD, 'a "no" without the number is a "no" the user cannot act on');
});

test('⭐ a CHEAP verb is not made annoying to buy the expensive ones a confirmation', async (t) => {
  resetGpuWarmth();
  resetSpendMeter();
  t.after(() => { resetGpuWarmth(); resetSpendMeter(); });

  const stub = stubJob('audio');
  const r = await cloneVoice(workspace(), { sample: 'voice.wav', text: 'hello' }, {
    env: ENV, fetchImpl: stub.impl, sleep: async () => {},
  });
  assert.equal(r.ok, true, 'clone_voice is sub-cent warm — a handshake here buys nothing and costs a round');
  assert.equal(stub.hits(), 1);
});

test('⭐⭐⭐ the ledger is written — these were the only GPU verbs charging nothing', async (t) => {
  resetGpuWarmth();
  resetSpendMeter();
  t.after(() => { resetGpuWarmth(); resetSpendMeter(); });

  await cloneVoice(workspace(), { sample: 'voice.wav', text: 'hello' }, {
    env: ENV, fetchImpl: stubJob('audio').impl, sleep: async () => {},
  });
  const spend = gpuSpend();
  assert.ok(spend.usd > 0, 'a run that spent real GPU seconds must not report $0.00 to --budget and `acuvo spend`');
  assert.ok(spend.calls.some((c) => c.verb === 'clone_voice'));
});

test('⚠️ a FAILED job is still charged — a container that answered has already billed', async (t) => {
  resetGpuWarmth();
  resetSpendMeter();
  t.after(() => { resetGpuWarmth(); resetSpendMeter(); });

  const impl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'the model fell over' }) });
  const r = await cloneVoice(workspace(), { sample: 'voice.wav', text: 'hello' }, {
    env: ENV, fetchImpl: impl, sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.ok(gpuSpend().usd > 0, 'charging only on success makes a run of failures free in the ledger and expensive on the invoice');
});

test('⭐⭐ a budget that cannot cover the FLOOR refuses before the call, not half-way through', async (t) => {
  resetGpuWarmth();
  resetSpendMeter();
  t.after(() => { resetGpuWarmth(); resetSpendMeter(); });

  const stub = stubJob();
  const budget = { canContinue: () => ({ remainingUsd: 0.0001 }) };
  const r = await generateVideo(workspace(), { prompt: 'a bicycle', [SPEND_APPROVAL_ARG]: true }, {
    env: ENV, budget, fetchImpl: stub.impl, sleep: async () => {},
  });
  assert.equal(r.code, 'over_budget');
  assert.equal(stub.hits(), 0);
  assert.match(r.error, /FLOOR/);
});

test('⚠️ no budget object, and `--budget none`, are NOT refusals', () => {
  resetGpuWarmth();
  assert.equal(preflight({ verb: 'clone_voice', endpoint: 'e1' }).go, true);
  resetGpuWarmth();
  assert.equal(preflight({ verb: 'clone_voice', endpoint: 'e1', budget: { canContinue: () => ({ remainingUsd: Infinity }) } }).go, true);
});

test('⭐ the second call to an endpoint is priced WARM, like the ledger prices it', () => {
  resetGpuWarmth();
  const first = preflight({ verb: 'clone_voice', endpoint: 'https://e' });
  assert.equal(first.cold, true);
  // `deliver` is what marks an endpoint seen, so simulate one completed call.
  preflight({ verb: 'clone_voice', endpoint: 'https://e' });
  assert.equal(first.estimateUsd > estimateJobUsd('clone_voice', { cold: false }).usd, true,
    'the cold estimate must exceed the warm one, or the cold-start charge is not reaching the number');
});

/* ── the rented backend ──────────────────────────────────────────────────── */

test('⭐⭐⭐ FAL is refused for an EMPTY BALANCE before it is refused for approval', async () => {
  /**
   * Asking somebody to approve a spend on an account with no money is a question
   * with one possible outcome, and it buries the real answer a round trip deep.
   */
  const r = preflightRented({ verb: 'generate_video', capability: 'video', env: { FAL_KEY: 'k' } });
  assert.equal(r.go, false);
  assert.equal(r.code, 'fal_out_of_balance');
});

test('⭐⭐ an UNPRICED backend says so rather than inventing a number, and always asks', () => {
  const r = preflightRented({ verb: 'generate_video', capability: 'video', env: { FAL_KEY: 'k', FAL_ACCOUNT_FUNDED: '1' } });
  assert.equal(r.go, false);
  assert.equal(r.code, 'needs_approval');
  assert.equal(r.estimateUsd, null, 'a made-up price is worse than no price, because a user acts on it');
  assert.match(r.estimateBasis, /RENTED/);

  const approved = preflightRented({ verb: 'generate_video', capability: 'video', approved: true, env: { FAL_KEY: 'k', FAL_ACCOUNT_FUNDED: '1' } });
  assert.equal(approved.go, true);
});

test('⚠️⚠️ FAL is NEVER the fallback — an unnamed backend never leaves our own GPU', async (t) => {
  resetGpuWarmth();
  resetSpendMeter();
  t.after(() => { resetGpuWarmth(); resetSpendMeter(); });

  const root = workspace();
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, video_b64: 'A'.repeat(4000), bytes: 3000, seconds: 5 }) };
  };
  await generateVideo(root, { prompt: 'x', [SPEND_APPROVAL_ARG]: true }, {
    env: { ...ENV, FAL_KEY: 'k', FAL_ACCOUNT_FUNDED: '1' }, fetchImpl: impl, sleep: async () => {},
  });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((u) => !u.includes('fal.run')),
    'a silent escalation to a rented model spends money on a decision nobody made, and would do it exactly when our GPU was having a bad day');
});

test('⭐ animating a still and generating from text are DIFFERENT FAL models, not one with a flag', async () => {
  const root = workspace();
  const urls = [];
  const impl = async (url, init = {}) => {
    urls.push(String(url));
    if (String(url).endsWith('/status')) return { ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) };
    if (String(url).startsWith('https://cdn')) {
      return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => new Uint8Array(9000).buffer };
    }
    if (init.method === 'POST') return { ok: true, status: 200, json: async () => ({ request_id: 'r' }) };
    return { ok: true, status: 200, json: async () => ({ video: { url: 'https://cdn/x.mp4' } }) };
  };
  const env = { FAL_KEY: 'k', FAL_ACCOUNT_FUNDED: '1' };

  await generateVideo(root, { prompt: 'x', backend: 'fal', [SPEND_APPROVAL_ARG]: true }, { env, fetchImpl: impl, sleep: async () => {} });
  assert.match(urls[0], /text-to-video/);

  urls.length = 0;
  await generateVideo(root, { prompt: 'x', image: 'face.png', backend: 'fal', [SPEND_APPROVAL_ARG]: true }, { env, fetchImpl: impl, sleep: async () => {} });
  assert.match(urls[0], /image-to-video/, 'sending a still to a text-to-video slug is how a picture gets silently ignored');
});

test('⭐ a FAL render writes the file and reports honestly that `acuvo spend` cannot see the cost', async (t) => {
  resetSpendMeter();
  t.after(() => resetSpendMeter());

  const root = workspace();
  const impl = async (url, init = {}) => {
    if (String(url).endsWith('/status')) return { ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) };
    if (String(url).startsWith('https://cdn')) {
      return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => new Uint8Array(9000).buffer };
    }
    if (init.method === 'POST') return { ok: true, status: 200, json: async () => ({ request_id: 'r' }) };
    return { ok: true, status: 200, json: async () => ({ video: { url: 'https://cdn/x.mp4' } }) };
  };
  const r = await generateVideo(root, { prompt: 'x', backend: 'fal', [SPEND_APPROVAL_ARG]: true }, {
    env: { FAL_KEY: 'k', FAL_ACCOUNT_FUNDED: '1' }, fetchImpl: impl, sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'fal');
  assert.ok(existsSync(join(root, r.path)));
  assert.match(r.note, /FAL invoice/);
  assert.equal(gpuSpend().usd, 0, 'writing a Modal container price for somebody else\'s machine would corrupt the one number `acuvo spend` means');
  assert.ok(readdirSync(join(root, 'video')).length > 0);
});
