/**
 * ── 💰⭐⭐⭐ THE SHORTLIST GATE, AT ITS DEFAULT, ON THE REAL PATH ─────────────
 *
 * `ECONOMICS.md`, reconciled to eight decimal places against what we were
 * actually billed: **cache-MISS input is 90.9% of every dollar**, tool schemas
 * are **53.3% of the head**, and for the two-character task "hi" **99.998% of
 * what we paid for was overhead we sent ourselves**. So the size of the tool
 * block is the largest structural cost lever in the product.
 *
 * ⚠️⚠️ AND IT WAS DARK. `turn.mjs` read `ACUVO_TOOL_SHORTLIST` and the flag was
 * off, so every measured saving was a lab number. This file defends the three
 * things that had to be true before it could be turned on, and it defends them
 * through `runSession` rather than through the pure functions — the repo's own
 * standing lesson is that only the end-to-end run proves reach.
 *
 *   1. it is ON by default, and `=0` still turns it off;
 *   2. the head stays TASK-INVARIANT, so shrinking the block does not cost the
 *      cross-task prefix (the prior author's real objection);
 *   3. the WIDEN escape hatch actually fires — it was imported and wired to
 *      nothing, which made a wrong shortlist a permanent capability ceiling.
 *
 * ⚠️ ZERO NETWORK. Every session below injects `callModelImpl`; nothing here
 * reaches a provider, and no number in it costs a cent to reproduce.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession, stableToolOrderKey } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { toolNamesForRounds } from '../lib/tools.mjs';
import { TOOL_GROUPS, CORE_TOOLS } from '../lib/tool-shortlist.mjs';
import { sharedPrefixBytes } from '../lib/cache-floor.mjs';

/** ECONOMICS.md: 90,993 chars of head against 25,707 billed prompt tokens. */
const CHARS_PER_TOKEN = 3.54;
const tokens = (s) => Math.round(s.length / CHARS_PER_TOKEN);
const ROUNDS = 8;

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-shortlist-gate-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  return root;
}

/**
 * ⚠️ SAVE AND RESTORE, ALWAYS. Tests in one file share a process, and a leaked
 * `ACUVO_TOOL_SHORTLIST` would silently decide the answer for every test after
 * it — including the ones asserting the DEFAULT.
 */
async function withFlag(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'ACUVO_TOOL_SHORTLIST');
  const prev = process.env.ACUVO_TOOL_SHORTLIST;
  if (value === null) delete process.env.ACUVO_TOOL_SHORTLIST;
  else process.env.ACUVO_TOOL_SHORTLIST = value;
  try { return await fn(); } finally {
    if (had) process.env.ACUVO_TOOL_SHORTLIST = prev;
    else delete process.env.ACUVO_TOOL_SHORTLIST;
  }
}

/**
 * Drive the real session and hand back the exact `tools` array the model was
 * sent, round by round. `replies` lets a test steer the model.
 */
async function capture(task, { root = null, allowRun = true, replies = null } = {}) {
  const seen = [];
  let i = 0;
  await runSession({
    task,
    executor: createLocalExecutor(root ?? workspace()),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds: ROUNDS,
    allowRun,
    callModelImpl: async (opts) => {
      seen.push(JSON.stringify(opts.tools));
      const scripted = replies?.[i];
      i += 1;
      return scripted ?? {
        ok: true, content: 'done', toolCalls: [], usage: { cost: 0, total_tokens: 1 },
        finishReason: 'stop', model: 'fake/model',
      };
    },
    onEvent: () => {},
  });
  assert.ok(seen.length > 0, 'no request was made');
  return seen;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE GATE — live by default, and still switchable
// ─────────────────────────────────────────────────────────────────────────────

test('💰⭐⭐⭐ the shortlist is LIVE BY DEFAULT — an unset flag narrows the real request', async () => {
  const root = workspace();
  const [on] = await withFlag(null, () => capture('hi', { root }));
  const [off] = await withFlag('0', () => capture('hi', { root }));

  assert.ok(
    on.length < off.length,
    `the default request is ${on.length}B against ${off.length}B with the shortlist off — `
    + 'the flag is dark again and every saving below is a lab number',
  );

  const pct = ((1 - on.length / off.length) * 100).toFixed(1);
  console.log(`   task "hi"        tool block ${off.length}B ~${tokens(off)} tok  ->  ${on.length}B ~${tokens(on)} tok  (-${pct}%)`);

  // ⚠️ The spine has to survive, or the saving is bought with capability.
  for (const t of ['read_file', 'write_file', 'edit_file', 'search_text', 'run_command']) {
    assert.ok(on.includes(`"${t}"`), `${t} is core and must survive an unsignalled brief`);
  }
});

test('⚠️ ACUVO_TOOL_SHORTLIST=0 still turns it off, and only an explicit off does', async () => {
  const root = workspace();
  const off = (await withFlag('0', () => capture('hi', { root })))[0];
  for (const v of [null, '', '1', 'true', 'yes']) {
    const got = (await withFlag(v, () => capture('hi', { root })))[0];
    assert.ok(got.length < off.length, `ACUVO_TOOL_SHORTLIST=${JSON.stringify(v)} did not shortlist`);
  }
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    const got = (await withFlag(v, () => capture('hi', { root })))[0];
    assert.equal(got.length, off.length, `ACUVO_TOOL_SHORTLIST=${JSON.stringify(v)} should disable the shortlist`);
  }
});

test('⭐ and on a realistic multi-file brief', async () => {
  const root = workspace();
  const task = 'add a dark mode toggle to the settings page and update the tests';
  const [on] = await withFlag(null, () => capture(task, { root }));
  const [off] = await withFlag('0', () => capture(task, { root }));
  assert.ok(on.length < off.length, 'this brief no longer exercises the shortlist');
  console.log(`   realistic task   tool block ${off.length}B ~${tokens(off)} tok  ->  ${on.length}B ~${tokens(on)} tok`
    + `  (-${((1 - on.length / off.length) * 100).toFixed(1)}%)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE SPLIT — a task-varying block that does not move the head
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── ⚠️⚠️ THE OBJECTION THIS ANSWERS ────────────────────────────────────────
 *
 * The prior author shipped the flag off partly because *"a shortlisted tool
 * list is TASK-VARYING, and a task-varying block cannot sit in a prefix shared
 * across tasks."* Correct — and it was the ORDERING, not the shortlist. The
 * block was emitted shortlist-first, hoisting each task's own groups to the
 * front, so two briefs diverged inside the first few schemas (measured: 8,418B,
 * 26.5%). `stableToolOrderKey` puts the invariant tools first instead.
 *
 * ⚠️ THE FLOOR IS ABSOLUTE BYTES, deliberately, and it is the same 15,000 the
 * neighbouring `tool-prefix-order.test.mjs` uses for a configuration
 * difference. A ratio would pass on two tiny blocks; the margin is made of
 * bytes that an upstream prefix cache can actually serve.
 */
test('⚠️⚠️⭐ two DIFFERENT tasks share the invariant head on the real path', async () => {
  const root = workspace();
  const [a] = await withFlag(null, () => capture('commit this and open a pull request for the auth fix', { root }));
  const [b] = await withFlag(null, () => capture('start the dev server and check the api endpoint responds', { root }));

  assert.notEqual(a, b, 'the two briefs produced identical blocks — they no longer exercise this');
  const shared = sharedPrefixBytes(a, b);
  console.log(`   cross-task tool prefix  ${shared}B of ${Math.min(a.length, b.length)}B  `
    + `(${((shared / Math.min(a.length, b.length)) * 100).toFixed(1)}%)`);

  assert.ok(
    shared > 15000,
    `two tasks in the same workspace share only ${shared} bytes of tool-block prefix. The task-varying `
    + 'part has moved back in front of the invariant part — see stableToolOrderKey in turn.mjs.',
  );
});

test('⭐ the ordering key itself is task-invariant, and derived rather than listed', () => {
  const offer = toolNamesForRounds(ROUNDS, { allowRun: true, root: '/acuvo-cache-core-probe-no-such-workspace', env: {} });
  const key = stableToolOrderKey(offer);

  // Nothing any group can add may be in it — that is the definition of "varies".
  for (const [name, g] of Object.entries(TOOL_GROUPS)) {
    for (const t of g.tools) {
      assert.ok(!key.includes(t), `"${t}" is added by the "${name}" group, so it varies with the task and cannot be in the head`);
    }
  }
  // And the spine that every brief gets must be, or the head is worthless.
  for (const t of CORE_TOOLS) {
    if (offer.includes(t)) assert.ok(key.includes(t), `"${t}" is core and is offered here, so it belongs in the head`);
  }
  assert.ok(key.length >= 20, `only ${key.length} tools are task-invariant — the head is too thin to matter`);

  // ⚠️ Order-preserving: it may not introduce a second sort.
  assert.deepEqual(key, offer.filter((n) => key.includes(n)), 'the key reordered the offer');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE WIDEN — it was imported, documented, and connected to nothing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `tool-shortlist.mjs` calls this "what makes this safe to ship": reaching for
 * an unoffered tool widens the offer to everything, permanently, so a wrong
 * shortlist costs ONE round rather than the task. `shouldWiden` was imported
 * into `turn.mjs` and never called, `toolsWidened` was never assigned, and the
 * tool block was a `const` built before the loop. The hatch did not exist.
 */
test('💰⭐⭐⭐ REACH: reaching for an unoffered tool widens the NEXT round', async () => {
  const root = workspace();
  const rounds = await withFlag(null, () => capture('hi', {
    root,
    replies: [{
      ok: true,
      content: '',
      toolCalls: [{ id: 'c1', function: { name: 'generate_image', arguments: '{"prompt":"x"}' } }],
      usage: { cost: 0, total_tokens: 1 },
      finishReason: 'tool_calls',
      model: 'fake/model',
    }],
  }));

  assert.ok(rounds.length >= 2, 'the session stopped after one round — nothing about widening is proven');
  assert.ok(!rounds[0].includes('"generate_image"'), 'the fixture failed: generate_image was already offered, so no widen was needed');
  assert.ok(rounds[1].includes('"generate_image"'), 'the model reached for an unoffered tool and round 2 still withheld it — the widen is dead again');
  assert.ok(rounds[1].length > rounds[0].length, 'the widened block is not larger than the narrow one');

  /**
   * ⚠️ AND THE HEAD SURVIVED THE WIDEN. This is what the task-invariant key
   * buys on top of the cross-task win: ranks 0-1 are identical before and
   * after, so the cached prefix is extended rather than rewritten.
   */
  const kept = sharedPrefixBytes(rounds[0], rounds[1]);
  console.log(`   widen  ${rounds[0].length}B -> ${rounds[1].length}B, prefix kept ${kept}B `
    + `(${((kept / rounds[0].length) * 100).toFixed(1)}% of the narrow block)`);
  assert.ok(kept > 15000, `a widen rewrote the cached head — only ${kept} bytes survived`);
});

test('⚠️ with the shortlist OFF nothing widens, because nothing was withheld', async () => {
  const root = workspace();
  const rounds = await withFlag('0', () => capture('hi', {
    root,
    replies: [{
      ok: true,
      content: '',
      toolCalls: [{ id: 'c1', function: { name: 'generate_image', arguments: '{"prompt":"x"}' } }],
      usage: { cost: 0, total_tokens: 1 },
      finishReason: 'tool_calls',
      model: 'fake/model',
    }],
  }));
  assert.ok(rounds.length >= 2, 'the session stopped after one round');
  assert.equal(rounds[0], rounds[1], 'the offer changed with the shortlist disabled');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE GUARD THE PRIOR AUTHOR WAS PROTECTING — at the new default
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── ⚠️⚠️ THE STALE OBJECTION, RE-MEASURED RATHER THAN ARGUED ───────────────
 *
 * *"Wiring this on by default turned `tool-prefix-order.test.mjs` red: two
 * sessions differing only in `--no-run` shared 14,088 bytes against an absolute
 * floor of 15,000."* That was written before `shortlistTools`' under-12-character
 * rule was inverted and its core widened. This runs the same pair at the new
 * DEFAULT and asserts the same floor, so the claim is defended continuously
 * rather than checked once in a comment — and if it ever stops holding, THIS is
 * what goes red, not a guard belonging to another lane.
 */
test('⚠️⚠️ the --no-run pair still clears the 15,000-byte floor WITH the shortlist on', async () => {
  const root = workspace();
  const task = 'say what a.js exports';
  const [open] = await withFlag(null, () => capture(task, { root, allowRun: true }));
  const [locked] = await withFlag(null, () => capture(task, { root, allowRun: false }));

  assert.ok(open.includes('"run_command"'), 'run_command should be offered without --no-run');
  assert.ok(!locked.includes('"run_command"'), '--no-run must still withhold run_command');

  const shared = sharedPrefixBytes(open, locked);
  console.log(`   --no-run pair, shortlist ON  ${open.length}B vs ${locked.length}B  shared prefix ${shared}B`);
  assert.ok(shared > 15000, `only ${shared} bytes of shared prefix survive at the default — the prior author's objection is live again`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DETERMINISM — the invariant that outranks every saving above
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ THREE FRESH PROCESSES, NOT THREE CALLS. Module state, memoised
 * derivations and a warm `Map` insertion order all survive between calls in one
 * process, and every one of them is a way for the head to differ between two
 * RUNS of the CLI while looking stable inside one. Prefix caching is a property
 * of separate processes on separate days, so the proof has to be too.
 */
test('⚠️⚠️⚠️ DETERMINISM: three separate processes send byte-identical tool blocks', () => {
  const root = workspace();
  const script = [
    `import { runSession } from ${JSON.stringify(new URL('../lib/turn.mjs', import.meta.url).href)};`,
    `import { createLocalExecutor } from ${JSON.stringify(new URL('../lib/workspace.mjs', import.meta.url).href)};`,
    'import { createHash } from "node:crypto";',
    `const root = ${JSON.stringify(root)};`,
    'const out = [];',
    'for (const task of ["hi", "add a dark mode toggle to the settings page and update the tests"]) {',
    '  let sent = null;',
    '  await runSession({',
    '    task, executor: createLocalExecutor(root),',
    '    config: { apiKey: "x", model: "fake/model" }, maxRounds: 8, allowRun: true,',
    '    callModelImpl: async (opts) => { if (!sent) sent = JSON.stringify(opts.tools);',
    '      return { ok: true, content: "a", toolCalls: [], usage: { cost: 0, total_tokens: 1 }, finishReason: "stop", model: "fake/model" }; },',
    '    onEvent: () => {},',
    '  });',
    '  out.push(createHash("sha256").update(sent).digest("hex") + ":" + sent.length);',
    '}',
    'process.stdout.write(out.join(" "));',
  ].join('\n');

  /**
   * ⚠️ THE FLAG IS DELETED, NOT SET TO `undefined`. This proves the DEFAULT is
   * stable, and a key whose value is the string "undefined" would be neither
   * unset nor off — it would be a third case nobody wrote a rule for.
   */
  const childEnv = { ...process.env };
  delete childEnv.ACUVO_TOOL_SHORTLIST;
  const run = () => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 180_000,
    env: childEnv,
  });
  const runs = [run(), run(), run()];

  // ⚠️ Shape first — a child that crashed and printed nothing would "pass" thrice.
  assert.match(runs[0], /^[0-9a-f]{64}:\d+ [0-9a-f]{64}:\d+$/, `the subprocess did not produce two digests: ${runs[0]}`);
  const [trivial, real] = runs[0].split(' ');
  assert.notEqual(trivial, real, 'the two tasks produced the same block — the fixture cannot tell them apart, so nothing is proven');

  assert.equal(runs[0], runs[1], `two processes sent different tool blocks:\n${runs[0]}\n${runs[1]}`);
  assert.equal(runs[1], runs[2], `the third process disagreed:\n${runs[1]}\n${runs[2]}`);
  console.log(`   determinism  3/3 identical   "hi" ${trivial.split(':')[1]}B   realistic ${real.split(':')[1]}B`);
});
