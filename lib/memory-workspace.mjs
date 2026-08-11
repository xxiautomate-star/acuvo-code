/**
 * ── ⭐ THE SECOND EXECUTOR — ONE LOOP, TWO CLIENTS, FINALLY REAL ─────────────
 *
 * "One registry, two clients" has been the stated architecture for weeks. It was
 * measured on 2026-08-09 and found to be fiction: the CLI has 13 verbs, the
 * console has 153 tools, and the overlap is ZERO. Two forked registries sharing
 * a doctrine paragraph.
 *
 * ⭐ AND IT EXPLAINS THE PEER GAP. We generate a PAGE where Manus/Replit/Base44
 * generate an APPLICATION, and the cause is not the model — it is that the
 * builder has no write→run→fix loop. It cannot run what it wrote, so it cannot
 * fix what it wrote. The CLI has exactly that loop and it works: 7/7 on the
 * bench, and it went 5/7 → 7/7 with NO MODEL CHANGE, purely on loop fixes.
 *
 * ⚠️ SO THE ANSWER IS NOT A SECOND LOOP. Forking `turn.mjs` for the browser is
 * how we got here. This file is the other half of the seam: the SAME
 * `runSession` gets an executor whose disk is a Map instead of a filesystem.
 *
 *   CLI      → createLocalExecutor(dir)      → real files, child_process
 *   BUILDER  → createMemoryExecutor({...})   → a file MAP, Modal sandbox
 *
 * ── ⚠️ WHY THE BUILDER'S WORKSPACE IS A MAP AND NOT A TEMP DIRECTORY ────────
 * A browser session has no disk of its own, and giving each one a server-side
 * temp directory would mean per-tenant cleanup, disk quotas and a new class of
 * path-escape bug on a multi-tenant box. The generated files already live in
 * memory (see `generated-files.ts`), and `runInSandbox` takes exactly
 * `Record<string, string>` — so the natural representation is the one both ends
 * already speak. Nothing is written to the server's disk, ever.
 *
 * ── ⚠️ THE DEPENDENCY DIRECTION IS DELIBERATE ───────────────────────────────
 * This module does NOT import the Modal sandbox, or anything from console/. It
 * takes a `runCommand` function. `acuvo-code/` stays zero-dependency and
 * runnable on its own; the console injects the sandbox when it constructs the
 * executor. Importing upward would make the CLI depend on Next.js, which is how
 * a shared core stops being shareable.
 */

import { normalizeRelativePath } from './workspace.mjs';

/** Mirrors the local executor's ceiling so the two agree about what is too big. */
export const MAX_MEMORY_FILE_BYTES = 512 * 1024;
/**
 * ⚠️ A TOTAL CAP, WHICH THE LOCAL EXECUTOR DOES NOT NEED. A real disk pushes
 * back; a Map on a shared server does not, and an agent in a loop writing
 * megabytes per round is a memory leak with a plausible explanation.
 */
export const MAX_MEMORY_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_MEMORY_FILES = 400;

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/**
 * An executor whose filesystem is a Map<string, string>.
 *
 * @param {{
 *   files?: Record<string, string>,
 *   dryRun?: boolean,
 *   runCommand?: (command: string, files: Record<string, string>) => Promise<any>,
 * }} [opts]
 */
export function createMemoryExecutor({ files = {}, dryRun = false, runCommand = null } = {}) {
  /** @type {Map<string, string>} */
  const disk = new Map();
  for (const [path, content] of Object.entries(files)) {
    const norm = normalizeRelativePath(path);
    // A malformed seed path is dropped rather than thrown: the caller is often
    // handing over model-generated filenames, and one bad name must not take
    // down a session that could still do useful work with the rest.
    if (norm.ok && typeof content === 'string') disk.set(norm.path, content);
  }

  const totalBytes = () => [...disk.values()].reduce((a, c) => a + bytes(c), 0);

  return {
    /**
     * ⚠️ A LABEL, NOT A PATH. The local executor's `root` is a real directory
     * and several call sites `join()` with it. Nothing may do that here, so it
     * is deliberately not path-shaped — a silent `join('(memory)', x)` producing
     * a relative path that half-works is worse than an obvious break.
     */
    root: '(memory)',
    dryRun,
    /** ⭐ How the caller gets the work back out — the whole point of the run. */
    snapshot() { return Object.fromEntries(disk); },

    readFile(path) {
      const r = normalizeRelativePath(path);
      if (!r.ok) return { ok: false, error: r.reason };
      if (!disk.has(r.path)) return { ok: false, error: `no such file: ${r.path}` };
      const content = disk.get(r.path);
      return { ok: true, path: r.path, content, bytes: bytes(content) };
    },

    writeFile(path, content) {
      const r = normalizeRelativePath(path);
      if (!r.ok) return { ok: false, error: r.reason };
      if (typeof content !== 'string') return { ok: false, error: 'content must be a string' };
      const size = bytes(content);
      if (size > MAX_MEMORY_FILE_BYTES) {
        return { ok: false, error: `${r.path} would be ${size} bytes, over the ${MAX_MEMORY_FILE_BYTES}-byte limit` };
      }
      const existed = disk.has(r.path);
      const previousBytes = existed ? bytes(disk.get(r.path)) : 0;
      if (!existed && disk.size >= MAX_MEMORY_FILES) {
        return { ok: false, error: `this workspace already holds ${disk.size} files, the maximum` };
      }
      if (totalBytes() - previousBytes + size > MAX_MEMORY_TOTAL_BYTES) {
        return { ok: false, error: `that write would take the workspace over its ${MAX_MEMORY_TOTAL_BYTES}-byte total` };
      }
      // ⚠️ A dry run must not mutate, but must still report what WOULD happen —
      // same contract as the local executor, or the two clients diverge in the
      // one mode where a user is deliberately being careful.
      if (!dryRun) disk.set(r.path, content);
      return { ok: true, path: r.path, bytes: size, created: !existed, previousBytes, dryRun };
    },

    deleteFile(path) {
      const r = normalizeRelativePath(path);
      if (!r.ok) return { ok: false, error: r.reason };
      if (!disk.has(r.path)) return { ok: false, error: `no such file: ${r.path} — nothing was deleted` };
      const size = bytes(disk.get(r.path));
      if (!dryRun) disk.delete(r.path);
      return { ok: true, path: r.path, bytes: size, dryRun };
    },

    /**
     * A Map has no directories, so they are DERIVED from the path segments.
     * ⚠️ The shape must match the local executor's exactly — `{ name, type,
     * bytes }` — because `gatherWorkspaceContext` walks it and would otherwise
     * silently produce an empty tree for the builder while working for the CLI.
     */
    listDir(path = '.') {
      let prefix = '';
      if (path && path !== '.' && path !== './') {
        const r = normalizeRelativePath(path);
        if (!r.ok) return { ok: false, error: r.reason };
        prefix = `${r.path}/`;
      }
      const seen = new Map();
      for (const [p, content] of disk) {
        if (prefix && !p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, { name: rest, type: 'file', bytes: bytes(content) });
        else {
          const dir = rest.slice(0, slash);
          if (!seen.has(dir)) seen.set(dir, { name: dir, type: 'dir' });
        }
      }
      if (prefix && seen.size === 0) return { ok: false, error: `no such directory: ${path}` };
      return {
        ok: true,
        path: prefix ? prefix.slice(0, -1) : '.',
        entries: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
      };
    },

    /**
     * ⭐ THE HALF THAT MAKES IT A BUILDER AND NOT A GENERATOR.
     *
     * Injected, never imported — see the header. The console passes a function
     * that ships `snapshot()` to the Modal sandbox; a test passes a stub; the
     * CLI never constructs this executor at all.
     *
     * ⚠️ AND WHEN IT IS ABSENT THE ANSWER IS AN HONEST REFUSAL, not a fake pass.
     * A builder whose "run" silently succeeds without running is the exact
     * dead-button failure this codebase keeps re-learning: the model believes
     * its code is verified, says so, and ships something nobody executed.
     */
    async runCommand(command) {
      if (typeof runCommand !== 'function') {
        return { ok: false, error: 'no sandbox is configured for this workspace, so nothing can be run or verified here' };
      }
      return runCommand(command, Object.fromEntries(disk));
    },

    hasRunner: typeof runCommand === 'function',
  };
}
