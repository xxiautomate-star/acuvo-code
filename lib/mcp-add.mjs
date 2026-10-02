/**
 * ── ⭐⭐⭐ `acuvo mcp add` — ONE COMMAND, THE WHOLE MCP ECOSYSTEM ─────────────
 *
 * Roman, 2026-08-23: *"find as much useful stuff on the internet to get our
 * builder and CLI as capable as quick as possible… the features must be
 * ridiculous, integration-wise."*
 *
 * ⭐ THE ANSWER WAS NOT MORE INTEGRATIONS. IT WAS ONE COMMAND.
 *
 * `lib/mcp.mjs` already speaks stdio, http and sse, and already reads
 * `.acuvo/mcp.json` / `.mcp.json`. Every MCP server on the internet was ALREADY
 * a capability we could run — filesystem, github, postgres, memory, playwright,
 * figma, context7, and hundreds more. The only thing standing between a user and
 * all of it was that they had to hand-author JSON.
 *
 * ⚠️ AND WE KNEW. Two files in this repo reference the competitor's version of
 * this command with open envy:
 *
 *   design-loop.mjs:14  "…are free, first-party and one `claude mcp add` away"
 *   media.mjs:32        "…types `claude mcp add playwright`, and it makes
 *                        everything else we claim work"
 *
 * A capability nobody can reach scores zero, and we had written that down twice
 * while shipping the unreachable version.
 *
 * ── ⚠️ WHY THIS FILE IS PURE ────────────────────────────────────────────────
 *
 * Everything here decides WHAT to write. The caller does the writing. That is
 * what makes "does `acuvo mcp add playwright` produce a config the loader
 * accepts" a unit test rather than a manual trial — and this repo has shipped
 * enough config that parsed nowhere to want that test.
 *
 * ⚠️ AND THAT TEST WAS TRUE OF EIGHT SERVERS AND FALSE OF THE NINTH. See
 * `mergeServer`.
 */

/**
 * ⭐ IMPORTED, NEVER RETYPED — the cap belongs to the LOADER.
 *
 * `readMcpConfig` stops at `MAX_SERVERS` with a bare `break`. A copy of that
 * number here is a copy that goes stale the day the loader's changes, and the
 * symptom of the drift is silence.
 */
import { MAX_SERVERS } from './mcp.mjs';
/**
 * ⭐ ONE CURATED SOURCE OF TRUTH, AND IT IS NOT THIS FILE. `mcp-defaults.mjs`
 * is where package claims are checked against the registry and written down
 * with a date; this file is where they finally reach a user.
 */
import {
  packageAdvisory,
  catalogueEntry,
  isHosted,
  packageOf,
  resolveArgs,
  PACKAGE_ROOT,
} from './mcp-defaults.mjs';

/**
 * Servers we know the invocation for, so a user can type a nickname.
 *
 * ⚠️ EVERY ONE OF THESE WAS VERIFIED AGAINST THE NPM REGISTRY on 2026-08-23 —
 * name and current version both. A curated list whose entries 404 is worse than
 * no list, because the failure lands after the user has already trusted it.
 * (`@modelcontextprotocol/server-*` are the official ones.)
 */
export const KNOWN_SERVERS = Object.freeze({
  filesystem: {
    package: '@modelcontextprotocol/server-filesystem',
    blurb: 'read and write files outside the workspace',
    /** ⚠️ Needs a root, or it serves nothing. Defaulted to the workspace by the caller. */
    needsPathArg: true,
  },
  github: {
    package: '@modelcontextprotocol/server-github',
    blurb: 'issues, PRs and code search on GitHub',
    env: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  postgres: {
    package: '@modelcontextprotocol/server-postgres',
    blurb: 'query a Postgres database',
    needsUrlArg: true,
  },
  memory: {
    package: '@modelcontextprotocol/server-memory',
    blurb: 'a knowledge graph that persists between sessions',
  },
  thinking: {
    package: '@modelcontextprotocol/server-sequential-thinking',
    blurb: 'structured step-by-step reasoning',
  },
  playwright: {
    package: '@playwright/mcp',
    blurb: 'drive a real browser — click, type, screenshot, read the DOM',
    /**
     * ⭐ HEADLESS, IN-MEMORY PROFILE, PLAYWRIGHT'S OWN CHROMIUM (2026-09-27).
     * @playwright/mcp defaults to `--browser chrome` — the user's INSTALLED
     * Google Chrome, headed, with a persistent profile — so the first
     * `playtest` popped a window on the owner's desktop and left a profile
     * dir behind (`ms-playwright/mcp-chrome-*` on this machine). Measured
     * through our own connectServer: with these flags it answers
     * `HeadlessChrome/152` in 12.8s cold. ⚠️ The bare `--` is load-bearing:
     * without it npm eats the flags and the handshake times out at 20s
     * (measured, same day). Mirrors the catalogue entry in mcp-defaults.mjs.
     */
    extraArgs: ['--', '--headless', '--isolated', '--browser', 'chromium'],
    // The browser is a separate download, matched to the server's own Playwright.
    install: 'npm i -g @playwright/mcp && npx @playwright/mcp install-browser chrome-for-testing',
  },
  figma: {
    package: 'figma-developer-mcp',
    blurb: 'read designs, tokens and components out of Figma',
    env: ['FIGMA_API_KEY'],
  },
  context7: {
    package: '@upstash/context7-mcp',
    blurb: 'current, version-correct docs for any library',
  },
});

/**
 * The name the config will be keyed by.
 *
 * ⚠️ MIRRORS `lib/mcp.mjs`'s NORMALISER EXACTLY, including the `_{2,}` collapse
 * that is the security line there — `__` is the namespace separator, so a name
 * that survives with a double underscore could impersonate another server's
 * tools. Writing a name the loader would then mangle is how a config silently
 * stops matching the thing the user typed.
 */
export function normaliseServerName(raw) {
  return String(raw ?? '')
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 31);
}

/** Is this a URL we are willing to put in a config? */
function looksRemote(spec) {
  return /^https?:\/\//i.test(String(spec ?? '').trim());
}

/**
 * Work out the server entry for what the user typed.
 *
 * Accepts a nickname (`playwright`), a CURATED CATALOGUE NAME (`browser`,
 * `deepwiki`, `mslearn` — anything `mcp-defaults.mjs` has measured), a bare npm
 * package (`@21st-dev/magic`), or a URL (`https://mcp.example.com/sse`).
 *
 * @returns {{ok:true,name:string,entry:object,note:string|null}|{ok:false,error:string}}
 */
export function resolveServer(input, { workspace = '.', name: explicitName, packageRoot = PACKAGE_ROOT } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'name a server: `acuvo mcp add playwright`, an npm package, or a URL.' };
  }

  if (looksRemote(raw)) {
    /**
     * ⚠️ A REMOTE SERVER GETS NO DEFAULT NAME FROM ITS PATH. `https://x.com/sse`
     * would become "sse", which tells the user nothing and collides with the
     * next SSE server they add. The host is the meaningful part.
     */
    let host;
    try { host = new URL(raw).hostname; } catch { return { ok: false, error: `"${raw}" is not a valid URL.` }; }
    const name = normaliseServerName(explicitName || host.replace(/^www\./, '').split('.')[0]);
    if (!name) return { ok: false, error: `could not derive a server name from ${raw} — pass --name.` };
    return {
      ok: true,
      name,
      entry: { type: /\/sse\b/i.test(raw) ? 'sse' : 'http', url: raw },
      note: null,
    };
  }

  const known = KNOWN_SERVERS[raw.toLowerCase()];

  /**
   * ── ⚠️⚠️ THE CURATED CATALOGUE IS A SECOND LIST OF NICKNAMES, AND UNTIL NOW
   *          TYPING ONE OF THEM INSTALLED A STRANGER'S PACKAGE ────────────────
   *
   * There are two curated lists in this codebase and they were never joined:
   * `KNOWN_SERVERS` above (eight nicknames, for this command) and `CATALOGUE`
   * in `mcp-defaults.mjs` (the hand-verified set the doctor and `--mcp` report
   * from). Four names live only in the catalogue — `acuvo`, `browser`, `docs`,
   * `firecrawl` — and typing one of them here fell through to the bare-package
   * branch, where the name is handed to npx AS THE PACKAGE NAME.
   *
   * ⚠️ MEASURED AGAINST THE REAL REGISTRY, 2026-08-25:
   *     npm view browser    → 0.2.6   ← EXISTS, and is not an MCP server
   *     npm view firecrawl  → 4.35.0  ← EXISTS: the Firecrawl SDK, not firecrawl-mcp
   *     npm view acuvo      → E404
   * So `acuvo mcp add browser` wrote `npx -y browser` into the user's config and
   * printed "added". The catalogue's own entry for `browser` is
   * `chrome-devtools-mcp` — Google's, Apache-2.0, 29 tools, the single largest
   * capability this CLI lacks — and the command named after it quietly
   * configured an unrelated package that will never speak MCP.
   *
   * ⭐ THIS IS THE REPO'S SIGNATURE DEFECT IN ITS PUREST FORM: the correct
   * answer was researched, written down, tested, and then not consulted by the
   * one function that needed it. The fix is not a bigger list here — it is
   * asking the list that already exists.
   *
   * ⚠️ IT DELIBERATELY DOES NOT GROW `KNOWN_SERVERS`. That object's key count is
   * load-bearing in a test that is not mine to edit: `test/mcp-add.test.mjs`
   * adds EVERY nickname to ONE config and asserts they all survive
   * `readMcpConfig`, and `MAX_SERVERS` is 8 while `KNOWN_SERVERS` has exactly 8
   * keys — so a ninth nickname would make `mergeServer` correctly refuse at the
   * cap and turn that test red. Resolving through the catalogue adds every
   * catalogue name as a nickname without touching the count.
   */
  const curated = known ? null : catalogueEntry(raw.toLowerCase());
  if (curated) {
    const name = normaliseServerName(explicitName || curated.name);
    if (!name) return { ok: false, error: `could not derive a server name from "${raw}" — pass --name.` };

    /**
     * ⚠️ A HOSTED ENTRY WRITES `{type,url}` AND NOTHING ELSE. Writing a
     * `command` for it would produce a config `readMcpConfig` reads as stdio and
     * tries to spawn; writing both is a config where nobody can tell which one
     * is live. The headers come straight from the catalogue, which stores them
     * as `${VAR}` references so the token is expanded from the environment at
     * connect time and is never written into the file.
     */
    if (isHosted(curated)) {
      const envNames = (curated.credentials ?? []).filter((c) => c.required).map((c) => c.env);
      let note = `${curated.purpose}\n  hosted — nothing is installed and nothing runs on this machine; your query text goes to ${curated.url}`;
      if (envNames.length > 0) note = `${note}\n  needs ${envNames.join(', ')} in your environment`;
      // ⭐ Same omission as the stdio branch below, same fix: `huggingface`
      // works anonymously and HF_TOKEN only widens it, and that was never said.
      const optHosted = (curated.credentials ?? []).filter((c) => !c.required);
      if (optHosted.length > 0) {
        note = `${note}\n  optional: ${optHosted.map((c) => `${c.env} — ${c.why}`).join('; ')}`;
      }
      if (!curated.verified) note = `${note}\n  ⚠ we have not run this one ourselves — see \`acuvo --mcp\` for what was actually measured`;
      return {
        ok: true,
        name,
        entry: {
          type: curated.transport ?? 'http',
          url: curated.url,
          ...(curated.headers ? { headers: { ...curated.headers } } : {}),
        },
        note,
        /**
         * ⚠️ `install: null`, NOT AN INSTALL LINE AND NOT UNDEFINED. There is
         * nothing to install, and the remote-URL branch above already returns
         * an object with no install line at all — so every caller has always had
         * to cope with a falsy value here. Saying `null` states it rather than
         * relying on the key's absence.
         */
        install: null,
        package: null,
        advisory: null,
      };
    }

    /**
     * A catalogue entry we SHIP (`acuvo`) has no package and no install line —
     * `needsDownload` is false and its args carry the package-root token, which
     * has to be substituted here or the config names a literal `{…}` path.
     */
    if (!curated.needsDownload) {
      return {
        ok: true,
        name,
        entry: { command: curated.command, args: resolveArgs(curated, { packageRoot }) },
        note: `${curated.purpose}\n  ships with acuvo-code — nothing to install`,
        install: null,
        package: null,
        advisory: null,
      };
    }

    const cpkg = packageOf(curated);
    const cadvisory = packageAdvisory(cpkg);
    if (cadvisory?.severity === 'refuse') {
      return { ok: false, error: `refusing to add ${cpkg}.\n  ${cadvisory.message}`, advisory: cadvisory };
    }
    let note = `${curated.purpose}\n  install it once (this client cannot download it for you):  ${curated.install}`;
    const reqEnv = (curated.credentials ?? []).filter((c) => c.required).map((c) => c.env);
    /**
     * ── ⚠️⚠️ THE ARGS ARE COPIED VERBATIM, AND ONE TOKEN IN THEM IS LOAD-BEARING
     *
     * `connectServer` runs `npx --no <pkg> <args…>`, and npm 11 parses any
     * `--flag` that follows the package name as its OWN config — it prints
     * "npm warn Unknown cli config" and the program never sees it (measured
     * 2026-08-26; see the header of mcp-defaults.mjs). A catalogue entry that
     * needs a flag therefore carries a bare `--` before it, and copying the
     * array unchanged is what keeps that separator intact. Do not "tidy" these
     * args, and do not append a flag here without a `--` already present —
     * `test/mcp-catalogue-stdio-flags.test.mjs` fails the catalogue if you do.
     */
    const entry = { command: curated.command, args: [...curated.args] };
    /**
     * ⭐ FIXED, NON-SECRET ENV THE CATALOGUE CHOSE FOR THE USER — today only
     * Blender, whose upstream server ships telemetry; we write it OFF.
     */
    if (curated.env && typeof curated.env === 'object') entry.env = { ...curated.env };
    if (reqEnv.length > 0) {
      /**
       * ⚠️ THE SAME `${VAR}` SHAPE THE NICKNAME PATH WRITES, AND FOR THE SAME
       * REASON. The child already inherits the whole process environment, so
       * this buys no access — it makes the REQUIREMENT visible in the file the
       * user is looking at, and `resolveServerEnv` expands it at spawn time
       * (and clobbers nothing, since the fix on 2026-08-15). A config that
       * silently depends on an unmentioned variable fails as a 401 twenty
       * seconds later, naming nothing the user wrote.
       */
      entry.env = { ...(entry.env ?? {}), ...Object.fromEntries(reqEnv.map((k) => [k, `\${${k}}`])) };
      note = `${note}\n  needs ${reqEnv.join(', ')} in your environment`;
    }
    /**
     * ── ⭐⭐ THE OPTIONAL CREDENTIAL REACHED NOBODY, AND IT IS THE INTERESTING
     *        HALF OF THE ANSWER ───────────────────────────────────────────────
     *
     * Only REQUIRED credentials were ever mentioned here, so `acuvo mcp add
     * tavily` printed the purpose and the install line and stopped — while the
     * catalogue's own measurement says that server runs KEYLESS for search and
     * extract and needs `TAVILY_API_KEY` only for crawl, map and research. The
     * user's two live questions at that moment are "does this work without an
     * account" and "what do I get if I sign up", and we had both answers in the
     * entry and printed neither.
     *
     * ⚠️ IT DOES NOT WRITE AN `env` BLOCK FOR THESE, deliberately. A `${VAR}`
     * reference in the config is the shape `resolveServerEnv` expands, and
     * writing one for a variable the server does not need would make an entry
     * that works today look misconfigured in `acuvo mcp list`. The requirement
     * is a sentence; only a REQUIREMENT earns a line in the file.
     */
    const optCreds = (curated.credentials ?? []).filter((c) => !c.required);
    if (optCreds.length > 0) {
      note = `${note}\n  optional: ${optCreds.map((c) => `${c.env} — ${c.why}`).join('; ')}`;
    }
    if (cadvisory) note = `${note}\n  ⚠ ${cadvisory.message}`;
    return {
      ok: true,
      name,
      entry,
      note,
      install: curated.install,
      package: cpkg,
      advisory: cadvisory ?? null,
    };
  }

  const pkg = known ? known.package : raw;

  /**
   * ⚠️ A BARE PACKAGE MUST STILL LOOK LIKE ONE. Without this, a typo like
   * `acuvo mcp add ../../etc/passwd` becomes an npx argument, and npx runs what
   * it is given.
   */
  if (!known && !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(pkg)) {
    return { ok: false, error: `"${raw}" is not a known server, an npm package name, or a URL.` };
  }

  /**
   * ── ⚠️⚠️ WHAT WE ALREADY KNEW ABOUT THIS PACKAGE, FINALLY ON THE PATH ──────
   *
   * `mcp-defaults.mjs` checked these names against the registry and wrote down
   * what it found. Until now that finding lived in a comment, and this function
   * — the one that actually writes a package name into a file the client will
   * spawn — had never heard of it.
   *
   * ⚠️ REFUSAL COMES BEFORE THE NAME IS DERIVED AND BEFORE ANYTHING IS SHAPED,
   * so there is no half-built entry a caller could reach past the error. Fails
   * CLOSED: an advisory we cannot interpret is not a reason to proceed.
   */
  const advisory = packageAdvisory(pkg);
  if (advisory?.severity === 'refuse') {
    return {
      ok: false,
      error: `refusing to add ${pkg}.\n  ${advisory.message}`,
      advisory,
    };
  }

  const name = normaliseServerName(explicitName || (known ? raw.toLowerCase() : pkg));
  if (!name) return { ok: false, error: `could not derive a server name from "${raw}" — pass --name.` };

  const args = ['-y', pkg];
  if (known?.extraArgs) args.push(...known.extraArgs);
  if (known?.needsPathArg) args.push(workspace);

  const entry = { command: 'npx', args };

  /**
   * ⚠️ THE ENV VAR IS NAMED, NOT INVENTED. We write the KEY it needs with an
   * empty value and say so, rather than silently writing a config that will fail
   * at connect time with an authentication error nobody can trace back to here.
   */
  let note = known?.blurb ?? null;
  if (known?.env?.length) {
    entry.env = Object.fromEntries(known.env.map((k) => [k, `\${${k}}`]));
    note = `${note} — needs ${known.env.join(', ')} in your environment`;
  }
  if (known?.needsUrlArg) {
    note = `${note} — append your connection string: \`acuvo mcp add ${raw} -- postgres://…\``;
  }

  /**
   * ── ⚠️⚠️ "added" IS NOT "runnable", AND WE SHIPPED THE GAP BETWEEN THEM ────
   *
   * `mcp.mjs`'s `connectServer` injects `--no` and strips `-y`, so npx may only
   * run a package that is ALREADY INSTALLED. That is a deliberate security
   * property — without it a committed config downloads and executes any name it
   * likes — but it means the `npx -y <pkg>` line THIS FUNCTION writes cannot
   * start on a machine that has never installed the package.
   *
   * ⚠️ `mcp-defaults.mjs` MEASURED THE COST AND WROTE THE RULE, and this file
   * broke it. Its rule 4: *"every entry that needs a download must carry the
   * exact install command, because 'install it yourself' without the line to
   * paste is not help"*, and its `filesystem` entry records the actual run —
   * npx spent 12s on the registry, said "npx canceled due to missing packages
   * and no YES option", and `connectServer` reported it at 20,083ms.
   *
   * So `acuvo mcp add playwright` printed "added" and "run /mcp to see whether
   * it connects", and /mcp then stalled 20 seconds and said `initialize failed`.
   * The user is one `npm i -g` from working and is told nothing — the exact
   * "capability present but unreachable" defect this command was written to end.
   *
   * ⭐ SO THE INSTALL LINE RIDES BACK WITH THE ENTRY. Returned as its own field
   * for callers that want it, and folded into `note` so the existing CLI prints
   * it with no change to `bin/`.
   */
  const install = known?.install ?? `npm i -g ${pkg}`;
  note = `${note ?? `runs ${pkg}`}\n  install it once (this client cannot download it for you):  ${install}`;

  /**
   * ⚠️ A `warn` ADVISORY DOES NOT BLOCK THE ADD, AND THAT IS THE POINT. Both
   * entries carrying one are npm-deprecated reference servers that still
   * install and still work — refusing them would break configs that are fine
   * today, which is a larger harm than the sentence. Two of the eight curated
   * nicknames (`github`, `postgres`) resolve to them, so this fires on the
   * flagship flow rather than only on an exotic one.
   */
  if (advisory) note = `${note}\n  ⚠ ${advisory.message}`;

  return { ok: true, name, entry, note, install, package: pkg, advisory: advisory ?? null };
}

/**
 * Merge a server into an existing config object.
 *
 * ⚠️ REFUSES TO OVERWRITE SILENTLY. Someone who has hand-tuned a server's args
 * and then adds it again by nickname should be told, not quietly reset. `force`
 * is the deliberate override.
 *
 * ── ⚠️⚠️ AND IT USED TO WRITE A NINTH SERVER THAT COULD NEVER LOAD ──────────
 *
 * `readMcpConfig` stops at `MAX_SERVERS` (8) with a bare `break` — no error, no
 * warning, and `ok: true`. `mergeServer` spreads the existing servers and adds
 * the new key LAST, so the entry that falls off the end is always THE ONE THE
 * USER JUST ADDED.
 *
 * ⚠️ MEASURED 2026-08-25, through the real code, not reasoned about: add all
 * eight curated nicknames, then add `@21st-dev/magic`. `mergeServer` → `ok:
 * true`. The CLI prints *added "21st-dev_magic" to .acuvo/mcp.json* and *run
 * "/mcp" to see whether it connects*. `readMcpConfig` then returns `ok: true`,
 * `error: undefined`, and **eight servers — without the ninth.** Every surface
 * agreed it had worked. `/mcp` shows eight healthy servers and no mention of
 * the missing one, so there is nothing to diagnose: the user's evidence is that
 * the command succeeded and the tool does not exist.
 *
 * ⭐ SO THE CAP IS ENFORCED WHERE THE DECISION IS MADE, not discovered where
 * the file is read. Refusing costs the user one sentence; the silent version
 * costs them the belief that `mcp add` works.
 *
 * ⚠️ REPLACING AN EXISTING SERVER IS NEVER CAPPED — it does not grow the count,
 * and blocking it would strand someone AT the cap with no way to fix a bad
 * entry except hand-editing the JSON this command exists to avoid.
 */
export function mergeServer(config, name, entry, { force = false } = {}) {
  const base = config && typeof config === 'object' ? config : {};
  const servers = { ...(base.mcpServers ?? base.servers ?? {}) };

  if (servers[name] && !force) {
    return { ok: false, error: `"${name}" is already configured. Re-run with --replace to overwrite it.` };
  }

  const isNew = !Object.prototype.hasOwnProperty.call(servers, name);
  if (isNew && Object.keys(servers).length >= MAX_SERVERS) {
    return {
      ok: false,
      atCap: true,
      error: `you already have ${Object.keys(servers).length} MCP servers configured, and this client loads at most `
        + `${MAX_SERVERS}. Adding "${name}" would write an entry that never loads — silently, because the loader `
        + `stops at ${MAX_SERVERS} without an error.\n`
        + `  Remove one you are not using from your MCP config first, then add this again.\n`
        + `  Configured now: ${Object.keys(servers).join(', ')}`,
    };
  }

  servers[name] = entry;
  /**
   * ⚠️ ALWAYS WRITES `mcpServers`, even if the file used `servers`. The loader
   * accepts both, but one file with both keys is a file where nobody can tell
   * which one is live.
   */
  const { servers: _legacy, ...rest } = base;
  return { ok: true, config: { ...rest, mcpServers: servers } };
}

/**
 * ── ⭐⭐ `remove` AND `list` — THE TWO HALVES `add` SHIPPED WITHOUT ──────────
 *
 * ⚠️ THE PRODUCT ALREADY TOLD PEOPLE TO DO THIS AND GAVE THEM NO WAY TO.
 * `mergeServer`'s own at-cap error reads verbatim: *"Remove one you are not
 * using from your MCP config first, then add this again."* The only way to obey
 * that sentence was to hand-edit JSON — which is the exact friction `mcp add`
 * exists to delete, and here it is worse than friction: **removal is the UNDO
 * for a trust decision.**
 *
 * `lib/mcp-consent.mjs` makes running a repo-supplied `.mcp.json` require an
 * explicit approval, and that gate is proven fail-closed. But a user who
 * approves a server and then thinks better of it, or who clones a repo and
 * wants to see what it declares BEFORE deciding, had one command (`add`) and no
 * inverse and no viewer. A security control you cannot reverse is half a
 * control.
 *
 * ⚠️ `list` DELIBERATELY DOES NOT CONNECT. `/mcp` inside a session shows live
 * status, which is the right tool once you have decided to run. This one
 * answers the question you ask BEFORE that: *what does this repo want to
 * start on my machine?* Spawning a process to answer it would be the thing the
 * consent gate exists to prevent.
 *
 * Pure, like everything else in this file: they decide what the config should
 * become and what to print. The caller reads and writes the files.
 */

/**
 * Drop one server. Returns the config to write, or an error that NAMES what is
 * actually configured — a bare "not found" makes the user guess at a spelling
 * when the answer is one line away.
 */
export function removeServer(config, name) {
  const base = config && typeof config === 'object' ? config : {};
  const servers = { ...(base.mcpServers ?? base.servers ?? {}) };
  const configured = Object.keys(servers);

  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    return {
      ok: false,
      configured,
      error: configured.length === 0
        ? `no MCP servers are configured here, so there is nothing named "${name}" to remove.`
        : `no MCP server named "${name}" is configured.\n  Configured now: ${configured.join(', ')}`,
    };
  }

  delete servers[name];
  /**
   * ⚠️ SAME NORMALISATION AS `mergeServer`, AND FOR THE SAME REASON. A file
   * that used the legacy `servers` key must not come back with BOTH keys after
   * an edit — nobody could then tell which one the loader reads.
   */
  const { servers: _legacy, ...rest } = base;
  return { ok: true, removed: name, config: { ...rest, mcpServers: servers } };
}

/**
 * The lines `acuvo mcp list` prints. Takes the parsed config and the file it
 * came from; renders WITHOUT judging, because this runs before consent.
 */
export function describeConfiguredServers(config, { source = null } = {}) {
  const base = config && typeof config === 'object' ? config : {};
  const servers = base.mcpServers ?? base.servers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) {
    return [
      source
        ? `No MCP servers are configured in ${source}.`
        : 'No MCP servers are configured for this workspace.',
      '  Add one with: acuvo mcp add <name-or-package-or-url>',
    ];
  }

  const width = names.reduce((n, s) => Math.max(n, s.length), 0);
  const lines = [`${names.length} MCP server${names.length === 1 ? '' : 's'}${source ? ` in ${source}` : ''}:`];
  for (const name of names) {
    const spec = servers[name] ?? {};
    /**
     * ⚠️ THE COMMAND LINE IS PRINTED IN FULL, ON PURPOSE. This is the screen
     * someone reads to decide whether a cloned repo is safe, and "stdio" alone
     * tells them nothing. `mcp-consent.mjs` prints the same shape for the same
     * reason — an approval prompt that hides the argv is consent to nothing.
     */
    const invocation = typeof spec.url === 'string' && spec.url
      ? spec.url
      : [spec.command, ...(Array.isArray(spec.args) ? spec.args : [])].filter(Boolean).join(' ');
    /**
     * ⚠️ ENV VARIABLE NAMES, NEVER VALUES. A config may legitimately carry a
     * literal token; printing it would put a secret on a terminal and into a
     * scrollback the user did not choose to expose. The NAMES are exactly what
     * matters for the decision (`NODE_OPTIONS` set on an MCP server is an RCE
     * in a trenchcoat) and they leak nothing.
     */
    const envNames = spec.env && typeof spec.env === 'object' ? Object.keys(spec.env) : [];
    const bits = [name.padEnd(width), invocation || '(no command)'];
    if (envNames.length > 0) bits.push(`env: ${envNames.join(', ')}`);
    lines.push(`  ${bits.join('  ')}`);
  }
  lines.push('', 'Remove one with: acuvo mcp remove <name>');
  return lines;
}
