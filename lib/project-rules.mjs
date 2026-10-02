/**
 * ── ⭐⭐⭐ `acuvo-rules.json` — THE OWNER'S WRITE POLICY, NOT THE MODEL'S ─────
 *
 * Roman, 2026-08-27, on what a game studio actually needs before it will let an
 * agent near a codebase:
 *
 * > *"Studio leads will not trust an AI that can modify any file it wants. They
 * > need hard, mathematical restrictions… 'You are allowed to write scripts in
 * > /Gameplay/Scripts, but you are hard-blocked from ever opening or modifying
 * > files in /Core/GraphicsEngine'."*
 *
 * ⭐⭐ THE WHOLE POINT IS THAT THIS IS NOT A PROMPT. Every CLI on the market
 * lets you write "please don't touch the engine" in a markdown file, and every
 * one of them will touch the engine on round forty when the context has rolled
 * over. **Instructions are not constraints.** This is a constraint: it sits on
 * `createLocalExecutor`'s write path, below the model, and no amount of
 * reasoning reaches around it.
 *
 * ── WHERE THE FILE LIVES, AND WHY TWO PLACES ────────────────────────────────
 *
 * `acuvo-rules.json` at the workspace root, or `.acuvo/rules.json`. The root
 * one is the one a team COMMITS and reviews in a pull request — the point of a
 * policy is that other humans can see it — and `.acuvo/` is for a policy one
 * person keeps to themselves. Root wins if both exist, because the committed,
 * reviewed one should never lose to a local file.
 *
 * ── ⚠️⚠️ IT FAILS CLOSED, AND THAT IS A DELIBERATE, COSTLY CHOICE ───────────
 *
 * A malformed rules file refuses EVERY write, loudly, with the parse error.
 * The alternative — ignore what we cannot parse — means a lead adds a trailing
 * comma, sees no error, believes `/Core/` is locked, and it is not. A guard
 * that silently stops guarding is the worst object in this repo's history and
 * we have shipped four of them. Annoying and correct beats quiet and wrong.
 *
 * ⭐ NO FILE AT ALL IS NOT A MALFORMED FILE. Absent means "no policy", every
 * write proceeds, and nobody who has not opted in notices this module exists.
 */

/**
 * ⚠️ BOUNDED, because this file is read from a repository and a repository can
 * contain anything. An unbounded pattern list is an unbounded regex build on
 * every single write.
 */
export const MAX_PATTERNS = 200;
export const MAX_PATTERN_LENGTH = 400;

/** The two places a policy may live. Root first — see the header. */
export const RULES_FILENAMES = Object.freeze(['acuvo-rules.json', '.acuvo/rules.json']);

/**
 * Glob → RegExp, for the three wildcards people actually use in a path policy.
 *
 * ⚠️ EVERY OTHER CHARACTER IS ESCAPED. These patterns come out of a file in the
 * repository, and `Core/Graphics(v2)/**` must match a directory literally named
 * `Graphics(v2)` rather than blowing up as a capture group — or worse, matching
 * something else entirely and letting a write through a lock.
 *
 * · `**` crosses directory separators (`Core/**` covers `Core/a/b/c.cpp`)
 * · `*`  does not (`*.uasset` is one segment)
 * · `?`  is a single non-separator character
 *
 * ⭐ A bare `Core` also matches everything beneath it. Writing `Core` and
 * getting a lock on the directory is what every person means by it, and making
 * them remember `/**` is a footgun on the exact feature whose job is to not
 * have footguns.
 */
export function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` should also match zero directories, so `a/**/b.c` covers `a/b.c`.
        if (p[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  /**
   * ⚠️ CASE-INSENSITIVE ON PURPOSE. Windows and macOS both have case-insensitive
   * filesystems by default, so on those machines `core/engine.cpp` and
   * `Core/Engine.cpp` are the SAME FILE — a case-sensitive lock would be
   * trivially bypassable there by changing one letter, and the person who wrote
   * the lock would never know.
   */
  return new RegExp(`^${out}(?:/.*)?$`, 'i');
}

function compileList(raw, label, errors) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    errors.push(`"${label}" must be an array of path patterns, not ${typeof raw}`);
    return null;
  }
  if (raw.length > MAX_PATTERNS) {
    errors.push(`"${label}" has ${raw.length} patterns; the limit is ${MAX_PATTERNS}`);
    return null;
  }
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      errors.push(`"${label}" contains an entry that is not a non-empty string`);
      return null;
    }
    if (entry.length > MAX_PATTERN_LENGTH) {
      errors.push(`"${label}" contains a pattern longer than ${MAX_PATTERN_LENGTH} characters`);
      return null;
    }
    out.push({ pattern: entry.trim(), re: globToRegExp(entry.trim()) });
  }
  return out;
}

/**
 * Parse a rules document into something `writeRefusal` can consult.
 *
 * @param {string|null} text  the file's contents, or null when there is no file
 * @param {string} [source]   the filename, for the message
 * @returns {{kind:'none'} | {kind:'broken', reason:string} | {kind:'rules', protect:Array, allowWrite:Array|null, note:string|null, source:string}}
 */
export function parseProjectRules(text, source = 'acuvo-rules.json') {
  if (text === null || text === undefined) return { kind: 'none' };
  const trimmed = String(text).trim();
  // ⭐ An empty file is a person who created it and has not written a policy
  // yet, not a broken one. Refusing every write over an empty file would be a
  // cruel first experience of a feature meant to build trust.
  if (!trimmed) return { kind: 'none' };

  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch (err) {
    return {
      kind: 'broken',
      reason: `${source} is not valid JSON (${err.message}). Every write is refused until it parses — `
        + 'a policy file that cannot be read is indistinguishable from one that permits everything, '
        + 'and guessing which is how a lock silently stops locking.',
    };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { kind: 'broken', reason: `${source} must contain a JSON object with "protect" and/or "allowWrite".` };
  }

  const errors = [];
  const protect = compileList(doc.protect, 'protect', errors) ?? [];
  const allowWrite = compileList(doc.allowWrite, 'allowWrite', errors);
  if (errors.length) return { kind: 'broken', reason: `${source}: ${errors[0]}` };

  const note = typeof doc.reason === 'string' && doc.reason.trim()
    ? doc.reason.trim().slice(0, 300)
    : null;

  if (!protect.length && !allowWrite) return { kind: 'none' };
  return { kind: 'rules', protect, allowWrite, note, source };
}

/**
 * The decision. `null` means the write may proceed; a string is the refusal the
 * model is shown.
 *
 * ── THE ORDER, AND WHY IT IS THIS ORDER ─────────────────────────────────────
 *
 * 1. **The rules file itself is always protected.** Without this the first
 *    thing a sufficiently determined agent does when refused is edit the
 *    policy — which is not a hypothetical, it is the obvious next move and it
 *    would make the whole feature theatre. Same argument as `.acuvo/`.
 * 2. **`protect` beats `allowWrite`.** A lead who writes both means "this
 *    region, except that". Letting the allowlist win would make the more
 *    specific, more deliberate instruction the weaker one.
 * 3. **`allowWrite`, when present, is exhaustive** — anything unlisted is
 *    refused. That is what makes it an allowlist rather than a suggestion.
 *
 * ⭐ EVERY REFUSAL NAMES THE PATTERN THAT DID IT. The reader is a model
 * deciding what to do next; "not permitted" makes it retry the same write,
 * whereas "`Core/**` in acuvo-rules.json" makes it go somewhere else or ask.
 *
 * @param {ReturnType<typeof parseProjectRules>} rules
 * @param {string} relPath  workspace-relative, forward slashes
 * @returns {string|null}
 */
export function writeRefusal(rules, relPath) {
  if (!rules || rules.kind === 'none') return null;
  if (rules.kind === 'broken') return rules.reason;

  const path = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!path) return null;

  const because = rules.note ? ` The project says: "${rules.note}"` : '';

  if (RULES_FILENAMES.includes(path)) {
    return `${path} is the file that decides which paths this agent may write, so editing it would grant `
      + 'permission rather than do the task. If the policy is wrong, say which line and why — the owner changes it.';
  }

  const locked = rules.protect.find((r) => r.re.test(path));
  if (locked) {
    return `${path} is protected by "${locked.pattern}" in ${rules.source} and cannot be modified.${because} `
      + 'This is the project owner\'s rule, not a preference — do the work somewhere permitted, or explain what '
      + 'needs to change there and let them make the call.';
  }

  if (rules.allowWrite) {
    if (!rules.allowWrite.some((r) => r.re.test(path))) {
      const shown = rules.allowWrite.slice(0, 6).map((r) => r.pattern).join(', ');
      const more = rules.allowWrite.length > 6 ? `, +${rules.allowWrite.length - 6} more` : '';
      return `${path} is outside the paths ${rules.source} allows writing to (${shown}${more}).${because} `
        + 'Put the change in one of those, or say what you need and where.';
    }
  }
  return null;
}

/**
 * A one-line summary for the banner, so a person can SEE that a policy is in
 * force before they watch an agent run for twenty minutes inside it.
 *
 * ⚠️ A guard nobody knows about is a guard that gets blamed for a mystery. The
 * refusal message is for the model; this line is for the human.
 */
export function describeProjectRules(rules) {
  if (!rules || rules.kind === 'none') return null;
  if (rules.kind === 'broken') return `⚠️ ${rules.reason}`;
  const bits = [];
  if (rules.protect.length) bits.push(`${rules.protect.length} protected`);
  if (rules.allowWrite) bits.push(`writes limited to ${rules.allowWrite.length}`);
  return `${rules.source}: ${bits.join(', ')} path${rules.protect.length === 1 && !rules.allowWrite ? '' : 's'}`;
}

/**
 * Read the policy off disk. Injected `readFile` for the same reason everything
 * else in this layer is injected — the decision must be testable with no
 * filesystem at all.
 *
 * @param {(p:string)=>string|null} readFileOrNull
 */
export function loadProjectRules(readFileOrNull) {
  for (const name of RULES_FILENAMES) {
    let text = null;
    try {
      text = readFileOrNull(name);
    } catch {
      text = null;
    }
    if (text !== null && text !== undefined) {
      const parsed = parseProjectRules(text, name);
      // ⚠️ A present-but-empty root file must NOT fall through to `.acuvo/`.
      // "I made the file and left it blank" means no policy, and silently
      // picking up a different one would be a surprise of the worst kind.
      return parsed;
    }
  }
  return { kind: 'none' };
}
