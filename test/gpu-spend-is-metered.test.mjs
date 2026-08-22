/**
 * ── ⚠️⚠️ THE STATED COST OF A RUN WAS NOT THE COST OF A RUN ─────────────────
 *
 * MEASURED 2026-08-14, before any of this existed:
 *
 *     for f in imagegen media vision; do grep -n costUsd lib/$f.mjs; done
 *       imagegen.mjs → (nothing)   media.mjs → (nothing)   vision.mjs → 261
 *     grep -n "budget.record" lib/tools.mjs
 *       → 1275, 1276, 1277 (delegate) · 1482 (read_image).  Both MODEL calls.
 *
 * So every dollar of Modal GPU — the most expensive verbs in the package — was
 * invisible to `--budget`, invisible to `--fleet-budget`, and absent from
 * `acuvo spend` and the audit ledger. Three of the four things this product is
 * sold on were priced off an incomplete figure.
 *
 * ── WHAT THIS FILE PINS, AND WHY EACH ONE IS HERE ────────────────────────────
 *
 *   1. THE PRICE IS THE MEASURED ONE. $0.0398 for a cold isolated render, not
 *      the $0.003 the codebase quoted in three places. If someone "tidies" the
 *      cold-start allowance away, the anchor test goes red.
 *   2. ONE BOOK. A GPU charge lands against the same ceiling as a model round,
 *      and is claimed by exactly one governor even when several share a process.
 *   3. IT DOES NOT CORRUPT THE PROJECTION. GPU dollars must not enter the round
 *      trend, or one image would project the next round at four cents and stop
 *      a run that could afford to finish.
 *   4. ⭐ THE ESTIMATE IS LABELLED EVERYWHERE IT IS REPORTED. A price-table
 *      figure presented as a bill is worse than the leak it replaced.
 *   5. ⭐⭐ A RUN THAT SPENDS NO GPU IS BYTE-IDENTICAL. Adding metering must not
 *      silently change the output of every run in the product.
 *
 * ⭐ $0.00 to run. Every service call here is a stub; nothing reaches a network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBudget, chargeGpu, chargeEstimate, gpuSpend, resetSpendMeter,
  priceGpuCall, USD_PER_SECOND, COLD_START_SECONDS, SCALEDOWN_WINDOW_SECONDS,
} from '../lib/budget.mjs';
import { auditRecord, serializeRecord } from '../lib/audit.mjs';
import { summariseSpend, formatSpend } from '../lib/spend.mjs';
import { seePage, speak } from '../lib/media.mjs';
import { generateViaOwnEngine, generateViaPollinations } from '../lib/imagegen.mjs';
import { readImage, resetVisionState } from '../lib/vision.mjs';

test.beforeEach(() => { resetSpendMeter(); resetVisionState(); });
test.afterEach(() => { resetSpendMeter(); });

const tempRoot = (files = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'gpu-meter-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
};

/* ── 1. THE PRICE ───────────────────────────────────────────────────────── */

test('⭐ the measured anchor: a cold isolated image render is $0.0398, not $0.003', () => {
  /**
   * ⚠️ THIS IS THE WHOLE FINDING IN ONE ASSERTION. The old figure counted the
   * ~10 render seconds and pretended the container was already up and would
   * never scale down. Real billing is 60s boot + 10s render + 60s scaledown.
   */
  const cold = priceGpuCall({ verb: 'generate_image', seconds: 10, cold: true });
  assert.equal(cold.billedSeconds, 130, 'a cold render bills ~130s, not ~10s');
  assert.equal(cold.usd.toFixed(4), '0.0398', `expected $0.0398, got ${cold.usd}`);

  // ⭐ And the number the codebase used to quote is what a WARM render costs —
  //    which is why the cold start is charged once per endpoint, not per call.
  const warm = priceGpuCall({ verb: 'generate_image', seconds: 10, cold: false });
  assert.equal(warm.usd.toFixed(4), '0.0031', `the warm render is the old $0.003 figure, got ${warm.usd}`);
  assert.ok(cold.usd / warm.usd > 12, 'the stale number was wrong by more than 12x');
});

test('the arithmetic is the published rate table, not a magic constant', () => {
  const expected = (COLD_START_SECONDS.gpu + 10 + SCALEDOWN_WINDOW_SECONDS) * USD_PER_SECOND.gpu;
  assert.equal(priceGpuCall({ verb: 'generate_image', seconds: 10, cold: true }).usd, expected);
});

test('a CPU verb is not priced as a GPU one — see_page is a browser, not an A10G', () => {
  const gpu = priceGpuCall({ verb: 'generate_image', seconds: 30, cold: true });
  const cpu = priceGpuCall({ verb: 'see_page', seconds: 30, cold: true });
  assert.ok(cpu.usd < gpu.usd / 5, `a headless render must be far cheaper (${cpu.usd} vs ${gpu.usd})`);
  assert.equal(cpu.class, 'cpu');
});

test('an unknown verb is priced on the expensive side rather than free', () => {
  const unknown = priceGpuCall({ verb: 'some_future_verb', seconds: 10, cold: true });
  assert.ok(unknown.usd > 0, 'a verb nobody added to the table must never be free');
  assert.equal(unknown.class, 'gpu', 'and it defaults to the expensive class, not the cheap one');
});

test('the cold start is charged ONCE per endpoint per process', () => {
  const a = chargeGpu({ verb: 'generate_image', seconds: 10, endpoint: 'https://engine' });
  const b = chargeGpu({ verb: 'generate_image', seconds: 10, endpoint: 'https://engine' });
  assert.equal(a.billedSeconds, 130);
  assert.equal(b.billedSeconds, 10, 'the second call rides a container already paid for');

  // ⚠️ A DIFFERENT endpoint is a different container and pays its own boot.
  const other = chargeGpu({ verb: 'speak', seconds: 5, endpoint: 'https://tts' });
  assert.equal(other.billedSeconds, 125);
});

test('a free provider is charged nothing AND recorded nothing', () => {
  assert.equal(chargeGpu({ verb: 'generate_image', seconds: 40, free: true }), null);
  assert.equal(gpuSpend().usd, 0);
  assert.equal(gpuSpend().calls.length, 0, 'a zero entry would grow a GPU section on a run that spent nothing');
});

/* ── 2. ONE BOOK: THE SAME CEILING ──────────────────────────────────────── */

test('⭐ a GPU call counts against --budget, and stops the run', () => {
  const b = createBudget({ limitUsd: 0.01 });
  assert.equal(b.canContinue().ok, true, 'a cent is plenty for model rounds');
  b.record({ costUsd: 0.0002 });

  chargeGpu({ verb: 'generate_image', seconds: 10, endpoint: 'https://engine' }); // $0.0398

  const verdict = b.canContinue();
  assert.equal(verdict.ok, false, 'a four-cent render must not fit inside a one-cent ceiling');
  assert.equal(verdict.reason, 'limit-reached');
  assert.ok(verdict.spentUsd > 0.039, `the ceiling sees the GPU dollars (${verdict.spentUsd})`);
  assert.equal(verdict.estimated, true, 'and a total containing GPU time is always an estimate');
  assert.match(verdict.message, /ESTIMATED GPU time/, 'the stop message says which dollars were guessed');
});

test('the split is available, so "one number" never means "one unexplained number"', () => {
  const b = createBudget({ limitUsd: 1 });
  b.record({ costUsd: 0.002 });
  chargeGpu({ verb: 'see_page', seconds: 20, endpoint: 'https://render' });
  const s = b.stats();
  assert.equal(s.modelUsd, 0.002);
  assert.ok(s.gpuUsd > 0);
  assert.equal(s.gpuCalls, 1);
  assert.equal(s.spentUsd, s.modelUsd + s.gpuUsd, 'the total is exactly the two halves');
});

test('⭐ a charge is claimed by exactly ONE governor — --parallel must not double-bill', () => {
  /**
   * ⚠️ `--parallel` and `--best-of` run several sessions in one process. A
   * shared running total would charge each sibling for all of them, and an
   * over-charge stops correct work just as surely as an under-charge hides a
   * bill.
   */
  const a = createBudget({ limitUsd: 1 });
  const b = createBudget({ limitUsd: 1 });
  chargeGpu({ verb: 'generate_image', seconds: 10, endpoint: 'https://engine' });

  const first = a.stats().gpuUsd;
  const second = b.stats().gpuUsd;
  assert.ok(first > 0, 'somebody has to take the charge');
  assert.equal(second, 0, 'and only one of them may');
  assert.equal(first + second, gpuSpend().usd, 'the sum across instances equals the ledger');
});

test('a charge made after the last round still reaches the summary', () => {
  /**
   * ⚠️ THE LAST-ROUND CASE IS THE ONE A NAIVE DRAIN LOSES. `canContinue()` is
   * not asked again after the loop ends, so if only that method drained, a GPU
   * verb called on the final round would vanish from the report and the record.
   */
  const b = createBudget({ limitUsd: 1 });
  b.record({ costUsd: 0.001 });
  chargeGpu({ verb: 'speak', seconds: 4, endpoint: 'https://tts' });
  assert.match(b.report(), /GPU time on 1 call/, 'report() drains too');
});

/* ── 3. IT MUST NOT CORRUPT THE PROJECTION ──────────────────────────────── */

test('⚠️ GPU dollars never enter the round trend', () => {
  const b = createBudget({ limitUsd: 10 });
  for (let i = 0; i < 3; i += 1) b.record({ costUsd: 0.0002 });
  const before = b.projectNext();

  chargeGpu({ verb: 'generate_image', seconds: 10, endpoint: 'https://engine' });
  b.canContinue();
  const after = b.projectNext();

  assert.deepEqual(after, before, 'the next MODEL round still costs what a model round costs');
  assert.ok(after.usd < 0.001, `a $0.04 render must not project a $0.04 round (${after.usd})`);
});

/* ── 4. THE ESTIMATE IS LABELLED WHEREVER IT IS REPORTED ────────────────── */

test('⭐⭐ report() says the GPU figure is estimated and why', () => {
  const b = createBudget({ limitUsd: 1 });
  b.record({ costUsd: 0.001 });
  chargeGpu({ verb: 'generate_image', seconds: 10, endpoint: 'https://engine' });
  const line = b.report();
  assert.match(line, /ESTIMATED from a price table/);
  assert.match(line, /not billed per call/, 'the reason it is an estimate, not just the word');
});

test('the audit record separates the billed half from the arithmetic half', () => {
  chargeGpu({ verb: 'generate_image', seconds: 10, endpoint: 'https://engine' });
  const rec = auditRecord(
    { ok: true, usage: { cost: 0.002 }, rounds: [], budget: { gpuUsd: gpuSpend().usd } },
    { now: '2026-08-14T00:00:00.000Z' },
  );
  assert.ok(rec.run.costUsd > 0.041, 'costUsd is what the RUN cost, both halves');
  assert.equal(rec.run.cost.modelUsd, 0.002, 'the billed half is named');
  assert.ok(rec.run.cost.estimatedUsd > 0.039, 'and so is the guessed half');
  assert.equal(rec.run.cost.estimated, true);
  assert.equal(rec.run.cost.calls[0].verb, 'generate_image', 'itemised, so a total can be checked');
  assert.match(rec.run.cost.calls[0].basis, /measured/, 'each call says how its number was derived');
});

test('⚠️ a model cost the provider never reported stays null, and is not turned into zero', () => {
  chargeGpu({ verb: 'see_page', seconds: 20, endpoint: 'https://render' });
  const rec = auditRecord(
    { ok: true, usage: null, rounds: [], budget: { gpuUsd: gpuSpend().usd } },
    { now: '2026-08-14T00:00:00.000Z' },
  );
  assert.equal(rec.run.cost.modelUsd, null, 'unknown is unknown, even beside a known GPU figure');
  assert.equal(rec.run.costUsd, rec.run.cost.estimatedUsd, 'the total is only what we do know');
});

test('acuvo spend prints the estimated share on its own line', () => {
  const line = JSON.stringify({
    at: '2026-08-14T01:00:00.000Z',
    run: { ok: true, costUsd: 0.0418, cost: { modelUsd: 0.002, estimatedUsd: 0.0398, estimated: true }, model: { answered: 'x' } },
  });
  const summary = summariseSpend([{ name: 'a.jsonl', text: `${line}\n` }]);
  assert.ok(summary.estimatedUsd > 0.039);
  assert.equal(summary.estimatedRuns, 1);
  const out = formatSpend(summary).join('\n');
  assert.match(out, /ESTIMATED GPU time/);
  assert.match(out, /not billed per call/);
});

/* ── 5. ⭐⭐ A RUN WITH NO GPU IS BYTE-IDENTICAL ─────────────────────────── */

test('⭐⭐ a run that spends no GPU reports byte-for-byte what it did before', () => {
  const b = createBudget({ limitUsd: 0.05 });
  for (let i = 0; i < 4; i += 1) b.record({ costUsd: 0.0012 });

  // The exact string `budget.test.mjs` has pinned since before this change.
  assert.equal(
    b.report(),
    'budget: $0.0048 of $0.0500 spent · 4 rounds · next ~$0.0013 · $0.0452 left',
  );
  assert.equal(b.canContinue().estimated, false, 'no GPU means the total is not an estimate');
  assert.equal('gpuUsd' in b.toJSON(), false, '--json gains no key it did not have');

  const outcome = { ok: true, usage: { cost: 0.0048 }, rounds: [], budget: b.toJSON() };
  const rec = auditRecord(outcome, { now: '2026-08-14T00:00:00.000Z' });
  assert.equal('cost' in rec.run, false, 'no cost block on a run that had nothing to explain');
  assert.equal(rec.run.costUsd, 0.0048, 'and costUsd is untouched');
  assert.equal(rec.v, 1, 'the schema version does not move for a field that is absent');

  // The whole serialised line, so a stray key anywhere fails this.
  assert.equal(serializeRecord(rec).includes('"cost"'), false);

  const summary = summariseSpend([{ name: 'a.jsonl', text: serializeRecord(rec) }]);
  assert.equal(summary.estimatedUsd, 0);
  assert.equal(formatSpend(summary).some((l) => /ESTIMATED/.test(l)), false, 'and spend says nothing new');
});

test('⭐⭐ the STOP MESSAGES are byte-identical too when no GPU was spent', () => {
  /**
   * ⚠️ THIS TEST EXISTS BECAUSE MUTATION TESTING FOUND THE HOLE. Breaking
   * `gpuClause()` so it fired on a zero-GPU run left all 25 other tests GREEN:
   * `report()` builds its own clause, and nothing pinned the sentence a user
   * actually reads when the run STOPS. The refusal messages are the most-read
   * strings in the package and they were the unguarded ones.
   */
  const spent = createBudget({ limitUsd: 0.001 });
  spent.record({ costUsd: 0.001 });
  const reached = spent.canContinue();
  assert.equal(reached.reason, 'limit-reached');
  assert.equal(
    reached.message,
    'budget spent: $0.0010 of $0.0010 after 1 round. Raise it with --budget if the job needs more.',
    'no parenthetical about GPU time on a run that used none',
  );

  const tight = createBudget({ limitUsd: 0.0012 });
  tight.record({ costUsd: 0.001 });
  const exceeds = tight.canContinue();
  assert.equal(exceeds.reason, 'would-exceed');
  assert.equal(
    exceeds.message,
    'stopping on budget after 1 round: $0.0010 of $0.0012 spent and the next round is projected at '
      + '~$0.0011, which would cross the line. Raise it with --budget if the job needs more.',
  );
});

/* ── 6. REACH: THE REAL FUNCTIONS, NOT THE METER IN ISOLATION ───────────── */

test('⭐ REACH — see_page charges the ledger through the real function', async () => {
  const root = tempRoot({ 'p.html': '<html><body><h1>hi</h1></body></html>' });
  try {
    const r = await seePage(root, 'p.html', {
      env: { RENDER_AUDIT_URL: 'https://render.example', ACUVO_MEDIA_SECRET: 's' },
      fetchImpl: async () => new Response(
        JSON.stringify({ ok: true, measurement: { viewport: { width: 1280, height: 900 }, paintedRatio: 0.4 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    });
    assert.equal(r.ok, true);
    const spend = gpuSpend();
    assert.equal(spend.calls.length, 1, 'the render was charged');
    assert.equal(spend.calls[0].verb, 'see_page', 'and charged under the verb the user typed');
    assert.ok(spend.usd > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ REACH — speak charges the ledger too (one choke point, six verbs)', async () => {
  const root = tempRoot();
  try {
    await speak(root, 'hello', 'out.wav', {
      env: { MODAL_TTS_URL: 'https://tts.example', ACUVO_MEDIA_SECRET: 's' },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, audio_b64: Buffer.from('x').toString('base64') }), { status: 200 }),
    });
    assert.equal(gpuSpend().calls[0].verb, 'speak');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ REACH — our own image engine charges the headline $0.0398', async () => {
  const root = tempRoot();
  try {
    const r = await generateViaOwnEngine({
      prompt: 'a red cube',
      executor: { root },
      env: { ACUVO_IMAGE_ENGINE_URL: 'https://engine.example', ACUVO_IMAGE_SECRET: 's' },
      fetchImpl: async () => new Response(
        JSON.stringify({ ok: true, image_b64: 'A'.repeat(200) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    });
    assert.equal(r.ok, true);
    const spend = gpuSpend();
    assert.equal(spend.calls.length, 1);
    // A stubbed fetch returns instantly, so the wall time is ~0 and the charge
    // is the cold-start allowance alone — which is the bulk of a real render.
    assert.ok(spend.usd > 0.036, `expected roughly the cold-start cost, got ${spend.usd}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a request that never got a reply is charged nothing — no container ran', async () => {
  const root = tempRoot();
  try {
    const r = await generateViaOwnEngine({
      prompt: 'a red cube',
      executor: { root },
      env: { ACUVO_IMAGE_ENGINE_URL: 'https://engine.example', ACUVO_IMAGE_SECRET: 's' },
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.equal(r.ok, false);
    assert.equal(gpuSpend().usd, 0, 'billing a boot that never happened is fiction in the other direction');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a REFUSAL is charged — a container that answers is a container that billed', async () => {
  const root = tempRoot();
  try {
    const r = await generateViaOwnEngine({
      prompt: 'a red cube',
      executor: { root },
      env: { ACUVO_IMAGE_ENGINE_URL: 'https://engine.example', ACUVO_IMAGE_SECRET: 's' },
      // Measured shape: this service answers 200 with ok:false on a bad secret.
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'unauthorised' }), { status: 200 }),
    });
    assert.equal(r.ok, false);
    assert.ok(gpuSpend().usd > 0, 'the GPU woke up and charged us whatever it decided about the secret');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the free fallback engine is not charged to us', async () => {
  const root = tempRoot();
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 1)]);
    const r = await generateViaPollinations({
      prompt: 'a red cube',
      executor: { root },
      fetchImpl: async () => new Response(png, { status: 200 }),
    });
    assert.equal(r.ok, true);
    assert.equal(gpuSpend().usd, 0, 'somebody else paid for that one');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 7. THE OTHER "UNKNOWN PRICED AS FREE" ──────────────────────────────── */

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100'
  + '05fe02fea7000000049454e44ae426082', 'hex',
);

async function look(root, usage) {
  return readImage({
    root,
    path: 'x.png',
    apiKey: 'k',
    fetchImpl: async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'a white pixel' } }], ...(usage ? { usage } : {}) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
}

test('⚠️ a vision call the provider did not price is estimated, not made free', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gpu-meter-v-'));
  writeFileSync(join(root, 'x.png'), PNG_1x1);
  try {
    const r = await look(root, null);
    assert.equal(r.ok, true);
    assert.equal(r.costUsd, null, 'we still do not claim a reported cost we never got');
    const spend = gpuSpend();
    assert.equal(spend.calls.length, 1, 'but the governor is told something was spent');
    assert.equal(spend.calls[0].kind, 'vision');
    assert.ok(spend.calls[0].usd > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a vision call the provider DID price is not double-charged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gpu-meter-v2-'));
  writeFileSync(join(root, 'x.png'), PNG_1x1);
  try {
    const r = await look(root, { cost: 0.00006 });
    assert.equal(r.costUsd, 0.00006, 'the reported figure is passed through for tools.mjs to charge');
    assert.equal(gpuSpend().calls.length, 0, 'and the estimate ledger stays out of it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an explicit $0.00 from the provider is believed, not overridden', () => {
  /**
   * ⚠️ `budget.mjs` states the rule: an explicit zero is DATA, an absent field
   * is not. `chargeEstimate` refuses a zero so a genuinely free call cannot be
   * "helpfully" repriced — the check-that-fails-correct-work trap.
   */
  assert.equal(chargeEstimate({ kind: 'vision', verb: 'read_image', usd: 0 }), null);
  assert.equal(gpuSpend().usd, 0);
});
