/**
 * ── 🔎 ONE SKILL SEARCH, READ BY THE CLI AND THE BUILDER ────────────────────
 *
 * A skill is found by what a person NEEDS ("take a card payment", "the game
 * stutters"), not by its file name. This module is the one ranking both
 * clients use:
 *
 *   · the CLI imports it directly (`/skills search`, and the `load_skill`
 *     refusal that suggests the closest skills);
 *   · the builder reads a byte-identical COPY, `console/lib/skill-search.generated.mjs`,
 *     written by `console/scripts/gen-builder-skills.mjs` — the skills sit
 *     outside the Next root, so this file does too, and the same argument that
 *     made the skill bodies a generated module applies to the code that ranks
 *     them. `builder-skills-in-sync.test.ts` fails the build if the copy drifts.
 *
 * ⚠️ PURE AND DEPENDENCY-FREE ON PURPOSE. No `node:` import, no I/O: the builder
 * bundles it into a serverless function and the CLI runs it on every `/skills`.
 *
 * ── THE SCORE ───────────────────────────────────────────────────────────────
 *
 *   trigger PHRASE found in the need          +10 each  (the author said "this")
 *   single-word trigger matched                +4 each
 *   need word in the skill NAME                +3 each
 *   need word in description / when            +1 each
 *
 * Words are folded (lower case, a trailing -s/-es/-ing/-ed removed) so
 * "payments" meets `payment` and "persisting" meets `persist`.
 *
 * ⭐ `triggers` is the lever. A description is written to be READ; a trigger is
 * written to be MATCHED — "stripe", "checkout", "take money". The 2026-09-01
 * shortlist measurement found the failure this exists for: a brief said
 * "modals and tables" and `ui-components` never said either word.
 */

/** Words that identify nothing: every skill "helps you build an app". */
const STOP = new Set((
  'a an the and or but for with that this from into your you are was were have has will can ' +
  'use using make build create need want page site app new add all any one out get its it to ' +
  'of in on at by is be as do how what when where which who why me my i we our us so if not ' +
  'some thing things way work working help please should would could just like also then'
).split(' '));

/** Fold a word to a comparable stem. Deliberately crude and deterministic. */
export function foldWord(word) {
  let w = String(word ?? '').toLowerCase();
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/** Split text into folded, meaningful words. */
export function searchTerms(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(foldWord);
}

/** A trigger phrase, normalised for substring matching against a normalised need. */
function phrase(text) {
  return ` ${searchTerms(text).join(' ')} `;
}

/**
 * Parse the `triggers:` frontmatter value. Comma-separated, each trimmed,
 * lower-cased, empty entries dropped, at most 24 kept.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseTriggers(raw) {
  if (Array.isArray(raw)) raw = raw.join(',');
  return String(raw ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(Boolean)
    .slice(0, 24);
}

/** @typedef {'builder' | 'cli' | 'both'} SkillSurface */

/**
 * Parse `applies-to:`. Anything unrecognised is `both` — a typo must never
 * make a skill silently vanish from a surface.
 * @param {unknown} raw
 * @returns {SkillSurface}
 */
export function parseAppliesTo(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'builder' || v === 'cli' ? v : 'both';
}

/** Does a skill declared for `appliesTo` belong on `surface`? */
export function skillAppliesTo(appliesTo, surface) {
  const a = parseAppliesTo(appliesTo);
  return a === 'both' || !surface || a === surface;
}

/**
 * @typedef {{ name: string, description?: string | null, when?: string | null,
 *   triggers?: readonly string[] | null, appliesTo?: string | null }} SearchableSkill
 * @typedef {{ name: string, score: number, description: string }} SkillHit
 */

/** The minimum score worth returning at all: one name word, or one trigger. */
export const MIN_SKILL_SCORE = 3;

/**
 * Rank skills for a plain-English need.
 * @param {unknown} need
 * @param {readonly SearchableSkill[]} skills
 * @param {{ limit?: number, surface?: SkillSurface }} [opts]
 * @returns {SkillHit[]}
 */
export function searchSkills(need, skills, { limit = 3, surface } = {}) {
  const words = [...new Set(searchTerms(need))];
  if (!words.length) return [];
  const needPhrase = ` ${searchTerms(need).join(' ')} `;
  const hits = [];
  for (const s of skills ?? []) {
    if (!s || !s.name) continue;
    if (surface && !skillAppliesTo(s.appliesTo, surface)) continue;
    const name = new Set(searchTerms(String(s.name).replace(/[-_.]+/g, ' ')));
    const text = new Set(searchTerms(`${s.description ?? ''} ${s.when ?? ''}`));
    const single = new Set();
    let score = 0;
    for (const t of s.triggers ?? []) {
      const p = phrase(t);
      if (p.trim().includes(' ')) { if (needPhrase.includes(p)) score += 10; }
      else if (p.trim()) single.add(p.trim());
    }
    for (const w of words) {
      if (single.has(w)) score += 4;
      if (name.has(w)) score += 3;
      if (text.has(w)) score += 1;
    }
    if (score >= MIN_SKILL_SCORE) hits.push({ name: s.name, score, description: String(s.description ?? '') });
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, Math.max(0, limit));
}

/**
 * Is the top hit clear enough to OPEN without asking? A trigger-phrase match
 * (score ≥ 10) that beats the runner-up by half again. Anything less is a list
 * for the reader to choose from — opening the wrong skill costs a round.
 * @param {readonly SkillHit[]} hits
 */
export function confidentSkill(hits) {
  const [top, next] = hits ?? [];
  if (!top || top.score < 10) return null;
  if (next && top.score < next.score * 1.5) return null;
  return top;
}

/**
 * The lines a search prints — one per hit, `name — description`. Shared so
 * the CLI and the builder say the same thing about the same shelf.
 * @param {readonly SkillHit[]} hits
 */
export function formatSkillHits(hits) {
  return (hits ?? []).map((h) => `- ${h.name} — ${h.description}`.slice(0, 180));
}
