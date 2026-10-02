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
 *
 * ── ⭐⭐⭐ 2026-08-25: THE RULES WERE WRITTEN FOR A TRANSPORT WE NO LONGER ONLY
 *                     HAVE, AND THAT IS WHY THIS CATALOGUE WAS SO SMALL ───────
 *
 * Every rule above is arithmetic about SPAWNING A PROCESS. Rule 1 (no download)
 * exists because `mcp.mjs` injects npx `--no`. Rule 2 (no credentials) exists
 * because a stdio server that cannot authenticate still burns the full 20s
 * handshake. Both were measured, both are correct — **and neither applies to a
 * server reached over HTTP.** `mcp.mjs` grew Streamable HTTP and SSE on
 * 2026-08-15; the catalogue never noticed, and stayed a list of eight programs.
 *
 * ⭐ MEASURED TODAY, through the real `connectRemoteServer`, with an EMPTY env
 * (`{ env: {} }` — no key of any kind could have leaked in), on this machine:
 *
 *     deepwiki      OK   1,754ms   3 tools    read_wiki_structure → real page list
 *     context7      OK   1,924ms   2 tools    (the hosted twin of the `docs` entry)
 *     mslearn       OK     783ms   3 tools    microsoft_docs_search → real Azure docs
 *     awsdocs       OK   1,030ms   5 tools    aws___search_documentation → real Lambda docs
 *     grep          OK   1,002ms   1 tool     searchGitHub → real vscode source hit
 *     huggingface   OK     719ms   4 tools    hub_repo_search → 6 real repos
 *     cloudflare    OK     416ms   2 tools    search_cloudflare_documentation → real KV docs
 *
 * ⭐⭐ SEVEN SERVERS, ZERO DOWNLOADS, ZERO CREDENTIALS, ALL UNDER TWO SECONDS.
 * Under this module's own rules they are `live` — not "live if you npm i", not
 * "live if you sign up". That is a bigger expansion of what this CLI can do than
 * anything the stdio half of the catalogue has produced, and it cost nothing but
 * noticing that the transport had changed.
 *
 * ── ⭐ AND THE SECOND MEASUREMENT KILLED THE OTHER HALF OF THE ARITHMETIC ────
 *
 * A CREDENTIALED hosted server does not cost 20 seconds either. Probed the same
 * way, anonymously, same run:
 *
 *     vercel  401 in   605ms · sentry 401 in 144ms · linear   401 in   118ms
 *     github  401 in   741ms · notion 401 in 134ms · stripe   401 in   468ms
 *     supabase 401 in  332ms
 *
 * ⚠️ SO `DARK_ENTRY_COST_MS` — the number that justifies rule 2, and that this
 * file quotes at the user in every `fix` line — IS WRONG FOR A HOSTED ENTRY BY
 * A FACTOR OF ABOUT THIRTY. An unconfigured hosted server answers 401 and gets
 * out of the way; an unconfigured stdio server holds the session for 20,052ms.
 * Quoting 20s at someone whose real cost is 741ms is the same class of stale
 * claim as the install-block sentence above, and it would have talked us out of
 * exactly the entries worth having. See `HOSTED_DARK_COST_MS`.
 *
 * ── ⚠️ THE NEW RULE THAT REPLACES "IS IT ON npm": WHOSE HOST IS IT? ──────────
 *
 * A hosted entry has no package to `npm view`, so the registry checks that
 * caught `mcp-server-git` cannot run on it. The substitute is stricter and is
 * checkable from the config line itself: **a hosted entry must live on the
 * apex domain of the vendor whose data it serves.** `learn.microsoft.com` is
 * Microsoft's, `knowledge-mcp.global.api.aws` is AWS's, `huggingface.co` is
 * Hugging Face's, `docs.mcp.cloudflare.com` is Cloudflare's, `mcp.grep.app` is
 * grep.app's (Vercel), `mcp.deepwiki.com` is Cognition's. A third party
 * proxying somebody else's docs gets no entry here, however good it is, because
 * the only trust signal a URL carries is who answers on it — and there is a
 * test that enforces exactly this.
 *
 * ⚠️ AND A HOSTED ENTRY IS AN EGRESS DECISION, WHICH IS WHY NONE OF THEM IS A
 * DEFAULT. The `docs` entry already made this argument and it has not weakened:
 * the query text is usually the user's actual problem statement, and it leaves
 * the machine. `live` here means "you can turn this on in one line", never "we
 * turned it on for you". The only entry we start uninvited is still the one we
 * ship and that talks to nobody.
 *
 * ── LICENCE, NOW A FIELD RATHER THAN AN ASSUMPTION ──────────────────────────
 *
 * Every entry carries `licence`, checked with `npm view <pkg> license` on the
 * stated date. AGPL is never acceptable here — we tell strangers to install
 * these — and "no licence field at all" is treated as worse than a bad one (see
 * the `exa-mcp-server` rejection below). For a hosted entry there is no licence
 * to check, because no code is installed; the honest field says so and points at
 * the thing that DOES matter, which is the terms and the egress.
 *
 * ── ⚠️⚠️⭐ 2026-08-26: EVERY FLAG THIS CATALOGUE PUTS AFTER A PACKAGE NAME IS
 *                      EATEN BY npm BEFORE THE SERVER EVER SEES IT ────────────
 *
 * The single most expensive thing found in this pass, and it was found by
 * accident while measuring something else. `connectServer` runs
 * `npx --no <pkg> <args…>`. Under npm 11, an arg beginning with `--` that
 * follows the package name is parsed as an **npm config option**, not as an
 * argument to the program. Measured on this machine, verbatim:
 *
 *     $ npx --no tavily-mcp --headless --isolated
 *     npm warn Unknown cli config "--headless". This will stop working in the
 *              next major version of npm.
 *     npm warn Unknown cli config "--isolated". This will stop working in the
 *              next major version of npm.
 *
 * …and the server started with neither flag. The same run against
 * `@bytebase/dbhub --demo --transport stdio` produced the identical warnings,
 * npm swallowed both `--` flags, kept only the bare word `stdio` as a
 * positional, and dbhub died with *"Database connection configuration is
 * required"* — reported by `connectServer` at **20,060ms**, the full handshake
 * timeout, with the usage text as the only clue.
 *
 * ⭐ THE FIX IS ONE TOKEN: a bare `--` before the program's own flags.
 *     ✗ ['-y', '@bytebase/dbhub', '--transport', 'stdio', '--demo']
 *     ✓ ['-y', '@bytebase/dbhub', '--', '--transport', 'stdio', '--demo']
 * Verified three ways (`pkg -- flags`, `-- pkg flags`, `--package=pkg -- bin
 * flags`); all three deliver the flags. `--` is skipped by `packageOf` and by
 * the dist-tag test, because both ignore args starting with `-`, so nothing
 * downstream had to change.
 *
 * ⚠️ AND IT HAD ALREADY REACHED A USER-FACING STRING. The `browser` entry's note
 * told people *"Add `--headless` and `--isolated` to args for CI"* — advice that
 * cannot work, in the entry we describe as our most valuable. Corrected below.
 * A POSITIONAL arg is unaffected (`server-filesystem`'s `.`, `postgres`'s
 * connection string), which is why this survived: every existing entry happened
 * to use positionals only. **There is now a test** —
 * `test/mcp-catalogue-stdio-flags.test.mjs` — that fails any entry with a
 * `--flag` after the package name and no `--` separator.
 *
 * ── ⭐⭐ THE 2026-08-26 STDIO PASS: 30+ PACKAGES CHECKED, 2 KEPT, 1 KILLED ON
 *          LATENCY ────────────────────────────────────────────────────────────
 *
 * The 2026-08-25 pass grew the hosted half. This one went back to the half that
 * spawns, because two capabilities a coding agent genuinely lacks were still
 * open here and both had been REJECTED rather than merely missed:
 *
 *   · **WEB SEARCH** — open since `exa-mcp-server` was rejected for publishing
 *     no licence at all. Closed by `tavily` below, which turned out to need **no
 *     key at all** for search and extract. That was not the plan; it was the
 *     measurement.
 *   · **A DATABASE THAT IS NOT POSTGRES** — the SQLite candidate was rejected on
 *     2026-08-14 for pulling `sqlite3`, a native module. ⚠️ **THAT REJECTION IS
 *     NOW OBSOLETE AND THE REASON IS A NODE VERSION.** Node ships `node:sqlite`
 *     built in from 22.5.0, so a server can speak SQLite with no compile at all.
 *     `@bytebase/dbhub` does exactly that and adds Postgres, MySQL, MariaDB and
 *     SQL Server through pure-JS optional drivers. Closed by `dbhub` below.
 *     ⭐ This is the third time a "cannot" in this file has expired; the standing
 *     instruction to RE-MEASURE before inheriting one keeps paying.
 *
 * ⚠️ AND THE THIRD CANDIDATE FAILED ON A BAR NOTHING HAD EVER BEEN JUDGED
 * AGAINST: its own startup time. `mongodb-mcp-server` is Apache-2.0, published
 * by MongoDB, and it works — and through the `npx --no` line a config actually
 * uses it connected **2 times out of 6**. See the rejection block.
 *
 * ── ⚠️ WHAT THIS PASS COULD NOT DO, STATED SO NOBODY THINKS IT WAS WEIGHED ───
 *
 * **No hosted entry could be added.** `test/mcp-catalogue-hosted.test.mjs` holds
 * `EXPECTED_HOST_SUFFIX`, a hardcoded name→vendor-domain map, and asserts that
 * EVERY hosted entry appears in it. Adding a hosted entry therefore requires an
 * edit to that test file, which this lane was not permitted to touch. Two
 * candidates were measured and are parked in the rejection block with their
 * numbers so the next pass — one that owns the test — can add them in a line.
 * ⭐ Worth noticing as a design smell rather than only as an obstacle: a guard
 * that lists allowed VALUES makes the test file part of the data, and the data
 * now cannot grow without it.
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
 * ── ⭐ WHAT AN UNCONFIGURED **HOSTED** ENTRY ACTUALLY COSTS ──────────────────
 *
 * Measured 2026-08-25 by connecting anonymously to seven vendor-hosted servers
 * that all require a token: 118ms, 134ms, 144ms, 332ms, 468ms, 605ms, 741ms.
 * Every one of them answered `HTTP 401` and released the connection. None of
 * them came anywhere near `HANDSHAKE_TIMEOUT_MS`.
 *
 * ⚠️ THIS IS NOT A DETAIL, IT IS THE REASON THE CATALOGUE COULD GROW. Rule 2
 * ("nothing that needs credentials is enabled by default") is an arithmetic
 * argument — no key, no handshake, 20 seconds gone — and the arithmetic is
 * simply false over HTTP. Telling a user that their unset `GITHUB_…_TOKEN`
 * costs them 20 seconds a session, when it costs 0.7, is the pessimistic kind
 * of stale claim this file has already been burned by once: nothing breaks, so
 * nobody re-checks, and the catalogue quietly stays smaller than it needs to be.
 *
 * ⭐ ROUNDED UP TO ONE SECOND, DELIBERATELY. The slowest measurement was 741ms
 * and a cold TLS handshake on a worse connection will beat that; a number the
 * user might experience as optimistic is worse than one they experience as
 * conservative. It is still 20× cheaper than the stdio figure, which is the
 * whole point being made.
 *
 * ⚠️ IT DOES NOT MAKE A CREDENTIALED HOSTED SERVER A DEFAULT. A server that
 * 401s is useless whatever it costs, and spawning useless servers is not
 * improved by them failing quickly. This changes what we TELL the user, not
 * what we turn on.
 */
export const HOSTED_DARK_COST_MS = 1_000;

/**
 * Is this entry reached over the network rather than spawned?
 *
 * ⚠️ THE TEST IS `url`, NOT `transport`, AND NOT "has no command". Every entry
 * carries a `command` string — the shape tests in `test/mcp-defaults.test.mjs`
 * require `typeof entry.command === 'string'` for all of them — so a hosted
 * entry has `command: ''`, and a truthiness check on `command` would be a
 * check on emptiness rather than on transport. `url` is the field that decides
 * which half of `connectServer` runs, so it is the field this asks about.
 */
export function isHosted(entry) {
  return typeof entry?.url === 'string' && entry.url.trim() !== '';
}

/** What an entry costs when it is dark: 20s if we spawn it, ~1s if we call it. */
export function darkCostMs(entry) {
  return isHosted(entry) ? HOSTED_DARK_COST_MS : DARK_ENTRY_COST_MS;
}

/**
 * ── THE CATALOGUE ───────────────────────────────────────────────────────────
 *
 * Fields, and why each one is here rather than being obvious from the command:
 *
 *   name          becomes `mcp__<name>__<tool>`, so it must satisfy the server
 *                 name rule in `readMcpConfig` or the whole config is rejected.
 *   purpose       one honest line. Not marketing — what you get.
 *   command/args  exactly what `mcp.mjs` will spawn. No shell, no expansion.
 *                 ⚠️ A HOSTED ENTRY STILL CARRIES BOTH, as `''` and `[]`. The
 *                 shape invariants in test/mcp-defaults.test.mjs assert
 *                 `typeof command === 'string'` on EVERY entry, and a catalogue
 *                 where the fields present depend on the entry is a catalogue
 *                 every consumer has to branch on twice.
 *   url/transport present ONLY on a hosted entry, and `url` is what `isHosted`
 *                 keys on. `transport` is 'http' or 'sse', the two `mcp.mjs`
 *                 speaks. A hosted entry spawns no process at all.
 *   headers       a hosted entry's credentials, as `${VAR}` references that
 *                 `resolveHeaders` expands at connect time. ⚠️ NEVER a literal
 *                 secret — `mcp.mjs` refuses to connect rather than send the
 *                 unexpanded text, which is the behaviour we want a config to
 *                 inherit from us.
 *   licence       from `npm view <pkg> license`, with the date it was checked,
 *                 or the honest "no code is installed" line for a hosted entry.
 *                 AGPL is never acceptable and neither is an absent field.
 *   needsDownload true when the package is not already on the machine. Under
 *                 this client that means it CANNOT self-install. Always false
 *                 for a hosted entry — there is nothing to download.
 *   install       the line to paste. Required whenever needsDownload is true.
 *   credentials   [{ env, required, why, absentDetail? }]. `required: false`
 *                 means the server starts without it.
 *                 ⚠️ `absentDetail` EXISTS BECAUSE THE DEFAULT SENTENCE WAS A
 *                 SMALL LIE FOR THE FIRST ENTRY THAT NEEDED IT. `assessEntry`
 *                 has always said "so it will offer fewer tools", which is true
 *                 of `acuvo` (its two tools are genuinely withheld) and FALSE of
 *                 `tavily`, which lists all five keyless and makes three of them
 *                 answer with a sign-up message. Optional and defaulted, so
 *                 every existing entry renders the identical string.
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
    // ⭐ OURS. It ships inside this package, under this package's licence —
    // there is no third party to check and nothing for a user to install.
    licence: 'ours — shipped inside acuvo-code, no separate package',
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
    // `npm view chrome-devtools-mcp version license` on 2026-08-25 → 1.8.0,
    // Apache-2.0, repo github.com/ChromeDevTools/chrome-devtools-mcp. Google's.
    licence: 'Apache-2.0 (npm, checked 2026-08-25, v1.8.0)',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT, end to end, through the real connectServer — and then CALLED IT, which no other entry here has earned. Connected in 1,935ms and listed 29 tools (click, fill, fill_form, type_text, navigate_page, take_snapshot, take_screenshot, evaluate_script, upload_file, list_network_requests, performance_start_trace, lighthouse_audit …); `navigate_page` to a data: URL answered ok in 789ms and `take_snapshot` in 13ms, returning the accessibility tree with the button named. 29 is under MAX_TOOLS_PER_SERVER (40), so nothing is truncated. ⚠️⚠️ FOR CI YOU WANT `--headless` AND `--isolated`, AND THIS NOTE USED TO SAY "add them to args" — WHICH DOES NOT WORK. `connectServer` runs `npx --no chrome-devtools-mcp …`, and npm 11 parses a `--flag` after the package name as its OWN config ("npm warn Unknown cli config") and never passes it on; measured 2026-08-26. Put a bare `--` first: `["-y","chrome-devtools-mcp","--","--headless","--isolated"]`. ⚠️ It drives the Chrome already installed on the machine and does NOT download one; with no Chrome present the connection still succeeds and the first tool call is what fails. Installed here from the npm cache — see the header on why nothing else could be.',
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
  /**
   * ── ⭐⭐⭐ 2026-08-26: THE DOWNLOAD WAS THE ONLY BLOCKER, AND CONTEXT7 SHIPS A
   * HOSTED ENDPOINT ───────────────────────────────────────────────────────────
   *
   * Everything above is unchanged and still true. What changed is the transport,
   * and it removes the single stated reason this entry could not be reached:
   * `needsDownload: true` meant that under this client's `npx --no` it could not
   * start at all on a machine without a global install, so `acuvo mcp add docs`
   * handed people a server that silently refused. `INTEGRATIONS.md` records the
   * consequence in its own words — *"`docs` cannot be defaulted and that is
   * correct … it needs `npm i -g @upstash/context7-mcp` first. The other six have
   * no such excuse."*
   *
   * ⭐ MEASURED 2026-08-26, through the real `connectRemoteServer` with an EMPTY
   * env — the same standard every other hosted entry in this block was held to:
   *
   *     connect            1,803ms   (the npx variant: 3,338–8,348ms)
   *     tools              2 — resolve-library-id, query-docs (identical)
   *     resolve-library-id 2,033ms   /vercel/next.js, 5551 snippets, version list
   *     query-docs         1,736ms   the real `export async function GET(request:
   *                                  Request) {}` with a GitHub source URL
   *
   * No key, no account, no install. So this is strictly better on every axis the
   * two differ on: same service, same two tools, same egress, faster, and it
   * works on a bare machine.
   *
   * ⚠️⚠️ THE ONE THING THAT GOT WORSE, SAID PLAINLY. With `npx` you pinned a
   * PACKAGE VERSION and ran it locally; hosted, Upstash can change the server
   * under you without a release. That is the standard hosted-service trade this
   * block already makes five times, and the `note` names the self-host command
   * for anyone who needs the version in their own hands. It is NOT in `install`,
   * because that field means "run this first" and a hosted entry has no first.
   *
   * ⚠️ IT IS STILL NOT A DEFAULT, AND THAT IS NOT AN OVERSIGHT. It now satisfies
   * the stated condition — verified && !needsDownload && no credentials — but
   * this file's own header says that condition is NECESSARY, NOT SUFFICIENT:
   * turning a server on for every session spends prefix bytes and a connect on
   * every run, and it sends the user's problem statement to a third party by
   * default. That is a product decision and it belongs to Roman. What this change
   * does is remove the technical reason it could not be made.
   */
  Object.freeze({
    name: 'docs',
    purpose: 'Look up current, version-specific documentation and code examples for a library, returned as source-cited snippets rather than as search results.',
    /**
     * ⚠️ EMPTY `command`/`args` ARE LOAD-BEARING, NOT FILLER — the shape
     * invariants require both on every entry, and `isHosted` keys on `url`.
     */
    command: '',
    args: Object.freeze([]),
    url: 'https://mcp.context7.com/mcp',
    transport: 'http',
    needsDownload: false,
    /**
     * ⚠️ NULL, AND THE FIRST DRAFT OF THIS CHANGE PUT THE SELF-HOST COMMAND HERE
     * — which `mcp-defaults.test.mjs` refused, correctly. `install` means "you
     * must run this before the entry can start", and every consumer prints it as
     * a prerequisite. A hosted entry has no prerequisite, so a command in this
     * field would tell every reader to install something they do not need. The
     * self-hosting escape hatch belongs in `note`, where it reads as an option.
     */
    install: null,
    licence: 'n/a for the hosted endpoint — no code is installed. The package behind it is MIT (npm, checked 2026-08-25, v4.0.3), which is what you get if you self-host via `install`.',
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
    note: 'HOSTED SINCE 2026-08-26. RAN IT AND CALLED IT through the real connectRemoteServer with an EMPTY env: connected in 1,803ms, listed the same 2 tools; `resolve-library-id` for "next.js" answered in 2,033ms with /vercel/next.js, 5551 snippets and a real version list; `query-docs` on /vercel/next.js answered in 1,736ms with the actual current `export async function GET(request: Request) {}` and a GitHub source URL per snippet. No download, no account, no key. ⚠️ Upstash can change the hosted server without a release — to pin the version yourself, `npm i -g @upstash/context7-mcp` and point a local entry at it instead. PREVIOUSLY, over npx: RAN IT, end to end, through the real connectServer — and CALLED IT TWICE, with no API key. Connected in 3,338–8,348ms across four runs and listed 2 tools (resolve-library-id, query-docs). `resolve-library-id` for "next.js" answered ok in 2,250ms with real registry data (/vercel/next.js, 6071 snippets, a version list); `query-docs` on /vercel/next.js for "how do I define a route handler" answered ok in 2,536ms with the actual current `export async function GET(request: Request) {}` signature and a GitHub source URL per snippet. ⚠️ Two tools is FAR under MAX_TOOLS_PER_SERVER (40), so it is a cheap entry in prefix bytes as well as in dollars. ⚠️ It is a network service: your query text leaves the machine to Upstash. ⚠️ Both `libraryName` and `query` are required by resolve-library-id even though each error message names only the other one.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'filesystem',
    purpose: 'Read and write files under directories you name — the reference MCP server, and the usual first one people add.',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-filesystem', '.']),
    needsDownload: true,
    install: 'npm i -g @modelcontextprotocol/server-filesystem',
    /**
     * ⚠️ npm's `license` field for this package is the unhelpful string
     * "SEE LICENSE IN LICENSE", which an automated check cannot grade. Resolved
     * by reading the actual file 2026-08-25:
     * raw.githubusercontent.com/modelcontextprotocol/servers/main/LICENSE says
     * the project is mid-transition — new contributions Apache-2.0, older
     * un-relicensed ones MIT. Both permissive, so this is fine; recorded in full
     * because "SEE LICENSE IN LICENSE" is exactly the value someone would later
     * mistake for a licence they had checked.
     */
    licence: 'MIT / Apache-2.0 (repo LICENSE read 2026-08-25; npm says only "SEE LICENSE IN LICENSE")',
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
    licence: 'MIT (npm, checked 2026-08-25, v3.24.0)',
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
    // ⭐ 2026-09-27: headless + in-memory profile + Playwright's own Chromium,
    // never the user's installed Chrome (the package default). See mcp-add.mjs.
    args: Object.freeze(['-y', '@playwright/mcp', '--', '--headless', '--isolated', '--browser', 'chromium']),
    needsDownload: true,
    // ⚠️ TWO commands, because the package alone is not always enough:
    // Playwright installs its browsers separately, and the second line is
    // ~150MB. It is `&&`-joined rather than split because the second half is
    // the one people skip, and skipping it fails at the first CALL rather than
    // at connect — see the note.
    // ⚠️ `npx playwright install chromium` was the line here and it installs the
    // browser for WHATEVER playwright npx resolves — on this machine chromium-1234,
    // while @playwright/mcp 0.0.79 wants chromium-1237 and failed with "Browser
    // chrome-for-testing is not installed". The server's own installer matches it.
    install: 'npm i -g @playwright/mcp && npx @playwright/mcp install-browser chrome-for-testing',
    licence: 'Apache-2.0 (npm, checked 2026-08-25, v0.0.79)',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT, end to end, through the real connectServer, and CALLED IT. Connected in 2,600–15,118ms and listed 24 tools (browser_click, browser_fill_form, browser_type, browser_navigate, browser_snapshot, browser_take_screenshot, browser_evaluate, browser_file_upload, browser_select_option, browser_tabs, browser_network_requests …); `browser_navigate` to a data: URL answered ok in 1,027ms and returned the Playwright code it ran. 24 is under MAX_TOOLS_PER_SERVER (40), so nothing is truncated. ⚠️ THE FIRST CONNECT TOOK 15,118ms — 75% of the 20s handshake budget — while a warm one took 2,600ms; a slower machine can therefore fail the handshake on first use and look permanently broken when it is merely cold. ⚠️ IT WRITES INTO YOUR WORKSPACE: the navigate call created `.playwright-mcp/page-<timestamp>.yml` in the current directory, unasked. Pass `--output-dir` to send that somewhere else, and expect to gitignore it otherwise — no other entry in this catalogue writes to the repo. ⚠️ It found a browser here without `npx playwright install chromium` having been run in this session, so that step is conditional on what the machine already has, not universal. Prefer the `browser` entry above unless you need Firefox or WebKit — it needs no browser download and does not litter the workspace.',
    enabledByDefault: false,
  }),

  /**
   * ── ⭐⭐⭐ 3D: BLENDER, THE FIRST PYTHON SERVER, AND A NAME THAT WAS A TRAP ──
   *
   * Owner, 2026-09-27: the CLI should build anything — apps, games, 3D, design.
   * Claude Code on this machine already drives Blender through `uvx blender-mcp`
   * (ahujasid/mcp-for-blender, MIT, ~29k stars). This client could not:
   *
   *   · `acuvo mcp add blender` fell through to the bare-npm branch and wrote
   *     `npx -y blender` — npm `blender` 0.0.8 is "SVG 2 PNG asset conversion",
   *     an unrelated stranger's package (checked 2026-09-27). The `browser`
   *     defect recorded in mcp-add.mjs, again.
   *   · The catalogue called itself npx-only. `connectServer` resolves any
   *     executable on PATH, so `uvx` always spawned; what was missing was the
   *     npx `--no` guarantee, which `uvxArgs` in mcp.mjs now gives uvx.
   *
   * ⚠️ `mcp-for-blender` IS THE PACKAGE, NOT `blender-mcp`. PyPI `blender-mcp`
   * 2.0.0 is now a shim whose only dependency is `mcp-for-blender>=2.0.0`, and
   * the server's own messages say `uvx mcp-for-blender install-addon`. And npm
   * `blender-mcp` is a DIFFERENT project (see PACKAGE_ADVISORIES).
   *
   * ⚠️ IT NEEDS BLENDER RUNNING. The server is a bridge to an add-on listening
   * on localhost:9876 (BLENDER_HOST / BLENDER_PORT). Without it the handshake
   * still succeeds and every tool answers, as ordinary text, "Could not connect
   * to Blender" — so `--doctor` probes that port (see `blenderAddonCheck`).
   *
   * ⚠️ PRIVACY: most tools ask the model for `user_prompt`, "the user's own words
   * … quoted verbatim", which feeds the server's telemetry. Telemetry is gated
   * on consent given inside the Blender add-on and is off with
   * BLENDER_MCP_DISABLE_TELEMETRY=true. Stated, not hidden.
   */
  Object.freeze({
    name: 'blender',
    purpose: 'Drive a running Blender: build and edit 3D scenes with Python (bpy), pull free assets from Poly Haven / Poly Pizza, screenshot the viewport, and export GLB/FBX for a game or a web page.',
    command: 'uvx',
    args: Object.freeze(['mcp-for-blender']),
    needsDownload: true,
    install: 'uv tool install mcp-for-blender',
    /**
     * `runner: 'uv'` — the package is a PyPI tool, so "is it installed" is a
     * question for uv's tool directory, not node_modules (doctor's
     * `installedUvTools`). Absent on every npm entry.
     */
    runner: 'uv',
    /** Upstream telemetry is consent-gated in the add-on; we also switch it off in the config we write. */
    env: Object.freeze({ BLENDER_MCP_DISABLE_TELEMETRY: 'true' }),
    licence: 'MIT (PyPI mcp-for-blender 2.1.1 license_expression, and github.com/ahujasid/mcp-for-blender, checked 2026-09-27)',
    credentials: Object.freeze([]),
    /**
     * Brief words that mean "this is a 3D job" — used by the MCP shortlist so a
     * 3D brief is offered Blender's schemas on round 0 while an ordinary coding
     * brief is not charged its 36KB of schemas.
     */
    signals: Object.freeze(['blender', '3d', 'mesh', 'meshes', 'glb', 'gltf', 'fbx', 'low-poly', 'low poly', 'lowpoly', 'sculpt', 'polyhaven', 'sketchfab', 'hdri', 'bpy']),
    verified: true,
    note: 'RAN IT, 2026-09-27, through the real connectServer on Windows ARM64: `uv tool install mcp-for-blender` (2.1.1), then `uvx --offline mcp-for-blender` connected in 6,512–8,188ms and listed 36 tools (32 on the cached 2.0.4) — execute_blender_code, get_scene_info, export_scene, the Poly Haven / Sketchfab / Poly Pizza / Hyper3D / Hunyuan3D asset tools. With no Blender running, `get_scene_info` answered ok with the text "Could not connect to Blender. Make sure the Blender addon is running." — the failure arrives at CALL time, as text. Schemas total ~36.6KB, which is why this is never a default and why the shortlist withholds it from non-3D briefs. Blender itself was NOT installed on the machine that measured this; the end-to-end build ran against a stub serving the identical tool surface (test/fixtures/blender-mcp-stub.mjs).',
    enabledByDefault: false,
  }),

  /**
   * ── ⭐⭐⭐ WEB SEARCH, AND IT NEEDS NO ACCOUNT — WHICH WAS NOT THE PLAN ─────
   *
   * Web search has been an open gap in this catalogue since 2026-08-25, when
   * `exa-mcp-server` was rejected for publishing NO LICENCE FIELD AT ALL. The
   * native `web_search` tool returns result pages; nothing here searched the web
   * and handed back the content.
   *
   * ⭐⭐ THE MEASUREMENT THAT DECIDED IT: `tavily_search` ANSWERED WITH NO KEY.
   * Connected through the real `connectServer` with `TAVILY_API_KEY` absent from
   * the environment entirely, and the server said so itself on stderr:
   *   "[tavily-mcp] no TAVILY_API_KEY set; running in keyless mode. Search and
   *    extract are available; other tools will return a message explaining that
   *    an API key is required."
   * A `tavily_search` for "model context protocol" then came back in 2,219ms
   * with the real specification page (modelcontextprotocol.io/specification/
   * 2025-06-18) and its content. That is web search, for every user, with no
   * signup — the same bar `docs` cleared, and the reason this entry exists at
   * all rather than being deferred behind a key like Firecrawl.
   *
   * ⚠️ THE KEY IS THEREFORE `required: false`, AND THAT IS A MEASUREMENT, NOT A
   * KINDNESS. Rule 2's arithmetic is "no key, no handshake, 20 seconds gone" —
   * and it is simply false here: keyless, the server connected in 1,467–3,676ms
   * across four runs and offered all five tools. Marking the key required would
   * darken an entry that provably works, which is the pessimistic stale claim
   * this file has already paid for twice.
   *
   * ⚠️ AND "fewer tools" WOULD HAVE BEEN THE WRONG WORDS, which is why the
   * credential carries an `absentDetail`. Keyless it still LISTS all five;
   * `tavily_crawl` answers "This Tavily endpoint requires an API key. Keyless
   * Tavily currently supports Search and Extract only." — measured. Saying the
   * surface shrinks when what actually happens is that three tools reply with a
   * sentence is a small lie, and a small lie in a status line is the shape of
   * every defect this module records.
   *
   * ⚠️ IT IS STILL NOT A DEFAULT. It needs a download (rule 1), and it is a
   * third-party network service: the query text — usually the user's actual
   * problem statement — leaves the machine to Tavily. Same egress argument
   * `docs` made, same answer.
   */
  Object.freeze({
    name: 'tavily',
    purpose: 'Search the live web and get the page content back rather than a list of links, extract a named URL as clean text, and crawl or map a site.',
    command: 'npx',
    args: Object.freeze(['-y', 'tavily-mcp']),
    needsDownload: true,
    install: 'npm i -g tavily-mcp',
    /**
     * Registry facts, checked 2026-08-26 against registry.npmjs.org: version
     * 0.2.22, licence MIT, no `deprecated` field, repository
     * github.com/tavily-ai/tavily-mcp, four runtime dependencies (axios, yargs,
     * dotenv, @modelcontextprotocol/sdk) and no native module. Maintainers are
     * Tavily's own npm accounts, which is the provenance signal that separates
     * this from the third-party wrappers rejected below.
     */
    licence: 'MIT (npm, checked 2026-08-26, v0.2.22)',
    credentials: Object.freeze([
      Object.freeze({
        env: 'TAVILY_API_KEY',
        required: false,
        why: 'without it search and extract still work; crawl, map and research answer with a sign-up message instead of a result',
        absentDetail: 'it runs keyless — search and extract answer normally, and crawl, map and research return a sign-up message instead of a result',
      }),
    ]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-26, through the real connectServer with the package installed locally and NO API KEY IN THE ENVIRONMENT. Connected in 1,467ms, 2,212ms, 2,669ms, 2,713ms and 3,676ms across five ad-hoc runs, and then 3 CONSECUTIVE times through the guard in test/mcp-catalogue-stdio-flags.test.mjs at 1,202ms, 1,186ms and 1,185ms — that 3-in-a-row bar is the one test/mcp-hosted-reconnect-stability.test.mjs argues for after Chakra passed a single probe and then failed four in five. It listed 5 tools every time (tavily_search, tavily_extract, tavily_crawl, tavily_map, tavily_research). `tavily_search` for "model context protocol" answered ok in 2,219ms with the real specification page and its text; `tavily_crawl` answered ok in 899ms with "This Tavily endpoint requires an API key. Keyless Tavily currently supports Search and Extract only." — so the key-gated half fails politely at CALL time rather than at connect. 5 tools is far under MAX_TOOLS_PER_SERVER (40). ⚠️ THE TOOL NAMES USE UNDERSCORES: `tavily_search`, not `tavily-search`; the hyphenated form returns "Unknown tool", measured. ⚠️ Your query text leaves the machine to Tavily. ⚠️ npm and the vendor README both write `tavily-mcp@latest`; the tag is deliberately dropped here — see packageOf.',
    enabledByDefault: false,
  }),

  /**
   * ── ⭐⭐⭐ A DATABASE THAT IS NOT POSTGRES, AND A DEAD "CANNOT" ─────────────
   *
   * Until today the only database in this catalogue was `postgres`, pointing at
   * an npm-DEPRECATED reference server that nobody here has run. SQLite — the
   * database this audience actually has on disk — was REJECTED on 2026-08-14,
   * and the recorded reason was specific and correct at the time: every SQLite
   * MCP server pulled `sqlite3`, a NATIVE module, so recommending one meant
   * recommending a node-gyp compile to a stranger.
   *
   * ⭐⭐ THAT REASON HAS EXPIRED, AND NOT BECAUSE ANY SERVER CHANGED. Node ships
   * `node:sqlite` as a built-in from **22.5.0**. `@bytebase/dbhub` requires
   * `node >= 22.5.0` for exactly that reason and says so in its own README
   * ("DBHub uses the built-in `node:sqlite` module"), so SQLite now costs zero
   * native code. Its other drivers — `pg`, `mysql2`, `mariadb`, `mssql` — are
   * pure-JS and, decisively, are **optionalDependencies**: a user who only wants
   * SQLite does not compile or download anybody's database client.
   *
   * ⭐ ONE ENTRY, FIVE ENGINES: PostgreSQL, MySQL, MariaDB, SQL Server and
   * SQLite behind one `DSN`. In a catalogue capped at MAX_SERVERS (8) that
   * matters more than it would elsewhere — a slot is a scarce thing, and this is
   * the only candidate found that spends one slot on five databases.
   *
   * ⚠️ THE DSN IS `required: true` AND THAT IS MEASURED, NOT ASSUMED. With no
   * DSN the server prints its usage text and DIES, and `connectServer` reported
   * it at **20,011ms** — the full handshake timeout. This is the cleanest
   * confirmation of rule 2 since `firecrawl`, on a package nobody had run.
   *
   * ⚠️⚠️ IT WRITES BY DEFAULT, AND THAT IS MEASURED, NOT INFERRED. `execute_sql`
   * with `insert into jobs (name) values ('written-by-the-model')` answered
   * `success: true, count: 1` and the row was there. A DSN pointing at
   * production is a model with a write connection to production.
   *
   * ⚠️ AND THE OBVIOUS REMEDY DOES NOT EXIST ANY MORE — checked, because a
   * warning whose fix is wrong is worse than no warning. `--readonly` was
   * REMOVED in 1.2.1: passing it kills the server with *"ERROR: --readonly flag
   * is no longer supported. Use dbhub.toml with [[tools]] configuration
   * instead"*, which `connectServer` reports as a 20,035ms timeout. The real
   * remedy is a `dbhub.toml` beside the workspace:
   *     [[sources]]
   *     id = "default"
   *     dsn = "…"
   *     [[tools]]
   *     name = "execute_sql"
   *     source = "default"
   *     readonly = true
   * (the server's own message, quoted; it cites dbhub.ai/tools/execute-sql).
   * ⭐ Note what this near-miss cost: the safe flag, passed the way every README
   * writes flags, would have produced a dead server and a 20-second stall — the
   * npm-swallowing defect and a removed flag failing in exactly the same silent
   * way.
   */
  Object.freeze({
    name: 'dbhub',
    purpose: 'Run SQL against PostgreSQL, MySQL, MariaDB, SQL Server or SQLite through one connection string, and search the schema for tables, columns and indexes.',
    command: 'npx',
    /**
     * ⚠️ NO FLAGS, ON PURPOSE, AND IT IS THE FLAG DEFECT THAT DECIDED IT. dbhub
     * defaults to the stdio transport, so `--transport stdio` is unnecessary —
     * and every `--flag` after a package name is eaten by npm unless a bare `--`
     * precedes it (see the header). The vendor's documented env-var route (`DSN`)
     * needs no argument at all, so the entry takes the path with nothing to get
     * swallowed. Proven: connected with only `DSN` set, no args.
     */
    args: Object.freeze(['-y', '@bytebase/dbhub']),
    needsDownload: true,
    install: 'npm i -g @bytebase/dbhub',
    /**
     * Registry facts, checked 2026-08-26 against registry.npmjs.org: version
     * 1.2.1, licence MIT, no `deprecated` field, repository
     * github.com/bytebase/dbhub, `engines.node >= 22.5.0`, 1.9MB unpacked over
     * 34 files. Runtime dependencies are pure JS (zod, ssh2, dotenv, express,
     * ssh-config, @iarna/toml, @modelcontextprotocol/{node,server}); the
     * database drivers are optionalDependencies. Maintainers are Bytebase's own
     * npm accounts.
     */
    licence: 'MIT (npm, checked 2026-08-26, v1.2.1)',
    credentials: Object.freeze([
      Object.freeze({ env: 'DSN', required: true, why: 'with no connection string the server prints its usage text and exits, costing the full handshake' }),
    ]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-26, through the real connectServer against a REAL DATABASE. With DSN=sqlite:///…/probe.db (a two-row table created for the run) it connected in 2,913ms, 4,113ms and 4,208ms on three consecutive attempts, listed 2 tools (execute_sql, search_objects), and `execute_sql` on "select name from jobs" answered ok in 19ms with the actual rows [{"name":"render"},{"name":"clone"}]. Re-run through the guard in test/mcp-catalogue-stdio-flags.test.mjs against DSN=sqlite:///:memory:, it connected 3 consecutive times at 1,985ms, 2,056ms and 2,013ms — the same 3-in-a-row bar Chakra taught us to demand. Also run in the vendor\'s `--demo` mode (in-memory SQLite, sample employee database): connected in 2,577ms and "select count(*) as n from employee" returned 1000 in 6ms — that is the zero-setup way to try it, and the invocation is `["-y","@bytebase/dbhub","--","--transport","stdio","--demo"]`, where the bare `--` is mandatory. ⚠️ WITH NO DSN IT DIES: connectServer reported 20,011ms, the full timeout, with the usage text on stderr. ⚠️ NEEDS NODE >= 22.5.0 — it uses the built-in `node:sqlite`, and that requirement is also what makes SQLite free of any native compile. ⚠️ `execute_sql` WRITES — proven: an INSERT answered success and the row was there. Point DSN at a scratch database, not at production. ⚠️ `--readonly` NO LONGER EXISTS in 1.2.1 and passing it kills the server ("ERROR: --readonly flag is no longer supported"), which arrives as a 20,035ms timeout; read-only is now a `[[tools]] readonly = true` block in a dbhub.toml. ⚠️ Only 2 tools are offered, so this is a very cheap entry in prefix bytes for five database engines.',
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
    licence: 'MIT (npm, checked 2026-08-25, v2025.4.8 — deprecated, see note)',
    credentials: Object.freeze([
      Object.freeze({ env: 'GITHUB_PERSONAL_ACCESS_TOKEN', required: true, why: 'every call is authenticated; the server will not start without it' }),
    ]),
    verified: false,
    /**
     * ── ⚠️⚠️ THIS NOTE'S LAST SENTENCE WENT STALE AND WAS COSTING US THE ENTRY ─
     *
     * It read: *"GitHub's current server is a Go binary / hosted HTTP service
     * that this stdio-only, npx-only client cannot start."* That was true when
     * it was written on 2026-08-14. `mcp.mjs` learned Streamable HTTP on
     * 2026-08-15 — the day after — and nobody came back to this line. So for
     * ten days the catalogue's own reasoning said the maintained GitHub server
     * was out of reach, while the client could have called it.
     *
     * ⭐ MEASURED 2026-08-25 through the real `connectRemoteServer`, anonymously:
     * `https://api.githubcopilot.com/mcp/` answered **HTTP 401 in 741ms**, with
     * the message "bad request: missing required Authorization header". A 401 is
     * a REACHABILITY PROOF — something is listening, speaking our transport, and
     * refusing us for the one reason we expected. See the `github_remote` entry.
     */
    note: 'NOT RUN by me. Listed for the install command only. Needs both a download and a token, so it is dark twice over. ⚠️ AND IT IS DEPRECATED: `npm view` on 2026-08-14 (re-checked 2026-08-25, unchanged) reports version 2025.4.8 carrying `deprecated: "Package no longer supported."` It still resolves and still installs, but it is not maintained. ⭐ PREFER THE `github_remote` ENTRY: GitHub\'s own maintained server is hosted at https://api.githubcopilot.com/mcp/, needs no install at all, and this client has spoken HTTP since 2026-08-15.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'postgres',
    purpose: 'Run read-only queries against a Postgres database and inspect its schema.',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-postgres']),
    needsDownload: true,
    install: 'npm i -g @modelcontextprotocol/server-postgres',
    licence: 'MIT (npm, checked 2026-08-25, v0.6.2 — deprecated, see note)',
    credentials: Object.freeze([
      Object.freeze({ env: 'POSTGRES_CONNECTION_STRING', required: true, why: 'there is nothing to connect to without it' }),
    ]),
    verified: false,
    note: 'NOT RUN by me. Listed for the install command only. Needs both a download and a connection string. ⚠️ AND IT IS DEPRECATED: `npm view` on 2026-08-14 reports version 0.6.2 carrying `deprecated: "Package no longer supported."` It is the last published build of the reference server and still installs; treat it as frozen, not as maintained.',
    enabledByDefault: false,
  }),

  /**
   * ── ⭐⭐⭐ BELOW HERE: HOSTED. NO DOWNLOAD, NO KEY, AND ACTUALLY LIVE ────────
   *
   * Everything above spawns a process, and that is what made the catalogue
   * mostly dark: rule 1 turns every npm entry off, so `--doctor` reported ONE
   * usable server on a plain machine. These seven need nothing installed and
   * nothing signed up for. Each one below was **connected AND called** through
   * the real `connectRemoteServer` with `{ env: {} }` on 2026-08-25 — the same
   * bar `browser`, `docs` and `playwright` had to clear, held to deliberately
   * because "the vendor's README says it works" is what this file exists to
   * refuse.
   *
   * ⚠️ NONE OF THEM IS A DEFAULT, and that is not an oversight. `docs` made the
   * argument first and it holds: a hosted server sees the query text, which is
   * usually the user's actual problem statement. Being cheap to turn on is not
   * consent to turn it on for them.
   *
   * ⚠️ AND THEY ARE NOT VETTED CODE — they are somebody else's SERVICE. We can
   * check who answers on the hostname (the vendor, in every case here) and we
   * can check what the tools returned when we called them. We cannot audit what
   * happens after the request leaves. The `_readme` in the rendered config says
   * so, and so does every `purpose` line: these read and search, none of them
   * writes anything anywhere.
   */

  Object.freeze({
    name: 'deepwiki',
    purpose: 'Ask questions about any public GitHub repository and get answers from an indexed wiki of its code — architecture, entry points, how a subsystem actually works.',
    /**
     * ⚠️ EMPTY `command`/`args` ARE LOAD-BEARING, NOT FILLER. See the field
     * documentation above `CATALOGUE`: the shape invariants require both on
     * every entry, and `isHosted` keys on `url` precisely so nobody has to
     * guess which of the two shapes an entry is in.
     */
    command: '',
    args: Object.freeze([]),
    url: 'https://mcp.deepwiki.com/mcp',
    transport: 'http',
    needsDownload: false,
    install: null,
    /**
     * ⭐ THE CAPABILITY GAP IT CLOSES, which is why it leads this block. The
     * `docs` entry answers "what is this library's current API"; nothing we had
     * answered "how does THIS repository work" — the question every agent asks
     * on contact with an unfamiliar codebase, and the one it otherwise answers
     * by reading forty files at full token price.
     */
    licence: 'n/a — hosted service, no code is installed. Cognition\'s (DeepWiki); what matters here is the egress, not a licence.',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-25, through the real connectRemoteServer with an empty env. Connected in 1,754ms, listed 3 tools (ask_question, read_wiki_contents, read_wiki_structure); `read_wiki_structure` for "modelcontextprotocol/servers" answered ok in 265ms with the real page list ("Introduction to Model Context Protocol Servers", "MCP Protocol and Architecture", "Repository Structure and Package …"). No download, no account, no key. ⚠️ Public repositories only — it indexes what is already public, so a private repo is not reachable and asking about one leaks the NAME of what you asked.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'grep',
    purpose: 'Search the source of a million public GitHub repositories by string or regex, filtered by language and path — find how an API is really used, not how the docs say it is.',
    command: '',
    args: Object.freeze([]),
    url: 'https://mcp.grep.app',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. grep.app (Vercel).',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-25, empty env. Connected in 1,002ms and listed 1 tool (searchGitHub); a search for "performHandshake" restricted to TypeScript answered ok in 448ms with a real hit in microsoft/vscode (src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts) including the file URL. ⭐ ONE TOOL — the cheapest entry in this catalogue in prefix bytes, and it does something the native `web_search` cannot: it searches CODE, not pages about code. ⚠️ Public repos only, and the query string leaves the machine.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'mslearn',
    purpose: 'Search Microsoft\'s official documentation and code samples — Azure, .NET, TypeScript, VS Code, Windows — and fetch a page as markdown.',
    command: '',
    args: Object.freeze([]),
    url: 'https://learn.microsoft.com/api/mcp',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. Microsoft\'s own (learn.microsoft.com).',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-25, empty env. Connected in 783ms and listed 3 tools (microsoft_docs_search, microsoft_code_sample_search, microsoft_docs_fetch); `microsoft_docs_search` for "azure functions typescript http trigger" answered ok in 779ms with the real "Azure Functions HTTP trigger (programming-language-typescript)" article. ⭐ It is served from learn.microsoft.com itself, so this is first-party documentation rather than a third party\'s copy of it.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'awsdocs',
    purpose: 'Search and read AWS\'s official documentation, and check which AWS services and features are actually available in a given region.',
    command: '',
    args: Object.freeze([]),
    url: 'https://knowledge-mcp.global.api.aws',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. AWS\'s own (api.aws).',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-25, empty env. Connected in 1,030ms and listed 5 tools (aws___read_documentation, aws___search_documentation, aws___list_regions, aws___get_regional_availability, aws___retrieve_skill); `aws___search_documentation` for "lambda nodejs handler" answered ok in 1,776ms with `isError:false` and the real "Define Lambda function handler in Node.js" page. ⚠️ NO AWS ACCOUNT AND NO CREDENTIALS — it reads public documentation and cannot see, let alone touch, anybody\'s infrastructure. That is the only reason it is in a catalogue that otherwise refuses credentialed entries by default.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'cloudflare',
    purpose: 'Search Cloudflare\'s developer documentation — Workers, KV, D1, R2, Durable Objects — and get the migration guide from Pages to Workers.',
    command: '',
    args: Object.freeze([]),
    url: 'https://docs.mcp.cloudflare.com/mcp',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. Cloudflare\'s own (cloudflare.com).',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-25, empty env. Connected in 416ms — the fastest handshake of anything in this catalogue, hosted or spawned — and listed 2 tools (search_cloudflare_documentation, migrate_pages_to_workers_guide); the search for "workers kv put" answered ok with the real KV documentation page. ⚠️ THE CALL TOOK 9,336ms while the connect took 416ms. Nothing is wrong: a documentation search is a retrieval, and the handshake time a doctor measures says nothing about what a tool call will cost. Worth stating because this catalogue quotes connect times everywhere and they are not a latency promise. ⚠️ This is Cloudflare\'s DOCS server, deliberately — their account server at the same brand needs OAuth and can change your infrastructure.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'huggingface',
    purpose: 'Search Hugging Face for models, datasets and Spaces, read a repo\'s card and metadata, and browse its files — the registry Studio picks engines out of.',
    command: '',
    args: Object.freeze([]),
    url: 'https://huggingface.co/mcp',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. Hugging Face\'s own (huggingface.co).',
    /**
     * ⚠️ OPTIONAL, AND THE `required:false` IS THE WHOLE REASON IT IS LISTED.
     * The anonymous surface is real and was measured; a token widens it (private
     * repos, higher limits, the whoami identity). Marking it required would
     * darken an entry that provably works without it — the pessimistic stale
     * claim this file has already paid for once.
     */
    credentials: Object.freeze([
      Object.freeze({ env: 'HF_TOKEN', required: false, why: 'without it you get the public catalogue only, and hf_whoami has no identity to report' }),
    ]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-25, WITH AN EMPTY ENV — no HF_TOKEN of any kind. Connected in 719ms and listed 4 tools (hf_whoami, hub_repo_search, hub_repo_details, hf_fs); `hub_repo_search` for "whisper" answered ok in 270ms with 6 real repositories including ggerganov/whisper.cpp and its task/download metadata. ⭐ RELEVANT TO US SPECIFICALLY: the licence trap recorded in CLAUDE.md — InsightFace and friends being non-commercial — is a question about a model card, and this reads model cards. Checking a weight\'s licence before adopting it stops being a browser tab.',
    enabledByDefault: false,
  }),

  /**
   * ── ⭐⭐⭐ 2026-08-26: THE FRAMEWORK PASS, AND ONE OF THESE IS NOT A DOCS
   *          SERVER AT ALL ───────────────────────────────────────────────────
   *
   * The 2026-08-25 pass added seven hosted servers and every one of them
   * ANSWERS QUESTIONS: search these docs, read that wiki, grep this code. That
   * is a real capability and it has a real ceiling — a documentation server can
   * only ever improve the model's PRIORS. It cannot tell you whether the code
   * you just wrote is correct.
   *
   * ⭐⭐ `svelte` BREAKS THAT CEILING, WHICH IS WHY IT LEADS THIS BLOCK.
   * `svelte-autofixer` COMPILES the code you hand it and returns the compiler's
   * own diagnostics with the canonical error URL for each. Measured below on
   * eight lines of the most ordinary Svelte a model could write: it caught BOTH
   * defects, and both are the Svelte 4 → 5 migration errors a model trained on
   * pre-2024 examples produces by default. That is a VERIFIER on the far side of
   * a network call, for free, with no key — the same class of thing as
   * `see_page`, and the class this catalogue had none of.
   *
   * ⚠️ THE HONEST LIMIT OF ALL THREE: they are FRAMEWORK-SPECIFIC. A user who
   * never touches Svelte gets nothing from the Svelte server, and this file does
   * not pretend a narrow tool is a broad one. What makes them worth curating is
   * that `MAX_SERVERS` is 8 and the choice is per-workspace: a SvelteKit repo
   * should be running the Svelte server, and until now nothing told anybody it
   * existed.
   */

  Object.freeze({
    name: 'svelte',
    purpose: 'Compile a snippet of Svelte and get the compiler\'s own errors back, generate a playground link, and read the official Svelte and SvelteKit documentation section by section.',
    command: '',
    args: Object.freeze([]),
    url: 'https://mcp.svelte.dev/mcp',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. Svelte\'s own (svelte.dev, the framework\'s apex domain).',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT TWICE, 2026-08-26, through the real connectRemoteServer with an empty env. Connected in 866ms and listed 4 tools (get-documentation, list-sections, playground-link, svelte-autofixer). `list-sections` answered ok in 524ms with the real section index. ⭐⭐ THE ONE THAT MATTERS: `svelte-autofixer` on `<script>let count = 0;</script><button on:click={() => count++}>` answered ok in 279ms and returned BOTH real defects — "Using `on:click` … is deprecated. Use the event attribute `onclick` instead" (svelte.dev/e/event_directive_deprecated) and "`count` is updated, but is not declared with `$state(...)`. Changing its value will not correctly trigger updates" (svelte.dev/e/non_reactive_update). It VERIFIES rather than describes, which nothing else in this catalogue does. ⚠️ TWO REQUIRED ARGUMENTS, and the second is not guessable: `code` AND `desired_svelte_version` (an integer — 5). Calling it with `code` alone fails with a schema error, so the first call a model makes will be the wrong one unless it is told; that is why it is written down here. ⚠️ It also returns `require_another_tool_call_after_fixing: true` — it expects to be called AGAIN on the fixed code, so a single round is not a clean bill of health. ⚠️ `playground-link` requires `name`, `tailwind` and `files`.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'astro',
    purpose: 'Search Astro\'s official documentation — content collections, islands, adapters, the config file — and get the passage back rather than a link to it.',
    command: '',
    args: Object.freeze([]),
    url: 'https://mcp.docs.astro.build/mcp',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. Astro\'s own (astro.build).',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-26, empty env. Connected in 516ms and listed 1 tool (search_astro_docs); a search for "content collections schema" answered ok in 502ms with the real "Guides > Content collections > Defining the collection schema" passage, including the Zod-validation paragraph. ⭐ ONE TOOL, which ties `grep` for the cheapest entry in this catalogue in prefix bytes — a single schema, and it either helps or costs almost nothing.',
    enabledByDefault: false,
  }),

  /**
   * ── ⭐⭐ THE 2026-08-29 SWEEP — 49 CANDIDATE URLS, THREE SURVIVED ──────────
   *
   * Every candidate below was probed through the REAL `connectRemoteServer`
   * with an empty env, and every survivor then had one of its own tools CALLED.
   * The three that follow are the ones that connected keyless AND returned real
   * content. ⚠️ Recording the ones that did NOT is the more useful half — a
   * previous session recommended three repositories and two did not exist, and
   * an unrecorded negative is a path the next person walks again.
   *
   * ⚠️ **CONNECTS ≠ WORKS. TWO OBVIOUS WINS DIED ON THE SECOND TEST, NOT THE
   * FIRST**, which is exactly why the bar here is a real tool call:
   *
   *   · `gitmcp` — https://gitmcp.io (idosal/git-mcp, Apache-2.0, 8,358 stars,
   *     pushed 2026-05-08: the repo and the service are both REAL, and the
   *     handshake succeeds keyless in ~1.1s listing 4–5 tools). It looked like
   *     the best find of the sweep — documentation and code search for ANY
   *     GitHub repo, filling the exact gap `deepwiki` leaves when a repo has
   *     never been indexed. Then **6 of 6 real calls came back empty**, across
   *     both the generic `/docs` endpoint and the per-repo one: "No code matches
   *     found in facebook/react", "No documentation found." And
   *     `fetch_*_documentation` took **36–38 SECONDS** to return those 23
   *     characters. NOT ADDED. Re-probe before believing this paragraph — the
   *     service may simply have been degraded — but do not ship it on the
   *     handshake alone, which is what nearly happened here.
   *   · `exa` — https://mcp.exa.ai/mcp, keyless, 2 tools (web_search_exa,
   *     web_fetch_exa). The FIRST search answered in 1,097ms with genuinely good
   *     content (the real MCP streamable-HTTP spec page, with highlights) — a
   *     clear upgrade on our native `web_search`, which scrapes DuckDuckGo HTML.
   *     The very next session every call returned *"You've hit Exa's free MCP
   *     rate limit"*. The keyless allowance is roughly ONE useful call, and the
   *     documented fix is an API key. NOT ADDED: "works with no account" is the
   *     bar, and a bar cleared once then closed is worse than an absent entry.
   *
   * ⚠️ **AUTH-WALLED, SO A KEYLESS ENTRY IS IMPOSSIBLE, NOT MERELY UNDONE.**
   * HTTP 401 to an empty env: sentry · linear · notion · vercel · supabase ·
   * neon · netlify · stripe · prisma · semgrep · terraform · apify · sanity ·
   * expo · railway · fal · shadcn · cloudflare's radar and browser servers
   * (their DOCS server is keyless and already in this catalogue). Every one is a
   * server we could support tomorrow if the user brings their own token — and
   * none of them can ever be a keyless default. Do not re-probe these hoping.
   *
   * ⚠️ **NO SERVER AT THAT ADDRESS AT ALL** (DNS or 404/405, 2026-08-29):
   * mcp.nuxt.com · mcp.tiptap.dev · mcp.angular.dev · mcp.bun.sh · bun.com/mcp ·
   * mcp.pulumi.com · remote.mcpservers.org · mcp.wikimedia.org ·
   * mcp.tailwindcss.com · nextjs.org/mcp · mcp.modal.com · mcp.elevenlabs.io ·
   * mcp.nx.dev · knowledge.mongodb.com · developer.mozilla.org/mcp ·
   * orm.drizzle.team/mcp · hono.dev/mcp · remotion.dev/mcp · mcp.shopify.com.
   * Several of these are named as working servers in blog posts. They are not.
   *
   * ⚠️⚠️ **AND THE SWEEP TRIED TO ADD `chakra`, WHICH IS ALREADY A NAMED
   * REJECTION HERE.** It connected in 869ms, listed 6 tools and answered a real
   * `list_components` call with 1,951 characters — one connect, exactly the bar
   * that `test/mcp-hosted-reconnect-stability.test.mjs` exists because it is not
   * enough. That guard went red on the added entry and was RIGHT. Re-measured
   * 2026-08-29 at five consecutive connects: **ok · ok · ok · FAIL · FAIL**,
   * HTTP 400, three days after the original ok·FAIL·FAIL·FAIL·FAIL. The finding
   * reproduces and the entry stays out. ⭐ THE GUARD DID ITS WHOLE JOB — the
   * lesson is that a keyless server answering a real call is still not evidence
   * until it has answered several in a row.
   *
   * ⭐ THE TWO BELOW ARE NARROW BY DESIGN AND THAT IS THE POINT. Each answers
   * one stack precisely, each is FIRST-PARTY (the vendor answers on its own
   * hostname), each needs no account, and `mcp-detect.mjs` gained a signal for
   * each in the same change — so they are suggested to the projects that have
   * evidence for them and are invisible to everyone else. Both cleared the
   * repeated bar, 2026-08-29: `convex` 5/5 (574–1,020ms), `clerk` 5/5
   * (64–190ms). ⚠️ A catalogue entry costs ZERO bytes per round: nothing is
   * offered to a model until a human runs `acuvo mcp add`, so breadth here is
   * not a tax on the byte ceiling.
   */

  Object.freeze({
    name: 'convex',
    purpose: 'Set up Convex in a project and get Convex\'s own guidance on schema, indexes and scaling — the answers its team wrote, not a recollection of its docs.',
    command: '',
    args: Object.freeze([]),
    url: 'https://mcp.convex.dev/mcp',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. Convex\'s own (convex.dev).',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-29, empty env. Connected in 926ms and listed 4 tools (start_convex_app, add_convex_to_existing_project, get_convex_scaling_guidance, get_runbook); `get_convex_scaling_guidance` answered ok in 339ms with 1,641 characters of real guidance ("Model reads first: identify the screens and queries that must stay fast, then add indexes that…"). No download, no account, no key. ⚠️ It advises and explains; it does not touch your Convex deployment, and it never sees your data — only the text of what you ask.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'clerk',
    purpose: 'Fetch Clerk\'s own current auth snippets — B2B organisations, waitlists, role-based access — instead of writing an auth integration from memory of an older SDK.',
    command: '',
    args: Object.freeze([]),
    url: 'https://mcp.clerk.com/mcp',
    transport: 'http',
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. Clerk\'s own (clerk.com).',
    credentials: Object.freeze([]),
    verified: true,
    note: 'RAN IT AND CALLED IT, 2026-08-29, empty env. Connected in 348ms and listed 2 tools (clerk_sdk_snippet, list_clerk_sdk_snippets); `list_clerk_sdk_snippets` answered ok in 44ms with 3,147 characters naming the real bundles ("b2b-saas: Complete B2B SaaS setup with organizations, billing, and role-based access", "waitlist"). ⭐ THE FASTEST CALL IN THE WHOLE CATALOGUE at 44ms, and only two schemas. ⚠️ It reads Clerk\'s published snippets; it has no access to your Clerk instance and needs no key to prove it.',
    enabledByDefault: false,
  }),

  /**
   * ── ⚠️ THE ONE HOSTED ENTRY THAT NEEDS A TOKEN, AND WHY IT IS STILL HERE ───
   *
   * Rule 2 says nothing credentialed is a DEFAULT, and it is not one. But the
   * reason rule 2 was written — 20 seconds of stall per unconfigured server —
   * is measured at **741ms** for this URL (see `HOSTED_DARK_COST_MS`). So the
   * cost of listing it is a fifth of a second and the benefit is that the
   * catalogue finally names GitHub's MAINTAINED server instead of the
   * npm-deprecated one it has been recommending since 2026-08-14.
   *
   * ⚠️ IT IS `verified: false` AND MUST STAY THAT WAY UNTIL SOMEONE RUNS IT
   * WITH A TOKEN. What was proven is REACHABILITY, not function: a 401 tells
   * you something is listening and speaking our transport, and nothing about
   * whether `create_issue` works. Recording "we got a 401" as verification
   * would be exactly the blur between documented and measured that this file
   * refuses everywhere else.
   */
  Object.freeze({
    name: 'github_remote',
    purpose: 'Issues, pull requests, code search and repository contents on GitHub — the server GitHub themselves run and maintain.',
    command: '',
    args: Object.freeze([]),
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    /**
     * ⚠️ THE `${…}` FORM IS MANDATORY AND IS NOT A STYLE CHOICE. `resolveHeaders`
     * in mcp.mjs REFUSES TO CONNECT rather than send the literal text when the
     * variable is unset, so a user who has not set the token gets a sentence
     * naming the variable instead of a 401 from a stranger naming nothing. A
     * literal token written here would end up in a config people commit.
     */
    headers: Object.freeze({ Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' }),
    needsDownload: false,
    install: null,
    licence: 'n/a — hosted service, no code is installed. GitHub\'s own (api.githubcopilot.com); the open-source local twin is github/github-mcp-server, MIT.',
    credentials: Object.freeze([
      Object.freeze({ env: 'GITHUB_PERSONAL_ACCESS_TOKEN', required: true, why: 'every call is authenticated; without it the server answers 401 and offers no tools' }),
    ]),
    verified: false,
    note: 'NOT RUN with a token — nobody here has authenticated against it, so its tools are unproven and this entry can never be enabled. What WAS measured, 2026-08-25, anonymously through the real connectRemoteServer: HTTP 401 in 741ms, "bad request: missing required Authorization header". That proves reachability and transport, nothing more. The URL and the `Authorization: Bearer` header shape are GitHub\'s own, from github/github-mcp-server\'s README (read 2026-08-25, which publishes exactly this config for VS Code). ⭐ It replaces the argument for the deprecated `github` npm entry above: no install, no Go binary, no npx.',
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
   *
   * ── ⭐ AND WHAT WAS WEIGHED AND REJECTED IN THE 2026-08-25 HOSTED PASS ──────
   *
   * Ten more were checked in this pass and seven were added; the three that were
   * not are the ones worth recording, because each was rejected for a DIFFERENT
   * reason and together they are the rule.
   *
   *   · **Sentry** (`@sentry/mcp-server` 0.37.0, and hosted at
   *     `https://mcp.sentry.dev/mcp`) — REJECTED ON LICENCE, and it is the only
   *     entry ever rejected on that ground. `npm view @sentry/mcp-server license`
   *     on 2026-08-25 → **FSL-1.1-ALv2**: the Functional Source License, which is
   *     source-available with a competing-use restriction and converts to
   *     Apache-2.0 only after two years. Our standing rule is MIT/Apache-2.0/BSD
   *     yes, AGPL never, and FSL is neither — it is a licence whose whole purpose
   *     is to restrict what a company like us may do with it. Observability was
   *     the gap this was meant to fill and the gap stays open rather than be
   *     filled with a recommendation we would have to un-recommend after legal
   *     review. ⚠️ The hosted endpoint was ALSO probed (401 in 144ms) and is
   *     reachable — reachability was never the problem.
   *   · **Exa** (`exa-mcp-server` 3.4.1) — REJECTED FOR HAVING NO LICENCE AT ALL.
   *     `npm view exa-mcp-server license` returns nothing: the field is absent,
   *     which in law means all rights reserved, not "probably MIT". Web search
   *     was a genuine gap and Exa is the obvious candidate for it; a curated set
   *     that tells strangers to globally install an unlicensed package is the
   *     `mcp-server-git` mistake with better branding. ⭐ AN ABSENT LICENCE IS
   *     WORSE THAN A BAD ONE, because a bad one at least tells you the answer.
   *   · **Vercel / Linear / Notion / Stripe / Supabase hosted** — DEFERRED, not
   *     judged. All four answered 401 in 118–605ms, so all four are reachable and
   *     cheap to list. They are out because their published auth flow is OAuth
   *     with dynamic client registration, and this client sends a static
   *     `Authorization` header and nothing else — so writing them into the
   *     catalogue would mean writing a `${TOKEN}` header whose contract I could
   *     not confirm from a primary source today. `github_remote` is in precisely
   *     because GitHub's own README publishes the static-Bearer shape verbatim.
   *     ⭐ THE LINE IS "CAN I QUOTE THE VENDOR ON THE HEADER", not "is it
   *     popular" — an entry whose credential shape we guessed fails at connect
   *     with a 401 the user reads as their own mistake.
   *   · **Supabase npm** (`@supabase/mcp-server-supabase` 0.11.0, Apache-2.0) —
   *     same deferral for the stdio half: the registry facts are clean, but I
   *     could not confirm its CLI credential contract from a primary source in
   *     this environment, and "databases beyond postgres" is not worth an
   *     invented env var name. It is the strongest candidate for the next pass.
   *
   * ── ⭐⭐ THE 2026-08-26 FRAMEWORK PASS: 30 PROBED, 4 ANSWERED, 2 KEPT ────────
   *
   * Thirty candidate URLs were connected to anonymously through the real
   * `connectRemoteServer`. Two were added above. The rest are recorded HERE,
   * with what they actually answered, because **a negative result nobody wrote
   * down gets re-probed by the next person**, and two thirds of this pass was
   * spent discovering that a plausible URL does not exist.
   *
   *   · **⚠️⚠️⭐ Chakra UI** (`https://mcp.chakra-ui.com/mcp`) — WRITTEN INTO THIS
   *     CATALOGUE AS `verified: true`, AND THEN TAKEN BACK OUT THE SAME HOUR.
   *     This is the most useful entry in this block and it is a failure of mine,
   *     so it is recorded as one. The first probe connected in 2,544ms, listed 6
   *     tools (get_theme, v2_to_v3_code_review, list_components,
   *     get_component_example, get_component_props, customize_theme), and
   *     `list_components` answered ok in 520ms with the real v3 component list.
   *     On that evidence I wrote the entry. ⚠️ THE OPT-IN LIVE TEST AT THE
   *     BOTTOM OF test/mcp-catalogue-hosted.test.mjs THEN FAILED IT IMMEDIATELY:
   *     `HTTP 400 {"code":-32000,"message":"Session expired or invalid"}`.
   *     Re-probed five times in a row — **FAIL, FAIL, FAIL, FAIL, OK.** One
   *     connect in five succeeds; my original measurement was the lucky one.
   *     ⭐ AND IT IS NOT OUR BUG, which is why it cannot be fixed from here.
   *     `mcp.mjs` implements the Streamable HTTP session contract correctly — it
   *     reads `mcp-session-id` off the initialize response and echoes it on every
   *     subsequent request (mcp.mjs, `sessionId`). The server is answering the
   *     follow-up as though it had never issued the session, which is what a
   *     serverless deployment does when the second request lands on an instance
   *     that does not share the session store.
   *     ⭐⭐ THE LESSON, AND IT IS THIS FILE'S OWN DOCTRINE TURNED ON ITSELF:
   *     **ONE SUCCESSFUL CONNECT IS NOT A MEASUREMENT.** Every other entry here
   *     was verified by a single connect-and-call, and this is the first evidence
   *     that the bar is too low — an 80%-failing server passes it. A user who
   *     added this on our recommendation would see it work once and fail four
   *     times, and would conclude our MCP support is broken. That is strictly
   *     worse than never listing it.
   *
   *   · **Convex** (`https://mcp.convex.dev/mcp`) — MEASURED GOOD, DEFERRED. It
   *     connected in 692ms with an empty env, listed 4 tools (start_convex_app,
   *     add_convex_to_existing_project, get_convex_scaling_guidance,
   *     get_runbook), and `get_convex_scaling_guidance` answered ok in 293ms
   *     with real indexing/query advice. ⚠️ It is out for a REASON THAT IS NOT
   *     QUALITY: its tools SCAFFOLD rather than explain — `start_convex_app` and
   *     `add_convex_to_existing_project` add a backend to the user's project —
   *     and every app this product generates already has one
   *     (`window.AcuvoData` / `window.AcuvoAuth`). Curating a server whose first
   *     two verbs push a competing backend into our own generated apps is a
   *     decision, not a default, and it is not one to make silently inside a
   *     catalogue. ⭐ It is the strongest candidate of this pass for promotion
   *     the day someone actually asks for Convex — the numbers are here so the
   *     probe does not have to be repeated.
   *   · **Reachable but CREDENTIALED, so out under rule 2 and out again under
   *     the "can I quote the vendor on the header" line that keeps Vercel and
   *     Linear out** — every one of these answered fast, which re-confirms
   *     `HOSTED_DARK_COST_MS` on seven fresh hosts:
   *         terraform  `mcp.terraform.io/mcp`      401 in 1,132ms ("Authorization bearer token is required")
   *         semgrep    `mcp.semgrep.ai/mcp`        401 in   621ms
   *         netlify    `netlify-mcp.netlify.app`   401 in   524ms
   *         sanity     `mcp.sanity.io/mcp`         401 in   455ms
   *         gitlab     `gitlab.com/api/v4/mcp`     401 in   405ms
   *         prisma     `mcp.prisma.io/mcp`         401 in   386ms
   *         expo       `mcp.expo.dev/mcp`          401 in   136ms
   *   · **⚠️ THE URL DOES NOT EXIST — DO NOT RE-GUESS THESE.** Every one was a
   *     plausible guess from the vendor's naming pattern and every one is wrong.
   *     Six answered an HTTP error from a real host and eleven do not resolve at
   *     all:
   *         404 / 405 / HTML :  shopify (`mcp.shopify.com/mcp`), mongodb
   *           (`knowledge.mongodb.com/mcp`), railway, bun (`bun.sh/mcp`),
   *           nodejs (`nodejs.org/mcp`), mdn (`developer.mozilla.org/mcp`, 405),
   *           angular (`angular.dev/mcp` — answers 200 with text/html, which our
   *           own loader correctly refuses as "not JSON-RPC")
   *         DNS FAILURE   :  nuxt, deno, redis, tailwind, vue, drizzle, hono,
   *                          fly.io, auth0, pydantic, elastic
   *     ⭐ THE LESSON, AND IT IS THE CHEAP ONE: `mcp.<vendor>.<tld>/mcp` IS NOT A
   *     CONVENTION. It happened to be right for Svelte, Chakra and Convex and
   *     wrong for eleven others; Astro's is at `mcp.docs.astro.build`. There is
   *     no substitute for probing, and a catalogue entry written from a guessed
   *     URL is a 404 the user reads as our mistake — which it would be.
   *
   * ── ⭐⭐ THE 2026-08-26 STDIO PASS: WHAT WAS CHECKED AND NOT KEPT ───────────
   *
   * Thirty-plus package names were resolved against registry.npmjs.org (name,
   * version, licence, `deprecated`, dependency list, maintainers). Two were
   * kept. The rest are here, because a negative result nobody wrote down gets
   * re-probed by the next person — and because three of these are rejections on
   * grounds this file had never used before.
   *
   *   · **⚠️⚠️ `mongodb-mcp-server` (2.1.0, Apache-2.0, MongoDB's own) —
   *     REJECTED ON ITS OWN STARTUP TIME, WHICH IS A FIRST.** Everything about
   *     the registry facts is clean: the vendor publishes it, ten MongoDB npm
   *     accounts maintain it, no `deprecated` flag, and the credential contract
   *     is documented (`MDB_MCP_CONNECTION_STRING`, `--readOnly`). It also
   *     WORKS: connected and listed 18 tools read-only, 27 without.
   *     ⚠️ AND THROUGH THE `npx --no` LINE A CONFIG ACTUALLY USES, IT CONNECTED
   *     **2 TIMES IN 6**: ok 11,483ms · ok 19,187ms · FAIL 20,131ms · FAIL
   *     20,278ms · FAIL 20,798ms · FAIL 22,792ms. Disabling its telemetry
   *     (`--telemetry disabled`) changed nothing: ok 13,827ms then two more
   *     failures. Spawned WITHOUT npx, straight at `dist/index.js`, it managed
   *     3/3 — at 4,901ms, 11,307ms and 13,056ms, i.e. the SERVER alone eats a
   *     quarter to two thirds of `HANDSHAKE_TIMEOUT_MS` before npx adds its own
   *     resolution cost for 308 transitive packages.
   *     ⭐ THE PRINCIPLE, and it generalises past MongoDB: **a dependency tree is
   *     a latency budget, not only a security surface.** `tavily` (4 deps) and
   *     `dbhub` (8) connect in 2–4s; this one does not reliably connect at all.
   *     ⭐⭐ AND THE BAR IT FAILS IS THE ONE CHAKRA TAUGHT US: one successful
   *     connect is not a measurement. Had it been probed once — the way every
   *     entry before 2026-08-26 was — it would have passed at 11.5s and then
   *     failed most sessions for whoever trusted us.
   *   · **⚠️ `@supabase/mcp-server-supabase` (0.11.0, Apache-2.0) — THE
   *     "STRONGEST CANDIDATE FOR THE NEXT PASS" IS NO LONGER A STDIO SERVER.**
   *     The 2026-08-25 pass deferred it because its CLI credential contract
   *     could not be confirmed from a primary source. Confirmed today, and the
   *     answer is that there is nothing to confirm: its npm README is a 28-byte
   *     stub and the vendor's own repo README (github.com/supabase/mcp, read
   *     2026-08-26) documents ONLY `{"type":"http","url":"https://mcp.supabase.
   *     com/mcp"}` with OAuth 2.1, plus a local-CLI endpoint at
   *     `http://localhost:54321/mcp`. The npm package is now positioned as a
   *     LIBRARY (`createToolSchemas`, `createSupabaseMcpHandler`) for people
   *     building their own server. ⭐ So the deferral was right and the reason
   *     has changed: it is not "we cannot quote the vendor on the header", it is
   *     "the vendor no longer ships the thing we were going to curate". Its
   *     hosted endpoint is OAuth-with-dynamic-registration, which this client
   *     (static `Authorization` header only) still cannot speak.
   *   · **⛔ `@henkey/postgres-mcp-server` (1.0.7) — AGPL-3.0.** The most
   *     feature-complete Postgres MCP server on npm, and the standing rule is
   *     MIT/Apache-2.0/BSD yes, AGPL never. Recorded by name because it ranks
   *     highly in every search and will be proposed again.
   *   · **⛔ `pg-mcp` (0.0.1) — NO LICENCE FIELD, no repository, no bin.** The
   *     `exa-mcp-server` shape exactly: an absent licence means all rights
   *     reserved, not "probably MIT".
   *   · **⚠️ `@benborla29/mcp-server-mysql` (2.0.9, MIT) — REJECTED ON WHAT IT
   *     INSTALLS.** Its RUNTIME dependencies include `mcp-evals`, which pulls
   *     `openai`, `@anthropic-ai/sdk`, `@ai-sdk/openai` and the OpenTelemetry
   *     stack. A MySQL server that installs three LLM SDKs and a tracing
   *     exporter is not a thing to hand a stranger, whatever the licence says.
   *     `dbhub` covers MySQL anyway, with pure-JS `mysql2` as an OPTIONAL
   *     dependency.
   *   · **⚠️ `@executeautomation/database-server` (1.1.0, MIT)** — depends on
   *     `sqlite3` AND `mssql` AND `mysql2` AND `pg`, unconditionally. The native
   *     compile that killed the SQLite candidate in 2026-08-14, now mandatory
   *     for everyone regardless of which database they use.
   *   · **⚠️ `mcp-remote` (0.2.5, MIT)** — genuinely tempting, and it is the one
   *     thing that would unlock every OAuth-only hosted server (Vercel, Linear,
   *     Notion, Supabase, Tavily's own remote endpoint) that this client cannot
   *     reach. It is out for a reason that is not quality: a SINGLE npm
   *     maintainer, and the package's job is to sit IN THE CREDENTIAL PATH,
   *     holding an OAuth token for an arbitrary remote server. A curated set is
   *     a set of things we are willing to be blamed for, and a sole-maintainer
   *     token broker is the one place that argument bites hardest.
   *   · **⚠️ THE WHOLE `@modelcontextprotocol/server-*` REFERENCE FAMILY IS
   *     DEPRECATED.** Re-checked 2026-08-26; every one of these carries npm's
   *     own `deprecated: "Package no longer supported."`: `-github` (2025.4.8),
   *     `-postgres` (0.6.2), `-redis` (2025.4.25), `-gitlab` (2025.4.25),
   *     `-slack` (2025.4.25), `-brave-search` (0.6.2), `-puppeteer`
   *     (2025.5.12), `-everart` (0.6.2). Only `-filesystem` (2026.7.10),
   *     `-memory` and `-sequential-thinking` (both 2026.7.4) are still current.
   *     ⭐ So "add Redis / GitLab / Slack from the official servers" is not
   *     available — those are the abandoned ones, and there is no maintained npm
   *     replacement we would recommend. Not a gap we can close by shopping.
   *   · **⚠️ OBSERVABILITY IS STILL OPEN, AND IT IS NOT FOR LACK OF LOOKING.**
   *     `@sentry/mcp-server` re-checked 2026-08-26: still 0.37.0, still
   *     **FSL-1.1-ALv2**, still out. `@grafana/mcp`, `@datadog/mcp-server`,
   *     `@honeycombio/mcp-server` and `@axiomhq/mcp-server` do not exist on npm
   *     at all (404). ⚠️ DO NOT RE-GUESS THOSE FOUR NAMES.
   *   · **⚠️ ISSUE TRACKERS BEYOND GITHUB: nothing publishable.** `@linear/mcp`
   *     and `@atlassian/mcp-server` are 404s; `linear-mcp-server` (0.1.0, MIT)
   *     is one person's 0.1.0. GitHub's own hosted server already covers the
   *     tracker most users are in.
   *
   * ── ⚠️ TWO HOSTED CANDIDATES MEASURED BUT PARKED, FOR A PROCESS REASON ─────
   *
   * Both are the vendor's own host and both would qualify. Neither could be
   * added in this pass because `test/mcp-catalogue-hosted.test.mjs` requires
   * every hosted entry to appear in a hardcoded `EXPECTED_HOST_SUFFIX` map, and
   * that file was outside this lane. The evidence is left here so the next pass
   * spends a line rather than an afternoon:
   *   · **Tavily remote** — `https://mcp.tavily.com/mcp`, on tavily.com. The
   *     vendor's README publishes BOTH auth shapes verbatim: a query parameter
   *     (`?tavilyApiKey=…`) and, quoted, *"you can pass your API key through an
   *     Authorization header … `Authorization: Bearer <your-api-key>`"* — which
   *     is exactly the static-Bearer contract that got `github_remote` in and
   *     kept Vercel and Linear out. Not probed anonymously in this pass.
   *   · **Supabase hosted** — `https://mcp.supabase.com/mcp`, on supabase.com,
   *     and now the ONLY shape Supabase documents. Out on the credential rule
   *     rather than the process one: OAuth 2.1 with dynamic client registration,
   *     which this client does not speak.
   */
]);

/**
 * ── ⚠️⚠️ THE REJECTIONS, MACHINE-READABLE — BECAUSE PROSE REACHES NOBODY ────
 *
 * Everything above this line is the curation this module was written to hold,
 * and the most valuable single fact in it is a REJECTION: `mcp-server-git` on
 * npm is a dependency-confusion canary (`github.com/theinfosecguy/npx-canary`,
 * self-described as *"Security research canary — not for production use"*), and
 * the two `@modelcontextprotocol/server-*` entries carry npm's own `deprecated`
 * flag.
 *
 * ⚠️ AND ALL THREE FACTS WERE UNREACHABLE. They lived in a header comment and in
 * a `note` string, which are read by the person editing THIS file and by nobody
 * else. Measured 2026-08-25, through the real code:
 *
 *   · `acuvo mcp search git` LISTS `mcp-server-git` as a result, with the
 *     package's own self-description as the only hint, and then prints
 *     `Add one: acuvo mcp add <top result>`.
 *   · `acuvo mcp add mcp-server-git` writes it to `.acuvo/mcp.json` without a
 *     word, and tells the user to run `/mcp` to see whether it connects.
 *
 * So this package researched a supply-chain probe, wrote three paragraphs about
 * why it must never be recommended, and then shipped two commands that
 * recommend it. That is the repo's own signature defect — a correct finding
 * with no caller — applied to a security finding.
 *
 * ⭐ SO THE FINDING BECOMES DATA, AND THE COMMANDS CONSULT IT. `severity`
 * separates the two honestly:
 *   · `refuse` — we will not write it into a config at all. Reserved for
 *     packages whose PUBLISHER says they are not a real server.
 *   · `warn`   — real, installable, still works; we say what is wrong and let
 *     the user decide. Refusing a deprecated-but-working package would break
 *     configs that are fine today, which is a bigger harm than the warning.
 *
 * ⚠️ THIS IS NOT A BLOCKLIST AND MUST NOT GROW INTO ONE. Four entries, each
 * one a fact checked against the registry on a stated date. A list of packages
 * we merely dislike would make `mcp add` a whitelist, which is precisely what
 * `mcp-add.mjs` says it must never become.
 */
export const PACKAGE_ADVISORIES = Object.freeze({
  'mcp-server-git': Object.freeze({
    severity: 'refuse',
    message: 'npm `mcp-server-git` describes ITSELF as "Security research canary — not for production use. '
      + 'Part of an authorized bug bounty research project" (repository github.com/theinfosecguy/npx-canary, '
      + 'checked 2026-08-14). It is a dependency-confusion probe, not the git MCP server — the real one is a '
      + 'Python package run with `uvx mcp-server-git`, which this npx-only client cannot start anyway. '
      + 'You do not need it: this CLI ships native git_status, git_diff, git_log and git_commit.',
  }),
  '@modelcontextprotocol/server-github': Object.freeze({
    severity: 'warn',
    /**
     * ── ⚠️ THE WARNING USED TO END IN A DEAD END, AND A DEAD END IS NOT ADVICE ─
     *
     * It said the maintained replacement was "a hosted HTTP service that this
     * stdio-only, npx-only client cannot start" — true on 2026-08-14, false from
     * 2026-08-15 when `mcp.mjs` learned Streamable HTTP. So the one time we had
     * the user's attention, we told them their alternative was impossible.
     *
     * ⭐ A WARNING WHOSE REMEDY IS A COMMAND IS WORTH TEN THAT ARE NOT. The
     * replacement is named, it is GitHub's own, and it was measured reachable.
     */
    message: 'npm reports this package `deprecated: "Package no longer supported."` (checked 2026-08-14, '
      + 're-checked 2026-08-25). It still resolves and still installs, but it is unmaintained. '
      + 'GitHub\'s maintained server is hosted at https://api.githubcopilot.com/mcp/ — measured reachable '
      + '2026-08-25 (HTTP 401 in 741ms without a token) — and this client has spoken HTTP since 2026-08-15, '
      + 'so it needs no install at all:  acuvo mcp add github_remote',
  }),
  'blender-mcp': Object.freeze({
    severity: 'warn',
    message: 'npm `blender-mcp` is published by `react-frameui` — it is NOT the widely used Blender server '
      + '(github.com/ahujasid/mcp-for-blender, MIT), which is a Python package on PyPI (checked 2026-09-27). '
      + 'The curated one needs no npm install at all:  acuvo mcp add blender',
  }),
  '@modelcontextprotocol/server-postgres': Object.freeze({
    severity: 'warn',
    message: 'npm reports this package `deprecated: "Package no longer supported."` (checked 2026-08-14). '
      + 'It is the last published build of the reference server and still installs; treat it as frozen, '
      + 'not as maintained.',
  }),
});

/**
 * What, if anything, we know against a package name.
 *
 * ⚠️ EXACT MATCH ON THE PACKAGE NAME, DELIBERATELY. A substring or prefix rule
 * would catch `mcp-server-github` on its way to matching `mcp-server-git`, and a
 * false refusal here blocks a legitimate server with a security-flavoured
 * message the user has no way to argue with. Returns null for everything we
 * have not personally checked, which is almost everything — see the note above
 * on why this stays tiny.
 */
export function packageAdvisory(pkg) {
  const name = String(pkg ?? '').trim();
  if (!name) return null;
  return PACKAGE_ADVISORIES[name] ?? null;
}

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

/**
 * The `mcp.mjs` server spec for an entry — what `connectServer` wants.
 *
 * ── ⚠️ TWO SHAPES, AND THE HOSTED ONE IS COPIED FROM `readMcpConfig` EXACTLY ──
 *
 * `connectServer` branches on `transport`, never on "does it have a command",
 * and `readMcpConfig` builds a remote server as
 * `{ name, transport, url, headers, command: url, args: [], env: {} }`.
 *
 * ⭐ `command` MIRRORING THE URL IS THE PART NOBODY WOULD GUESS, and dropping it
 * would break three readers that are not ours: `turn.mjs` prints the
 * `mcp-start` notice from `server.command` (it would read
 * "starting MCP server deepwiki: undefined"), `mcp-consent.mjs` puts it in the
 * approval text, and `fingerprint` HASHES it — so every remote server would
 * hash identically and approving one host would silently approve any other.
 * `readMcpConfig` says all of this in its own comment; the rule here is simply
 * that a spec we hand to the same client must be indistinguishable from one the
 * loader produced.
 */
export function toServerSpec(entry, { packageRoot = PACKAGE_ROOT } = {}) {
  if (isHosted(entry)) {
    return {
      name: entry.name,
      transport: entry.transport ?? 'http',
      url: entry.url,
      headers: { ...(entry.headers ?? {}) },
      command: entry.url,
      args: [],
      env: {},
    };
  }
  /**
   * ⚠️ THE STDIO BRANCH IS UNCHANGED, INCLUDING THE ABSENCE OF `transport`.
   * `connectServer` treats anything that is not 'http'/'sse' as a spawn, and
   * `test/mcp-defaults.test.mjs` pins this object to exactly four keys
   * (`args, command, env, name`). Adding a redundant `transport: 'stdio'` here
   * would be a cosmetic improvement that turns another lane's suite red.
   */
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
      // ⚠️ The guard that stops the download differs by runner; naming npx on a
      // uv entry sends the user to the wrong package manager.
      const guard = entry.runner === 'uv' ? 'runs uvx `--offline`' : 'passes npx `--no`';
      return {
        ...base,
        state: 'dark',
        detail: known
          ? `${pkg} is not installed — this client ${guard}, so it cannot download it`
          : `needs ${pkg}, and whether it is installed was not checked — this client ${guard}, so it cannot download it`,
        fix: `${entry.install} — then re-run. Leaving it unconfigured costs a ${Math.round(DARK_ENTRY_COST_MS / 1000)}s timeout every session it is enabled.`,
        costMs: DARK_ENTRY_COST_MS,
      };
    }
  }

  const missing = requiredCredentials(entry).filter((c) => !present(env, c.env));
  if (missing.length > 0) {
    const names = missing.map((c) => c.env).join(', ');
    /**
     * ── ⚠️ THE COST SENTENCE IS TRANSPORT-SPECIFIC, BECAUSE THE COST IS ───────
     *
     * A spawned server that cannot authenticate holds the session for the full
     * 20,052ms handshake — that measurement is what rule 2 is built on. A hosted
     * one answers 401 and lets go: 118–741ms across seven vendors, measured
     * 2026-08-25. Printing "20s" at someone whose real cost is under a second
     * is not a harmless rounding; it is the sentence that would talk them out of
     * configuring a server worth having.
     */
    const hosted = isHosted(entry);
    const cost = darkCostMs(entry);
    return {
      ...base,
      state: 'dark',
      detail: `${names} ${missing.length === 1 ? 'is' : 'are'} not set — ${missing[0].why}`,
      fix: hosted
        ? `set ${names}. Until then ${entry.url} answers 401 — measured under ${Math.round(cost / 1000)}s, so an unconfigured hosted server costs a line in the transcript rather than a stalled session.`
        : `set ${names}. Until then this server cannot start, and enabling it costs a ${Math.round(cost / 1000)}s timeout every session.`,
      costMs: cost,
    };
  }

  const optionalMissing = (entry.credentials ?? []).filter((c) => !c.required && !present(env, c.env));
  /**
   * ⚠️ "can start" IS THE WRONG VERB FOR SOMETHING WE NEVER START. A hosted
   * entry is a call to somebody else's machine, and the fact a user most needs
   * on that line is not that it works — it is WHERE their query goes. The
   * hostname is in the detail for the same reason `describeConfiguredServers`
   * prints the whole command line: a one-word status is consent to nothing.
   */
  const where = isHosted(entry) ? ` — reached over the network at ${entry.url}` : '';
  const canStart = isHosted(entry) ? 'reachable with no install and no key' : 'can start';
  /**
   * ── ⚠️ "fewer tools" IS NOT WHAT ALWAYS HAPPENS, AND SAYING IT ANYWAY IS THE
   *       SAME CLASS OF DEFECT AS THE 20s COST SENTENCE ────────────────────────
   *
   * The phrase was hardcoded when `acuvo` was the only entry with an optional
   * credential, and for `acuvo` it is exact: no RENDER_AUDIT_URL, no `see_page`
   * in the list. `tavily` (2026-08-26) is the first entry where it is wrong —
   * keyless it advertises all five tools and three of them reply with a sign-up
   * message. A status line that describes a shrunken surface when the surface is
   * the same size sends the user looking for a missing tool that is right there.
   *
   * ⭐ DE-DUPLICATED, so the acuvo case — three variables, one shared effect —
   * still renders exactly the sentence it rendered before this field existed.
   * That is deliberate: an honesty fix that churns every other entry's output is
   * an honesty fix nobody can review.
   */
  const DEFAULT_ABSENT_EFFECT = 'it will offer fewer tools';
  const absentEffects = [...new Set(optionalMissing.map((c) => c.absentDetail ?? DEFAULT_ABSENT_EFFECT))];
  const detail = optionalMissing.length > 0
    ? `${canStart}; ${optionalMissing.map((c) => c.env).join(', ')} not set, so ${absentEffects.join('; and ')}${where}`
    : `${canStart}, and nothing checkable rules it out${where}`;

  /**
   * ⚠️ EACH REASON STAYS ATTACHED TO ITS VARIABLE. Joining the names and then
   * joining the reasons produced "without it …; without it …", where "it"
   * pointed at nothing — three variables and three dangling pronouns.
   */
  const optionalFix = optionalMissing.length > 0
    ? `set ${optionalMissing.map((c) => `${c.env} (${c.why})`).join('; ')}`
    : null;

  /**
   * ── ⭐⭐ THE SHORTEST PATH HAS TO BE NAMED OR IT IS NOT TAKEN ───────────────
   *
   * This repo's own hard-learned rule, and `fix: null` broke it the moment the
   * hosted entries arrived. Six servers now report `live` with nothing missing —
   * and switched off, because turning them on is the user's call — so the
   * `--doctor` row and the `--mcp` line for each of them said, in effect,
   * "this works" and then stopped. The user is one command away and is told
   * nothing; that is an offered capability nobody reaches, which is the exact
   * defect this catalogue was written to stop being.
   *
   * ⚠️ NOT FOR AN ENTRY THAT IS ALREADY A DEFAULT. `acuvo` is started for you,
   * so telling you to add it is noise — and `test/mcp-defaults.test.mjs` pins
   * its fix to null with all its optional endpoints set, which is the right
   * assertion: there is genuinely nothing left to do.
   */
  const enableFix = entry.enabledByDefault
    ? null
    : `turn it on with \`acuvo mcp add ${entry.name}\``;

  return {
    ...base,
    state: 'live',
    detail,
    fix: [optionalFix, enableFix].filter(Boolean).join('; ') || null,
    costMs: 0,
    /**
     * ⚠️ THE URL, NOT AN EMPTY STRING. A hosted entry's `command` is `''`, so
     * the template below would have rendered a bare `''` for every one of them
     * — a "command" field that is present, empty and meaningless is worse than
     * one that is absent, because a caller printing it shows the user nothing
     * and has no way to know it got nothing.
     */
    command: isHosted(entry)
      ? entry.url
      : `${entry.command} ${resolveArgs(entry, { packageRoot }).join(' ')}`.trim(),
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
    /**
     * ── ⚠️⚠️ THE INVOCATION MUST BE THE SHAPE THE LOADER READS, PER TRANSPORT ─
     *
     * `_disabled` exists so a user can MOVE an entry into `mcpServers` and have
     * it work. Writing `{"command":"","args":[]}` for a hosted server would
     * hand them a block that `readMcpConfig` rejects with `server "deepwiki"
     * has no "command"` — and the failure would land after they had followed
     * our own instructions, which is the worst place for it. So the rendered
     * block is `{type,url,headers}` for hosted and `{command,args}` for stdio,
     * and there is a test that round-trips one of each through the real reader.
     */
    const invocation = isHosted(entry)
      ? {
        type: entry.transport ?? 'http',
        url: entry.url,
        ...(entry.headers ? { headers: { ...entry.headers } } : {}),
      }
      : { command: entry.command, args: resolveArgs(entry, { packageRoot }) };

    if (active) {
      mcpServers[entry.name] = invocation;
      continue;
    }
    _disabled[entry.name] = {
      what: entry.purpose,
      why_off: a?.detail ?? 'not enabled by default',
      /**
       * ── ⚠️ A LIVE ENTRY HAS NOTHING TO *FIX*, AND STILL NEEDS AN INSTRUCTION ─
       *
       * `assessEntry.fix` is null when nothing is missing, which is exactly the
       * state the keyless hosted entries are in: reachable, no key, no install —
       * and switched off, because turning them on is the user's call.
       * (⚠️ DELIBERATELY NOT A COUNT. This read "the seven hosted entries" and
       * was stale within a day of the next pass adding two more. A comment that
       * counts the thing beside it goes wrong every time somebody does correct
       * work, which is the failure mode this whole file is written against.)
       * Passing
       * that null straight through would have printed
       * `"to_enable": null` next to a server that needs one line to enable, and
       * would have broken the invariant in test/mcp-defaults.test.mjs that every
       * disabled entry says how to turn it on. The fallback is the command, not
       * a shrug.
       */
      to_enable: a?.fix
        ?? `nothing is missing — turn it on with \`acuvo mcp add ${entry.name}\`, or move this block into "mcpServers".`,
      verified_by_us: entry.verified,
      // ⭐ THE LICENCE TRAVELS WITH THE ENTRY. This is the file a reviewer reads
      // before allowing a server, and "what am I installing and under what
      // terms" is the first question they ask. It was previously answerable only
      // by reading this module's source.
      licence: entry.licence ?? null,
      note: entry.note,
      ...invocation,
    };
  }

  return {
    // ⭐ A header the user reads before the servers, in a key the client ignores.
    _readme: [
      `Written by acuvo-code. Only "mcpServers" is read; "_disabled" and "_hosted_example" are documentation.`,
      `Move an entry from _disabled into mcpServers to turn it on — its "to_enable" says what it needs first.`,
      `A spawned server that cannot start costs a ${Math.round(DARK_ENTRY_COST_MS / 1000)}s timeout at session start, which is why they are off.`,
      `At most ${MAX_SERVERS} servers are read; anything past that is silently ignored.`,
      `Entries with a "url" are HOSTED: nothing is installed and nothing runs on this machine, but your query text leaves it — that is why they are off by default too, and it is the only reason.`,
      `A hosted server that is missing its token answers 401 in well under ${Math.round(HOSTED_DARK_COST_MS / 1000)}s (measured), not the ${Math.round(DARK_ENTRY_COST_MS / 1000)}s a spawned one costs.`,
      `"_hosted_example" shows the shape for a hosted server we do not curate.`,
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
  /**
   * ⚠️ THE COLUMN WIDTH IS MEASURED, NOT GUESSED AT 12. It was a literal until
   * `github_remote` (13 characters) arrived and pushed its own detail column out
   * of line with every other row. A hardcoded width is a layout that silently
   * degrades the moment the catalogue grows, which is the one thing this module
   * is now designed to do.
   */
  const width = rows.reduce((n, r) => Math.max(n, String(r.label).length), 0);
  const lines = [
    `MCP defaults — ${live.length} of ${rows.length} usable here`,
    '',
  ];
  for (const r of rows) {
    const mark = r.state === 'live' ? 'live' : 'dark';
    const flag = r.verified ? '' : ' (unverified — never enabled)';
    lines.push(`  ${mark.padEnd(4)}  ${r.label.padEnd(width)} ${r.detail}${flag}`);
    if (r.fix) lines.push(`        ${' '.repeat(width)} → ${r.fix}`);
  }
  const stalled = rows.filter((r) => r.state === 'dark' && r.enabledByDefault);
  if (stalled.length > 0) {
    /**
     * ⚠️ SUMMED FROM EACH ROW'S OWN `costMs`, NOT FROM `count × 20s`. The two
     * were the same number until 2026-08-25, when hosted entries arrived with a
     * measured dark cost of ~1s instead of 20,052ms. Multiplying a mixed set by
     * the stdio constant would over-state the stall by up to 20×, which is the
     * same class of wrong as the under-statement this file usually guards
     * against — a warning nobody can reproduce stops being believed.
     */
    const totalMs = stalled.reduce((n, r) => n + (r.costMs ?? DARK_ENTRY_COST_MS), 0);
    lines.push('', `  ⚠️ ${stalled.length} default(s) would stall this session by ${Math.round(totalMs / 1000)}s if spawned — they are skipped.`);
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
