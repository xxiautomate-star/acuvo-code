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

import { realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync} from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';

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
  if (unified.startsWith('/')) return { ok: false, reason: 'absolute path' };
  if (/^[A-Za-z]:/.test(unified)) return { ok: false, reason: 'absolute path with a drive letter' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(unified)) return { ok: false, reason: 'URL, not a path' };

  // `.` is a no-op segment and is dropped; `..` is the attack and is refused.
  // Conflating the two cost `generated-files.ts` a test — models write `./x.css`
  // constantly because that is how the href reads in the HTML they just emitted.
  const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return { ok: false, reason: 'path resolves to the workspace root itself' };
  if (segments.length > MAX_DEPTH) return { ok: false, reason: `path deeper than ${MAX_DEPTH} directories` };
  for (const s of segments) {
    if (s === '..') return { ok: false, reason: 'path escapes the workspace with ".."' };
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
export function createLocalExecutor(root, { dryRun = false, claimPath = null } = {}) {
  const realRoot = realpathSync(resolve(root));

  return {
    root: realRoot,
    dryRun,

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
          return { ok: false, error: `could not read ${r.relative}: permission denied` };
        }
        return { ok: false, error: `no such file: ${r.relative}` };
      }
      if (stat.isDirectory()) return { ok: false, error: `${r.relative} is a directory — use list_dir` };
      if (stat.size > MAX_READ_BYTES) {
        return { ok: false, error: `${r.relative} is ${stat.size} bytes, over the ${MAX_READ_BYTES}-byte read limit` };
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
        if (raw.includes(0)) return { ok: false, error: `${r.relative} looks binary, refusing to read it as text` };
        return {
          ok: false,
          error: `${r.relative} is not valid UTF-8, so it will not be read as text. `
            + 'Decoding it would replace every undecodable byte with U+FFFD, and writing that back would destroy those bytes permanently.',
        };
      }
      if (content.includes('\u0000')) return { ok: false, error: `${r.relative} looks binary — refusing to read it as text` };
      return { ok: true, path: r.relative, content, bytes: stat.size };
    },

    /** @param {unknown} path @param {unknown} content @returns {WriteOk | ToolFailure} */
    writeFile(path, content) {
      // ⚠️ FIRST, before the size and path checks — the reason this path is
      // refused has nothing to do with how big or well-formed the content is.
      const leash = agentWriteRefusal(path);
      if (leash) return { ok: false, error: leash };
      if (typeof content !== 'string') return { ok: false, error: 'content must be a string' };
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        return { ok: false, error: `refusing to write ${bytes} bytes (limit ${MAX_WRITE_BYTES})` };
      }
      const r = resolveInWorkspace(realRoot, path, 'write');
      if (!r.ok) return { ok: false, error: r.reason };
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
        if (stat.isDirectory()) return { ok: false, error: `${r.relative} is a directory` };
        previousBytes = stat.size;
      }
      /**
       * ⚠️ DRY RUN STOPS HERE, NOT EARLIER. Every safety check above has already
       * run, so `--dry-run` reports exactly the refusals a real run would — a
       * preview that skipped validation would be a preview of a different
       * command, which is the only way a dry run can lie.
       */
      if (dryRun) return { ok: true, path: r.relative, bytes, previousBytes, created: !existed, dryRun: true };
      try {
        mkdirSync(dirname(r.absolute), { recursive: true });
        writeFileSync(r.absolute, content, 'utf8');
      } catch (err) {
        return { ok: false, error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, path: r.relative, bytes, previousBytes, created: !existed };
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
        return { ok: false, error: `no such directory: ${relative}` };
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
