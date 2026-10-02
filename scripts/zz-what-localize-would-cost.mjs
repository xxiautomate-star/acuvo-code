/**
 * ── ⭐⭐ WHAT WOULD `localize_files` COST, AND WHAT WOULD IT BUY? ────────────
 *
 * `lib/localize.mjs` shipped 834 lines, two test files and NO importer.
 * `test/wiring-reach.test.mjs` has carried it on `KNOWN_UNWIRED` since
 * 2026-08-20 with a dated excuse that says, verbatim, *"If this line is still
 * here without that decision having been made, the excuse has expired."*
 *
 * ⚠️ THIS SCRIPT IS THE INSTRUMENT FOR THAT DECISION, not a summary of it. The
 * decision itself lives in `DECISION-localize-files.md` beside this file, and
 * the numbers there came from a run of this. Re-run it rather than trusting a
 * figure anybody typed — three separate numbers in CLAUDE.md's own byte-ceiling
 * section went stale exactly that way.
 *
 * It answers the four questions the decision turns on:
 *
 *   1. what the SCHEMA adds to the per-round tool block, per brief, through the
 *      shortlist the CLI actually uses;
 *   2. what the SYSTEM PROMPT adds — `systemPrompt({ offeredNames })` is built
 *      from the offer, so a verb is not only its schema;
 *   3. what one CALL costs, because a localization tool is not a schema, it is
 *      ≥3 extra model calls whose prompts carry the tree and the skeletons;
 *   4. what the turn ALREADY sends to answer "which files" — the task-seeded
 *      repo map, plus the six file-finding verbs that are in CORE_TOOLS on
 *      every single task. ⭐ THIS IS THE ONE THAT DECIDES IT: the module's
 *      15-17x is measured against a NO-FILE baseline, and this CLI is not at
 *      one.
 *
 * Run:  node scripts/zz-what-localize-would-cost.mjs
 */
import { localizeToolSchemas, renderTree, DEFAULT_TREE_BUDGET_TOKENS, MAX_LOCALIZE_ROUNDS } from '../lib/localize.mjs';
import { TOOL_SCHEMAS, toolSchemasFor } from '../lib/tools.mjs';
import { shortlistTools, CORE_TOOLS } from '../lib/tool-shortlist.mjs';
import { systemPrompt } from '../lib/turn.mjs';
import { buildRepoMap } from '../lib/repo-map.mjs';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());

function listPaths(dir, out = [], base = dir, depth = 0) {
  if (depth > 12) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listPaths(p, out, base, depth + 1);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const paths = listPaths(root);
const bytes = (s) => Buffer.byteLength(String(s), 'utf8');

const schema = localizeToolSchemas();
const schemaBytes = bytes(JSON.stringify(schema));
const allNames = TOOL_SCHEMAS.map((t) => t.function.name);

const BRIEFS = [
  'hi',
  'fix the typo in the readme',
  'rename the formatPrice helper and remove every unused export',
  'the login page 500s somewhere in the auth flow, find it and fix it',
  'add a dark mode toggle to the settings page',
];

// ── 1 + 2. the per-round fixed payload, with and without the verb ───────────
console.log('== 1+2. THE PER-ROUND FIXED PAYLOAD — system prompt + tool block ==');
console.log('   (both are re-sent every round; the prompt is built FROM the offer)');
console.log('');
console.log(`  localize_files schema, on its own      ${schemaBytes.toLocaleString()} B`);
console.log(`  whole registry (${allNames.length} tools)              ${bytes(JSON.stringify(toolSchemasFor(allNames))).toLocaleString()} B`);
console.log('');
console.log('   tools    without      with    delta     %   brief');
for (const b of BRIEFS) {
  const kept = shortlistTools(b, allNames);
  const withOut = bytes(JSON.stringify(toolSchemasFor(kept))) + bytes(systemPrompt({ maxRounds: 24, offeredNames: kept }));
  const keptPlus = [...kept, 'localize_files'];
  const withIn = bytes(JSON.stringify(toolSchemasFor(kept))) + schemaBytes
    + bytes(systemPrompt({ maxRounds: 24, offeredNames: keptPlus }));
  const d = withIn - withOut;
  console.log(
    `    ${String(kept.length).padStart(3)}  ${String(withOut).padStart(8)}  ${String(withIn).padStart(8)}`
    + `  ${String('+' + d).padStart(7)}  ${((d / withOut) * 100).toFixed(2).padStart(5)}%  ${b.slice(0, 40)}`,
  );
}

// ── 3. the run ──────────────────────────────────────────────────────────────
const tree = renderTree(paths, { budgetTokens: DEFAULT_TREE_BUDGET_TOKENS });
console.log('');
console.log('== 3. THE RUN — what ONE localize_files call costs ==');
console.log(`  repo scanned                          ${paths.length.toLocaleString()} files`);
console.log(`  tree, sent on ask 1 and every files round   ${bytes(tree.text).toLocaleString()} B`);
console.log(`  model calls per invocation            ${1 + MAX_LOCALIZE_ROUNDS} worst case, ${1 + 2} typical`);
console.log(`  floor prompt cost of one call         ~${(bytes(tree.text) * 3).toLocaleString()} B, before skeletons`);
console.log('  ⚠️ these are MODEL CALLS, not bytes on an existing one. A verb that');
console.log('     costs three round-trips is not priced by its schema.');

// ── 4. what the turn already sends ──────────────────────────────────────────
console.log('');
console.log('== 4. WHAT THE TURN ALREADY SENDS TO ANSWER "WHICH FILES" ==');
for (const task of ['fix the typo in the readme', 'the login page 500s somewhere in the auth flow']) {
  let map = '';
  try {
    map = buildRepoMap(root, {}, { task });
    if (map && typeof map === 'object') map = map.text ?? JSON.stringify(map);
  } catch (err) { map = `(buildRepoMap threw: ${err.message})`; }
  console.log(`  repo map, task-seeded                 ${bytes(map).toLocaleString()} B   "${task.slice(0, 40)}"`);
}
console.log('  ⚠️ built ONCE PER SESSION (turn.mjs skips it when `continuing`), not per round.');
const finders = CORE_TOOLS.filter((t) => /file|symbol|search|usages|dir/.test(t));
console.log(`  file-finding verbs in CORE_TOOLS, offered on EVERY task (${finders.length}):`);
console.log(`    ${finders.join(' ')}`);
console.log('');
console.log('  ⭐ SO THE 15-17x IN THE MODULE HEADER IS AGAINST A NO-FILE BASELINE,');
console.log('     AND THIS CLI IS NOT AT ONE. That is the measurement the decision');
console.log('     turns on, and nothing here measures what localize_files would add');
console.log('     ON TOP of a repo map — see DECISION-localize-files.md for what would.');
