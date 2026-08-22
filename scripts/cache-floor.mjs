/**
 * ── ⭐⭐ MEASURE THE CACHE FLOOR. IT COSTS $0.00 AND IT IS THE MARGIN. ───────
 *
 *     node scripts/cache-floor.mjs [repoA] [repoB] ...
 *
 * `PRICING.md` §5 states `cache floor = sharedHead ÷ typicalPrompt` and closes
 * with the open item *"measure the achieved cache floor"*. This is that
 * measurement, and it runs offline: the model is SCRIPTED, so what is being read
 * is the bytes WE send — the half of the cache contract we control, and the only
 * half that can be checked on every commit without a key or a bill.
 *
 * It prints two things a live `acuvo --json` reading cannot tell apart on its
 * own:
 *
 *   1. **the floor across tenants** — how much of a brand-new user's very first
 *      request the provider has already seen, because some other tenant sent the
 *      same head. This is the number the ladder is sized on.
 *   2. **the floor across configurations** — what one machine's `--no-run`, TTY
 *      or `MODAL_*` setting does to that head. Two tenants whose configs differ
 *      are two cache pools, however perfect the prefix is inside each.
 *
 * ⚠️ IT DOES NOT MEASURE WHAT THE PROVIDER DID. A perfect prefix still misses if
 * the request lands on a cold upstream — `lib/model.mjs` measured 46.7% unpinned
 * against 95.8% pinned on the same bytes. That reading comes from
 * `acuvo --json`'s `.cache` block against a real key. ⭐ The point of this
 * script is that it makes that reading INTERPRETABLE: a live 0% beside a
 * measured 99.9% prefix is a routing finding, and a live 0% beside a measured
 * 4% prefix is ours.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { toolNamesForRounds, toolSchemasFor } from '../lib/tools.mjs';
import { orderForCachePrefix } from '../lib/tool-prefix.mjs';
import { sharedPrefixBytes, describeDivergence, wireBytes } from '../lib/cache-floor.mjs';

const ROUNDS = 8;
const made = [];

/** A throwaway repository, so the script has something to measure with no arguments. */
function scratchRepo(name, files) {
  const root = mkdtempSync(join(tmpdir(), `acuvo-floor-${name}-`));
  made.push(root);
  writeFileSync(join(root, 'package.json'), `{"name":"${name}","version":"1.0.0"}\n`);
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < files; i += 1) {
    writeFileSync(join(root, 'src', `mod${i}.js`), `export function fn${i}(x) {\n  return x + ${i};\n}\n`);
  }
  return root;
}

/**
 * Round 1 of a FRESH invocation, which is the round the floor is a claim about.
 * ⚠️ Rounds 2+ are a different measurement — they append tool results the
 * provider has by definition never seen, so their miss is arithmetic.
 */
async function firstRequest(root, task) {
  let captured = null;
  const callModelImpl = async (opts) => {
    if (!captured) captured = { tools: opts.tools ?? null, messages: opts.messages };
    return {
      ok: true, content: 'done', toolCalls: [],
      usage: { cost: 0, total_tokens: 0 }, finishReason: 'stop', model: 'scripted/none',
    };
  };
  await runSession({
    task,
    executor: createLocalExecutor(root),
    config: { apiKey: 'scripted', model: 'scripted/none' },
    maxRounds: ROUNDS,
    allowRun: false,
    callModelImpl,
    onEvent: () => {},
  });
  return captured;
}

const kb = (n) => `${(n / 1024).toFixed(1)}k`;
const pct = (n) => (n === null ? '  —  ' : `${(n * 100).toFixed(1)}%`);

const args = process.argv.slice(2).filter((p) => existsSync(p));
const roots = args.length >= 2
  ? args.map((p) => [p, `describe what ${basename(p)} does`])
  : [
    [scratchRepo('alpha', 30), 'add a test for src/mod3.js'],
    [scratchRepo('beta', 60), 'rename fn7 to seven and update the callers'],
    [scratchRepo('gamma', 12), 'write a README'],
  ];

console.log('── 1. THE FLOOR ACROSS TENANTS ─────────────────────────────────────');
console.log('   round 1 of a fresh invocation, one scripted round, $0.00\n');

const caps = [];
for (const [root, task] of roots) {
  const cap = await firstRequest(root, task);
  if (!cap) { console.log(`   ${root}: no request was made`); continue; }
  const bytes = wireBytes(cap);
  caps.push({ root, bytes, cap });
  console.log(
    `   ${basename(root).padEnd(28)} prompt ${kb(bytes.length).padStart(7)}`
    + `  tools ${kb(JSON.stringify(cap.tools).length).padStart(7)} (${cap.tools.length})`
    + `  system ${kb(String(cap.messages[0]?.content ?? '').length).padStart(7)}`,
  );
}

console.log('\n   pair                                 shared head      floor');
let worst = null;
for (let i = 0; i < caps.length; i += 1) {
  for (let j = i + 1; j < caps.length; j += 1) {
    const d = describeDivergence(caps[i].bytes, caps[j].bytes);
    const label = `${basename(caps[i].root)} vs ${basename(caps[j].root)}`;
    console.log(`   ${label.padEnd(52)} ${kb(d.sharedPrefix).padStart(8)}      ${pct(d.floor)}`);
    if (worst === null || d.floor < worst.floor) worst = { ...d, label };
  }
}
if (worst) {
  console.log(`\n   ⚠️ the head ends at byte ${worst.at} (${worst.label}), where the two requests read:`);
  console.log(`      A …${JSON.stringify(worst.aroundA.slice(100, 200))}`);
  console.log(`      B …${JSON.stringify(worst.aroundB.slice(100, 200))}`);
  /**
   * ⚠️ THE TWO NUMBERS ARE PRINTED WHETHER OR NOT THEY DISAGREE, and the reading
   * says which case this is. Printing them only when they diverge would teach a
   * reader that "shared" and "cacheable" are normally the same word, which is
   * the exact confusion that turns a 98.9%-shared / 0%-cached probe into a
   * hunt for a prefix bug that is not there.
   */
  const drift = (worst.sharedFraction ?? 0) - (worst.floor ?? 0);
  console.log(`\n   shared bytes ${pct(worst.sharedFraction)} · cacheable prefix ${pct(worst.floor)} — `
    + (drift > 0.02
      ? '⚠️ SHARED BYTES ARE NOT A SHARED PREFIX. What they have in common is behind the divergence, so none of it bills as cache.'
      : 'healthy: what they share is at the front, so the cache can reach all of it.'));
}

if (args.length < 2) {
  console.log('\n   ⚠️ THESE ARE SCRATCH REPOSITORIES AND THEY FLATTER THE FLOOR. A repo map is');
  console.log('      the per-tenant half of the prompt, and a 30-file scratch repo has almost none');
  console.log('      of one. Measured on three REAL repositories in this tree the same day, the head');
  console.log('      was 22.9k against a 41.9k prompt — a 54.6% floor. Pass real paths:');
  console.log('        node scripts/cache-floor.mjs ../acuvo-code ../acuvo-gateway ../slopscore');
}

console.log('\n── 2. THE FLOOR ACROSS CONFIGURATIONS ──────────────────────────────');
console.log('   one machine\'s settings against another\'s, tools block only\n');

const probeRoot = caps[0]?.root ?? roots[0][0];
const variants = [
  ['reference (bare machine)', { allowRun: true, env: {}, root: probeRoot }],
  ['--no-run', { allowRun: false, env: {}, root: probeRoot }],
  ['ACUVO_ALLOW_PUSH=1', { allowRun: true, env: { ACUVO_ALLOW_PUSH: '1' }, root: probeRoot }],
  ['MODAL_TTS_URL set', { allowRun: true, env: { MODAL_TTS_URL: 'https://x' }, root: probeRoot }],
  ['stdin is a TTY (ask_user)', { allowRun: true, env: {}, root: probeRoot, interactive: true }],
  ['running as a subagent', { allowRun: true, env: {}, root: probeRoot, subagent: true }],
];

const block = (opts, ordered) => {
  const picked = toolSchemasFor(toolNamesForRounds(ROUNDS, opts));
  return JSON.stringify(ordered ? orderForCachePrefix(picked, { maxRounds: ROUNDS }) : picked);
};
const refOpts = variants[0][1];

console.log('   difference from the reference        registry order      cache order');
for (const [label, opts] of variants) {
  const before = sharedPrefixBytes(block(refOpts, false), block(opts, false));
  const after = sharedPrefixBytes(block(refOpts, true), block(opts, true));
  const gain = before > 0 ? ` (${(after / before).toFixed(1)}x)` : '';
  console.log(`   ${label.padEnd(34)} ${String(before).padStart(9)} B      ${String(after).padStart(9)} B${gain}`);
}

console.log('\n   ⭐ the cache order is a PERMUTATION — every tool above is still offered.');
console.log('   ⚠️ what a provider then did with these bytes is `acuvo --json` .cache, not this.\n');

for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
