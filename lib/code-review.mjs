/**
 * ── ⭐⭐ WE REVIEW OUR OWN ACTIONS OBSESSIVELY AND THE USER'S CODE NOT AT ALL ─
 *
 * This package spends most of its guard budget on what the AGENT is allowed to
 * do: `command.mjs` vets every argv, `fetch-text.mjs` refuses a private address,
 * `mcp.mjs` closed an RCE through env values, `secret-paths.mjs` refuses to
 * commit a credential file. All of that protects the MACHINE the agent runs on.
 *
 * None of it looks at the thing we actually hand the user: the CODE.
 *
 * ⚠️ An agent that writes `db.query('… WHERE id = ' + req.query.id)`, commits a
 * live API key, and then prints a green ✔ because `npm test` exited 0 is worse
 * than no agent — the tests pass, the reviewer is absent, and the user has been
 * given confidence instead of code. This module is the missing half.
 *
 * ── ⚠️⚠️ WHAT THIS IS NOT — SAY IT BEFORE ANYTHING ELSE ─────────────────────
 * THIS IS A LAYER, NOT A BOUNDARY. It is a pattern matcher over ONE file's text.
 * It has:
 *   · no types, so it cannot know `id` is a number
 *   · no cross-file view, so a sanitizer that lives in `lib/clean.js` is
 *     invisible and a tainted value arriving through an import is invisible too
 *   · no execution, so it cannot know which branch runs
 *
 * Therefore it MISSES things, and a clean result is not a safety claim. That is
 * why `formatReviewSummary` prints `REVIEW_CAVEAT` alongside findings and why it
 * prints NOTHING AT ALL when there are none — an "✔ no vulnerabilities found"
 * line is the same false all-clear that `see_page` once emitted for pages it had
 * never seen, and it would be believed.
 *
 * ── ⚠️⚠️ THE HARD PART IS NOT FINDING THINGS. IT IS NOT CRYING WOLF ─────────
 * A reviewer that flags every `innerHTML` is noise, and noise gets switched off
 * — at which point it protects nothing at all. A guard that fails correct work
 * is worse than no guard (this repo has learned that four times in one day). So
 * every rule here obeys three house rules:
 *
 *   1. NO EVIDENCE, NO FINDING. A literal string is not user input.
 *      `eval('2+2')` is not flagged. `exec('ls -la')` is not flagged.
 *      `el.innerHTML = '<b>hi</b>'` is not flagged.
 *   2. EVERY FINDING CARRIES A CONFIDENCE AND THE REASON FOR IT
 *      (`confidenceWhy`), so a reader can dismiss one in a second. Default
 *      reporting threshold is `medium`; `low` findings exist, are honest about
 *      being guesses, and stay out of the report unless asked for.
 *   3. THE SUSPECT GETS TO SPEAK. A `catch {}` whose comment says "ignore" is
 *      not flagged; a `DOMPurify.sanitize(...)` is not flagged; an interpolated
 *      value that is a file-local `const` literal drops to `low`.
 *
 * ── ⭐ WHY THIS RULE LIST AND NOT THE OWASP TOP TEN ─────────────────────────
 * The list is chosen from what an LLM actually emits in generated app code,
 * because a rule that never fires costs the same attention as one that does:
 *
 *   · INJECTION — models write string-built SQL constantly; it is the single
 *     most common serious defect in generated CRUD code.
 *   · SECRETS — a model that has seen a key in context will helpfully paste it
 *     back. Git keeps it after you delete it, so this one is unrecoverable.
 *   · WEB (XSS / CORS / cookies) — `dangerouslySetInnerHTML` is the fastest way
 *     a generated React page becomes exploitable, and `origin:'*'` +
 *     `credentials:true` is a config a model copies from a tutorial.
 *   · AUTH / CRYPTO — `Math.random()` for a reset token and `md5(password)` are
 *     both idioms that look plausible and are catastrophic.
 *   · FOOTGUNS — a swallowed error is how a generated app "works" while doing
 *     nothing; path traversal and open redirect are one line each.
 *
 * Deliberately NOT covered: race conditions, business-logic authorisation,
 * dependency CVEs, anything needing a call graph. Naming what we do not cover
 * is part of the guarantee.
 *
 * ── ⭐ ON `secret-paths.mjs`: IMPORTED, NOT RE-TYPED ────────────────────────
 * `refusedCommitPath` is imported rather than reproduced. That module's own
 * header records what happened when this concept existed twice: `read-window`
 * kept a second credential list and the two DISAGREED, so which of a user's
 * secrets were protected depended on which verb the model happened to pick.
 * Writing "my" list here would be that bug for the third time. The import is
 * also cycle-free by construction — `secret-paths.mjs` is a documented LEAF
 * (zero imports), which is exactly the property that makes it importable from
 * anywhere, including here.
 *
 * ⭐ AND IT CHANGES THE VERDICT, NOT JUST THE WORDING: for a credential path we
 * emit ONE finding ("never commit this") and DO NOT run the secret-literal
 * rules. A `.env` file full of keys is a `.env` file doing its job; forty
 * "hardcoded secret" findings on it would be the noise problem in its purest
 * form.
 *
 * ── ⭐ PURITY / INJECTION SEAMS ─────────────────────────────────────────────
 * `reviewCode(path, content)` touches nothing outside its arguments — no fs, no
 * network, no clock, no env. There is nothing to inject because there is nothing
 * outside. The one function that needs the outside, `reviewWrittenFiles`, takes
 * `read` as a parameter and defaults to a reader that refuses, so every branch
 * of this file tests with no network, no database and no API key.
 */

import { refusedCommitPath } from './secret-paths.mjs';

/** Categories a finding can belong to. Exported so the lead can filter. */
export const CATEGORIES = ['injection', 'secret', 'web', 'auth', 'footgun'];

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };
const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 };

/** One threshold, shared by every entry point. See the note in `reviewCode`. */
export const DEFAULT_MIN_CONFIDENCE = 'medium';

/**
 * ⚠️ A FILE WE CANNOT LEX IS A FILE WE DO NOT REVIEW. Guessing at a language
 * whose comment and string syntax we do not know produces findings inside
 * comments, which is the fastest way to become noise.
 */
const LANGS = {
  js: { id: 'js', line: '//', block: ['/*', '*/'], quotes: `'"\``, full: true },
  c: { id: 'c', line: '//', block: ['/*', '*/'], quotes: `'"`, full: true },
  py: { id: 'py', line: '#', block: null, quotes: `'"`, full: true },
  rb: { id: 'rb', line: '#', block: null, quotes: `'"`, full: true },
  php: { id: 'php', line: '//', block: ['/*', '*/'], quotes: `'"`, full: true },
  sh: { id: 'sh', line: '#', block: null, quotes: `'"`, full: true },
  html: { id: 'html', line: null, block: ['<!--', '-->'], quotes: `'"`, full: true },
  // ⭐ DATA FILES GET THE SECRET RULES ONLY. A `config.json` with a live key in
  // it is a real finding; "SQL injection" in JSON is not a thing that exists.
  data: { id: 'data', line: '#', block: null, quotes: `'"`, full: false },
};

const EXT_LANG = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  vue: 'js', svelte: 'js', astro: 'js',
  py: 'py', rb: 'rb', php: 'php', sh: 'sh', bash: 'sh', zsh: 'sh',
  go: 'c', java: 'c', cs: 'c', kt: 'c', swift: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', rs: 'c', scala: 'c',
  html: 'html', htm: 'html',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', ini: 'data', cfg: 'data', conf: 'data', properties: 'data',
};

/** Files that are generated, vendored or minified — reviewing them is all noise. */
const SKIP_PATH = [
  /(^|\/)node_modules\//i,
  /(^|\/)(dist|build|out|coverage|vendor|third_party)\//i,
  /\.min\.(js|css)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
  /\.(map|lock)$/i,
];

/** A regex line-scanner on a 4MB bundle is a hang, not a review. */
export const MAX_REVIEW_BYTES = 512 * 1024;
/** One line this long means minified or generated: columns are meaningless. */
export const MAX_LINE_CHARS = 2000;
/** Past this many findings in one file the answer is "rewrite it", not a list. */
export const MAX_FINDINGS_PER_FILE = 40;

// ── text handling ───────────────────────────────────────────────────────────

/**
 * Blank out comments, preserving every byte offset (comment chars become
 * spaces, newlines stay newlines). Offsets must survive because a finding
 * reports a COLUMN, and a column that does not point at the code it names is
 * worse than no column.
 *
 * ⚠️ STRINGS ARE NOT BLANKED — deliberately. Half the evidence lives inside
 * string literals (the SQL text, the connection string, the `-----BEGIN` block).
 * Only comments go.
 *
 * ⚠️ KNOWN LIMIT, WRITTEN DOWN RATHER THAN HIDDEN: this does not track JS
 * regex literals, so a regex whose body contains an unescaped `//` would be
 * read as a comment. In practice `//` inside a regex is written `\/\/`, which
 * has no adjacent pair. It is a lexer, not a parser, and this is the price.
 */
export function blankComments(content, lang) {
  const src = String(content);
  const out = new Array(src.length);
  let inBlock = false;
  let quote = null;
  // Inside a backtick template, `${ … }` is CODE again — a quote character in
  // there must not be read as closing the template.
  let tplDepth = 0;
  const bs = lang.block ? lang.block[0] : null;
  const be = lang.block ? lang.block[1] : null;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const keepNewline = ch === '\n' || ch === '\r';

    if (inBlock) {
      out[i] = keepNewline ? ch : ' ';
      if (be && src.startsWith(be, i)) {
        for (let k = 0; k < be.length; k++) out[i + k] = src[i + k] === '\n' ? '\n' : ' ';
        i += be.length - 1;
        inBlock = false;
      }
      continue;
    }

    if (quote) {
      out[i] = ch;
      if (ch === '\\') { if (i + 1 < src.length) out[i + 1] = src[i + 1]; i++; continue; }
      if (quote === '`' && ch === '$' && src[i + 1] === '{') { tplDepth++; out[i + 1] = '{'; i++; continue; }
      if (quote === '`' && tplDepth > 0 && ch === '}') { tplDepth--; continue; }
      if (tplDepth === 0 && ch === quote) quote = null;
      // A single-quoted string in most of these languages cannot span lines;
      // if it does, we are mis-lexing, so bail out at the newline rather than
      // swallowing the rest of the file.
      if (keepNewline && quote !== '`') quote = null;
      continue;
    }

    if (bs && src.startsWith(bs, i)) { inBlock = true; out[i] = ' '; continue; }
    if (lang.line && src.startsWith(lang.line, i)) {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++; }
      out[i] = '\n';
      continue;
    }
    if (lang.quotes.includes(ch)) { quote = ch; tplDepth = 0; }
    out[i] = ch;
  }
  return out.join('');
}

function excerpt(line) {
  const t = String(line ?? '').trim();
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * ⚠️ `\b(token)\b` DOES NOT MATCH `resetToken`, AND THAT SILENTLY DISABLED THE
 * BEST RULE IN THIS FILE. Every noun list below is matched against this
 * normalised form instead: camel boundaries become underscores, then lowercase.
 * `resetToken` → `reset_token` → `\btoken\b` matches. `sessionId` →
 * `session_id`. Without this, insecure-randomness fired on `const token =`
 * (snake by luck) and not on `const resetToken =`, which is the spelling a
 * model actually emits.
 */
function camelWords(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // ⚠️ `_` AND `-` TOO. `res.cookie('session_id', t)` went unflagged because
    // `\bsession\b` does not match `session_id` — the underscore is a word
    // character, so there is no boundary after `session`. Snake_case is the
    // other half of how these names are spelled and both must normalise.
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

/**
 * Is this expression made only of literals? If so it is not attacker-controlled
 * and nothing here may flag it. This is rule 1 in code.
 */
export function isLiteralOnly(expr) {
  const t = String(expr ?? '').trim().replace(/[;,)\]}]+$/, '').trim();
  if (!t) return false;
  if (/^`[^`$]*`$/.test(t)) return true;              // template with no ${…}
  if (/^'(?:\\.|[^'\\])*'$/.test(t)) return true;
  if (/^"(?:\\.|[^"\\])*"$/.test(t)) return true;
  // A concatenation of literals only: 'a' + "b"
  if (/^(['"][^'"]*['"]\s*\+\s*)+['"][^'"]*['"]$/.test(t)) return true;
  return false;
}

// ── taint: the only thing standing between "a finding" and "noise" ──────────

const TAINT_SOURCES = [
  /\breq(uest)?\s*\.\s*(query|body|params|headers|cookies|url|originalUrl|files|path)\b/,
  /\bctx\s*\.\s*(query|params|request|req)\b/,
  /\bevent\s*\.\s*(body|queryStringParameters|pathParameters|headers)\b/,
  /\bsearchParams\s*\.\s*get\s*\(/,
  /\buseSearchParams\s*\(/,
  /\bformData\s*\.\s*get\s*\(/,
  /\bprocess\s*\.\s*argv\b/,
  /\bsys\s*\.\s*argv\b/,
  /\blocation\s*\.\s*(search|hash|href|pathname)\b/,
  /\bdocument\s*\.\s*(URL|referrer|cookie)\b/,
  /\bwindow\s*\.\s*name\b/,
  /\brequest\s*\.\s*(args|form|json|values|files|GET|POST)\b/,
  /\bparams\s*\[/,
  /\$_(GET|POST|REQUEST|COOKIE|FILES)\b/,
];

/**
 * ⚠️ ONE FORWARD PASS, AND IT IS DELIBERATELY AN OVER-APPROXIMATION.
 *
 * The tainted set is built over the whole file before any rule runs, so a
 * variable declared at line 90 counts as tainted at line 10 too. That is
 * technically wrong and it is the right trade: handlers are routinely defined
 * below the routes that reference them, and the alternative — losing taint
 * because of source order — turns HIGH-confidence findings into MEDIUM ones,
 * i.e. it degrades the thing that makes this reviewer usable.
 *
 * It never CREATES a finding on its own: every rule that consults taint also
 * requires its own dangerous-sink evidence on the line.
 */
export function taintedNames(codeLines) {
  const tainted = new Set();
  const safeConsts = new Set();
  const seen = (expr) => TAINT_SOURCES.some((rx) => rx.test(expr))
    || [...tainted].some((n) => new RegExp(`\\b${escapeRx(n)}\\b`).test(expr));

  // Two passes: a value can be laundered through an intermediate declared
  // above OR below its use, and one pass would only catch the first order.
  for (let pass = 0; pass < 2; pass++) {
    for (const code of codeLines) {
      /**
       * ⚠️⚠️ `^` WITHOUT `\s*` MADE THIS RULE A NO-OP AND EVERY TEST STILL
       * PASSED. The first version anchored with `(?:^|[;{}]\s*)`, so it saw
       * `const x = req.query.id` at column 0 and never saw the indented one
       * inside a route handler — which is where every declaration in real code
       * lives. Taint was therefore empty for realistic files, every
       * taint-gated rule silently dropped to its lower confidence, and nothing
       * went red. Caught only by running the reviewer over a whole clean file
       * and noticing a finding that should have fired did not.
       */
      const m = /(?:^\s*|[;{}]\s*)(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(code)
        || /^\s*([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(code);
      if (!m) continue;
      const target = m[1].trim();
      const rhs = m[2].trim();

      // The bare-assignment arm can capture a keyword (`return x = 1`); a
      // language keyword is never a variable we want to taint.
      if (/^(const|let|var|return|await|if|while|for|else)$/.test(target)) continue;

      if (seen(rhs)) {
        for (const name of bindingNames(target)) tainted.add(name);
      } else if (pass === 0 && isLiteralOnly(rhs) && /^[A-Za-z_$][\w$]*$/.test(target)) {
        safeConsts.add(target);
      }
    }
  }
  return { tainted, safeConsts };
}

/** `{ a, b: c }` → ['a','c'] · `[x, y]` → ['x','y'] · `name` → ['name'] */
function bindingNames(target) {
  const inner = /^[{[]/.test(target) ? target.slice(1, -1) : target;
  return inner
    .split(',')
    .map((p) => p.includes(':') ? p.split(':').pop() : p)
    .map((p) => p.replace(/=.*$/, '').replace(/\.\.\./, '').trim())
    /**
     * ⚠️ A DENYLIST, NOT A LENGTH RULE. The first version required 2+
     * characters to stop `i` and `e` tainting a whole file — and that dropped
     * `const q = req.query.q`, which is exactly how a model names a search
     * parameter. Measured: the XSS in `res.send(\`…${q}…\`)` went unreported.
     * So single letters are allowed except the handful that are conventionally
     * a counter or a caught error and are never a request value. `n` is NOT on
     * the list: `const n = req.query.n` is how a model names a page size, and
     * excluding it lost the unbounded-loop finding that depends on it.
     */
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p) && !/^(i|j|k|e|_|\$)$/.test(p));
}

// ── the rules ───────────────────────────────────────────────────────────────

const SQL_STMT = /\b(select|insert\s+into|update|delete\s+from|drop\s+table|alter\s+table)\b[\s\S]{0,240}?\b(from|into|set|where|values|table)\b/i;

/**
 * ── ⚠️⚠️ THE FALSE POSITIVE THAT NEARLY SHIPPED ────────────────────────────
 * `SQL_STMT` alone matches this, which is an ordinary log line:
 *
 *     console.log('Select the file from the list: ' + name)
 *
 * "Select" … "from" is the same shape as `SELECT … FROM`. A reviewer that
 * flags that once is a reviewer nobody runs twice. So a SQL finding needs
 * evidence beyond the two keywords, and there are two independent kinds:
 *
 *  · SHAPE — what follows FROM/INTO/UPDATE parses as a table reference. In
 *    prose, `from the list` is followed by another bare word; in SQL, the
 *    table name is followed by WHERE/SET/VALUES/JOIN/a quote/end of string.
 *  · CONTEXT — something on the line executes or names a query (`db.query`,
 *    `cursor.execute`, `knex.raw`, a variable called `sql`).
 *
 * With neither, the finding still exists but drops to `low` and says why —
 * recall is kept for `minConfidence: 'low'`, and the default report stays
 * quiet. That is the trade this whole module is built around.
 */
const SQL_SHAPE = /\b(from|into|join|update)\s+(?:\$\{[^}]*\}|["'`[]?[A-Za-z_][\w.$]*["'`\]]?)\s*(?:\bwhere\b|\bset\b|\bvalues\b|\bjoin\b|\border\b|\bgroup\b|\blimit\b|\bon\b|\bas\b|[;,()]|["'`]|\+|\$\{|$)/i;
const SQL_CONTEXT = /\b(query|execute|exec|raw|prepare|db|cursor|conn|connection|knex|sequelize|pool|client|sql|stmt|statement)\b/i;
const SANITISERS = /\b(DOMPurify\s*\.\s*sanitize|sanitize[Hh]tml|sanitizeHTML|xss\s*\(|escapeHtml|createDOMPurify)\b/;
const AUTH_COOKIE = /\b(sess|session|sid|token|jwt|auth|login|remember|csrf)\b/i;
const CREDENTIAL_NOUN = /\b(password|passwd|pwd|credential|passphrase)\b/i;
// ⚠️ Matched against `camelWords(…)`, so every separator has already become a
// space — hence `api ?key`, not `api[_-]?key`. Deliberately WITHOUT a bare
// `key`: `keyframe`, `Object.keys` and `keyboard` are everywhere, and
// `Math.random()` beside one of those is not a security defect.
const TOKEN_NOUN = /\b(token|secret|password|passwd|otp|nonce|salt|session|csrf|api ?key|private ?key|reset ?code|verification ?code|auth ?code|uuid|guid)\b/i;

const SECRET_NAME = /\b(api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|app[_-]?secret|secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|bearer[_-]?token|password|passwd|db[_-]?pass|private[_-]?key)\b/i;

/**
 * Prefixes that are a live credential by construction — no entropy heuristic
 * needed, and no placeholder ever looks like this.
 */
const KNOWN_KEY = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'an OpenAI-style secret key'],
  [/\bsk_live_[A-Za-z0-9]{16,}/, 'a live Stripe secret key'],
  [/\brk_live_[A-Za-z0-9]{16,}/, 'a live Stripe restricted key'],
  [/\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub fine-grained token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, 'a SendGrid key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key block'],
];

const PLACEHOLDER = /(your[_-]?|my[_-]?|example|sample|placeholder|changeme|change[_-]?me|dummy|fake|todo|xxxx|<[^>]+>|\$\{|%s|\.\.\.|insert[_-]?here|redacted|replace[_-]?me|test[_-]?key|foo|bar|abc123)/i;

/**
 * Does this literal look like a real credential rather than a stand-in?
 * ⚠️ Deliberately strict. A false "you committed a key" costs the user a
 * rotation they did not need and teaches them to ignore the reviewer.
 */
export function looksLikeRealSecret(value) {
  const v = String(value ?? '');
  if (v.length < 12) return false;
  if (PLACEHOLDER.test(v)) return false;
  if (/^[A-Z_]+$/.test(v)) return false;                 // an env var NAME, not a value
  if (new Set(v).size < 8) return false;                 // 'xxxxxxxxxxxxxx'
  if (/^(https?|file):\/\//i.test(v)) return false;      // a URL is not a key
  if (/\s/.test(v)) return false;                        // a sentence, not a credential
  /**
   * ⚠️ MEASURED FALSE POSITIVE: `const SECRET_HEADER = 'x-app-secret'` was
   * flagged as a committed credential. All-lowercase kebab or snake words are
   * header names, config keys and env var names — never a generated key, which
   * always mixes case or digits.
   */
  if (/^[a-z][a-z0-9]*([-_][a-z0-9]+)*$/.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((rx) => rx.test(v)).length;
  return classes >= 2;
}

/** Read the text inside a call's parentheses, spanning up to `maxLines`. */
function readCall(codeLines, li, openIdx, maxLines = 8) {
  let depth = 0;
  let out = '';
  for (let i = li; i < codeLines.length && i - li < maxLines; i++) {
    const s = i === li ? codeLines[i].slice(openIdx) : codeLines[i];
    for (const ch of s) {
      if (ch === '(') { depth++; if (depth === 1) continue; }
      else if (ch === ')') { depth--; if (depth === 0) return out; }
      if (depth >= 1) out += ch;
    }
    out += ' ';
  }
  return out;
}

/** Read a `{ … }` block starting at `openIdx`, spanning up to `maxLines`. */
function readBlock(codeLines, li, openIdx, maxLines = 8) {
  let depth = 0;
  let out = '';
  let endLine = li;
  for (let i = li; i < codeLines.length && i - li < maxLines; i++) {
    const s = i === li ? codeLines[i].slice(openIdx) : codeLines[i];
    for (const ch of s) {
      if (ch === '{') { depth++; if (depth === 1) continue; }
      else if (ch === '}') { depth--; if (depth === 0) return { body: out, endLine: i }; }
      if (depth >= 1) out += ch;
    }
    out += '\n';
    endLine = i;
  }
  return { body: out, endLine, unterminated: true };
}

// ── review ──────────────────────────────────────────────────────────────────

/**
 * Review one file's source text.
 *
 * @param {string} path   workspace-relative path (decides the language, and
 *                        whether the file is a credential file at all)
 * @param {string} content the source text
 * @param {{minConfidence?: 'low'|'medium'|'high'}} [opts]
 * @returns {any[]} findings, most serious first. NEVER throws.
 */
export function reviewCode(path, content, opts = {}) {
  /**
   * ⚠️ THE DEFAULT IS `medium`, AND IT MUST BE THE SAME NUMBER IN ALL THREE
   * ENTRY POINTS. The first version defaulted `reviewCode` to `low` while
   * `executeReviewCode` and `reviewWrittenFiles` defaulted to `medium`, so the
   * function the tests called was strictly noisier than the one the agent
   * calls — the low-confidence guesses this module deliberately hides were
   * visible only to the test suite. Two thresholds means the thing under test
   * is not the thing that ships.
   */
  const min = CONFIDENCE_RANK[opts.minConfidence] ?? CONFIDENCE_RANK[DEFAULT_MIN_CONFIDENCE];
  let findings;
  try {
    findings = collect(path, content);
  } catch (err) {
    /**
     * ⚠️ A REVIEWER THAT THROWS DESTROYS THE REPORT IT WAS ADDED TO. It runs at
     * the end of a run, after the work is done; an exception here would turn a
     * successful build into a crash. It reports its own failure as a finding
     * instead, so the failure is visible rather than silent.
     */
    return [{
      path, line: 1, column: 1, rule: 'reviewer-failed', category: 'footgun',
      severity: 'low', confidence: 'high',
      confidenceWhy: 'the reviewer itself threw — this is about the reviewer, not your code',
      why: `the code reviewer could not parse this file: ${err && err.message}`,
      fix: 'nothing to do in your code — this file was simply not reviewed, so do not read a clean result for it as a pass',
      evidence: '',
    }];
  }
  return findings
    .filter((f) => CONFIDENCE_RANK[f.confidence] >= min)
    .sort((a, b) =>
      (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
      || (CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])
      || (a.line - b.line)
      || a.rule.localeCompare(b.rule))
    .slice(0, MAX_FINDINGS_PER_FILE);
}

function collect(path, content) {
  const p = String(path ?? '');
  const src = String(content ?? '');

  /**
   * ⭐ THE CREDENTIAL-PATH CHECK RUNS FIRST AND ALONE, and it runs BEFORE the
   * extension gate because `.env`, `.pem` and `id_rsa` are not languages we
   * lex. One finding, and the secret-literal rules are skipped: an env file
   * full of keys is an env file working correctly.
   */
  const refusal = refusedCommitPath(p);
  if (refusal) {
    return [{
      path: p, line: 1, column: 1, rule: 'credential-file', category: 'secret',
      severity: 'high', confidence: 'high',
      confidenceWhy: 'decided by the path alone, using the same list this agent uses to refuse commits',
      why: `${refusal}. Its CONTENTS are fine — the danger is the file reaching version control, because git keeps it after you delete it.`,
      fix: `add \`${p}\` to .gitignore before the next commit, ship a \`${p}.example\` with the keys blanked, and if it was ever committed rotate every value in it — deleting the file does not remove it from history`,
      evidence: '',
    }];
  }

  if (SKIP_PATH.some((rx) => rx.test(p))) return [];
  if (src.length > MAX_REVIEW_BYTES) return [];

  const ext = (p.split('.').pop() || '').toLowerCase();
  const lang = LANGS[EXT_LANG[ext]];
  if (!lang) return [];

  const raw = src.split(/\r?\n/);
  // ⚠️ Minified/generated: one enormous line. Column numbers would be useless
  // and every rule would fire at once. Reviewing it is worse than skipping it.
  if (raw.some((l) => l.length > MAX_LINE_CHARS)) return [];

  const code = blankComments(src, lang).split(/\r?\n/);
  const { tainted, safeConsts } = lang.full ? taintedNames(code) : { tainted: new Set(), safeConsts: new Set() };

  const isTest = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|mocks?|examples?)\//i.test(p)
    || /\.(test|spec)\.[a-z]+$/i.test(p);

  const ctx = { path: p, lang, raw, code, tainted, safeConsts, isTest, codeText: code.join('\n') };
  ctx.isTainted = (expr) => {
    const e = String(expr ?? '');
    if (!e.trim()) return false;
    if (TAINT_SOURCES.some((rx) => rx.test(e))) return true;
    return [...tainted].some((n) => new RegExp(`\\b${escapeRx(n)}\\b`).test(e));
  };

  const out = [];
  ruleSecrets(ctx, out);
  if (lang.full) {
    ruleInjection(ctx, out);
    ruleWeb(ctx, out);
    ruleAuthCrypto(ctx, out);
    ruleFootguns(ctx, out);
  }

  // Dedupe: one finding per rule per line, whichever fired first.
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.rule}:${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function add(ctx, out, f) {
  out.push({
    path: ctx.path,
    line: f.line,
    column: f.column ?? 1,
    rule: f.rule,
    category: f.category,
    severity: f.severity,
    confidence: f.confidence,
    confidenceWhy: f.confidenceWhy,
    why: f.why,
    fix: f.fix,
    evidence: excerpt(ctx.raw[f.line - 1]),
  });
}

// ── injection ───────────────────────────────────────────────────────────────

/**
 * Every value spliced into this text, as source expressions.
 *
 * ⚠️ THE LANGUAGE GATE IS NOT TIDINESS, IT IS A BUG FIX. The python `%`
 * extractor, run on JavaScript, reads `WHERE name LIKE '%foo%'` as an
 * interpolation of `foo` — a SQL wildcard turned into a fake injection
 * finding. `%` and `.format` only mean interpolation in python; `#{}` only in
 * ruby. Applying every language's rules to every language is how a reviewer
 * invents defects.
 */
function interpolatedExprs(text, langId = 'js') {
  const out = [];
  for (const m of text.matchAll(/\$\{([^}]*)\}/g)) out.push(m[1].trim());          // JS template
  for (const m of text.matchAll(/['"]\s*\+\s*([A-Za-z_$][\w$.[\]()]*)/g)) out.push(m[1].trim()); // concat
  for (const m of text.matchAll(/([A-Za-z_$][\w$.[\]()]*)\s*\+\s*['"]/g)) out.push(m[1].trim());
  if (langId === 'py') {
    /**
     * ⚠️ THE `%` MUST FOLLOW A CLOSING QUOTE. `"… WHERE id = %s"` is the
     * CORRECT parameterised form and its `%s` is a placeholder, not an
     * interpolation — reading it as one turned a safe `cursor.execute(sql,
     * (uid,))` into a critical injection finding. Real python interpolation is
     * `"…" % (uid,)`, where the operator sits outside the string.
     */
    for (const m of text.matchAll(/['"]\s*%\s*\(?\s*([A-Za-z_][\w.[\]]*)/g)) out.push(m[1].trim());
    for (const m of text.matchAll(/\.format\s*\(\s*([^)]*)\)/g)) out.push(m[1].trim());
    // f-strings interpolate with neither `+` nor `${`.
    if (/\bf['"]/.test(text)) for (const m of text.matchAll(/\{([A-Za-z_][\w.[\]]*)\}/g)) out.push(m[1].trim());
  }
  if (langId === 'rb') for (const m of text.matchAll(/#\{([^}]*)\}/g)) out.push(m[1].trim());
  return out.filter(Boolean);
}

function ruleInjection(ctx, out) {
  for (let i = 0; i < ctx.code.length; i++) {
    const line = ctx.code[i];
    const n = i + 1;
    if (!line.trim()) continue;

    // ── SQL built by string concatenation ──────────────────────────────────
    if (SQL_STMT.test(line)) {
      const exprs = interpolatedExprs(line, ctx.lang.id);
      const real = exprs.filter((e) => !/^['"`]/.test(e));
      if (real.length > 0) {
        const anyTainted = real.some((e) => ctx.isTainted(e));
        const allConst = real.every((e) => ctx.safeConsts.has(e.split(/[.[(]/)[0]));
        // See the SQL_SHAPE comment: without shape or context evidence this is
        // as likely to be an English sentence as a query.
        const strong = SQL_SHAPE.test(line) || SQL_CONTEXT.test(camelWords(line));
        const confidence = !strong ? 'low' : (anyTainted ? 'high' : (allConst ? 'low' : 'medium'));
        add(ctx, out, {
          line: n, column: line.search(SQL_STMT) + 1,
          rule: 'sql-string-concat', category: 'injection',
          severity: 'critical', confidence,
          confidenceWhy: !strong
            ? 'these words have the shape of SQL, but nothing on this line executes or names a query and what follows FROM/INTO does not parse as a table — this may simply be an English sentence'
            : (anyTainted
              ? `\`${real.find((e) => ctx.isTainted(e))}\` traces back to request input in this file`
              : (allConst
                ? `every interpolated value (${real.join(', ')}) is a literal \`const\` declared in this file, so it is probably a table name — check it is not reassigned`
                : `\`${real[0]}\` is a variable and this file does not show where it came from`)),
          why: 'the query text is assembled by string interpolation, so whatever this value contains becomes SQL. A value of `1 OR 1=1--` reads the whole table; `1; DROP TABLE users--` does worse.',
          fix: 'use a placeholder and pass the value separately — `db.query("SELECT * FROM users WHERE id = $1", [id])` (pg) or `?` (mysql/sqlite). If the interpolated part is an identifier (a table or column name) placeholders cannot help: check it against a hardcoded allow-list instead.',
        });
      }
    }

    // ── a shell command built from a variable ──────────────────────────────
    const shell = /\b(exec|execSync|os\.system|popen|shell_exec|system)\s*\(/.exec(line);
    if (shell) {
      const args = readCall(ctx.code, i, line.indexOf('(', shell.index));
      const exprs = interpolatedExprs(args, ctx.lang.id);
      if (exprs.length > 0 && !isLiteralOnly(args)) {
        const anyTainted = exprs.some((e) => ctx.isTainted(e));
        add(ctx, out, {
          line: n, column: shell.index + 1,
          rule: 'shell-string-interpolation', category: 'injection',
          severity: 'critical', confidence: anyTainted ? 'high' : 'medium',
          confidenceWhy: anyTainted
            ? `\`${exprs.find((e) => ctx.isTainted(e))}\` traces back to request input in this file`
            : 'the command string is built from a variable whose origin is not visible here',
          why: `\`${shell[1]}\` hands the whole string to a shell, so \`;\`, \`|\`, \`$(…)\` and backticks in that value are commands. A filename of \`a; rm -rf ~\` is a working exploit.`,
          fix: 'use the argv form, which never involves a shell: `execFile("git", ["checkout", branch])` in Node, `subprocess.run(["git","checkout",branch])` in Python. If you truly need a shell, validate the value against an allow-list first — quoting by hand is not reliable.',
        });
      }
    }
    const pyShell = /subprocess\.(run|call|check_output|check_call|Popen)\s*\(/.exec(line);
    if (pyShell) {
      const args = readCall(ctx.code, i, line.indexOf('(', pyShell.index));
      if (/shell\s*=\s*True/.test(args) && interpolatedExprs(args, ctx.lang.id).length > 0) {
        add(ctx, out, {
          line: n, column: pyShell.index + 1,
          rule: 'shell-string-interpolation', category: 'injection',
          severity: 'critical', confidence: ctx.isTainted(args) ? 'high' : 'medium',
          confidenceWhy: ctx.isTainted(args)
            ? 'an interpolated value traces back to request input in this file'
            : '`shell=True` with an interpolated command string; the value\'s origin is not visible here',
          why: '`shell=True` runs the string through /bin/sh, so shell metacharacters in the interpolated value are commands.',
          fix: 'drop `shell=True` and pass a list: `subprocess.run(["git", "checkout", branch])`.',
        });
      }
    }

    // ── eval / new Function on something that is not a literal ─────────────
    const ev = /\b(eval|new\s+Function)\s*\(/.exec(line);
    if (ev) {
      const args = readCall(ctx.code, i, line.indexOf('(', ev.index));
      // ⭐ RULE 1 IN ACTION: `eval('2+2')` is ugly, not a vulnerability. No
      // evidence of an outside value means no finding.
      if (args.trim() && !isLiteralOnly(args)) {
        const anyTainted = ctx.isTainted(args);
        add(ctx, out, {
          line: n, column: ev.index + 1,
          rule: 'eval-non-literal', category: 'injection',
          severity: anyTainted ? 'critical' : 'high',
          confidence: anyTainted ? 'high' : 'medium',
          confidenceWhy: anyTainted
            ? 'the evaluated expression traces back to request input in this file'
            : 'the argument is not a literal, so this executes text computed at runtime — where that text comes from is not visible here',
          why: `\`${ev[1].replace(/\s+/g, ' ')}\` compiles and runs its argument as code with this program's full privileges. If any part of that string can be influenced from outside, it is remote code execution.`,
          fix: 'for data use `JSON.parse`; for a dispatch table use an object of allowed functions keyed by name; for arithmetic use a small expression parser. If it is a fixed snippet, inline it — there is no case where `eval` of a computed string is the right answer.',
        });
      }
    }
  }
}

// ── secrets ─────────────────────────────────────────────────────────────────

function ruleSecrets(ctx, out) {
  for (let i = 0; i < ctx.code.length; i++) {
    const line = ctx.code[i];
    const n = i + 1;
    if (!line.trim()) continue;

    // A key whose shape identifies the issuer. No heuristic needed.
    for (const [rx, what] of KNOWN_KEY) {
      const m = rx.exec(line);
      if (!m) continue;
      add(ctx, out, {
        line: n, column: m.index + 1,
        rule: 'committed-secret', category: 'secret',
        severity: 'critical', confidence: ctx.isTest ? 'medium' : 'high',
        confidenceWhy: ctx.isTest
          ? `the value has the exact shape of ${what}, but this path looks like a test fixture, where a fake key is normal — confirm it is fake`
          : `the value has the exact shape of ${what}; no placeholder looks like this`,
        why: 'a live credential in source is compromised the moment the file is shared, pushed, or included in a build. Git keeps it after you delete the line, and public-repo scanners find these within minutes.',
        fix: 'move it to an environment variable (`process.env.API_KEY`), add the env file to .gitignore, and ROTATE the key — assume it is already burned. Removing the line is not enough; the value stays in history.',
      });
    }

    // A connection string carrying a password.
    const conn = /\b[a-z][a-z0-9+.-]*:\/\/([A-Za-z0-9._%-]+):([^@\s'"/`]{3,})@/i.exec(line);
    if (conn && !PLACEHOLDER.test(conn[2]) && !/^(pass(word)?|secret|user|admin|root|test)$/i.test(conn[2])) {
      add(ctx, out, {
        line: n, column: conn.index + 1,
        rule: 'connection-string-password', category: 'secret',
        severity: 'critical', confidence: ctx.isTest ? 'low' : 'high',
        confidenceWhy: ctx.isTest
          ? 'a URL with embedded credentials, but this path looks like a test fixture'
          : 'a URL with a non-placeholder password embedded in it',
        why: 'the database password is in source. It also leaks further than you expect: connection URLs end up in logs, error messages and crash reports.',
        fix: 'build the URL from env vars at runtime — `postgres://${process.env.DB_USER}:${process.env.DB_PASS}@host/db` — and rotate this password, because it is already in git history.',
      });
    }

    /**
     * name = "value" where the name says credential and the value looks real.
     *
     * ⚠️ `matchAll`, NOT `exec`. With `exec` this read only the FIRST
     * assignment on the line, so `{ url: "x", apiKey: "…" }` — one object
     * literal, which is how config is actually written — was judged on `url`
     * and the key beside it was never looked at.
     */
    // ⚠️ `['"]?` BEFORE THE COLON. In JSON — the single most likely place for a
    // committed key after a .env — the NAME is quoted too (`"apiKey": "…"`),
    // and without this the rule matched nothing in any .json file at all.
    for (const assign of line.matchAll(/([A-Za-z_$][\w$.-]*)['"]?\s*[:=]\s*(['"`])((?:\\.|(?!\2).)*)\2/g)) {
      if (!SECRET_NAME.test(assign[1]) || !looksLikeRealSecret(assign[3])) continue;
      // Already reported, more precisely, by the known-prefix rule above.
      if (KNOWN_KEY.some(([rx]) => rx.test(assign[3]))) continue;
      add(ctx, out, {
        line: n, column: assign.index + 1,
        rule: 'hardcoded-secret', category: 'secret',
        severity: 'high', confidence: ctx.isTest ? 'low' : 'medium',
        confidenceWhy: ctx.isTest
          ? `\`${assign[1]}\` is assigned a literal, but this path looks like a test fixture where a dummy value is expected`
          : `\`${assign[1]}\` is assigned a string literal that does not look like a placeholder — it may still be a sample value, so check before rotating`,
        why: 'a credential written into source is shared with everyone who can read the repo, and it survives deletion because git keeps history.',
        fix: 'read it from the environment instead (`process.env.…` / `os.environ[…]`), keep the real value in a gitignored .env, and commit a `.env.example` with the key names only.',
      });
    }

    // process.env.X || 'literal' — the fallback IS the committed secret.
    const fallback = /process\.env\.([A-Z_][A-Z0-9_]*)\s*(\|\||\?\?)\s*(['"`])((?:\\.|(?!\3).)*)\3/.exec(line);
    if (fallback && SECRET_NAME.test(fallback[1]) && looksLikeRealSecret(fallback[4])) {
      add(ctx, out, {
        line: n, column: fallback.index + 1,
        rule: 'hardcoded-secret-fallback', category: 'secret',
        severity: 'high', confidence: 'medium',
        confidenceWhy: 'the env var is read correctly; the literal after `||` is the part that ships',
        why: 'the fallback defeats the environment variable: if the variable is ever unset — a new machine, a missed CI secret — the app silently runs on this hardcoded value instead of failing.',
        fix: 'fail loudly instead: `const key = process.env.API_KEY; if (!key) throw new Error("API_KEY is not set");`. A missing secret should stop the process, not be quietly substituted.',
      });
    }
  }
}

// ── web ─────────────────────────────────────────────────────────────────────

function ruleWeb(ctx, out) {
  for (let i = 0; i < ctx.code.length; i++) {
    const line = ctx.code[i];
    const n = i + 1;
    if (!line.trim()) continue;

    // dangerouslySetInnerHTML={{ __html: value }}
    const dsi = /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*([^}]*)\}/.exec(line);
    if (dsi) {
      const val = dsi[1].trim();
      // ⭐ THE SUSPECT GETS TO SPEAK: a named sanitizer is accepted at face
      // value. We cannot verify it (no cross-file view) and flagging it anyway
      // would punish the correct fix, which is how a reviewer gets muted.
      if (!isLiteralOnly(val) && !SANITISERS.test(val)) {
        const t = ctx.isTainted(val);
        add(ctx, out, {
          line: n, column: dsi.index + 1,
          rule: 'dangerously-set-inner-html', category: 'web',
          severity: 'high', confidence: t ? 'high' : 'medium',
          confidenceWhy: t
            ? `\`${val}\` traces back to request input in this file, and no sanitizer call appears on this line`
            : 'the value is not a literal and no sanitizer call appears on this line; where it comes from is not visible here',
          why: 'React escapes everything except this. Whatever HTML is in that value is parsed and run, so a stored `<img src=x onerror=fetch("/api/keys").then(...)>` executes in every viewer\'s session.',
          fix: 'render it as text (`{value}`) if it is text. If it really must be HTML, sanitize on the way in AND out with DOMPurify: `dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }}`.',
        });
      }
    }

    // el.innerHTML = value  ·  insertAdjacentHTML  ·  document.write
    const ih = /\.\s*(innerHTML|outerHTML)\s*=\s*([^;]+)/.exec(line);
    if (ih) {
      const val = ih[2].trim();
      if (!isLiteralOnly(val) && !SANITISERS.test(val)) {
        const t = ctx.isTainted(val);
        add(ctx, out, {
          line: n, column: ih.index + 1,
          rule: 'inner-html-assignment', category: 'web',
          severity: t ? 'high' : 'medium', confidence: t ? 'high' : 'low',
          confidenceWhy: t
            ? `\`${val}\` traces back to input read from the URL or a request in this file`
            : 'assigning a non-literal to innerHTML is only a bug if the value can carry markup from elsewhere — this file does not show where it comes from, so this is a prompt to check, not a defect',
          why: 'assigning to innerHTML parses the string as HTML. Any markup in the value runs, including `<img onerror>` — which is XSS in the user\'s own session.',
          fix: 'use `textContent` when you want text (it is also faster). When you need structure, build it with `createElement`/`append`, or sanitize with DOMPurify first.',
        });
      }
    }

    const iah = /\.\s*insertAdjacentHTML\s*\(/.exec(line);
    if (iah) {
      const args = readCall(ctx.code, i, line.indexOf('(', iah.index));
      const val = args.split(',').slice(1).join(',').trim();
      if (val && !isLiteralOnly(val) && !SANITISERS.test(val) && ctx.isTainted(val)) {
        add(ctx, out, {
          line: n, column: iah.index + 1,
          rule: 'inner-html-assignment', category: 'web',
          severity: 'high', confidence: 'high',
          confidenceWhy: 'the inserted markup traces back to input read from the URL or a request in this file',
          why: 'insertAdjacentHTML parses its argument as HTML, so markup in that value runs in the page.',
          fix: 'insert text with `insertAdjacentText`, or sanitize with DOMPurify before inserting.',
        });
      }
    }

    // An HTML response assembled by interpolation, with no escaping in sight.
    const htmlOut = /\b(res|response)\s*\.\s*(send|write|end)\s*\(\s*`/.exec(line);
    if (htmlOut) {
      const args = readCall(ctx.code, i, line.indexOf('(', htmlOut.index));
      const exprs = interpolatedExprs(args, ctx.lang.id);
      const tainted = exprs.filter((e) => ctx.isTainted(e) && !/escape|sanit|encodeURI/i.test(e));
      if (/<[a-z!/]/i.test(args) && tainted.length > 0) {
        add(ctx, out, {
          line: n, column: htmlOut.index + 1,
          rule: 'unescaped-html-output', category: 'web',
          severity: 'high', confidence: 'high',
          confidenceWhy: `\`${tainted[0]}\` traces back to request input and is interpolated straight into an HTML response with no escaping call`,
          why: 'the value is written into the page as markup. A visitor who supplies `<script>` gets it executed in every viewer\'s browser — reflected XSS, and stored XSS if the value came from the database.',
          fix: 'escape on output: replace `& < > " \'` with entities, use a template engine that escapes by default (EJS `<%= %>`, Handlebars `{{ }}`), or return JSON and render on the client.',
        });
      }
    }

    // Handlebars/Mustache triple-stache disables escaping.
    const triple = /\{\{\{\s*[\w.]+\s*\}\}\}/.exec(line);
    if (triple && (ctx.lang.id === 'html' || /\.hbs$|\.handlebars$|\.mustache$/i.test(ctx.path))) {
      add(ctx, out, {
        line: n, column: triple.index + 1,
        rule: 'unescaped-html-output', category: 'web',
        severity: 'medium', confidence: 'medium',
        confidenceWhy: 'triple braces explicitly turn OFF the escaping the double-brace form gives you; whether the value is attacker-controlled is not visible here',
        why: '`{{{ x }}}` inserts raw HTML. Double braces escape; triple braces are the opt-out, and are only safe for markup you generated yourself.',
        fix: 'use `{{ x }}` unless the value is HTML you built and sanitized. If it must be raw, sanitize it before it reaches the template.',
      });
    }

    // CORS wildcard together with credentials — the combination is the bug.
    const wildcard = /(Access-Control-Allow-Origin['"\s:,]+\*)|(origin\s*:\s*['"]\*['"])/.exec(line);
    if (wildcard && /(Access-Control-Allow-Credentials['"\s:,]+true)|(credentials\s*:\s*true)/i.test(ctx.codeText)) {
      add(ctx, out, {
        line: n, column: wildcard.index + 1,
        rule: 'cors-wildcard-with-credentials', category: 'web',
        severity: 'high', confidence: 'high',
        confidenceWhy: 'both halves are present in this file: a `*` origin here and a credentials-true setting elsewhere in the same file',
        why: 'either alone is defensible; together they mean any website can make authenticated requests to this API using the visitor\'s cookies and read the responses. Browsers reject the literal combination, so code like this usually goes on to reflect the request Origin instead, which is the same hole with extra steps.',
        fix: 'list the origins you actually serve: `cors({ origin: ["https://app.example.com"], credentials: true })`. If you genuinely need any origin, you cannot also have credentials — use a bearer token instead of cookies.',
      });
    }

    // A cookie set without the flags that make it a session cookie.
    const ck = /\b(res|reply|ctx)\s*\.\s*(cookie|setCookie)\s*\(|\bcookies\s*\.\s*set\s*\(/.exec(line);
    if (ck) {
      const args = readCall(ctx.code, i, line.indexOf('(', ck.index));
      const nameMatch = /['"`]([^'"`]+)['"`]/.exec(args);
      const cookieName = nameMatch ? nameMatch[1] : '';
      const missing = [];
      if (!/httpOnly\s*:\s*true/i.test(args)) missing.push('httpOnly');
      if (!/secure\s*:\s*true/i.test(args)) missing.push('secure');
      if (!/sameSite\s*:/i.test(args)) missing.push('sameSite');
      if (missing.length > 0) {
        const authish = AUTH_COOKIE.test(camelWords(cookieName));
        add(ctx, out, {
          line: n, column: ck.index + 1,
          rule: 'cookie-missing-flags', category: 'web',
          severity: authish ? 'high' : 'low',
          // ⚠️ A theme-preference cookie without httpOnly is CORRECT — the
          // client needs to read it. Only a cookie whose NAME says session or
          // token earns a report-level finding.
          confidence: authish ? 'high' : 'low',
          confidenceWhy: authish
            ? `the cookie name \`${cookieName}\` says this carries a session or token, so the missing flags matter`
            : `\`${cookieName || 'this cookie'}\` does not look like a session cookie — a preference cookie is often meant to be readable by JavaScript, so this may be entirely correct`,
          why: `missing ${missing.join(', ')}. Without httpOnly any XSS on the page can read the cookie; without secure it is sent over plain HTTP; without sameSite another site can make the browser send it (CSRF).`,
          fix: `pass the flags: \`{ httpOnly: true, secure: true, sameSite: "lax", path: "/" }\`. Use \`secure: process.env.NODE_ENV === "production"\` if you develop over http://localhost.`,
        });
      }
    }
  }
}

// ── auth / crypto ───────────────────────────────────────────────────────────

function ruleAuthCrypto(ctx, out) {
  for (let i = 0; i < ctx.code.length; i++) {
    const line = ctx.code[i];
    const n = i + 1;
    if (!line.trim()) continue;

    // Math.random() — ONLY where the surrounding names say "this is a secret".
    // ⚠️ Math.random() for a jitter, an animation or a demo dataset is fine and
    // is by far the common case; flagging it unconditionally is exactly the
    // noise that gets a reviewer disabled.
    const mr = /\b(Math\.random\s*\(|random\.(random|randint|choice|randrange)\s*\()/.exec(line);
    if (mr && TOKEN_NOUN.test(camelWords(line))) {
      add(ctx, out, {
        line: n, column: mr.index + 1,
        rule: 'insecure-randomness', category: 'auth',
        severity: 'critical', confidence: 'high',
        confidenceWhy: `this line both calls a non-cryptographic RNG and names a secret (${(TOKEN_NOUN.exec(camelWords(line)) || [])[0]})`,
        why: 'Math.random is a fast, seeded, predictable generator — it was never meant to be unguessable. Given a couple of outputs an attacker can recover its state and predict every later value, so password-reset tokens and session ids become forgeable.',
        fix: 'use the CSPRNG: `crypto.randomUUID()` or `crypto.randomBytes(32).toString("hex")` in Node, `crypto.getRandomValues()` in the browser, `secrets.token_urlsafe(32)` in Python.',
      });
    }

    // md5 / sha1 for a password.
    const wh = /\b(createHash\s*\(\s*['"](md5|sha1)['"]|hashlib\.(md5|sha1)\s*\(|\bmd5\s*\()/i.exec(line);
    if (wh) {
      const near = [ctx.code[i - 1] ?? '', line, ctx.code[i + 1] ?? ''].join(' ');
      const cred = CREDENTIAL_NOUN.test(camelWords(near));
      add(ctx, out, {
        line: n, column: wh.index + 1,
        rule: 'weak-password-hash', category: 'auth',
        severity: cred ? 'critical' : 'low',
        // ⭐ md5 for an ETag, a cache key or a content fingerprint is FINE.
        // Without a credential word nearby this stays `low` and never reaches
        // the default report.
        confidence: cred ? 'high' : 'low',
        confidenceWhy: cred
          ? 'a password/credential word appears within one line of this hash call'
          : 'md5/sha1 is perfectly fine for a cache key, an ETag or a content fingerprint — reported only in case this one is hashing a credential',
        why: 'md5 and sha1 are built to be fast, which is the opposite of what a password hash needs. Commodity hardware tries billions of candidates a second, so a stolen table of md5 password hashes is a table of passwords.',
        fix: 'use a slow, salted password hash: bcrypt (`bcrypt.hash(pw, 12)`), scrypt (`crypto.scrypt`) or argon2. For non-password hashing, md5 is fine and this finding does not apply.',
      });
    }

    // A JWT signed or verified with a literal secret.
    const jwt = /\bjwt\s*\.\s*(sign|verify)\s*\(/.exec(line);
    if (jwt) {
      const args = readCall(ctx.code, i, line.indexOf('(', jwt.index));
      const parts = splitTopLevel(args);
      const secretArg = (parts[1] ?? '').trim();
      if (secretArg && /^['"`]/.test(secretArg) && isLiteralOnly(secretArg)) {
        add(ctx, out, {
          line: n, column: jwt.index + 1,
          rule: 'hardcoded-jwt-secret', category: 'auth',
          severity: 'critical', confidence: 'high',
          confidenceWhy: 'the signing key argument is a string literal in the source',
          why: 'the signing key is the only thing that makes a token unforgeable. Anyone who reads this file — or the published bundle, or the git history — can mint a token for any user, including an admin.',
          fix: 'read it from the environment (`process.env.JWT_SECRET`), refuse to start if it is missing, and use at least 32 random bytes. Rotating it logs everyone out, which is the correct price for a leaked key.',
        });
      }
    }

    // jwt.decode does not verify. It is legitimate on an already-verified
    // token, so this is a MEDIUM prompt, not an accusation.
    const dec = /\bjwt\s*\.\s*decode\s*\(/.exec(line);
    if (dec) {
      add(ctx, out, {
        line: n, column: dec.index + 1,
        rule: 'jwt-decode-without-verify', category: 'auth',
        severity: 'high', confidence: 'medium',
        confidenceWhy: 'decoding is correct if this token was already verified elsewhere — this file does not show that, so it is worth one look',
        why: '`jwt.decode` only base64-decodes the token; it checks NO signature. If an authorisation decision is made from its output, anyone can hand-craft a token claiming `role: "admin"`.',
        fix: 'use `jwt.verify(token, secret, { algorithms: ["HS256"] })` anywhere the claims are trusted. Keep `decode` only for inspecting a token you have already verified.',
      });
    }

    // Signature verification explicitly turned off.
    /**
     * ⚠️ `verify = False` IS PYTHON-CASED ON PURPOSE. An earlier version also
     * matched `verify: false` / `verify = false`, which is an ordinary
     * JavaScript feature flag (`const verify = false`) and has nothing to do
     * with TLS. Capital-F `False` only exists in python, where `verify=False`
     * on a `requests` call means exactly one thing.
     */
    const off = /(algorithms\s*:\s*\[\s*['"]none['"])|(\bverify\s*=\s*False\b)|(rejectUnauthorized\s*:\s*false)|(NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0)|(InsecureSkipVerify\s*:\s*true)/.exec(line);
    if (off) {
      add(ctx, out, {
        line: n, column: off.index + 1,
        rule: 'verification-disabled', category: 'auth',
        severity: 'critical', confidence: 'high',
        confidenceWhy: 'the switch that performs the check is explicitly set to off on this line',
        why: 'this turns off the check that makes the channel or the token trustworthy. With TLS verification off, anyone on the network path can present their own certificate and read and rewrite the traffic; with `alg: none` accepted, any token validates.',
        fix: 'remove the flag. If a self-signed certificate is the reason, add that certificate to the trust store (`NODE_EXTRA_CA_CERTS`) instead of disabling verification for every connection the process makes.',
      });
    }
  }
}

/** Split a call's argument text on top-level commas only. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (`'"\``.includes(ch)) { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// ── footguns ────────────────────────────────────────────────────────────────

/** A comment that says the silence is on purpose. The author gets the benefit. */
const DELIBERATE = /\b(ignore|ignored|intentional|deliberate|on purpose|best[- ]effort|no[- ]?op|noop|not important|don't care|dont care|fine|expected)\b/i;

function ruleFootguns(ctx, out) {
  for (let i = 0; i < ctx.code.length; i++) {
    const line = ctx.code[i];
    const n = i + 1;
    if (!line.trim()) continue;

    // ── an empty catch ─────────────────────────────────────────────────────
    const cat = /\bcatch\s*(\([^)]*\))?\s*\{/.exec(line);
    if (cat) {
      const open = line.indexOf('{', cat.index);
      const { body, endLine } = readBlock(ctx.code, i, open, 12);
      if (!body.trim()) {
        // Comments were blanked out of `code`, so an "empty" body may still
        // carry an explanation in `raw`. Read it before accusing anyone.
        const rawBody = ctx.raw.slice(i, endLine + 1).join(' ');
        if (!DELIBERATE.test(rawBody)) {
          add(ctx, out, {
            line: n, column: cat.index + 1,
            rule: 'swallowed-error', category: 'footgun',
            severity: 'medium', confidence: 'high',
            confidenceWhy: 'the catch block contains no statements at all, and no comment says the silence is deliberate',
            why: 'the failure is discarded. The function returns as if it worked, the caller carries on with missing data, and the first symptom is wrong output somewhere else with no trace of the real cause. This is the single most common reason a generated app "runs" while doing nothing.',
            fix: 'at minimum log it with context (`console.error("saving profile failed", err)`); better, rethrow or return a failure the caller must handle. If ignoring it really is correct, say so in a comment — this reviewer reads it and stays quiet.',
          });
        }
      }
    }

    // .catch(() => {})
    const pcat = /\.catch\s*\(\s*(?:\([^)]*\)|[\w$]+)?\s*=>\s*\{\s*\}\s*\)/.exec(line);
    if (pcat && !DELIBERATE.test(ctx.raw[i] ?? '')) {
      add(ctx, out, {
        line: n, column: pcat.index + 1,
        rule: 'swallowed-error', category: 'footgun',
        severity: 'medium', confidence: 'high',
        confidenceWhy: 'the rejection handler has an empty body and no comment explains it',
        why: 'the promise rejection is discarded, so a failed request or write looks exactly like a successful one.',
        fix: 'log or handle it: `.catch((err) => console.error("upload failed", err))`, or let it reject and handle it where the outcome matters.',
      });
    }

    // except …: pass
    if (ctx.lang.id === 'py' && /^\s*except\b.*:\s*$/.test(line)) {
      let j = i + 1;
      while (j < ctx.code.length && !ctx.code[j].trim()) j++;
      if (j < ctx.code.length && /^\s*pass\s*$/.test(ctx.code[j])) {
        const rawBody = ctx.raw.slice(i, j + 1).join(' ');
        if (!DELIBERATE.test(rawBody)) {
          add(ctx, out, {
            line: n, column: (line.length - line.trimStart().length) + 1,
            rule: 'swallowed-error', category: 'footgun',
            severity: 'medium', confidence: 'high',
            confidenceWhy: 'the except body is exactly `pass` and no comment explains it',
            why: 'the exception is discarded, so the caller cannot tell a failure from a success.',
            fix: 'log it (`logging.exception("…")`), narrow the except to the one error you expect, or re-raise. If it is deliberate, say so in a comment.',
          });
        }
      }
    }

    // ── an unbounded loop whose size comes from the request ────────────────
    const forBound = /for\s*\([^;]*;\s*[\w$]+\s*<\s*([^;)]+)[;)]/.exec(line);
    if (forBound && ctx.isTainted(forBound[1])) {
      add(ctx, out, {
        line: n, column: forBound.index + 1,
        rule: 'unbounded-input-loop', category: 'footgun',
        severity: 'high', confidence: 'high',
        confidenceWhy: `the loop bound \`${forBound[1].trim()}\` traces back to request input in this file`,
        why: 'the caller chooses how many iterations this process performs. One request with a large number pins a CPU and stops the server answering anyone — a denial of service that needs no tooling to exploit.',
        fix: 'clamp it before looping: `const n = Math.min(Number(req.query.n) || 0, 100);`, and reject anything larger with a 400 rather than silently truncating.',
      });
    }
    const sizer = /\b(new\s+Array|Array|Buffer\.alloc|\.repeat)\s*\(\s*([^),]+)/.exec(line);
    if (sizer && ctx.isTainted(sizer[2])) {
      add(ctx, out, {
        line: n, column: sizer.index + 1,
        rule: 'unbounded-input-loop', category: 'footgun',
        severity: 'high', confidence: 'high',
        confidenceWhy: `the allocation size \`${sizer[2].trim()}\` traces back to request input in this file`,
        why: 'the caller chooses how much memory this allocates. A single request asking for a huge size exhausts the heap and takes the process down.',
        fix: 'clamp the value against a maximum before allocating, and reject anything above it with a 400.',
      });
    }

    // ── an open redirect ───────────────────────────────────────────────────
    const red = /\b(res|response)\s*\.\s*redirect\s*\(|\b(window\.)?location\s*\.\s*(href|assign|replace)\s*[=(]|\bwindow\.location\s*=/.exec(line);
    if (red) {
      // `res.redirect(302, url)` — drop a leading status code so the target is
      // what gets taint-checked, not the number in front of it.
      const target = line.slice(red.index + red[0].length).replace(/^\s*\d+\s*,\s*/, '');
      if (ctx.isTainted(target) && !/startsWith\s*\(|allow|whitelist|allowlist|new URL\s*\(/i.test(line)) {
        add(ctx, out, {
          line: n, column: red.index + 1,
          rule: 'unvalidated-redirect', category: 'footgun',
          severity: 'medium', confidence: 'high',
          confidenceWhy: 'the redirect target traces back to request input in this file and no allow-list check appears on this line',
          why: 'the caller picks where your site sends the visitor. `?next=https://evil.example/login` produces a phishing page the victim reached by clicking YOUR domain, which is exactly what makes it work.',
          fix: 'only accept paths on your own site — reject anything not starting with a single `/` (`if (!/^\\/[^/]/.test(next)) next = "/";`) — or map an opaque key to a fixed table of destinations.',
        });
      }
    }

    // ── path traversal ─────────────────────────────────────────────────────
    const fsCall = /\b(readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|sendFile|unlink|unlinkSync|readdir|readdirSync|open)\s*\(|\bpath\s*\.\s*(join|resolve)\s*\(/.exec(line);
    if (fsCall) {
      const args = readCall(ctx.code, i, line.indexOf('(', fsCall.index));
      const guarded = /basename\s*\(|startsWith\s*\(|allow|whitelist|allowlist|normalize\s*\(/i.test(
        [ctx.code[i - 2] ?? '', ctx.code[i - 1] ?? '', line, ctx.code[i + 1] ?? ''].join(' '),
      );
      if (ctx.isTainted(args)) {
        add(ctx, out, {
          line: n, column: fsCall.index + 1,
          rule: 'path-traversal', category: 'footgun',
          severity: 'high',
          confidence: guarded ? 'low' : 'high',
          confidenceWhy: guarded
            ? 'a path is built from request input, but a basename/normalize/allow-list check appears nearby — check that it actually covers this call'
            : 'the path is built from request input and no basename, normalize-and-compare, or allow-list check appears within two lines',
          why: 'the caller chooses which file is opened. `../../../../etc/passwd` — or `..%2f..%2f` after URL-decoding — walks out of the directory you meant, and on a server that serves user files it reads your .env.',
          fix: 'strip the directory part (`path.basename(name)`) when only a filename is meant. When subdirectories are legitimate, resolve then verify containment: `const full = path.resolve(ROOT, rel); if (!full.startsWith(ROOT + path.sep)) throw new Error("outside root");`.',
        });
      }
    }
  }
}

// ── the report side ─────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ SAY WHAT WE DID NOT DO. Printed with every non-empty summary so nobody
 * reads "3 findings" as "and there are exactly 3 problems".
 */
export const REVIEW_CAVEAT = 'Pattern review only — one file at a time, no types, no cross-file view. It cannot see a sanitizer or a taint that lives in another module, so a short list is not a clean bill of health.';

/**
 * Review everything a run wrote. The lead calls this after the work, with a
 * reader closed over the workspace.
 *
 * ⚠️ IT NEVER THROWS AND IT NEVER READS ANYTHING BY ITSELF. `read` is a
 * parameter with a refusing default, which is what lets every branch below be
 * tested with no filesystem at all.
 *
 * @param {string[]} paths workspace-relative paths that were written
 * @param {{read?: (p:string)=>string, minConfidence?: string, maxFiles?: number}} [opts]
 */
export function reviewWrittenFiles(paths, opts = {}) {
  const read = opts.read ?? (() => { throw new Error('no reader was supplied to reviewWrittenFiles — pass { read } so it can load the files it is asked to review'); });
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxFiles = opts.maxFiles ?? 60;

  const findings = [];
  const reviewed = [];
  const skipped = [];

  for (const p of (paths ?? []).slice(0, maxFiles)) {
    if (typeof p !== 'string' || !p.trim()) continue;
    let text;
    try {
      text = read(p);
    } catch (err) {
      // A file deleted by a later step, or a binary, is not a review failure.
      skipped.push({ path: p, reason: `could not read it: ${err && err.message}` });
      continue;
    }
    if (typeof text !== 'string') { skipped.push({ path: p, reason: 'not text' }); continue; }
    reviewed.push(p);
    for (const f of reviewCode(p, text, { minConfidence })) findings.push(f);
  }

  findings.sort((a, b) =>
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    || (CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])
    || a.path.localeCompare(b.path)
    || (a.line - b.line));

  return { findings, reviewed, skipped };
}

/**
 * Render the findings for the end-of-run report.
 *
 * ⚠️⚠️ RETURNS `[]` WHEN THERE IS NOTHING TO SAY. It must never print an
 * all-clear. A regex layer that says "no vulnerabilities found" is making a
 * claim it cannot support, and a user who reads it once will trust it forever.
 * Silence is the honest output of a reviewer that found nothing.
 *
 * @param {{findings:any[]}|any[]} result output of `reviewWrittenFiles`, or a bare findings array
 * @param {{paint?: any, max?: number}} [opts]
 * @returns {string[]} lines
 */
export function formatReviewSummary(result, opts = {}) {
  const findings = Array.isArray(result) ? result : (result?.findings ?? []);
  if (findings.length === 0) return [];
  const p = opts.paint ?? { red: (t) => t, gold: (t) => t, dim: (t) => t };
  const max = opts.max ?? 8;

  const worst = findings.filter((f) => f.severity === 'critical').length;
  const head = worst > 0
    ? p.red(`⚠ code review — ${findings.length} finding${findings.length === 1 ? '' : 's'} in the code just written, ${worst} critical`)
    : p.gold(`⚠ code review — ${findings.length} finding${findings.length === 1 ? '' : 's'} in the code just written`);

  const lines = [head];
  for (const f of findings.slice(0, max)) {
    lines.push(`  ${f.path}:${f.line}  ${f.rule} (${f.severity}, ${f.confidence} confidence)`);
    lines.push(p.dim(`    why: ${f.why}`));
    lines.push(p.dim(`    fix: ${f.fix}`));
    lines.push(p.dim(`    confidence: ${f.confidenceWhy}`));
  }
  if (findings.length > max) lines.push(p.dim(`  … and ${findings.length - max} more — run \`review_code\` on the file for the full list`));
  lines.push(p.dim(`  ${REVIEW_CAVEAT}`));
  return lines;
}

/** The same summary as a machine-readable object, for `--json`. */
export function reviewToJson(result) {
  const findings = Array.isArray(result) ? result : (result?.findings ?? []);
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return {
    findings,
    counts,
    reviewed: Array.isArray(result) ? undefined : result?.reviewed,
    caveat: REVIEW_CAVEAT,
  };
}

// ── the tool ────────────────────────────────────────────────────────────────

export function codeReviewToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'review_code',
        description: [
          'Review a source file you wrote for security defects before telling the user it is done.',
          'Covers injection (SQL built by concatenation, shell strings, eval of a computed value), secrets committed in source,',
          'web issues (dangerouslySetInnerHTML, innerHTML, unescaped output, CORS wildcard with credentials, cookies missing httpOnly/secure/sameSite),',
          'auth and crypto (Math.random for tokens, md5/sha1 for passwords, hardcoded JWT secrets, verification switched off),',
          'and footguns (swallowed errors, loops sized by request input, unvalidated redirects, path traversal).',
          'Every finding names the line, why it is dangerous, the concrete fix, and a confidence with the reason for it —',
          'a `low` confidence finding is a prompt to look, not a defect.',
          'It is a pattern layer over ONE file: it has no types and no cross-file view, so a clean result is NOT a guarantee of safety.',
          'Fix anything critical or high before reporting the work as finished.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Workspace-relative path of the file to review. The extension selects the language; the path alone also decides whether this is a credential file that must never be committed.',
            },
            content: {
              type: 'string',
              description: 'The source text. Optional — omit it to review the file as it is on disk. Pass it to review code you have not written yet.',
            },
            minConfidence: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Lowest confidence to report. Default "medium". Use "low" for a pre-release sweep — it includes guesses that are often correct behaviour.',
            },
          },
          required: ['path'],
        },
      },
    },
  ];
}

/**
 * Execute `review_code`.
 *
 * @param {{path:string, content?:string, minConfidence?:string}} args
 * @param {{read?: (p:string)=>string}} [deps] `read` is injected so this
 *        function is testable with no filesystem; the lead closes it over
 *        `resolveInWorkspace`.
 */
export function executeReviewCode(args = {}, deps = {}) {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) {
    return { error: 'review_code needs a `path` — pass the workspace-relative path of the file to review.' };
  }

  let content = typeof args.content === 'string' ? args.content : null;
  if (content === null) {
    if (typeof deps.read !== 'function') {
      // ⭐ EVERY REFUSAL NAMES THE WAY OUT.
      return { error: `review_code could not read ${path} and no content was supplied — pass \`content\` with the source text, or write the file first so it can be read from the workspace.` };
    }
    try {
      content = deps.read(path);
    } catch (err) {
      return { error: `review_code could not read ${path}: ${err && err.message}. Pass \`content\` with the source text instead, or check the path is relative to the workspace root.` };
    }
  }
  if (typeof content !== 'string') {
    return { error: `review_code got no text for ${path} — pass \`content\` with the source, or point at a text file.` };
  }

  const findings = reviewCode(path, content, { minConfidence: args.minConfidence ?? DEFAULT_MIN_CONFIDENCE });
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  return {
    path,
    findings,
    counts,
    /**
     * ⚠️ THE ZERO CASE IS WORDED CAREFULLY. "No findings" is a statement about
     * this reviewer, not about the file. It must not read as an all-clear,
     * because the model will quote it to the user as one.
     */
    summary: findings.length === 0
      ? `No findings at ${args.minConfidence ?? DEFAULT_MIN_CONFIDENCE} confidence or above in ${path}. That means these patterns did not match — it is not a guarantee the file is safe.`
      : `${findings.length} finding${findings.length === 1 ? '' : 's'} in ${path}: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Fix critical and high before calling this done.`,
    caveat: REVIEW_CAVEAT,
  };
}
