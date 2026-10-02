/**
 * THE LOCAL FILESYSTEM EXECUTOR — the boundary that makes a terminal coding
 * agent safe to run.
 *
 * ── WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE PACKAGE ──────────────────
 * Every other tool in this repo hands model output to a browser iframe or a
 * cloud sandbox, where the blast radius of a bad path is a broken preview. Here
 * the model's string becomes a real `writeFileSync` on Roman's laptop. A single
 * accepted `../../.ssh/authorized_keys` is not a rendering bug, it is a
 * compromise — and the string is chosen by a language model, which is to say by
 * something with no notion of what is outside the project.
 *
 * ── THE RULE WAS INHERITED, AND THE INHERITANCE WAS WRONG ───────────────────
 * `console/lib/generated-files.ts:safeFilePath` settled the argument for
 * generated projects, and this file copied its answer verbatim:
 *
 *   WHITELIST the characters a segment may contain (`^[A-Za-z0-9._-]+$`), never
 *   blacklist the traversal spellings.
 *
 * ⚠️ THAT RULE IS CORRECT FOR A ZIP OF WEB ASSETS AND WRONG FOR A CODEBASE, and
 * this file spent its first months being wrong. `safeFilePath`'s whole universe
 * is `index.html` and `js/app.js`. A real repository contains
 * `app/[tenantSlug]/page.tsx`, `app/(dashboard)/layout.tsx`, `src/[...slug]/`,
 * `@modal/`, `My Component.tsx` and `café.js`. Measured on `console/` on
 * 2026-08-10: **565 of 2,077 tracked files — 27% — were unopenable.**
 *
 * ⭐ AND THE TOOL DISAGREED WITH ITSELF. `search.mjs` walks the disk directly,
 * so `find_files` and `search_text` RETURNED those paths while `read_file`
 * refused them. The model was handed a filename it could never open, burned
 * rounds retrying spellings, gave up — and the session still exited 0 with
 * `ok: true`. A capability hole that reports success is worse than a crash.
 *
 * ── SO THE CHARACTER RULE IS NOW A DENYLIST, AND THAT IS SAFE ───────────────
 * It is safe because the character rule was never what held the line. Escaping
 * the workspace is refused STRUCTURALLY, further down: the `..` segment check,
 * then `resolveInWorkspace`'s realRoot + `isInside` + realpath-of-the-deepest-
 * existing-ancestor. `../outside`, `..\outside`, `src/../../outside`,
 * `/etc/passwd`, `C:/Windows/win.ini`, `\\server\share`, an embedded NUL and a
 * planted junction were each re-verified against that half with the whitelist
 * gone. The `isInside` call below is documented as the assertion that catches a
 * loosening of this regex — this IS that loosening, so it stays.
 *
 * What the denylist now refuses is a different hazard entirely: **filenames
 * Windows cannot store, or stores and then cannot delete.** `< > : " | ? * \ /`
 * are illegal outright; `...`, `trail.` and `trail ` are creatable through the
 * API and then undeletable through Explorer, cmd and PowerShell; `nul` and
 * `com1.txt` are MS-DOS devices and open the device instead of the file. Every
 * one of those passed the old whitelist. An agent that leaves undeletable
 * litter in someone's project is a worse neighbour than one that refuses a name.
 *
 * ⚠️ THREE RULES NOW DIFFER FROM `safeFilePath`, NOT TWO.
 * `safeFilePath` also demands a web-asset extension and a depth of ≤4, because
 * its output is a static site bundle. Here the extension gate is dropped, the
 * depth budget is widened, and — new — the character rule is a denylist rather
 * than a whitelist. `console/lib/acuvo-code-workspace.test.ts` is the drift
 * guard that asserts the shared half cannot diverge; its third divergence
 * assertion still names only two and MUST be updated with this change, or it
 * will be red for a reason that is no longer true.
 *
 * ── AND THE ONE `safeFilePath` NEVER HAD TO THINK ABOUT: SYMLINKS ───────────
 * A purely lexical check is sufficient when the path is a key in a zip. It is
 * NOT sufficient against a real filesystem: `notes` can be a symlink to
 * `C:\Windows\System32`, and `notes/evil.dll` passes every character test ever
 * written while landing squarely outside the project. So every resolved path is
 * run through `realpathSync` on its deepest EXISTING ancestor and re-checked
 * against the REAL root. A path component that does not exist yet cannot be a
 * symlink, which is why checking the existing prefix is enough rather than
 * merely convenient.
 */

import { realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync, renameSync, copyFileSync } from 'node:fs';
/**
 * ⚠️ `basename` IS FOR AN ERROR MESSAGE, NOT FOR RESOLUTION. Nothing in this
 * file may resolve a path with anything but `resolveInWorkspace`; this is used
 * only to put a copy-pasteable `find_files` call into the "no such file"
 * refusal, so a model that guessed the DIRECTORY has a next move instead of a
 * second guess.
 */
import { resolve, join, dirname, sep, basename } from 'node:path';
/**
 * ⭐ IMPORTED, NEVER RE-IMPLEMENTED — the rule search.mjs follows for the same
 * function. secret-paths.mjs owns the one list of paths that must never leave this
 * machine, and `moveFile` has to consult it or a rename becomes a way to
 * relabel a credential into something committable.
 */
import { refusedCommitPath } from './secret-paths.mjs';
/**
 * ⭐ The PROJECT OWNER'S write policy, kept in its own module because the
 * decision (`is this path locked`) must be provable with no filesystem at all.
 * Aliased on import so the two call sites read as what they are — a rule the
 * repository declared, not a rule this file invented.
 */
import { writeRefusal as projectRuleRefusal } from './project-rules.mjs';

/** Depth budget. Deep enough for a real source tree, bounded so a model cannot
 *  spray a thousand nested directories from one typo. */
export const MAX_DEPTH = 12;
/** A single path string longer than this is a mistake, not a filename. */
export const MAX_PATH_LENGTH = 255;
/** Refuse to hand the model a file large enough to blow the context budget. */
export const MAX_READ_BYTES = 200_000;
/** Refuse to write more than this in one call. */
export const MAX_WRITE_BYTES = 400_000;
/** A directory listing is context, not a database dump. */
export const MAX_LIST_ENTRIES = 400;

/**
 * ── ⭐ SWE-agent's THIRD ACI FINDING, AS ONE SHARED CLAUSE ───────────────────
 *
 * Their measured result is that TERSE STRUCTURED ERRORS moved solve rate as much
 * as the windowed viewer did, and the property that does the work is not
 * terseness on its own — it is that a refusal names the NEXT MOVE. This file
 * already knew that (see the too-big read branch, which was written for exactly
 * that reason) and it had been applied to one refusal out of thirty.
 *
 * ⚠️ THE TWO BINARY BRANCHES BOTH ENDED AT "refusing to read it as text", which
 * is a policy statement, not an instruction. The observed shape of that failure
 * is a second identical `read_file` and then a third, because nothing in the
 * sentence says whether a different call would work. There are exactly two true
 * next moves and this clause is both of them: `read_image` is the one binary
 * kind this registry really can see, and for everything else the honest answer
 * is that retrying returns this same string.
 *
 * ⚠️ ONE CONSTANT, NOT TWO COPIES. The NUL branch and the invalid-UTF-8 branch
 * are twenty lines apart and say almost the same thing; this package has already
 * paid twice for a message that drifted between two copies (the two credential
 * lists in read-window.mjs, and `no such file` in delete.mjs vs here).
 *
 * ⚠️ AND IT IS A SUFFIX, DELIBERATELY. Three suites match the head of these
 * strings (`/looks binary/`, `/binary/i`) and one asserts `no such file` is
 * anchored at position 0; every terse-error improvement in this file appends and
 * none rewrites, so a guard that pins the reason still passes while the model
 * gains the instruction.
 */
export const BINARY_NEXT_MOVE = '. If it is an image, read_image reads it; if it is not, there is no text form'
  + ' and re-reading it returns this same refusal — get what you need from a text file instead.';

/**
 * ── ⭐⭐ THE SAME CLAUSE FOR THE #1 MEASURED REFUSAL IN THE WHOLE CORPUS ─────
 *
 * Counted 2026-08-26 across every stored transcript this package has — 3,859
 * files under `.acuvo/sessions`, `.acuvo/audit` and `bench/` — by extracting
 * every `"error"` string and tallying it:
 *
 *     22  absolute path            ← across 16 DISTINCT bench tasks
 *      8  …over the 200000-byte read limit
 *      6  the log tools are not wired to a log source
 *      6  git is not installed, or not on PATH
 *      4  tool arguments were not valid JSON: Unterminated string…
 *
 * `absolute path` is not merely first, it is first by 3×, and it fired on
 * `read_file`, `write_file` AND `list_dir` — every door into the workspace. The
 * POSIX branch below was given a next move for exactly that reason and the
 * sentence works; what it was never given was its SIBLINGS.
 *
 * ⚠️ A DRIVE LETTER IS THE SAME MISTAKE WITH A DIFFERENT SPELLING, and it got
 * `'absolute path with a drive letter'` — six words, no instruction — while the
 * `/app/eigen.py` case three lines up got a paragraph. `..` and a URL are the
 * same shape again. A model cannot tell from any of them that the fix is to
 * re-spell the argument rather than to abandon the file.
 *
 * ⭐ ONE CONSTANT, FOUR CALLERS, following the rule the clause above states:
 * this text is the POSIX branch's existing suffix, byte for byte, so the string
 * that is already measured in production is the string every sibling now gets,
 * and the four cannot drift apart later.
 *
 * ⚠️ IT STATES THE RULE AND NEVER GUESSES THE PATH — the reason is argued at the
 * POSIX branch and it applies identically here: this function never sees the
 * root, so `C:/app/eigen.py` may be `eigen.py` or may be nothing at all.
 */
export const RELATIVE_PATH_NEXT_MOVE = ' — paths are relative to the workspace ROOT, so give the part inside it'
  + ' (e.g. "src/main.py") rather than a filesystem path. Call list_dir to see what the root actually contains.';

/**
 * ⚠️ WRITE-ONLY REFUSALS. These directories are readable (a coding agent has
 * every reason to read `node_modules` types or a git config) but must never be
 * WRITTEN, because writing to them is remote code execution wearing a filename:
 * `.git/hooks/pre-commit` runs on the owner's next commit, and a package inside
 * `node_modules` runs on the next `npm run` of anything.
 *
 * This is the one rule here that is NOT about staying inside the project — it is
 * about the fact that "inside the project" still contains loaded guns.
 */
/**
 * ── ⚠️⚠️ EVERY SEGMENT, NOT JUST THE FIRST ─────────────────────────────────
 *
 * This was `has(segments[0])` — index 0 only. Measured against a temp workspace,
 * every one of these returned `{ok:true, created:true}` and landed on disk:
 *
 *     packages/web/node_modules/vitest/dist/index.js
 *     apps/api/node_modules/.bin/anything
 *
 * A monorepo has a `node_modules` under every package, and a file written into
 * one of them **executes on the next `npm run`** exactly as a root-level one
 * does. The guard was defeated by a directory prefix.
 *
 * ── ⭐ AND WHY `.github/` IS DELIBERATELY *NOT* ON THIS LIST ────────────────
 *
 * ENTERPRISE.md §3.4 proposed adding `.github/`, `.husky/`, `.vscode/` and
 * `.devcontainer/`. I am not doing that, and the reason is the line this set
 * actually draws.
 *
 * These four are refused because **a diff never shows them**: `.git/` is
 * internal, `node_modules/` `.next/` and `.vercel/` are git-ignored build and
 * dependency trees. Code written there runs on the owner's next command having
 * been reviewed by nobody, because there was nowhere for anybody to review it.
 *
 * `.github/workflows/`, `.husky/` and `.vscode/` are the opposite: **tracked,
 * committed, and shown in every diff and pull request**. They are also things a
 * user legitimately asks for — "add a CI workflow" is an ordinary request, and a
 * coding agent that silently refuses it has failed correct work, which this
 * package treats as worse than the risk it was avoiding. The protection there is
 * review, and review is present by construction.
 *
 * ⚠️ If that trade is ever revisited, revisit it as a POLICY setting
 * (`lib/policy.mjs` already owns opt-in restrictions) rather than by extending
 * this set — otherwise the refusal has no way to be turned off by someone who
 * meant it.
 */
const WRITE_FORBIDDEN_ROOTS = new Set(['.git', 'node_modules', '.next', '.vercel']);

/**
 * ── ⚠️⚠️ AND THE ONE DIRECTORY THAT DECIDES WHAT THIS AGENT MAY DO ──────────
 *
 * `.acuvo/` holds `mcp.json` (which NAMES THE PROGRAMS WE SPAWN),
 * `commands.json` (which grants language ecosystems) and `policy.json` (the
 * round and dollar ceilings). Proven against the real executor on 2026-08-13:
 * `write_file('.acuvo/mcp.json', …)` succeeded, and the next run would have
 * spawned the binary it named. That is the identical sentence `.git/` is
 * already refused for — code executing on the owner's next command, in a
 * directory nobody thinks to review — pointed at our own leash.
 *
 * ⚠️ NOT MERELY A PROMPT RULE. The system prompt does tell the model not to
 * enable a preset for itself, and that is worth saying, but guidance is not a
 * boundary: "it would not think of it" has never been a security control.
 *
 * ⚠️ WHY THIS ONE IS HARD-REFUSED RATHER THAN A POLICY SETTING, given the note
 * above says new restrictions belong in policy.mjs so they can be turned off:
 * that argument is about `.github/workflows` and `.vscode`, which a user
 * LEGITIMATELY ASKS FOR — refusing those would be refusing correct work. Nobody
 * asks an agent to rewrite its own permission file mid-run, and a switch to
 * disable this guard would live in the very directory the guard protects, so it
 * could turn itself off. `.git/` is hard-refused for the same reason.
 *
 * ⭐ READS ARE UNTOUCHED. Write is the dangerous verb; an agent that can read
 * its own rules can explain them, which users ask for and costs nothing.
 *
 * ⚠️ THE SAME RULE LIVES IN `policy.mjs` AS `isPolicyProtectedPath`, because
 * this module cannot import that one (policy → tools → workspace is a cycle).
 * `test/agent-cannot-rewrite-its-own-leash.test.mjs` asserts the two agree on a
 * table of paths — without it they drift, which is precisely how the timeout
 * string and its matcher came apart for weeks.
 */
const AGENT_CONFIG_DIR = '.acuvo';

/**
 * Characters no Windows filesystem will store in a name. `\` and `/` can never
 * actually reach the segment test — separators are unified below and the split
 * consumes them — but they stay in the class so this reads as the OS rule it is
 * rather than as a list someone trimmed and a later reader has to re-derive.
 */
const FORBIDDEN_SEGMENT_CHARS = /[<>:"|?*\\/]/;

/**
 * ⚠️ MS-DOS DEVICE NAMES, STILL RESERVED FORTY YEARS ON. `nul` and `com1.txt`
 * passed the old whitelist cleanly, and both are undeletable debris once
 * created: Explorer, `del` and `Remove-Item` all fail, because the OS opens the
 * DEVICE rather than the file. Only a `\\?\`-prefixed incantation removes them,
 * which is not knowledge anybody should need because an agent guessed a
 * filename. Matched on the stem — the extension does not save you.
 */
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

/**
 * ⚠️ AN ERROR STRING IS AN INSTRUCTION TO WHOEVER READS IT, AND HERE THAT IS A
 * MODEL. `EPERM: operation not permitted, open 'C:\…'` reads as noise and
 * invites the identical call again next round; "permission denied" is a fact it
 * can route around by choosing a different file. The raw message is kept for
 * everything else, because an unclassified failure the model can quote is more
 * useful to a human reading the transcript than a tidy euphemism.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeFsError(err) {
  const code = err && typeof err === 'object' ? /** @type {{ code?: unknown }} */ (err).code : undefined;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (err instanceof Error && err.message) return err.message;
  return 'unreadable';
}

/**
 * ── ⚠️ THE CONTRACTS ARE DECLARED, NOT INFERRED ────────────────────────────
 * This package is plain `.mjs` with no build step, but the console's TypeScript
 * suite imports it (`console/lib/acuvo-code-workspace.test.ts`) and `allowJs` is
 * on — so `tsc --noEmit` type-checks these modules through that import and the
 * whole repo's build depends on what it infers. Inference alone widens every
 * `ok: false` to `ok: boolean`, which destroys the discriminated union and makes
 * `if (r.ok) r.absolute` a type error at the CALL SITE rather than here.
 *
 * So the shapes are stated. It costs a few JSDoc blocks and it is what makes
 * "one registry, two clients" survive a type-checker: the TS client gets a real
 * contract without this package acquiring a compiler.
 *
 * @typedef {{ ok: false, reason: string }} PathRefused
 * @typedef {{ ok: true, path: string }} PathAccepted
 * @typedef {{ ok: true, absolute: string, relative: string, root: string }} PathResolved
 * @typedef {{ ok: false, error: string }} ToolFailure
 * @typedef {{ ok: true, path: string, content: string, bytes: number }} ReadOk
 * @typedef {{ ok: true, path: string, bytes: number, previousBytes: number, created: boolean, dryRun?: boolean }} WriteOk
 * @typedef {{ name: string, type: 'dir' | 'file', bytes?: number, skipped?: boolean }} DirEntry
 * @typedef {{ ok: true, path: string, entries: DirEntry[], truncated: boolean }} ListOk
 */

/** Windows compares paths case-insensitively; a case-only mismatch must not
 *  read as "outside the root" and refuse a legitimate file. */
const normalizeCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function isInside(root, candidate) {
  const a = normalizeCase(root);
  const b = normalizeCase(candidate);
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * The LEXICAL half: is this string allowed to name a file at all?
 *
 * Pure — no filesystem access, which is what makes it exhaustively testable
 * without a temp directory. Returns the normalised POSIX-ish relative path, or
 * null with a reason.
 *
 * @param {unknown} raw
 * @returns {PathAccepted | PathRefused}
 */
export function normalizeRelativePath(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'path must be a string' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty path' };
  if (trimmed.length > MAX_PATH_LENGTH) return { ok: false, reason: `path longer than ${MAX_PATH_LENGTH} characters` };
  // ⚠️ Checked on the RAW string, before any normalisation can hide it. A NUL
  // byte truncates the path in some syscalls, so `safe.txt\0../../etc` has been
  // a real bypass in more than one language runtime.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) return { ok: false, reason: 'path contains control characters' };

  const unified = trimmed.replace(/\\/g, '/');
  // UNC (`//server/share`) before the leading-slash test, so the reason is honest.
  if (unified.startsWith('//')) return { ok: false, reason: 'UNC network path' };
  /**
   * ⚠️ THE REASON NAMES THE FIX. A task prompt frequently hands the model an
   * absolute path INSIDE the workspace (`/app/eigen.py` when the root IS
   * `/app`), and "absolute path" alone reads as "this file is off limits"
   * rather than "say it differently". This function is deliberately root-less,
   * so it cannot strip the prefix itself — but it can say what to write.
   */
  if (unified.startsWith('/')) {
    /**
     * ⚠️ IT STATES THE RULE AND DOES NOT GUESS THE PATH. Suggesting the string
     * with the leading slash removed looks helpful and is wrong exactly when it
     * matters: if the root IS `/app`, then `/app/eigen.py` is `eigen.py`, not
     * `app/eigen.py`. A confident wrong suggestion costs the same round the bare
     * refusal did, and this function cannot tell the difference — it never sees
     * the root.
     */
    return { ok: false, reason: `absolute path${RELATIVE_PATH_NEXT_MOVE}` };
  }
  if (/^[A-Za-z]:/.test(unified)) return { ok: false, reason: `absolute path with a drive letter${RELATIVE_PATH_NEXT_MOVE}` };
  /**
   * ⚠️ NOT `RELATIVE_PATH_NEXT_MOVE` — a URL is a different mistake with a
   * different fix. The model has confused two tools rather than two spellings of
   * one path, so the move is to change TOOL, and `fetch_url` is the one that
   * takes this argument. Telling it to re-spell a URL as a relative path would
   * send it looking for a file that was never in the workspace.
   */
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(unified)) {
    return { ok: false, reason: 'URL, not a path — this argument names a file inside the workspace. fetch_url reads a web address; a file tool never does.' };
  }

  // `.` is a no-op segment and is dropped; `..` is the attack and is refused.
  // Conflating the two cost `generated-files.ts` a test — models write `./x.css`
  // constantly because that is how the href reads in the HTML they just emitted.
  const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
  /**
   * ⚠️ `listDir` SPECIAL-CASES THE ROOT AND THIS FUNCTION NEVER SEES IT, so the
   * refusal can name the call that does work — the model asking for the root is
   * usually asking for a LISTING, and it just used the wrong verb to ask.
   */
  if (segments.length === 0) return { ok: false, reason: 'path resolves to the workspace root itself — this argument has to name a FILE. list_dir {"path":"."} is what shows the root.' };
  if (segments.length > MAX_DEPTH) return { ok: false, reason: `path deeper than ${MAX_DEPTH} directories — nothing legitimate nests that far; check the path for a repeated segment.` };
  for (const s of segments) {
    if (s === '..') return { ok: false, reason: `path escapes the workspace with ".."${RELATIVE_PATH_NEXT_MOVE}` };
    /**
     * ── THE DENYLIST ────────────────────────────────────────────────────────
     * ⚠️ This is NOT the containment check — see the header. Escaping is refused
     * by the `..` test above and by `resolveInWorkspace` below, both of which
     * are structural and neither of which cares what characters a name uses.
     * What is refused here is names the filesystem cannot hold. Everything else
     * — spaces, `[ ] ( ) @ + , # ! & ' ~ $ =`, Unicode letters — is a real
     * filename in a real repository and is permitted.
     *
     * ⭐ Each refusal names the offending character or the rule, because the
     * reader is a model choosing what to do next and "unsupported characters"
     * told it nothing it could act on.
     */
    const bad = FORBIDDEN_SEGMENT_CHARS.exec(s);
    if (bad) return { ok: false, reason: `path segment "${s}" contains a character Windows cannot store: "${bad[0]}"` };
    // `...`, `....` — the `..` family beyond the two everyone remembers. Windows
    // creates them through the API and then no ordinary tool can remove them.
    if (/^\.+$/.test(s)) {
      return { ok: false, reason: `path segment "${s}" is nothing but dots — Windows will create it and then refuse to delete it. Give the file a name.` };
    }
    if (s.endsWith('.') || s.endsWith(' ')) {
      const what = s.endsWith('.') ? 'a dot' : 'a space';
      return { ok: false, reason: `path segment "${s}" ends in ${what} — Windows silently strips it, so the file written is not the file named, and the result cannot be deleted normally. Drop the trailing character.` };
    }
    const dot = s.indexOf('.');
    const stem = dot === -1 ? s : s.slice(0, dot);
    if (RESERVED_DEVICE_NAMES.has(stem.toLowerCase())) {
      return { ok: false, reason: `path segment "${s}" starts with the reserved device name "${stem}" — Windows opens the device instead of a file. Rename it, e.g. "${stem}-notes${dot === -1 ? '' : s.slice(dot)}".` };
    }
  }
  return { ok: true, path: segments.join('/') };
}

/**
 * The FILESYSTEM half: turn a model-supplied path into an absolute path proven
 * to live inside the workspace, symlinks included.
 *
 * `intent` is 'read' or 'write' — only the second consults WRITE_FORBIDDEN_ROOTS.
 *
 * @param {string} root
 * @param {unknown} raw
 * @param {'read' | 'write'} [intent]
 * @returns {PathResolved | PathRefused}
 */
export function resolveInWorkspace(root, raw, intent = 'read') {
  const lexical = normalizeRelativePath(raw);
  if (!lexical.ok) return lexical;

  const segments = lexical.path.split('/');
  if (intent === 'write') {
    // ⚠️ The LAST segment is excluded: a file literally named `node_modules`
    // is not a directory anybody executes out of, and refusing it would be a
    // refusal of correct work for a name collision.
    const blocked = segments.slice(0, -1).find((seg) => WRITE_FORBIDDEN_ROOTS.has(seg));
    if (blocked) {
      const nested = segments.indexOf(blocked) > 0 ? ` (nested at ${segments.slice(0, segments.indexOf(blocked) + 1).join('/')}/)` : '';
      return { ok: false, reason: `writing into ${blocked}/${nested} is refused — it executes code on the owner's next command, and no diff would show it` };
    }
    /**
     * ⚠️⚠️ THE `.acuvo/` GUARD IS DELIBERATELY *NOT* HERE, and putting it here
     * was the first attempt. This function is a PATH UTILITY that the package's
     * own internals use — `acceptance.mjs:323` resolves `.acuvo/acceptance.json`
     * through it with intent 'write' and then writes with raw `fs`. A refusal at
     * this layer broke seven tests of legitimate machinery: the product writing
     * its own state is not the threat.
     *
     * ⭐ The threat is the MODEL writing there, and the model only ever arrives
     * through `createLocalExecutor` — so the guard lives on those methods. See
     * `agentWriteRefusal` below.
     */
  }

  // realpath the ROOT once, so a workspace that is itself reached through a
  // symlink (macOS /tmp, a junction on Windows) does not make every child look
  // like an escape.
  let realRoot;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    return { ok: false, reason: `workspace directory does not exist: ${root}` };
  }

  const absolute = resolve(realRoot, ...segments);
  // Belt and braces: the whitelist already makes this unreachable, which is
  // exactly why it is cheap to keep. It is the assertion that the lexical layer
  // did its job, and it is what would catch a future loosening of the regex.
  if (!isInside(realRoot, absolute)) {
    return { ok: false, reason: 'resolved outside the workspace' };
  }

  // ── THE SYMLINK CHECK ─────────────────────────────────────────────────────
  // Walk up to the deepest ancestor that EXISTS and realpath that. Resolving it
  // resolves every link along its whole path in one call, and the non-existent
  // tail cannot be a link because it is not anything yet.
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break; // reached a filesystem root; cannot happen inside a workspace
    existing = parent;
  }
  let realExisting;
  try {
    realExisting = realpathSync(existing);
  } catch {
    return { ok: false, reason: 'path could not be resolved on disk' };
  }
  if (!isInside(realRoot, realExisting)) {
    return { ok: false, reason: 'path escapes the workspace through a symlink' };
  }

  return { ok: true, absolute, relative: lexical.path, root: realRoot };
}

/**
 * The executor the agent turn is handed. Everything it can do to a filesystem
 * is these three functions, and all three go through `resolveInWorkspace`.
 *
 * Returns plain data (never throws for an expected failure) because the result
 * of a tool call is something the model has to be TOLD about, not something that
 * should kill the process.
 */
/**
 * ── ⚠️⚠️ THE AGENT MAY NOT REWRITE ITS OWN LEASH ────────────────────────────
 *
 * `.acuvo/` holds `mcp.json` (which NAMES THE PROGRAMS WE SPAWN),
 * `commands.json` (which grants language ecosystems) and `policy.json` (round
 * and dollar ceilings). Proven against the real executor on 2026-08-13:
 * `write_file('.acuvo/mcp.json', …)` succeeded and the next run would have
 * spawned the binary it named — the same sentence `.git/` is refused for, aimed
 * at our own permission file.
 *
 * ⚠️ THE GUARD IS ON THE EXECUTOR, NOT ON `resolveInWorkspace`. Putting it there
 * was the first attempt and it broke seven tests: the package's own internals
 * (`acceptance.mjs`) legitimately write inside `.acuvo/`. The product writing its
 * own state is not the threat; the MODEL writing there is, and the model only
 * ever arrives through this executor.
 *
 * ⚠️ NOT MERELY A PROMPT RULE. The system prompt tells the model not to enable a
 * preset for itself. That is worth saying and it is not a boundary.
 *
 * ⚠️ HARD-REFUSED RATHER THAN A POLICY SETTING, unlike the note on
 * WRITE_FORBIDDEN_ROOTS: that argument is about `.github/workflows`, which a
 * user legitimately asks for. Nobody asks an agent to rewrite its own
 * permission file mid-run — and a switch to disable this would live in the very
 * directory it protects, so it could turn itself off.
 *
 * ⭐ READS ARE UNTOUCHED. An agent that can read its own rules can explain them.
 *
 * @returns {string|null} a refusal sentence, or null when the path is fine
 */
function agentWriteRefusal(relPath) {
  const segments = String(relPath ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== AGENT_CONFIG_DIR) return null;
  return `writing into ${AGENT_CONFIG_DIR}/ is refused — that directory decides which programs this agent may `
    + 'spawn (mcp.json), which languages it may run (commands.json) and its own round and dollar ceilings '
    + '(policy.json), so a write there grants permissions rather than doing the task. If one of them really '
    + 'should change, say which line and why, and let the owner edit it themselves.';
}

/**
 * ── ⭐ `claimPath` — THE ONE SEAM THAT MAKES LEASES A GUARANTEE ─────────────
 *
 * Injected rather than imported, for the reason every other disk touch in this
 * file is injected: `workspace.mjs` is the lowest layer here and must stay
 * testable with no filesystem and no lease directory. `bin/` owns the policy
 * and builds the claimer (`lib/auto-lease.mjs`); this file only asks.
 *
 * ⚠️ `null` BY DEFAULT, so every existing caller and every existing test is
 * byte-identical. A guard on the write path is the last place to change
 * behaviour for someone who did not ask.
 */
/**
 * ── ⭐⭐ `journal` — THE SECOND SEAM ON THIS PATH, AND WHY IT IS THE ONLY ONE
 *        CHECKPOINTING NEEDS ──────────────────────────────────────────────────
 *
 * `writeFile` and `deleteFile` below are the ONLY two ways a file on disk
 * changes through this agent — `write_files`, `edit_file` and the media verbs
 * all call them (lib/write-many.mjs:22-24 states it outright). So an undo does
 * not need a hook per tool; it needs the previous bytes read at these two
 * points, which is what `journal.record` does.
 *
 * ⚠️ INJECTED, NOT IMPORTED, for exactly the reason `claimPath` is: this file
 * is the lowest layer and must stay testable with no filesystem and no journal.
 * `bin/` owns the policy and builds it (lib/checkpoint.mjs); this file only
 * tells it what is about to happen.
 *
 * ⚠️ `null` BY DEFAULT, so every existing caller and every existing test is
 * byte-identical.
 */
/**
 * ── ⭐⭐⭐ `rules` — THE PROJECT OWNER'S WRITE POLICY ────────────────────────
 *
 * A parsed `acuvo-rules.json` (see `lib/project-rules.mjs`), or `null` for the
 * overwhelming majority of workspaces that have no policy — in which case not
 * one byte of behaviour changes.
 *
 * ⚠️ IT IS CONSULTED **AFTER** `resolveInWorkspace`, ON `r.relative`, and that
 * is the entire security argument. Checked against the raw argument, a lock on
 * `Core/**` would be walked straight past by `./Core/x.cpp`, `Core\x.cpp` or
 * `Gameplay/../Core/x.cpp` — three spellings of the same file, one of which the
 * model will eventually produce by accident. `r.relative` is the canonical
 * path, so there is exactly one spelling left to match.
 */
export function createLocalExecutor(root, { dryRun = false, claimPath = null, holder = null, journal = null, rules = null } = {}) {
  /**
   * ⚠️ A WRITE MUST NEVER DIE BECAUSE BOOKKEEPING DID — the same rule
   * `audit.mjs` states in its header. `openJournal`'s `record` is written never
   * to throw and to collect its own failures in `errors`; this catch exists for
   * the OTHER implementations (a stub in a test, a future one) so a bug in the
   * recorder can never cost the user the work. It still lands in `errors` when
   * the journal has one, because a silent checkpoint failure is the thing that
   * makes an undo a lie.
   */
  const note = (mutation) => {
    if (!journal) return;
    try {
      journal.record(mutation);
    } catch (err) {
      if (Array.isArray(journal.errors)) {
        journal.errors.push(`checkpoint: ${mutation.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const realRoot = realpathSync(resolve(root));

  return {
    root: realRoot,
    dryRun,
    /**
     * ⭐ WHO THIS TERMINAL IS, when the user said so. Carried here because the
     * executor is what every tool already receives — the alternative was
     * threading a holder through the dispatcher as a second parameter beside
     * `root`, which is the same fact in two places waiting to disagree.
     *
     * `null` for a terminal that named no holder, which is the single-terminal
     * case and must keep behaving exactly as it does today.
     */
    holder,

    /** @param {unknown} path @returns {ReadOk | ToolFailure} */
    /**
     * ⚠️ ADDED SO THE DISPATCHER NEVER BRANCHES ON EXECUTOR TYPE. delete.mjs
     * owns the schema and the refusal wording; the executor owns HOW a file
     * stops existing — on disk here, in a Map for the browser builder. Two
     * implementations of one verb is fine; two dispatchers is not.
     */
    deleteFile(path) {
      // ⚠️ Deleting mcp.json is not safer than rewriting it — it silently drops
      // the servers a user configured, which is a change to what runs.
      const leash = agentWriteRefusal(path);
      if (leash) return { ok: false, error: leash };
      const r = resolveInWorkspace(realRoot, path, 'write');
      if (!r.ok) return { ok: false, error: r.reason };
      // ⭐ The owner's policy covers deletion as much as modification — a lock
      // that stops you editing the engine but lets you delete it is not a lock.
      const denied = rules ? projectRuleRefusal(rules, r.relative) : null;
      if (denied) return { ok: false, error: denied };
      /**
       * ⚠️ AFTER the path is resolved, so the claim is on the REAL relative
       * path rather than whatever spelling the model used — `./src/app.ts` and
       * `src/app.ts` must be one lease, not two. And before anything is
       * removed, obviously: a refusal has to arrive while the file still exists.
       */
      if (claimPath) {
        const claim = claimPath(r.relative);
        if (!claim.ok) return { ok: false, error: claim.error };
      }
      let stat;
      try { stat = statSync(r.absolute); } catch (err) {
        // ⚠️ "no such file" for an EPERM is a lie, and the model acts on it by
        // creating the file it was told is missing. Branch on the code.
        const code = err && typeof err === 'object' ? /** @type {{ code?: unknown }} */ (err).code : undefined;
        if (code === 'EACCES' || code === 'EPERM') {
          return { ok: false, error: `could not inspect ${r.relative}: permission denied — it exists but this account cannot see it. Nothing was deleted.` };
        }
        return { ok: false, error: `no such file: ${r.relative} — nothing was deleted` };
      }
      if (stat.isDirectory()) {
        return { ok: false, error: `${r.relative} is a directory. This agent deletes one FILE at a time and never a directory — removing a tree is the operation nobody can review.` };
      }
      if (!dryRun) {
        // ⭐ BEFORE the unlink, obviously — after it there is nothing left to
        // copy. A delete is the mutation an undo matters most for: a rewritten
        // file is still on disk to look at, a deleted one is gone.
        note({ verb: 'delete', path: r.relative, absolute: r.absolute, after: null });
        try { unlinkSync(r.absolute); } catch (err) {
          return { ok: false, error: `could not delete ${r.relative}: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      return { ok: true, path: r.relative, bytes: stat.size, dryRun };
    },

    readFile(path) {
      const r = resolveInWorkspace(realRoot, path, 'read');
      if (!r.ok) return { ok: false, error: r.reason };
      let stat;
      try {
        stat = statSync(r.absolute);
      } catch (err) {
        const code = err && typeof err === 'object' ? /** @type {{ code?: unknown }} */ (err).code : undefined;
        if (code === 'EACCES' || code === 'EPERM') {
          return {
            ok: false,
            error: `could not read ${r.relative}: permission denied — it exists but this account cannot open it.`
              + ' Nothing here will change that; work from another file.',
          };
        }
        /**
         * ── ⚠️ THE MOST FREQUENT REFUSAL IN THE WHOLE LOOP, AND IT WAS A FULL
         * STOP. A model guesses a path far more often than it mistypes one, and
         * "no such file: src/utils.ts" gives it nothing to do next except guess
         * again — which is the same round spent twice. `find_files` and
         * `search_text` are both already in the registry and both already answer
         * exactly this question.
         *
         * ⚠️⚠️ THE `no such file:` PREFIX IS LOAD-BEARING AND MUST STAY FIRST.
         * `command.mjs` tests this error with `/^no such file/i` in THREE places
         * (lines 2657, 2757, 2764) to tell "there is no config/lockfile/rcfile,
         * carry on" apart from "the read genuinely failed". Anchored at the
         * START, so a suffix is safe and a prefix is not. `vision.mjs`'s suite
         * asserts the same anchor from the other direction. Append only.
         */
        return {
          ok: false,
          error: `no such file: ${r.relative} — find_files {"pattern":"${basename(String(path ?? '')) || r.relative}"}`
            + ' locates it if the name is right and the directory is wrong; list_dir on the parent shows what is'
            + ' actually there.',
        };
      }
      if (stat.isDirectory()) return { ok: false, error: `${r.relative} is a directory — use list_dir` };
      if (stat.size > MAX_READ_BYTES) {
        /**
         * ⚠️ NAMES THE WAY OUT, BECAUSE A LIMIT WITHOUT AN ALTERNATIVE IS A
         * DEAD END. `read_file` takes a path and nothing else, so "too big" is
         * not something the model can retry differently — it has to change TOOL.
         * Measured: make-mips-interpreter re-issued the identical refused read,
         * because nothing in the message suggested there was another way in.
         *
         * ── ⚠️⚠️ AND IT NAMED THE WRONG ARGUMENTS FOR TWO MONTHS ──────────────
         *
         * The sentence above was right about the PRINCIPLE and wrong about the
         * FACTS. It advertised `read_lines {"path","start","end"}` and
         * `read_around {"path","match"}`. Neither tool has ever had a `start`,
         * an `end` or a `match`: `read_lines` takes path/offset/limit/numbered
         * and `read_around` takes path/pattern/context/ignoreCase/maxBlocks
         * (`READ_LINES_KEYS` / `READ_AROUND_KEYS` in read-window.mjs).
         *
         * PROBED OFFLINE 2026-08-26 through `createLocalExecutor` + `readWindow`
         * on a 324,000-byte file — i.e. a model that read this refusal and did
         * exactly what it said:
         *
         *   read_file  {"path":"huge.mjs"}
         *     → "over the 200000-byte read limit … read_lines {path,start,end}"
         *   read_lines {"path":"huge.mjs","start":300,"end":320}
         *     → ok:false  'read_lines accepts only path, offset, limit,
         *                  numbered, maxChars — it does not accept "start".'
         *   read_around {"path":"huge.mjs","match":"line 0300"}
         *     → ok:false  'read_lines accepts only path, offset, limit,
         *                  numbered, maxChars — it does not accept "match".'
         *
         * ⭐ READ THE SECOND ONE AGAIN: it says READ_LINES. `readWindow` picks
         * the tool by `'pattern' in args`, so `{path, match}` never reaches
         * `read_around` at all — the model is refused by a tool it did not call,
         * and told about arguments belonging to a tool it was not using. That is
         * three paid rounds to page one file, and the first of them was spent
         * obeying us.
         *
         * ⚠️ A TOOL THAT DOCUMENTS THE WRONG ARGUMENT NAMES TEACHES THE MODEL TO
         * CALL IT WRONG, EVERY TIME, FOREVER — and on an append-only transcript
         * the bad advice is re-sent for the rest of the run, so one refusal keeps
         * paying for itself. The literal calls are spelled out below, values and
         * all, because a shape with placeholder keys is what produced this bug:
         * `{"path","start","end"}` is not JSON anybody can copy, so nobody ever
         * copied it into a probe and found out it was wrong.
         *
         * ⚠️ THE `no such file:` PREFIX RULE APPLIES TO ITS SIBLING BELOW, NOT
         * HERE — see the note on that branch before reformatting either.
         */
        /**
         * ── ⭐ AND FOR A DATA FILE, PAGING IS THE WRONG ANSWER ─────────────────
         *
         * MEASURED across the 139 bench runs: EVERY hit on this refusal was a
         * data file, and `bn_sample_10k.csv` alone accounts for eight of them. All
         * four `bn-fit-modify` runs then spent round 2 doing what this sentence
         * says — `read_lines`, or `head -5 && wc -l` — to learn five column names,
         * which is two rounds of sixteen and still does not answer what the
         * columns CONTAIN. `profile_table` answers it in round 1 and has no size
         * limit at all, because it streams.
         *
         * ⚠️ NAMED ONLY FOR A DELIMITED EXTENSION, deliberately. Two of the
         * recorded hits were a linker `.map` and a `.gcode`, and telling the model
         * about a table reader for those is the "documents the wrong thing"
         * failure this whole block exists to record.
         *
         * ⚠️⚠️ THE LIST IS SPELLED HERE RATHER THAN IMPORTED, AND THAT IS NOT
         * LAZINESS: `table-profile.mjs` imports THIS file, so importing its
         * `TABULAR_EXTENSIONS` back would close a module cycle around the
         * workspace resolver. Two copies that can drift are exactly what this
         * package treats as a defect, so `test/table-profile.test.mjs` asserts
         * the two sets are equal by driving BOTH — not by restating either.
         */
        const tabular = /\.(?:csv|tsv|tab|psv|dat)$/i.test(r.relative);
        return {
          ok: false,
          error: `${r.relative} is ${stat.size} bytes, over the ${MAX_READ_BYTES}-byte read limit.`
            + (tabular
              ? ` If it is delimited data, do not page it: profile_table {"path":"${r.relative}"} describes the WHOLE file`
                + ' — row count, every column with its type, range and distinct values, plus the first rows — with no size limit.'
              : '')
            + ` Read part of it instead: read_lines {"path":"${r.relative}","offset":1,"limit":200}`
            + ' for a range (offset is a 1-indexed LINE NUMBER, and the result tells you totalLines'
            + ` and the nextOffset to continue from), read_around {"path":"${r.relative}","pattern":"someText"}`
            + ' for the region near a string, or search_text to find the lines worth reading first.',
        };
      }
      // ⚠️ 'utf8' on a binary file yields replacement characters rather than an
      // error, so the model would silently reason about garbage. Detecting a NUL
      // in the first block is the cheap, standard heuristic and it is honest
      // about what it cannot read.
      /**
       * ── ⚠️ THE READ THAT KILLED WHOLE SESSIONS ──────────────────────────────
       * This was the ONE unguarded call in the file — the `statSync` above was
       * wrapped and this was not, which is exactly the asymmetry nobody notices
       * in review. `gatherWorkspaceContext` (turn.mjs) pre-reads every small
       * file in the top two directory levels BEFORE the first model call, so a
       * single permission-denied file sitting in the workspace root took the
       * entire run down with a raw EPERM stack — before a token was spent, with
       * nothing in the output the owner could act on.
       *
       * ⭐ And `statSync` succeeding proves nothing: on Windows a deny ACE lets
       * you stat a file you cannot open. Existence and readability are two
       * different questions and only one of them was being asked.
       */
      /**
       * ── ⚠️⚠️ READ THE BYTES, NOT A DECODED STRING. THE DECODE IS THE LOSS. ──
       *
       * This was `readFileSync(r.absolute, 'utf8')`, and that one argument was a
       * silent data-destruction bug. `'utf8'` NEVER FAILS: every byte it cannot
       * make sense of becomes U+FFFD, and a write-back turns each one into
       * `ef bf bd`. So a cp1252 / latin-1 / Shift-JIS file, which is legitimate
       * text and merely not our encoding, came back permanently mangled with
       * `ok: true` and a plausible byte count sitting on top of it.
       *
       * ⚠️ `lib/edit.mjs:85` ALREADY FIXED THIS AND THE CLI DID NOT CALL IT.
       * `editFile()` carries the whole defence, but `tools.mjs` dispatches
       * `edit_file` to `editThroughExecutor()`, which reads through THIS
       * function. The fix was written, argued, tested, and routed around. The
       * guard belongs here rather than in a second copy inside edit.mjs because
       * `read_file`, `edit_file` and `gatherWorkspaceContext`'s automatic
       * pre-read of the workspace all come through this one door.
       *
       * ⭐ THE PRE-READ IS WHY THIS OUTRANKS AN EDIT BUG. The gather reads small
       * files before round 1, so one cp1252 file in the workspace root fed the
       * model text that was not the text on disk, before a token was spent, and
       * with no way for the model to know.
       */
      let raw;
      try {
        raw = readFileSync(r.absolute);
      } catch (err) {
        return { ok: false, error: `could not read ${r.relative}: ${describeFsError(err)}` };
      }

      /**
       * ⭐ `fatal: true` IS THE FIX: it throws on exactly the bytes `'utf8'`
       * would have silently replaced.
       *
       * ⚠️ `ignoreBOM: true` IS LOAD-BEARING AND IS NAMED BACKWARDS. It means
       * "do not treat a leading U+FEFF as a marker to swallow", i.e. KEEP the
       * BOM as an ordinary character. The default (`false`) strips it, which
       * quietly deletes three bytes from the front of every BOM'd file on every
       * read-then-edit round trip, and BOM'd UTF-8 is what many Windows editors
       * write by default.
       *
       * ⚠️ The binary check below still runs on the DECODED string so that its
       * message wins for a .png: "looks binary" is more useful than "not valid
       * UTF-8", and a real binary is almost always both. A NUL byte always
       * decodes cleanly to U+0000, so a binary file reaches that check intact.
       */
      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
      } catch {
        /**
         * ⚠️ A REFUSAL THAT CANNOT BE RETRIED HAS TO SAY SO. Both binary
         * branches used to end at "refusing to read it as text", which reads to
         * a model like a policy it might be able to argue with — and the
         * observed behaviour is a second identical `read_file`, then a third.
         * There are exactly two next moves and both are named: `read_image` for
         * the one binary kind this registry CAN see, and "stop" for the rest.
         */
        if (raw.includes(0)) return { ok: false, error: `${r.relative} looks binary, refusing to read it as text${BINARY_NEXT_MOVE}` };
        return {
          ok: false,
          error: `${r.relative} is not valid UTF-8, so it will not be read as text. `
            + 'Decoding it would replace every undecodable byte with U+FFFD, and writing that back would destroy those bytes permanently.',
        };
      }
      if (content.includes('\u0000')) return { ok: false, error: `${r.relative} looks binary — refusing to read it as text${BINARY_NEXT_MOVE}` };
      return { ok: true, path: r.relative, content, bytes: stat.size };
    },

    /** @param {unknown} path @param {unknown} content @returns {WriteOk | ToolFailure} */
    writeFile(path, content) {
      // ⚠️ FIRST, before the size and path checks — the reason this path is
      // refused has nothing to do with how big or well-formed the content is.
      const leash = agentWriteRefusal(path);
      if (leash) return { ok: false, error: leash };
      /**
       * ⚠️ NAMES THE TYPE IT GOT, BECAUSE THE COMMON CAUSE IS AN OBJECT. The old
       * message — "content must be a string" — is true and unactionable: the
       * model that sent `{"path":"tsconfig.json","content":{...}}` reads it, sees
       * that it did send a content, and sends the same object again. Saying WHICH
       * type arrived turns it into a one-round fix, and the JSON clause is there
       * because a serialisable object is the only shape that ever arrives here.
       */
      if (typeof content !== 'string') {
        return {
          ok: false,
          error: `write_file needs "content" to be a string and you sent ${content === null ? 'null' : typeof content}.`
            + ' Pass the file\'s complete new text; for a .json file that means the serialised text, not an object.',
        };
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        /**
         * ⚠️ A CEILING WITHOUT A ROUTE PAST IT IS THE SAME DEAD END the too-big
         * READ branch was fixed for. A model that has assembled 500KB in one
         * string cannot make it smaller by asking again, so it either retries
         * verbatim or abandons the file; the way through is to land the head and
         * grow it, and that is now stated rather than left to be worked out.
         */
        return {
          ok: false,
          error: `refusing to write ${bytes} bytes (limit ${MAX_WRITE_BYTES})`
            + ' — write the first part with write_file, then extend it with edit_file, or split it into'
            + ' several smaller files. Nothing was written.',
        };
      }
      const r = resolveInWorkspace(realRoot, path, 'write');
      if (!r.ok) return { ok: false, error: r.reason };
      /**
       * ⭐⭐ THE OWNER'S POLICY, AND IT IS THE FIRST THING AFTER RESOLUTION.
       * Before the lease, before the existence check, before a single byte is
       * read — a path this project has locked should cost no I/O to refuse, and
       * more importantly must not be able to fail *later* than a lease conflict
       * and thereby depend on who else is running.
       */
      const denied = rules ? projectRuleRefusal(rules, r.relative) : null;
      if (denied) return { ok: false, error: denied };
      /**
       * ⭐ THE CLAIM, ON THE RESOLVED RELATIVE PATH. Two spellings of one file
       * must be one lease — `lease.mjs` normalises too, but claiming the
       * resolved path means the two layers cannot disagree about what was
       * claimed. Placed before the existence check so a refusal costs no I/O.
       */
      if (claimPath) {
        const claim = claimPath(r.relative);
        if (!claim.ok) return { ok: false, error: claim.error };
      }

      // Whether this CREATES or REPLACES is the single most important fact in
      // the summary, and it can only be known before the write.
      const existed = existsSync(r.absolute);
      let previousBytes = 0;
      if (existed) {
        // Unguarded until 2026-08-10, for the same reason the read below it was:
        // `existsSync` had just said yes, so the throw looked impossible. It is
        // not — a deny ACE, or the file vanishing between the two calls.
        let stat;
        try {
          stat = statSync(r.absolute);
        } catch (err) {
          return { ok: false, error: `could not inspect ${r.relative} before writing: ${describeFsError(err)}` };
        }
        /**
         * ⚠️ THE COLLISION IS ALWAYS A MISREAD TREE, so the refusal points at
         * the tool that would have shown it. Bare "X is a directory" leaves the
         * model to decide whether the DIRECTORY is wrong or its own filename is
         * missing, and it has a one-in-two chance of picking the wrong one.
         */
        if (stat.isDirectory()) {
          return {
            ok: false,
            error: `${r.relative} is a directory, so nothing was written — write to a file inside it`
              + ` (list_dir {"path":"${r.relative}"} shows what is already there).`,
          };
        }
        previousBytes = stat.size;
      }
      /**
       * ⚠️ DRY RUN STOPS HERE, NOT EARLIER. Every safety check above has already
       * run, so `--dry-run` reports exactly the refusals a real run would — a
       * preview that skipped validation would be a preview of a different
       * command, which is the only way a dry run can lie.
       */
      if (dryRun) return { ok: true, path: r.relative, bytes, previousBytes, created: !existed, dryRun: true };
      /**
       * ⭐ AFTER the dry-run return, so a preview records nothing — a dry run
       * that filled the journal would be a run that "touched nothing" and left
       * two files behind. And before the write, because the previous contents
       * only exist until the line below.
       */
      note({ verb: 'write', path: r.relative, absolute: r.absolute, after: content });
      try {
        mkdirSync(dirname(r.absolute), { recursive: true });
        writeFileSync(r.absolute, content, 'utf8');
      } catch (err) {
        return { ok: false, error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, path: r.relative, bytes, previousBytes, created: !existed };
    },

    /**
     * ── ⭐⭐ RENAMING WAS IMPOSSIBLE, NOT MERELY EXPENSIVE ────────────────────
     *
     * With no move verb, the only way to rename was `read_file` + `write_file`
     * + `delete_file`: three rounds of a five-round default, and the file's
     * whole content through the model's context TWICE. MEASURED against the
     * real executor, and for two very ordinary files it does not work at all:
     *
     *   a 250KB source file  → `read_file` refuses: "over the 200000-byte read
     *                          limit". There is no second way in.
     *   `logo.png`           → `read_file` refuses: binary. Which is the good
     *                          outcome — the alternative is a silent corruption
     *                          on the way back out.
     *
     * So today an agent cannot rename a large module or move an image into
     * `assets/`, and nothing tells it why except a read error about a file it
     * never wanted to read.
     *
     * ⚠️⚠️ AND THE OBVIOUS IMPLEMENTATION LAUNDERS CREDENTIALS. `git.mjs`
     * refuses to COMMIT `.env`, `id_rsa`, `*.pem` and friends BY PATH — so
     * `move_file('.env', 'notes/env.txt')` followed by `git_commit` puts the
     * secret in history with every check passing, because the name it is
     * checked under is one the agent chose. Verified against the real
     * `refusedCommitPath`: `.env` REFUSED, `notes/env.txt` allowed.
     *
     * ⭐ The rule is precise rather than blunt: a move is refused when it
     * carries a path OUT of the protected namespace. `.env` → `.env.bak` is
     * fine (still refused at commit); `.env` → `notes/env.txt` is not. Blanket
     * refusal would block renaming `.env.example`, which is an ordinary thing
     * to do and would be a guard that fails correct work.
     *
     * ⚠️ DIRECTORIES ARE REFUSED, and the reason is the checkpoint rather than
     * squeamishness. The journal snapshots ONE path per entry, so a directory
     * move would be recorded as a single mutation covering an unknown number of
     * files and `acuvo rewind` would silently restore none of them. An undo
     * that lies is worse than a verb that is missing.
     *
     * @param {unknown} from
     * @param {unknown} to
     * @param {{ overwrite?: boolean }} [opts]
     */
    moveFile(from, to, { overwrite = false } = {}) {
      // ⚠️ BOTH SIDES. A path this agent may not write is one it may not create
      // by moving onto, nor destroy by moving away from.
      for (const p of [from, to]) {
        const leash = agentWriteRefusal(p);
        if (leash) return { ok: false, error: leash };
      }
      const src = resolveInWorkspace(realRoot, from, 'write');
      if (!src.ok) return { ok: false, error: src.reason };
      const dst = resolveInWorkspace(realRoot, to, 'write');
      if (!dst.ok) return { ok: false, error: dst.reason };
      if (src.relative === dst.relative) {
        return { ok: false, error: `${src.relative} and ${dst.relative} are the same file — nothing to move` };
      }

      /**
       * ⚠️ ON THE RESOLVED PATHS, so `./.env` and `.env` cannot disagree, and
       * the check reads the name the file will actually be committed under.
       */
      if (refusedCommitPath(src.relative) && !refusedCommitPath(dst.relative)) {
        return {
          ok: false,
          error: `refusing to move ${src.relative} to ${dst.relative}: the source is a credential path this agent will never commit, `
            + 'and the destination is not — so the move would make it committable under a name of the agent\'s choosing. '
            + 'Rename it yourself if that is really what you want.',
        };
      }

      if (claimPath) {
        for (const rel of [src.relative, dst.relative]) {
          const claim = claimPath(rel);
          if (!claim.ok) return { ok: false, error: claim.error };
        }
      }

      let stat;
      try { stat = statSync(src.absolute); } catch (err) {
        const code = err && typeof err === 'object' ? /** @type {{ code?: unknown }} */ (err).code : undefined;
        if (code === 'EACCES' || code === 'EPERM') {
          return { ok: false, error: `could not inspect ${src.relative}: permission denied. Nothing was moved.` };
        }
        return { ok: false, error: `no such file: ${src.relative} — nothing was moved` };
      }
      if (stat.isDirectory()) {
        return {
          ok: false,
          error: `${src.relative} is a directory. This agent moves one FILE at a time: the checkpoint journal records one path per `
            + 'mutation, so a directory move would look like a single change and `acuvo rewind` would restore none of it. '
            + 'Move the files individually, or do the directory yourself with `git mv`.',
        };
      }

      const destExisted = existsSync(dst.absolute);
      if (destExisted && !overwrite) {
        return {
          ok: false,
          error: `${dst.relative} already exists. Pass overwrite: true if replacing it is what you mean — a move that silently `
            + 'overwrote a file would destroy work nobody asked about.',
        };
      }
      if (destExisted) {
        let dstat;
        try { dstat = statSync(dst.absolute); } catch (err) {
          return { ok: false, error: `could not inspect ${dst.relative} before overwriting it: ${describeFsError(err)}` };
        }
        /**
         * ⚠️ Same fix as `writeFile`'s, and it matters more here: a move that
         * lands on a directory is nearly always a `to` that names the FOLDER
         * rather than the destination file, and the message has to say so or the
         * retry is the identical call.
         */
        if (dstat.isDirectory()) {
          return {
            ok: false,
            error: `${dst.relative} is a directory, so nothing was moved — "to" must name the destination FILE,`
              + ` e.g. {"from":"${src.relative}","to":"${dst.relative}/${basename(src.relative)}"}.`,
          };
        }
      }

      // ⚠️ Same placement as writeFile: after every check, before any I/O. A
      // preview that skipped validation would be a preview of a different
      // command.
      if (dryRun) {
        return { ok: true, from: src.relative, to: dst.relative, bytes: stat.size, replaced: destExisted, dryRun: true };
      }

      /**
       * ⭐ TWO ENTRIES, BOTH BEFORE THE MOVE, AND THAT IS A COMPLETE UNDO.
       * `delete` on the source snapshots its bytes — the journal reads the file
       * as a BUFFER, so this works for the binary and large files that are the
       * whole reason this verb exists. `write` on the destination records that
       * it did not exist, so a rewind removes it. Recorded before, because
       * afterwards the source is gone.
       */
      note({ verb: 'delete', path: src.relative, absolute: src.absolute, after: null });
      note({ verb: 'write', path: dst.relative, absolute: dst.absolute, after: null });

      try {
        mkdirSync(dirname(dst.absolute), { recursive: true });
        renameSync(src.absolute, dst.absolute);
      } catch (err) {
        const code = err && typeof err === 'object' ? /** @type {{ code?: unknown }} */ (err).code : undefined;
        /**
         * ⚠️ EXDEV IS NOT HYPOTHETICAL INSIDE ONE WORKSPACE. A subdirectory can
         * be a mount point or a junction on another volume, and `rename` across
         * devices fails outright. Copy-then-unlink is the standard fallback and
         * it is ordered so a failed copy leaves the source untouched.
         */
        if (code === 'EXDEV') {
          try {
            copyFileSync(src.absolute, dst.absolute);
            unlinkSync(src.absolute);
          } catch (err2) {
            return { ok: false, error: `could not move ${src.relative} to ${dst.relative} across devices: ${describeFsError(err2)}` };
          }
          return { ok: true, from: src.relative, to: dst.relative, bytes: stat.size, replaced: destExisted };
        }
        return { ok: false, error: `could not move ${src.relative} to ${dst.relative}: ${describeFsError(err)}` };
      }
      return { ok: true, from: src.relative, to: dst.relative, bytes: stat.size, replaced: destExisted };
    },

    /** @param {unknown} [path] @returns {ListOk | ToolFailure} */
    listDir(path = '.') {
      // '.' is the workspace root, and `normalizeRelativePath` deliberately
      // refuses the empty segment list — so the root is special-cased HERE
      // rather than by weakening the rule that a path must name something.
      const wantsRoot = typeof path !== 'string' || path.trim() === '' || path.trim() === '.' || path.trim() === './';
      let absolute = realRoot;
      let relative = '.';
      if (!wantsRoot) {
        const r = resolveInWorkspace(realRoot, path, 'read');
        if (!r.ok) return { ok: false, error: r.reason };
        absolute = r.absolute;
        relative = r.relative;
      }
      let names;
      try {
        names = readdirSync(absolute);
      } catch (err) {
        /**
         * ⚠️ THIS CATCH USED TO SAY "no such directory" FOR EVERY FAILURE,
         * including a directory that demonstrably exists and that the account
         * simply may not read, and including a path that is a FILE.
         *
         * ⭐ A model told a path does not exist does not investigate — it
         * invents a plausible name and writes there instead. So the lie is the
         * defect and the missing branch is only its cause; three different
         * facts were being reported as one, and only one of them was true.
         */
        const code = err && typeof err === 'object' ? /** @type {{ code?: unknown }} */ (err).code : undefined;
        if (code === 'EACCES' || code === 'EPERM') {
          return { ok: false, error: `could not list ${relative}: permission denied — the directory exists but this account cannot read it. List its parent instead, or work somewhere else in the tree.` };
        }
        if (code === 'ENOTDIR') {
          return { ok: false, error: `${relative} is a file, not a directory — use read_file` };
        }
        /**
         * ⚠️ THE COMMENT ABOVE ALREADY DIAGNOSED THIS — "a model told a path
         * does not exist does not investigate, it invents a plausible name and
         * writes there instead" — and then left the true branch with no way out
         * either. Listing the parent is the move that ends the invention, so it
         * is named rather than hoped for.
         */
        const parent = relative === '.' ? null : (dirname(relative) === '.' ? '.' : dirname(relative));
        return {
          ok: false,
          error: `no such directory: ${relative}`
            + (parent === null ? '' : ` — list_dir {"path":"${parent}"} shows what is actually there;`)
            + ' do not invent a path and write into it.',
        };
      }
      const entries = [];
      for (const name of names.sort()) {
        if (entries.length >= MAX_LIST_ENTRIES) break;
        // Noise the model should never spend context on. Not a safety rule —
        // `.git` is still READABLE by name if it is genuinely asked for.
        if (name === 'node_modules' || name === '.git' || name === '.next') {
          entries.push({ name, type: 'dir', skipped: true });
          continue;
        }
        let stat;
        try {
          stat = statSync(join(absolute, name));
        } catch {
          continue; // a broken symlink or a file that vanished mid-listing
        }
        entries.push({ name, type: stat.isDirectory() ? 'dir' : 'file', bytes: stat.isDirectory() ? undefined : stat.size });
      }
      return { ok: true, path: relative, entries, truncated: names.length > MAX_LIST_ENTRIES };
    },
  };
}
