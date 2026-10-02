/**
 * ── ⭐⭐ PLAYTEST — DRIVE THE THING YOU BUILT AND REPORT WHAT BROKE ──────────
 *
 * `see_page` renders a page and MEASURES it — contrast, painted ratio, clipped
 * text. It is a photograph. It cannot press a button, and "the primary action
 * does nothing" is the defect that survives every screenshot ever taken.
 *
 * ⭐ WHAT IS ACTUALLY NEW HERE IS NOT THE BROWSER. IT IS THE RETURN VALUE.
 * A browser is one `acuvo mcp add playwright` away and always has been — the
 * catalogue entry is VERIFIED, 24 tools, a real navigation. What nobody has is
 * a way to spend ONE tool call on the whole loop. Driving a page through the
 * raw MCP verbs costs a round per action: navigate, snapshot, read the tree,
 * find the ref, click, snapshot again, read the console, read the network. That
 * is eight rounds and eight full accessibility trees in the transcript — and
 * the transcript is re-sent on every subsequent round, so the cost is not paid
 * once. Measured against `MAX_TOOL_ROUNDS`, a single interactive check can eat
 * an entire run before it finds anything.
 *
 * ⭐ So this verb does the whole sequence in-process and returns ~200 tokens of
 * ORDERED, SPECIFIC defects. No DOM. No screenshot. A prioritised list, worst
 * first, and a one-sentence verdict that says what was measured and what was
 * not.
 *
 * ── ⚠️⚠️ IT MUST NEVER SAY IT TESTED SOMETHING IT DID NOT ────────────────────
 *
 * This package has shipped that exact bug: `see_page` returned
 * `{ looked: true, findings: [] }` for pages it had never rendered, because it
 * read three keys that did not exist. An empty findings list reads as an
 * all-clear. So every refusal in this file returns `drove: false` and a sentence
 * naming what is missing, and `drove: true` is only ever produced by a run that
 * really navigated. `measured` and `unmeasured` are BOTH returned, always, so a
 * clean verdict can never be mistaken for a complete one.
 *
 * ── ⚠️ GENERIC. NO VERTICAL, NO DOMAIN, NO GAME ─────────────────────────────
 *
 * The brief that produced this file was "a headless playtester", and the
 * temptation is to teach it about the thing being tested. It knows about
 * exactly four things: a URL, an accessibility tree, a console and a network
 * log. `steps` and `expect` come from the caller. There is no rule in here that
 * only makes sense for one kind of page, and there must never be one.
 *
 * ── ⚠️ THE DEPENDENCY RULE ──────────────────────────────────────────────────
 *
 * `acuvo-code` has zero runtime dependencies and this file does not change that.
 * It drives a browser the USER has already installed and already consented to,
 * through the MCP client this package already ships. Nothing is downloaded,
 * nothing is added to package.json, and a machine without a browser server gets
 * a sentence rather than an install attempt.
 *
 * ── ⚠️⚠️ AND IT CANNOT SPAWN A SERVER NOBODY APPROVED ───────────────────────
 *
 * `turn.mjs` gates the per-run MCP spawn behind `checkMcpConsent` for the reason
 * ENTERPRISE §3.1 records: a cloned repository used to choose a binary and get
 * it executed. A second door that reads the same `.mcp.json` and spawns from it
 * directly would reopen that hole in full. So this file requires the SAME
 * fingerprint to already be in the trust store (or `ACUVO_TRUST_MCP` set) and
 * refuses otherwise — it can only ever start something the user has already
 * said yes to, and it never asks, because a tool result is not a consent
 * screen.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { resolveInWorkspace } from './workspace.mjs';
import { serveWorkspace } from './serve-workspace.mjs';
import { readMcpConfig, connectServer, callMcpTool, closeConnections, namespacedName } from './mcp.mjs';
import { fingerprint, loadTrust, isTrusted, TRUST_ENV } from './mcp-consent.mjs';
/**
 * ⭐ IMPORTED, NOT RE-IMPLEMENTED. `see_page` already decided "which URLs may a
 * model point a browser at" and wrote the argument down: an arbitrary URL is a
 * request-forgery primitive, and a hostname comparison is the only version of
 * the check that cannot be talked around with `http://127.0.0.1.evil.com/`.
 * A second copy here is the copy that goes stale — this package has had that
 * exact failure twice in one week (`feedback_a_fix_that_cannot_be_imported`).
 */
import { loopbackTarget, inlineLocalAssets, fetchServedPage } from './media.mjs';
import { readAccount } from './account.mjs';
import { renderEndpoint } from './creative-engines.mjs';
import { failureReason } from './model-json.mjs';

export const PLAYTEST_TOOL_NAMES = Object.freeze(['playtest']);

/**
 * ⭐ THE OVERRIDE, AND THE REASON IT EXISTS. The gate below looks for a
 * browser-shaped server in the user's own MCP config by NAME, which works for
 * everyone who typed `acuvo mcp add playwright`. Someone who called theirs
 * `qa-browser` would be invisible to it — so they can name it, and the same
 * variable is what the reachability guard sets to prove the verb is reachable
 * under SOME configuration.
 */
export const BROWSER_SERVER_ENV = 'ACUVO_BROWSER_MCP';

/**
 * The server names this recognises as a browser without being told. Both
 * entries in `mcp-defaults.mjs`'s catalogue that can drive a page are here —
 * `playwright` (@playwright/mcp) and `browser` (chrome-devtools-mcp) — plus the
 * two other names people give the same thing.
 */
export const BROWSER_SERVER_NAMES = Object.freeze(['playwright', 'browser', 'chrome-devtools', 'chrome', 'puppeteer']);

/** How long the whole drive may take. A step is a real browser action. */
export const MAX_RUN_MS = 120_000;
/** Bounds on what the model may ask for — see the schema for why each one. */
export const MAX_STEPS = 12;
export const MAX_EXPECT = 10;
/** Bounds on what comes back. The result is re-sent every subsequent round. */
export const MAX_PROBLEMS = 20;
export const MAX_PROBLEM_CHARS = 200;

/**
 * ── ⭐ TWO SERVERS, ONE SEQUENCE ────────────────────────────────────────────
 *
 * The verbs are identical in meaning and different in spelling: Playwright's
 * `browser_click` wants `{element, ref}` (a human label plus a snapshot ref),
 * Chrome DevTools' `click` wants `{uid}`. Rather than hard-code one and call
 * the other unsupported, the differences live in a table and the DRIVING CODE
 * IS SHARED — which is the only reason both are actually exercised rather than
 * one being a claim.
 *
 * ⚠️ `requires` IS CHECKED AGAINST THE TOOLS THE SERVER REALLY LISTED, never
 * against its name. A server called `playwright` that speaks something else is
 * reported as unusable, with its tool names, instead of failing on the first
 * call with a message about an argument nobody passed.
 *
 * ── ⚠️⚠️ AND THE NAMES ARE NOT THE ONLY THING THAT DRIFTS ────────────────────
 *
 * Measured against a REAL `@playwright/mcp` 0.0.79 on 2026-09-01: this table
 * was two spellings out of date and EVERY interactive step failed —
 *
 *     browser_click  required=["target"]  props=[element,target,…]   (no `ref`)
 *     browser_type   required=["target","text"]
 *     browser_console_messages  required=["level"]
 *     browser_network_requests  required=["static"]
 *
 * so `{element, ref}` came back as *"Invalid input: expected string, received
 * undefined → at target"*, and the console and network reads — which are sent
 * `{}` — were rejected for a missing required argument. The page loaded, the
 * refs parsed, the report said `drove: true`, and not one click landed.
 *
 * ⭐ THE WHOLE SUITE WAS GREEN THROUGHOUT, because `fake-browser-mcp.mjs`
 * declared `inputSchema: { type: 'object' }` — no properties, no `required` —
 * so the fixture accepted arguments the real server refuses. Its own header
 * says it cannot prove the spelling is current, and it was right.
 *
 * ⭐⭐ SO THE ARGUMENTS ARE ADAPTED TO THE SCHEMA THE SERVER DECLARED AT
 * CONNECT, not to a spelling recorded here on a date (see `adaptArgs`). Each
 * entry below offers EVERY spelling it has ever known; the ones the connected
 * server does not declare are dropped, and anything it requires and we did not
 * send is filled from its own `default`. Pinning one spelling is what put this
 * table two versions behind, and pinning the NEW one would only reset the
 * clock.
 */
export const DRIVERS = Object.freeze([
  Object.freeze({
    id: 'playwright',
    requires: Object.freeze(['browser_navigate', 'browser_snapshot']),
    navigate: (url) => ['browser_navigate', { url }],
    snapshot: () => ['browser_snapshot', {}],
    consoleMessages: () => ['browser_console_messages', {}],
    network: () => ['browser_network_requests', {}],
    resize: (width, height) => ['browser_resize', { width, height }],
    /**
     * ⚠️ `ref` AND `target` ARE BOTH SENT AND EXACTLY ONE SURVIVES. `element`
     * is still declared (it is what the server puts in its own permission
     * prompts) so it is kept in both eras; `ref` is the pre-0.0.79 name for the
     * snapshot reference and `target` is the current one, and `adaptArgs` drops
     * whichever this server does not list. Sending both blind would fail on its
     * own: the schema is `additionalProperties: false`.
     */
    click: (el) => ['browser_click', { element: el.label, ref: el.ref, target: el.ref }],
    type: (el, text) => ['browser_type', { element: el.label, ref: el.ref, target: el.ref, text }],
    press: (key) => ['browser_press_key', { key }],
    waitFor: (text) => ['browser_wait_for', text ? { text } : { time: 1 }],
    evaluate: (fn) => ['browser_evaluate', { function: fn }],
  }),
  Object.freeze({
    id: 'chrome-devtools',
    requires: Object.freeze(['navigate_page', 'take_snapshot']),
    navigate: (url) => ['navigate_page', { url }],
    snapshot: () => ['take_snapshot', {}],
    consoleMessages: () => ['list_console_messages', {}],
    network: () => ['list_network_requests', {}],
    resize: (width, height) => ['resize_page', { width, height }],
    click: (el) => ['click', { uid: el.ref }],
    type: (el, text) => ['fill', { uid: el.ref, value: text }],
    press: (key) => ['press_key', { key }],
    waitFor: (text) => ['wait_for', text ? { text } : { text: '' }],
    evaluate: (fn) => ['evaluate_script', { function: fn }],
  }),
]);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. IS THERE A BROWSER TO DRIVE — the gate, which runs once per turn
 * ──────────────────────────────────────────────────────────────────────────── */

/** The configured server this should drive, or null. Name-based; nothing spawns. */
export function chooseBrowserServer(servers, env = process.env) {
  const list = Array.isArray(servers) ? servers : [];
  const named = String(env?.[BROWSER_SERVER_ENV] ?? '').trim();
  if (named) return list.find((s) => s?.name === named) ?? null;
  for (const want of BROWSER_SERVER_NAMES) {
    const hit = list.find((s) => String(s?.name ?? '').toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

/**
 * ⚠️ CHEAP ENOUGH TO RUN EVERY TURN, and there is a test that measures it. The
 * database gate in `tools.mjs` cost 478ms per call in its first version and
 * cancelled a whole test run; this reads at most two small JSON files that
 * `readMcpConfig` already caps at 8 servers.
 *
 * ⚠️ AND IT IS A GATE, NOT A PROMISE. A configured server can still be dark —
 * not installed, no browser on the machine, consent never given. That is the
 * runtime's problem and it is reported honestly there. What this decides is the
 * cheaper question: is it worth spending ~430 tokens of schema on this machine.
 */
export function browserServerAvailable(root, env = process.env, { configImpl = readMcpConfig } = {}) {
  if (String(env?.[BROWSER_SERVER_ENV] ?? '').trim()) return true;
  let cfg;
  try { cfg = configImpl(root); } catch { return false; }
  if (!cfg?.ok) return false;
  return Boolean(chooseBrowserServer(cfg.servers, env));
}

/**
 * ⚠️ `allowRun` GATES IT, exactly as `start_process` and `run_command` are
 * gated. Driving a browser starts a child process on this machine — a flag that
 * promises "run nothing" must withhold it, or the flag is a lie by a side door.
 *
 * ⚠️ MULTI-ROUND ONLY, for this package's standing reason: the whole value of a
 * report is the round that ACTS on it. A single-shot turn that playtests and
 * stops has bought a list of defects nobody can fix.
 */
export function playtestToolNames(root, env = process.env, { allowRun = true, maxRounds = 2, configImpl = readMcpConfig, home = undefined } = {}) {
  if (!allowRun || maxRounds <= 1) return [];
  return browserServerAvailable(root, env, { configImpl }) || hostedDriveRoute(env, home)
    ? [...PLAYTEST_TOOL_NAMES]
    : [];
}

/**
 * ── 🎮⭐⭐ THE HOSTED DRIVE (2026-09-26) ────────────────────────────────────
 *
 * Found by using it: asked to *"check it actually starts and moves"*, the CLI
 * built a snake game and had to say *"I don't have a browser-driving tool in
 * this environment"* — `playtest` needed a LOCAL browser MCP server, which a
 * customer does not have, while `see_page` worked out of the box through the
 * account. This is the same door: `<gateway>/render` with `mode: 'playtest'`,
 * the customer's own token, our Modal drive behind it, and the frame probe so a
 * canvas game reports whether its picture MOVED.
 *
 * `null` when there is no signed-in account — the caller then says what it
 * always said. The page is bundled the way `see_page` bundles it.
 */
export function hostedDriveRoute(env = process.env, home = undefined) {
  if (String(env?.ACUVO_HOSTED_PLAYTEST ?? '').trim().toLowerCase() === 'off') return null;
  let account = null;
  try { account = readAccount(env, ...(home === undefined ? [] : [home])); } catch { return null; }
  const token = account?.token?.trim?.() || null;
  const url = token ? renderEndpoint(account.gatewayUrl) : null;
  return url ? { url, token } : null;
}

const HOSTED_DRIVE_TIMEOUT_MS = 150_000;

export async function hostedPlaytest(root, target, spec, { env = process.env, fetchImpl = fetch, home = undefined } = {}) {
  const via = hostedDriveRoute(env, home);
  if (!via) return null;

  let html;
  if (target.kind === 'url') {
    const served = await fetchServedPage(new URL(target.url), { fetchImpl });
    if (!served.ok) return { ok: false, drove: false, error: served.error };
    html = served.html;
  } else {
    let raw;
    try { raw = readFileSync(new URL(target.url), 'utf8'); } catch (e) {
      return { ok: false, drove: false, error: `could not read ${target.path}: ${e?.message ?? e}` };
    }
    html = inlineLocalAssets(root, target.path, raw).html;
  }

  // The hosted drive knows no `hold`; a press is the nearest thing it can do.
  const steps = normaliseSteps(spec?.steps).map((st) => (st.do === 'hold' ? { ...st, do: 'press' } : st));
  const expect = (Array.isArray(spec?.expect) ? spec.expect : []).filter((e) => typeof e === 'string' && e.trim()).slice(0, MAX_EXPECT);
  let res;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HOSTED_DRIVE_TIMEOUT_MS);
    try {
      res = await fetchImpl(via.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${via.token}` },
        body: JSON.stringify({ mode: 'playtest', html, steps, expect, phone: spec?.phone === true }),
        signal: ac.signal,
      });
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, drove: false, error: `the hosted browser did not answer, so the page was NOT tested: ${e?.message ?? e}` };
  }
  const json = await res.json().catch(() => null);
  const r = json?.report;
  // ⚠️ A GATEWAY OLDER THAN `mode: 'playtest'` IGNORES THE MODE AND RENDERS: it answers 200 with a
  // `measurement` and no `report`. Say that, not "HTTP 200" — the CLI can ship before the server does.
  if (res.ok && json?.measurement && !r) {
    return { ok: false, drove: false, error: 'this Acuvo server does not drive pages yet (it can only screenshot them), so the page was NOT driven — use see_page, or give this machine a headless local browser with `acuvo mcp add playwright` (the user runs it once, then approves it)' };
  }
  if (!res.ok || !r || !Array.isArray(r.problems)) {
    const why = json?.error?.message ?? json?.error ?? `HTTP ${res.status}`;
    return { ok: false, drove: false, error: `the hosted browser could not drive the page, so it was NOT tested: ${why}` };
  }

  const problems = [...r.problems];
  const measured = [...(r.measured ?? [])];
  const unmeasured = [...(r.unmeasured ?? [])];
  if (r.frame?.canvas && r.frame.moved === false) {
    problems.push('the canvas picture never changed after the steps — the game did not start, or does not animate');
  }
  if (r.frame?.moved === true) measured.push('the picture changed after the input');
  const actions = Array.isArray(r.steps) ? r.steps.filter((st) => st?.ok).length : 0;
  const loaded = r.drove === true;
  return {
    ok: true, drove: loaded, driver: 'hosted', server: 'acuvo', url: target.url,
    loaded, actions, measured, unmeasured, problems,
    ...(Array.isArray(r.steps) ? { steps: r.steps } : {}),
    ...(r.frame ? { frame: r.frame } : {}),
    summary: verdictLine({ problems, measured, unmeasured, actions, loaded }),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1b. SPEAKING THE ARGUMENTS THIS BUILD OF THE SERVER ACTUALLY DECLARES
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Reshape one call's arguments to the schema the connected server published.
 *
 * Two rules, and each one is a failure that was really measured against
 * `@playwright/mcp` 0.0.79:
 *
 *   1. **DROP what it does not declare.** Both browser schemas are
 *      `additionalProperties: false`, so an obsolete spelling left alongside the
 *      current one is not ignored — it is a hard rejection of the whole call.
 *      This is what lets a driver offer `ref` AND `target` and stay correct on
 *      either build.
 *   2. **FILL what it requires and we did not send.** `browser_console_messages`
 *      grew a required `level` and `browser_network_requests` a required
 *      `static`; both are sent `{}` here and both were rejected. The value comes
 *      from the server's OWN `default` wherever it publishes one, so we are
 *      never inventing behaviour — only saying out loud what it would have
 *      assumed.
 *
 * ⚠️ NO SCHEMA MEANS NO CHANGE. A server that publishes nothing useful (or a
 * fixture that publishes `{type:'object'}`) gets its arguments through
 * untouched — the alternative is guessing, and a silently emptied argument list
 * is how a call fails while looking like the page is broken.
 */
export function adaptArgs(args, schema) {
  const given = args && typeof args === 'object' ? args : {};
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : null;
  if (!props) return { ...given };

  const out = {};
  for (const [k, v] of Object.entries(given)) {
    if (v === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(props, k)) out[k] = v;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (out[key] !== undefined) continue;
    const p = props[key] && typeof props[key] === 'object' ? props[key] : {};
    if (Object.prototype.hasOwnProperty.call(p, 'default')) { out[key] = p.default; continue; }
    /**
     * ⚠️ A LAST RESORT, NOT A GUESS AT INTENT. Reached only when the server
     * marks an argument required and publishes no default; the value is the
     * emptiest legal one for its declared type, so the call is well-formed and
     * the server's own behaviour decides the rest.
     */
    if (Array.isArray(p.enum) && p.enum.length) out[key] = p.enum[0];
    else if (p.type === 'boolean') out[key] = false;
    else if (p.type === 'number' || p.type === 'integer') out[key] = 0;
    else if (p.type === 'array') out[key] = [];
    else if (p.type === 'object') out[key] = {};
    else out[key] = '';
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. READING WHAT A BROWSER SAYS BACK
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The accessibility tree, with the volatile parts removed.
 *
 * ⚠️ REFS ARE STRIPPED BEFORE HASHING, and that is the whole correctness of
 * "did this action change anything". A snapshot ref is an internal id, not
 * content: a page that re-renders identically can hand back different ones, and
 * a digest that included them would report every click as effective — which is
 * precisely the failure this verb exists to catch, inverted.
 */
export function pageText(raw) {
  let s = String(raw ?? '');
  // Playwright answers with "### Ran Playwright code" then "### Page state".
  // Only the state is content; the echoed source changes with every action.
  const marker = /(^|\n)#{0,4}\s*(page snapshot|page state)\s*:?\s*(\n|$)/i.exec(s);
  if (marker) s = s.slice(marker.index + marker[0].length);
  return s
    .replace(/^```.*$/gm, '')
    .replace(/\[ref=[^\]]*\]/g, '')
    .replace(/\buid\s*=\s*[A-Za-z0-9_.:-]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** A stable digest of what the page currently shows. */
export function digestPage(raw) {
  return createHash('sha1').update(pageText(raw)).digest('hex').slice(0, 16);
}

/**
 * Every addressable element in a snapshot: its ref and a human label.
 *
 * ⚠️ THE LABEL IS NOT COSMETIC. Playwright's `browser_click` requires BOTH a
 * ref and an `element` description — the description is what it puts in its own
 * error messages and its permission prompts — so a click assembled without one
 * is refused by the server, not by us.
 */
export function parseSnapshotRefs(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const m = /\[ref=([^\]]+)\]/.exec(line) || /\buid\s*=\s*([A-Za-z0-9_.:-]+)/.exec(line);
    if (!m) continue;
    const label = line
      .replace(/\[ref=[^\]]*\]/g, '')
      .replace(/\buid\s*=\s*[A-Za-z0-9_.:-]+/g, '')
      .replace(/^[\s\-*|]+/, '')
      .trim()
      .slice(0, 80);
    if (!label) continue;
    out.push({ ref: m[1], label, line: line.trim() });
  }
  return out;
}

/**
 * Find the element a step is talking about.
 *
 * ⭐ EXACT ACCESSIBLE NAME FIRST, then substring. "Save" must not silently
 * resolve to "Save and close" while a control literally called "Save" is
 * sitting further down the tree — a playtester that presses the wrong button
 * and reports success is worse than one that presses nothing.
 */
export function findTarget(refs, target) {
  const want = String(target ?? '').trim().toLowerCase();
  if (!want) return null;
  const quoted = refs.find((r) => {
    const m = /"([^"]*)"/.exec(r.label);
    return m && m[1].trim().toLowerCase() === want;
  });
  if (quoted) return quoted;
  return refs.find((r) => r.label.toLowerCase().includes(want)) ?? null;
}

/**
 * Console output, split into the two lines that matter and the noise.
 *
 * ⚠️ AN UNHANDLED REJECTION IS REPORTED SEPARATELY FROM AN ERROR, because they
 * fail differently: an uncaught error usually stops the script it is in, while
 * a rejected promise leaves the page looking perfectly alive with one feature
 * silently dead. A model told only "console error" will look in the wrong
 * place.
 */
export function classifyConsole(text) {
  const errors = [];
  const rejections = [];
  let warnings = 0;
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (/unhandled\s*(promise\s*)?rejection/i.test(s)) { rejections.push(s); continue; }
    if (/^\[?(error|severe)\]?[:\s]/i.test(s) || /\bUncaught\b/.test(s) || /^Error\b/.test(s)) { errors.push(s); continue; }
    if (/^\[?(warn|warning)\]?[:\s]/i.test(s)) warnings += 1;
  }
  return { errors: [...new Set(errors)], rejections: [...new Set(rejections)], warnings };
}

/**
 * Requests that did not come back with something usable.
 *
 * ⚠️ THE STATUS IS TAKEN FROM THE STATUS POSITION, NEVER FROM ANYWHERE IN THE
 * LINE. `GET /api/404-handler => [200] OK` contains "404", and a lazy regex
 * turns a healthy request into the top finding of the report. Tried in order:
 * the `=> [NNN]` form both servers emit, then a bracketed code, then a bare
 * three-digit token that follows the URL.
 *
 * ⭐ A LINE WITH A URL AND NO STATUS AT ALL IS A FINDING IN ITS OWN RIGHT —
 * that is a request that never completed, which is what a wrong port or a dead
 * API looks like from the browser's side.
 */
export function failedRequests(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n').slice(0, 200)) {
    const s = line.trim();
    if (!s) continue;
    const url = /(https?:\/\/[^\s"'<>)]+|\bfile:\/\/[^\s"'<>)]+)/.exec(s);
    if (!url) continue;
    let status = null;
    const arrow = /=>\s*\[?(\d{3})\]?/.exec(s);
    const bracket = /\[(\d{3})\]/.exec(s);
    if (arrow) status = Number(arrow[1]);
    else if (bracket) status = Number(bracket[1]);
    else {
      const after = s.slice(url.index + url[0].length).trim().split(/\s+/);
      const bare = after.find((t) => /^[1-5]\d{2}$/.test(t));
      if (bare) status = Number(bare);
    }
    if (status === null) { out.push({ url: url[0], status: null, line: s }); continue; }
    if (status >= 400) out.push({ url: url[0], status, line: s });
  }
  return out;
}

/**
 * ⚠️ "THE BROWSER IS MISSING" IS NOT "THE PAGE IS BROKEN", and conflating them
 * is the dishonest failure this file is written to avoid. Playwright answers a
 * navigation on a machine with no Chromium by naming the executable it wanted;
 * reporting that as a defect in the user's page would send a model off to fix
 * code that is fine.
 */
export function looksLikeBrowserMissing(err) {
  const s = String(err ?? '');
  return /executable doesn'?t exist|browserType\.launch|playwright install|no browser|chrome could not be found|failed to launch/i.test(s);
}

/**
 * ⚠️ AND NEITHER IS "THE SERVER REFUSED THE PROTOCOL YOU ASKED FOR".
 *
 * Measured 2026-09-01: `@playwright/mcp` 0.0.79 answers a `file://` navigation
 * with *"Access to \"file:\" protocol is blocked"* — its own guardrail, on by
 * default, which its config docs describe as *"a convenience defense to catch
 * unintended file access, not a secure boundary"*. `resolveTarget` accepts a
 * workspace path and the tool description advertises `dist/index.html`, so half
 * of this verb's documented surface dies there on that one server.
 *
 * ⭐ Reported as OUR configuration problem with the two commands that fix it,
 * not as a defect in the user's page — the same distinction `looksLikeBrowserMissing`
 * draws. `chrome-devtools-mcp` opens the same file with no flag at all, which is
 * why it is named first: it is the catalogue's preferred browser anyway.
 */
export function looksLikeFileProtocolBlocked(err) {
  return /access to "?file:"? protocol is blocked/i.test(String(err ?? ''));
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE REPORT
 * ──────────────────────────────────────────────────────────────────────────── */

const cut = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROBLEM_CHARS);

/**
 * Order the findings by what actually breaks a page, then bound them.
 *
 * ⚠️ THE ORDER IS THE PRODUCT. `see_page`'s `findingsFrom` learned this: a
 * console error that stopped the app booting explains every finding underneath
 * it, and a model that spends its round on the fifth item has wasted the round.
 * So: the page did not load · it threw · a request failed · something never
 * appeared · an action did nothing.
 */
export function buildReport(parts) {
  const {
    loaded = true, navError = null, console: con = { errors: [], rejections: [], warnings: 0 },
    network = [], missing = [], inert = [], stepErrors = [], phoneMissing = [],
  } = parts ?? {};

  const problems = [];
  if (!loaded) problems.push(cut(`the page did not load: ${navError}`));
  for (const e of con.errors.slice(0, 5)) problems.push(cut(`console error: ${e}`));
  for (const r of con.rejections.slice(0, 3)) problems.push(cut(`unhandled promise rejection: ${r}`));
  for (const r of network.slice(0, 5)) {
    problems.push(cut(r.status === null
      ? `request never completed: ${r.url}`
      : `request failed HTTP ${r.status}: ${r.url}`));
  }
  for (const m of missing.slice(0, 5)) problems.push(cut(`never appeared on the page: "${m}"`));
  for (const s of stepErrors.slice(0, 5)) problems.push(cut(s));
  for (const s of inert.slice(0, 5)) problems.push(cut(s));
  for (const m of phoneMissing.slice(0, 3)) problems.push(cut(`present at desktop width but gone at 390px: "${m}"`));
  return problems.slice(0, MAX_PROBLEMS);
}

/**
 * ⭐ ONE SENTENCE THAT CANNOT BE READ AS MORE THAN IT IS. "No problems found"
 * on its own is the `looked: true` bug in prose — it sounds like a full pass
 * when the network log may never have been readable. So the sentence always
 * names what was measured, and names what was not.
 */
export function verdictLine({ problems, measured, unmeasured, actions, loaded }) {
  const head = !loaded
    ? 'the page never loaded, so nothing below it was checked'
    : problems.length === 0
      ? `no problems found in ${measured.join(', ') || 'nothing'}`
      : `${problems.length} problem${problems.length === 1 ? '' : 's'} found`;
  const acted = actions > 0 ? `; ${actions} action${actions === 1 ? '' : 's'} driven` : '';
  const gap = unmeasured.length ? `; NOT checked: ${unmeasured.join(', ')}` : '';
  return `${head}${acted}${gap}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE DRIVE
 * ──────────────────────────────────────────────────────────────────────────── */

/** Where to point the browser. Loopback URL, or a page in the workspace. */
export function resolveTarget(root, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'playtest needs a url — a loopback address like http://localhost:3000, or a workspace path like "dist/index.html"' };
  const asUrl = loopbackTarget(s);
  if (asUrl.isUrl) {
    if (!asUrl.ok) {
      return {
        ok: false,
        error: `playtest drives LOOPBACK urls (localhost / 127.x) and files in this workspace only — "${s.slice(0, 80)}" is neither. `
          + 'Start the site with start_process and playtest the local address, or pass the built file path.',
      };
    }
    return { ok: true, url: asUrl.url.href, kind: 'url' };
  }
  const target = resolveInWorkspace(root, s, 'read');
  if (!target.ok) return { ok: false, error: target.reason };
  return { ok: true, url: pathToFileURL(target.absolute).href, kind: 'file', path: target.relative };
}

/** Normalise and bound what the model asked for. */
export function normaliseSteps(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const steps = [];
  for (const s of list.slice(0, MAX_STEPS)) {
    const act = String(s?.do ?? s?.action ?? '').trim().toLowerCase();
    if (!['click', 'type', 'press', 'hold', 'wait'].includes(act)) continue;
    steps.push({ do: act, target: String(s?.target ?? '').trim(), text: String(s?.text ?? '') });
  }
  return steps;
}

/**
 * Run the whole check and return the report.
 *
 * ⚠️ EVERY OUTWARD CALL IS INJECTABLE — the config read, the connect, the tool
 * call. Not for tidiness: the only other way to test this file is to launch a
 * real browser, which means in practice it would not be tested, and the two
 * things being pinned here (that a refusal never claims to have tested, and
 * that the report is ordered and bounded) are exactly the ones a manual check
 * would wave through.
 */
export async function playtest(root, spec = {}, {
  env = process.env,
  dryRun = false,
  configImpl = readMcpConfig,
  connectImpl = connectServer,
  callImpl = callMcpTool,
  closeImpl = closeConnections,
  trustImpl = loadTrust,
  now = () => Date.now(),
  maxRunMs = MAX_RUN_MS,
  fetchImpl = fetch,
  home = undefined,
  serveImpl = serveWorkspace,
} = {}) {
  const target = resolveTarget(root, spec?.url);
  if (!target.ok) return { ok: false, drove: false, error: target.error };

  /**
   * ⚠️ A DRY RUN STARTS NOTHING. `--dry-run` promises "touch nothing, run
   * nothing", and this spawns a program and opens a browser. `transcribe`
   * already had to learn that gating only the write while still making the call
   * turns the flag from a weak guarantee into a false one.
   */
  if (dryRun) {
    return { ok: false, drove: false, error: 'this is a --dry-run, so no browser was started and the page was NOT tested' };
  }

  let cfg;
  try { cfg = configImpl(root); } catch (e) { cfg = { ok: false, error: e?.message ?? String(e) }; }
  const server = cfg?.ok ? chooseBrowserServer(cfg.servers, env) : null;
  /**
   * ⭐ NO LOCAL BROWSER → THE ACCOUNT'S HOSTED DRIVE, the way `see_page` already
   * works out of the box. See `hostedPlaytest`. Only when that is unavailable too
   * does the run get the old "configure a browser" sentence.
   */
  if (!server) {
    const hosted = await hostedPlaytest(root, target, spec, { env, fetchImpl, home });
    if (hosted) return hosted;
  }
  if (!cfg?.ok) return { ok: false, drove: false, error: `the MCP config is unusable, so no browser could be started: ${failureReason(cfg)}` };
  if (!server) {
    return {
      ok: false,
      drove: false,
      error: 'no browser is configured on this machine, so the page was NOT tested. '
        + 'Run `acuvo mcp add browser` (drives the Chrome already installed) or `acuvo mcp add playwright`, '
        + `then try again. A server under another name works too — set ${BROWSER_SERVER_ENV} to its name.`,
    };
  }

  /**
   * ⚠️ THE SAME CONSENT THE TURN LOOP REQUIRES, CHECKED AGAINST THE SAME
   * FINGERPRINT. See this file's header: a second door into `connectServer`
   * that skipped it would restore the RCE that `mcp-consent.mjs` exists to
   * close. It never ASKS — a tool result is not a consent screen — so the
   * honest outcome is a refusal naming the one command that fixes it.
   */
  const trusted = String(env?.[TRUST_ENV] ?? '').trim()
    ? true
    : isTrusted(fingerprint(cfg.servers), trustImpl({ env }));
  if (!trusted) {
    return {
      ok: false,
      drove: false,
      error: `the "${server.name}" browser server is configured but nobody has approved starting it, so the page was NOT tested. `
        + 'Start acuvo interactively once and approve the MCP servers when it asks.',
    };
  }

  const conn = await connectImpl(server, { root, env });
  if (!conn?.ok) {
    return { ok: false, drove: false, error: `the "${server.name}" browser server would not start, so the page was NOT tested: ${failureReason(conn)}` };
  }

  try {
    const have = new Set((conn.tools ?? []).map((t) => t?.name).filter(Boolean));
    const driver = DRIVERS.find((d) => d.requires.every((n) => have.has(n)));
    if (!driver) {
      return {
        ok: false,
        drove: false,
        error: `the "${server.name}" server is connected but does not speak a browser protocol this understands `
          + `(it offers: ${[...have].slice(0, 8).join(', ') || 'nothing'}), so the page was NOT tested`,
      };
    }
    /**
     * ⭐ A WORKSPACE FILE IS SERVED OVER LOOPBACK FOR THE DRIVE — see
     * serve-workspace.mjs. file:// is refused by @playwright/mcp by default and
     * breaks modules and fetch() everywhere. If the server cannot start, the
     * old file:// URL is used and the old refusal still explains it.
     */
    let served = null;
    let driveTarget = target;
    if (target.kind === 'file' && target.path) {
      try {
        served = await serveImpl(root);
        driveTarget = { ...target, url: served.urlFor(target.path) };
      } catch { served = null; }
    }
    try {
      return await drive(conn, driver, driveTarget, spec, { callImpl, now, maxRunMs, serverName: server.name });
    } finally {
      try { await served?.close(); } catch { /* already closed */ }
    }
  } finally {
    // ⚠️ ALWAYS. A stdio MCP server is a child process; leaving one running
    // leaves a browser running, and `child-lifetime.mjs` records what an
    // un-closed child does to the exit of the session.
    try { closeImpl([conn]); } catch { /* already gone */ }
  }
}

/**
 * ── ⭐⭐ A CANVAS GAME IS JUDGED BY ITS PICTURE, NOT ITS ACCESSIBILITY TREE ───
 *
 * Found by driving a real Breakout build (2026-09-27) through a local
 * @playwright/mcp: every key press was reported "changed nothing on the page",
 * because the page IS one <canvas> and its accessibility tree never changes
 * while the game runs. The hosted drive already reports whether the canvas
 * picture MOVED (`r.frame`, above); the local drive had no equivalent, so a
 * working game read as dead. This is that probe for a local driver: the
 * largest canvas is hashed after two animation frames, before and after each
 * step. ⚠️ A WebGL canvas without preserveDrawingBuffer reads back blank, so
 * its hash never moves — then the probe says "unmeasured" rather than "dead".
 */
export const CANVAS_PROBE = "async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); "
  + "const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; "
  + "if (!c) return 'canvas:none'; let d; try { d = c.toDataURL(); } catch (e) { return 'canvas:tainted'; } "
  + "if (c.getContext && !c.getContext('2d')) return 'canvas:webgl'; "
  + "let h = 0; for (let i = 0; i < d.length; i += 3) h = (h * 31 + d.charCodeAt(i)) | 0; return 'canvas:' + h; }";

/**
 * ⭐ `hold` — found on the same drive. A game that moves on HELD keys (the
 * shape the game-prototype skill teaches) ignores `press`: keydown and keyup
 * land inside one frame, so the paddle never moves and the step reads as dead.
 * A human holds the key. This dispatches keydown, waits, then keyup, from the
 * focused element so it bubbles to document and window listeners alike.
 */
export const HOLD_MS = 400;
export function holdKeyScript(key, ms = HOLD_MS) {
  const k = JSON.stringify(String(key).slice(0, 20));
  const code = JSON.stringify(/^[a-z]$/i.test(String(key)) ? `Key${String(key).toUpperCase()}` : String(key) === ' ' ? 'Space' : String(key));
  const wait = Math.max(50, Math.min(3000, Number(ms) || HOLD_MS));
  return `async () => { const t = document.activeElement || document.body; const o = { key: ${k}, code: ${code}, bubbles: true, cancelable: true }; `
    + `t.dispatchEvent(new KeyboardEvent('keydown', o)); await new Promise((r) => setTimeout(r, ${wait})); `
    + `t.dispatchEvent(new KeyboardEvent('keyup', o)); return 'held'; }`;
}

export function readCanvasProbe(text) {
  const m = /canvas:(none|tainted|webgl|-?\d+)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

async function drive(conn, driver, target, spec, { callImpl, now, maxRunMs, serverName }) {
  const started = now();
  const overBudget = () => now() - started > maxRunMs;
  const has = new Set((conn.tools ?? []).map((t) => t?.name).filter(Boolean));
  /**
   * ⭐ THE SCHEMAS AS THIS BUILD PUBLISHED THEM, read once. `adaptArgs` needs
   * them per call and re-scanning the tool list each time would be the same
   * lookup thirty times in one drive.
   */
  const schemaOf = new Map((conn.tools ?? []).filter((t) => t?.name).map((t) => [t.name, t.inputSchema]));
  const call = async (pair) => {
    const [tool, rawArgs] = pair;
    if (!has.has(tool)) return { ok: false, error: `the ${serverName} server has no "${tool}"` };
    const args = adaptArgs(rawArgs, schemaOf.get(tool));
    /**
     * ⚠️ `namespacedName` IS IMPORTED, NEVER RETYPED. The prefix is a safety
     * property (see mcp.mjs) and `callMcpTool` parses it back off with a regex;
     * a hand-built string here is the copy that stops matching the day the
     * separator changes.
     */
    return callImpl([conn], namespacedName(conn.name, tool), args);
  };

  const measured = ['the page loads'];
  const unmeasured = [];

  // ── 1. Load it.
  const nav = await call(driver.navigate(target.url));
  if (!nav.ok) {
    if (looksLikeBrowserMissing(nav.error)) {
      return { ok: false, drove: false, error: `the ${serverName} server has no browser to drive, so the page was NOT tested: ${cut(nav.error)}` };
    }
    if (looksLikeFileProtocolBlocked(nav.error)) {
      return {
        ok: false,
        drove: false,
        error: `the "${serverName}" server blocks file:// URLs by default, so the workspace file was NOT tested. `
          + 'Run `acuvo mcp add browser` (chrome-devtools-mcp opens workspace files with no extra flag), '
          + 'or add `--allow-unrestricted-file-access` to this server\'s args, '
          + 'or serve the folder with start_process and playtest the http://localhost URL instead.',
      };
    }
    const problems = buildReport({ loaded: false, navError: nav.error });
    return {
      ok: true, drove: true, driver: driver.id, server: serverName, url: target.url,
      loaded: false, actions: 0, measured, unmeasured, problems,
      summary: verdictLine({ problems, measured, unmeasured, actions: 0, loaded: false }),
    };
  }

  // ── 2. What is on it. The navigate reply usually already carries a snapshot;
  //       asking for one explicitly is cheap and makes the shape uniform.
  let snap = await call(driver.snapshot());
  let view = snap.ok ? snap.text : nav.text;
  if (snap.ok || nav.text) measured.push('the accessibility tree');
  else unmeasured.push('the page structure');

  // ── 3. Drive it.
  const steps = normaliseSteps(spec?.steps);
  const stepErrors = [];
  const inert = [];
  const missing = [];
  let actions = 0;
  const has2 = new Set((conn.tools ?? []).map((t) => t?.name).filter(Boolean));
  const canEval = typeof driver.evaluate === 'function' && has2.has(driver.evaluate('')[0]);
  const frame = { canvas: false, moved: false, readable: true };
  /** A comparable hash of the main canvas, or null when there is none / it cannot be read. */
  const canvasHash = async () => {
    if (!canEval || !steps.length) return null;
    const r = await call(driver.evaluate(CANVAS_PROBE));
    const v = r.ok ? readCanvasProbe(r.text) : null;
    if (v === null || v === 'none') return null;
    frame.canvas = true;
    if (v === 'tainted' || v === 'webgl') { frame.readable = false; return null; }
    return v;
  };

  for (let i = 0; i < steps.length; i++) {
    if (overBudget()) { stepErrors.push(`stopped after ${actions} of ${steps.length} actions — the ${Math.round(maxRunMs / 1000)}s budget ran out`); break; }
    const step = steps[i];
    const before = digestPage(view);
    const canvasBefore = await canvasHash();
    let res;

    if (step.do === 'press') {
      res = await call(driver.press(step.text || 'Enter'));
    } else if (step.do === 'hold') {
      res = canEval
        ? await call(driver.evaluate(holdKeyScript(step.text || 'ArrowRight', HOLD_MS)))
        : await call(driver.press(step.text || 'ArrowRight'));
    } else if (step.do === 'wait') {
      res = await call(driver.waitFor(step.text));
    } else {
      const el = findTarget(parseSnapshotRefs(view), step.target);
      if (!el) {
        missing.push(step.target);
        stepErrors.push(`step ${i + 1} (${step.do} "${step.target}") could not run — nothing on the page matches that name`);
        continue;
      }
      res = step.do === 'click' ? await call(driver.click(el)) : await call(driver.type(el, step.text));
    }

    if (!res.ok) { stepErrors.push(`step ${i + 1} (${step.do}${step.target ? ` "${step.target}"` : ''}) failed: ${res.error}`); continue; }
    actions += 1;

    const after = await call(driver.snapshot());
    if (after.ok) view = after.text;
    else if (res.text) view = res.text;
    /**
     * ⭐ THE FINDING NOBODY ELSE PRODUCES. A button that is present, enabled,
     * pressable and wired to nothing looks perfect in a screenshot and perfect
     * in an accessibility tree. The only way to see it is to press it and
     * notice that the page is byte-for-byte what it was.
     *
     * ⚠️ Stated as an observation, not a verdict — a click on a link that
     * re-renders the same content is legitimately inert, and the model has the
     * source and can tell which it is.
     */
    const canvasAfter = await canvasHash();
    const canvasMoved = canvasBefore !== null && canvasAfter !== null && canvasBefore !== canvasAfter;
    if (canvasMoved) frame.moved = true;
    if (digestPage(view) === before && !canvasMoved) {
      inert.push(`step ${i + 1} (${step.do}${step.target ? ` "${step.target}"` : ''}) changed nothing on the page`);
    }
  }
  if (steps.length) measured.push('the actions you asked for');
  if (frame.canvas && frame.readable && actions > 0) {
    measured.push('the canvas picture');
    if (!frame.moved) stepErrors.push('the canvas picture never changed after the steps — the game did not start, or does not respond to input');
  } else if (frame.canvas && !frame.readable) {
    unmeasured.push('the canvas picture (WebGL or cross-origin — it cannot be read back)');
  }

  // ── 4. What should be there.
  const expect = (Array.isArray(spec?.expect) ? spec.expect : []).map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, MAX_EXPECT);
  const seen = pageText(view).toLowerCase();
  for (const want of expect) if (!seen.includes(want.toLowerCase())) missing.push(want);
  if (expect.length) measured.push('the text you expected');

  // ── 5. Phone width. Most generated layouts break here and nowhere else.
  const phoneMissing = [];
  if (spec?.phone === true && !overBudget()) {
    const r = await call(driver.resize(390, 844));
    const s2 = r.ok ? await call(driver.snapshot()) : { ok: false };
    if (s2.ok) {
      const small = pageText(s2.text).toLowerCase();
      for (const want of expect) if (seen.includes(want.toLowerCase()) && !small.includes(want.toLowerCase())) phoneMissing.push(want);
      measured.push('390px phone width');
      view = s2.text;
    } else {
      unmeasured.push('390px phone width');
    }
  }

  // ── 6. What the browser itself has to say. Read LAST, because both logs are
  //       cumulative — one read covers the load and every action after it.
  const conRes = await call(driver.consoleMessages());
  const con = conRes.ok ? classifyConsole(conRes.text) : { errors: [], rejections: [], warnings: 0 };
  if (conRes.ok) measured.push('the console'); else unmeasured.push('the console');

  const netRes = await call(driver.network());
  const network = netRes.ok ? failedRequests(netRes.text) : [];
  if (netRes.ok) measured.push('network requests'); else unmeasured.push('network requests');

  const problems = buildReport({
    loaded: true, console: con, network, missing: [...new Set(missing)], inert, stepErrors, phoneMissing,
  });

  return {
    ok: true,
    drove: true,
    driver: driver.id,
    server: serverName,
    url: target.url,
    loaded: true,
    actions,
    measured,
    unmeasured,
    warnings: con.warnings,
    problems,
    summary: verdictLine({ problems, measured, unmeasured, actions, loaded: true }),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. REGISTRATION
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE DESCRIPTION IS THE CHEAPEST DOCUMENTATION IN THE SYSTEM, and it has to
 * state the boundary out loud — a model that does not know the loopback rule
 * spends one round discovering it and a second arguing with the refusal.
 */
export function playtestToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'playtest',
        description: [
          'Open a page in a real browser, DRIVE it, and get back a short ordered list of what is broken —',
          'console errors, unhandled promise rejections, requests that 404 or never complete, text that never',
          'appeared, and controls that do nothing when pressed. Use it after building or changing any page,',
          'BEFORE saying it works: this is the only check that catches a button which is present, enabled and',
          'wired to nothing.',
          'It returns findings, never a screenshot or a DOM dump.',
          'IT REACHES LOOPBACK ADDRESSES AND WORKSPACE FILES ONLY: start the site with start_process and pass',
          'http://localhost:PORT, or pass a built file like "dist/index.html". Public URLs are refused.',
          'If no browser is configured it says so and tests nothing — it never pretends.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'A loopback URL ("http://localhost:3000/pricing") or a workspace-relative HTML file ("dist/index.html").',
            },
            steps: {
              type: 'array',
              description: `What to do on the page, in order (max ${MAX_STEPS}). Press the PRIMARY action — a demo that dies does so here.`,
              items: {
                type: 'object',
                properties: {
                  do: { type: 'string', enum: ['click', 'type', 'press', 'hold', 'wait'], description: 'The action. "hold" keeps a key down ~0.4s — for games that move on held keys.' },
                  target: { type: 'string', description: 'The visible name of the control, e.g. "Add to cart". Matched against the accessibility tree.' },
                  text: { type: 'string', description: 'For "type", the text to enter. For "press", the key ("Enter"). For "wait", text to wait for.' },
                },
                required: ['do'],
              },
            },
            expect: {
              type: 'array',
              description: `Text that must be visible after the steps (max ${MAX_EXPECT}). Anything absent is reported as never having appeared.`,
              items: { type: 'string' },
            },
            phone: { type: 'boolean', description: 'Also re-check at 390x844. Most generated layouts break here and nowhere else.' },
          },
          required: ['url'],
        },
      },
    },
  ];
}

/** Dispatch. Mirrors the shape every other tool module in this package uses. */
export async function runPlaytestTool(name, args = {}, { executor, env = process.env } = {}) {
  if (name !== 'playtest') return { ok: false, error: `unknown playtest tool "${name}"` };
  return playtest(executor?.root, args, { env, dryRun: executor?.dryRun === true });
}
