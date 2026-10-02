/**
 * ── ⭐⭐⭐ EIGHT SYMBOL VERBS WERE DARK ON A FRESH INSTALL, AND THE PRINTED FIX
 *          NO LONGER WORKS ───────────────────────────────────────────────────
 *
 * `find_definition`, `find_references`, `check_types`, `list_symbols`,
 * `rename_symbol`, `insert_before_symbol`, `insert_after_symbol` and
 * `replace_function_body` are the single largest edge this CLI has over a
 * string-matching agent — and all eight ride one gate in `tools.mjs`:
 *
 *     lspAvailable(root, env) || tsserverAvailable(root)
 *
 * `tsserver.mjs` already closed most of that hole by driving the `typescript`
 * package a project ALREADY HAS. What it cannot do is serve a project that has
 * no `node_modules` at all — a scratch directory, a fresh clone before
 * `npm install`, a plain `.js` folder, or this package, which is zero-dependency
 * by design. Measured 2026-09-19 with the real binary in a scratch TS project
 * (package.json + tsconfig.json + two .ts files, no node_modules):
 *
 *     node bin/acuvo.mjs --doctor      64 of 87 tools · all eight dark
 *
 * ── 🚨 AND THE ADVICE THE DOCTOR HAS BEEN PRINTING IS NOW WRONG ─────────────
 *
 * The dark rows told the user to run `npm i -D typescript-language-server
 * typescript`, and `tsserver.mjs`'s own refusal says `npm i -D typescript`.
 * MEASURED 2026-09-19 against the live registry:
 *
 *     npm install typescript        → typescript@7.0.2
 *     node_modules/typescript/lib/  → getExePath.js  tsc.js  version.cjs
 *                                     …and NO tsserver.js
 *
 * TypeScript 7 is the Go rewrite: it ships a native `tsc.exe` per platform and
 * has dropped the JavaScript `tsserver.js` that `tsserver.mjs` drives and that
 * `typescript-language-server` shells out to. So a user who followed our
 * instruction to the letter got 23MB of the wrong thing and eight tools that
 * stayed dark with no explanation. `lsp.mjs` had already SEEN this — its
 * `workspaceCanBeServed` comment records "the global npm root here holds
 * typescript@7.0.2 … whose lib/ contains no tsserver.js at all" — and the
 * install strings one file over were never updated. Two places disagreeing,
 * again.
 *
 *     npm install typescript@5      → typescript@5.9.3, lib/tsserver.js present
 *                                     23MB, 2.3s wall clock
 *
 * ── ⭐⭐ THE MECHANISM: ONE SERVER PER MACHINE, NOT ONE PER PROJECT ──────────
 *
 * tsserver does not have to live in the tree it serves — that is how VS Code
 * ships its own TypeScript and still answers about a project that has none.
 * PROVEN HERE, not assumed: a tsserver installed in a scratch directory, driven
 * by `lib/tsserver.mjs` against the bare fixture above (which has NO
 * node_modules), answered
 *
 *     definition  main.ts:3:10  → util.ts:1:17        (cross-file, correct)
 *     references  util.ts:1:17  → 3 refs in 2 files   (util.ts:1, main.ts:1, main.ts:3)
 *     navtree     util.ts       → formatPrice:function, TAX:const
 *     semantic diagnostics      → []                  (the fixture typechecks)
 *
 * So one install under the user's own `~/.acuvo/` lights all eight verbs in
 * EVERY TypeScript and JavaScript project on that machine, for ever, and the
 * per-project advice stops being needed at all.
 *
 * ── ⚠️⚠️ WHAT THIS DELIBERATELY DOES **NOT** DO ────────────────────────────
 *
 * 1. **It never installs into the user's project.** `acuvo-dir.mjs` exists
 *    because we once dirtied somebody's git tree with our own bookkeeping and
 *    failed our own bench for it. Writing `node_modules/` and a `package.json`
 *    dependency into a repo we do not own — to enable a feature they did not ask
 *    for — is that defect with a much larger blast radius. Everything lands in
 *    `<accountDir>/language-servers/`, which is under HOME and already where
 *    this package keeps credentials, the engine catalogue and the MCP trust
 *    store.
 *
 * 2. **It never runs on its own.** No first-use auto-install, no background
 *    fetch, no "we noticed you have TypeScript". `mcp-consent.mjs` states the
 *    rule this follows: *"nobody objected is not the same as somebody agreed"*.
 *    Installing 23MB from the network is a decision a person makes, so it is a
 *    command a person types (`acuvo lsp install`), and non-interactively it
 *    fails closed unless `--yes` was passed — the same shape as the MCP gate.
 *
 * 3. **It is not a second package manager.** One package, one pinned major, one
 *    fixed directory. The spec is a CONSTANT in this file and no caller — and
 *    certainly no model — can name a different one. "Which program do we
 *    download" is the same decision as `lsp.mjs`'s "which program do we spawn",
 *    and it gets the same answer: not the model's, and not the workspace's.
 *
 * 4. **It does not cover Python, Rust or Go.** pyright is npm-installable and
 *    would fit here in an afternoon; rust-analyzer and gopls are native
 *    toolchain components that `rustup`/`go install` own, and re-implementing
 *    their distribution would be a worse copy of a thing that already works.
 *    TypeScript/JavaScript is the one where the fix is unambiguous AND the one
 *    where the printed advice was actively broken, so it is the one that ships.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { accountDir } from './account.mjs';
import { findNpmEntry } from './command.mjs';

/** Under `~/.acuvo/`, beside `credentials.json` and `mcp-trust.json`. */
export const MANAGED_DIR = 'language-servers';

/**
 * ⚠️ PINNED TO THE MAJOR, NOT TO `latest` AND NOT TO AN EXACT VERSION.
 *
 * `latest` is what produced the defect this file exists to fix — it resolves to
 * 7.x, which has no `tsserver.js`. An exact pin (`typescript@5.9.3`) would go
 * stale in the package and quietly stop picking up TypeScript's own fixes. `@5`
 * is the last major that ships the server we drive, so it is the honest
 * statement of what we need: *the newest TypeScript that still has a tsserver*.
 *
 * ⚠️ WHEN TYPESCRIPT 7 GROWS A SERVER WE CAN DRIVE, THIS IS THE LINE TO CHANGE
 * — and `tsserver.mjs`'s protocol goes with it. tsgo speaks LSP, not the
 * tsserver protocol, so it would be a `lsp.mjs` registry entry rather than a
 * bump here. Do not change one without the other.
 */
export const MANAGED_TYPESCRIPT_SPEC = 'typescript@5';

/** How long an install may take before we stop waiting. Measured at 2.3s on a warm cache. */
export const INSTALL_TIMEOUT_MS = 180_000;

/** Where the managed servers live for this user. */
export function managedRoot(env = process.env, home = homedir()) {
  return join(accountDir(env, home), MANAGED_DIR);
}

/**
 * The file `tsserver.mjs` spawns, if we have installed one.
 *
 * ⚠️ THE SAME PATH SHAPE `findTsserver` WALKS FOR — `node_modules/typescript/
 * lib/tsserver.js` — so the managed copy is found by the identical predicate as
 * a project-local one and there is no second notion of "a tsserver" anywhere.
 */
export function managedTsserverPath(env = process.env, home = homedir()) {
  return join(managedRoot(env, home), 'node_modules', 'typescript', 'lib', 'tsserver.js');
}

/**
 * The managed tsserver's absolute path, or null.
 *
 * ⚠️ PURE `existsSync`, NO SPAWN, NO CACHE. This runs on the tool-offer path of
 * every multi-round session — the constraint `tsserver.mjs`'s `findTsserver`
 * already states — and a cache would go stale the moment somebody ran
 * `acuvo lsp install` in another terminal.
 */
export function managedTsserver(env = process.env, home = homedir()) {
  try {
    const file = managedTsserverPath(env, home);
    return existsSync(file) && statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * What a person reads before agreeing, and it names all four facts that matter:
 * what is downloaded, from where, to where, and what it will NOT touch.
 *
 * ⭐ THE LAST ONE IS THE POINT. `mcp-consent.mjs` learned that a consent screen
 * describing the wrong action is consent to nothing; the fear anybody has about
 * a CLI offering to run `npm install` is that it is about to edit their project,
 * so the sentence that answers it has to be on the screen.
 */
export function describeInstall({ env = process.env, home = homedir() } = {}) {
  const dir = managedRoot(env, home);
  return [
    '⚠️  Acuvo can install its own copy of TypeScript so that semantic navigation',
    '    works in every project on this machine.',
    '',
    `    downloads   ${MANAGED_TYPESCRIPT_SPEC} from the npm registry (~23 MB)`,
    `    installs to ${dir}`,
    '    runs        node <npm>/bin/npm-cli.js install — no shell, no lifecycle scripts',
    '',
    '    It does NOT write to your project: no node_modules, no package.json change,',
    '    nothing in your git tree. Remove it any time with `acuvo lsp remove`.',
    '',
    '    Unlocks: find_definition · find_references · check_types · list_symbols ·',
    '             rename_symbol · insert_before_symbol · insert_after_symbol ·',
    '             replace_function_body',
  ].join('\n');
}

/**
 * ── ⚠️ `--ignore-scripts` IS NOT OPTIONAL HERE ──────────────────────────────
 *
 * An npm lifecycle script is arbitrary code from the registry running with the
 * user's permissions, which is precisely the thing `mcp-consent.mjs` exists to
 * stop a CONFIG doing. `typescript` has no install scripts, so this costs
 * nothing and closes the door on a compromised transitive dependency doing what
 * the package itself would not.
 *
 * `--no-audit --no-fund` are noise suppression. `--no-package-lock` keeps npm
 * from writing a lockfile into a directory that is ours and has no project.
 * `--prefix` is what makes this land in our directory rather than wherever the
 * shell happens to be.
 */
export function installArgv({ env = process.env, home = homedir(), spec = MANAGED_TYPESCRIPT_SPEC } = {}) {
  return [
    'install', spec,
    '--prefix', managedRoot(env, home),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--loglevel', 'error',
  ];
}

/**
 * Install the managed TypeScript. Resolves; never throws.
 *
 * ⚠️ IT DOES NOT ASK. Consent is the CALLER's job (`bin/acuvo.mjs`), for the
 * same reason `checkMcpConsent` is separate from `mcp.mjs`: a function that both
 * asks and acts cannot be tested without a terminal, and the asking is the half
 * worth testing exhaustively.
 *
 * ⚠️ `npm` IS SPAWNED AS `node .../npm-cli.js`, NEVER AS `npm`. On Windows `npm`
 * is `npm.cmd` and Node refuses to spawn a `.cmd` without `shell: true` — the
 * BatBadBut fix, CVE-2024-27980 — and a shell is not on the table anywhere in
 * this package. `findNpmEntry` is imported from `command.mjs` rather than
 * re-derived, so there is one answer to "where is npm" and it cannot drift.
 */
export async function installManagedTypescript({
  env = process.env,
  home = homedir(),
  spawnImpl = spawn,
  execPath = process.execPath,
  onLine = null,
  timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  const dir = managedRoot(env, home);
  const npm = findNpmEntry('npm-cli.js', execPath);
  if (!npm) {
    return {
      ok: false,
      error: 'npm could not be found next to this node installation, so Acuvo cannot install a language server for you. '
        + `Install TypeScript 5 yourself into your project (npm i -D ${MANAGED_TYPESCRIPT_SPEC}) and the eight symbol tools light up there.`,
    };
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not create ${dir}: ${e?.message ?? e}` };
  }

  const argv = installArgv({ env, home });
  return new Promise((resolveP) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolveP(value); } };

    let child;
    try {
      child = spawnImpl(execPath, [npm, ...argv], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return done({ ok: false, error: `could not start npm: ${e?.message ?? e}` });
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ ok: false, error: `npm did not finish within ${Math.round(timeoutMs / 1000)}s — check your network and try again` });
    }, timeoutMs);

    let stderr = '';
    const line = (s) => { if (typeof onLine === 'function') { try { onLine(s); } catch { /* a reporter must never fail the install */ } } };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (d) => line(String(d)));
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (d) => { stderr += String(d); line(String(d)); });

    child.on?.('error', (e) => { clearTimeout(timer); done({ ok: false, error: `could not start npm: ${e?.message ?? e}` }); });
    child.on?.('exit', (code) => {
      clearTimeout(timer);
      const file = managedTsserver(env, home);
      /**
       * ⚠️⚠️ SUCCESS IS THE FILE EXISTING, NOT THE EXIT CODE. That is the whole
       * lesson of this module's header: `npm install typescript` exits 0 and
       * installs a package with no `tsserver.js` in it. An installer that
       * trusted the exit code would have reported success for the exact failure
       * it was written to fix.
       */
      if (file) return done({ ok: true, file, dir, spec: MANAGED_TYPESCRIPT_SPEC });
      return done({
        ok: false,
        error: code === 0
          ? `npm reported success but ${managedTsserverPath(env, home)} is not there. `
            + `That is what happens when ${MANAGED_TYPESCRIPT_SPEC} resolves to TypeScript 7, which ships no tsserver.js.`
          : `npm exited ${code}: ${stderr.trim().slice(0, 500) || 'no output'}`,
      });
    });
  });
}

/**
 * Delete the managed install.
 *
 * ⭐ IT EXISTS BECAUSE THE CONSENT SCREEN PROMISES IT. An install a person
 * cannot undo from the same tool that offered it is not a reversible decision,
 * and saying "remove it any time" while shipping no way to do so would be the
 * kind of prose this repository keeps finding as its own top defect.
 */
export function removeManaged({ env = process.env, home = homedir() } = {}) {
  const dir = managedRoot(env, home);
  if (!existsSync(dir)) return { ok: true, removed: false, dir };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, removed: true, dir };
  } catch (e) {
    return { ok: false, removed: false, dir, error: e?.message ?? String(e) };
  }
}

/** One object describing what is installed — for `acuvo lsp status` and the doctor. */
export function managedStatus({ env = process.env, home = homedir() } = {}) {
  const file = managedTsserver(env, home);
  return {
    installed: file !== null,
    file,
    dir: managedRoot(env, home),
    spec: MANAGED_TYPESCRIPT_SPEC,
  };
}
