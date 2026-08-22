/**
 * ── ⭐⭐ THE TOOLS BLOCK IS BYTE 0, AND ITS ORDER IS THE CACHE FLOOR ─────────
 *
 * `lib/tool-prefix.mjs` has the measurements. What this file protects is the
 * pair of properties that make the ordering safe AND worth having:
 *
 *   1. it is a PERMUTATION — no tool is added, dropped or reworded, so no
 *      capability is traded for a cache rate;
 *   2. the HEAD contains only tools that every configuration offers, so a
 *      machine that differs by one setting differs only in the TAIL.
 *
 * ⚠️⚠️ AND PROPERTY 2 IS ASSERTED BY RE-DERIVING IT, NOT BY READING THE LIST.
 * The failure this guards against is a future conditional tool landing in the
 * head: it would break no existing test, look like an ordinary registration, and
 * cost the whole prompt on every machine that does not have it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';

import { TOOL_SCHEMAS, toolNamesForRounds, toolSchemasFor } from '../lib/tools.mjs';
import { alwaysOfferedNames, orderForCachePrefix } from '../lib/tool-prefix.mjs';
import { sharedPrefixBytes } from '../lib/cache-floor.mjs';
import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-toolorder-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  return root;
}

const ROUNDS = 8;
const names = (opts) => toolNamesForRounds(ROUNDS, { root: '/acuvo-cache-core-probe-no-such-workspace', env: {}, ...opts });
const block = (opts, ordered) => {
  const picked = toolSchemasFor(names(opts));
  return JSON.stringify(ordered ? orderForCachePrefix(picked, { maxRounds: ROUNDS }) : picked);
};

// ── 1. it may not change what is offered ───────────────────────────────────

test('⭐⭐ ordering is a PERMUTATION — same tools, same schemas, same objects', () => {
  const picked = toolSchemasFor(names({ allowRun: true }));
  const ordered = orderForCachePrefix(picked, { maxRounds: ROUNDS });

  assert.equal(ordered.length, picked.length, 'a tool was added or dropped');
  assert.deepEqual(
    [...ordered.map((t) => t.function.name)].sort(),
    [...picked.map((t) => t.function.name)].sort(),
    'the offered SET changed',
  );
  /**
   * ⚠️ IDENTITY, NOT DEEP EQUALITY. A copy that happens to match today is a
   * copy that can drift tomorrow — the schemas must be the very same objects,
   * so a description can never be reworded on the way past.
   */
  for (const t of picked) assert.ok(ordered.includes(t), `${t.function.name} was replaced by a copy`);
});

test('the input array is not mutated', () => {
  const picked = toolSchemasFor(names({ allowRun: true }));
  const before = picked.map((t) => t.function.name).join(',');
  orderForCachePrefix(picked, { maxRounds: ROUNDS });
  assert.equal(picked.map((t) => t.function.name).join(','), before);
});

test('it is deterministic — the same offer always renders the same bytes', () => {
  assert.equal(block({ allowRun: true }, true), block({ allowRun: true }, true));
  assert.equal(block({ allowRun: false }, true), block({ allowRun: false }, true));
});

// ── 2. the head may contain only unconditional tools ───────────────────────

test('⚠️⚠️ NOTHING CONDITIONAL IS IN THE HEAD — re-derived across the config space', () => {
  /**
   * A brute force over one variable at a time, which is a WIDER space than the
   * module's own reduced matrix samples. If the reduced derivation ever admits a
   * tool this space omits, that tool is in the head on some machines and absent
   * on others — the exact defect, and this is what goes red.
   */
  const keys = [
    'ACUVO_ALLOW_PUSH', 'ACUVO_MEDIA_SECRET', 'MODAL_DOC_READ_URL', 'MODAL_FLUX_RESULT_URL',
    'MODAL_FLUX_URL', 'MODAL_PRESS_URL', 'MODAL_RENDER_AUDIT_URL', 'MODAL_SELECT_URL',
    'MODAL_TABLE_READ_URL', 'MODAL_TRANSCRIBE_URL', 'MODAL_TTS_URL', 'MODAL_VIDEO_SECRET',
    'PERCHANCE_IMAGE_TOKEN', 'PERCHANCE_IMAGE_URL', 'RENDER_AUDIT_URL',
  ];
  const core = alwaysOfferedNames(ROUNDS);
  let sampled = 0;
  for (const allowRun of [true, false]) {
    for (const subagent of [true, false]) {
      for (const interactive of [true, false]) {
        for (const root of ['/acuvo-cache-core-probe-no-such-workspace', process.cwd()]) {
          const envs = [{}];
          for (const k of keys) for (const v of ['', '1', '0', 'https://example.invalid']) envs.push({ [k]: v });
          for (const env of envs) {
            const offered = new Set(toolNamesForRounds(ROUNDS, { allowRun, subagent, interactive, root, env }));
            sampled += 1;
            for (const n of core) {
              assert.ok(offered.has(n), `"${n}" is in the cacheable head but this configuration does not offer it `
                + `(allowRun=${allowRun} subagent=${subagent} interactive=${interactive} env=${JSON.stringify(env)})`);
            }
          }
        }
      }
    }
  }
  assert.ok(sampled > 400, `only ${sampled} configurations were sampled`);
});

test('⭐ the head is worth having — it is most of the registry\'s bytes', () => {
  const core = alwaysOfferedNames(ROUNDS);
  const headBytes = JSON.stringify(TOOL_SCHEMAS.filter((t) => core.has(t.function.name))).length;
  assert.ok(core.size >= 20, `only ${core.size} tools are unconditional`);
  assert.ok(headBytes > 15000, `the unconditional head is only ${headBytes} bytes — the floor leans on it`);
});

test('⚠️ the known conditional tools are NOT in the head', () => {
  const core = alwaysOfferedNames(ROUNDS);
  for (const n of ['run_command', 'git_push', 'generate_image', 'ask_user', 'delegate', 'speak', 'read_document', 'git_commit']) {
    assert.ok(!core.has(n), `"${n}" depends on configuration and must sit in the tail`);
  }
  for (const n of ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text']) {
    assert.ok(core.has(n), `"${n}" is offered everywhere and belongs in the head`);
  }
});

test('⚠️⚠️ the derivation is MACHINE-INDEPENDENT — no root-gated tool can reach the head', () => {
  /**
   * The trap that nearly shipped: derive the core from what THIS machine offers
   * and a box with a language server produces a different ORDER from a box
   * without one — a sort whose result depends on the environment, which is
   * `localeCompare` in `lib/prefix-order.mjs` wearing a different hat.
   *
   * Skills and the LSP verbs are gated on files under the workspace, so they are
   * the tools that would differ. None of them may be in the head, on any machine.
   */
  const core = alwaysOfferedNames(ROUNDS);

  /**
   * ⚠⚠ `read_skill` MOVED OUT OF THIS LIST, AND THE FACT UNDER IT CHANGED.
   *
   * When this test was written, skills came only from a project's
   * `.acuvo/skills/`, so `read_skill` genuinely differed between machines. The
   * CLI now ships a BUILTIN shelf inside the binary (23 skills), and
   * `skillsAvailable()` asks `discoverAllSkills()`, which merges builtin with
   * project. Measured on this merge: it returns **true for a root that does not
   * exist**, so the verb is offered on every machine.
   *
   * ⭐ That makes it head-eligible, and the head is where we WANT it — the
   * whole point of this file is to put stable bytes in the cached prefix, and
   * `read_skill`'s schema is now stable bytes.
   *
   * ⚠️ The invariant is unchanged and still enforced below: a tool whose
   * availability depends on the MACHINE may not be in the head. The LSP verbs
   * still are, so they stay.
   */
  for (const n of ['find_definition', 'find_references', 'check_types', 'list_symbols']) {
    assert.ok(!core.has(n), `"${n}" is gated on the workspace and must never be in the shared head`);
  }
  assert.ok(
    core.has('read_skill'),
    'read_skill is no longer machine-dependent (builtin skills ship in the binary) and belongs in the head',
  );
});

test('⚠️⚠️ and it stays machine-independent ON A MACHINE THAT HAS THE EXTRA TOOLS', () => {
  /**
   * ⚠️ THE TEST ABOVE PASSES VACUOUSLY ON A BARE BOX. Measured while writing
   * this file: pointing the derivation's probe root at `process.cwd()` — the
   * mutation that reintroduces the whole defect — left every assertion green,
   * because this checkout has no `.acuvo/skills` directory and so offers the same
   * tools either way. A guard that cannot fail is not a guard.
   *
   * ⭐ So this one builds a workspace where the extra verb IS available and runs
   * the derivation in a child process rooted there. On a correct build the core
   * is unchanged, because the probe root is a path that cannot exist; on a build
   * that derives from the machine, `read_skill` joins the head and the order
   * changes for everybody who does not have skills.
   */
  const root = mkdtempSync(join(tmpdir(), 'acuvo-skilled-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"s","version":"1.0.0"}\n');
  mkdirSync(join(root, '.acuvo', 'skills'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'skills', 'deploy.md'), '# deploy\nRun the deploy script.\n');

  // The workspace really does unlock a verb the bare machine does not offer.
  const skilled = new Set(toolNamesForRounds(ROUNDS, { root, env: {}, allowRun: true }));
  assert.ok(skilled.has('read_skill'), 'the fixture failed to make read_skill available — this test proves nothing');

  const here = join(process.cwd(), 'lib', 'tool-prefix.mjs');
  const run = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(pathToFileURL(here).href)}).then((m) => `
      + 'process.stdout.write([...m.alwaysOfferedNames(8)].sort().join(",")));'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `the child derivation failed: ${run.stderr}`);
  const childCore = run.stdout.split(',').filter(Boolean);

  /**
   * ⚠⚠ THIS ASSERTION FLIPPED, AND THE FIXTURE GOT WEAKER — SAYING SO OUT LOUD.
   *
   * It used to read `!childCore.includes('read_skill')`, which was right while
   * skills came only from a project's `.acuvo/skills/`. The builtin shelf now
   * ships inside the binary, so `read_skill` is offered on every machine and is
   * in the core on BOTH sides.
   *
   * ⚠️ Consequence worth naming: `read_skill` no longer DISCRIMINATES, so this
   * fixture — which unlocks skills and nothing else — can no longer catch a
   * machine-derived core on its own. The `deepEqual` below is now carrying the
   * whole test. If the derivation ever regresses, the verb that would expose it
   * is an LSP one, and this fixture does not install a language server.
   *
   * ⭐ So this is a KNOWN reduction in coverage, not an oversight. Strengthening
   * it means a fixture that unlocks a still-machine-dependent verb.
   */
  assert.ok(
    childCore.includes('read_skill'),
    'read_skill vanished from the child core — builtin skills ship in the binary, so it must be present everywhere',
  );
  assert.deepEqual(childCore, [...alwaysOfferedNames(ROUNDS)].sort(),
    'the core differed between a bare cwd and a skills-bearing one');
});

test('a single-shot turn is its own cache pool', () => {
  /**
   * `toolNamesForRounds` returns SINGLE_SHOT_TOOL_NAMES at `maxRounds <= 1`, a
   * set that shares almost nothing with the multi-round offer. Deriving one core
   * for both would put multi-round tools in a single-shot head.
   */
  const single = alwaysOfferedNames(1);
  const multi = alwaysOfferedNames(8);
  assert.notEqual(single.size, multi.size);
  for (const n of single) assert.ok(multi.has(n), `"${n}" is unconditional single-shot but not multi-round`);
});

// ── 3. the money ───────────────────────────────────────────────────────────

test('⭐⭐ a configuration difference now costs its TAIL, not the whole prompt', () => {
  /**
   * MEASURED before the change, against a bare-machine reference of 31,354
   * bytes: `--no-run` shared 1,199 bytes of prefix — 3.8%. Everything behind
   * byte 1,199 (the rest of the tools, the system message, the repo map, the
   * task) was paid for at full price on every round.
   */
  const ref = { allowRun: true };
  const variants = [
    ['--no-run', { allowRun: false }],
    ['ACUVO_ALLOW_PUSH=1', { env: { ACUVO_ALLOW_PUSH: '1' } }],
    ['MODAL_TTS_URL set', { env: { MODAL_TTS_URL: 'https://example.invalid' } }],
    ['stdin is a TTY', { interactive: true }],
    ['subagent', { subagent: true }],
  ];
  for (const [label, opts] of variants) {
    const before = sharedPrefixBytes(block(ref, false), block({ ...ref, ...opts }, false));
    const after = sharedPrefixBytes(block(ref, true), block({ ...ref, ...opts }, true));
    assert.ok(after > before, `${label}: ordering did not help (${before} -> ${after})`);
    /**
     * ⚠️ AN ABSOLUTE FLOOR, NOT ONLY AN IMPROVEMENT. "better than before" passes
     * on a one-byte gain; the head is ~19k bytes and every one of these must
     * reach it, because that is the number the margin is made of.
     */
    assert.ok(after > 15000, `${label}: only ${after} bytes of shared prefix survive`);
  }
});

test('⭐ the worst case improves by more than an order of magnitude', () => {
  const before = sharedPrefixBytes(block({ allowRun: true }, false), block({ allowRun: false }, false));
  const after = sharedPrefixBytes(block({ allowRun: true }, true), block({ allowRun: false }, true));
  assert.ok(before < 2000, `the unordered baseline was ${before} — this test is measuring the wrong thing`);
  assert.ok(after / before > 8, `--no-run improved only ${(after / before).toFixed(1)}x (${before} -> ${after})`);
});

// ── 4. REACH — it is applied on the real path, not merely exported ──────────

test('⭐⭐ REACH: two real sessions differing only in --no-run share the head', async () => {
  /**
   * ⚠️ THE HALF THAT GETS MISSED. A pure function with perfect tests and no
   * caller is 200 lines of very well-commented dead weight — this repo has nine
   * of those on record. This drives the real `runSession` and reads the bytes
   * that actually reached the model.
   */
  const root = workspace();
  const capture = async (allowRun) => {
    let sent = null;
    await runSession({
      task: 'say what a.js exports',
      executor: createLocalExecutor(root),
      config: { apiKey: 'x', model: 'fake/model' },
      maxRounds: ROUNDS,
      allowRun,
      callModelImpl: async (opts) => {
        if (!sent) sent = JSON.stringify(opts.tools);
        return { ok: true, content: 'a', toolCalls: [], usage: { cost: 0, total_tokens: 1 }, finishReason: 'stop', model: 'fake/model' };
      },
      onEvent: () => {},
    });
    return sent;
  };

  const open = await capture(true);
  const locked = await capture(false);
  assert.ok(open && locked, 'no request was made');

  const shared = sharedPrefixBytes(open, locked);
  assert.ok(shared > 15000, `the two offers share only ${shared} bytes of prefix on the real path`);

  // ⚠️ And --no-run really did withhold the verbs, so the sharing is not because
  // the flag stopped working.
  assert.ok(open.includes('"run_command"'), 'run_command should be offered without --no-run');
  assert.ok(!locked.includes('"run_command"'), '--no-run must still withhold run_command');
});

test('⭐ REACH: the head really is at the front of what the model receives', async () => {
  const root = workspace();
  let sent = null;
  await runSession({
    task: 'say what a.js exports',
    executor: createLocalExecutor(root),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds: ROUNDS,
    allowRun: true,
    callModelImpl: async (opts) => {
      if (!sent) sent = opts.tools;
      return { ok: true, content: 'a', toolCalls: [], usage: { cost: 0, total_tokens: 1 }, finishReason: 'stop', model: 'fake/model' };
    },
    onEvent: () => {},
  });

  const core = alwaysOfferedNames(ROUNDS);
  const offered = sent.map((t) => t.function.name);
  const firstConditional = offered.findIndex((n) => !core.has(n));
  const lastCore = offered.reduce((acc, n, i) => (core.has(n) ? i : acc), -1);
  assert.ok(firstConditional > 0, 'the request should begin with unconditional tools');
  assert.ok(
    lastCore < firstConditional,
    `"${offered[lastCore]}" (unconditional) is behind "${offered[firstConditional]}" (conditional) — the partition did not apply`,
  );
});

test('⚠️ the derivation touches no disk and answers the same on the second call', () => {
  /**
   * The derivation NAMES a path that cannot exist so that root-gated verbs
   * answer "absent" identically everywhere. If anything ever created it, the
   * answer would start depending on whether the probe had run — a cache pool
   * that changes on the second invocation of the day.
   */
  const probe = '/acuvo-cache-core-probe-no-such-workspace';
  assert.equal(existsSync(probe), false, 'the probe root existed BEFORE the derivation — pick another name');
  const first = [...alwaysOfferedNames(ROUNDS)].sort();
  assert.equal(existsSync(probe), false, 'the derivation created its own probe root');
  assert.deepEqual([...alwaysOfferedNames(ROUNDS)].sort(), first, 'the second derivation disagreed with the first');
});
