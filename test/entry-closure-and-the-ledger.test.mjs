/**
 * ── ⭐⭐⭐ THE GAP `wiring-reach.test.mjs` CANNOT SEE: *WHICH* ENTRY POINT ────
 *
 * That file walks the import graph from BOTH binaries seeded together and fails
 * on anything neither can reach. It is the right guard and it works — it caught
 * `repl-driver.mjs` the hour it shipped, and it currently holds two honest
 * entries on `KNOWN_UNWIRED`.
 *
 * ⚠️ AND ON 2026-08-30 IT WAS GREEN THROUGH A DEFECT THAT DISCARDED EVERY
 * DOLLAR THE MCP DAEMON SPENT. `chargeGpu` writes GPU seconds into a
 * module-level ledger in `budget.mjs`; `media.mjs`, `imagegen.mjs` and
 * `avatar-run.mjs` all call it, and all three ARE in the MCP server's closure.
 * What was not in that closure was anything that DRAINS the ledger — neither
 * `mcp-server.mjs` nor `bin/acuvo-mcp.mjs` imported `budget.mjs` or `audit.mjs`
 * at all. Measured with a fake renderer, on a daemon that lives for days:
 *
 *     meter after the call: usd=0.0028 calls=1
 *     .acuvo workspace exists? false | audit dir? false | spend.jsonl? false
 *
 * A seeded-together walk is structurally blind to that, because every module
 * involved is reachable from the OTHER binary. **Reachability is a property of
 * an entry point, not of a package**, and this file measures it per entry.
 *
 * ── ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT DO ────────────────────────────
 * It does not re-ask "is this module orphaned" — `wiring-reach.test.mjs` owns
 * that question and two lists answering one question is how one of them rots.
 * It asks the narrower one nothing owns: **can this process account for what it
 * is about to spend.**
 *
 * ── ⭐⭐ VERIFIED AGAINST THE BROKEN TREE, NOT ONLY AGAINST A FIXTURE ───────
 * The whole file was run against the actual pre-fix source, extracted with
 *
 *     git archive 5a3d34565^ acuvo-code/lib acuvo-code/bin | tar -x -C <tmp>
 *
 * and copied in unchanged. Result: **5 pass, 1 fail** —
 *
 *     not ok 4 — every module that dispatches a tool constructs a spend meter
 *       lib/mcp-server.mjs dispatches tools and never constructs a budget
 *
 * On today's tree the same file is 6/6. A guard written after a defect is only
 * worth having if somebody put the defect back and watched it fail; this one
 * was, and the first version of it did not (see `dispatchWithoutAMeter`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const norm = (p) => p.split(sep).join('/');
const rel = (f) => norm(relative(ROOT, f));

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (!/\.(mjs|js)$/.test(e)) continue;
    out.push(full);
  }
  return out;
}

/**
 * ⚠️ THREE KINDS OF EDGE, COPIED FROM `wiring-reach.test.mjs` ON PURPOSE AND
 * THE COPY IS LABELLED. A static import is the easy one; a file handed to
 * `spawn` via `new URL('./x.mjs', import.meta.url)` is every bit as wired; and
 * `bin/acuvo.mjs` lazily `await import()`s login, account and doctor so a CLI
 * whose startup a user feels does not parse them on every run.
 *
 * Missing any of the three does not under-report — it INVENTS an orphan, which
 * is how a correctly-wired file ends up on an allowlist that exists to shrink.
 */
function specifiers(src) {
  return [...new Set([
    ...[...src.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/new URL\('(\.[^']+)',\s*import\.meta\.url\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bimport\('(\.[^']+)'\)/g)].map((m) => m[1]),
  ])];
}

function buildGraph() {
  const files = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'bin'))];
  const known = new Set(files);
  const source = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const resolveSpec = (from, spec) => {
    const base = resolve(dirname(from), spec);
    for (const c of [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs')]) {
      if (known.has(c)) return c;
    }
    return null;
  };
  const edges = new Map(files.map((f) => [
    f,
    specifiers(source.get(f)).map((s) => resolveSpec(f, s)).filter(Boolean),
  ]));
  return { files, source, edges };
}

const GRAPH = buildGraph();

/** Every file an entry point loads, directly or transitively. PURE. */
export function closureOf(edges, entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length > 0) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const t of edges.get(f) ?? []) if (!seen.has(t)) stack.push(t);
  }
  return seen;
}

/**
 * ── ⚠️⚠️ THE RULE I WROTE FIRST WAS GREEN ON THE BROKEN TREE. SAY IT. ───────
 *
 * The obvious formulation is "does this process contain a writer of the ledger
 * and no reader of it". It was written, and then RUN AGAINST THE ACTUAL PRE-FIX
 * SOURCE (`git archive 5a3d34565^`), which is the only way anyone was ever
 * going to find out:
 *
 *     bin/acuvo-mcp.mjs  closure 115
 *       writers: budget.mjs, media.mjs, imagegen.mjs, avatar-run.mjs
 *       readers: turn.mjs, budget.mjs, cost-units.mjs        ← VERDICT: green
 *
 * `budget.mjs` DEFINES both halves and `turn.mjs` was in the closure because
 * `tools.mjs` imports it — loaded, never executed by that daemon. **A static
 * closure cannot tell "loaded" from "run"**, so the whole family of
 * writer-versus-reader rules is blind to this defect by construction. Shipping
 * it would have been a fifth entry on the repo's own list of guards that passed
 * while checking nothing.
 *
 * ⭐ WHAT DOES BITE, and it bites for a reason rather than by coincidence: the
 * defect is that a process DISPATCHES TOOLS and never constructs a meter. A
 * tool call can boot a GPU container; `executeToolCall` is the one door every
 * verb goes through. So the rule is about the DISPATCH SITE, not the ledger:
 *
 *     pre-fix   lib/mcp-server.mjs  dispatches | createBudget: false   ← RED
 *     today     lib/mcp-server.mjs  dispatches | createBudget: true    ← green
 *     both      lib/turn.mjs        dispatches | createBudget: true
 *
 * Verified against both trees before this file was written, not after.
 */
export function dispatchWithoutAMeter(rule, files, readSource) {
  const bad = [];
  for (const f of files) {
    const src = readSource(f);
    // The module that DEFINES the dispatcher is not a caller of it.
    if (rule.defines.test(src)) continue;
    if (!rule.dispatches.test(src)) continue;
    if (rule.meters.test(src)) continue;
    bad.push(f);
  }
  return bad;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RULES. One today, and adding a second is five lines.
 * ══════════════════════════════════════════════════════════════════════════ */
const LEDGER_RULES = [
  {
    name: 'the tool dispatch meter',
    defines: /export\s+(?:async\s+)?function\s+executeToolCall\b/,
    /** Every verb in the package goes through this one door. */
    dispatches: /\bexecuteToolCall\s*\(/,
    /** Constructing a budget is what drains `chargeGpu`'s ledger and records it. */
    meters: /\bcreateBudget\s*\(/,
    why: 'A tool call can boot a GPU container. A process that dispatches tools and never constructs a budget '
      + 'discards every dollar: measured 2026-08-30, the MCP daemon charged $0.0028 and wrote no meter, '
      + 'no audit directory and no spend.jsonl, on a daemon that lives for days.',
  },
];

/** The real entry points a user can start. `package.json` `bin`, and nothing else. */
const BINS = ['bin/acuvo.mjs', 'bin/acuvo-mcp.mjs'];

test('the graph is real before anything is concluded from it', () => {
  assert.ok(GRAPH.files.length > 100, `only ${GRAPH.files.length} modules found — the walk is not walking`);
  for (const b of BINS) {
    assert.ok(GRAPH.files.some((f) => rel(f) === b), `${b} is not in the graph — package.json bin moved`);
  }
  // Both binaries must reach a substantial closure, or "unreachable" below
  // would be an artefact of a broken resolver rather than a finding.
  for (const b of BINS) {
    const entry = GRAPH.files.find((f) => rel(f) === b);
    const c = closureOf(GRAPH.edges, [entry]);
    assert.ok(c.size > 50, `${b} reaches only ${c.size} modules — the resolver is broken, not the repo`);
  }
});

test('⚠️ the closure walk is DEMONSTRATED, both directions', () => {
  // A walk that returns everything, and one that returns only the seed, both
  // make every assertion below pass silently. So the algorithm is driven on a
  // graph built for the purpose.
  const edges = new Map([
    ['bin/a.mjs', ['lib/one.mjs']],
    ['lib/one.mjs', ['lib/two.mjs']],
    ['lib/two.mjs', ['lib/one.mjs']],       // a cycle must not hang
    ['bin/b.mjs', ['lib/three.mjs']],
    ['lib/three.mjs', []],
    ['lib/orphan.mjs', []],
  ]);
  const a = closureOf(edges, ['bin/a.mjs']);
  assert.deepEqual([...a].sort(), ['bin/a.mjs', 'lib/one.mjs', 'lib/two.mjs']);
  assert.equal(a.has('lib/three.mjs'), false, 'the walk crossed into another entry\'s closure');
  assert.equal(a.has('lib/orphan.mjs'), false, 'an unimported module was called reachable');
});

test('⭐⭐ THE REPRODUCTION: the pre-fix MCP dispatcher goes RED', () => {
  const rule = LEDGER_RULES[0];

  /**
   * ⚠️ THE THREE SOURCES ARE THE REAL SHAPES, not sketches. `mcp-server.mjs`
   * before 5a3d34565 imported `executeToolCall` and constructed nothing;
   * `turn.mjs` has always constructed a budget; `tools.mjs` DEFINES the
   * dispatcher and must never be reported for calling itself.
   */
  const prefix = new Map([
    ['lib/tools.mjs', 'export async function executeToolCall(call, executor, opts) { return 1; }'],
    ['lib/mcp-server.mjs', 'import { executeToolCall } from "./tools.mjs";\n'
      + 'const outcome = await executeToolCall(call, executor, {});'],
    ['lib/turn.mjs', 'const budget = createBudget({ usd });\n'
      + 'const record = await executeToolCall(call, executor, {});'],
  ]);
  assert.deepEqual(
    dispatchWithoutAMeter(rule, [...prefix.keys()], (f) => prefix.get(f)),
    ['lib/mcp-server.mjs'],
    'the detector did not report a dispatcher that constructs no meter',
  );

  /**
   * ⚠️ AND THE THREE NEGATIVE CONTROLS, because "found nothing" and "looked for
   * nothing" are the same empty array and this repo has shipped both.
   */
  const fixed = new Map([...prefix, ['lib/mcp-server.mjs',
    'const budget = createBudget({ usd });\nconst o = await executeToolCall(call, executor, {});']]);
  assert.deepEqual(
    dispatchWithoutAMeter(rule, [...fixed.keys()], (f) => fixed.get(f)), [],
    'a dispatcher that DOES construct a meter was still reported',
  );
  assert.deepEqual(
    dispatchWithoutAMeter(rule, ['lib/tools.mjs'], (f) => prefix.get(f)), [],
    'the module that DEFINES the dispatcher was reported for containing its own name',
  );
  const quiet = new Map([['lib/chart.mjs', 'export function chart() { return ""; }']]);
  assert.deepEqual(
    dispatchWithoutAMeter(rule, [...quiet.keys()], (f) => quiet.get(f)), [],
    'a module that dispatches nothing was reported for having no meter',
  );
});

test('⭐⭐ every module that dispatches a tool constructs a spend meter', () => {
  const failures = [];
  for (const rule of LEDGER_RULES) {
    for (const f of dispatchWithoutAMeter(rule, GRAPH.files, (x) => GRAPH.source.get(x))) {
      failures.push(`${rel(f)} dispatches tools and never constructs a budget (${rule.name}). ${rule.why}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('⚠️ and that check is NOT vacuous — the dispatcher is really being found', () => {
  /**
   * The assertion above passes identically if the dispatch pattern has stopped
   * matching anything, which is the single most likely way this guard dies —
   * `executeToolCall` gets renamed and the file goes on being green forever.
   * So the population it judged is counted, and both known dispatchers must be
   * in it BY NAME.
   */
  const rule = LEDGER_RULES[0];
  const dispatchers = GRAPH.files
    .filter((f) => !rule.defines.test(GRAPH.source.get(f)) && rule.dispatches.test(GRAPH.source.get(f)))
    .map(rel);
  assert.ok(
    dispatchers.length >= 2,
    `only ${dispatchers.length} tool dispatchers found — the pattern has stopped matching, `
    + 'so the guard above is checking nothing',
  );
  for (const known of ['lib/turn.mjs', 'lib/mcp-server.mjs']) {
    assert.ok(dispatchers.includes(known), `${known} is no longer seen as a dispatcher — re-point this rule`);
  }
  // ...and the definer is excluded, or the rule would judge tools.mjs forever.
  assert.equal(dispatchers.includes('lib/tools.mjs'), false, 'the dispatcher definition is being judged as a caller');
});

test('the per-entry closures actually DIFFER — otherwise this file is redundant', () => {
  /**
   * ⚠️ THE WHOLE PREMISE, MEASURED. If both binaries loaded the same modules,
   * `wiring-reach.test.mjs`'s seeded-together walk would already answer every
   * question here and this file would be ceremony. They do not: the MCP daemon
   * loads a strict, substantially smaller subset, which is exactly the room a
   * producer-without-consumer defect lives in.
   */
  const [main, mcp] = BINS.map((b) => closureOf(GRAPH.edges, [GRAPH.files.find((f) => rel(f) === b)]));
  const onlyMain = [...main].filter((f) => !mcp.has(f)).map(rel).sort();
  assert.ok(
    onlyMain.length > 10,
    `only ${onlyMain.length} modules differ between the two binaries — re-read whether this file earns its place`,
  );
  if (process.env.DARK_PRINT) {
    console.log(`\n== reached by bin/acuvo.mjs and NOT by bin/acuvo-mcp.mjs (${onlyMain.length})`);
    for (const f of onlyMain) console.log('   ', f);
  }
});
