/**
 * ── ⭐ SEARCH — THE DIFFERENCE BETWEEN WRITING FILES AND WORKING IN A REPO ───
 *
 * Until now Acuvo Code could only touch files it was HANDED: the deterministic
 * gather reads the tree and a few small files, and everything else is invisible.
 * That is fine for "create src/thing.js" and useless for "rename this function
 * everywhere" or "why does the login page 404". Asked to change something it
 * cannot find, the model does the only thing left to it — invents a plausible
 * file and writes over the wrong one.
 *
 * ⭐ So this is the highest-value tool the CLI was missing, and it is the one
 * every real coding agent leans on hardest. Two verbs, deliberately:
 *   · `find_files` — locate by NAME  (glob)
 *   · `search_text` — locate by CONTENT (regex, with line numbers)
 *
 * ── ⚠️ WHY IT IS IMPLEMENTED IN NODE AND NOT BY SHELLING TO ripgrep ─────────
 * `command.mjs` exists to keep a shell away from model-authored strings, and its
 * allowlist deliberately excludes every binary but four. Adding `rg` would mean
 * either a new binary in that list (with a pattern argument the model controls —
 * the exact shape the allowlist refuses) or `shell: true`, which hands a shell
 * the string the module exists to keep from one. A directory walk in Node costs
 * a few hundred lines and gives up nothing that matters at repo scale.
 *
 * ── ⚠️⚠️ AND THE THING THIS MODULE GOT WRONG FOR ITS FIRST LIFE ────────────
 * A search tool's output is not a list, it is a CLAIM: "I looked, and here is
 * what is there". `searchText` used to make that claim while quietly declining
 * to open files — too big, NUL byte, unreadable — and returning
 * `{ matches: [], truncated: false, scanned: N }`, three fields that together
 * say "everything was looked at and the string is not there". The model then
 * stops looking, which is the whole cost: a wrong answer it has no reason to
 * doubt. The rule the module already applied to truncation ("a model told the
 * first will stop looking") applies identically to skips, so every file the
 * walk reached and did not read now comes back named, with a reason.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * ⭐ IMPORTED, NEVER RE-IMPLEMENTED. `git.mjs` already owns the one list of
 * "files that must never leave this machine"; `turn.mjs` reuses it for the same
 * reason. A second copy here would be the copy that goes stale the day someone
 * adds a filename to the first one.
 */
import { refusedCommitPath } from './secret-paths.mjs';
import { rankMatches } from './search-rank.mjs';

/**
 * ⚠️ NEVER DESCENDED. Walking `node_modules` on a real project is tens of
 * thousands of files and would blow both the time budget and the model's
 * context with matches from other people's code. `.git` is worse than useless —
 * it is binary objects that happen to contain fragments of your source.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.vercel', 'coverage', '.turbo']);

/**
 * ── ⭐ HIDDEN DIRECTORIES THAT ARE ORDINARY SOURCE ───────────────────────────
 *
 * DIRECTORIES ONLY, and deliberately short. Every entry here is a place teams
 * keep code they routinely ask an agent to change — CI workflows above all —
 * and none of them is a conventional home for a credential. `.env` is a FILE,
 * so nothing in this set can expose it; the hidden-file rule is untouched.
 *
 * ⚠️ THE BAR FOR ADDING ONE: it must be a directory whose contents a stranger
 * would expect to appear in a code search, and which no common tool uses to
 * store secrets. `.aws`, `.ssh`, `.docker` and `.gnupg` fail that test and must
 * never appear here.
 */
const HIDDEN_DIRS_ALLOWED = new Set(['.github', '.vscode', '.husky', '.circleci', '.changeset', '.storybook']);

/**
 * ── ⭐⭐ THE AGENT COULD NOT FIND ITS OWN WORK ────────────────────────────────
 *
 * `.acuvo/` is where THIS package writes the plan, the board, the checkpoint
 * journal, the policy, the acceptance record and the audit log. All of it is
 * hidden, so all of it was invisible to `find_files` and `search_text` — an
 * agent resuming a job could not answer "what did I already do?" about files it
 * had written itself, and got the `matches: [] / skippedCount: 0` triple this
 * module documents as meaning NOT THERE.
 *
 * ⚠️ IT IS DELIBERATELY NOT IN `HIDDEN_DIRS_ALLOWED` ABOVE. That set's stated
 * bar is "no common tool uses it to store secrets", and `.acuvo` FAILS it —
 * `credentials.json` lives in a directory of exactly this name. Folding it in
 * would quietly widen a set whose comment promises the opposite.
 *
 * ⭐ WHAT KEEPS IT SAFE IS NOT THIS LINE. `searchText` already refuses the
 * CONTENTS of anything `refusedCommitPath` names, and that pattern list matches
 * `credentials.json` wherever it sits. The containment is at the FILE level,
 * which is the level that survives someone running the agent with the workspace
 * set to their home directory. The test that matters asserts the token never
 * comes back, not that this constant has a particular value.
 */
const ACUVO_DIR = '.acuvo';

/**
 * ⚠️ SESSIONS ARE THE AGENT'S OWN TRANSCRIPT, AND SEARCHING THEM IS AN ECHO.
 * A session file is every word the model wrote, so a search for a symbol finds
 * the agent's own earlier SPECULATION about that symbol alongside the source —
 * indistinguishable in a result list, and the older guess reads as evidence.
 * One session measured here is 43KB of prose. `acuvo --sessions` lists them
 * properly; this walk stays out.
 */
const ACUVO_SUBDIRS_SKIPPED = new Set(['sessions']);

/** Files we will never read as text. Reading them yields replacement chars. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp4|mov|mp3|wav|woff2?|ttf|eot|so|dll|exe|node)$/i;

/**
 * Bounds. Every one of these exists because the failure it prevents is silent:
 * a search that walks forever looks like a hung terminal, and one that returns
 * 4,000 matches costs more in context than the answer is worth.
 */
export const MAX_FILES_SCANNED = 4_000;
export const MAX_MATCHES = 60;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_LINE_CHARS = 200;
/**
 * ── ⭐ HOW FAR PAST THE CURRENT PAGE WE KEEP COUNTING ───────────────────────
 *
 * `total` is the field that turns "truncated" from a dead end into a decision:
 * 61 hits and 6,000 hits are the same word today, and they call for opposite
 * next moves. Counting is far cheaper than RETURNING — a counted match costs an
 * integer, a returned one costs a line of context — so we keep counting after
 * the page is full.
 *
 * ⚠️ BUT NOT FOREVER. `searchText` has to READ a file to count matches in it,
 * and the old code's early break is what made a search for a common token
 * finish after three files. So counting stops this far past the requested page,
 * and when it does the reply says `countCapped: true` and `totalExact: false`
 * rather than passing a floor off as a census.
 */
export const MAX_COUNTED = 1_000;
/**
 * How many skipped paths are NAMED in a reply. The count is always exact; this
 * caps only the list, because a repo with 400 images must not spend the model's
 * whole context enumerating them.
 */
export const MAX_SKIPPED_LISTED = 20;

/** Depth-first walk, honouring the skip list and the file cap. */
function* walk(root, dir, budget, inAcuvo = false) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // an unreadable directory is skipped, never fatal
  }
  // Sorted so two runs over an unchanged tree return the same order — a search
  // whose results shuffle makes a diff between runs unreadable.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (budget.scanned >= MAX_FILES_SCANNED) return;
    if (e.name.startsWith('.') && e.name !== '.env.example') {
      /**
       * ── ⚠️ HIDDEN ENTRIES: REFUSE THE CREDENTIALS, NOT THE SOURCE ──────────
       *
       * The original rule skipped EVERY dotted entry and recorded nothing. Its
       * reason is right and stays: a search that surfaces `.env` into a model's
       * context is an exfiltration channel with good intentions, and hidden
       * FILES are overwhelmingly config and credentials.
       *
       * ⚠️ BUT IT ALSO MADE ORDINARY SOURCE UNREACHABLE AND SAID NOTHING.
       * `.github/workflows`, `.vscode`, `.husky` and `.circleci` are code people
       * ask an agent to change constantly — "fix the CI workflow" is a top task
       * — and the reply was the exact `matches: [] / truncated: false /
       * skippedCount: 0` triple this module documents as meaning "not there".
       * Being unable to see a file is survivable. Reporting it as ABSENT is not,
       * because the model stops looking and then invents.
       *
       * ⭐ So: walk a small allowlist of hidden directories that are plainly
       * source, skip everything else hidden as before, and RECORD every skip so
       * the caller can name it. Hidden FILES are still never walked — the
       * allowlist is directories only, so `.env` is untouched by this.
       */
      if (e.isDirectory() && HIDDEN_DIRS_ALLOWED.has(e.name)) {
        yield* walk(root, join(dir, e.name), budget);
        continue;
      }
      if (e.isDirectory() && e.name === ACUVO_DIR) {
        yield* walk(root, join(dir, e.name), budget, true);
        continue;
      }
      if (budget.hiddenSkipped && budget.hiddenSkipped.length < MAX_SKIPPED_LISTED) {
        budget.hiddenSkipped.push({
          path: relative(root, join(dir, e.name)).split(sep).join('/'),
          reason: e.isDirectory() ? 'hidden directory, not searched' : 'hidden file, not read',
        });
      }
      budget.hiddenSkippedCount = (budget.hiddenSkippedCount ?? 0) + 1;
      continue;
    }
    if (e.isDirectory()) {
      if (inAcuvo && ACUVO_SUBDIRS_SKIPPED.has(e.name)) {
        if (budget.hiddenSkipped && budget.hiddenSkipped.length < MAX_SKIPPED_LISTED) {
          budget.hiddenSkipped.push({
            path: relative(root, join(dir, e.name)).split(sep).join('/'),
            reason: 'the agent\'s own session transcripts — list them with `acuvo --sessions`',
          });
        }
        budget.hiddenSkippedCount = (budget.hiddenSkippedCount ?? 0) + 1;
        continue;
      }
      if (SKIP_DIRS.has(e.name)) {
        if (budget.hiddenSkipped && budget.hiddenSkipped.length < MAX_SKIPPED_LISTED) {
          budget.hiddenSkipped.push({
            path: relative(root, join(dir, e.name)).split(sep).join('/'),
            reason: 'skipped directory (build output or dependencies)',
          });
        }
        budget.hiddenSkippedCount = (budget.hiddenSkippedCount ?? 0) + 1;
        continue;
      }
      yield* walk(root, join(dir, e.name), budget);
    } else if (e.isFile()) {
      budget.scanned += 1;
      yield join(dir, e.name);
    }
  }
}

/**
 * Placeholders used while expanding a glob. They stand in for an expansion that
 * itself contains glob characters, so the later passes cannot chew up the regex
 * an earlier pass just wrote. Control characters because a path may not contain
 * one, so no real pattern can collide with them.
 */
const TOK_STARSTAR = '\x00';      // `**` not followed by a slash
const TOK_GLOBSTAR_SEG = '\x01';  // `**/` — a whole directory span, possibly empty

/**
 * A tiny glob: `*` (not across `/`), `**` (across `/`), `?`. Anchored whole.
 *
 * ⚠️ BUILT RATHER THAN REGEX-FROM-USER-INPUT. Handing a model's string straight
 * to `new RegExp` is a catastrophic-backtracking DoS in one call — `(a+)+$` on a
 * long path hangs the process. Escaping everything and expanding only the three
 * glob tokens means the pattern can only ever describe a path shape.
 *
 * ── ⚠️ `**` + `/` MATCHES ZERO DIRECTORIES, AND USED NOT TO ────────────────
 * `**` became `.*` and the `/` after it stayed a literal, so the pattern
 * `**` `/` `*.json` compiled to `^.*\/[^/]*\.json$` — with a MANDATORY slash.
 * Effect: it found `src/a.json` and missed `package.json`, which means the
 * BROADER pattern returned strictly FEWER files than the narrower `*.json`.
 * That is the opposite of what a glob promises, and it fails silently: the
 * model asks for "every json in the repo", gets a list with the root one
 * absent, and concludes the file does not exist. Bash globstar, minimatch and
 * ripgrep all read a `**` segment as ZERO or more directories, so the honest
 * expansion is `(?:.*\/)?` and never `.*\/`.
 *
 * ⚠️ It has to go behind its own placeholder because the replacement contains
 * both `?` and `*`; written any earlier, the two token passes below would
 * rewrite it into nonsense.
 */
export function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, TOK_GLOBSTAR_SEG)  // a directory span, zero or more deep
    .replace(/\*\*/g, TOK_STARSTAR)        // placeholder so * does not eat it
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(new RegExp(TOK_STARSTAR, 'g'), '.*')
    .replace(new RegExp(TOK_GLOBSTAR_SEG, 'g'), '(?:.*/)?');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * ── ⚠️ AN OFFSET IS EITHER A WHOLE COUNT OR A MISTAKE ───────────────────────
 *
 * Coercing `-1` or `"later"` to 0 would hand back page one while the model
 * believes it is reading page two — a silent wrong answer of exactly the class
 * this module exists to stop, and one the model cannot detect. A refusal it can
 * read is strictly better.
 *
 * ⚠️ The shapes a real tool-call carries are still accepted: absent, `0`, and a
 * NUMERIC STRING, because JSON emitted by a model routinely types numbers as
 * strings and refusing that would fail correct work.
 */
function normaliseOffset(offset, tool) {
  if (offset === undefined || offset === null || offset === '') return { ok: true, value: 0 };
  const n = typeof offset === 'number' ? offset : Number(String(offset).trim());
  if (!Number.isInteger(n) || n < 0) {
    return {
      ok: false,
      error: `${tool}: offset must be a whole number ≥ 0 — the number of results already seen, e.g. ${MAX_MATCHES} for the second page. Got ${JSON.stringify(offset)}.`,
    };
  }
  return { ok: true, value: n };
}

/**
 * Locate files by name. Returns repo-relative POSIX paths.
 *
 * ⭐ `offset` is how many matches to SKIP, so a model told `truncated: true` has
 * somewhere to go. The walk is not repeated to find page two — it never was
 * capable of stopping early in a way that mattered here, because matching a
 * NAME costs a regex test, not a file read. So the whole tree is matched once,
 * every hit is counted into `total`, and only the requested window is recorded.
 */
export function findFiles(root, pattern, { offset = 0 } = {}) {
  if (!pattern || typeof pattern !== 'string') return { ok: false, error: 'a glob pattern is required' };
  const off = normaliseOffset(offset, 'find_files');
  if (!off.ok) return off;
  const start = off.value;
  let rx;
  try {
    rx = globToRegExp(pattern);
  } catch {
    return { ok: false, error: `not a usable pattern: ${pattern}` };
  }
  const budget = { scanned: 0, hiddenSkipped: [], hiddenSkippedCount: 0 };
  const hits = [];
  let total = 0;
  for (const abs of walk(root, root, budget)) {
    const rel = relative(root, abs).split(sep).join('/');
    if (!rx.test(rel) && !rx.test(rel.split('/').pop())) continue;
    total += 1;
    // Counted always; recorded only inside the requested window. The old code
    // broke out of the walk here, which is why it could say "there are more"
    // and never say how many, nor let anyone ask for them.
    if (total > start && hits.length < MAX_MATCHES) hits.push(rel);
  }
  const scanCapped = budget.scanned >= MAX_FILES_SCANNED;
  const unseen = start + hits.length < total;
  return {
    ok: true,
    pattern,
    files: hits,
    /** How many matches were skipped to build this page. Echoed so a caller that
     *  asked for page two and got page one can SEE that its offset was dropped. */
    offset: start,
    /** Every match the walk found, not just the ones returned. */
    total,
    /**
     * ⚠️ `total` IS A FLOOR, NOT A CENSUS, WHEN THE WALK WAS CAPPED. Saying
     * "47 files" about a tree we only walked a third of is the same lie as
     * `truncated: false`, wearing a number.
     */
    totalExact: !scanCapped,
    /** Where to resume. `null` means there is nothing after this page. */
    nextOffset: unseen ? start + hits.length : null,
    /**
     * ⚠️ TRUNCATION IS REPORTED, NEVER SILENT. "12 files" and "the first 60 of
     * many" are different answers, and a model told the first will stop looking.
     *
     * ⚠️⚠️ THIS COMMENT WAS TRUE AND THE CODE UNDER IT WAS NOT. It read
     * `hits.length >= MAX_MATCHES` — the MATCH cap only — while `walk()` also
     * stops dead at MAX_FILES_SCANNED. A walk cut short after 4,000 of 12,000
     * files, finding 3 matches, answered `truncated: false`: a claim of
     * completeness over a third of the tree, printed directly beneath a comment
     * promising the opposite.
     *
     * ⭐ `searchText` HAD ALREADY FIXED EXACTLY THIS (see its `scanCapped`, and
     * the note above it recording the same bug). Its sibling never got the fix.
     * Both causes mean "there may be more", so both set the flag and
     * `scanCapped` says which.
     *
     * ⭐ NOW EXACT RATHER THAN PESSIMISTIC. `hits.length >= MAX_MATCHES` was a
     * proxy for "there are probably more"; with `total` counted we know. A full
     * page that happens to be the last page honestly says `truncated: false`.
     */
    truncated: unseen || scanCapped,
    scanned: budget.scanned,
    scanCapped,
    // Places the walk declined to enter, so "not found" is never confused with
    // "not looked at". The count is exact even when the list is capped.
    skipped: budget.hiddenSkipped,
    skippedCount: budget.hiddenSkippedCount,
  };
}

/**
 * Search file CONTENT.
 *
 * ⚠️ The pattern is a regex because that is what makes search useful, so it is
 * compiled inside a try and every match is bounded — see MAX_* above. A literal
 * search is available by escaping, which the description tells the model.
 *
 * Returns, on success:
 *   matches       the hits, capped at MAX_MATCHES
 *   truncated     true when there may be more — capped matches OR a capped walk
 *   scanned       files the walk reached
 *   skipped       up to MAX_SKIPPED_LISTED `{ path, reason }` of files NOT read
 *   skippedCount  the exact number not read, even when the list above is capped
 *   withheld      how many of those were withheld as credential files
 */
export function searchText(root, pattern, { glob = null, offset = 0 } = {}) {
  if (!pattern || typeof pattern !== 'string') return { ok: false, error: 'a search pattern is required' };
  const off = normaliseOffset(offset, 'search_text');
  if (!off.ok) return off;
  const start = off.value;
  let rx;
  try {
    rx = new RegExp(pattern, 'i');
  } catch (err) {
    return { ok: false, error: `not a valid regular expression: ${String(err?.message || err)}` };
  }
  const nameFilter = glob ? globToRegExp(glob) : null;
  /**
   * ⭐ The walk records the directories it declined to ENTER, which the
   * per-file `note()` below could never see — it only ever hears about files
   * the walk actually yielded. A directory skipped at the walk level was
   * previously invisible to both, which is how "not searched" came back as
   * "not there".
   */
  const budget = { scanned: 0, hiddenSkipped: [], hiddenSkippedCount: 0 };
  const matches = [];

  /**
   * ⚠️ EVERY `continue` IN THE LOOP BELOW GOES THROUGH HERE. That is the whole
   * fix: the old code had four bare `continue`s, and four bare `continue`s in a
   * function that reports `matches: []` is a function that says "not there"
   * when it means "not opened". If you add a fifth reason to skip a file, it
   * gets a `note()` too — a skip nobody can see is the bug returning.
   */
  const skipped = [];
  let skippedCount = 0;
  let withheld = 0;
  const note = (path, reason) => {
    skippedCount += 1;
    if (skipped.length < MAX_SKIPPED_LISTED) skipped.push({ path, reason });
  };

  /**
   * How far past the requested page we keep counting before admitting the count
   * is a floor. See MAX_COUNTED — counting costs a file read here, which is why
   * this is bounded at all.
   */
  const countLimit = start + MAX_MATCHES + MAX_COUNTED;
  let total = 0;
  let countCapped = false;

  scan:
  for (const abs of walk(root, root, budget)) {
    const rel = relative(root, abs).split(sep).join('/');
    // A caller's own `glob` narrowing is not a skip — they asked for it, and
    // reporting it back as "not looked at" would bury the real skips in noise.
    if (nameFilter && !nameFilter.test(rel) && !nameFilter.test(rel.split('/').pop())) continue;

    /**
     * ── ⚠️⚠️ THE SECOND DOOR INTO THE WORST BUG THIS PACKAGE HAS HAD ────────
     *
     * `turn.mjs:112` documents the first: the deterministic pre-load read every
     * small file in the tree into the prompt, `.env` and `id_rsa` included, and
     * the provider chain then fanned them across up to four upstreams. It was
     * fixed there, and the fix stopped exactly one caller.
     *
     * This tool is the other way in, and a worse one, because the pre-load only
     * reads what happens to be lying around while this reads what the model
     * ASKS for — in round 1, before any plan is reviewed, through the same
     * prompt and the same chain. Verified on a fixture 2026-08-10: searching
     * `CANARY` returned `password: …` from `config/credentials.yml`, the body
     * of `id_rsa`, and `{"aws_secret":"…"}` from `secrets.json`.
     *
     * ⭐ The hidden-file rule in `walk` was never cover for this. It stops
     * `.env`, and stops nothing else: `id_rsa`, `secrets.json`, `server.key`
     * and `config/credentials.yml` are all ordinary visible files.
     *
     * ⭐ WITHHELD, NOT DROPPED. Silently omitting them would be the very lie
     * this function was just fixed for — the model would search for a config
     * key, find nothing, and go write a duplicate. It is told the file exists
     * and that the contents are not coming.
     */
    if (refusedCommitPath(rel)) {
      withheld += 1;
      note(rel, 'credential file — the path is shown, the contents are never returned');
      continue;
    }

    if (BINARY_EXT.test(rel)) { note(rel, 'binary file extension — not read as text'); continue; }

    let stat;
    try { stat = statSync(abs); } catch { note(rel, 'could not be stat-ed — it may have been deleted mid-walk'); continue; }
    if (stat.size > MAX_FILE_BYTES) {
      note(rel, `over ${MAX_FILE_BYTES / 1024}KB — read it directly with read_file if you need this one`);
      continue;
    }

    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { note(rel, 'could not be read — check the file permissions'); continue; }
    // A NUL in the first block means binary regardless of extension — the same
    // heuristic readFile uses, so search and read agree about what is text.
    // ⚠️ UTF-16 source lands here too, so this is not only "real" binaries.
    if (text.includes('\x00')) { note(rel, 'binary (contains a NUL byte) — UTF-16 text looks like this too'); continue; }

    /**
     * ── ⚠️ A UTF-8 BOM DEFEATS A `^` ANCHOR, SILENTLY ──────────────────────
     * `readFileSync(..., 'utf8')` hands back the BOM as a real U+FEFF at index
     * 0, so line 1 of a BOM file is `"﻿import …"` and `/^import/` does not
     * match it. The reply is `matches: []` — the exact triple this module
     * documents as meaning "it is not there" — for a line that plainly is.
     * The BOM is an encoding marker, not content, so it comes off before
     * anything looks at the text, which also keeps it out of the returned line.
     */
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      /**
       * ── ⚠️ CRLF: THE OTHER HALF OF A REAL WINDOWS TREE ────────────────────
       * Splitting on `\n` leaves the `\r` sitting on the end of every line, so
       * `$` can never match anything but the carriage return, and a
       * `$`-anchored search over a CRLF file returns NOTHING. Same silent
       * "it is not there". `\r` is half of the line TERMINATOR, not content.
       */
      const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
      if (!rx.test(line)) continue;

      total += 1;
      if (total > start && matches.length < MAX_MATCHES) {
        /**
         * ── ⭐⭐ THE ONE-LINE FIX THIS FUNCTION EXISTED TO GET WRONG ────────
         *
         * This used to be `lines[i].trim()`, and `trim()` takes the LEADING
         * whitespace off. Search feeds edit: the model builds an `edit_file`
         * old_string out of this exact string, and a left-aligned copy of an
         * indented line CANNOT MATCH the file. It is refused, guesses the
         * indentation, is refused again, and the round budget is gone —
         * `read-window.mjs:34` records the session that died this way, six
         * spaces guessed where `lib/git.mjs:282` has two.
         *
         * ⭐ TRAILING whitespace only. That direction is safe in the way the
         * other is not: the result stays a byte-exact SUBSTRING of the file,
         * which is the only property `edit_file` actually tests.
         */
        const kept = line.trimEnd();
        const clipped = kept.length > MAX_LINE_CHARS;
        const m = { path: rel, line: i + 1, text: kept.slice(0, MAX_LINE_CHARS) };
        /**
         * ⚠️ SAID OUT LOUD when it happens. A clipped line is a PREFIX, so an
         * old_string built from it is refused — and being told why beats
         * guessing. An 8,000-character minified line would otherwise swamp the
         * whole reply with one useless match, so the cap stays.
         */
        if (clipped) m.clipped = true;
        matches.push(m);
      }
      if (total >= countLimit) { countCapped = true; break scan; }
    }
  }

  /**
   * ⚠️ THE WALK CAP IS A TRUNCATION TOO. `walk` stops dead at
   * MAX_FILES_SCANNED, and the old code still answered `truncated: false` — the
   * same claim of completeness, made by a different mechanism. Both causes mean
   * "there may be more", so both set the flag, and `scanCapped` says which.
   */
  const scanCapped = budget.scanned >= MAX_FILES_SCANNED;
  const unseen = start + matches.length < total;

  return {
    ok: true,
    pattern,
    /**
     * ⭐ RANKED, NOT WALK-ORDERED. Matches were pushed in raw filesystem
     * traversal order and capped at MAX_MATCHES, so a model hunting a symbol
     * read whatever the directory walk reached first and the DEFINITION being
     * near the top was luck. `rankMatches` puts definitions and exports above
     * mentions.
     *
     * ⚠️ IT REORDERS THE PAGE AND CHANGES NOTHING ELSE. `total`, `unseen` and
     * `nextOffset` are computed above from the unranked window and are
     * untouched — re-ranking ACROSS pages would require collecting every match
     * before returning any, which breaks the bounded-scan contract that keeps a
     * search on a large repo from reading the whole thing.
     */
    matches: rankMatches(matches, pattern),
    /** Matches skipped to build this page — echoed so a dropped offset is visible. */
    offset: start,
    /** Every match found, not just the ones returned. 61 and 6,000 are different answers. */
    total,
    /** ⚠️ `total` is a FLOOR when the walk or the count was cut short. */
    totalExact: !scanCapped && !countCapped,
    /** Where to resume; `null` when nothing follows this page. */
    nextOffset: unseen || countCapped ? start + matches.length : null,
    countCapped,
    truncated: unseen || countCapped || scanCapped,
    scanned: budget.scanned,
    scanCapped,
    /**
     * ⭐ Two sources, one answer. `skipped` holds files the walk YIELDED and
     * this function then declined to read; `budget.hiddenSkipped` holds
     * directories and hidden files the walk never entered at all. Reporting only
     * the first is what let a whole `.github/` tree vanish behind
     * `skippedCount: 0`. The list is capped for context; the count is exact.
     */
    skipped: [...skipped, ...budget.hiddenSkipped].slice(0, MAX_SKIPPED_LISTED),
    skippedCount: skippedCount + budget.hiddenSkippedCount,
    withheld,
  };
}

export function searchToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'find_files',
        description: [
          'Find files by NAME anywhere in the workspace, using a glob.',
          'Examples: "*.test.ts", "src/**/*.tsx", "package.json".',
          'A `**/` segment matches zero or more directories, so "**/*.json" includes a top-level package.json.',
          'Use this before assuming where something lives — never guess a path.',
          'node_modules, .git, dist and build are never searched.',
          'Your own `.acuvo/` IS searched — the plan, board, checkpoints, policy and audit log are all findable — except `.acuvo/sessions`, which you list with `acuvo --sessions` instead.',
          // ⚠️ A cap the model cannot step past is a dead end, and a cap with no
          // size attached makes 61 files and 6,000 files read identically.
          `Results are capped at ${MAX_MATCHES} per call: \`total\` is how many matched in all, and \`offset\` skips that many to read the next page (use the \`nextOffset\` the reply gives you). \`totalExact: false\` means even \`total\` is a floor.`,
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'A glob, e.g. "src/**/*.ts".' },
            offset: {
              type: 'integer',
              minimum: 0,
              description: `How many matches to skip. Defaults to 0. Pass ${MAX_MATCHES} for the second page, or just use the reply's nextOffset.`,
            },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: [
          'Search file CONTENTS with a regular expression and get back path, line number and the line.',
          'This is how you find where a function is defined, who calls it, or where a string comes from.',
          'Optionally narrow by filename with `glob`. Escape regex characters for a literal search.',
          // ⭐ THE HANDOFF, STATED. The model has to know the string is safe to
          // paste into an edit, or it will "helpfully" re-indent it and fail.
          'Each hit\'s `text` is the line VERBATIM — leading indentation and all, byte-exact except for trailing whitespace — so you can copy it straight into an edit_file old_string. (`clipped: true` means the line was longer than the display cap and the text is only a prefix; read_around it instead.)',
          `Results are capped at ${MAX_MATCHES} per call: \`total\` is how many lines matched in all, and \`offset\` skips that many to read the next page (use the \`nextOffset\` the reply gives you). \`totalExact: false\` means even \`total\` is a floor.`,
          // ⚠️ SAID OUT LOUD, because a field the model is not told about is a
          // field it does not read, and then the honest reply is as misleading
          // as the dishonest one was.
          'An empty `matches` means NOT FOUND only if `skippedCount` is 0: `skipped` lists files that could not be read (too large, binary) and `withheld` counts credential files whose contents are never returned. If what you want may be in one of those, open it with read_file instead.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'A JavaScript regular expression, case-insensitive. `^` and `$` anchor to the line, and work on CRLF files and files with a UTF-8 BOM.',
            },
            glob: { type: 'string', description: 'Optional filename filter, e.g. "*.ts".' },
            offset: {
              type: 'integer',
              minimum: 0,
              description: `How many matches to skip. Defaults to 0. Pass ${MAX_MATCHES} for the second page, or just use the reply's nextOffset.`,
            },
          },
          required: ['pattern'],
        },
      },
    },
  ];
}
