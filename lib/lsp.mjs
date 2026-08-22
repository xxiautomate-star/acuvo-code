/**
 * ── ⭐⭐ LSP — THE AGENT STOPS GREPPING AND STARTS KNOWING ────────────────────
 *
 * Every navigation verb in this package is a TEXT verb. `search_text` finds the
 * string `handleClick`; it cannot tell the definition from the eleven call sites
 * from the word in a comment, and it silently misses the one that was imported
 * under another name. A model handed that list has to guess, and guessing is
 * what burns rounds.
 *
 * A language server already knows. It has parsed the project, resolved the
 * imports and built the symbol table — and on most developer machines one is
 * already installed, because their editor needs it. So this is the rare
 * capability where the expensive part is somebody else's and we only have to
 * ask.
 *
 * ── ⭐ WHY IT IS CHEAP FOR US SPECIFICALLY ──────────────────────────────────
 * LSP is JSON-RPC over a child process's stdio, which is exactly what
 * `mcp.mjs` already speaks. Its child-process lifecycle, its stderr tail, its
 * "a broken server is data, never a throw" rule and its Windows spawn
 * archaeology are all reused here deliberately. Read that file alongside this
 * one; the differences are the interesting part, and there are four:
 *
 *   1. ⚠️ **THE FRAMING IS BYTE-LENGTH, NOT NEWLINE.** MCP delimits messages
 *      with `\n` and can therefore buffer a decoded STRING. LSP prefixes each
 *      message with `Content-Length: N`, counted in BYTES. Buffering a string
 *      would be a real corruption bug rather than a style difference: a
 *      multi-byte character split across two `data` events decodes to two
 *      replacement characters, and thereafter every byte offset in the stream
 *      is wrong. So this file buffers `Buffer`s and never calls `setEncoding`.
 *   2. ⚠️ **THE SERVER SENDS US REQUESTS.** MCP servers only answer. A language
 *      server asks the client for configuration and to register capabilities,
 *      and some of them BLOCK until answered — an unanswered `client/…` request
 *      is a hang that looks exactly like a slow project scan. So there is a
 *      responder below, and unknown methods get a proper JSON-RPC
 *      MethodNotFound rather than silence.
 *   3. ⚠️ **DOCUMENTS GO STALE, AND THIS AGENT EDITS FILES.** The server answers
 *      from the copy of the document IT holds, not from disk. Open a file, let
 *      the model rewrite it, ask again, and you get diagnostics for the previous
 *      version — a wrong answer that looks completely plausible. Every query
 *      here re-reads the file and sends `didChange` when the bytes differ.
 *   4. ⚠️ **THE CHILD FORKS ITS OWN CHILD.** `typescript-language-server` is a
 *      thin wrapper that runs `tsserver` as a separate process, and tsserver is
 *      the one holding a gigabyte of project graph. `child.kill()` reaches the
 *      wrapper and orphans the expensive half. This machine has been overheated
 *      by exactly that class of leak, so shutdown here is graceful-then-tree-kill
 *      and is wired to `exit` AND to the signals — because an `exit` listener
 *      does not run on Ctrl-C, which `turn.mjs` learned the hard way.
 *
 * ── ⚠️ WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 * No `rename`, no `codeAction`, no `formatting`. Those are WRITES, and a write
 * that arrives as a workspace-edit payload bypasses `edit.mjs` — the diff the
 * user reviews, the size caps, the refusals. Reads first; a write verb needs its
 * own argument.
 *
 * ── ⚠️ READINESS IS TWO QUESTIONS, NOT ONE ─────────────────────────────────
 * "Is the server installed" and "can it serve THIS workspace" are different
 * questions with different answers, and conflating them shipped four tools that
 * fail on first use. See `workspaceCanBeServed` — it carries the measurements.
 *
 * ── ⚠️ AND THE HONEST LIMIT ─────────────────────────────────────────────────
 * A language server is a program the USER installed, spawned from their own
 * project. We do not sandbox it and must not claim to. What is guaranteed is
 * that nothing is spawned except a server from this file's fixed registry,
 * found at a path we resolved ourselves — a model cannot name the program, only
 * the file it wants to know about.
 */

import { spawn } from 'node:child_process';
import { exitIsDeferred } from './interrupt.mjs';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, extname, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { detachChild } from './child-lifetime.mjs';

import { resolveInWorkspace } from './workspace.mjs';

/**
 * ── BOUNDS ──────────────────────────────────────────────────────────────────
 * Each one exists because the failure it prevents is either silent or expensive.
 */
/** tsserver cold-starting on a large monorepo is genuinely slow; a minute is not. */
export const HANDSHAKE_TIMEOUT_MS = 30_000;
/** A resolved query is milliseconds. Twenty seconds means something is wedged. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** How long to wait for push diagnostics after a document changes. */
export const DIAGNOSTICS_TIMEOUT_MS = 15_000;
/**
 * ⚠️ tsserver publishes an EMPTY diagnostic set the instant a file opens and the
 * real one a beat later. Returning the first would report "no problems" for a
 * file full of them — the most dangerous lie this module could tell. So after
 * the first publish we wait this long for a revision and take the last.
 */
export const DIAGNOSTICS_QUIET_MS = 600;
/** Time given to a polite `shutdown` before the tree is killed. */
export const SHUTDOWN_GRACE_MS = 2_000;
/** A single LSP message larger than this is a runaway, not a response. */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
/** A document we are willing to hand a server in full. */
export const MAX_OPEN_DOC_BYTES = 2_000_000;

/**
 * ── ⚠️ THE CAPS ARE THE POINT, NOT HOUSEKEEPING ─────────────────────────────
 * A raw `textDocument/references` response for a common symbol is tens of
 * thousands of tokens of JSON — ranges, URIs, nesting — of which the model needs
 * a path, a line and enough text to recognise the site. React's `useState` in a
 * real app returns hundreds of locations. Uncapped, one navigation call costs
 * more than the entire rest of the round and can exceed the context window
 * outright, which is not a slow answer but no answer at all.
 */
export const MAX_LOCATIONS = 25;
export const MAX_DIAGNOSTICS = 30;
export const MAX_SYMBOLS = 80;
/** Same 200 characters `search.mjs` clamps a match line to, for the same reason. */
export const EXCERPT_MAX_CHARS = 200;
export const MAX_DIAGNOSTIC_CHARS = 300;

/**
 * ── THE SERVER REGISTRY ─────────────────────────────────────────────────────
 *
 * ⚠️ FIXED, AND NOT READ FROM ANY FILE A MODEL CAN WRITE. `mcp.mjs` can take its
 * server list from a config because a HUMAN authors that config and can review
 * it. There is no equivalent here and there must not be: "which program do we
 * spawn" is the one decision a language model never gets to make.
 *
 * `package` servers ship as npm packages and are started by running their own
 * JavaScript entry point with the `node` we are already running — the only
 * Windows-safe way, proven in `mcp.mjs` (`.cmd` shims cannot be spawned without
 * a shell since CVE-2024-27980, and a shell is not on the table). `binary`
 * servers are native executables found on PATH.
 *
 * ⭐ `workspace` (only `typescript` has one) is the SECOND half of readiness —
 * see `workspaceCanBeServed` below. Three of the four servers ship everything
 * they need: pyright bundles its own type checker, and rust-analyzer and gopls
 * are single static binaries. `typescript-language-server` is the odd one out
 * because it is not a language server at all — it is a translator in front of
 * `tsserver`, and tsserver ships in a package it does not depend on.
 */
export const LANGUAGE_SERVERS = {
  typescript: {
    label: 'typescript-language-server',
    package: 'typescript-language-server',
    entries: ['lib/cli.mjs', 'lib/cli.js'],
    args: ['--stdio'],
    install: 'npm i -D typescript-language-server typescript',
    /**
     * ⚠️ COPIED FROM THE SERVER'S OWN SOURCE, NOT GUESSED — v5.3.0's
     * `TypeScriptVersionProvider.getWorkspaceVersion()` calls
     * `findPathToModule(workspaceRoot, MODULE_FOLDERS)` and joins `tsserver.js`
     * onto whichever it finds. Mirroring its list rather than inventing one is
     * what keeps this check from being STRICTER than the server it is
     * predicting: the yarn-PnP and pnpify layouts have no `node_modules` at all,
     * and a check that only looked there would withhold four working tools from
     * every PnP repository.
     */
    workspace: {
      moduleFolders: ['node_modules/typescript/lib', '.vscode/pnpify/typescript/lib', '.yarn/sdks/typescript/lib'],
      probe: 'tsserver.js',
      /** Named in the refusal, because "did not initialize" teaches nobody anything. */
      fix: 'npm i -D typescript',
      needs: 'the `typescript` package (it drives `tsserver`; it does not contain one)',
    },
    extensions: {
      '.ts': 'typescript',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.jsx': 'javascriptreact',
    },
  },
  python: {
    label: 'pyright-langserver',
    package: 'pyright',
    entries: ['langserver.index.js', 'dist/pyright-langserver.js'],
    args: ['--stdio'],
    install: 'npm i -D pyright',
    extensions: { '.py': 'python', '.pyi': 'python' },
  },
  rust: {
    label: 'rust-analyzer',
    binary: 'rust-analyzer',
    args: [],
    install: 'rustup component add rust-analyzer',
    extensions: { '.rs': 'rust' },
  },
  go: {
    label: 'gopls',
    binary: 'gopls',
    // Bare `gopls` serves LSP on stdio; `serve` is the same thing spelled out.
    args: [],
    install: 'go install golang.org/x/tools/gopls@latest',
    extensions: { '.go': 'go' },
  },
};

/**
 * @typedef {{ ok: false, error: string, missing?: boolean }} LspRefused
 * @typedef {{ path: string, line: number, column: number, excerpt: string }} LspLocation
 * @typedef {{ ok: true, kind: string, path: string, count: number, shown: number, truncated: boolean, locations: LspLocation[] }} LspLocations
 */

/** Which server handles this file, by extension. Null when nothing does. */
export function languageForFile(path) {
  const ext = extname(String(path ?? '')).toLowerCase();
  if (!ext) return null;
  for (const [language, spec] of Object.entries(LANGUAGE_SERVERS)) {
    if (spec.extensions[ext]) return language;
  }
  return null;
}

/** The `languageId` the server expects in `didOpen` — NOT the same as our key
 *  ('.tsx' is 'typescriptreact', and a server that is told 'typescript'
 *  silently mis-parses JSX). */
export function languageIdForFile(path) {
  const ext = extname(String(path ?? '')).toLowerCase();
  for (const spec of Object.values(LANGUAGE_SERVERS)) {
    if (spec.extensions[ext]) return spec.extensions[ext];
  }
  return null;
}

/**
 * Walk up from the workspace looking for `node_modules`. Monorepos hoist, so the
 * server a project depends on is very often two or three levels above the
 * directory the CLI was pointed at.
 */
function nodeModulesDirs(root) {
  const out = [];
  let dir = resolve(root);
  for (let i = 0; i < 6; i += 1) {
    out.push(join(dir, 'node_modules'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // The global install, last — a project-local server matches the project's own
  // TypeScript version, and a global one is a fallback, never a preference.
  const appData = process.env.APPDATA;
  if (appData) out.push(join(appData, 'npm', 'node_modules'));
  if (process.env.HOME) out.push(join(process.env.HOME, '.npm-global', 'lib', 'node_modules'));
  out.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  return out;
}

/**
 * Find a native executable on PATH.
 *
 * ⚠️ ON WINDOWS A `.cmd` HIT IS A MISS. Node refuses to spawn `.cmd`/`.bat`
 * without `shell: true` (the BatBadBut fix, CVE-2024-27980), and `shell: true`
 * is not available to us for the reasons `mcp.mjs` documents at length. Finding
 * one and reporting "installed" would produce an EINVAL from a path that
 * demonstrably exists, which is the hardest kind of failure to diagnose. So it
 * is reported as what it is: present, unusable, here is the way round it.
 */
export function resolveOnPath(command, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    // Extensions before the bare name: `mcp.mjs` shipped the other order for one
    // commit and resolved to an extensionless bash script Windows cannot run.
    for (const ext of process.platform === 'win32' ? [...exts, ''] : ['']) {
      const candidate = join(dir, command + ext);
      try {
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      } catch { continue; /* unreadable PATH entry */ }
      const lower = candidate.toLowerCase();
      if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
        return { ok: false, shim: candidate };
      }
      return { ok: true, file: candidate };
    }
  }
  return null;
}

/**
 * Every directory from `root` up to the filesystem root.
 *
 * ⚠️ UNBOUNDED ON PURPOSE (past a sanity stop), because
 * `typescript-language-server` is unbounded: its `findPathToModule` recurses to
 * `/`. `nodeModulesDirs` above stops at six levels, which is right for "where
 * might a server be installed" and WRONG here — a check that gave up two levels
 * before the server does would report "cannot serve" for a deep monorepo the
 * server serves perfectly, and withholding four working tools is the more
 * expensive of the two mistakes.
 */
function ancestors(from, max = 64) {
  const out = [];
  let dir = resolve(from);
  for (let i = 0; i < max; i += 1) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * ── ⚠️⚠️ THE READINESS LIE: INSTALLED ≠ ABLE TO SERVE THIS WORKSPACE ────────
 *
 * MEASURED ON THIS MACHINE, 2026-08-15, with `typescript-language-server`
 * installed globally:
 *
 *   · `console/`     → discovery said yes, and `list_symbols` returned 8 real
 *                      symbols with kinds and line numbers.
 *   · `acuvo-code/`  → discovery said yes, and every verb died on the handshake:
 *                      *"Could not find a valid TypeScript installation."*
 *
 * Same binary, same machine, opposite outcomes — because discovery only ever
 * asked whether the SERVER EXECUTABLE was findable. `typescript-language-server`
 * is a translator in front of `tsserver`, and tsserver ships inside the
 * `typescript` package, which it does not depend on (v5.3.0's package.json
 * declares no `dependencies` and no `peerDependencies` at all). acuvo-code is
 * zero-dependency BY DESIGN and has no `node_modules`, so that server can never
 * serve it — not today, not after any amount of retrying.
 *
 * The cost of the lie is not the failed call. It is that the model was OFFERED
 * four tools, spent a round on one, was told something that reads like a broken
 * install, and learned that semantic navigation does not work here. Four dead
 * buttons are worse than no buttons, which is the same lesson `tools.mjs`
 * already records for the language-not-spoken half of this gate.
 *
 * ── WHAT IT ACTUALLY NEEDS — MEASURED, NOT ASSUMED ─────────────────────────
 * Four real spawns against real temp workspaces, 2026-08-15:
 *
 *   | tsconfig.json | node_modules/typescript | result                |
 *   |---------------|-------------------------|-----------------------|
 *   | yes           | no                      | ❌ did not initialize |
 *   | no            | yes                     | ✅ 1 symbol           |
 *   | yes           | yes                     | ✅ 1 symbol           |
 *   | no            | no                      | ❌ did not initialize |
 *
 * ⭐ So the answer to "a typescript install, or a tsconfig, or both" is
 * NEITHER OF THE GUESSES: the `typescript` package alone, and a `tsconfig.json`
 * is worth exactly nothing to initialization. That matters, because tsconfig is
 * the intuitive thing to check for and checking it would have produced a gate
 * that is wrong in both directions at once.
 *
 * ── ⭐ AND THAT IS WHY THIS STAYS SPAWN-FREE ────────────────────────────────
 * The brief asked what to do if an honest answer needs a spawn — cache it, or
 * probe lazily on first use and degrade with a good message. The research made
 * the question moot, and that is the best available outcome: what the server
 * needs is a FILE, so predicting it is `existsSync`, exactly as cheap as the
 * dishonest version it replaces. `lspAvailable`'s promise that it "spawns
 * nothing" survives intact, with no cache to go stale after an `npm install`
 * and no first-call round spent discovering the truth.
 *
 * ⚠️ THE HONEST LIMIT: this predicts the server's own lookup rather than
 * performing it, so it can still be wrong if the server changes its resolution
 * order. It is deliberately biased toward YES — every path the server would try
 * is tried here, so the failure mode is "we allowed a start that fails", i.e.
 * exactly today's behaviour, never "we withheld a capability that worked".
 *
 * @param {string} root workspace directory
 * @param {string} language registry key
 * @param {{ serverFile?: string|null }} opts `serverFile` is the server's own
 *   entry point, used to emulate its bundled fallback. Optional; omitting it
 *   only makes the answer more conservative.
 */
export function workspaceCanBeServed(root, language, { serverFile = null } = {}) {
  const spec = LANGUAGE_SERVERS[language];
  // No stated requirement = nothing to check. pyright, rust-analyzer and gopls
  // bring their own everything; saying "ready" for them is not a lie.
  if (!spec?.workspace) return { ok: true, source: 'self-contained' };
  if (typeof root !== 'string' || root === '') return { ok: true, source: 'unknown-root' };

  const need = spec.workspace;
  try {
    for (const dir of ancestors(root)) {
      for (const folder of need.moduleFolders) {
        const candidate = join(dir, ...folder.split('/'), need.probe);
        try {
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            return { ok: true, source: 'workspace', via: candidate };
          }
        } catch { /* unreadable level on the way up */ }
      }
    }
  } catch { /* an unresolvable root is not this function's failure to report */ }

  /**
   * ⭐ THE BUNDLED FALLBACK, and it is not theoretical — it is the server's last
   * resort (`bundledVersion()`: `require.resolve('typescript')` from its own
   * location, then `tsserver.js` beside the entry point). Emulating it with the
   * real `createRequire` rather than a hand-rolled walk is the point: node's
   * resolution has rules (scoped dirs, `exports` maps, symlink realpaths) that a
   * reimplementation gets subtly wrong, and being wrong HERE means withholding a
   * capability that works.
   *
   * ⚠️ MEASURED, and it is why acuvo-code still fails: the global npm root here
   * holds `typescript@7.0.2`, whose `require.resolve` lands on `lib/version.cjs`
   * — and whose `lib/` contains no `tsserver.js` at all, because TypeScript 7 is
   * the Go rewrite and ships `tsgo` instead. A globally-installed `typescript`
   * therefore does NOT rescue a workspace, and a check that assumed it did would
   * have gone on offering four dead buttons while looking rigorous.
   */
  if (serverFile) {
    try {
      const req = createRequire(pathToFileURL(serverFile));
      const main = req.resolve('typescript');
      const bundled = join(dirname(main), need.probe);
      if (existsSync(bundled) && statSync(bundled).isFile()) {
        return { ok: true, source: 'bundled', via: bundled };
      }
    } catch { /* not resolvable from there, which is the common case */ }
  }

  return {
    ok: false,
    error: [
      `${spec.label} is installed but cannot serve ${root}: it needs ${need.needs},`,
      `and there is none in this workspace or any directory above it.`,
      `THE FIX IS ONE COMMAND, run in this workspace: ${need.fix}.`,
      // ⚠️ Named explicitly because it is the intuitive wrong answer, and a
      // model that adds a tsconfig will be told the same thing again.
      `A tsconfig.json does NOT satisfy this — measured; only the package does.`,
      `Until then use search_text to find the symbol and read_file to read around it,`,
      `and do not call the ${language} navigation tools again in this run.`,
    ].join(' '),
  };
}

/**
 * Where is this language's server, if anywhere — AND can it serve this root?
 *
 * ⚠️ NEVER THROWS, AND "NOT INSTALLED" IS THE EXPECTED ANSWER. Most machines
 * have a server for one language and none for the rest. The refusal text is
 * written for a model: it names the install command AND names the fallback,
 * because an error that only says no is an error that gets retried.
 *
 * ⚠️ BOTH HALVES BY DEFAULT, and this is a behaviour change with teeth: this
 * function is what `tools.mjs`'s `lspAvailable` consults, so tightening it here
 * closes the readiness lie everywhere at once with no wiring. `require-
 * WorkspaceSupport: false` exists for the caller that genuinely only wants
 * "is the program on this machine" — `doctor`, a fixture — and for nothing else.
 */
export function discoverLanguageServer(root, language, { env = process.env, requireWorkspaceSupport = true } = {}) {
  const spec = LANGUAGE_SERVERS[language];
  if (!spec) {
    return {
      ok: false,
      error: `no language server is configured for "${language}". This tool covers ${Object.keys(LANGUAGE_SERVERS).join(', ')}; for anything else use search_text and read_file.`,
    };
  }
  /**
   * ⚠️ FOUND BY THE READINESS TEST, AND IT PREDATES IT: `nodeModulesDirs` calls
   * `resolve(root)`, which THROWS on `undefined` — "The paths[0] argument must
   * be of type string". It never surfaced because the one caller,
   * `lspAvailable`, wraps the whole thing in a try/catch, so a latent crash was
   * being absorbed by somebody else's defensiveness. Any new caller would have
   * got the throw. This function's contract is "never throws"; make it true here
   * rather than hope every caller keeps guarding.
   */
  if (typeof root !== 'string' || root === '') {
    return { ok: false, missing: true, error: `${spec.label}: no workspace directory was given, so there is nothing to check. Semantic navigation needs a real project root.` };
  }

  if (spec.package) {
    /**
     * ⚠️ THE WORKSPACE CHECK RUNS PER CANDIDATE AND A FAILURE DOES NOT STOP THE
     * SEARCH. The bundled fallback depends on WHICH install we found, so a
     * project-local server whose sibling `typescript` exists must still win
     * after a global one without it was seen first. Only the first failure is
     * remembered, so the message names a real install rather than the last one
     * tried.
     */
    let blocked = null;
    for (const modules of nodeModulesDirs(root)) {
      for (const entry of spec.entries) {
        const candidate = join(modules, spec.package, ...entry.split('/'));
        try {
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            const servable = requireWorkspaceSupport
              ? workspaceCanBeServed(root, language, { serverFile: candidate })
              : { ok: true, source: 'unchecked' };
            if (!servable.ok) {
              if (!blocked) blocked = { ok: false, missing: true, unservable: true, error: servable.error };
              continue;
            }
            return {
              ok: true,
              language,
              label: spec.label,
              // Our own node, running the server's own JS. No shim, no PATH
              // lookup of anything but the interpreter already running.
              file: process.execPath,
              argv: [candidate, ...spec.args],
              via: candidate,
              tsserverFrom: servable.via ?? null,
            };
          }
        } catch { /* unreadable directory on the way up */ }
      }
    }
    if (blocked) return blocked;
  }

  if (spec.binary) {
    const found = resolveOnPath(spec.binary, env);
    if (found?.ok) {
      // ⭐ A no-op for every server in the registry today (none of the native
      // binaries declares a `workspace` requirement) — present so the field
      // means the same thing on both branches. A future binary server that DOES
      // need something in the tree gets the honest gate for free rather than
      // reintroducing the lie on the branch nobody remembered to update.
      const servable = requireWorkspaceSupport
        ? workspaceCanBeServed(root, language, { serverFile: found.file })
        : { ok: true, source: 'unchecked' };
      if (!servable.ok) return { ok: false, missing: true, unservable: true, error: servable.error };
      return { ok: true, language, label: spec.label, file: found.file, argv: [...spec.args], via: found.file, tsserverFrom: servable.via ?? null };
    }
    if (found?.shim) {
      return {
        ok: false,
        missing: true,
        error: `${spec.label} was found at ${found.shim}, but Node cannot start a .cmd shim without a shell and this agent never uses one. Install the package into the project instead (${spec.install}) so it can be started directly. Meanwhile search_text and read_file still work.`,
      };
    }
  }

  return {
    ok: false,
    missing: true,
    error: `${spec.label} is not installed, so semantic navigation is unavailable for ${language} on this machine. Install it with: ${spec.install}. Do not call this tool again for ${language} in this run — use search_text to find the symbol and read_file to read around it.`,
  };
}

/**
 * ── THE WIRE ────────────────────────────────────────────────────────────────
 * `Content-Length: N\r\n\r\n<N bytes of JSON>`.
 */
export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Pull as many complete messages as the buffer holds.
 *
 * ⚠️ THE CONTRACT IS "GIVE ME BYTES, ANY BYTES". A TCP-ish stream splits
 * wherever it likes: mid-header, mid-JSON, mid-CHARACTER. Every test in
 * `lsp.test.mjs` that feeds this one byte at a time exists because getting it
 * subtly wrong is invisible on a fast local server and corrupt under load —
 * which is to say, invisible until it matters.
 *
 * Returns `{ messages, rest, error }`. An `error` means the stream can no longer
 * be trusted; the caller tears the connection down rather than resynchronising,
 * because there is no framing marker to resynchronise ON.
 */
export function decodeMessages(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      // A header this long is not a header. Refuse to buffer forever.
      if (rest.length > 8 * 1024) return { messages, rest, error: 'no message header in the first 8KB of the stream' };
      return { messages, rest };
    }
    const header = rest.subarray(0, headerEnd).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) return { messages, rest, error: `message header has no Content-Length: ${JSON.stringify(header.slice(0, 120))}` };
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
      return { messages, rest, error: `refusing a ${length}-byte message (limit ${MAX_MESSAGE_BYTES})` };
    }
    const start = headerEnd + 4;
    if (rest.length < start + length) return { messages, rest }; // the body has not all arrived
    const body = rest.subarray(start, start + length).toString('utf8');
    rest = rest.subarray(start + length);
    try {
      messages.push(JSON.parse(body));
    } catch (err) {
      // One unparseable body does not have to poison the stream: the framing
      // told us exactly where it ended, so the next message is still findable.
      messages.push({ __parseError: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * ⚠️ THE SERVER-TO-CLIENT REQUESTS THAT MUST BE ANSWERED.
 *
 * A language server is a peer, not a service. It will ask the client to register
 * capabilities and — if we advertise it — for configuration, and several servers
 * WAIT for the reply. An unanswered request presents as the server never
 * finishing its startup scan, i.e. as our timeout, i.e. as "the server is
 * broken". Answering minimally is what keeps that from happening.
 */
function answerServerRequest(msg) {
  switch (msg.method) {
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
      return { result: null };
    case 'workspace/configuration':
      // One null per requested item: "no opinion, use your defaults."
      return { result: (msg.params?.items ?? [null]).map(() => null) };
    case 'workspace/applyEdit':
      // ⚠️ Refused on purpose. A server-driven write would bypass edit.mjs and
      // land on disk with no diff and no size cap. See the header.
      return { result: { applied: false, failureReason: 'this client is read-only' } };
    default:
      return { error: { code: -32601, message: `acuvo-code does not implement ${msg.method}` } };
  }
}

function createRpc(child, { onNotification, onBroken }) {
  let nextId = 1;
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let broken = null;

  const failAll = (why) => {
    broken = why;
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      entry.resolve({ error: { message: why } });
    }
    if (onBroken) onBroken(why);
  };

  // ⚠️ NO setEncoding. See the header: the framing is counted in bytes.
  child.stdout.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    const { messages, rest, error } = decodeMessages(buffer);
    buffer = rest;
    for (const msg of messages) {
      if (msg.__parseError) continue;
      if (msg.id !== undefined && msg.method) {
        // A request FROM the server.
        const answer = answerServerRequest(msg);
        try { child.stdin.write(encodeMessage({ jsonrpc: '2.0', id: msg.id, ...answer })); } catch { /* dying */ }
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        entry.resolve(msg);
        continue;
      }
      if (msg.method && onNotification) onNotification(msg);
    }
    if (error) failAll(`the language server's output could not be framed (${error})`);
  });

  return {
    get broken() { return broken; },
    failAll,
    request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (broken) return Promise.resolve({ error: { message: broken } });
      const id = nextId++;
      return new Promise((res) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          res({ error: { message: `${method} got no answer in ${Math.round(timeoutMs / 1000)}s` } });
        }, timeoutMs);
        /**
         * ⚠️ DELIBERATELY REF'D, and this line is load-bearing. The server's
         * stdio is unref'd (see child-lifetime.mjs), so an IDLE server no longer
         * holds the process open — which is the whole point. But that removes
         * the last anchor while a request is in flight too, and Node then
         * decides the loop is empty and settles with the promise still pending:
         * `Promise resolution is still pending but the event loop has already
         * resolved`. Measured — it broke twelve tests in this file.
         *
         * So the invariant is: an idle helper never holds the process, a
         * REQUEST does. This timer is that anchor, it is bounded by
         * REQUEST_TIMEOUT_MS, and every resolution path clears it.
         */
        pending.set(id, { resolve: (m) => { clearTimeout(timer); res(m); } });
        try {
          child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          res({ error: { message: `could not write to the language server: ${err?.message ?? err}` } });
        }
      });
    },
    notify(method, params) {
      if (broken) return;
      try { child.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params })); } catch { /* dying anyway */ }
    },
  };
}

/**
 * ── ⚠️ THE CHILD MUST DIE, AND `child.kill()` IS NOT ENOUGH ─────────────────
 *
 * `typescript-language-server` forks `tsserver`; `pyright-langserver` forks
 * workers. Killing the pid we hold leaves the expensive process running with a
 * dead parent — a true orphan that survives until reboot, which is exactly the
 * leak that has been cooking this laptop.
 *
 * This is `command.mjs`'s `killProcessTree`, reimplemented rather than imported
 * because that one is module-private there and this file may not edit it. The
 * duplication is deliberate and is noted so a later reader does not "tidy" one
 * of them away: if `command.mjs` ever exports it, delete this.
 */
function killProcessTree(child) {
  const pid = child?.pid;
  if (typeof pid !== 'number' || pid <= 0) {
    try { child?.kill?.('SIGKILL'); } catch { /* already gone */ }
    return;
  }
  if (process.platform === 'win32') {
    try {
      const reaper = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', shell: false });
      reaper.on('error', () => { /* taskkill missing, or the pid already went */ });
      if (typeof reaper.unref === 'function') reaper.unref();
    } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * ── THE PROCESS-LIFETIME REGISTRY ───────────────────────────────────────────
 * Same shape as `turn.mjs`'s MCP registry, and for the same two measured
 * reasons: a listener registered per session leaks one per turn, and an `exit`
 * listener does not fire on a signal. A language server that outlives Ctrl-C is
 * the single most expensive thing this file could leave behind.
 */
const liveSessions = new Set();
let hooksInstalled = false;

function installLifecycleHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // ⚠️ SYNCHRONOUS on 'exit' — nothing async runs there, so the polite
  // `shutdown` handshake is not an option and the tree kill is all there is.
  process.once('exit', () => { for (const s of [...liveSessions]) hardStop(s); });
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149]]) {
    try {
      process.on(sig, () => {
        for (const s of [...liveSessions]) hardStop(s);
        // ⚠️ The language servers are killed either way; only the exit waits.
        // See lib/interrupt.mjs — a first Ctrl-C asks the run to stop cleanly
        // so its session and audit line survive.
        if (!exitIsDeferred()) process.exit(code);
      });
    } catch { /* signal not supported on this platform */ }
  }
}

function hardStop(session) {
  liveSessions.delete(session);
  session.stopped = true;
  try { killProcessTree(session.child); } catch { /* already gone */ }
}

/** Windows compares paths case-insensitively, and servers echo URIs back with
 *  their own drive-letter casing and percent-encoding. Match on the real path. */
function uriKey(uri) {
  let path;
  try { path = fileURLToPath(uri); } catch { path = String(uri); }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * Start a server and complete the handshake.
 *
 * `server` and `spawnImpl` are injection seams for tests and for nothing else —
 * ⚠️ no tool schema reaches them, so a model can never name the program. The
 * normal path calls `discoverLanguageServer` itself, two lines down.
 */
export async function startLanguageServer(root, {
  language,
  server = null,
  spawnImpl = spawn,
  env = process.env,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
} = {}) {
  let realRoot;
  try {
    realRoot = resolve(root);
    if (!statSync(realRoot).isDirectory()) return { ok: false, error: `not a directory: ${root}` };
  } catch {
    return { ok: false, error: `workspace directory does not exist: ${root}` };
  }

  const found = server ?? discoverLanguageServer(realRoot, language, { env });
  if (!found.ok) return found;

  let child;
  try {
    child = spawnImpl(found.file, found.argv, {
      cwd: realRoot,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // POSIX only: makes the child a process-group leader so `kill(-pid)` can
      // reach what IT forked. On Windows `taskkill /T` does the same job.
      ...(process.platform === 'win32' ? {} : { detached: true }),
    });
  } catch (err) {
    return { ok: false, error: `could not start ${found.label}: ${err?.message ?? err}` };
  }
  // A failed spawn leaves stdio null and `createRpc` would throw on it — the
  // exact silent crash `mcp.mjs` documents.
  if (!child?.stdout || !child?.stdin) {
    return { ok: false, error: `could not start ${found.label} (no stdio — is ${found.via ?? found.file} really executable?)` };
  }

  /**
   * ⚠️ A language server must not decide when acuvo exits. Without this, any
   * session that touched an LSP hangs at the end with no message — see
   * lib/child-lifetime.mjs for the full account and why unreffing the child
   * alone is not enough.
   */
  detachChild(child);

  let died = null;
  let stderrTail = '';
  child.on('error', (e) => { died = e?.message ?? String(e); });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-800); });

  /** @type {any} */
  const session = {
    ok: true,
    language,
    label: found.label,
    root: realRoot,
    child,
    docs: new Map(),      // real path → { uri, version, text, languageId }
    published: new Map(), // uriKey → { items, seq }
    waiters: new Map(),   // uriKey → [resolve]
    seq: 0,
    stopped: false,
    capabilities: {},
    get stderr() { return stderrTail; },
  };

  session.rpc = createRpc(child, {
    onNotification: (msg) => {
      if (msg.method !== 'textDocument/publishDiagnostics') return;
      const key = uriKey(msg.params?.uri ?? '');
      session.seq += 1;
      session.published.set(key, { items: msg.params?.diagnostics ?? [], seq: session.seq });
      const waiting = session.waiters.get(key);
      if (waiting) { session.waiters.delete(key); for (const w of waiting) w(); }
    },
    onBroken: () => { /* pending calls already rejected; shutdown handles the rest */ },
  });

  child.on('exit', () => {
    session.exited = true;
    session.rpc.failAll(`${found.label} exited${stderrTail ? ` — ${stderrTail.trim().slice(0, 200)}` : ''}`);
    for (const [, waiting] of session.waiters) for (const w of waiting) w();
    session.waiters.clear();
  });

  liveSessions.add(session);
  installLifecycleHooks();

  const init = await session.rpc.request('initialize', {
    processId: process.pid,
    clientInfo: { name: 'acuvo-code', version: '0.2.0' },
    rootUri: pathToFileURL(realRoot).href,
    rootPath: realRoot,
    workspaceFolders: [{ uri: pathToFileURL(realRoot).href, name: 'workspace' }],
    initializationOptions: {},
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
        definition: { dynamicRegistration: false, linkSupport: true },
        references: { dynamicRegistration: false },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        publishDiagnostics: { relatedInformation: false, versionSupport: false },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
      },
      // ⚠️ `configuration: false` on purpose — declaring it invites
      // `workspace/configuration` round-trips we have nothing to say to.
      workspace: { workspaceFolders: true, configuration: false },
      window: { workDoneProgress: false },
      general: { positionEncodings: ['utf-16'] },
    },
  }, handshakeTimeoutMs);

  if (init?.error || died) {
    await stopLanguageServer(session);
    return {
      ok: false,
      // ⭐ stderr is included because a server's real complaint ("Cannot find
      // module 'typescript'") arrives there and never in the RPC error.
      error: `${found.label} did not initialize: ${init?.error?.message ?? died}${stderrTail ? ` — ${stderrTail.trim().slice(0, 300)}` : ''}`,
    };
  }
  session.capabilities = init?.result?.capabilities ?? {};
  session.rpc.notify('initialized', {});
  return session;
}

/**
 * Stop it. Politely, then not.
 *
 * ⚠️ THE POLITE HALF IS NOT MANNERS. `shutdown` is what makes the wrapper stop
 * ITS child; a straight tree-kill usually works too, but on Windows a taskkill
 * that races the fork can miss a grandchild that had not been created yet.
 * Graceful first, grace window, then the tree.
 *
 * ⚠️ AND THE PART THAT IS A TRUST, NOT A GUARANTEE: when the server DOES exit
 * politely we do not tree-kill, because by then there is no tree to walk — on
 * Windows `taskkill /T` needs the parent alive to enumerate its children. So the
 * graceful path relies on the server reaping what it forked, which
 * `typescript-language-server` does (it stops tsserver on `shutdown`; that is
 * what `shutdown` is FOR). The ungraceful path does not trust anything, and
 * `lsp.test.mjs` proves the grandchild dies there.
 */
export async function stopLanguageServer(session, { graceMs = SHUTDOWN_GRACE_MS } = {}) {
  if (!session || session.stopped) return { ok: true, alreadyStopped: true };
  session.stopped = true;
  liveSessions.delete(session);

  const exited = new Promise((res) => {
    if (session.exited) return res(true);
    session.child.once('exit', () => res(true));
    const t = setTimeout(() => res(false), graceMs);
        /** ?? REF'D: stdio is unref'd, so this bounded wait is the only anchor. See child-lifetime.mjs. */
  });

  try {
    // Short timeout: a wedged server is precisely the one that will not answer.
    await session.rpc.request('shutdown', null, Math.min(graceMs, 1_500));
    session.rpc.notify('exit', null);
    try { session.child.stdin.end(); } catch { /* already closed */ }
  } catch { /* it is going to be killed either way */ }

  const wentQuietly = await exited;
  if (!wentQuietly) killProcessTree(session.child);
  return { ok: true, graceful: wentQuietly };
}

/** Every server this process started. Called by the exit hooks, and by tests. */
export async function stopAllLanguageServers() {
  const all = [...liveSessions];
  await Promise.all(all.map((s) => stopLanguageServer(s)));
  sessionCache.clear();
  return all.length;
}

/**
 * ── THE SESSION CACHE ───────────────────────────────────────────────────────
 * tsserver takes seconds to cold-start and then answers in milliseconds. Paying
 * that once per tool call would make semantic navigation slower than grep, which
 * is the one way to make a correct feature useless. Keyed by root+language, and
 * every entry is in `liveSessions`, so the exit hooks still reach it.
 */
const sessionCache = new Map();

export async function getLanguageServer(root, language, opts = {}) {
  const key = `${resolve(root)}::${language}`;
  const existing = sessionCache.get(key);
  if (existing) {
    const settled = await existing;
    if (settled.ok && !settled.stopped && !settled.exited) return settled;
    sessionCache.delete(key);
  }
  const started = startLanguageServer(root, { ...opts, language });
  sessionCache.set(key, started);
  const settled = await started;
  if (!settled.ok) sessionCache.delete(key);
  return settled;
}

/**
 * ── DOCUMENT SYNC ───────────────────────────────────────────────────────────
 * Read the file, open it if new, `didChange` it if the bytes moved.
 *
 * ⚠️ THE `didChange` IS THE WHOLE REASON THIS FUNCTION EXISTS. See header note
 * (3): without it the second question about a file the model just rewrote is
 * answered from the first version, confidently and wrongly.
 */
function syncDocument(session, resolved) {
  let stat;
  try { stat = statSync(resolved.absolute); } catch { return { ok: false, error: `no such file: ${resolved.relative}` }; }
  if (stat.isDirectory()) return { ok: false, error: `${resolved.relative} is a directory — name a source file` };
  if (stat.size > MAX_OPEN_DOC_BYTES) {
    return { ok: false, error: `${resolved.relative} is ${stat.size} bytes, over the ${MAX_OPEN_DOC_BYTES}-byte limit for a document handed to a language server` };
  }
  let text;
  try { text = readFileSync(resolved.absolute, 'utf8'); } catch (err) {
    return { ok: false, error: `could not read ${resolved.relative}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (text.includes('\u0000')) return { ok: false, error: `${resolved.relative} looks binary — a language server cannot parse it` };

  const languageId = languageIdForFile(resolved.relative);
  if (!languageId) return { ok: false, error: `no language server handles ${resolved.relative}` };

  const uri = pathToFileURL(resolved.absolute).href;
  const known = session.docs.get(resolved.absolute);
  if (!known) {
    session.docs.set(resolved.absolute, { uri, version: 1, text, languageId });
    session.rpc.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    return { ok: true, uri, text, changed: true, opened: true };
  }
  if (known.text !== text) {
    known.version += 1;
    known.text = text;
    session.rpc.notify('textDocument/didChange', {
      textDocument: { uri, version: known.version },
      // Full-text sync. Incremental would mean tracking edits we did not make.
      contentChanges: [{ text }],
    });
    return { ok: true, uri, text, changed: true, opened: false };
  }
  return { ok: true, uri, text, changed: false, opened: false };
}

/** One line of a file, trimmed and clamped — the excerpt that makes a
 *  `path:line` recognisable without paying for the file. */
function excerptFrom(text, line1) {
  const lines = String(text).split(/\r?\n/);
  const raw = lines[line1 - 1] ?? '';
  const trimmed = raw.trim();
  return trimmed.length > EXCERPT_MAX_CHARS ? `${trimmed.slice(0, EXCERPT_MAX_CHARS)}…` : trimmed;
}

/**
 * A per-QUERY file cache for excerpts.
 *
 * ⚠️ IT MUST NOT OUTLIVE THE QUERY, and a module-level Map is the obvious
 * version of this that is wrong: 40 references frequently land in the same 3
 * files, so caching inside one call is most of the win — but this agent REWRITES
 * files between calls, and a cache that survived would quote the old line next
 * to the new line number. A stale excerpt is worse than none, because it reads
 * as evidence.
 */
function makeExcerptReader() {
  const cache = new Map();
  return (absolute, line1) => {
    let text = cache.get(absolute);
    if (text === undefined) {
      try {
        text = statSync(absolute).size <= MAX_OPEN_DOC_BYTES ? readFileSync(absolute, 'utf8') : '';
      } catch { text = ''; }
      cache.set(absolute, text);
    }
    return text ? excerptFrom(text, line1) : '';
  };
}

/**
 * ⚠️ THE OFF-BY-ONE THAT WOULD POISON EVERY ANSWER.
 *
 * LSP positions are ZERO-based. Everything a human or a model has in hand is
 * ONE-based: `read_file` prints 1-based line numbers, `search_text` reports
 * 1-based hits, editors count from 1, and a stack trace counts from 1. Taking
 * the model's number straight through would silently ask about the line ABOVE
 * the one it meant — which usually still resolves to something, so the answer
 * comes back looking fine and is wrong.
 *
 * So the public API of this file is 1-based, end to end, and the conversion
 * happens here and nowhere else.
 */
function toLspPosition(line, column) {
  const l = Number(line);
  const c = column === undefined || column === null ? 1 : Number(column);
  if (!Number.isInteger(l) || l < 1) return { ok: false, error: `line must be a whole number ≥ 1 (1-based, as read_file and search_text print them); got ${JSON.stringify(line)}` };
  if (!Number.isInteger(c) || c < 1) return { ok: false, error: `column must be a whole number ≥ 1 (1-based); got ${JSON.stringify(column)}` };
  return { ok: true, position: { line: l - 1, character: c - 1 } };
}

/** LSP `Location | Location[] | LocationLink[] | null` → our flat shape. */
function normalizeLocations(root, result) {
  const raw = result === null || result === undefined ? [] : (Array.isArray(result) ? result : [result]);
  const excerptForPath = makeExcerptReader();
  const out = [];
  for (const item of raw) {
    // A LocationLink names the target differently from a Location. Both are
    // legal answers to the same request, and a server picks based on the
    // `linkSupport` we advertised — so both have to be handled here.
    const uri = item?.uri ?? item?.targetUri;
    const range = item?.range ?? item?.targetSelectionRange ?? item?.targetRange;
    if (!uri || !range) continue;
    let absolute;
    try { absolute = fileURLToPath(uri); } catch { continue; }
    const line = (range.start?.line ?? 0) + 1;
    const column = (range.start?.character ?? 0) + 1;
    // Outside the workspace is legitimate here (a definition in node_modules or
    // in lib.dom.d.ts is often the correct answer), so it is REPORTED rather
    // than refused — but shown relative when it is inside, absolute when not,
    // so the model can tell at a glance whether it can open it.
    const rel = relative(root, absolute);
    const inside = rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel);
    out.push({
      path: inside ? rel.split(sep).join('/') : absolute,
      inWorkspace: inside,
      line,
      column,
      excerpt: excerptForPath(absolute, line),
    });
  }
  return out;
}

function capped(list, max) {
  return { shown: list.slice(0, max), truncated: list.length > max };
}

/**
 * A resolved query target: workspace-relative path in, absolute path plus a
 * synced document out. ⚠️ Every entry point goes through here, so a model can
 * never point a language server at `../../.ssh/config`.
 */
function target(session, root, file) {
  const r = resolveInWorkspace(root, file, 'read');
  if (!r.ok) return { ok: false, error: r.reason };
  const synced = syncDocument(session, r);
  if (!synced.ok) return synced;
  return { ok: true, resolved: r, ...synced };
}

/**
 * ── ⭐ GO TO DEFINITION ─────────────────────────────────────────────────────
 * `root` is the workspace; `file` is workspace-relative; `line`/`column` are
 * 1-BASED, matching everything else the model has seen this session.
 */
export async function definition(root, file, line, column, opts = {}) {
  const pos = toLspPosition(line, column);
  if (!pos.ok) return pos;
  const language = languageForFile(file);
  if (!language) return { ok: false, error: `no language server handles ${file} — this tool covers ${Object.keys(LANGUAGE_SERVERS).join(', ')} files. Use search_text instead.` };
  const session = opts.session ?? await getLanguageServer(root, language, opts);
  if (!session.ok) return session;

  const t = target(session, root, file);
  if (!t.ok) return t;

  const res = await session.rpc.request('textDocument/definition', {
    textDocument: { uri: t.uri },
    position: pos.position,
  }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (res?.error) return { ok: false, error: `${session.label}: ${res.error.message}` };

  const all = normalizeLocations(session.root, res?.result);
  const { shown, truncated } = capped(all, MAX_LOCATIONS);
  if (all.length === 0) {
    return {
      ok: true, kind: 'definition', path: t.resolved.relative, count: 0, shown: 0, truncated: false, locations: [],
      // ⚠️ "No definition" and "you pointed at whitespace" look identical to the
      // caller, and the second is by far the more common. Say so.
      note: `${session.label} found no definition at ${t.resolved.relative}:${line}:${column}. Check the position is on the symbol itself — the column is 1-based and counts characters, not tabs-as-spaces.`,
    };
  }
  return { ok: true, kind: 'definition', path: t.resolved.relative, count: all.length, shown: shown.length, truncated, locations: shown };
}

/**
 * ── ⭐ FIND REFERENCES — the verb grep cannot do ────────────────────────────
 * Every real use of the symbol, including renamed imports, excluding the string
 * that merely spells the same thing.
 */
export async function references(root, file, line, column, opts = {}) {
  const pos = toLspPosition(line, column);
  if (!pos.ok) return pos;
  const language = languageForFile(file);
  if (!language) return { ok: false, error: `no language server handles ${file} — this tool covers ${Object.keys(LANGUAGE_SERVERS).join(', ')} files. Use search_text instead.` };
  const session = opts.session ?? await getLanguageServer(root, language, opts);
  if (!session.ok) return session;

  const t = target(session, root, file);
  if (!t.ok) return t;

  const res = await session.rpc.request('textDocument/references', {
    textDocument: { uri: t.uri },
    position: pos.position,
    context: { includeDeclaration: opts.includeDeclaration !== false },
  }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (res?.error) return { ok: false, error: `${session.label}: ${res.error.message}` };

  const all = normalizeLocations(session.root, res?.result);
  const { shown, truncated } = capped(all, MAX_LOCATIONS);
  return {
    ok: true,
    kind: 'references',
    path: t.resolved.relative,
    count: all.length,
    shown: shown.length,
    truncated,
    locations: shown,
    // ⚠️ SAY THAT YOU TRUNCATED, AND SAY THE REAL TOTAL. A silently shortened
    // list reads as "these are all of them", and a model that believes it will
    // happily change a symbol used in 118 places after checking 25.
    note: truncated
      ? `showing ${shown.length} of ${all.length} references — the rest were cut to stay inside the context budget. Do NOT treat this list as exhaustive; narrow the question or work through it file by file.`
      : null,
  };
}

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' };

/**
 * ── ⭐ REAL TYPE ERRORS, WITHOUT RUNNING THE COMPILER ───────────────────────
 *
 * ⚠️ AND THE ONE PLACE THIS MODULE REFUSES TO GUESS. Diagnostics are mostly
 * PUSHED: the server publishes them when it is ready, on its own schedule. If it
 * has not published yet, the honest answer is "nothing was measured" — reporting
 * an empty list would be the module telling the model the file is clean, which
 * it will act on. That failure is worse than no feature at all, so it is an
 * error with a named alternative instead.
 */
export async function diagnostics(root, file, opts = {}) {
  const language = languageForFile(file);
  if (!language) return { ok: false, error: `no language server handles ${file} — this tool covers ${Object.keys(LANGUAGE_SERVERS).join(', ')} files.` };
  const session = opts.session ?? await getLanguageServer(root, language, opts);
  if (!session.ok) return session;

  const t = target(session, root, file);
  if (!t.ok) return t;
  /**
   * ⚠️ READ THE "HAVE WE GOT ANYTHING?" FLAG *AFTER* THE SYNC, NOT BEFORE.
   * `target` writes `didOpen`/`didChange` synchronously; the reply cannot land
   * before this line, because a `data` event is never emitted inside our own
   * `write`. So anything already in `published` here is genuinely from before —
   * and that is the ONLY thing making the "was it invalidated?" test below
   * meaningful.
   */
  const realKey = uriKey(t.uri);

  let items = null;

  // Pull diagnostics (LSP 3.17) when the server offers them: one request, one
  // answer, no waiting on a publish that may never come.
  if (session.capabilities?.diagnosticProvider) {
    const res = await session.rpc.request('textDocument/diagnostic', {
      textDocument: { uri: t.uri },
    }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    if (!res?.error && res?.result?.kind === 'full') items = res.result.items ?? [];
  }

  if (items === null) {
    const waitMs = opts.diagnosticsTimeoutMs ?? DIAGNOSTICS_TIMEOUT_MS;
    // Wait when the document just moved (whatever is cached describes the old
    // bytes) or when nothing has ever been published for it.
    if (t.changed || !session.published.has(realKey)) {
      await waitForPublish(session, realKey, waitMs);
      // ⚠️ AND THEN WAIT A BEAT MORE. tsserver publishes an empty set the moment
      // a file opens and the real one right after; taking the first is how you
      // report a broken file as clean.
      await settle(session, realKey, opts.quietMs ?? DIAGNOSTICS_QUIET_MS);
    }
    const entry = session.published.get(realKey);
    if (!entry) {
      return {
        ok: false,
        error: `${session.label} published no diagnostics for ${t.resolved.relative} within ${Math.round(waitMs / 1000)}s. That is NOT the same as "no problems" — nothing was measured. Run the project's own type-check with run_command instead, and do not re-call this tool for this file.`,
      };
    }
    items = entry.items;
  }

  const ranked = [...items].sort((a, b) => (a.severity ?? 4) - (b.severity ?? 4) || (a.range?.start?.line ?? 0) - (b.range?.start?.line ?? 0));
  const counts = { error: 0, warning: 0, information: 0, hint: 0 };
  for (const d of ranked) counts[SEVERITY[d.severity ?? 1] ?? 'error'] += 1;
  const { shown, truncated } = capped(ranked, MAX_DIAGNOSTICS);

  return {
    ok: true,
    kind: 'diagnostics',
    path: t.resolved.relative,
    counts,
    count: ranked.length,
    shown: shown.length,
    truncated,
    items: shown.map((d) => ({
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      severity: SEVERITY[d.severity ?? 1] ?? 'error',
      code: d.code ?? null,
      message: String(d.message ?? '').replace(/\s+/g, ' ').slice(0, MAX_DIAGNOSTIC_CHARS),
      excerpt: excerptFrom(t.text, (d.range?.start?.line ?? 0) + 1),
    })),
    note: truncated ? `showing the ${shown.length} most severe of ${ranked.length} problems` : null,
  };
}

/** Resolve on the next `publishDiagnostics` for this URI, or on the timeout —
 *  never reject, because a server that says nothing is a fact the caller has to
 *  report, not an exception it has to catch. */
function waitForPublish(session, key, ms) {
  return new Promise((res) => {
    const list = session.waiters.get(key) ?? [];
    const done = () => { clearTimeout(timer); res(); };
    const timer = setTimeout(() => {
      const current = session.waiters.get(key);
      if (current) session.waiters.set(key, current.filter((f) => f !== done));
      res();
    }, ms);
        /** ?? REF'D: stdio is unref'd, so this bounded wait is the only anchor. See child-lifetime.mjs. */
    list.push(done);
    session.waiters.set(key, list);
  });
}

/** Wait for the publish AFTER the publish, then stop. */
function settle(session, key, quietMs) {
  if (quietMs <= 0) return Promise.resolve();
  return new Promise((res) => {
    const timer = setTimeout(() => {
      const current = session.waiters.get(key);
      if (current) session.waiters.set(key, current.filter((f) => f !== done));
      res();
    }, quietMs);
        /** ?? REF'D: stdio is unref'd, so this bounded wait is the only anchor. See child-lifetime.mjs. */
    const done = () => { clearTimeout(timer); res(); };
    const list = session.waiters.get(key) ?? [];
    list.push(done);
    session.waiters.set(key, list);
  });
}

/** LSP SymbolKind is a number on the wire and useless to a model as one. */
const SYMBOL_KINDS = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method',
  7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface',
  12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 16: 'number',
  17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null',
  22: 'enum-member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type-parameter',
};

/**
 * ── ⭐ THE SHAPE OF A FILE, FOR A FRACTION OF READING IT ────────────────────
 * A 900-line module costs ~12k tokens to read and ~300 to outline. This is how
 * the agent decides WHERE to read.
 */
export async function documentSymbols(root, file, opts = {}) {
  const language = languageForFile(file);
  if (!language) return { ok: false, error: `no language server handles ${file} — this tool covers ${Object.keys(LANGUAGE_SERVERS).join(', ')} files.` };
  const session = opts.session ?? await getLanguageServer(root, language, opts);
  if (!session.ok) return session;

  const t = target(session, root, file);
  if (!t.ok) return t;

  const res = await session.rpc.request('textDocument/documentSymbol', {
    textDocument: { uri: t.uri },
  }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (res?.error) return { ok: false, error: `${session.label}: ${res.error.message}` };

  const flat = [];
  /**
   * ⚠️ TWO INCOMPATIBLE RESPONSE SHAPES FOR ONE REQUEST, and which you get
   * depends on the server: hierarchical `DocumentSymbol[]` (children, `range`)
   * or flat `SymbolInformation[]` (no children, `location.range`). Handling only
   * the first is the common bug — it works perfectly against tsserver and
   * returns an empty outline against half the other servers.
   */
  const walk = (nodes, depth) => {
    for (const n of nodes ?? []) {
      if (flat.length >= MAX_SYMBOLS * 2) return;
      const range = n.range ?? n.location?.range;
      if (!n?.name || !range) continue;
      flat.push({
        name: String(n.name).slice(0, 120),
        kind: SYMBOL_KINDS[n.kind] ?? String(n.kind ?? 'symbol'),
        line: (range.start?.line ?? 0) + 1,
        depth,
        detail: n.detail ? String(n.detail).slice(0, 100) : null,
      });
      if (Array.isArray(n.children) && n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(res?.result, 0);
  flat.sort((a, b) => a.line - b.line || a.depth - b.depth);
  const { shown, truncated } = capped(flat, MAX_SYMBOLS);

  return {
    ok: true,
    kind: 'symbols',
    path: t.resolved.relative,
    count: flat.length,
    shown: shown.length,
    truncated,
    symbols: shown,
    note: truncated ? `showing the first ${shown.length} of ${flat.length} symbols` : null,
  };
}

/**
 * Run one navigation verb and guarantee the server dies afterwards.
 *
 * ⭐ For a caller that wants the capability without owning the lifecycle — a
 * test, a one-shot script, anything that is not the long-lived agent loop.
 */
export async function withLanguageServer(root, language, fn, opts = {}) {
  const session = await startLanguageServer(root, { ...opts, language });
  if (!session.ok) return session;
  try {
    return await fn(session);
  } finally {
    await stopLanguageServer(session);
  }
}

/** Render for the model: compact, and leading with the fact that drives the
 *  next move. Never the raw object — that is the token bill this file exists
 *  to avoid. */
export function formatLspForModel(result) {
  if (!result?.ok) return `lsp: ${result?.error ?? 'unknown failure'}`;
  const lines = [];
  if (result.kind === 'diagnostics') {
    const { error = 0, warning = 0 } = result.counts ?? {};
    lines.push(`${result.path}: ${error} error${error === 1 ? '' : 's'}, ${warning} warning${warning === 1 ? '' : 's'}`);
    for (const d of result.items) lines.push(`  ${d.severity.padEnd(7)} ${result.path}:${d.line}:${d.column}  ${d.message}${d.code ? ` [${d.code}]` : ''}`);
  } else if (result.kind === 'symbols') {
    lines.push(`${result.path}: ${result.count} symbol${result.count === 1 ? '' : 's'}`);
    for (const s of result.symbols) lines.push(`  ${'  '.repeat(s.depth)}${s.kind} ${s.name}  (line ${s.line})`);
  } else {
    lines.push(`${result.kind}: ${result.count} result${result.count === 1 ? '' : 's'}`);
    for (const l of result.locations) lines.push(`  ${l.path}:${l.line}:${l.column}  ${l.excerpt}`);
  }
  if (result.note) lines.push(`  ⚠️ ${result.note}`);
  return lines.join('\n');
}

/**
 * ── THE TOOL SURFACE ────────────────────────────────────────────────────────
 * ⚠️ NOT REGISTERED HERE. `tools.mjs` is owned by another lane; the three-line
 * registration is in this module's report rather than applied, so two agents do
 * not write the same file.
 *
 * The names are chosen for a ROUTER, not for LSP purists: a model picks a tool
 * by reading its name and description, and `find_references` says what it does
 * where `textDocument/references` says where it came from.
 */
export function lspToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'find_definition',
        description: [
          'Jump to where a symbol is actually DEFINED, using the project\'s language server —',
          'imports resolved, aliases followed, the real file even when it is in node_modules.',
          'Use this instead of guessing from search_text: grep finds every line that spells the',
          'name, this finds the one that declares it. Line and column are 1-based, exactly as',
          'read_file and search_text print them; point at the symbol itself.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Workspace-relative source file.' },
            line: { type: 'number', description: '1-based line the symbol appears on.' },
            column: { type: 'number', description: '1-based column of the symbol (default 1).' },
          },
          required: ['file', 'line'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_references',
        description: [
          'Every real use of a symbol across the whole project, from the language server.',
          'This is the check to run BEFORE changing or deleting anything shared — it catches',
          'call sites that search_text cannot, because it follows renamed imports and ignores',
          'the same word in comments and strings. Line and column are 1-based.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Workspace-relative source file.' },
            line: { type: 'number', description: '1-based line the symbol appears on.' },
            column: { type: 'number', description: '1-based column of the symbol (default 1).' },
          },
          required: ['file', 'line'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_types',
        description: [
          'Real type and syntax errors for one file, from the language server, in about a second —',
          'no build, no test run. Call it after editing a file to see whether the edit compiles',
          'before spending a round on run_command. Reports the file as it is ON DISK right now.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: { file: { type: 'string', description: 'Workspace-relative source file.' } },
          required: ['file'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_symbols',
        description: [
          'Outline a file: every class, function, method and exported constant with its line number.',
          'Use this before read_file on anything large — it costs a fraction of the tokens and tells',
          'you which lines are worth reading.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: { file: { type: 'string', description: 'Workspace-relative source file.' } },
          required: ['file'],
        },
      },
    },
  ];
}

/**
 * ── ⚠️ THE WRONG-ARGUMENT MESSAGE THAT NAMED THE WRONG PROBLEM ──────────────
 *
 * These four take `file` + `line` + `column`. A caller that sends `path` +
 * `symbol` — the shape every OTHER search tool in this package uses, so it is
 * the natural mistake, not a careless one — used to reach `toLspPosition` with
 * `line: undefined` and get back *"line must be a whole number ≥ 1 … got
 * undefined"*. That message is true and useless: it complains about the argument
 * that is MISSING while saying nothing about the two that were SENT, so the
 * obvious repair is to invent a line number, and the second call fails too.
 *
 * ⭐ A wrong-argument error should name the RIGHT argument. These tables are the
 * keys actually observed or plausibly reached for; each maps to what to say.
 */
const FILE_ALIASES = ['path', 'filename', 'filePath', 'file_path', 'filepath', 'uri', 'document', 'source'];
const LINE_ALIASES = ['lineNumber', 'line_number', 'row', 'lineNo'];
/** These do not map to anything — they mean the caller wanted a different tool. */
const SYMBOL_ALIASES = ['symbol', 'symbolName', 'identifier', 'name', 'query', 'term'];

/** First key present in `args` from `keys`, or null. `undefined` is absent. */
function firstPresent(args, keys) {
  for (const k of keys) if (args?.[k] !== undefined && args[k] !== null) return k;
  return null;
}

/**
 * Refuse an unusable call in a way that costs one round instead of three.
 *
 * ⚠️ IT ONLY FIRES WHEN THE REAL ARGUMENT IS ABSENT. `{ file, path }` together
 * is not an error — `file` wins silently, because a guard that rejects a call
 * carrying everything it needs is worse than no guard. And it polices only the
 * REQUIRED arguments: `column` is optional with a default, so an alias there is
 * forgiven below rather than refused.
 */
export function checkLspArgs(name, args = {}) {
  const wantsPosition = name === 'find_definition' || name === 'find_references';
  const a = args ?? {};

  if (typeof a.file !== 'string' || a.file === '') {
    const alias = firstPresent(a, FILE_ALIASES);
    if (alias) {
      return { ok: false, error: `${name} takes "file", not "${alias}". Re-send it as {"file": ${JSON.stringify(String(a[alias]))}${wantsPosition ? ', "line": <1-based line>, "column": <1-based column>' : ''}} — a workspace-relative path.` };
    }
    return { ok: false, error: `${name} needs "file": a workspace-relative source path${wantsPosition ? ', plus a 1-based "line" and "column" pointing at the symbol' : ''}.` };
  }

  if (wantsPosition && a.line === undefined) {
    const sym = firstPresent(a, SYMBOL_ALIASES);
    if (sym) {
      // ⭐ The important case: the caller knows the NAME and wants the position.
      // Saying "line is required" tells them to guess. Naming the tool that
      // produces a line number tells them what to do next.
      return {
        ok: false,
        error: `${name} is position-based, not name-based: it takes "file" + "line" + "column", and there is no "${sym}" argument. It cannot look up ${JSON.stringify(String(a[sym]))} by name. Do this instead — call search_text for ${JSON.stringify(String(a[sym]))} to get a file and a 1-based line:column, then call ${name} with those. Or call list_symbols on "${a.file}", which returns every symbol in it with its line number.`,
      };
    }
    const alias = firstPresent(a, LINE_ALIASES);
    if (alias) {
      return { ok: false, error: `${name} takes "line", not "${alias}". Re-send it as {"file": ${JSON.stringify(a.file)}, "line": ${JSON.stringify(a[alias])}, "column": <1-based column>}.` };
    }
    return { ok: false, error: `${name} needs "line": the 1-based line the symbol appears on, exactly as read_file and search_text print it. Call list_symbols on "${a.file}" if you do not know it yet.` };
  }

  return { ok: true };
}

/** The dispatcher `tools.mjs` would call. One entry point, so the registration
 *  is three lines and cannot drift from the schemas above. */
export async function runLspTool(root, name, args = {}, opts = {}) {
  if (!LSP_TOOL_NAMES.includes(name)) return { ok: false, error: `"${name}" is not an lsp tool` };
  const check = checkLspArgs(name, args);
  if (!check.ok) return check;
  /**
   * ⭐ REQUIRED ARGUMENTS TEACH, OPTIONAL ARGUMENTS FORGIVE. `column` defaults
   * to 1, so accepting `col`/`character` costs nothing and cannot mislead —
   * whereas refusing the call over an optional argument would spend a round to
   * fix something that was never going to be wrong.
   */
  const column = args.column ?? args.col ?? args.character ?? 1;
  switch (name) {
    case 'find_definition': return definition(root, args.file, args.line, column, opts);
    case 'find_references': return references(root, args.file, args.line, column, opts);
    case 'check_types': return diagnostics(root, args.file, opts);
    case 'list_symbols': return documentSymbols(root, args.file, opts);
    /* c8 ignore next */
    default: return { ok: false, error: `"${name}" is not an lsp tool` };
  }
}

export const LSP_TOOL_NAMES = ['find_definition', 'find_references', 'check_types', 'list_symbols'];
