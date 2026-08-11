/**
 * ── ⭐ THE BENCH RUNNER ──────────────────────────────────────────────────────
 *
 * Runs every task in the corpus against a fresh workspace and reports what
 * happened — mechanically, in one pass, without a human watching each round.
 *
 *   node acuvo-code/bench/run.mjs                # all of them
 *   node acuvo-code/bench/run.mjs --only git,fix # a subset
 *   node acuvo-code/bench/run.mjs --list         # free — spends nothing
 *   node acuvo-code/bench/run.mjs --keep         # leave the workspaces to inspect
 *
 * ── ⚠️ WHAT IT REPORTS THAT A PASS/FAIL COLUMN WOULD NOT ────────────────────
 * The aggregate REFUSALS table, and it is the reason this exists rather than a
 * simple score. `node -e` was refused in five consecutive hand-runs before I
 * noticed it was systematic — a ~20% tax on every session's round budget, fully
 * invisible in a green/red column because the task still passed. A defect that
 * only shows up as a pattern across runs needs something that looks across runs.
 *
 * ⚠️ AND IT DOES NOT SCORE QUALITY. Every check is mechanical: the file exists,
 * the module returns 6, the tree is clean, the test file was not edited. There
 * is no model judging output here — a bench whose grader can be wrong tells you
 * nothing about the thing it is grading, and we already learned that a critic
 * scored 5 of 6 identically when asked for taste.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TASKS } from './tasks.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'acuvo.mjs');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

if (has('--list')) {
  console.log('\nAcuvo Code bench — the corpus:\n');
  for (const t of TASKS) console.log(`  ${t.id.padEnd(11)} ${t.what}  (${t.checks.length} checks, ${t.rounds} rounds)`);
  console.log(`\n${TASKS.length} tasks. Run without --list to execute them (costs roughly $0.01 total).\n`);
  process.exit(0);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set — the bench calls a real model. (Use --list to see the corpus for free.)');
  process.exit(2);
}

const only = valueOf('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const selected = only ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
if (selected.length === 0) {
  console.error(`No task matched --only ${only?.join(',')}. Known: ${TASKS.map((t) => t.id).join(', ')}`);
  process.exit(2);
}

/** Lay a task's fixture down in a fresh directory. */
function makeWorkspace(task) {
  const ws = mkdtempSync(join(tmpdir(), `acuvo-bench-${task.id}-`));
  for (const [rel, body] of Object.entries(task.setup.files ?? {})) {
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  if (task.setup.git) {
    const g = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
    g(['init', '-q', '-b', 'main']);
    // Local identity only — never touch the developer's global config.
    g(['config', 'user.email', 'bench@acuvo.local']);
    g(['config', 'user.name', 'Bench']);
    g(['add', '-A']);
    g(['commit', '-q', '-m', task.setup.git]);
  }
  return ws;
}

/**
 * ⚠️ THE CLI IS RUN AS A CHILD PROCESS, NOT IMPORTED. Importing runSession would
 * test the library and quietly skip argument parsing, the summary renderer and
 * the exit code — three things that have each had a real bug. The bench must
 * exercise what a user actually types.
 */
function runCli(task, ws) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [
    CLI, '--dir', ws, '--max-rounds', String(task.rounds), task.prompt,
  ], { encoding: 'utf8', timeout: 6 * 60_000, env: process.env });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    out,
    exitCode: r.status,
    seconds: (Date.now() - started) / 1000,
    // Parsed from the summary the CLI already prints — no second source of truth.
    /**
     * ⚠️ ANCHORED TO THE SUMMARY LINE, and the loose version reported $7.50 for
     * a task that cost $0.0008 — it matched the "$7.50" inside the FIXTURE's
     * own test name ("3 hours at $2.50/hr is $7.50"). Third time a bench
     * regex has scraped the wrong thing out of a transcript, and the pattern is
     * always the same: matching a shape that appears in DATA as well as in
     * output. The summary's shape is `model · N rounds · N tokens · $X` — the
     * `tokens · ` prefix is what makes it unambiguous.
     */
    cost: Number(out.match(/tokens\s*·\s*\$([0-9.]+)/)?.[1] ?? 0),
    rounds: Number(out.match(/·\s*(\d+) rounds?\s*·/)?.[1] ?? 0),
    verified: /✔ VERIFIED/.test(out),
    // The model's closing prose — what the 'refuse' task inspects.
    note: out.split('\n').filter((l) => l.trim() && !/^[·✎✂$✔✖─└│]/.test(l.trim())).slice(-6).join(' '),
    /**
     * ⚠️ ANCHORED TO REAL TOOL NAMES, and the first version was not — it matched
     * `✖ exit 1 · 6.99s` (a FAILING COMMAND, which is the loop working exactly
     * as designed) and reported it as a refused tool call named "exit". A
     * diagnostic that invents findings is worse than no diagnostic, because it
     * is the thing you turn to when you do not already know what is wrong.
     */
    refusals: [...out.matchAll(/^\s*✖\s*([a-z_]+)\s[^:]*:\s*(.+)$/gm)]
      .filter((m) => TOOL_NAMES.includes(m[1]))
      .map((m) => ({ tool: m[1], why: m[2].trim().slice(0, 90) })),
  };
}

const results = [];
console.log(`\nAcuvo Code bench — ${selected.length} task${selected.length === 1 ? '' : 's'}\n`);

for (const task of selected) {
  process.stdout.write(`  ${task.id.padEnd(11)} … `);
  const ws = makeWorkspace(task);
  let res;
  try {
    res = runCli(task, ws);
  } catch (err) {
    res = { out: String(err), exitCode: null, seconds: 0, cost: 0, rounds: 0, verified: false, note: '', refusals: [] };
  }

  const failures = [];
  for (const check of task.checks) {
    let verdict;
    // ⚠️ A THROWING CHECK IS A FAILED CHECK, never a crashed bench. Half a
    // report is worse than a slow one: you re-run everything to see the rest.
    try { verdict = check(ws, res); } catch (err) { verdict = `the check itself threw: ${err?.message ?? err}`; }
    if (verdict) failures.push(verdict);
  }

  results.push({ task, res, failures, ws });
  const mark = failures.length === 0 ? '[32mPASS[0m' : `[31mFAIL[0m ${failures.length}/${task.checks.length}`;
  console.log(`${mark}  ${res.rounds}r  ${res.seconds.toFixed(0)}s  $${res.cost.toFixed(4)}`);
  for (const f of failures) console.log(`               ↳ ${f}`);
  /**
   * ⚠️ THE TRANSCRIPT ON FAILURE, AND THE FIRST VERSION OMITTED IT — which made
   * the bench's own first two findings cost more to investigate than running
   * the task by hand would have. It said "nothing was committed" and I had to
   * go re-run the CLI manually to discover it HAD called git_commit.
   *
   * ⭐ A harness that reports a verdict without the evidence just moves the
   * spelunking, it does not remove it. The whole value proposition is finding
   * things without a human watching each round — so when it finds one, the
   * rounds have to be right there.
   */
  if (failures.length > 0) {
    const rounds = res.out.split('\n')
      .filter((l) => /^(──| {2}[·✎✂$✔✖]|\s+[✔✖] exit)/.test(l) || /^\s{2}\S.*[a-z]/.test(l))
      .map((l) => l.replace(/^──.*round (\d+)\/(\d+).*$/, '  ── round $1/$2'));
    console.log('               ┌─ what it actually did:');
    for (const l of rounds.slice(0, 30)) console.log(`               │ ${l.trim()}`);
    console.log('               └─');
  }
  if (!has('--keep')) rmSync(ws, { recursive: true, force: true });
  else console.log(`               workspace: ${ws}`);
}

// ── The summary ─────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.failures.length === 0).length;
const cost = results.reduce((a, r) => a + r.res.cost, 0);
const seconds = results.reduce((a, r) => a + r.res.seconds, 0);

console.log(`\n${'─'.repeat(66)}`);
console.log(`  ${passed}/${results.length} tasks passed · $${cost.toFixed(4)} · ${seconds.toFixed(0)}s`);

/**
 * ⭐ THE REFUSAL TABLE — the reason the bench beats watching one run. A refusal
 * costs a whole round whether or not the task ends up passing, so a systematic
 * one is a permanent tax that no pass/fail column will ever show you.
 */
const refusals = results.flatMap((r) => r.res.refusals.map((x) => ({ ...x, task: r.task.id })));
if (refusals.length > 0) {
  const byWhy = new Map();
  for (const r of refusals) {
    const key = r.why.slice(0, 55);
    if (!byWhy.has(key)) byWhy.set(key, { tool: r.tool, tasks: new Set(), n: 0 });
    const e = byWhy.get(key);
    e.n += 1; e.tasks.add(r.task);
  }
  console.log(`\n  ⚠ ${refusals.length} refused tool call${refusals.length === 1 ? '' : 's'} — each one costs a round:`);
  for (const [why, e] of [...byWhy.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`     ×${e.n}  ${e.tool}  ${why}`);
    console.log(`           in: ${[...e.tasks].join(', ')}`);
  }
  const share = refusals.length / Math.max(1, results.reduce((a, r) => a + r.res.rounds, 0));
  if (share > 0.1) {
    console.log(`\n     ⚠ ${(share * 100).toFixed(0)}% of all rounds ended in a refusal. That is a systematic tax,`);
    console.log('       not bad luck — fix the tool or the prompt, not the task.');
  }
}

/**
 * ⚠️ ONLY TASKS THAT SHOULD VERIFY. `refuse` has nothing to run and `search`
 * only edits a constant — flagging them taught me to ignore the warning, which
 * is how a real one would slip past. A check that cries wolf disarms itself.
 */
const unverified = results.filter((r) => r.task.expectVerified !== false && !r.res.verified && r.failures.length === 0);
if (unverified.length > 0) {
  // Passing the checks without the CLI ever proving it to itself is a real
  // finding: the bench got lucky, and a user would have no reason to trust it.
  console.log(`\n  ⚠ ${unverified.length} passed the checks but the CLI never reported VERIFIED: ${unverified.map((r) => r.task.id).join(', ')}`);
}
console.log('');

process.exit(passed === results.length ? 0 : 1);
