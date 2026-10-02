/**
 * ── ⭐⭐ WHAT IN `acuvo-code/lib/` IS BUILT AND REACHES NOBODY? ──────────────
 *
 * `project_acuvo_built_and_unwired_is_the_defect` records EIGHT capabilities
 * shipped built-and-unreached in 48 hours. `test/wiring-reach.test.mjs` guards
 * the coarse half (a FILE nothing imports). This script is the instrument for
 * the finer half, and it prints three signals — kept separate on purpose,
 * because two of them are diagnostic and one is a defect.
 *
 * Run:  node scripts/zz-what-is-dark.mjs
 *
 * ── ⚠️ WHICH SIGNAL IS A DEFECT, AND WHICH TWO ARE NOT ─────────────────────
 *
 *   A. a lib/ module no path from either binary reaches
 *          → A DEFECT unless a DECISION-*.md says otherwise.
 *
 *   B. a `*ToolSchemas` factory nothing ever calls
 *          → A DEFECT. Rarer and more expensive than (A), because the file can
 *            be imported, the tests can be green, and the verb still reaches no
 *            model. `lib/localize.mjs` was exactly this for a month.
 *            `test/wiring-reach.test.mjs` now guards it.
 *
 *   C. a registered verb that `toolNamesForRounds` offers in no configuration
 *          → ⚠️⚠️ **NOT A DEFECT, AND THE FIRST RUN OF THIS SCRIPT GOT IT
 *            WRONG.** It named six — `vercel_preview`, `playtest`, `inspect_db`,
 *            `sample_db_rows`, `profile_table`, `inspect_binary` — and every one
 *            is correctly gated on the WORKSPACE holding the thing it inspects
 *            (a linked Vercel project, a browser server, a database, a binary).
 *            Run in `acuvo-code/`, which has none of those, "offered nowhere"
 *            means "this directory has no database", not "the verb is dark". So
 *            (C) is printed with its gate, never as a list of problems — a
 *            reader who treats it as one will delete working gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(PKG, p), 'utf8');
const listMjs = (d) => fs.readdirSync(path.join(PKG, d)).filter((n) => n.endsWith('.mjs')).map((n) => `${d}/${n}`);

const files = [...listMjs('lib'), ...listMjs('bin'), ...listMjs('scripts')];
const imports = {};
for (const f of files) {
  const src = read(f);
  const rel = (spec) => path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
  imports[f] = [...new Set([
    ...[...src.matchAll(/from '(\.[^']+)'/g)].map((m) => rel(m[1])),
    ...[...src.matchAll(/new URL\('(\.[^']+)',\s*import\.meta\.url\)/g)].map((m) => rel(m[1])),
    ...[...src.matchAll(/\bimport\('(\.[^']+)'\)/g)].map((m) => rel(m[1])),
  ])];
}

// ── A ───────────────────────────────────────────────────────────────────────
const seen = new Set();
const stack = ['bin/acuvo.mjs', 'bin/acuvo-mcp.mjs'];
while (stack.length) {
  const f = stack.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  for (const d of imports[f] ?? []) if (!seen.has(d)) stack.push(d);
}
const decisionText = fs.readdirSync(PKG).filter((n) => /^DECISION-.*\.md$/.test(n))
  .map((n) => `${n}\n${read(n)}`).join('\n');

console.log('== A. lib/ MODULES NO PATH FROM EITHER BINARY REACHES ==');
const darkFiles = files.filter((f) => f.startsWith('lib/') && !seen.has(f));
for (const f of darkFiles) {
  const named = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(decisionText);
  console.log(`  ${f.padEnd(30)} ${read(f).split('\n').length} lines   ${named ? 'DECIDED (a DECISION-*.md names it)' : '⚠️ UNDECIDED'}`);
}
if (darkFiles.length === 0) console.log('  (none)');

// ── B ───────────────────────────────────────────────────────────────────────
console.log('');
console.log('== B. *ToolSchemas FACTORIES AND WHO CALLS THEM ==');
const declared = [];
for (const f of listMjs('lib')) {
  for (const m of read(f).matchAll(/^export function (\w*ToolSchemas)\b/gm)) declared.push({ name: m[1], file: f });
}
const srcs = [...listMjs('lib'), ...listMjs('bin')].map((rel) => ({ rel, src: read(rel) }));
let dark = 0;
for (const { name, file } of declared) {
  const callers = srcs.filter(({ rel, src }) => rel !== file
    && new RegExp(`${name}\\s*\\(`).test(src.replace(new RegExp(`^import .*${name}.*$`, 'gm'), '')))
    .map(({ rel }) => rel);
  if (callers.length > 0) continue;
  dark += 1;
  const named = new RegExp(`\\b${name}\\b`).test(decisionText);
  console.log(`  ⚠️ ${name.padEnd(26)} declared in ${file}, called by NOBODY   ${named ? '— DECIDED' : '— UNDECIDED'}`);
}
console.log(`  ${declared.length} factories, ${declared.length - dark} called, ${dark} not.`);

// ── C ───────────────────────────────────────────────────────────────────────
console.log('');
console.log('== C. REGISTERED VERBS THIS WORKSPACE IS OFFERED IN NO CONFIGURATION ==');
console.log('   ⚠️ DIAGNOSTIC, NOT A DEFECT LIST — read the header. Most of these are');
console.log('      gated on the workspace holding a database / a binary / a browser.');
const { TOOL_SCHEMAS, toolNamesForRounds } = await import('../lib/tools.mjs');
const env = { ...process.env };
delete env.ACUVO_OFFLINE;
const reach = new Set();
for (const allowRun of [true, false]) {
  for (const interactive of [true, false]) {
    for (const subagent of [true, false]) {
      for (const rounds of [1, 24]) {
        for (const n of toolNamesForRounds(rounds, { allowRun, interactive, subagent, env, root: PKG })) reach.add(n);
      }
    }
  }
}
const never = TOOL_SCHEMAS.map((t) => t.function.name).filter((n) => !reach.has(n));
console.log(`  registry ${TOOL_SCHEMAS.length} · offered here in some configuration ${reach.size}`);
console.log(`  not offered here: ${never.length ? never.join(' ') : '(none)'}`);
