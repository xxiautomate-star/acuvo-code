/**
 * ── ⭐⭐ MCP DEFAULTS — THE CURATED SET, AND WHY IT IS SO SMALL ──────────────
 *
 * `mcp.mjs` proved this CLI is a working MCP client: read a config, spawn the
 * servers, namespace their tools, call them, shut them down. What it does NOT
 * do is tell a new user which servers are worth having. Neither does anyone
 * else — Claude Code, Cursor, Cline and Codex all speak MCP, and all four hand
 * you an empty config file and wish you luck.
 *
 * ⭐ THE OPPORTUNITY IS THE DEFAULT SET, NOT THE PROTOCOL. MCP access is an
 * open standard and is not our edge. "Acuvo arrives already able to do X" is a
 * claim none of the others make, and it is integration work, not invention.
 *
 * ── ⚠️⚠️ AND THE HARD PART IS THE HONESTY, WHICH COST THIS FILE ITS SIZE ────
 *
 * The obvious version of this module is forty servers copied off a README. I
 * measured what that would actually do on this machine, through the real
 * `connectServer`, and the numbers killed it:
 *
 *   · `npx -y @modelcontextprotocol/server-filesystem` — REFUSED. `mcp.mjs`
 *     deliberately injects `--no` and strips `-y`, so npx may only run a
 *     package that is ALREADY INSTALLED. npx spent 12s asking the registry and
 *     then said "npx canceled due to missing packages and no YES option".
 *   · `npx firecrawl-mcp` — the package IS installed globally here, and it
 *     still failed: "Either FIRECRAWL_API_KEY or FIRECRAWL_API_URL must be
 *     provided".
 *   · `node <packageRoot>/bin/acuvo-mcp.mjs` — connected in **156ms** with no
 *     download and no credentials, and offered **zero tools**, because its two
 *     tools are gated on RENDER_AUDIT_URL / MODAL_PRESS_URL.
 *
 * ⚠️⚠️ **A DARK ENTRY COSTS 20 SECONDS, NOT NOTHING.** Both failures above were
 * reported by `connectServer` at **20,052ms** and **20,083ms** — the full
 * `HANDSHAKE_TIMEOUT_MS`. The underlying process had already died in under a
 * second; the client waits out the whole budget regardless. So a "harmless"
 * default that happens to be unconfigured is a **20-second stall before the
 * user's first prompt**, and four of them is a minute and a half.
 *
 * ⭐ THAT is why this module exists and why it is PURE. The point is not to
 * publish a list. The point is to decide, WITHOUT SPAWNING ANYTHING, which
 * entries provably cannot work here, so they are never spawned and never
 * charged for. `assessCatalogue` is a precheck, and every 'dark' it returns is
 * 20 seconds the session does not spend.
 *
 * ── THE RULES, ENFORCED BY TESTS RATHER THAN BY INTENTION ───────────────────
 *   1. Nothing that needs a DOWNLOAD is enabled by default. It cannot work —
 *      `--no` forbids the install — so enabling it buys a guaranteed 20s stall.
 *   2. Nothing that needs CREDENTIALS is enabled by default, for the same
 *      arithmetic: no key, no handshake, 20s gone.
 *   3. Nothing UNVERIFIED is enabled by default. An entry nobody ran is a
 *      promise, and this repo has spent the day deleting promises.
 *   4. Every entry that needs a download must carry the exact install command,
 *      because "install it yourself" without the line to paste is not help.
 *
 * ⚠️ WHAT I PERSONALLY RAN, so nobody has to guess which claims are load-bearing:
 *   · `acuvo`      — VERIFIED, end to end, through `readMcpConfig` +
 *                    `connectServer`. Connected, listed tools, closed clean.
 *   · `browser`    — VERIFIED, end to end, INCLUDING A REAL TOOL CALL. See its
 *                    entry: connected in 1,935ms, 29 tools, navigated a page
 *                    and read the accessibility tree back. RE-VERIFIED
 *                    independently 2026-08-14: 2,894ms, still 29 tools, and the
 *                    same navigate + snapshot pair answered ok.
 *   · `playwright` — VERIFIED 2026-08-14, having been INERT for one day. See
 *                    its entry: 24 tools and a real navigation.
 *   · `docs`       — VERIFIED 2026-08-14, end to end, INCLUDING TWO REAL CALLS
 *                    THAT RETURNED REAL DOCUMENTATION, with no API key.
 *   · `filesystem` — VERIFIED FAILING. I ran it and watched npx refuse.
 *   · `firecrawl`  — VERIFIED FAILING. I ran it and read its own complaint.
 * Everything else in `CATALOGUE` is marked `verified: false` and is INERT: it
 * can never be enabled, never be rendered active, and exists only so the
 * availability report can name the install command. I did not run those, and
 * the entry says so rather than implying otherwise by sitting in a list.
 *
 * ── ⚠️⚠️ 2026-08-14: A CURATED SET THAT NAMED A STRANGER'S CANARY PACKAGE ───
 *
 * The entries below were curated by hand and NOT ONE of the npm names had ever
 * been checked against the registry. Checked on 2026-08-14 with `npm view`, and
 * the result is the argument for doing it:
 *
 *   · `mcp-server-git` — **REMOVED.** npm `mcp-server-git@0.0.2` describes
 *     itself as *"Security research canary — not for production use. Part of an
 *     authorized bug bounty research project"*, repository
 *     `github.com/theinfosecguy/npx-canary`. It is a dependency-confusion probe,
 *     not the git MCP server (the real one is a PYTHON package run with
 *     `uvx mcp-server-git`, which this npx-only client cannot start anyway). Our
 *     catalogue was handing users `npm i -g mcp-server-git` — a curated set that
 *     tells you to globally install a stranger's canary is worse than no set.
 *     ⭐ And it bought nothing: this CLI already ships native `git_status`,
 *     `git_diff`, `git_log` and `git_commit`.
 *   · `@modelcontextprotocol/server-github` and `…/server-postgres` — both carry
 *     an npm `deprecated` field: *"Package no longer supported."* Kept, because
 *     they still resolve and still work, but their notes now say so. Silently
 *     recommending abandonware is the same class of stale claim this file is
 *     otherwise strict about.
 *   · `@modelcontextprotocol/server-filesystem` (2026.7.10) and `firecrawl-mcp`
 *     (3.24.0) — current, not deprecated. Unchanged.
 *
 * ⭐ THE RULE THAT FOLLOWS FROM IT: an entry's package name must be checked
 * against the registry before it is written down, and the package spec must
 * never carry a dist-tag (`@latest`) — `packageOf` feeds the `installed` lookup,
 * and `"@playwright/mcp@latest"` can never match a package called
 * `@playwright/mcp`, so a tagged spec reports an installed server as dark
 * forever.
 *
 * ⚠️⚠️ AND THAT RULE SAID OF ITSELF "AND IT IS NOW A TEST" WHILE NO SUCH TEST
 * EXISTED. Checked on 2026-08-14 — `grep -n "latest\|dist-tag"
 * test/mcp-defaults.test.mjs` returned nothing, so the sentence asserting the
 * rule was enforced was the only thing enforcing it. It is a test NOW (see
 * `test/mcp-catalogue-claims.test.mjs`), which is a smaller and truer claim
 * than the one it replaces. ⭐ A comment that says "there is a test for this" is
 * itself a factual claim about the repo, and this file is otherwise strict
 * about exactly that — the honesty rules have to apply to the honesty rules.
 *
 * ── ⚠️⚠️ 2026-08-14, LATER THE SAME DAY: THE INSTALL BLOCK IS GONE ──────────
 *
 * This header stated, at length and in bold, that **no new npm package could be
 * installed on this machine** — a network appliance answering HTTP 503 with an
 * HTML "File Transfer Blocked" page for every `.tgz` under `registry.npmjs.org`,
 * `is-odd` included. That was true when it was measured and it is FALSE NOW.
 * Re-measured today, same machine: `npm i is-odd` → *"added 2 packages in 1s"*,
 * `npm i -g @upstash/context7-mcp` → *"added 88 packages in 1m"*,
 * `npm i -g @playwright/mcp` → *"added 3 packages in 36s"*.
 *
 * ⭐ AND THE STALE CLAIM WAS COSTING REAL CAPABILITY, which is why it is worth
 * this much space. `playwright` was filed as INERT *solely* because of it, and
 * the note said so. One re-measurement promoted it to verified and added a
 * second verified entry — the blocker was a sentence, not a fact. This repo's
 * standing rule is that a warning which has gone stale is as expensive as the
 * wrong instruction it replaced, and going stale in the PESSIMISTIC direction
 * is the sneakier half: nothing breaks, so nobody re-checks, and the catalogue
 * just quietly stays smaller than the machine can support.
 *
 * ⚠️ SO: RE-MEASURE BEFORE INHERITING ANY "CANNOT" IN THIS FILE. The install
 * channel here has now changed twice in one day; treat every environment claim
 * below as dated, not permanent.
 *
 * ⚠️ THE HONEST LIMIT OF THIS FILE: it decides what CANNOT work. It cannot
 * promise that a `live` entry WILL work — a key can be revoked and a package
 * can be broken. `live` here means "nothing we can check from memory rules it
 * out", which is a smaller claim than it looks and is deliberately worded that
 * way everywhere it surfaces.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { MAX_SERVERS, HANDSHAKE_TIMEOUT_MS, MCP_CONFIG_FILES } from './mcp.mjs';

/**
 * ⭐ IMPORTED, NOT RETYPED. `readMcpConfig` silently `break`s past the 9th
 * server, so a renderer with its own idea of the cap would emit a config whose
 * tail is dropped without a word. The cap has to be the same number by
 * construction, not by comment.
 */
export { MAX_SERVERS, HANDSHAKE_TIMEOUT_MS, MCP_CONFIG_FILES };

/** Where `renderStarterConfig`'s output is meant to be written. */
export const STARTER_CONFIG_FILE = MCP_CONFIG_FILES[0];

/**
 * The token standing in for this package's install directory inside `args`.
 *
 * ⚠️ A LITERAL ABSOLUTE PATH CANNOT LIVE IN THE CATALOGUE. The catalogue is a
 * constant; the path is different on every machine and is not knowable until
 * someone asks for a rendered config. Substituting at render time keeps the
 * data pure and keeps the rendered file correct.
 */
export const PACKAGE_ROOT_TOKEN = '{ACUVO_PACKAGE_ROOT}';

/** This package's root, for the default substitution. Computed, no I/O. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ⚠️ Measured, and it is the whole argument for the precheck: this is what a
 * dark entry costs at session start. Not a guess — `connectServer` returned at
 * 20,052ms and 20,083ms for the two failures described in the header.
 */
export const DARK_ENTRY_COST_MS = HANDSHAKE_TIMEOUT_MS;

/**
 * ── THE CATALOGUE ───────────────────────────────────────────────────────────
 *
 * Fields, and why each one is here rather than being obvious from the command:
 *
 *   name          becomes `mcp__<name>__<tool>`, so it must satisfy the server
 *                 name rule in `readMcpConfig` or the whole config is rejected.
 *   purpose       one honest line. Not marketing — what you get.
 *   command/args  exactly what `mcp.mjs` will spawn. No shell, no expansion.
 *   needsDownload true when the package is not already on the machine. Under
 *                 this client that means it CANNOT self-install.
 *   install       the line to paste. Required whenever needsDownload is true.
 *   credentials   [{ env, required, why }]. `required: false` means the server
 *                 starts without it but offers fewer tools.
 *   verified      did I personally run it, through the real client?
 *   note          what running it actually did, or why it is unverified.
 *   enabledByDefault  only ever true when verified && !needsDownload && no
 *                 required credentials. Tests enforce this; see the header.
 */
export const CATALOGUE = Object.freeze([
  Object.freeze({
    name: 'acuvo',
    purpose: 'Render HTML in a real browser and get the screenshot plus measured layout and contrast defects back; turn HTML into a PDF, PNG or PPTX.',
    command: 'node',
    args: Object.freeze([`${PACKAGE_ROOT_TOKEN}/bin/acuvo-mcp.mjs`]),
    /**
     * ⭐ THE ONLY ENTRY THAT NEEDS NO DOWNLOAD, because we ship it. `bin/
     * acuvo-mcp.mjs` is in this package's `files` list, so it is on disk the
     * moment acuvo-code is.
     *
     * ⚠️ AND IT IS SPAWNED AS `node <abs path>`, NOT AS `acuvo-mcp`. I tried
     * the bare bin name and got ENOENT: the shim is `acuvo-mcp.cmd`, and
     * `resolveExecutable` only finds it when PATH is separated the Windows way
     * — under Git Bash PATH is `:`-separated and the lookup misses entirely.
     * `node` resolves as `node.exe` everywhere, and an absolute script path
     * needs no lookup at all.
     */
    needsDownload: false,
    install: null,
    credentials: Object.freeze([
      Object.freeze({ env: 'RENDER_AUDIT_URL', required: false, why: 'without it the `see_page` tool is not offered' }),
      Object.freeze({ env: 'MODAL_PRESS_URL', required: false, why: 'without it the `make_document` tool is not offered' }),
      Object.freeze({ env: 'MODAL_VIDEO_SECRET', required: false, why: 'only if those services require a shared secret' }),
    ]),
    verified: true,
    note: 'Ran it: connected in 156ms with no download and no credentials, and offered zero tools — its two tools are gated on the URLs above. It stays up and answers with an empty list rather than dying, so it costs a spawn and never a 20s timeout.',
    enabledByDefault: true,
  }),

  /**
   * ── ⭐⭐ THE ONE CAPABILITY THIS CLI COULD NOT REACH AT ALL ────────────────
   *
   * `see_page` RENDERS a page and measures it. Nothing in the 49-tool registry
   * can CLICK a button, FILL a form, or drive a flow — which is most of what
   * "test the thing you just built" actually means. That is not a gap MCP
   * merely papers over; it is the single largest capability this client does
   * not have and cannot cheaply build.
   *
   * ⭐ WHY chrome-devtools-mcp AND NOT PLAYWRIGHT, having weighed both:
   *   1. It drives the Chrome ALREADY ON THE MACHINE. Playwright's MCP server
   *      additionally needs `npx playwright install chromium` — a ~150MB
   *      download on top of the package, on a client that cannot download.
   *   2. `npm view chrome-devtools-mcp` → **zero runtime dependencies** (it is
   *      rollup-bundled), Apache-2.0, 14MB installed, and no postinstall step
   *      that fetches a browser. Nothing about it can surprise a security
   *      reviewer, which for a server we RECOMMEND is the whole point.
   *   3. It is Google's own, versioned 1.7.0 and current.
   *
   * ⚠️ IT IS STILL NOT A DEFAULT, and the rule is not being bent for it: it
   * needs a download, so under `--no` it cannot start, so enabling it would buy
   * a guaranteed 20s stall. Rule 1 applies to the capability we most want.
   *
   * ⚠️ AND IT NEEDS A REAL CHROME. That is a machine fact no environment
   * variable expresses, so it cannot be in `credentials` and the precheck
   * cannot see it — `assessEntry` will say "live" on a machine with no browser.
   * Stated here rather than implied away.
   */
  Object.freeze({
    name: 'browser',
    purpose: 'Drive a real Chrome: click, fill forms, type, navigate, read the accessibility tree, screenshot, and read console messages, network requests and performance traces.',
    command: 'npx',
    args: Object.freeze(['-y', 'chrome-devtools-mcp']),
    needsDownload: true,
    install: 'npm i -g chrome-devtools-mcp',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT, end to end, through the real connectServer — and then CALLED IT, which no other entry here has earned. Connected in 1,935ms and listed 29 tools (click, fill, fill_form, type_text, navigate_page, take_snapshot, take_screenshot, evaluate_script, upload_file, list_network_requests, performance_start_trace, lighthouse_audit …); `navigate_page` to a data: URL answered ok in 789ms and `take_snapshot` in 13ms, returning the accessibility tree with the button named. 29 is under MAX_TOOLS_PER_SERVER (40), so nothing is truncated. Add `--headless` and `--isolated` to args for CI. ⚠️ It drives the Chrome already installed on the machine and does NOT download one; with no Chrome present the connection still succeeds and the first tool call is what fails. Installed here from the npm cache — see the header on why nothing else could be.',
    enabledByDefault: false,
  }),

  /**
   * ── ⭐⭐ THE SECOND CAPABILITY THIS CLI STRUCTURALLY CANNOT HAVE ───────────
   *
   * A coding agent's most common wrong answer is not a logic error — it is
   * CONFIDENTLY CURRENT-SOUNDING API ADVICE FROM A STALE TRAINING SET. Nothing
   * in the 49-tool registry fixes that: `web_search` returns result pages and
   * `fetch_url` returns one document, so "how do I write a route handler in
   * this framework's current major" costs several paid rounds of reading HTML
   * and still lands wherever the model's priors were.
   *
   * ⭐ WHY THIS EARNS A SLOT WHEN `web_search` AND `fetch_url` ALREADY EXIST:
   * it returns VERSIONED, SOURCE-CITED SNIPPETS from the library's own repo
   * rather than prose about them. The measured call below came back with the
   * `route.js` signature and a GitHub source path per snippet. That is the
   * difference between evidence and a search result, and it is the same
   * argument `see_page` makes against a screenshot: hand the model the answer,
   * not the material to derive it from.
   *
   * ⭐⭐ AND IT NEEDS NO CREDENTIAL, which is rare enough to be the deciding
   * factor. Rule 2 exists because a keyed server is a guaranteed 20s stall for
   * anyone who has not signed up; this one is one `npm i -g` away from working
   * for every user, with no account. Of everything weighed for this expansion it
   * is the only candidate that clears both the "a working developer reaches for
   * it" bar and the no-signup bar.
   *
   * ⚠️ IT IS STILL NOT A DEFAULT. Rule 1 is not bent for it either: it needs a
   * download, so under `--no` it cannot start, so enabling it would buy the
   * guaranteed 20s stall. Every argument above is an argument for CURATING it,
   * not for spawning it uninvited.
   *
   * ⚠️ AND IT IS A THIRD-PARTY NETWORK SERVICE. The query text — which will
   * often be the user's actual problem statement — leaves the machine to
   * Upstash's API. That is an egress path an enterprise reviewer must be told
   * about, exactly like `generate_image`'s, and it is why this sits behind an
   * explicit opt-in rather than in `mcpServers`.
   *
   * ⚠️ ITS TWO REQUIRED ARGUMENTS CONTRADICT EACH OTHER IN THE ERROR MESSAGE,
   * measured, and it cost two calls to work out: passing only `libraryName`
   * complains *"query: expected string, received undefined"*, and passing only
   * `query` complains *"libraryName: expected string, received undefined"*.
   * Both are required. Recorded because the model will hit this too, and the
   * server's own error names the field it was NOT given.
   */
  Object.freeze({
    name: 'docs',
    purpose: 'Look up current, version-specific documentation and code examples for a library, returned as source-cited snippets rather than as search results.',
    command: 'npx',
    args: Object.freeze(['-y', '@upstash/context7-mcp']),
    needsDownload: true,
    install: 'npm i -g @upstash/context7-mcp',
    /**
     * ⚠️ DELIBERATELY EMPTY, and that is a claim I checked rather than assumed.
     * Context7 sells an API key for higher rate limits; the server starts and
     * ANSWERS without one — proven by the calls in `note`, made with a scrubbed
     * environment containing no Context7 variable of any kind. Listing an
     * optional credential here would have darkened nothing but would have
     * implied a signup that is not required.
     */
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT, end to end, through the real connectServer — and CALLED IT TWICE, with no API key. Connected in 3,338–8,348ms across four runs and listed 2 tools (resolve-library-id, query-docs). `resolve-library-id` for "next.js" answered ok in 2,250ms with real registry data (/vercel/next.js, 6071 snippets, a version list); `query-docs` on /vercel/next.js for "how do I define a route handler" answered ok in 2,536ms with the actual current `export async function GET(request: Request) {}` signature and a GitHub source URL per snippet. ⚠️ Two tools is FAR under MAX_TOOLS_PER_SERVER (40), so it is a cheap entry in prefix bytes as well as in dollars. ⚠️ It is a network service: your query text leaves the machine to Upstash. ⚠️ Both `libraryName` and `query` are required by resolve-library-id even though each error message names only the other one.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'filesystem',
    purpose: 'Read and write files under directories you name — the reference MCP server, and the usual first one people add.',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-filesystem', '.']),
    needsDownload: true,
    install: 'npm i -g @modelcontextprotocol/server-filesystem',
    credentials: Object.freeze([]),
    verified: true,
    note: 'Ran it: REFUSED. `mcp.mjs` injects `--no` and strips `-y`, so npx may only run an already-installed package. npx spent 12s on the registry then said "npx canceled due to missing packages and no YES option", and connectServer still reported it at 20,083ms. Install it globally first and this entry works.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'firecrawl',
    purpose: 'Fetch and crawl web pages as clean markdown, including JavaScript-rendered ones.',
    command: 'npx',
    args: Object.freeze(['-y', 'firecrawl-mcp']),
    needsDownload: true,
    install: 'npm i -g firecrawl-mcp',
    credentials: Object.freeze([
      Object.freeze({ env: 'FIRECRAWL_API_KEY', required: true, why: 'the server refuses to start without it' }),
    ]),
    verified: true,
    note: 'Ran it with the package already installed globally: it still failed, with its own message — "Either FIRECRAWL_API_KEY or FIRECRAWL_API_URL must be provided" — and connectServer reported it at 20,052ms. This is the entry that proves the credential rule is about latency, not tidiness.',
    enabledByDefault: false,
  }),

  /**
   * ⚠️ THIS SLOT USED TO BE `git`, POINTING AT npm `mcp-server-git` — which is a
   * security-research canary, not a server. See the header. It is gone, and the
   * capability was never missing: `git_status`, `git_diff`, `git_log` and
   * `git_commit` are native tools in this CLI.
   *
   * ⚠️ THE CANONICAL PLAYWRIGHT INSTALL LINE IS REFUSED BY THIS CLIENT BY
   * DESIGN, and that is the single most valuable thing this entry carries.
   * Every Playwright MCP README says:
   *     {"command":"npx","args":["-y","@playwright/mcp@latest"]}
   * `mcp.mjs:261` filters `-y`/`--yes` out and injects `--no`, so that becomes
   * `npx --no @playwright/mcp@latest` — which cannot install anything and dies,
   * costing the full 20s handshake with no explanation. A user who pastes the
   * documented line gets a silent 20-second stall and a dark server, and has no
   * way to know why. The args below are the form that CAN work: no `-y` to be
   * stripped, and NO `@latest`, because `packageOf` feeds the installed-package
   * lookup and a tagged spec never matches an installed package name.
   *
   * ── ⭐ PROMOTED FROM INERT TO VERIFIED, 2026-08-14 ──────────────────────────
   *
   * It sat unverified for exactly one day, and the reason recorded in its own
   * note was an environment claim — "no npm package can be installed on this
   * machine" — that stopped being true. See the header. Re-measured rather than
   * re-argued.
   */
  Object.freeze({
    name: 'playwright',
    purpose: 'Drive a Playwright-managed browser — click, fill, navigate and assert against a live page, across Chromium, Firefox and WebKit.',
    command: 'npx',
    args: Object.freeze(['-y', '@playwright/mcp']),
    needsDownload: true,
    // ⚠️ TWO commands, because the package alone is not always enough:
    // Playwright installs its browsers separately, and the second line is
    // ~150MB. It is `&&`-joined rather than split because the second half is
    // the one people skip, and skipping it fails at the first CALL rather than
    // at connect — see the note.
    install: 'npm i -g @playwright/mcp && npx playwright install chromium',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT, end to end, through the real connectServer, and CALLED IT. Connected in 2,600–15,118ms and listed 24 tools (browser_click, browser_fill_form, browser_type, browser_navigate, browser_snapshot, browser_take_screenshot, browser_evaluate, browser_file_upload, browser_select_option, browser_tabs, browser_network_requests …); `browser_navigate` to a data: URL answered ok in 1,027ms and returned the Playwright code it ran. 24 is under MAX_TOOLS_PER_SERVER (40), so nothing is truncated. ⚠️ THE FIRST CONNECT TOOK 15,118ms — 75% of the 20s handshake budget — while a warm one took 2,600ms; a slower machine can therefore fail the handshake on first use and look permanently broken when it is merely cold. ⚠️ IT WRITES INTO YOUR WORKSPACE: the navigate call created `.playwright-mcp/page-<timestamp>.yml` in the current directory, unasked. Pass `--output-dir` to send that somewhere else, and expect to gitignore it otherwise — no other entry in this catalogue writes to the repo. ⚠️ It found a browser here without `npx playwright install chromium` having been run in this session, so that step is conditional on what the machine already has, not universal. Prefer the `browser` entry above unless you need Firefox or WebKit — it needs no browser download and does not litter the workspace.',
    enabledByDefault: false,
  }),

  /**
   * ── ⚠️ BELOW HERE: UNVERIFIED, AND THEREFORE INERT ────────────────────────
   * I did not run these. They are real, widely-used servers and the commands
   * are the documented ones, but "documented" is not "measured" and this file
   * refuses to blur the two. They can never be enabled and are never rendered
   * active; they exist so the availability report can hand over an install
   * command instead of a shrug. Promote one by RUNNING it and rewriting `note`
   * with what happened.
   */

  Object.freeze({
    name: 'github',
    purpose: 'Issues and pull requests — open, read and comment on your issue tracker from inside a run.',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-github']),
    needsDownload: true,
    install: 'npm i -g @modelcontextprotocol/server-github',
    credentials: Object.freeze([
      Object.freeze({ env: 'GITHUB_PERSONAL_ACCESS_TOKEN', required: true, why: 'every call is authenticated; the server will not start without it' }),
    ]),
    verified: false,
    note: 'NOT RUN by me. Listed for the install command only. Needs both a download and a token, so it is dark twice over. ⚠️ AND IT IS DEPRECATED: `npm view` on 2026-08-14 reports version 2025.4.8 carrying `deprecated: "Package no longer supported."` It still resolves and still installs, but it is not maintained, and GitHub\'s current server is a Go binary / hosted HTTP service that this stdio-only, npx-only client cannot start.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'postgres',
    purpose: 'Run read-only queries against a Postgres database and inspect its schema.',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-postgres']),
    needsDownload: true,
    install: 'npm i -g @modelcontextprotocol/server-postgres',
    credentials: Object.freeze([
      Object.freeze({ env: 'POSTGRES_CONNECTION_STRING', required: true, why: 'there is nothing to connect to without it' }),
    ]),
    verified: false,
    note: 'NOT RUN by me. Listed for the install command only. Needs both a download and a connection string. ⚠️ AND IT IS DEPRECATED: `npm view` on 2026-08-14 reports version 0.6.2 carrying `deprecated: "Package no longer supported."` It is the last published build of the reference server and still installs; treat it as frozen, not as maintained.',
    enabledByDefault: false,
  }),

  /**
   * ── ⭐ WHAT WAS WEIGHED AND REJECTED, 2026-08-14 ────────────────────────────
   *
   * The thesis at the top of this file is that CURATION is the edge, not access.
   * That is only true if the rejections are real, so they are written down here
   * with the reason — otherwise "curated" degrades into "whatever got added".
   *
   *   · **SQLite** (`mcp-server-sqlite-npx`, 0.8.0, ISC) — REJECTED, and it was
   *     the strongest miss. "A database the audience actually uses" is a fair
   *     brief and SQLite is the honest answer to it. But `npm view … dependencies`
   *     shows it pulls **`sqlite3` ^5.1.7**, a NATIVE module: installing it means
   *     a prebuilt-binary download or a node-gyp compile, on a package we are
   *     RECOMMENDING to strangers. Every other entry here is plain JavaScript
   *     that a reviewer can read. `npm view` also returned no `repository.url`,
   *     so provenance is weaker than the two Anthropic-published entries above.
   *     ⭐ The deciding argument: a curated set is a set of things we are willing
   *     to be blamed for. A native compile that fails on a user's machine is a
   *     support burden bought for a capability they can already reach by
   *     declaring the server themselves.
   *   · **`@modelcontextprotocol/server-memory` / `…-sequential-thinking`
   *     (2026.7.4)** — REJECTED as DUPLICATES of shipped native tools, which is
   *     the failure mode `mcp-server-git` already demonstrated. This CLI has
   *     `remember`/`forget` (`learned.mjs`) and `plan_*` (`plan-ledger.mjs`).
   *     Adding an MCP server that shadows a native tool spends 20s of handshake
   *     budget and prefix bytes to offer the model a second, worse door to a
   *     verb it already has — and gives it two places to store one fact.
   *   · **Notion (2.5.1) / Supabase (0.10.0)** — REJECTED for this pass, not on
   *     quality: both require an account and a token, so both are dark on every
   *     machine until a signup happens (rule 2). They are the right SECOND wave,
   *     once someone actually asks. A catalogue whose entries are mostly dark
   *     for mostly everyone is the forty-servers-off-a-README failure wearing
   *     better names.
   */
]);

/** Look one up by name. Returns null rather than throwing — callers branch anyway. */
export function catalogueEntry(name) {
  return CATALOGUE.find((e) => e.name === name) ?? null;
}

/**
 * Substitute `PACKAGE_ROOT_TOKEN` in an entry's args.
 *
 * ⚠️ FORWARD SLASHES ARE LEFT ALONE ON PURPOSE. Windows accepts them in a path
 * passed to `node`, and rewriting them to backslashes would put an escape
 * character into a JSON file that a human is expected to read and edit.
 */
export function resolveArgs(entry, { packageRoot = PACKAGE_ROOT } = {}) {
  const root = String(packageRoot).split(String.fromCharCode(92)).join('/');
  return (entry?.args ?? []).map((a) => a.split(PACKAGE_ROOT_TOKEN).join(root));
}

/** The `mcp.mjs` server spec for an entry — what `connectServer` wants. */
export function toServerSpec(entry, { packageRoot = PACKAGE_ROOT } = {}) {
  return {
    name: entry.name,
    command: entry.command,
    args: resolveArgs(entry, { packageRoot }),
    env: {},
  };
}

/** The credentials an entry cannot start without. */
export function requiredCredentials(entry) {
  return (entry?.credentials ?? []).filter((c) => c.required);
}

function present(env, name) {
  const v = env?.[name];
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * ── ⭐ THE PRECHECK — DECIDE WITHOUT SPAWNING ───────────────────────────────
 *
 * Returns doctor's shape (`state` / `detail` / `fix`) so a doctor lane can drop
 * these straight into its check list without a translation layer.
 *
 * `installed` is INJECTED rather than probed. Whether a package is on disk is
 * an I/O question, and this module stays pure so it is testable with no
 * network and no filesystem. A caller that knows (the doctor, which is already
 * allowed to look) passes a Set of package names; a caller that does not gets
 * the honest answer that a download-needing entry cannot be assumed present.
 *
 * ⚠️ `state: 'live'` IS THE WEAKER CLAIM IT LOOKS LIKE. It means "nothing
 * checkable rules this out", not "this will work". A revoked key looks exactly
 * like a good one from here, and the wording of `detail` never pretends
 * otherwise.
 */
export function assessEntry(entry, { env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  const base = {
    id: `mcp.${entry.name}`,
    label: entry.name,
    entry: entry.name,
    purpose: entry.purpose,
    verified: entry.verified,
    enabledByDefault: entry.enabledByDefault,
  };

  // ⚠️ DOWNLOAD FIRST: it is the reason that cannot be worked around by setting
  // a variable, so reporting a missing key on a package that is not even here
  // would send the user to fix the second problem first.
  if (entry.needsDownload) {
    const known = installed instanceof Set ? installed : null;
    const pkg = packageOf(entry);
    if (!known || !known.has(pkg)) {
      return {
        ...base,
        state: 'dark',
        detail: known
          ? `${pkg} is not installed — this client passes npx \`--no\`, so it cannot download it`
          : `needs ${pkg}, and whether it is installed was not checked — this client passes npx \`--no\`, so it cannot download it`,
        fix: `${entry.install} — then re-run. Leaving it unconfigured costs a ${Math.round(DARK_ENTRY_COST_MS / 1000)}s timeout every session it is enabled.`,
        costMs: DARK_ENTRY_COST_MS,
      };
    }
  }

  const missing = requiredCredentials(entry).filter((c) => !present(env, c.env));
  if (missing.length > 0) {
    const names = missing.map((c) => c.env).join(', ');
    return {
      ...base,
      state: 'dark',
      detail: `${names} ${missing.length === 1 ? 'is' : 'are'} not set — ${missing[0].why}`,
      fix: `set ${names}. Until then this server cannot start, and enabling it costs a ${Math.round(DARK_ENTRY_COST_MS / 1000)}s timeout every session.`,
      costMs: DARK_ENTRY_COST_MS,
    };
  }

  const optionalMissing = (entry.credentials ?? []).filter((c) => !c.required && !present(env, c.env));
  const detail = optionalMissing.length > 0
    ? `can start; ${optionalMissing.map((c) => c.env).join(', ')} not set, so it will offer fewer tools`
    : 'can start, and nothing checkable rules it out';

  return {
    ...base,
    state: 'live',
    detail,
    /**
     * ⚠️ EACH REASON STAYS ATTACHED TO ITS VARIABLE. Joining the names and then
     * joining the reasons produced "without it …; without it …", where "it"
     * pointed at nothing — three variables and three dangling pronouns.
     */
    fix: optionalMissing.length > 0
      ? `set ${optionalMissing.map((c) => `${c.env} (${c.why})`).join('; ')}`
      : null,
    costMs: 0,
    command: `${entry.command} ${resolveArgs(entry, { packageRoot }).join(' ')}`.trim(),
  };
}

/**
 * The npm package an entry runs, for install checks. Null when we ship it.
 *
 * ── ⚠️ THE DIST-TAG IS STRIPPED, AND THAT IS NOT COSMETIC ───────────────────
 *
 * This value is the KEY looked up in the `installed` Set, and an installed
 * package is recorded under its NAME. Every MCP README in the world writes
 * `@playwright/mcp@latest` or `chrome-devtools-mcp@latest`, so the moment
 * somebody copies one in, `assessEntry` looks up `"@playwright/mcp@latest"`,
 * never finds it, and reports a perfectly working server as dark FOREVER —
 * a check that cannot pass, which is the same shape as a check that cannot
 * fail and just as useless.
 *
 * ⚠️ THE LAST `@`, NOT THE FIRST. A scoped name begins with one:
 * `@playwright/mcp` is the package, `@playwright/mcp@latest` is the package plus
 * a tag. Splitting on the first `@` would turn every scoped package into an
 * empty string.
 *
 * A catalogue entry must not carry a tag in the first place — there is a test —
 * but the stripping stays, because the next person to add an entry will paste
 * the README line and the failure it causes is silent.
 */
export function packageOf(entry) {
  if (!entry?.needsDownload) return null;
  // The first arg that is not a flag is the package npx would run.
  const spec = (entry.args ?? []).find((a) => !a.startsWith('-')) ?? null;
  if (!spec) return null;
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Assess every entry. Same order as the catalogue, so output is stable. */
export function assessCatalogue({ env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  return CATALOGUE.map((e) => assessEntry(e, { env, installed, packageRoot }));
}

/**
 * The entries that should actually be spawned here: enabled by default AND
 * assessed live.
 *
 * ⚠️ BOTH CONDITIONS, NOT EITHER. `enabledByDefault` is a property of the
 * catalogue; `live` is a property of this machine right now. An entry can be a
 * fine default and still be dark today, and spawning it anyway is the 20s
 * stall this whole module exists to avoid.
 */
export function defaultServerSpecs({ env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  const assessed = new Map(assessCatalogue({ env, installed, packageRoot }).map((a) => [a.entry, a]));
  return CATALOGUE
    .filter((e) => e.enabledByDefault && assessed.get(e.name)?.state === 'live')
    .slice(0, MAX_SERVERS)
    .map((e) => toServerSpec(e, { packageRoot }));
}

/**
 * ── THE STARTER CONFIG ──────────────────────────────────────────────────────
 *
 * ⚠️ `mcp.json` IS STRICT JSON, SO THE EXPLANATIONS CANNOT BE COMMENTS. They go
 * in `_disabled`, a key `readMcpConfig` never reads (it takes `mcpServers` ??
 * `servers` and nothing else). The user gets the whole catalogue in the file
 * they are already editing, with the reason each one is off and the command
 * that turns it on — and the client still only ever spawns what is in
 * `mcpServers`.
 *
 * ⚠️ CAPPED AT `MAX_SERVERS`, because `readMcpConfig` drops the overflow with a
 * bare `break` — no error, no warning. Rendering a 10-entry config would be
 * rendering two entries that silently never run.
 */
export function renderStarterConfig({ env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  const assessed = new Map(assessCatalogue({ env, installed, packageRoot }).map((a) => [a.entry, a]));

  const mcpServers = {};
  const _disabled = {};

  for (const entry of CATALOGUE) {
    const a = assessed.get(entry.name);
    const active = entry.enabledByDefault && a?.state === 'live' && Object.keys(mcpServers).length < MAX_SERVERS;
    if (active) {
      mcpServers[entry.name] = {
        command: entry.command,
        args: resolveArgs(entry, { packageRoot }),
      };
      continue;
    }
    _disabled[entry.name] = {
      what: entry.purpose,
      why_off: a?.detail ?? 'not enabled by default',
      to_enable: a?.fix ?? null,
      verified_by_us: entry.verified,
      note: entry.note,
      command: entry.command,
      args: resolveArgs(entry, { packageRoot }),
    };
  }

  return {
    // ⭐ A header the user reads before the servers, in a key the client ignores.
    _readme: [
      `Written by acuvo-code. Only "mcpServers" is read; "_disabled" and "_hosted_example" are documentation.`,
      `Move an entry from _disabled into mcpServers to turn it on — its "to_enable" says what it needs first.`,
      `A server that cannot start costs a ${Math.round(DARK_ENTRY_COST_MS / 1000)}s timeout at session start, which is why they are off.`,
      `At most ${MAX_SERVERS} servers are read; anything past that is silently ignored.`,
      `Hosted servers work too — see "_hosted_example"; they need no install at all.`,
    ].join(' '),
    mcpServers,
    /**
     * ── ⭐ THE HOSTED SHAPE, IN THE FILE THE USER IS ALREADY EDITING ─────────
     *
     * Every entry in `CATALOGUE` is a program we spawn, because that was the
     * only transport `mcp.mjs` had until 2026-08-15. It now speaks Streamable
     * HTTP and SSE as well, and hosted servers are the half of the ecosystem
     * that needs no install, no npx and no `--no` argument — the rules that
     * darken most of the catalogue simply do not apply to them.
     *
     * ⚠️ AN EXAMPLE, NOT A RECOMMENDATION, and it sits OUTSIDE `mcpServers` for
     * that reason. `readMcpConfig` reads `mcpServers` (or `servers`) and nothing
     * else, so this is inert text — the same guarantee `_disabled` relies on.
     * Nothing here has been run by us, and this file's whole discipline is that
     * an unverified entry must not be able to become an active one.
     *
     * ⚠️ THE `${…}` IS THE POINT. A remote server gets no inherited environment,
     * so a credential has to be named in the config and is expanded from your
     * shell at connect time — never written into this file. If the variable is
     * unset, acuvo refuses to connect rather than sending the literal text.
     */
    _hosted_example: {
      _what: 'A server reached over the network. Not read by the client — copy an entry into "mcpServers" to use it.',
      _rules: [
        'https:// is required unless the host is loopback, so a token never crosses in cleartext.',
        'Credentials come from your environment via ${VAR} in "headers"; the value is never stored here.',
        'You are asked to approve the HOST before the first connection, and again if the url or the headers change.',
      ].join(' '),
      example_http: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${EXAMPLE_TOKEN}' } },
      example_sse: { type: 'sse', url: 'http://127.0.0.1:3845/sse' },
    },
    _disabled,
  };
}

/** The starter config as the text to write to `.acuvo/mcp.json`. */
export function renderStarterConfigJson(opts = {}) {
  return `${JSON.stringify(renderStarterConfig(opts), null, 2)}\n`;
}

/**
 * A human-readable availability report — what is usable here and what is dark,
 * with the reason and the fix on the same line as the name.
 */
export function formatAvailability(report) {
  const rows = Array.isArray(report) ? report : assessCatalogue(report ?? {});
  const live = rows.filter((r) => r.state === 'live');
  const lines = [
    `MCP defaults — ${live.length} of ${rows.length} usable here`,
    '',
  ];
  for (const r of rows) {
    const mark = r.state === 'live' ? 'live' : 'dark';
    const flag = r.verified ? '' : ' (unverified — never enabled)';
    lines.push(`  ${mark.padEnd(4)}  ${r.label.padEnd(12)} ${r.detail}${flag}`);
    if (r.fix) lines.push(`        ${' '.repeat(12)} → ${r.fix}`);
  }
  const stalled = rows.filter((r) => r.state === 'dark' && r.enabledByDefault);
  if (stalled.length > 0) {
    lines.push('', `  ⚠️ ${stalled.length} default(s) would stall this session by ${Math.round((stalled.length * DARK_ENTRY_COST_MS) / 1000)}s if spawned — they are skipped.`);
  }
  return lines.join('\n');
}

/**
 * Doctor-shaped checks. Kept separate from `assessCatalogue` so the doctor's
 * list is not flooded: one line per entry is right for `--mcp`, but the health
 * report wants the summary plus only the entries a user can act on.
 */
export function doctorChecks({ env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  const rows = assessCatalogue({ env, installed, packageRoot });
  const live = rows.filter((r) => r.state === 'live');
  const summary = {
    id: 'mcp.defaults',
    label: 'MCP defaults',
    state: live.length > 0 ? 'live' : 'dark',
    verified: true,
    detail: `${live.length} of ${rows.length} catalogue entries usable here${live.length ? ` (${live.map((r) => r.label).join(', ')})` : ''}`,
    fix: live.length > 0 ? null : `run with --mcp-init to write ${STARTER_CONFIG_FILE}, then install or configure one`,
  };
  return [summary, ...rows.filter((r) => r.enabledByDefault)];
}
