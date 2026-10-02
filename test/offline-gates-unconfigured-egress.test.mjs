/**
 * ── ⭐⭐⭐ A CAP IS NOT A GATE ──────────────────────────────────────────────
 *
 * Three verbs in this package reach a stranger with NO configuration at all:
 *
 *   fetch_url       any URL the model names
 *   web_search      the query leaves the machine
 *   generate_image  ⭐ the prompt goes to perchance.org and pollinations.ai.
 *                   `imageConfig` DEFAULTS to configured, so this fires on a
 *                   bare install with no key, no account and no config.
 *                   `ENTERPRISE.md` §2.2 calls this egress "easy to miss".
 *
 * Each had a CAP — 10 fetches a run, 12 searches a run — and caps bound how
 * much leaves. They cannot express "none". An operator on a machine that must
 * not talk to strangers had no way to say so short of naming each verb in a
 * policy file, and `--offline` — the flag whose own help text said *"nothing
 * leaves the machine"* — reached exactly one thing: `--doctor`'s probes.
 *
 * ── ⚠️ WHAT THIS DELIBERATELY DOES NOT CLAIM ───────────────────────────────
 *
 * Not "no network". The model chain IS egress, and an MCP server an operator
 * registered is a program we spawn rather than a verb we gate. The claim is
 * narrow and checkable: no tool Acuvo ships reaches a third party the operator
 * did not separately configure. Every other networked verb here is already
 * behind a credential somebody chose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  toolNamesForRounds,
  executeToolCall,
  offlineEnabled,
  OFFLINE_ENV,
  UNCONFIGURED_EGRESS_TOOL_NAMES,
} from '../lib/tools.mjs';

const BIN = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));
const HERE = fileURLToPath(new URL('.', import.meta.url));

const offer = (env) => toolNamesForRounds(6, { allowRun: true, env, root: HERE, home: HERE });

test('⭐⭐⭐ by default all three are offered — this flag changes NO default', () => {
  const names = offer({});
  for (const n of UNCONFIGURED_EGRESS_TOOL_NAMES) {
    assert.ok(names.includes(n), `${n} must still be offered on a bare install; withholding it by default would be a capability change nobody asked for`);
  }
});

test('⭐⭐⭐ ACUVO_OFFLINE withholds exactly those three and nothing else', () => {
  const on = offer({});
  const off = offer({ [OFFLINE_ENV]: '1' });
  const removed = on.filter((n) => !off.includes(n));
  assert.deepEqual(
    removed.sort(), [...UNCONFIGURED_EGRESS_TOOL_NAMES].sort(),
    'the flag must take away the three egress verbs and nothing besides — a narrowing flag that quietly removes more is a capability regression wearing a safety label',
  );
  assert.equal(off.length, on.length - 3);
});

test('⚠️ unset, 0, false and no all mean ONLINE — three states, not two', () => {
  assert.equal(offlineEnabled({}), false);
  assert.equal(offlineEnabled({ [OFFLINE_ENV]: '' }), false);
  assert.equal(offlineEnabled({ [OFFLINE_ENV]: '0' }), false);
  assert.equal(offlineEnabled({ [OFFLINE_ENV]: 'false' }), false);
  assert.equal(offlineEnabled({ [OFFLINE_ENV]: 'no' }), false);
  assert.equal(offlineEnabled({ [OFFLINE_ENV]: '1' }), true);
  assert.equal(offlineEnabled({ [OFFLINE_ENV]: 'yes' }), true);
});

/* ── THE SECOND GATE ─────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ THE OFFER IS NOT A GATE, and this package has already paid for believing
 * it was. `tools.mjs`'s own comment on `repl` says a caller that widens the tool
 * list, replays a session, or hands a name in directly reaches the dispatch
 * switch without consulting the offer — and `evaluate` was withheld only at the
 * offer, which made `--no-run` a lie by a side door. A withheld egress verb that
 * still runs when named is the identical defect.
 */
for (const name of ['fetch_url', 'web_search', 'generate_image']) {
  test(`⭐⭐⭐ ${name} is refused at the DISPATCH when offline, not merely unoffered`, async () => {
    const before = process.env[OFFLINE_ENV];
    process.env[OFFLINE_ENV] = '1';
    /**
     * ── ⚠️⚠️ A THROWAWAY ROOT, AND THE REASON IS MEASURED ────────────────────
     *
     * Mutation-testing this guard (`if (…) {` → `if (false) {`) let
     * `generate_image` through, and it **reached pollinations.ai and wrote a
     * 33 KB JPEG into `test/`** — from a unit test, with `dryRun: true` set. So
     * the egress this file is about is real, it is on by default, and it is not
     * stopped by the dry-run flag.
     *
     * ⭐ Pointing the executor at a temp directory means a future regression
     * fails the assertion WITHOUT leaving a generated image in the repository
     * for somebody to commit by accident.
     */
    const ws = mkdtempSync(join(tmpdir(), 'acuvo-offline-'));
    try {
      const out = await executeToolCall(
        { id: 'c1', function: { name, arguments: JSON.stringify({ url: 'https://example.com', query: 'x', prompt: 'a cat' }) } },
        { root: ws, dryRun: true },
        { allowRun: true },
      );
      assert.equal(out.result.ok, false, `${name} executed under --offline — the offer is not a gate, and a caller that hands the name in directly reaches the switch`);
      assert.match(out.result.error, /offline/i, 'the refusal must name the flag, or the reader cannot tell it from a broken network');
      assert.equal(out.mutated, false);
    } finally {
      if (before === undefined) delete process.env[OFFLINE_ENV]; else process.env[OFFLINE_ENV] = before;
      rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

/* ── THE FLAG, AND THE SENTENCE IT IS ALLOWED TO SAY ─────────────────────── */

test('⭐⭐ the CLI turns --offline into the variable the gate reads', async () => {
  const src = await readFile(BIN, 'utf8');
  assert.match(
    src, /if \(opts\.offline === true\) process\.env\[OFFLINE_ENV\] = '1';/,
    '--offline reached only --doctor\'s probes; without this line it still does nothing on an ordinary run',
  );
});

test('⚠️⚠️ the help text must NOT claim nothing leaves the machine on a normal run', async () => {
  const src = await readFile(BIN, 'utf8');
  const at = src.indexOf("'  --offline ");
  assert.notEqual(at, -1, '--offline must have its own help entry — a flag nobody is told about is a flag nobody uses');
  const entry = src.slice(at, at + 900);
  /**
   * ⚠️ THE MODEL CALL IS EGRESS. An absolute here would be the unscoped-absolute
   * defect CLAUDE.md records by name, in the one place a security reviewer
   * reads.
   */
  assert.ok(
    !/nothing leaves the machine/.test(entry),
    "the model chain is egress and so is a registered MCP server; 'nothing leaves the machine' is true of --doctor and false of a run",
  );
  for (const n of UNCONFIGURED_EGRESS_TOOL_NAMES) {
    assert.ok(entry.includes(n), `the help must NAME ${n} — "the network verbs" is a category the reader has to guess at`);
  }
});

test('⭐⭐ the doctor blames the flag, not a variable nobody set', async () => {
  const { runDoctor } = await import('../lib/doctor.mjs');
  const report = await runDoctor({
    root: HERE, allowRun: true, maxRounds: 6, skipNetwork: true,
    env: { ...process.env, [OFFLINE_ENV]: '1' },
  });
  const tools = report.sections.find((s) => s.id === 'tools');
  const image = tools.checks.find((c) => c.label === 'generate_image');
  assert.ok(image, 'generate_image must appear as withheld');
  /**
   * ⚠️ MEASURED THE DAY THE GATE LANDED: it said "PERCHANCE_IMAGE_URL is set to
   * an empty value, which means the image service is deliberately OFF" — on a
   * machine where that variable was never mentioned. A withheld-reason that
   * names the wrong cause sends somebody to unset a variable that does not
   * exist, which is this function's own `read_skill` lesson repeating.
   */
  assert.match(image.detail, /offline/i, `the doctor blamed the wrong cause: ${image.detail}`);
  assert.ok(!/PERCHANCE_IMAGE_URL/.test(image.detail), 'that variable is not why it is dark here');
});
