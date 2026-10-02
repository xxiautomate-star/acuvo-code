/**
 * ── ⭐⭐⭐ A METERED RUN THAT NOTHING CAN ADD UP IS NOT METERED ─────────────
 *
 * `--harness` recorded every round through the same governor as our own loop —
 * correctly, at the wire, with `test/harness-cli-wires-the-budget.test.mjs`
 * pinning the wiring — and then the process EXITED WITHOUT WRITING A RECORD.
 *
 * So the money was governed and invisible:
 *
 *   · `acuvo spend` reads `.acuvo/audit/<date>.jsonl` and nothing else, so it
 *     reported zero harness runs however many you had driven;
 *   · `--fleet-budget` has NO SECOND BOOK — `lib/fleet-budget.mjs` argues at
 *     length that the audit directory IS the fleet ledger — so seven terminals
 *     could drive codex all night against a ceiling that never moved.
 *
 * That is this repo's signature defect (BUILT AND UNREACHED) applied to the one
 * subsystem whose whole pitch is *"tell me the price and stop at the number I
 * gave you"*.
 *
 * ── ⚠️ THREE LAYERS, BECAUSE ONE OF THEM CANNOT SEE WHAT ANOTHER CAN ───────
 *
 *   1. the MAPPING (`harnessAuditOutcome`) — pure, every branch, $0;
 *   2. the DISPATCH (`bin/acuvo.mjs`) — source-level, the house pattern, and
 *      the honest limit of it is that it only proves the text is there;
 *   3. ⭐ the PRODUCT — the real binary, a real child, a real metering proxy
 *      and a real audit file. It is the only layer that can fail when the call
 *      is deleted AND the regex is updated to match, which is exactly how a
 *      guard gets neutered by a well-meaning refactor.
 *
 * ⚠️ LAYER 3 SPENDS NOTHING. The proxy is pointed at a throwaway
 * Responses-shaped server on 127.0.0.1 that answers one turn and reports a
 * usage block. No provider is contacted and no key is real.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

import { harnessAuditOutcome, foldHarnessUsage } from '../lib/harness-run.mjs';
import { resolveHarness } from '../lib/harness.mjs';
import { auditRecord } from '../lib/audit.mjs';
import { summariseSpend } from '../lib/spend.mjs';

const BIN = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));

/** One metered response as the proxy reports it. */
const round = (prompt, cached, completion) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  prompt_tokens_details: { cached_tokens: cached },
});

/* ── 1 · THE FOLD, SHARED BY THE SUMMARY AND THE LEDGER ──────────────────── */

test('⭐⭐ the proxy fold SUMS and the codex fold takes the LAST reading', () => {
  const list = [round(100, 0, 10), round(300, 200, 20)];
  const metered = foldHarnessUsage(list, { metered: true });
  assert.equal(metered.prompt, 400, 'a proxy sees one response per request — those add up');
  assert.equal(metered.completion, 30);
  assert.equal(metered.cached, 200);

  const self = foldHarnessUsage(list, { metered: false });
  assert.equal(self.prompt, 300, "codex's turn.completed is a RUNNING TOTAL — summing it over-reports every multi-turn run");
  assert.equal(self.rounds, 1);
});

test('⚠️ a round that omits cached_tokens is UNKNOWN, never a cached zero', () => {
  const fold = foldHarnessUsage([round(100, 40, 5), { prompt_tokens: 100, completion_tokens: 5 }], { metered: true });
  assert.equal(fold.cached, 40);
  assert.equal(fold.cacheRoundsReported, 1);
  assert.equal(fold.cacheRoundsUnknown, 1, '"the provider said nothing" and "the provider cached nothing" are different facts');
});

/* ── 2 · THE MAPPING ─────────────────────────────────────────────────────── */

test('⭐⭐⭐ a metered run carries the GOVERNOR\'s total, not a second pricing', () => {
  const budget = { stats: () => ({ spentUsd: 0.0042 }) };
  const out = harnessAuditOutcome({
    harness: 'codex',
    result: { ok: true, mode: 'metered', usage: [round(4000, 3600, 120)] },
    budget,
  });
  assert.equal(out.usage.cost, 0.0042, 'the figure must be the one budget.record() already holds — repricing here would be a second opinion beside a derived value');
  assert.equal(out.usage.total_tokens, 4120);
  assert.equal(out.usage.cache.hitRate, 0.9);
  assert.equal(out.stoppedBecause, 'harness:codex:metered');
});

test('⭐⭐⭐ an UNMETERED run records NO cost — null, never a number', () => {
  const out = harnessAuditOutcome({
    harness: 'codex',
    result: { ok: true, mode: 'unmetered', usage: [round(4000, 3600, 120)] },
    // ⚠️ A governor is still passed: an unmetered run constructs one and it
    // simply never records. Reading it here would have priced a spend Acuvo
    // never carried, which is the exact lie this module's header refuses.
    budget: { stats: () => ({ spentUsd: 0 }) },
  });
  assert.equal(out.usage.cost, undefined, "codex's own tokens are honest numbers Acuvo did not carry — pricing them would make a runaway bill look supervised");
  assert.equal(out.usage.total_tokens, 4120, 'the TOKENS are still recorded — what is unknown is the money, not the traffic');
  assert.equal(out.stoppedBecause, 'harness:codex:unmetered');

  // And `spend.mjs` must classify it as unknown rather than fold it into zero.
  const rec = auditRecord(out, { task: 'x', now: new Date('2026-09-17T00:00:00Z') });
  assert.equal(rec.run.costUsd, null);
  const sum = summariseSpend([{ name: 'a.jsonl', text: `${JSON.stringify(rec)}\n` }]);
  assert.equal(sum.unknown, 1);
  assert.equal(sum.counted, 0);
  assert.equal(sum.totalUsd, 0, 'an unknown must never be added to the total as a zero');
});

test('⚠️ a REFUSED harness records nothing at all — it never ran', () => {
  assert.equal(harnessAuditOutcome({ harness: 'codex', result: { ok: false, mode: 'refused', usage: [] } }), null);
});

test('⚠️ a metered run that reported no usage has a null cost, not $0.00', () => {
  const out = harnessAuditOutcome({
    harness: 'codex',
    result: { ok: true, mode: 'metered', usage: [] },
    budget: { stats: () => ({ spentUsd: 0 }) },
  });
  assert.equal(out.usage, null, 'nothing was reported, so nothing is known — a confident zero here is the one lie `spend.mjs` exists to prevent');
  assert.equal(auditRecord(out, { task: 'x' }).run.costUsd, null);
});

test('⚠️ the model field stays null when nobody named one', () => {
  const out = harnessAuditOutcome({ harness: 'codex', result: { ok: true, mode: 'metered', usage: [round(1, 0, 1)] } });
  assert.equal(out.model, null, 'writing "codex" into a field every report reads as a model id would put a harness name in the model column');
  const named = harnessAuditOutcome({ harness: 'codex', result: { ok: true, mode: 'metered', usage: [round(1, 0, 1)] }, model: 'gpt-5-codex' });
  assert.equal(named.model, 'gpt-5-codex');
});

/* ── 3 · THE DISPATCH ────────────────────────────────────────────────────── */

async function harnessBranch() {
  const src = await readFile(BIN, 'utf8');
  const at = src.indexOf('if (life.harness !== null)');
  assert.notEqual(at, -1, 'the --harness dispatch must exist');
  const end = src.indexOf('`── ⭐⭐ `--replay`', at);
  return src.slice(at, end === -1 ? at + 4000 : end);
}

test('⭐⭐⭐ the CLI writes an audit record for a harness run', async () => {
  const block = await harnessBranch();
  assert.match(block, /recordRun\(\{/, 'without this the spend is governed and invisible: `acuvo spend` and `--fleet-budget` both read ONLY the audit log');
  assert.match(block, /harnessAuditOutcome\(\{/, 'the harness result is not an outcome — it has to be mapped, or toJson records an empty run');
});

test('⚠️ --dry-run and --no-audit still opt out of the receipt', async () => {
  const block = await harnessBranch();
  assert.match(block, /if \(!opts\.dryRun && life\.audit\)/, '`--help` promises a dry run touches nothing and `--no-audit` promises the workspace is left alone; a spend record is not an exception to either');
});

/* ── 4 · THE PRODUCT ─────────────────────────────────────────────────────── */

/**
 * A throwaway Responses-shaped upstream. Answers one turn with a usage block
 * and contacts nothing. Returns `{ port, close }`.
 */
async function fakeUpstream() {
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      if (String(req.url).includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-5-codex' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`);
      send('response.created', { response: { id: 'r1', status: 'in_progress', output: [] } });
      send('response.output_item.done', {
        output_index: 0,
        item: { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'nothing to do' }] },
      });
      send('response.completed', {
        response: {
          id: 'r1',
          status: 'completed',
          output: [],
          usage: { input_tokens: 4000, input_tokens_details: { cached_tokens: 3600 }, output_tokens: 120, total_tokens: 4120 },
        },
      });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

test('⭐⭐⭐ END TO END: a real `--harness` run lands in `acuvo spend`', { timeout: 180_000 }, async (t) => {
  /**
   * ⚠️ SKIPPED, NOT FAKED, WHEN CODEX IS ABSENT. It is a user's own install and
   * cannot be a dependency of this package — which is precisely why layers 1–3
   * above exist and are not redundant with this one.
   */
  if (!resolveHarness('codex').ok) {
    t.skip('codex is not installed on this machine — layers 1-3 still hold the mapping and the dispatch');
    return;
  }
  const up = await fakeUpstream();
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-harness-spend-'));
  /**
   * ── ⚠️⚠️⭐ THE INSTRUMENT DEADLOCKED, AND IT LOOKED EXACTLY LIKE A HANG ───
   *
   * The first version of this test used `spawnSync` and timed out at 150s every
   * time, while the identical command finished in 20.7s from a shell — a
   * perfect impression of "the harness hangs under test". It does not.
   * `spawnSync` BLOCKS THE EVENT LOOP, and the throwaway upstream above is
   * served by THIS process, so the proxy's forwarded request could never be
   * answered. The test was starving the server it had started.
   *
   * ⭐ That is CLAUDE.md's *"the instrument is likelier wrong than the
   * product"* with a stopwatch on it, and the cure is the async spawn below:
   * the loop stays free to serve while the child runs.
   */
  try {
    const r = await new Promise((done) => {
      const child = spawn(process.execPath, [BIN, '--dir', ws, '--harness', 'codex', 'say nothing and stop'], {
        env: { ...process.env, ACUVO_HARNESS_KEY: 'sk-not-a-real-key', ACUVO_HARNESS_UPSTREAM: `http://127.0.0.1:${up.port}/v1` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill(), 150_000);
      child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.match(out, /metered through Acuvo/, `the run did not meter — nothing downstream can be asserted. Output:\n${out.slice(0, 1500)}`);

    const dir = join(ws, '.acuvo', 'audit');
    const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'a finished harness run must leave exactly one day file');

    const text = readFileSync(join(dir, files[0]), 'utf8');
    const rec = JSON.parse(text.trim().split('\n').pop());
    assert.equal(rec.run.stoppedBecause, 'harness:codex:metered', 'the ledger must be able to tell a harness run from one of our own');
    assert.equal(rec.run.tokens, 4120);
    assert.equal(rec.run.cache.hitRate, 0.9, "Roman's first MVP point is the cache; a harness round whose rate we drop is a round we cannot evaluate");
    assert.ok(typeof rec.run.costUsd === 'number' && rec.run.costUsd > 0, 'a metered round moved tokens, so the governor priced it and the record must carry that price');

    /**
     * ⭐ AND THE QUESTION A PAYER ACTUALLY ASKS. Asserting the file exists only
     * proves a write; this proves the report can add it up, which is the thing
     * that was broken.
     */
    const sum = summariseSpend([{ name: files[0], text }]);
    assert.equal(sum.counted, 1);
    assert.ok(sum.totalUsd > 0, '`acuvo spend` reported nothing for every harness run ever driven — that is the defect this file exists for');
  } finally {
    await up.close();
    // ⚠️ Windows holds the sandbox's handles for a moment after codex exits;
    // an un-retried rmdir fails EBUSY and reports a PASSING run as a failure.
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
