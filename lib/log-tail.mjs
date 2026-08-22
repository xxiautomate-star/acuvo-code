/**
 * ── ⭐⭐ THE AGENT COULD START A SERVER. IT COULD NOT WATCH ONE ──────────────
 *
 * `background.mjs` starts long-running processes and keeps the last
 * `MAX_LOG_CHARS` (16,000) of their output in a ring. `check_process` hands that
 * ring back. That is enough to answer "did it boot?" and it is NOT enough to
 * debug anything, because debugging a server is a three-step loop:
 *
 *     1. start it        2. make a request        3. read what appeared BETWEEN
 *
 * Step 3 was missing. There was no way to ask "what is new since I last looked",
 * no way to say "only the lines with ERROR in them", and no way to wait for a
 * line to appear — so the only strategy available was to re-read the whole ring
 * every round and diff it by eye.
 *
 * ── ⚠️⚠️ AND THAT IS NOT A CONVENIENCE PROBLEM, IT IS A BUDGET FIRE ─────────
 *
 * Re-reading a saturated ring costs ~16,000 characters ≈ 4,000 tokens EVERY
 * ROUND, and almost all of it is text the model has already read. Ten rounds of
 * watching a dev server is ~40,000 tokens spent re-reading the same startup
 * banner, and it is worse than merely expensive: the new three lines that
 * actually matter arrive buried in 200 identical ones, which is how a model
 * looks straight past the stack trace it asked for.
 *
 * ⭐ THE CURSOR IS THE ENTIRE POINT OF THIS MODULE. Everything else here —
 * filters, waiting, summarising — is a refinement. `tailSince` returns what is
 * new and a token to ask again with; asking again with that token and nothing
 * having happened returns ZERO lines and ZERO characters. The suite asserts
 * exactly that, because a cursor that quietly re-delivers is worse than no
 * cursor at all: it costs the same and it looks like it is working.
 *
 * ── ⚠️ WHY THE CURSOR IS NOT A NUMBER, WHICH IS WHAT I WROTE FIRST ─────────
 *
 * The obvious cursor is an offset into the buffer. It is wrong, and it is wrong
 * in the one case that matters: the buffer is a RING. Once a chatty server has
 * printed more than 16,000 characters, `record()` in `background.mjs` slices the
 * FRONT off, so every existing offset now points 200 characters further into the
 * text than it did a moment ago. A plain offset does not fail loudly there — it
 * silently skips whatever slid past it, which is precisely the output you were
 * watching for.
 *
 * ⭐ So the cursor anchors on CONTENT: `acv1:<seen>:<hash>` where the hash is of
 * the last `ANCHOR_CHARS` characters already delivered. Resolving it tries the
 * recorded position first (the common case, one hash), and only if the ring has
 * shifted does it walk backwards looking for the anchor. If the anchor is gone
 * entirely, that is reported as `evicted: true` — the honest answer, "output was
 * dropped before you read it", never a silent jump.
 *
 * ⚠️ THE HASH IS FNV-1a/32, NOT A CRYPTOGRAPHIC DIGEST, and a scan over a 16,000
 * character ring gives roughly a 4-in-a-million chance of landing on a wrong
 * anchor. Named rather than hidden: the exact-position check runs first and does
 * not scan at all, so the scan only happens on a ring that has actually shifted.
 * The failure mode if it ever fires is a few repeated or skipped lines, not
 * corruption — and the alternative (carrying 32 raw characters through every
 * tool call) costs the model tokens on every single round forever.
 *
 * ── ⚠️ PARTIAL LINES, AND WHY THE CURSOR STOPS SHORT OF THEM ───────────────
 *
 * A process is writing while you read. The tail of the buffer is routinely half
 * a line. Deliver it and advance past it and the line arrives split in two,
 * across two rounds, matching no filter and reading as two different events. So
 * a trailing line with no newline is HELD BACK: reported separately as
 * `partial`, never counted as a line, and the cursor stops before it. `flush`
 * overrides that, and `waitFor` sets it, because a point-in-time question about
 * a line that may never get its newline is a different question.
 *
 * ── ⚠️ THE REGEX FILTER, AND THE DoS IT WOULD HAVE BEEN ────────────────────
 *
 * `search.mjs` already says it: handing a model's string to `new RegExp` is a
 * catastrophic-backtracking hang in one call. `(a+)+$` against a long line does
 * not return. This module takes patterns from the same place, so it does not
 * accept arbitrary regex. `validateLogRegex` enforces a restricted grammar, and
 * the guarantee comes from THREE layers, in decreasing strength:
 *
 *   1. **A quantifier may not be applied to a group.** `(x+)+`, `(a|a)*`,
 *      `(?:ab)+` are refused. This is structural, not a heuristic: exponential
 *      backtracking needs a quantified group containing an ambiguous quantifier
 *      or alternation, and you cannot write one in this grammar at all.
 *   2. **Unbounded quantifiers are capped and must be separated.** At most
 *      `MAX_UNBOUNDED_QUANTIFIERS`, and two of them may not sit adjacent with no
 *      concrete atom between (`.*.*`, `\s*\s*` are refused) — that adjacency is
 *      what produces polynomial blowup once the exponential road is closed.
 *   3. **The input is clipped.** Matching happens per line against at most
 *      `MATCH_LINE_CHARS` characters, and the whole filter runs under a wall
 *      clock (`FILTER_BUDGET_MS`) checked every `TIME_CHECK_EVERY` lines.
 *
 * ⚠️ HONESTLY: (1) is a proof, (2) and (3) are bounds. A hostile pattern at the
 * cap can still be slower than a nice one. It cannot hang, and if it is slow the
 * result says `budgetExceeded` with the line it reached rather than pretending
 * it searched everything — which is the failure `search.mjs` had to fix too
 * ("everything was looked at and the string is not there", when it was not).
 *
 * ⭐ AND `contains` NEEDS NONE OF THAT. Plain substring matching is first-class
 * here, not a fallback: it is what a caller wants ~90% of the time, it cannot
 * backtrack, and the regex door only opens when someone explicitly asks for it.
 *
 * ── PURE ON PURPOSE ────────────────────────────────────────────────────────
 *
 * Nothing here imports `background.mjs` or touches its registry. Every function
 * takes the buffer as a STRING (or, for `waitFor`, an injected `read()` that
 * returns one). So the whole module tests with no processes, no ports, no
 * network and no timers — and the lead can point it at any log source at all.
 */

/** Characters of already-delivered text the cursor anchors on. */
export const ANCHOR_CHARS = 32;

/** Cursor token version tag. Bump it if the format changes; old tokens then read as invalid rather than as garbage. */
export const CURSOR_PREFIX = 'acv1';

/** Longest filter pattern accepted. A 200-character log filter is a mistake, not a need. */
export const MAX_PATTERN_CHARS = 200;

/** ⚠️ See layer 2 above. Four is generous — `^\s*at .*\(.*\)` uses three. */
export const MAX_UNBOUNDED_QUANTIFIERS = 4;

/** Largest `{n,m}` repeat accepted; `a{5000}` is a slow way to say nothing. */
export const MAX_REPEAT = 1_000;

/** Nested groups beyond this are refused — depth is complexity nobody needs in a log filter. */
export const MAX_GROUP_DEPTH = 5;

/** ⚠️ Layer 3: how much of a line the matcher may look at. Bounds the input, not the pattern. */
export const MATCH_LINE_CHARS = 512;

/**
 * ── ⚠️⚠️ HOW LONG A PARTIAL LINE MAY BE HELD, AND THE BUG THAT PUT IT HERE ──
 *
 * Holding back the trailing partial line (so it is never split across two reads)
 * is right — until the process does not emit newlines at all. FOUND BY THE
 * MEASUREMENT TEST, which fed a 16,000-character buffer with no `\n` in it: the
 * whole buffer was one partial line, so `deliveredChars` was ZERO, the cursor
 * never moved, and ten rounds re-delivered all 16,000 characters ten times.
 *
 * ⭐ That is the precise failure this module exists to prevent, reintroduced by
 * its own politeness. A progress bar redrawing with `\r`, a minified bundle
 * printed in one write, or a process that flushes without newlines all produce
 * it. So past this length the text stops being "a line in progress" and is
 * delivered — split, and SAID to be split, which is strictly better than
 * charging for it again every round forever.
 */
export const PARTIAL_HOLD_CHARS = 2_000;

/** How long a whole filter pass may take before it reports back unfinished. */
export const FILTER_BUDGET_MS = 250;

/** The clock is read every N lines rather than every line — reading it is not free. */
export const TIME_CHECK_EVERY = 256;

/** Default / ceiling on lines returned by one tail. */
export const DEFAULT_TAIL_LINES = 200;
export const MAX_TAIL_LINES = 2_000;

/** waitFor: defaults and the ceiling. A wait longer than this is a hung tool call. */
export const DEFAULT_WAIT_MS = 10_000;
export const MAX_WAIT_MS = 120_000;
export const DEFAULT_POLL_MS = 200;

/** How many lines a timeout message quotes back. Enough to recognise where it got to. */
export const TIMEOUT_SAMPLE_LINES = 12;

/** Summary shape. */
export const DEFAULT_SUMMARY_TAIL = 40;
export const DEFAULT_SUMMARY_ERRORS = 20;

/**
 * The lines a summary pulls to the front. OURS, not the caller's — compiled
 * once, no nested quantifiers, so layer 1 above is satisfied by construction.
 */
export const NOTABLE_PATTERNS = Object.freeze({
  error: /(?:^|[^a-z])(?:error|fatal|exception|traceback|panic|unhandled|failed|failure|refused|denied|EADDRINUSE|ECONNREFUSED|ENOENT|MODULE_NOT_FOUND)(?:[^a-z]|$)/i,
  warn: /(?:^|[^a-z])(?:warn|warning|deprecated|deprecation)(?:[^a-z]|$)/i,
  trace: /^\s+at\s/,
});

/* ────────────────────────────── the cursor ────────────────────────────── */

/**
 * FNV-1a, 32-bit. Inline because this package has zero dependencies and
 * `node:crypto` would be a heavier hammer for a non-security hash.
 * @param {string} str
 * @returns {number} unsigned 32-bit
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    // ⚠️ The shift-and-add form of `h * 16777619` — a plain multiply overflows
    // the double's integer range and quietly stops being FNV.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Build the opaque cursor token for "everything up to `end` has been delivered".
 * @param {string} text the buffer as it was read
 * @param {number} end absolute index in `text` up to which content was delivered
 * @returns {string}
 */
export function formatCursor(text, end) {
  const safeEnd = Math.max(0, Math.min(Number.isFinite(end) ? end : 0, text.length));
  const anchorLen = Math.min(safeEnd, ANCHOR_CHARS);
  const anchor = text.slice(safeEnd - anchorLen, safeEnd);
  return `${CURSOR_PREFIX}:${safeEnd}:${fnv1a32(anchor).toString(16)}`;
}

/**
 * @param {unknown} token
 * @returns {{seen: number, hash: number}|null} null when it is not one of ours
 */
export function parseCursor(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split(':');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) return null;
  const seen = Number(parts[1]);
  const hash = Number.parseInt(parts[2], 16);
  if (!Number.isInteger(seen) || seen < 0 || !Number.isInteger(hash)) return null;
  return { seen, hash };
}

/**
 * Where in `text` the caller's "new content" begins.
 *
 * ⚠️ THREE OUTCOMES, AND THEY ARE DIFFERENT FACTS:
 *   · found at the recorded position — nothing was evicted, the fast path;
 *   · found earlier — the ring dropped text the caller had ALREADY seen, which
 *     is harmless and reported as `shiftedChars`;
 *   · not found — the ring dropped text the caller had NOT seen. That is data
 *     loss and it is reported as `evicted`, never smoothed over.
 *
 * @param {string} text
 * @param {string|null|undefined} token
 * @returns {{start:number, fresh?:boolean, invalid?:boolean, evicted?:boolean, shiftedChars?:number}}
 */
export function resolveCursor(text, token) {
  if (token === null || token === undefined || token === '') return { start: 0, fresh: true };
  const parsed = parseCursor(token);
  if (!parsed) return { start: 0, invalid: true };

  const anchorLen = Math.min(parsed.seen, ANCHOR_CHARS);

  // Fast path: the buffer has not shifted, so the anchor is exactly where we left it.
  if (parsed.seen <= text.length
    && fnv1a32(text.slice(parsed.seen - anchorLen, parsed.seen)) === parsed.hash) {
    return { start: parsed.seen };
  }

  // The ring evicted from the front, so the anchor can only have moved LEFT.
  const from = Math.min(parsed.seen, text.length);
  for (let end = from; end >= anchorLen; end -= 1) {
    if (fnv1a32(text.slice(end - anchorLen, end)) === parsed.hash) {
      return { start: end, shiftedChars: parsed.seen - end };
    }
  }

  return { start: 0, evicted: true };
}

/* ────────────────────────────── the filter ────────────────────────────── */

/**
 * Is this pattern safe to compile? See the three layers in the file header.
 *
 * ⚠️ THIS IS A RESTRICTION, NOT A PARSER. `new RegExp` remains the authority on
 * whether the syntax is valid — `compileFilter` still compiles inside a
 * try/catch. This function only decides whether a VALID pattern is one we are
 * willing to run against model-supplied input.
 *
 * @param {string} source
 * @returns {{ok:true, unbounded:number}|{ok:false, error:string}}
 */
export function validateLogRegex(source) {
  if (typeof source !== 'string' || source === '') {
    return { ok: false, error: 'a regex filter needs a pattern, e.g. "ERROR|WARN". For plain text use "contains" instead — it needs no escaping and cannot be refused.' };
  }
  if (source.length > MAX_PATTERN_CHARS) {
    return { ok: false, error: `that pattern is ${source.length} characters and the limit is ${MAX_PATTERN_CHARS}. A log filter this long is almost always several filters — run them one at a time, or use "contains" with the distinctive substring.` };
  }

  const quantifierRefusal = (what) => ({
    ok: false,
    error: `"${what}" applies a quantifier to a group, which is refused here: a quantified group is how a regex backtracks exponentially and hangs the process. Quantify a single character or a character class instead — "(?:ab)+" becomes "(?:ab)(?:ab)?" or just "contains":"ab".`,
  });

  let unbounded = 0;
  let depth = 0;
  /** Has a concrete atom appeared since the last unbounded quantifier? See layer 2. */
  let separated = true;
  /** An atom that has been consumed but not yet claimed by a quantifier. */
  let atomPending = false;
  /** 'none' | 'char' | 'group' | 'quant' | 'anchor' | 'alt' | 'open' */
  let prev = 'none';
  let i = 0;

  const takeAtom = () => {
    if (atomPending) separated = true; // the previous atom went unquantified — it is a separator
    atomPending = true;
    prev = 'char';
  };

  while (i < source.length) {
    const c = source[i];

    if (c === '\\') {
      const n = source[i + 1];
      if (n === undefined) return { ok: false, error: 'the pattern ends with a lone backslash, so it escapes nothing. Drop it, or double it ("\\\\") if you meant a literal backslash.' };
      if (n >= '1' && n <= '9') return { ok: false, error: 'back-references like "\\1" are refused: matching a group against itself is the other way a regex backtracks exponentially. Write the text out, or use "contains".' };
      if (n === 'k') return { ok: false, error: 'named back-references ("\\k<name>") are refused for the same reason as "\\1" — they make the match ambiguous and the backtracking unbounded.' };
      takeAtom();
      i += 2;
      continue;
    }

    if (c === '[') {
      let j = i + 1;
      if (source[j] === '^') j += 1;
      if (source[j] === ']') j += 1; // a `]` first in the class is a literal
      while (j < source.length && source[j] !== ']') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      if (j >= source.length) return { ok: false, error: 'unclosed "[" — a character class needs its "]". Escape it as "\\[" if you meant a literal bracket.' };
      takeAtom();
      i = j + 1;
      continue;
    }

    if (c === '(') {
      if (source.startsWith('(?', i)) {
        if (!source.startsWith('(?:', i)) {
          return { ok: false, error: 'look-ahead and look-behind ("(?=", "(?!", "(?<=") are refused here: they re-scan the same text and are the classic source of a slow filter. Only the non-capturing group "(?:" is allowed.' };
        }
        i += 3;
      } else {
        i += 1;
      }
      depth += 1;
      if (depth > MAX_GROUP_DEPTH) return { ok: false, error: `groups nested more than ${MAX_GROUP_DEPTH} deep are refused. A log filter that deep is a program — match something simpler and filter the result again.` };
      if (atomPending) separated = true;
      atomPending = false;
      prev = 'open';
      continue;
    }

    if (c === ')') {
      if (depth === 0) return { ok: false, error: 'unbalanced ")" — escape it as "\\)" if you meant a literal parenthesis.' };
      depth -= 1;
      if (atomPending) separated = true;
      atomPending = false;
      prev = 'group';
      i += 1;
      continue;
    }

    if (c === '|') {
      if (atomPending) separated = true;
      atomPending = false;
      // ⚠️ Branches do not chain, so an unbounded quantifier in the next branch
      // is not "adjacent" to one in this branch. `(?:a*|b*)` is fine.
      separated = true;
      prev = 'alt';
      i += 1;
      continue;
    }

    if (c === '^' || c === '$') {
      if (atomPending) separated = true;
      atomPending = false;
      prev = 'anchor';
      i += 1;
      continue;
    }

    if (c === '*' || c === '+' || c === '?') {
      // `??`, `*?`, `+?` — the lazy modifier on a quantifier we already counted.
      if (c === '?' && prev === 'quant') { prev = 'lazy'; i += 1; continue; }
      if (prev !== 'char') return quantifierRefusal(`${prev === 'group' ? ')' : source[i - 1] ?? ''}${c}`);
      atomPending = false;
      if (c === '?') {
        separated = true; // bounded: it can match at most one, no ambiguity to chain
      } else {
        if (!separated) {
          return { ok: false, error: `two unbounded quantifiers sit together in "${source}" (like ".*.*" or "\\\\s*\\\\s*"). Each one can claim the other's text, so the match has to try every split — put a literal between them, or use just one.` };
        }
        unbounded += 1;
        separated = false;
      }
      prev = 'quant';
      i += 1;
      continue;
    }

    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (!m) { takeAtom(); i += 1; continue; } // a literal `{`
      if (prev !== 'char') return quantifierRefusal(`)${m[0]}`);
      const min = Number(m[1]);
      const openEnded = m[2] !== undefined && (m[3] === undefined || m[3] === '');
      const max = openEnded ? Infinity : (m[3] ? Number(m[3]) : min);
      if (Number.isFinite(max) && max > MAX_REPEAT) {
        return { ok: false, error: `"${m[0]}" repeats more than ${MAX_REPEAT} times. Nothing in a log line is that long — did you mean "+"?` };
      }
      if (Number.isFinite(max) && max < min) {
        return { ok: false, error: `"${m[0]}" has a maximum below its minimum, so it can never match.` };
      }
      atomPending = false;
      if (openEnded) {
        if (!separated) {
          return { ok: false, error: `two unbounded quantifiers sit together in "${source}". Put a literal between them, or use just one.` };
        }
        unbounded += 1;
        separated = false;
      } else {
        separated = true;
      }
      i += m[0].length;
      prev = 'quant';
      continue;
    }

    // `.` and every ordinary literal.
    takeAtom();
    i += 1;
  }

  if (depth !== 0) return { ok: false, error: 'unclosed "(" — every group needs its ")". Escape it as "\\(" if you meant a literal parenthesis.' };
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
    return { ok: false, error: `that pattern has ${unbounded} unbounded quantifiers ("*", "+", "{n,}") and the limit is ${MAX_UNBOUNDED_QUANTIFIERS}. Each one multiplies the work on a line that nearly matches. Anchor it with more literal text, or filter twice.` };
  }
  return { ok: true, unbounded };
}

/** Coerce a `contains`/`exclude` argument into an array of non-empty strings. */
function toTerms(value) {
  if (value === null || value === undefined || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v)).filter((v) => v !== '');
}

/**
 * Build a line predicate from plain substrings and/or a bounded regex.
 *
 * ⚠️ NO FILTER IS A VALID FILTER. `compileFilter({})` returns a predicate that
 * accepts everything, and `active:false` so the caller can say so. A guard that
 * refused an empty filter would fail the most common correct call there is.
 *
 * @param {{contains?:string|string[], exclude?:string|string[], matches?:string, ignoreCase?:boolean}} spec
 * @returns {{ok:true, test:(line:string)=>boolean, active:boolean, describe:string}|{ok:false, error:string}}
 */
export function compileFilter({ contains, exclude, matches, ignoreCase = false } = {}) {
  const includes = toTerms(contains);
  const excludes = toTerms(exclude);
  let rx = null;

  if (matches !== undefined && matches !== null && matches !== '') {
    const source = String(matches);
    const check = validateLogRegex(source);
    if (!check.ok) return check;
    try {
      rx = new RegExp(source, ignoreCase ? 'i' : '');
    } catch (err) {
      return { ok: false, error: `not a valid regular expression: ${String(err?.message ?? err)}. If you only want to find text, use "contains" — it takes the characters literally.` };
    }
  }

  const fold = (s) => (ignoreCase ? s.toLowerCase() : s);
  const inc = includes.map(fold);
  const exc = excludes.map(fold);
  const active = inc.length > 0 || exc.length > 0 || rx !== null;

  const parts = [];
  if (inc.length) parts.push(`contains ${inc.map((t) => JSON.stringify(t)).join(' or ')}`);
  if (rx) parts.push(`matches /${String(matches)}/${ignoreCase ? 'i' : ''}`);
  if (exc.length) parts.push(`and not ${exc.map((t) => JSON.stringify(t)).join(' or ')}`);

  return {
    ok: true,
    active,
    describe: parts.length ? parts.join(', ') : 'no filter (every line)',
    test(line) {
      // ⚠️ Layer 3: the matcher never sees more than MATCH_LINE_CHARS. A minified
      // bundle printed as one 400KB "line" would otherwise be handed whole to a
      // regex, which is exactly the input that turns a slow pattern into a hang.
      const probe = line.length > MATCH_LINE_CHARS ? line.slice(0, MATCH_LINE_CHARS) : line;
      const folded = fold(probe);
      if (exc.length && exc.some((t) => folded.includes(t))) return false;
      if (!inc.length && !rx) return true;
      if (inc.length && inc.some((t) => folded.includes(t))) return true;
      if (rx && rx.test(probe)) return true;
      return false;
    },
  };
}

/* ────────────────────────────── the tail ──────────────────────────────── */

/**
 * Split a chunk into complete lines plus the trailing partial line.
 * ⚠️ `\r\n` is normalised on the LINE, not on the buffer — the offsets the
 * cursor records must stay indices into the original text.
 */
function splitChunk(chunk) {
  const nl = chunk.lastIndexOf('\n');
  const complete = nl === -1 ? '' : chunk.slice(0, nl + 1);
  const partial = nl === -1 ? chunk : chunk.slice(nl + 1);
  const lines = complete === '' ? [] : complete.slice(0, -1).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines, partial, completeChars: complete.length };
}

/**
 * What has appeared since the caller's cursor.
 *
 * @param {string} text the whole buffer, as read right now
 * @param {object} [opts]
 * @param {string|null} [opts.cursor] the token from a previous call; omit for a first read
 * @param {boolean} [opts.flush] deliver the trailing partial line too (use when the process has exited)
 * @param {number} [opts.maxLines]
 * @param {string|string[]} [opts.contains]
 * @param {string|string[]} [opts.exclude]
 * @param {string} [opts.matches]
 * @param {boolean} [opts.ignoreCase]
 * @param {() => number} [opts.now]
 * @param {number} [opts.budgetMs]
 * @returns {object}
 */
export function tailSince(text, opts = {}) {
  const src = typeof text === 'string' ? text : '';
  const {
    cursor = null,
    flush = false,
    maxLines = DEFAULT_TAIL_LINES,
    now = Date.now,
    budgetMs = FILTER_BUDGET_MS,
  } = opts;

  const filter = compileFilter(opts);
  if (!filter.ok) return filter;

  const cap = Math.max(1, Math.min(Number.isFinite(maxLines) ? Math.floor(maxLines) : DEFAULT_TAIL_LINES, MAX_TAIL_LINES));
  const at = resolveCursor(src, cursor);
  const chunk = src.slice(at.start);
  const split = splitChunk(chunk);

  /**
   * ⚠️ See PARTIAL_HOLD_CHARS: a partial line is held only while it is
   * plausibly a line still being written. Past that it is delivered, because a
   * cursor that never advances is the bug this module was built to fix.
   */
  const overlongPartial = !flush && split.partial.length > PARTIAL_HOLD_CHARS;
  const holdPartial = !flush && !overlongPartial;
  const deliveredChars = holdPartial ? split.completeChars : chunk.length;
  const candidates = !holdPartial && split.partial !== ''
    ? [...split.lines, split.partial]
    : split.lines;

  /**
   * ⚠️ THE FILTER RUNS UNDER A CLOCK AND SAYS SO WHEN IT RUNS OUT. Reporting
   * `matched: 3` after looking at 40 of 9,000 lines would be the same lie
   * `search.mjs` had to fix: a claim of completeness the caller cannot check.
   */
  const deadline = now() + Math.max(1, budgetMs);
  const kept = [];
  let scanned = 0;
  let budgetExceeded = false;
  for (const line of candidates) {
    if (scanned % TIME_CHECK_EVERY === TIME_CHECK_EVERY - 1 && now() > deadline) { budgetExceeded = true; break; }
    scanned += 1;
    if (filter.test(line)) kept.push(line);
  }

  // Newest lines win: a tail is a question about what just happened.
  const droppedOlderLines = Math.max(0, kept.length - cap);
  const lines = droppedOlderLines > 0 ? kept.slice(-cap) : kept;

  const out = {
    ok: true,
    lines,
    text: lines.join('\n'),
    cursor: formatCursor(src, at.start + deliveredChars),
    newChars: deliveredChars,
    newLines: candidates.length,
    scannedLines: scanned,
    matched: kept.length,
    filteredOut: scanned - kept.length,
    droppedOlderLines,
    partial: holdPartial ? split.partial : '',
    bufferChars: src.length,
    filter: filter.describe,
  };

  const notes = [];
  if (at.fresh) notes.push('first read: this is everything the buffer holds. Pass the cursor back next time to get only what is new.');
  if (at.invalid) notes.push('that cursor was not one of mine, so this is a full read. Use the "cursor" value from a previous read_log reply verbatim.');
  if (at.evicted) {
    out.evicted = true;
    notes.push('⚠️ output was DROPPED before you read it: the process printed more than the buffer holds, and the point your cursor marked is gone. What follows is everything still in the buffer, but there is a hole before it — read more often, or filter so you can afford to.');
  }
  if (at.shiftedChars) {
    out.shiftedChars = at.shiftedChars;
    notes.push(`the buffer dropped ${at.shiftedChars} characters you had already read; nothing new was lost.`);
  }
  if (budgetExceeded) {
    out.budgetExceeded = true;
    notes.push(`⚠️ the filter ran out of its ${budgetMs}ms budget after ${scanned} of ${candidates.length} lines, so lines after that were NOT examined. This count is a floor, not a total.`);
  }
  if (droppedOlderLines > 0) notes.push(`${droppedOlderLines} older matching lines were dropped to fit maxLines=${cap}; these are the newest.`);
  if (holdPartial && split.partial !== '') notes.push('the process is mid-line; that partial line is in "partial" and is NOT counted as a line — it arrives whole on your next read.');
  if (overlongPartial) {
    out.splitLine = true;
    notes.push(`⚠️ the last "line" is ${split.partial.length} characters with no newline yet, past the ${PARTIAL_HOLD_CHARS}-character hold, so it was delivered UNFINISHED and the rest will arrive as a separate line. Holding it instead would mean re-sending it to you every single round.`);
  }
  if (candidates.length === 0 && !at.fresh) notes.push('nothing new since your last read.');
  if (candidates.length > 0 && lines.length === 0 && filter.active) notes.push(`${candidates.length} new lines appeared and none matched the filter (${filter.describe}). The output is there — the filter is what is hiding it.`);

  out.note = notes.join(' ');
  return out;
}

/* ────────────────────────────── waiting ───────────────────────────────── */

/** Accept either a plain string or a `{text, running, exitCode}` record from `read()`. */
function normaliseRead(value) {
  if (typeof value === 'string') return { ok: true, text: value, running: undefined };
  if (value && typeof value === 'object') {
    if (value.ok === false) return { ok: false, error: String(value.error ?? 'the log could not be read') };
    const text = typeof value.text === 'string' ? value.text
      : (typeof value.output === 'string' ? value.output
        : (typeof value.log === 'string' ? value.log : null));
    if (text === null) return { ok: false, error: 'the log source returned no text (expected a string, or an object with "text").' };
    return { ok: true, text, running: value.running, exitCode: value.exitCode ?? null };
  }
  return { ok: false, error: 'the log source returned nothing readable.' };
}

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Wait until a line appears, or say what it DID see.
 *
 * ⚠️⚠️ "TIMED OUT" ALONE IS USELESS, AND IT IS THE DEFAULT EVERY WAIT HELPER
 * SHIPS. A model told only that its wait expired has three indistinguishable
 * explanations — the pattern is wrong, the process is dead, or it is genuinely
 * still starting — and no way to choose, so it waits again. Every failure here
 * carries: how long it waited, how many lines appeared, whether output was still
 * arriving, and the last `sampleLines` lines verbatim.
 *
 * ⭐ AND IT STOPS EARLY WHEN THE PROCESS IS GONE. `background.mjs` already
 * records the cost of not knowing this: "a model that cannot tell them apart
 * waits politely forever for a dead process." If `read()` reports
 * `running:false`, the wait ends immediately — AFTER one last scan, because the
 * line you are waiting for is very often the last thing a process prints before
 * it dies.
 *
 * @param {object} opts
 * @param {() => (string|object|Promise<string|object>)} opts.read the log source
 * @returns {Promise<object>}
 */
export async function waitFor(opts = {}) {
  const {
    read,
    cursor = null,
    timeoutMs = DEFAULT_WAIT_MS,
    pollMs = DEFAULT_POLL_MS,
    sampleLines = TIMEOUT_SAMPLE_LINES,
    now = Date.now,
    sleep = realSleep,
    signal = null,
  } = opts;

  if (typeof read !== 'function') {
    return { ok: false, reason: 'unwired', error: 'waitFor needs a read() that returns the current log text. Nothing here reaches a process on its own — that is the caller\'s job.' };
  }

  const filter = compileFilter(opts);
  if (!filter.ok) return { ok: false, reason: 'bad-filter', error: filter.error };
  if (!filter.active) {
    return { ok: false, reason: 'bad-filter', error: 'waitFor needs something to wait FOR: "contains" (plain text, e.g. "Ready in") or "matches" (a bounded regex). Without one it would return on the first line of anything.' };
  }

  const requested = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : DEFAULT_WAIT_MS;
  // ⚠️ CLAMPED AND SAID SO. Silently honouring a 10-minute wait blocks the whole
  // run; silently refusing it fails correct work. Clamp, then report the number
  // actually used so the caller can see what happened.
  const budget = Math.min(requested, MAX_WAIT_MS);
  const poll = Math.max(1, Math.min(Number.isFinite(pollMs) ? Math.floor(pollMs) : DEFAULT_POLL_MS, 5_000));
  const started = now();
  const deadline = started + budget;

  let polls = 0;
  let last = { lines: [], newLines: 0, newChars: 0, cursor, evicted: false };
  let firstChars = null;
  let lastChars = 0;

  for (;;) {
    if (signal?.aborted) {
      return {
        ok: false,
        reason: 'aborted',
        waitedMs: now() - started,
        polls,
        error: `the wait was cancelled after ${now() - started}ms, before ${filter.describe} appeared.`,
        sawLines: last.newLines,
        tail: last.lines.slice(-sampleLines),
      };
    }

    const got = normaliseRead(await read());
    if (!got.ok) return { ok: false, reason: 'unreadable', error: got.error, waitedMs: now() - started, polls };
    if (firstChars === null) firstChars = got.text.length;
    lastChars = got.text.length;
    polls += 1;

    /**
     * ⚠️ RE-RESOLVED FROM THE ORIGINAL CURSOR EVERY POLL, NOT ADVANCED. The
     * cursor is content-anchored, so re-resolving is correct even after the ring
     * shifts — whereas advancing it each poll would step past a partial line and
     * split the very line being waited for across two polls, which is the one
     * line that must not split.
     */
    /**
     * ⭐ ONE unfiltered pass, then the filter applied here. Calling `tailSince`
     * twice (once filtered, once not) would re-split the same buffer every poll
     * for nothing, and a poll loop is the last place to do work twice.
     */
    const unfiltered = tailSince(got.text, { cursor, flush: true, maxLines: MAX_TAIL_LINES, now });
    last = {
      lines: unfiltered.lines,
      newLines: unfiltered.newLines,
      newChars: unfiltered.newChars,
      cursor: unfiltered.cursor,
      evicted: unfiltered.evicted === true,
    };
    const hits = unfiltered.lines.filter((l) => filter.test(l));

    if (hits.length > 0) {
      return {
        ok: true,
        matched: hits[0],
        matchedAll: hits,
        matchCount: hits.length,
        waitedMs: now() - started,
        polls,
        sawLines: last.newLines,
        /**
         * ⚠️ A NON-FLUSHED cursor, deliberately. The caller continues reading
         * from here, and handing back a cursor that sits mid-line would split
         * the next line in two. The flush above was only for MATCHING.
         */
        cursor: tailSince(got.text, { cursor, flush: false, maxLines: 1, now }).cursor,
        note: `matched after ${now() - started}ms: ${JSON.stringify(hits[0])}`,
      };
    }

    // ⭐ Scanned FIRST, then noticed it is dead — see the note above.
    if (got.running === false) {
      return {
        ok: false,
        reason: 'exited',
        waitedMs: now() - started,
        polls,
        sawLines: last.newLines,
        exitCode: got.exitCode ?? null,
        tail: last.lines.slice(-sampleLines),
        cursor: last.cursor,
        error: `the process is NOT running any more (exit code ${got.exitCode ?? 'unknown'}) and ${filter.describe} never appeared in the ${last.newLines} lines it printed. `
          + 'This is a failure to fix, not a slow start — the tail below is why. Waiting again cannot help; a stopped process prints nothing.',
      };
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(poll, remaining));
  }

  const waitedMs = now() - started;
  const growing = firstChars !== null && lastChars > firstChars;
  const clamped = requested > budget;
  return {
    ok: false,
    reason: 'timeout',
    waitedMs,
    timeoutMs: budget,
    polls,
    sawLines: last.newLines,
    tail: last.lines.slice(-sampleLines),
    cursor: last.cursor,
    evicted: last.evicted,
    error: [
      `waited ${waitedMs}ms (${polls} polls) and ${filter.describe} never appeared.`,
      clamped ? `⚠️ the timeout was clamped from ${requested}ms to the ${MAX_WAIT_MS}ms ceiling.` : '',
      `In that time ${last.newLines} lines appeared and the log ${growing ? `GREW from ${firstChars} to ${lastChars} characters — it is alive and working, so waiting longer may be right` : 'did NOT grow at all — the process is idle, so waiting longer will probably not help; check the pattern, or that this is the process you think it is'}.`,
      last.evicted ? '⚠️ output was dropped from the ring before it could be read, so the line may have appeared and been evicted.' : '',
      last.lines.length ? `The last ${Math.min(sampleLines, last.lines.length)} lines it DID print are in "tail".` : 'It printed nothing at all.',
    ].filter(Boolean).join(' '),
  };
}

/* ───────────────────────────── summarising ────────────────────────────── */

/** Clip one line for display, and say how much was clipped. Never a bare cut. */
function clipLine(line, max = MATCH_LINE_CHARS) {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}… (+${line.length - max} more characters on this line)`;
}

/**
 * Fold a big log down to what is worth reading: the notable lines first, the end
 * of the log second, and an explicit count of everything left out.
 *
 * ⚠️ NEVER SILENTLY TRUNCATE. `droppedLines` is always present and always exact,
 * because a summary that omits without saying so is indistinguishable from a log
 * where the error genuinely is not there — and that is the mistake that makes a
 * model stop looking.
 *
 * ⭐ ERRORS FIRST, AND DEDUPED AGAINST THE TAIL. A crash is usually the last
 * thing printed, so a naive "errors + tail" prints the same stack twice and
 * charges for it. Lines already in the tail are counted, not repeated.
 *
 * @param {string} text
 * @param {{tailLines?:number, errorLines?:number, includeWarnings?:boolean, maxLineChars?:number}} [opts]
 * @returns {object}
 */
export function summariseLog(text, opts = {}) {
  const src = typeof text === 'string' ? text : '';
  const {
    tailLines = DEFAULT_SUMMARY_TAIL,
    errorLines = DEFAULT_SUMMARY_ERRORS,
    includeWarnings = true,
    maxLineChars = MATCH_LINE_CHARS,
  } = opts;

  const tailCap = Math.max(0, Math.min(Math.floor(tailLines) || 0, MAX_TAIL_LINES));
  const errCap = Math.max(0, Math.min(Math.floor(errorLines) || 0, MAX_TAIL_LINES));

  const all = src === '' ? [] : src.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  // A trailing newline produces one empty element; it is not a line.
  if (all.length && all[all.length - 1] === '' && src.endsWith('\n')) all.pop();

  const total = all.length;
  const notable = [];
  let errorCount = 0;
  let warnCount = 0;
  for (let i = 0; i < total; i += 1) {
    const line = all[i];
    const probe = line.length > MATCH_LINE_CHARS ? line.slice(0, MATCH_LINE_CHARS) : line;
    let kind = null;
    if (NOTABLE_PATTERNS.error.test(probe)) kind = 'error';
    else if (includeWarnings && NOTABLE_PATTERNS.warn.test(probe)) kind = 'warn';
    else if (NOTABLE_PATTERNS.trace.test(probe)) kind = 'trace';
    if (!kind) continue;
    if (kind === 'error') errorCount += 1;
    if (kind === 'warn') warnCount += 1;
    notable.push({ line: i + 1, kind, text: line });
  }

  const tailStart = Math.max(0, total - tailCap);
  const tail = [];
  for (let i = tailStart; i < total; i += 1) tail.push({ line: i + 1, text: all[i] });

  // ⭐ Only the notable lines the tail does NOT already show, newest first —
  // a crash is usually at the end, and printing it twice is pure waste.
  const inTail = (n) => n > tailStart;
  const notableOutsideTail = notable.filter((n) => !inTail(n.line));
  const shownNotable = notableOutsideTail.slice(-errCap);
  const notableDropped = notableOutsideTail.length - shownNotable.length;
  const alsoInTail = notable.length - notableOutsideTail.length;

  const shownNumbers = new Set([...shownNotable.map((n) => n.line), ...tail.map((t) => t.line)]);
  const droppedLines = total - shownNumbers.size;

  const blocks = [];
  blocks.push(`log summary: ${total} lines, ${src.length} characters. ${errorCount} look like errors, ${warnCount} like warnings.`);
  if (shownNotable.length) {
    blocks.push(`── ${shownNotable.length} notable line${shownNotable.length === 1 ? '' : 's'} from earlier in the log ──`);
    for (const n of shownNotable) blocks.push(`${n.line}: ${clipLine(n.text, maxLineChars)}`);
    if (notableDropped > 0) blocks.push(`(${notableDropped} more notable lines were left out to fit errorLines=${errCap} — raise it or filter with read_log to see them.)`);
  }
  if (tail.length) {
    blocks.push(`── the last ${tail.length} line${tail.length === 1 ? '' : 's'} ──`);
    for (const t of tail) blocks.push(`${t.line}: ${clipLine(t.text, maxLineChars)}`);
  }
  if (droppedLines > 0) {
    blocks.push(`── ${droppedLines} line${droppedLines === 1 ? '' : 's'} not shown ──`);
    blocks.push(`They were neither notable nor near the end. Nothing was cut silently: total is ${total}, shown is ${shownNumbers.size}. Use read_log with "contains" to reach them.`);
  }

  return {
    ok: true,
    totalLines: total,
    totalChars: src.length,
    errorCount,
    warnCount,
    notable: shownNotable,
    notableDropped,
    notableAlsoInTail: alsoInTail,
    tail,
    shownLines: shownNumbers.size,
    droppedLines,
    text: blocks.join('\n'),
  };
}

/* ─────────────────────────────── the tools ────────────────────────────── */

export const LOG_TAIL_TOOL_NAMES = Object.freeze(['read_log', 'wait_for_output', 'summarize_log']);

export function logTailToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'read_log',
        description: [
          'Read what a background process has printed SINCE YOU LAST LOOKED. This is the tool for watching',
          'a running server: start it, make a request, then call this to see only the lines that appeared in between.',
          'Pass back the "cursor" from the previous reply and you get ONLY new output — calling it twice with',
          'nothing happening returns zero lines. Omit the cursor for a full read.',
          'Prefer this over re-reading the whole log with check_process: the log buffer holds up to 16,000',
          'characters and re-reading it every round spends your context on text you have already seen.',
          'Filter with "contains" (plain text, no escaping, always safe) or "matches" (a restricted regex:',
          'no quantified groups, no look-ahead, no back-references — those are refused because they can hang).',
          'Use "exclude" to drop noise like access-log lines you do not care about.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The background process id from start_process, e.g. "bg1".' },
            cursor: { type: 'string', description: 'The "cursor" string from your previous read_log reply, verbatim. Leave it out on the first read.' },
            contains: { type: 'string', description: 'Only lines containing this text (literal — no escaping needed). The safe, preferred filter.' },
            exclude: { type: 'string', description: 'Drop lines containing this text. Use it to silence repetitive noise.' },
            matches: { type: 'string', description: 'Only lines matching this regex, e.g. "ERROR|WARN". Restricted: a quantifier may not be applied to a group. Use "contains" unless you need alternation.' },
            ignoreCase: { type: 'boolean', description: 'Match case-insensitively. Default false.' },
            maxLines: { type: 'number', description: `Most lines to return, newest kept. Default ${DEFAULT_TAIL_LINES}.` },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wait_for_output',
        description: [
          'Block until a line appears in a background process\'s output, or until a timeout.',
          'Use it right after start_process instead of guessing how long a server takes to boot:',
          'wait_for_output {"id":"bg1","contains":"Ready in"} returns the moment the line is printed.',
          'It stops early — and tells you — if the process EXITS, so you never wait out a full timeout on',
          'something that already crashed. On a timeout it reports how long it waited, how many lines appeared,',
          'whether the log was still growing, and the last lines it did see, so you can tell "still booting"',
          'from "wrong pattern" from "dead".',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The background process id from start_process, e.g. "bg1".' },
            contains: { type: 'string', description: 'The literal text to wait for, e.g. "Ready in" or "Listening on". Preferred.' },
            matches: { type: 'string', description: 'A restricted regex to wait for, e.g. "ready|listening". Use "contains" unless you need alternation.' },
            ignoreCase: { type: 'boolean', description: 'Match case-insensitively. Default false.' },
            cursor: { type: 'string', description: 'Only consider output after this cursor, so an older identical line does not match. Use the cursor from a previous read_log.' },
            timeoutMs: { type: 'number', description: `How long to wait. Default ${DEFAULT_WAIT_MS}, ceiling ${MAX_WAIT_MS}.` },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'summarize_log',
        description: [
          'Fold a long log down to what matters: the error and warning lines first, then the last lines,',
          'then an exact count of what was left out. Use this when a build or a test run printed far more',
          'than you want to read, instead of paging through it.',
          'It never truncates silently — every reply says how many lines exist, how many are shown, and how',
          'many are not, so you always know whether the thing you are looking for could still be hiding.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The background process id from start_process, e.g. "bg1".' },
            tailLines: { type: 'number', description: `How many trailing lines to show. Default ${DEFAULT_SUMMARY_TAIL}.` },
            errorLines: { type: 'number', description: `How many earlier error/warning lines to show. Default ${DEFAULT_SUMMARY_ERRORS}.` },
          },
          required: ['id'],
        },
      },
    },
  ];
}

/**
 * Dispatch. `readLog(id)` is INJECTED — this module never reaches into
 * `background.mjs`'s registry, so the lead can point these three tools at a
 * background process, a file, or a test fixture without changing a line here.
 *
 * @param {string} name
 * @param {object} args
 * @param {{readLog?: (id:string)=>any, now?: ()=>number, sleep?: (ms:number)=>Promise<void>, signal?: AbortSignal}} [ctx]
 */
export async function runLogTailTool(name, args = {}, ctx = {}) {
  const { readLog, now = Date.now, sleep = realSleep, signal = null } = ctx;
  if (typeof readLog !== 'function') {
    return { ok: false, error: 'the log tools are not wired to a log source in this run. Read the output with check_process instead.' };
  }

  const id = String(args.id ?? '');
  if (id === '') {
    return { ok: false, error: 'which process? Pass the "id" that start_process returned, e.g. "bg1". check_process with no id lists what is running.' };
  }

  if (name === 'wait_for_output') {
    return waitFor({
      read: () => readLog(id),
      contains: args.contains,
      matches: args.matches,
      exclude: args.exclude,
      ignoreCase: args.ignoreCase === true,
      cursor: typeof args.cursor === 'string' ? args.cursor : null,
      timeoutMs: args.timeoutMs,
      now,
      sleep,
      signal,
    });
  }

  const got = normaliseRead(await readLog(id));
  if (!got.ok) return { ok: false, error: got.error };

  switch (name) {
    case 'read_log': {
      const out = tailSince(got.text, {
        cursor: typeof args.cursor === 'string' ? args.cursor : null,
        // ⭐ A process that has stopped will never finish its last line, so the
        // partial is flushed rather than held forever.
        flush: got.running === false,
        contains: args.contains,
        exclude: args.exclude,
        matches: args.matches,
        ignoreCase: args.ignoreCase === true,
        maxLines: args.maxLines,
        now,
      });
      if (out.ok === false) return out;
      return { ...out, id, running: got.running ?? null };
    }
    case 'summarize_log':
      return { ...summariseLog(got.text, { tailLines: args.tailLines, errorLines: args.errorLines }), id, running: got.running ?? null };
    default:
      return { ok: false, error: `unknown log tool "${name}". This module offers: ${LOG_TAIL_TOOL_NAMES.join(', ')}.` };
  }
}
