/**
 * ── ⭐⭐⭐ WHAT DOES ONE ROUND PAY FOR TOOL SCHEMAS, AND WHAT IS DEFERRED? ────
 *
 * Run:  node scripts/zz-what-does-a-round-cost-in-tools.mjs
 *       node scripts/zz-what-does-a-round-cost-in-tools.mjs "your brief here"
 *
 * ⚠️ WRITTEN BECAUSE A BRIEF HANDED TO THIS REPO ON 2026-09-20 ASSERTED THE
 * OPPOSITE OF WHAT THE CODE DOES, and it was a reasonable thing to assert. It
 * said the deferred-tools pattern — hold a small set, fetch a schema BY NAME when
 * you need it — exists in agent harnesses and that *"nothing does it for SCHEMAS"*
 * here; that `read_skill` defers INSTRUCTIONS and nothing defers VERBS.
 *
 * ⭐⭐ THE CLI HAS SHIPPED BOTH HALVES SINCE 2026-08-31 AND THE NUMBERS ARE BIG.
 * Not "a plan for one" — running code, in the round loop, rebuilding the `tools`
 * array mid-session when the model asks:
 *
 *   1. `lib/tool-shortlist.mjs`  — a CORE spine plus groups matched to the task,
 *      with `shouldWiden` re-offering everything the instant the model reaches
 *      for a verb it was not given. Same shape as the builder's shortlist.
 *   2. `lib/mcp-shortlist.mjs`   — **`use_toolset`**: ONE schema naming the
 *      withheld servers. The model calls it, `buildToolBlock()` runs again
 *      (`turn.mjs` ~6252) and that server's tools are in the array from the next
 *      round on. That IS fetch-a-schema-by-name. It was built because appending
 *      every connected server cost **+34,890 B, +54%** on the default offer —
 *      "a number, not a decision", and eleven working servers were switched off
 *      over it.
 *
 * ── ⚠️⚠️ AND THE REASON THE CLI CAN CARRY 87 VERBS WHERE THE BUILDER CANNOT ──
 *
 * It is NOT that the CLI is richer. It is that the two surfaces pay in different
 * currencies, and a fix for one is a tax on the other:
 *
 *   · the BUILDER pays a RATIO — fixed payload < 1.3x the one-shot prompt, per
 *     brief, re-sent every round. Deferral is pure win there.
 *   · the CLI pays a CACHE. `lib/tool-prefix.mjs` measured the tools block as
 *     **94% of the shared prefix between two tenants** (21,466 of 22,889 B) and
 *     it is byte 0 of every request. A schema that arrives MID-SESSION moves
 *     byte 0 of every round after it and voids the cached prefix.
 *
 * ⭐ THAT IS WHY `use_toolset` IS THE RIGHT SHAPE AND A GENERAL "fetch any verb"
 * DOOR WOULD NOT BE: it fires rarely, at a server's granularity, and the schemas
 * it reveals are STICKY (`revealed` is absolute), so the prefix is voided once
 * and re-warms. A door the model opens every round would be a cache miss wearing
 * a saving's clothes. Do not add one without measuring the prefix.
 *
 * ── WHAT THIS PRINTS ────────────────────────────────────────────────────────
 *
 * Per brief: the shortlisted offer, its byte cost, the widened ceiling, and what
 * the shortlist is holding back. Plus the registry total and the MCP catalogue
 * sitting behind one schema. Nothing here calls a model or touches the network.
 */

import { TOOL_NAMES, toolNamesForRounds, toolSchemasFor } from '../lib/tools.mjs';
import { CORE_TOOLS, TOOL_GROUPS, shortlistTools, groupsForTask } from '../lib/tool-shortlist.mjs';
import { useToolsetSchema } from '../lib/mcp-shortlist.mjs';
import { CATALOGUE } from '../lib/mcp-defaults.mjs';

const bytes = (names) => JSON.stringify(toolSchemasFor(names)).length;
const pad = (n, w) => String(n).padStart(w);

/**
 * ⚠️ THE DEFAULT BRIEFS ARE A CORPUS, NOT A SAMPLE — five shapes chosen to pull
 * different groups. `feedback_an_instrument_that_looks_for_defects_will_find_them`
 * is the rule they exist under: ask what this would print if the product were
 * perfect. The answer is "a spread", and a spread is what a shortlist IS. A flat
 * column would mean the shortlist had stopped discriminating.
 */
const CORPUS = [
  'fix the failing test in lib/budget.mjs',
  'build me a landing page for my plumbing business',
  'make a promo reel for the launch',
  'refactor the auth module and rename the handler',
  'add a chart of monthly revenue to the dashboard',
];

const briefs = process.argv.slice(2).length ? process.argv.slice(2) : CORPUS;

/**
 * ⚠️ `interactive: true` IS DELIBERATE AND IS ITSELF A FINDING. `tool-prefix.mjs`
 * measured that a TTY run and a CI run of the same command shared only HALF their
 * prefix, because one is offered `ask_user`. Measuring the TTY case is measuring
 * what a person actually pays.
 */
const offer = toolNamesForRounds(20, { root: process.cwd(), interactive: true });
const widened = shortlistTools('', offer, { widened: true });

console.log('');
console.log('REGISTRY          %s verbs   %s B  (everything lib/tools.mjs defines)', pad(TOOL_NAMES.length, 3), pad(bytes(TOOL_NAMES), 6));
console.log('OFFER this machine %s verbs   %s B  (toolNamesForRounds, multi-round, TTY)', pad(offer.length, 2), pad(bytes(offer), 6));
console.log('WIDENED ceiling   %s verbs   %s B  (what shouldWiden re-offers)', pad(widened.length, 3), pad(bytes(widened), 6));
console.log('CORE spine        %s verbs   %s B  (offered under every brief)', pad(CORE_TOOLS.length, 3), pad(bytes(CORE_TOOLS.filter((n) => offer.includes(n))), 6));
console.log('');
console.log('groups: %s', Object.keys(TOOL_GROUPS).join(' '));
console.log('');
console.log('  per-round   verbs      B    % of widened  groups lit                      brief');
for (const brief of briefs) {
  const list = shortlistTools(brief, offer);
  const b = bytes(list);
  const pct = (100 * b) / bytes(widened);
  const lit = groupsForTask(brief);
  console.log(
    '              %s   %s   %s%%   %s  %s',
    pad(list.length, 3), pad(b, 6), pad(pct.toFixed(1), 5),
    (Array.isArray(lit) ? lit : [...(lit ?? [])]).join(' ').padEnd(30).slice(0, 30),
    brief,
  );
}

/**
 * ⭐ THE DOOR, PRICED. One schema stands in for every withheld server, and this
 * is what it costs — the number that makes "eleven servers are off because they
 * cost 34,890 B" into a decision instead of a shrug.
 */
const servers = CATALOGUE.map((e) => e.id ?? e.name).filter(Boolean);
const door = useToolsetSchema(servers);
console.log('');
console.log('DEFERRED — `use_toolset`');
console.log('  %s catalogue servers reachable behind %s B of schema', pad(servers.length, 3), pad(door ? JSON.stringify(door).length : 0, 5));
console.log('  revealing one rebuilds the tools array mid-run (turn.mjs buildToolBlock) and');
console.log('  voids the cached prefix ONCE — `revealed` is sticky, so it re-warms and stays.');
console.log('');
