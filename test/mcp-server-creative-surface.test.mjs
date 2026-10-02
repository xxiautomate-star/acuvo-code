/**
 * ── WHAT THIS FILE PINS: THAT THE METER FOLLOWS THE CALL ────────────────────
 *
 * ⚠️ THE DEFECT THIS FILE EXISTS FOR, MEASURED 2026-08-29 by driving the real
 * `createMcpServer` with a fake renderer:
 *
 *     meter AFTER the call: usd= 0.0028081053 calls= 1
 *     workspace .acuvo exists?  false
 *     audit dir exists?         false
 *     spend.jsonl exists?       false
 *     server exposes a spend accessor? []
 *
 * `chargeGpu` was writing into a module-level array in `budget.mjs` that
 * nothing in the MCP process ever read, on a DAEMON that lives for days. Every
 * dollar an MCP host spent was recorded into memory and thrown away. The two
 * tools this server already served — `see_page` and `make_document` — were the
 * unmetered ones, which is why the creative verbs could not be served at all.
 *
 * ⭐ SO THE ASSERTIONS HERE ARE ABOUT MONEY, AND THREE OF THEM MATTER MOST:
 *
 *   1. A spending call leaves a REAL LINE ON DISK, in the file `acuvo spend`
 *      already reads. Proven by reading it back, not by an accessor agreeing
 *      with itself.
 *   2. A call past the ceiling is refused with NOTHING SENT — proven by the
 *      fake transport never being invoked, not by an `isError` flag.
 *   3. RESTARTING THE SERVER CANNOT REFILL THE CEILING. That is the one an
 *      attacker actually reaches for: kill the pipe, reconnect, spend again.
 *
 * ⚠️ NOT ONE TEST HERE SPENDS A CENT. Every GPU call goes through an injected
 * `fetchImpl`, and the charge is real because `media.mjs` prices the WALL CLOCK
 * of whatever answered — a fake response is charged exactly like a real one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resetSpendMeter } from '../lib/budget.mjs';
import { parseAuditLog } from '../lib/audit.mjs';
import {
  createMcpServer,
  redactCreativeResult,
  resolveSpendCeiling,
  CREATIVE_TOOLS,
  CREATIVE_SPEND_TOOLS,
  REFUSED_TOOL_REASONS,
  MAX_MCP_SPEND_USD,
  DEFAULT_MCP_SPEND_USD,
  SPEND_RUN_KEY,
} from '../lib/mcp-server.mjs';

function scratchWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-mcp-creative-'));
  writeFileSync(join(dir, 'README.md'), '# hello\n', 'utf8');
  return dir;
}

async function call(server, name, args) {
  return server.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
}

const listNames = (server) => server.listTools().map((t) => t.name);

/** A render service that is configured but whose transport we own. */
const RENDER_ON = Object.freeze({
  RENDER_AUDIT_URL: 'https://render.invalid/audit',
  MODAL_PRESS_URL: '', MODAL_DOC_READ_URL: '', MODAL_TABLE_READ_URL: '', MODAL_TTS_URL: '',
});

/**
 * ⚠️ A COUNTING TRANSPORT, BECAUSE "NOTHING WAS SENT" IS THE CLAIM. An
 * `isError` reply is what the code says happened; a call counter that never
 * moved is what actually happened. Same argument the surface test makes for
 * asserting the missing file before the message.
 */
function countingFetch() {
  const state = { calls: 0 };
  const impl = async () => {
    state.calls += 1;
    return new Response('{"ok":false,"error":"fake renderer"}', { status: 500 });
  };
  impl.state = state;
  return impl;
}

/** Reads the ledger the same way `acuvo spend` does. */
function auditLines(dir) {
  const auditDir = join(dir, '.acuvo', 'audit');
  if (!existsSync(auditDir)) return [];
  const out = [];
  for (const name of readdirSync(auditDir)) {
    out.push(...parseAuditLog(readFileSync(join(auditDir, name), 'utf8')).records);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE THREE SWITCHES
// ─────────────────────────────────────────────────────────────────────────────

test('the creative group needs a root, a write opt-in AND a dollar ceiling — any one missing and nothing is offered', () => {
  const dir = scratchWorkspace();
  try {
    const cases = [
      ['no root', { workspaceRoot: null, allowWrite: true, allowSpend: '0.25' }],
      ['no write', { workspaceRoot: dir, allowWrite: false, allowSpend: '0.25' }],
      ['no ceiling', { workspaceRoot: dir, allowWrite: true, allowSpend: undefined }],
    ];
    for (const [why, opts] of cases) {
      const server = createMcpServer({ env: { ...RENDER_ON }, ...opts });
      const names = listNames(server);
      for (const verb of CREATIVE_TOOLS) {
        assert.ok(!names.includes(verb), `${verb} was offered with ${why}`);
      }
      assert.equal(server.creativeEnabled, false, `creativeEnabled was true with ${why}`);
    }
    // And with all three, they arrive.
    const on = createMcpServer({ env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.25' });
    assert.ok(listNames(on).includes('list_engines'));
    assert.ok(listNames(on).includes('generate_image'));
    assert.equal(on.creativeEnabled, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('speak is offered only when a speech service is configured — never as a dead button', () => {
  const dir = scratchWorkspace();
  try {
    const off = createMcpServer({
      env: { ...RENDER_ON, MODAL_TTS_URL: '' }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.25',
    });
    assert.ok(!listNames(off).includes('speak'), 'speak was offered with no speech service');
    /**
     * ⚠️ THE OFFER IS **AND**ed WITH `process.env`, exactly as read_document is,
     * because `media.mjs` reads the real environment when the call actually
     * runs. Setting the URL on the injected env ALONE must not light it up —
     * that would ship a control answering "not configured" on every call.
     */
    const injectedOnly = createMcpServer({
      env: { ...RENDER_ON, MODAL_TTS_URL: 'https://tts.invalid/say' },
      workspaceRoot: dir, allowWrite: true, allowSpend: '0.25',
    });
    const liveToo = Boolean(process.env.MODAL_TTS_URL || process.env.MODAL_VIDEO_SECRET || process.env.ACUVO_MEDIA_SECRET);
    assert.equal(
      listNames(injectedOnly).includes('speak'), liveToo,
      'speak must be offered only when BOTH the injected env and process.env can reach a speech service',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a money verb called with the ceiling unset does nothing and names the switch', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true });
    for (const verb of CREATIVE_SPEND_TOOLS) {
      const reply = await call(server, verb, { prompt: 'a cat', text: 'hello', path: 'out.bin' });
      assert.equal(existsSync(join(dir, 'out.bin')), false, `${verb} wrote a file despite the refusal`);
      assert.equal(reply.result.isError, true, `${verb} must be refused`);
      assert.match(reply.result.content[0].text, /ACUVO_MCP_SPEND/, `${verb} must name the switch that is off`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE CEILING IS A NUMBER, AND "true" IS AN ERROR
// ─────────────────────────────────────────────────────────────────────────────

test('ACUVO_MCP_SPEND takes dollars — the yes-words are refused rather than guessed at', () => {
  for (const yes of ['true', 'yes', 'on', 'unlimited', 'none']) {
    const out = resolveSpendCeiling(yes);
    assert.equal(out.ok, false, `"${yes}" must not silently become a ceiling`);
    assert.match(out.reason, /DOLLAR AMOUNT/);
  }
  for (const off of ['', undefined, null, false]) {
    assert.deepEqual(resolveSpendCeiling(off), { ok: true, usd: null });
  }
  assert.deepEqual(resolveSpendCeiling('0.25'), { ok: true, usd: 0.25 });
  assert.deepEqual(resolveSpendCeiling('$1.50'), { ok: true, usd: 1.5 });
  assert.deepEqual(resolveSpendCeiling(true), { ok: true, usd: DEFAULT_MCP_SPEND_USD });
});

test('the ceiling an operator may authorise over this transport is capped', () => {
  const over = resolveSpendCeiling(String(MAX_MCP_SPEND_USD + 1));
  assert.equal(over.ok, false);
  assert.match(over.reason, /capped/);
  assert.equal(resolveSpendCeiling(String(MAX_MCP_SPEND_USD)).ok, true);
  for (const bad of ['-1', '0', 'banana']) {
    assert.equal(resolveSpendCeiling(bad).ok, false, `${bad} must be refused`);
  }
});

test('a refused ceiling darkens the creative group and survives to the operator', () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({
      env: { ...RENDER_ON, ACUVO_MCP_SPEND: 'true' }, workspaceRoot: dir, allowWrite: true,
    });
    assert.ok(server.spendError, 'the reason must survive to stderr');
    assert.equal(server.spendCeilingUsd, null);
    assert.equal(server.creativeEnabled, false);
    for (const verb of CREATIVE_TOOLS) assert.ok(!listNames(server).includes(verb));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE LEDGER — a real line on disk, in the file `acuvo spend` reads
// ─────────────────────────────────────────────────────────────────────────────

test('⭐ a spending call is charged, journalled AND written to the audit log the CLI already reads', async () => {
  const dir = scratchWorkspace();
  resetSpendMeter();
  try {
    const fetchImpl = countingFetch();
    const server = createMcpServer({
      env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.25', fetchImpl,
    });

    assert.equal(server.spentUsd, 0, 'nothing spent before the call');
    assert.equal(existsSync(join(dir, '.acuvo', 'audit')), false, 'no audit before the call');

    const reply = await call(server, 'see_page', { html: '<h1>hi</h1>' });
    // The render itself fails — that is fine and is the point. The container
    // was still booted, so the money was still spent.
    assert.equal(reply.result.isError, true);
    assert.equal(fetchImpl.state.calls, 1, 'the render must actually have been attempted');

    // 1. The server can now answer "what has this cost", which it could not before.
    assert.ok(server.spentUsd > 0, `nothing was charged (spentUsd=${server.spentUsd})`);
    assert.equal(server.ledgerError, null, `the ledger failed: ${server.ledgerError}`);

    // 2. The journal carries the total, so a restart cannot forget it.
    const journal = readFileSync(join(dir, '.acuvo', 'spend.jsonl'), 'utf8');
    const rows = journal.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.k === SPEND_RUN_KEY && r.c === 0.25), 'the ceiling line is missing');
    const spent = rows.filter((r) => r.k === SPEND_RUN_KEY && typeof r.u === 'number');
    assert.ok(spent.length > 0 && spent.at(-1).u > 0, `the journal recorded no spend: ${journal}`);

    // 3. ⭐ THE AUDIT LINE. Same file, same shape, same reader as a normal run.
    const records = auditLines(dir);
    assert.equal(records.length, 1, 'exactly one audit record for one spending call');
    const rec = records[0];
    assert.equal(rec.run.task, 'mcp:see_page', 'the record must name the verb that spent');
    assert.ok(rec.run.costUsd > 0, 'the audit line must carry the dollars');
    assert.equal(rec.run.cost.estimated, true, 'GPU dollars are a price table, never a bill');
    assert.equal(rec.run.cost.calls[0].verb, 'see_page');
    assert.ok(rec.run.cost.calls[0].billedSeconds > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a call that spends nothing writes no ledger line — a zero-dollar record is a lie about a free run', async () => {
  const dir = scratchWorkspace();
  resetSpendMeter();
  try {
    const server = createMcpServer({
      env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.25', fetchImpl: countingFetch(),
    });
    const reply = await call(server, 'read_file', { path: 'README.md' });
    assert.equal(reply.result.isError, undefined);
    assert.equal(server.spentUsd, 0);
    assert.equal(existsSync(join(dir, '.acuvo', 'audit')), false, 'a free read wrote an audit record');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE REFUSAL — proven by the transport never being touched
// ─────────────────────────────────────────────────────────────────────────────

test('⭐ once the ceiling is spent the next call is refused BEFORE anything is sent', async () => {
  const dir = scratchWorkspace();
  resetSpendMeter();
  try {
    const fetchImpl = countingFetch();
    /**
     * ⚠️ A CEILING SMALLER THAN ONE COLD CONTAINER. `priceGpuCall` bills 80
     * seconds of cold start and scaledown for a CPU render before a byte is
     * drawn, so $0.001 cannot cover even one — which is exactly the case the
     * pre-flight floor exists for.
     */
    const server = createMcpServer({
      env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.001', fetchImpl,
    });

    const reply = await call(server, 'see_page', { html: '<h1>hi</h1>' });

    assert.equal(fetchImpl.state.calls, 0, 'THE RENDER WAS SENT despite the ceiling — money moved');
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /nothing was charged/i);
    assert.equal(server.spentUsd, 0, 'a refused call must not be charged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the ceiling refuses the SECOND call after the first one used the room up', async () => {
  const dir = scratchWorkspace();
  resetSpendMeter();
  try {
    const fetchImpl = countingFetch();
    // Enough for one cold CPU render (~$0.0028) and nowhere near two.
    const server = createMcpServer({
      env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.004', fetchImpl,
    });
    await call(server, 'see_page', { html: '<h1>one</h1>' });
    assert.equal(fetchImpl.state.calls, 1, 'the first call should have gone through');
    assert.ok(server.spentUsd > 0);

    const second = await call(server, 'see_page', { html: '<h1>two</h1>' });
    assert.equal(fetchImpl.state.calls, 1, 'the SECOND render was sent past the ceiling');
    assert.equal(second.result.isError, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ⭐⭐ RESTARTING THE SERVER IS NOT A WAY TO REFILL THE CEILING
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐ a fresh server on the same workspace inherits what the last one spent', async () => {
  const dir = scratchWorkspace();
  resetSpendMeter();
  try {
    const first = createMcpServer({
      env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.004', fetchImpl: countingFetch(),
    });
    await call(first, 'see_page', { html: '<h1>one</h1>' });
    assert.ok(first.spentUsd > 0);

    /**
     * ⚠️ THE MODULE METER IS RESET, WHICH IS THE WHOLE POINT. A new PROCESS
     * starts with an empty `chargeGpu` ledger; if the ceiling lived only in
     * memory, killing the pipe and reconnecting would be free money. The
     * journal on disk is what has to carry it.
     */
    resetSpendMeter();
    const fetchImpl = countingFetch();
    const second = createMcpServer({
      env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.004', fetchImpl,
    });
    const reply = await call(second, 'see_page', { html: '<h1>two</h1>' });
    assert.equal(fetchImpl.state.calls, 0, 'RESTARTING THE SERVER REFILLED THE CEILING — money moved');
    assert.equal(reply.result.isError, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐⭐ restarting with a BIGGER ceiling does not widen the one already recorded', async () => {
  const dir = scratchWorkspace();
  resetSpendMeter();
  try {
    const first = createMcpServer({
      env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '0.004', fetchImpl: countingFetch(),
    });
    assert.equal(first.spendCeilingUsd, 0.004);

    resetSpendMeter();
    const second = createMcpServer({
      env: { ...RENDER_ON }, workspaceRoot: dir, allowWrite: true, allowSpend: '2', fetchImpl: countingFetch(),
    });
    assert.equal(second.spendCeilingUsd, 0.004, 'a restart widened the ceiling — a crash must not be a refill');
    assert.ok(second.resumeNote, 'and it must say so');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE DISCLOSURE list_engines WAS ORIGINALLY REFUSED FOR
// ─────────────────────────────────────────────────────────────────────────────

test('⭐ list_engines never carries the operator\'s plan tier, credit balance or the prose that quotes them', () => {
  const raw = {
    ok: true,
    pricesFrom: 'live',
    tier: 'scale',
    creditsRemaining: 41_812,
    engines: [{ id: 'acuvo-image', credits: 4 }],
    note: 'An Ultra engine runs only when it is named.',
    text: 'Plan: scale · 41,812 credits remaining\n  Acuvo Image — 4 credits',
  };
  const out = redactCreativeResult('list_engines', raw);

  assert.equal('tier' in out, false, 'the operator\'s plan tier crossed the wire');
  assert.equal('creditsRemaining' in out, false, 'the operator\'s balance crossed the wire');
  assert.equal('text' in out, false, 'formatEngineList\'s prose quotes the balance in words');
  // ⚠️ The serialised form is what actually reaches the model, so check THAT too.
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes('41812') && !wire.includes('41,812'), `the balance leaked: ${wire}`);
  assert.ok(!wire.includes('scale'), 'the tier leaked');

  // And the capability itself survives — a redaction that removed the prices
  // would leave a model unable to tell a 4-credit image from a 193-credit clip.
  assert.equal(out.engines[0].credits, 4);
  assert.match(out.note, /does not report the operator/);

  // Every other tool passes through untouched.
  assert.equal(redactCreativeResult('read_file', raw), raw);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. WHAT STAYED REFUSED, AND WHY IT MUST NOT DRIFT BACK TO A MONEY REASON
// ─────────────────────────────────────────────────────────────────────────────

test('the identity verbs are refused on CONSENT, not on cost — a ledger must not read as having answered them', () => {
  /**
   * ⚠️ THE POINT OF THIS TEST. Three of these were refused on spend alone
   * ("no spending limit we can see"), and this file BUILT that limit. A future
   * reader who finds a money-only reason beside a working ceiling will
   * reasonably conclude the refusal is obsolete and serve the verb — which is
   * how somebody's face ends up in a video nobody asked them about.
   */
  for (const verb of ['clone_voice', 'character_lock', 'talking_head']) {
    const why = REFUSED_TOOL_REASONS[verb];
    assert.ok(why, `${verb} must still be refused`);
    assert.match(why, /REAL (PERSON|FACE)|consent|right to that/i,
      `${verb}'s refusal must rest on consent, not on money: ${why}`);
  }
});

test('the two unmeterable verbs say WHY no ceiling can see them', () => {
  // budget.mjs's SERVICE_CLASS table omits lib/image-edit.mjs by its own note,
  // so these two charge nothing at all — a ceiling cannot bound what is never
  // priced, which is the decisive reason and must be the one written down.
  for (const verb of ['edit_image', 'expand_image']) {
    assert.match(REFUSED_TOOL_REASONS[verb], /unmetered|charges nothing|never calls chargeGpu/i);
  }
});

test('every creative verb is decided — none of them is quietly both served and refused', () => {
  for (const verb of CREATIVE_TOOLS) {
    assert.ok(!(verb in REFUSED_TOOL_REASONS), `${verb} is served AND refused`);
  }
  for (const verb of CREATIVE_SPEND_TOOLS) {
    assert.ok(CREATIVE_TOOLS.includes(verb), `${verb} spends but is not in the creative group`);
  }
});
