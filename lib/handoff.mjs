/**
 * ── ⭐⭐ THE HANDOFF — A HELPER THAT *IMPLEMENTS*, NOT ONLY ONE THAT READS ────
 *
 * `subagent.mjs` shipped delegation with a lock on it: twelve READ verbs, and
 * `allowRun: false` as a second lock. Its own header states the reason, and the
 * reason is TECHNICAL rather than moral:
 *
 *   *"A subagent that writes can collide with the parent editing the same file,
 *   and whoever finishes second wins silently. `parallel.mjs` exists to catch
 *   exactly that between processes and is blind to it here, because these run
 *   INSIDE one session."*
 *
 * ⭐ THAT IS AN UNFINISHED CAPABILITY, NOT A SAFETY BOUNDARY — and the blocker
 * it names is already solved twice in this package. `best-of.mjs` runs three
 * attempts in `mkdtemp` copies of the workspace and applies the winner's own
 * change list back (`best-of.mjs:162 applyAttempt`). `parallel.mjs` decides
 * which files a record touched and refuses to pretend when two agents touched
 * one. This file is those two ideas joined, so a helper can WRITE:
 *
 *   1. it works in an isolated COPY, so it cannot race the parent at all;
 *   2. every file it changed is re-applied THROUGH THE PARENT'S EXECUTOR;
 *   3. a file that changed underneath us between the copy and the apply is
 *      REFUSED BY NAME, never silently overwritten.
 *
 * ── ⭐⭐ WHY THROUGH THE EXECUTOR AND NOT `cpSync` ──────────────────────────
 *
 * `best-of.mjs:179` applies with `cpSync`, which is right there — it runs from
 * `bin/`, after the session, with no executor in scope. Copying here would have
 * been three lines and would have walked around FOUR guarantees that this
 * package sells:
 *
 *   · **leases** — `createLocalExecutor(root, { claimPath })` claims each path
 *     (`workspace.mjs:625`). A raw copy claims nothing, so the fleet's
 *     file-level locking would be blind to every byte a helper wrote.
 *   · **`--dry-run`** — `writeFile` stops at `workspace.mjs:653` and reports
 *     what it WOULD do. A raw copy would make `--dry-run` a lie the moment the
 *     model delegated.
 *   · **the `.acuvo/` leash** — `agentWriteRefusal` (`workspace.mjs:610`) is on
 *     the executor method, deliberately and with a comment saying so.
 *   · **containment** — `resolveInWorkspace` refuses `..`, drive letters, UNC
 *     and symlink escapes.
 *
 * ⭐ So the apply path is `executor.writeFile` / `executor.deleteFile`: the
 * same door the parent's own tools use, and therefore the same guards. The
 * helper gets a capability; it does not get an exemption.
 *
 * ── ⚠️ THE COLLISION CHECK IS A CONTENT HASH, AND IT HAD TO BE ──────────────
 *
 * The cheap version compares byte LENGTH — `writeFile` already computes
 * `previousBytes` (`workspace.mjs:645`), so it is free. It is also wrong for
 * the most common edit there is: another terminal changing a line without
 * changing the file's size. A check that cannot see the ordinary case is worse
 * than no check, because it is quoted as if it saw it.
 *
 * ⭐ So the baseline is a SHA-256 per file, taken from the copy the instant it
 * is made — which is byte-identical to the workspace at that instant. We have
 * already paid to read every one of those bytes in order to copy them; reading
 * them once more is the same order of magnitude and buys an exact answer.
 */

import { createHash } from 'node:crypto';
import {
  cpSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { COPY_SKIP_DIRS, MAX_COPY_BYTES, measureWorkspace } from './best-of.mjs';
import { changedPaths } from './changed-paths.mjs';
import { resolveInWorkspace } from './workspace.mjs';

/**
 * SHA-256 of one file, or `null` when it is not there.
 *
 * ⚠️ ABSENCE IS A VALUE, NOT AN ERROR. "the file does not exist" and "the file
 * exists with these bytes" are both states the collision check compares, and
 * conflating absence with failure would make a helper's freshly CREATED file
 * look like a collision with something.
 */
export function fileHash(absolute, { read = readFileSync } = {}) {
  try {
    return createHash('sha256').update(read(absolute)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Hash every file under `root`, keyed by the same '/'-separated relative path
 * `resolveInWorkspace` returns — so the two halves of the comparison cannot
 * disagree about how a path is spelled on Windows.
 *
 * ⚠️ THE SAME SKIP SET THE COPY USED. Hashing `node_modules` would cost more
 * than the whole feature saves, and nothing under it can be written by a
 * helper anyway: `resolveInWorkspace(..., 'write')` refuses it outright
 * (`workspace.mjs:330`).
 */
export function hashTree(root, { skip = COPY_SKIP_DIRS } = {}) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
      } else if (e.isFile()) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const h = fileHash(join(dir, e.name));
        if (h) map.set(rel, h);
      }
    }
  };
  walk(root, '');
  return map;
}

/** How many refusals to spell out before summarising the rest. */
const MAX_NAMED_REFUSALS = 6;

/**
 * Re-apply everything a helper changed in its copy, into the real workspace.
 *
 * @param {{
 *   copyRoot: string,
 *   executor: any,
 *   outcome: any,
 *   baseline: Map<string, string>,
 * }} args
 * ── ⭐⭐ IT REPORTS `written[{path,bytes,previousBytes,created}]`, WHICH IS NOT
 * A NEW SHAPE — IT IS `write_files`' SHAPE (`write-many.mjs:128`) ────────────
 *
 * My first version returned `applied: string[]`, and a REAL RUN showed why that
 * was wrong. The end-of-run summary printed:
 *
 *     1 file written:
 *       replaced  src/calc.test.mjs  (0 bytes)
 *
 * for a file that was CREATED and was 510 bytes. `report.mjs:describeChange`
 * reads `result.bytes` and `result.created` off a record, finds neither on a
 * bare string list, and falls through to "replaced, 0 bytes" — confidently
 * wrong in a place people trust. ⭐ `tools.mjs:989` records this exact class
 * happening before ("a new tool whose result shape differs from write_file's
 * breaks every downstream reader that assumed one shape"), and I did it again.
 *
 * ⭐ So a built handoff reports the SAME shape a bulk write already reports,
 * and every reader that learned it once gets this for free — including
 * `changed-paths.mjs`, which needs no delegate-specific arm at all.
 *
 * @returns {{ written: {path:string,bytes:number,previousBytes:number,created:boolean,deleted?:boolean}[],
 *             refused: {path:string, why:string}[], problems: string[] }}
 */
export function applyHandoff({ copyRoot, executor, outcome, baseline }) {
  const written = [];
  const refused = [];
  const problems = [];
  const seen = new Set();

  for (const record of outcome?.executed ?? []) {
    for (const raw of changedPaths(record)) {
      /**
       * ⚠️ RESOLVED AGAINST THE COPY, WITH THE PACKAGE'S OWN PATH LAYER. The
       * path is a string a model wrote; `best-of.mjs:171` hand-rolls four
       * checks for this and misses UNC, control characters and symlink
       * escapes. `resolveInWorkspace` is the audited version and it is right
       * here.
       */
      const src = resolveInWorkspace(copyRoot, raw, 'read');
      if (!src.ok) { problems.push(`${raw}: ${src.reason}`); continue; }
      const rel = src.relative;

      /**
       * ⚠️ ONCE PER PATH, AND THE DISK IS THE TRUTH. A helper that wrote a
       * file three times leaves three records; only the final state in the
       * copy is what "apply" means, and that is what `existsSync` below reads.
       */
      if (seen.has(rel)) continue;
      seen.add(rel);

      /**
       * ── ⚠️⚠️ THE COLLISION CHECK ────────────────────────────────────────
       *
       * `was` is the file's content at the instant the copy was taken; `now`
       * is its content in the real workspace at the instant we are about to
       * overwrite it. Equal means nobody touched it while the helper worked
       * and applying is safe. Different means SOMEBODY ELSE — another
       * terminal, the user's editor, a watcher — changed it, and overwriting
       * would be the silent loss `subagent.mjs:24` refused to ship.
       *
       * ⭐ REFUSED BY NAME, AND THE HELPER'S VERSION IS STILL DESCRIBED in
       * the summary the parent reads. Refusing silently would be its own
       * version of the same failure.
       */
      const was = baseline.get(rel) ?? null;
      const now = fileHash(join(executor.root, ...rel.split('/')));
      if (was !== now) {
        refused.push({
          path: rel,
          why: was === null
            ? 'something else created this file while the helper was working'
            : now === null
              ? 'something else deleted this file while the helper was working'
              : 'this file changed in the workspace while the helper was working',
        });
        continue;
      }

      if (!existsSync(src.absolute)) {
        // The helper deleted it. Deleting it here is what "apply" means.
        // ⭐ Through the executor, so the lease is claimed and `--dry-run` holds.
        const d = executor.deleteFile(rel);
        if (d?.ok) {
          written.push({ path: rel, bytes: 0, previousBytes: d.bytes ?? 0, created: false, deleted: true });
        } else {
          problems.push(`${rel}: ${d?.error ?? 'delete failed'}`);
        }
        continue;
      }

      let content;
      try {
        content = readFileSync(src.absolute, 'utf8');
      } catch (err) {
        problems.push(`${rel}: could not read it back from the helper's copy: ${String(err?.message ?? err)}`);
        continue;
      }
      /**
       * ⚠️ THE SAME BINARY TEST `workspace.mjs:602` USES. A file read as UTF-8
       * and written back is corrupted if it was not text, and it would be
       * corrupted SILENTLY — the write succeeds and reports a byte count.
       */
      if (content.includes('\u0000')) {
        problems.push(`${rel}: looks binary — refusing to copy it back as text`);
        continue;
      }

      const w = executor.writeFile(rel, content);
      if (w?.ok) {
        /**
         * ⭐ THE EXECUTOR ALREADY COMPUTED EVERY FIELD THE SUMMARY NEEDS —
         * `created` and `previousBytes` are decided at `workspace.mjs:632-645`
         * BEFORE the write, which is the only moment they are knowable. Passing
         * them straight through is why the summary can say "created … 510
         * bytes" instead of the "replaced … 0 bytes" it printed on the first
         * real run.
         */
        written.push({
          path: w.path ?? rel,
          bytes: w.bytes ?? 0,
          previousBytes: w.previousBytes ?? 0,
          created: w.created === true,
        });
      } else {
        problems.push(`${rel}: ${w?.error ?? 'write failed'}`);
      }
    }
  }

  return { written, refused, problems };
}

/**
 * Copy the workspace, run something in the copy, apply what it changed.
 *
 * `run(copyRoot)` resolves to a SessionDone-shaped outcome. Injected so this
 * module never imports the turn loop — it is a mechanism, not a second engine,
 * exactly as `best-of.mjs` is.
 *
 * ⚠️ THE COPY IS ALWAYS REMOVED, including when `run` threw. Three abandoned
 * workspace copies per invocation is how a temp directory becomes a disk
 * problem nobody connects back to this feature — `best-of.mjs:285` learned that
 * and it applies identically here.
 */
export async function runInIsolatedCopy({
  root,
  executor,
  run,
  maxBytes = MAX_COPY_BYTES,
  makeTempDir = () => mkdtempSync(join(tmpdir(), 'acuvo-handoff-')),
  copyDir = cpSync,
  removeDir = rmSync,
  hash = hashTree,
  /**
   * ── ⭐⭐ THE ONE THING THAT MADE "THE HELPER MAY VERIFY" IMPOSSIBLE ─────────
   *
   * `subagent.mjs` passed `allowRun: false` in BOTH modes, and its reason was
   * this file's `COPY_SKIP_DIRS`: the copy has no `node_modules`, so `npm test`
   * in there fails with "Cannot find module" — a verification that fails for a
   * reason that has nothing to do with the code, which the parent would act on.
   * That reasoning was CORRECT and it was an argument about the COPY, not about
   * the helper. So the copy is what changes.
   *
   * ⭐ A LINK, NOT A COPY. Duplicating `node_modules` per delegation is exactly
   * why `COPY_SKIP_DIRS` skips it (hundreds of megabytes, thousands of files),
   * and this needs none of that: a symlink (a JUNCTION on Windows, which needs
   * no elevation) makes the same directory reachable at the same relative path
   * for the cost of one inode.
   *
   * ── ⚠️⚠️ THE DELETE, WHICH IS THE THING THAT COULD HAVE GONE VERY WRONG ────
   *
   * `finally` below runs `removeDir(copyRoot, { recursive: true })`, and a
   * recursive delete that FOLLOWED the link would destroy the user's real
   * `node_modules`. MEASURED on this machine (Windows, Node 22.17) before the
   * code was written: a junction is removed as a link, `precious.txt` inside the
   * real directory survived, and `lstatSync().isSymbolicLink()` is true. Node's
   * `rmSync` unlinks rather than descends. That is not an assumption anyone
   * should carry — it is the reason this comment cites a measurement.
   *
   * ⚠️ AND IT IS NOT A NEW CAPABILITY CLASS. The PARENT already runs `npm test`
   * in the real workspace with the real `node_modules` on the default surface;
   * a helper running the allowlisted set inside a copy that reaches the same
   * directory is a subset of exposure that already exists. What it is NOT is a
   * write path: `resolveInWorkspace(..., 'write')` refuses `node_modules`, the
   * baseline hash skips it, and `npm install` is refused without
   * `ACUVO_ALLOW_INSTALL`.
   *
   * ⚠️ OPT-IN AND FAIL-SOFT. Default false, so every existing caller copies
   * exactly what it copied before; and if the link cannot be made the run
   * continues WITHOUT it and reports `dependenciesLinked: false`, because a
   * helper that cannot run `npm test` is worse than a helper, not worse than
   * nothing.
   */
  linkNodeModules = false,
  linkDir = symlinkSync,
}) {
  const size = measureWorkspace(root, { limit: maxBytes });
  if (size.overLimit) {
    return {
      ok: false,
      error: `this workspace holds more than ${Math.round(maxBytes / 1024 / 1024)}MB of files that would have to be copied `
        + 'for a writing helper to work in isolation. Do this part yourself, or point --dir at the subdirectory the task actually touches.',
    };
  }

  let copyRoot = null;
  try {
    copyRoot = makeTempDir();
    copyDir(root, copyRoot, {
      recursive: true,
      // ⚠️ `dereference: false` — a symlink copied as its target silently
      // doubles a workspace and breaks any code that checks `isSymbolicLink`.
      dereference: false,
      force: true,
      filter: (src) => {
        const rel = relative(root, src);
        if (rel === '') return true;
        return !rel.split(sep).some((part) => COPY_SKIP_DIRS.has(part));
      },
    });

    /**
     * ⚠️ AFTER THE COPY AND BEFORE THE BASELINE. After, so `cpSync`'s filter
     * never sees it and cannot be asked to walk into the real dependency tree;
     * before, so anything the helper does is bracketed by a hash that already
     * knows the layout it worked against. `hashTree` skips `node_modules`
     * itself, so the link contributes nothing to the collision check — which is
     * right: a file in there is not a file the helper is allowed to change.
     */
    let dependenciesLinked = false;
    if (linkNodeModules) {
      const from = join(root, 'node_modules');
      if (existsSync(from)) {
        try {
          // 'junction' on Windows because a 'dir' symlink needs Developer Mode
          // or elevation there, and a capability that only works for
          // administrators is not a capability.
          linkDir(from, join(copyRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
          dependenciesLinked = true;
        } catch {
          // Degraded, not fatal — and SAID SO in the return value, because a
          // helper that silently could not run its tests would report success
          // it never had.
        }
      }
    }

    /**
     * ⭐ TAKEN FROM THE COPY, NOT THE ORIGINAL, AND THE DIFFERENCE MATTERS.
     * The copy is frozen the moment `copyDir` returns; the original is not,
     * and hashing it afterwards would race the very writes this check exists
     * to catch — a file changed between the copy and the hash would be
     * baselined in its NEW state and then overwritten as if nothing happened.
     */
    const baseline = hash(copyRoot);

    const outcome = await run(copyRoot);
    const { written, refused, problems } = applyHandoff({ copyRoot, executor, outcome, baseline });
    return { ok: true, outcome, written, refused, problems, copiedFiles: size.files, dependenciesLinked };
  } catch (err) {
    return { ok: false, error: `the isolated workspace failed: ${err?.message ?? String(err)}` };
  } finally {
    if (copyRoot) { try { removeDir(copyRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/**
 * One sentence per outcome, for the parent to read.
 *
 * ⚠️ A REFUSAL IS THE HEADLINE, not a footnote. The parent is about to tell the
 * user the work is done; a file that did NOT land is the one fact that changes
 * what it should say next.
 */
export function describeHandoff({ written = [], refused = [], problems = [] } = {}) {
  const lines = [];
  lines.push(written.length === 0
    ? 'It changed nothing in the workspace.'
    : `Applied to the workspace: ${written.map((w) => (w.deleted ? `${w.path} (deleted)` : w.path)).join(', ')}`);
  if (refused.length > 0) {
    lines.push(`⚠ ${refused.length} change${refused.length === 1 ? ' was' : 's were'} NOT applied because the file moved under us — `
      + refused.slice(0, MAX_NAMED_REFUSALS).map((r) => `${r.path} (${r.why})`).join('; ')
      + (refused.length > MAX_NAMED_REFUSALS ? `; +${refused.length - MAX_NAMED_REFUSALS} more` : '')
      + '. Re-read those files before trusting anything said about them.');
  }
  for (const p of problems.slice(0, MAX_NAMED_REFUSALS)) lines.push(`⚠ ${p}`);
  return lines.join('\n');
}
