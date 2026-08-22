/**
 * ── ⭐⭐ WHAT THE AGENT LEARNS, KEPT ─────────────────────────────────────────
 *
 * `project-memory.mjs` opens by naming the prize exactly right: *"what a wrapper
 * CAN own is the accumulated context — the thing that makes session forty better
 * than session one."* Then it delivers a file a HUMAN writes. ACUVO.md is
 * conventions someone typed; nothing the agent DISCOVERS survives the process
 * exiting.
 *
 * So session forty re-derives what session one already learned, and gets it
 * wrong in the same way — `npm test` that runs zero tests, a `require()` in an
 * ESM project, the dev server on the wrong port. Every one of those is a fact
 * the agent held for a few minutes and then threw away.
 *
 * ⭐ `session.mjs` FIXED RESUMING ONE RUN. This is the other half: facts that
 * outlive every run. Together they are the difference between a tool you
 * re-explain your project to daily and one that knows it.
 *
 * ── ⚠️ THE FIVE RULES, AND THE FAILURE EACH ONE PREVENTS ────────────────────
 *
 * 1. ⚠️⚠️ A WRONG MEMORY IS WORSE THAN NO MEMORY, and it is the reason this
 *    module is mostly restraint. A false fact goes into EVERY future prompt and
 *    the model acts on it forever — and it presents as the model being stupid
 *    rather than as us having poisoned it. This repo watched a TEST pin a false
 *    claim in place for a day while the model quoted it straight back and burned
 *    a round working around output that was already correct. So every entry
 *    carries WHY it was learned, and `forget()` is one call.
 *
 * 2. ⚠️ IT MUST NOT GROW FOREVER. Memory that only accumulates eventually eats
 *    the very context budget it exists to save. Bounded by entry count and by
 *    bytes; the oldest is evicted first.
 *
 * 3. ⚠️ NO SECRET IS EVER WRITTEN. The agent is routinely holding `.env`
 *    contents and API keys in its context, and these files are meant to be
 *    COMMITTED. The redaction here is deliberately blunt: a fact that looks like
 *    it carries a credential is refused outright rather than cleaned, because a
 *    half-redacted secret in a git history is still a leaked secret.
 *
 * 4. ⚠️ IT MUST BE REVIEWABLE — markdown under `.acuvo/memory/`, diffable and
 *    committable, for exactly the reason project-memory.mjs gives for ACUVO.md:
 *    a hidden per-user store means two developers on one codebase get two
 *    different agents and neither can see why.
 *
 * 5. ⭐ IT MUST NOT BREAK PROMPT CACHING. Measured 2026-08-11: DeepSeek caches
 *    automatically and gives **3.05x**, but only when the prompt prefix repeats
 *    BYTE-FOR-BYTE. The block this module renders is therefore DETERMINISTIC —
 *    sorted, no timestamps in the body, no reordering — so it is identical on
 *    every round of a session. Anything that reshuffled here would silently cost
 *    three times the money and nothing would report it.
 *
 * ── ⚠️ WHAT IS WORTH REMEMBERING, WHICH IS THE HARD PART ────────────────────
 * Not "I read src/index.js". A memory is worth keeping only if a FUTURE session
 * would otherwise get it wrong: the real test command, the module system, where
 * things live, a convention, a mistake that cost rounds. The tool description
 * says so in those words, because the model is the one deciding.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { byCodePointOn } from './prefix-order.mjs';

/** Where learned facts live. Inside the workspace, so it can be committed. */
export const LEARNED_DIR = join('.acuvo', 'memory');

/**
 * Bounds. Both exist because the failure they prevent is silent: a memory that
 * grows without limit does not error, it just quietly consumes the context
 * budget until the useful part no longer fits.
 */
export const MAX_LEARNED_ENTRIES = 40;
export const MAX_LEARNED_BYTES = 4_000;
export const MAX_FACT_CHARS = 400;
export const MAX_WHY_CHARS = 200;

/**
 * ⚠️ REFUSE, DO NOT REDACT. A fact that looks like it carries a credential is
 * rejected whole. Cleaning it and storing the rest is worse: it teaches the
 * model the call succeeded, and a partially-redacted secret committed to a git
 * history is still a leaked secret.
 *
 * Deliberately broad. A false positive costs one refused memory and a clear
 * message; a false negative costs a key in a public repo.
 */
const SECRET_SHAPES = [
  /sk-[a-z]*-?v?\d?-?[A-Za-z0-9_-]{16,}/i,   // OpenAI / OpenRouter
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,             // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,           // Slack
  /\bAKIA[0-9A-Z]{16}\b/,                     // AWS
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /(api[_-]?key|secret|password|token|passwd|credential)\s*[=:]\s*\S{8,}/i,
];

export function looksLikeSecret(text) {
  const s = String(text ?? '');
  for (const rx of SECRET_SHAPES) {
    const m = s.match(rx);
    if (m) return m[0].slice(0, 12);
  }
  return null;
}

/**
 * ⚠️ A NAME BECOMES A FILENAME, so it is the one field an attacker (or a
 * confused model) could use to write outside the directory. Reduced to a safe
 * slug rather than validated-and-refused: the model should not have to guess our
 * filename rules to record something true.
 */
export function slugify(name) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'note';
}

const dirFor = (root) => join(root, LEARNED_DIR);

function parseEntry(name, raw) {
  // Frontmatter is deliberately tiny and hand-editable. A file that does not
  // have it is skipped, never fatal — a human is expected to edit these.
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const head = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (kv) head[kv[1]] = kv[2].trim();
  }
  const fact = m[2].trim();
  if (!fact) return null;
  return {
    name: head.name || name,
    fact,
    why: head.why || '',
    learnedAt: head.learnedAt || '',
  };
}

function serialise(entry) {
  return [
    '---',
    `name: ${entry.name}`,
    `why: ${entry.why}`,
    `learnedAt: ${entry.learnedAt}`,
    '---',
    '',
    entry.fact,
    '',
  ].join('\n');
}

/**
 * Read every learned fact. Never throws: a workspace with no memory is the
 * normal case, and one corrupt file must not take the rest down with it.
 *
 * @returns {{ ok: true, entries: Array<{name:string,fact:string,why:string,learnedAt:string}>, skipped: number }}
 */
export function recall(root) {
  const dir = dirFor(root);
  if (!existsSync(dir)) return { ok: true, entries: [], skipped: 0 };
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.md')); }
  catch { return { ok: true, entries: [], skipped: 0 }; }

  const entries = [];
  let skipped = 0;
  for (const f of names.sort()) {
    let raw;
    try { raw = readFileSync(join(dir, f), 'utf8'); } catch { skipped += 1; continue; }
    const e = parseEntry(f.replace(/\.md$/, ''), raw);
    if (e) entries.push(e); else skipped += 1;
  }
  /**
   * ⭐ SORTED BY NAME, NOT BY TIME. The prompt block must be byte-identical
   * across every round of a session or prompt caching (3.05x) stops firing, and
   * a time sort would reorder the moment anything new is learned mid-session.
   *
   * ⚠️⚠️ AND NOT BY `localeCompare`, WHICH IS WHAT THIS LINE USED TO SAY.
   * This block renders into the system-message preamble — the very FIRST bytes of
   * every prompt — and `localeCompare` with no locale argument resolves against
   * the runtime's default locale and the Node build's ICU data. Two workers on
   * the same repo could therefore render a different byte at position 0 and
   * share no prompt cache whatsoever, which is exactly the fleet configuration
   * this project is built for. `repo-map.mjs` wrote that rule down first
   * ("⚠️ NOT `localeCompare` — ICU differs per machine"); this file did not
   * inherit it. See `prefix-order.mjs`.
   */
  entries.sort(byCodePointOn('name'));
  return { ok: true, entries, skipped };
}

/**
 * Record one fact. Replaces any existing fact of the same name — two
 * contradictory beliefs about one thing is worse than either alone.
 *
 * @param {string} root
 * @param {{ name: string, fact: string, why: string }} args
 * @param {{ clock?: () => Date }} [opts]
 */
export function remember(root, args = {}, { clock = () => new Date() } = {}) {
  const fact = typeof args.fact === 'string' ? args.fact.trim() : '';
  if (!fact) return { ok: false, error: 'fact is required — a memory with no content is noise' };
  if (fact.length > MAX_FACT_CHARS) {
    return { ok: false, error: `fact is ${fact.length} characters, over the ${MAX_FACT_CHARS} limit — keep it to one thing a future session would otherwise get wrong` };
  }

  const why = typeof args.why === 'string' ? args.why.trim().slice(0, MAX_WHY_CHARS) : '';
  if (!why) return { ok: false, error: 'why is required — a fact with no provenance cannot be judged later, and a wrong memory is worse than none' };

  for (const [field, value] of [['fact', fact], ['why', why], ['name', args.name]]) {
    const hit = looksLikeSecret(value);
    if (hit) {
      return {
        ok: false,
        error: `refusing to remember: ${field} looks like it contains a credential (${hit}…). These files are committed to the repo, so nothing secret can go in one. Record the SHAPE of the fact instead, e.g. "deploy needs OPENROUTER_API_KEY set".`,
      };
    }
  }

  const name = slugify(args.name);
  const dir = dirFor(root);
  try { mkdirSync(dir, { recursive: true }); }
  catch (err) { return { ok: false, error: `could not create ${LEARNED_DIR}: ${err?.message ?? err}` }; }

  const entry = { name, fact, why, learnedAt: clock().toISOString() };
  try { writeFileSync(join(dir, `${name}.md`), serialise(entry), 'utf8'); }
  catch (err) { return { ok: false, error: `could not write memory: ${err?.message ?? err}` }; }

  const pruned = prune(root);
  return { ok: true, name, path: join(LEARNED_DIR, `${name}.md`), evicted: pruned.evicted };
}

/** Remove a fact that turned out to be wrong. Safe when it does not exist. */
export function forget(root, name) {
  const slug = slugify(name);
  const file = join(dirFor(root), `${slug}.md`);
  if (!existsSync(file)) return { ok: false, error: `no memory named "${slug}"` };
  try { rmSync(file, { force: true }); } catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
  return { ok: true, name: slug };
}

/**
 * ⚠️ EVICT THE OLDEST, NEVER THE NEWEST. Sorted by `learnedAt` so the eviction
 * order is about age rather than alphabet — the one place a time sort is right,
 * because it never reaches the prompt.
 */
export function prune(root, { max = MAX_LEARNED_ENTRIES } = {}) {
  const { entries } = recall(root);
  if (entries.length <= max) return { ok: true, evicted: [] };
  const byAge = [...entries].sort((a, b) => String(a.learnedAt).localeCompare(String(b.learnedAt)));
  const doomed = byAge.slice(0, entries.length - max);
  const evicted = [];
  for (const e of doomed) {
    try { rmSync(join(dirFor(root), `${e.name}.md`), { force: true }); evicted.push(e.name); } catch { /* leave it */ }
  }
  return { ok: true, evicted };
}

/**
 * Render learned facts for the system prompt.
 *
 * ⭐ RETURNS EMPTY STRING WHEN THERE IS NOTHING. A heading with nothing under it
 * teaches the model the feature is broken — this package's own rule that a
 * control which presents itself and does nothing is worse than one that is absent.
 */
export function learnedPromptBlock(recalled) {
  const entries = recalled?.entries ?? [];
  if (entries.length === 0) return '';

  const lines = [
    'WHAT YOU HAVE LEARNED ABOUT THIS PROJECT BEFORE (from earlier sessions):',
  ];
  let used = lines[0].length;
  let shown = 0;
  for (const e of entries) {
    const line = `  · ${e.fact}`;
    /**
     * ── ⚠️⚠️ `continue`, NOT `break` — ONE BIG ENTRY USED TO DELETE ALL OF THEM ─
     *
     * `break` stopped at the first entry that did not fit, so a single oversized
     * fact silently discarded EVERY fact after it. With an entry near the front
     * of the sort order, that is the whole learned memory gone — the block still
     * renders, still looks healthy, and is simply missing what the agent knew.
     *
     * ⚠️ AND IT IS ATTACKER-REACHABLE, WHICH IS WHY IT IS NOT MERELY A BUG. The
     * entries are files in the repository and `recall` sorts by name, so whoever
     * writes the repo picks BOTH the sort key and the size. One oversized entry
     * named to sort first blanks the project's accumulated memory on every run,
     * with nothing on screen to say so. Found by an adversarial pass over the
     * untrusted-content fence.
     *
     * ⭐ Skipping keeps the budget honest AND keeps the small facts. The count
     * below already says how many were left out, so nothing becomes silent.
     */
    if (used + line.length > MAX_LEARNED_BYTES) continue;
    lines.push(line);
    used += line.length;
    shown += 1;
  }
  if (shown < entries.length) {
    lines.push(`  (${entries.length - shown} more not shown — the memory is larger than the prompt budget)`);
  }
  lines.push('⚠️ These are notes from past runs, not gospel. If one contradicts what you can see in the');
  lines.push('   files right now, believe the files and say so.');
  return lines.join('\n');
}

/**
 * ⭐ THE MODEL DECIDES WHAT IS WORTH KEEPING, so the description is where the
 * judgement lives. It names the test explicitly — would a future session get
 * this wrong without it — because "remember useful things" produces a memory
 * full of "I read a file".
 */
export function learnedToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'remember',
        description:
          'Record ONE durable fact about this project so future sessions do not have to rediscover it. '
          + 'Only worth it if a future session would otherwise get it WRONG: the real test command, the module '
          + 'system, where something lives, a house convention, or a mistake that cost you rounds. '
          + 'Do NOT record what you did this session, what a file contains, or anything that will be stale tomorrow. '
          + 'Never include a key, token or password — these files are committed to the repository.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'fact', 'why'],
          properties: {
            name: { type: 'string', description: 'short kebab-case identifier, e.g. "test-command". Re-using a name REPLACES that fact.' },
            fact: { type: 'string', description: `the fact itself, one or two sentences, max ${MAX_FACT_CHARS} characters` },
            why: { type: 'string', description: 'how you learned it — the evidence, so a human can judge later whether to keep it' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forget',
        description: 'Remove a previously recorded fact that has turned out to be wrong or is no longer true. A wrong memory is worse than no memory.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string', description: 'the identifier the fact was recorded under' } },
        },
      },
    },
  ];
}
