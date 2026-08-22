/**
 * ── ⭐⭐ THE DOCTOR — ONE COMMAND THAT SAYS WHAT IS ACTUALLY WORKING ─────────
 *
 * ⚠️ THIS FILE IS PAID FOR BY A MEASURED HOUR. Four media tools were silently
 * dark because ONE undocumented environment variable (`MODAL_VIDEO_SECRET`) was
 * missing. The error the agent saw was *"the speech service returned no audio"*
 * — which reads TRANSIENT, so it retried four times and burned six rounds on a
 * call that could never have succeeded. An hour went into diagnosing a
 * thirty-second question.
 *
 * ── ⚠️⚠️ THE ONE RULE THIS FILE EXISTS TO ENFORCE: A 200 IS NOT HEALTH ──────
 *
 * MEASURED LIVE, 2026-08-11, against all four Modal endpoints:
 *
 *     POST {}          -> 200 {"ok":false,"error":"unauthorised"}
 *     POST {secret}    -> 200 {"ok":false,"error":"empty text"}
 *
 * Both are HTTP 200. The FIRST is a dead capability; the SECOND is a healthy
 * service complaining about a deliberately-empty payload — which is exactly
 * the proof we want, because a payload complaint can only be reached AFTER the
 * credential was accepted. So the health probe here sends the secret and NO
 * payload: it costs no GPU-seconds, it returns in ~300ms, and it distinguishes
 * "your key is wrong" from "your request was wrong". Believing the 200 is
 * precisely the bug that cost the hour.
 *
 * ── ⭐ THE OUTPUT IS THE PRODUCT ────────────────────────────────────────────
 * Three states, and nothing else:
 *
 *   live    it is configured AND something proved it works
 *   dark    it is switched off / not configured — nothing is wrong, but the
 *           capability is not there and the model will never be offered it
 *   broken  it is configured and it DOES NOT WORK
 *
 * ⚠️ AND EVERY dark OR broken LINE NAMES THE EXACT VARIABLE OR ACTION. A
 * diagnostic that says "TTS: unavailable" has done nothing — the reader is
 * exactly where they started. "TTS: dark — MODAL_TTS_URL unset" ends the
 * investigation in one line. The word "unavailable" is banned here and a test
 * pins that.
 *
 * ── ⚠️ THE FOURTH THING THAT IS NOT A STATE: `verified` ─────────────────────
 * A machine with no network is NOT a broken machine, and a doctor that paints
 * an offline laptop red is a check that fails correct work — the failure mode
 * this repo has now been bitten by six times. So when every single probe fails
 * at the TRANSPORT layer (no HTTP status ever arrived), the endpoints keep the
 * state their configuration earns and carry `verified: false` plus the words
 * "could not check". One host down while the others answer is a different
 * story and IS reported broken, because then we have proof.
 *
 * ── ⚠️⚠️ NEVER PRINT A SECRET. NOT A PREFIX, NOT A SUFFIX, NOT A LENGTH ─────
 * The temptation is real and there is a specific trap: OpenRouter's own
 * `GET /api/v1/key` answers with `{"data":{"label":"sk-or-v1-abc...xyz"}}` —
 * a prefix AND a suffix of a live credential, handed to us by the service we
 * are checking. Reading that field would leak a key into terminal scrollback,
 * CI logs and every pasted bug report. So: this file reports "present" or
 * "absent", it reads `label` from nothing, and `scrubSecrets` runs over the
 * WHOLE report on the way out as a second line of defence.
 *
 * ── ⚠️ IT MUST NEVER HANG ───────────────────────────────────────────────────
 * Every probe is bounded twice — an `AbortSignal.timeout` for the real network
 * and a `withTimeout` race for a `fetchImpl` that ignores signals — and they
 * all run concurrently. A diagnostic you have to wait thirty seconds for is one
 * people stop running.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────
 * Everything that decides anything is a pure function of data: `assessProbe`,
 * `isOffline`, `checkNodeVersion`, `gitignoreCoversAcuvo`, `scrubSecrets`,
 * `summarise`, `formatDoctor`. `runDoctor` is the only edge, and it takes its
 * clock, its fetch, its git and its filesystem as arguments.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readMcpConfig, MCP_CONFIG_FILES, MAX_SERVERS } from './mcp.mjs';
import { CATALOGUE, assessCatalogue, packageOf, STARTER_CONFIG_FILE } from './mcp-defaults.mjs';
import { readModelConfig, DEFAULT_MODEL } from './model.mjs';
import { buildChain } from './chain.mjs';
import { mediaConfig, MEDIA_SECRET_ENV_NAMES } from './media.mjs';
import { editConfig } from './image-edit.mjs';
import { imageConfig, engineConfig, generateEndpoint, IMAGE_URL_ENV, IMAGE_TOKEN_ENV, ENGINE_SECRET_ENV } from './imagegen.mjs';
import { resolveCommandAllowlist, COMMANDS_CONFIG_FILE, ALLOW_COMMANDS_ENV, PRESET_NAMES } from './command.mjs';
import { TOOL_NAMES, toolNamesForRounds, languagesPresent } from './tools.mjs';
import { LANGUAGE_SERVERS } from './lsp.mjs';
import { gitStatus as realGitStatus, ALLOW_PUSH_ENV, PROTECTED_BRANCHES } from './git.mjs';

/** ⚠️ THREE. Adding a fourth is how "unknown" becomes a place to hide. */
export const DOCTOR_STATES = ['live', 'dark', 'broken'];

/**
 * The credentials this package reads. Used only to know what to SCRUB — the
 * values are never rendered, compared against the output, or counted.
 */
export const SECRET_ENV_VARS = [
  'OPENROUTER_API_KEY',
  'MODAL_VIDEO_SECRET',
  IMAGE_TOKEN_ENV,
  'GITHUB_TOKEN',
  'GH_TOKEN',
];

/** OpenRouter's free, tokenless endpoints. A model call would cost money and prove less. */
const OR_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OR_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** The directory the CLI writes sessions and audit logs into, inside the USER's repo. */
const ACUVO_DIR = '.acuvo';

// ───────────────────────────────────────────────────────────────────────────
// PURE: TIME AND VERSIONS
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bound a promise without leaking a timer.
 *
 * ⚠️ `clearTimeout` IS THE POINT, not the race. A doctor that finished in 400ms
 * and then held the process open for the remaining ten seconds of every probe
 * timeout would look like a hang to the only observer who matters — the person
 * waiting for their shell prompt back.
 *
 * ⚠️ AND IT IS NEEDED EVEN THOUGH EVERY REQUEST CARRIES AN AbortSignal. A
 * `fetchImpl` handed in by a caller (or a test) is under no obligation to
 * honour the signal, and "we trusted the injected dependency" is not a bound.
 *
 * ⚠️⚠️ THE TIMER IS DELIBERATELY **NOT** unref'd, and the first draft got this
 * backwards. An unref'd alarm does not hold the event loop open, so when the
 * thing being bounded is a promise that never settles — precisely the case this
 * function exists for — the loop drains and the await never returns. Node's own
 * test runner names it exactly: *"Promise resolution is still pending but the
 * event loop has already resolved"*. The leak this was meant to avoid is
 * handled by `clearTimeout` in the `finally`, which runs on every path.
 */
export function withTimeout(promise, ms, fallback) {
  let timer = null;
  const alarm = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, alarm]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * The minimum major version an `engines` range asks for.
 *
 * ⚠️ DELIBERATELY NOT A SEMVER IMPLEMENTATION. This package has zero
 * dependencies forever, and the question is small: what is the lowest major
 * that satisfies this string. `>=20`, `>=20.0.0`, `^22.0.0` and `22.x` are the
 * shapes a package.json really carries.
 *
 * ⭐ RETURNS null RATHER THAN GUESSING. `*`, `latest`, an absent field and
 * anything unparseable all mean "we do not know", and a doctor that invents a
 * requirement will fail a machine that is completely fine.
 */
export function parseEnginesRange(spec) {
  if (typeof spec !== 'string') return null;
  const m = /(\d+)/.exec(spec);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * ⚠️ AN UNPARSEABLE VERSION IS NOT A FAILING VERSION. Node is obviously running
 * — it is running this code — so the worst honest answer is "we could not
 * compare", never "your runtime is broken".
 */
export function checkNodeVersion(version, enginesSpec) {
  const min = parseEnginesRange(enginesSpec);
  const running = /v?(\d+)/.exec(String(version ?? ''));
  const major = running ? Number(running[1]) : null;

  if (min === null) {
    return {
      id: 'runtime.node',
      label: 'node',
      state: 'live',
      verified: true,
      detail: `${version} — no engines range to compare against`,
      fix: null,
    };
  }
  if (major === null) {
    return {
      id: 'runtime.node',
      label: 'node',
      state: 'live',
      verified: false,
      detail: `could not read a major version out of "${version}"; engines asks for >=${min}`,
      fix: null,
    };
  }
  if (major < min) {
    return {
      id: 'runtime.node',
      label: 'node',
      state: 'broken',
      verified: true,
      detail: `${version} is below the engines floor of >=${min}`,
      fix: `upgrade Node to ${min} or newer — https://nodejs.org (this package uses Node ${min}+ built-ins and has no dependencies to fall back on)`,
    };
  }
  return {
    id: 'runtime.node',
    label: 'node',
    state: 'live',
    verified: true,
    detail: `${version} satisfies engines >=${min}`,
    fix: null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// PURE: PROBE VERDICTS
// ───────────────────────────────────────────────────────────────────────────

/**
 * True only when EVERY network probe failed before an HTTP status arrived.
 *
 * ⚠️ A REFUSAL OR A 404 PROVES THE NETWORK WORKS, so one of those anywhere in
 * the set means this machine is online and a dead host is genuinely dead. The
 * distinction is the whole reason an offline laptop does not light up red.
 */
export function isOffline(probes) {
  const seen = (probes ?? []).filter(Boolean);
  if (seen.length === 0) return false;
  return seen.every((p) => p.kind === 'unreachable');
}

/**
 * Turn one probe result into a check verdict.
 *
 * kinds:
 *   ok           the service answered and the credential was accepted
 *   refused      the service answered and rejected the credential (often HTTP 200!)
 *   http         the service answered with a status or body we cannot call healthy
 *   unreachable  no HTTP status ever arrived
 *   unchecked    we deliberately did not probe (no fetch, or no health route)
 */
export function assessProbe(probe, { envVar, secretVar = 'MODAL_VIDEO_SECRET', offline = false, host = null } = {}) {
  const where = host ? ` (${host})` : '';
  switch (probe?.kind) {
    case 'ok':
      return { state: 'live', verified: true, detail: `configured${where} · reachable and authorised${probe.detail ? ` — ${probe.detail}` : ''}`, fix: null };

    /**
     * ⭐⭐ THE LINE THAT PAYS FOR THE FILE. The service said 200 and it said no.
     * The fix is a credential, and NOTHING about it is transient — so the
     * message must not read like something worth retrying.
     */
    case 'refused':
      return {
        state: 'broken',
        verified: true,
        detail: `configured${where} · the service REFUSED the credential — ${probe.detail || 'unauthorised'} (it answered HTTP 200; a 200 is not proof of health)`,
        fix: `set ${secretVar} to the value this endpoint expects — retrying will not help`,
      };

    case 'http':
      return {
        state: 'broken',
        verified: true,
        detail: `configured${where} · ${probe.detail || 'the service answered with an error'}`,
        fix: `check ${envVar} points at the right service, and that the service is deployed`,
      };

    case 'unreachable':
      if (offline) {
        return {
          state: 'live',
          verified: false,
          detail: `configured${where} · could not check — nothing on this machine reached the network`,
          fix: `reconnect and re-run the doctor to verify ${envVar}`,
        };
      }
      return {
        state: 'broken',
        verified: true,
        detail: `configured${where} · unreachable while other services answered — ${probe.detail || 'no response'}`,
        fix: `check ${envVar} — the host may be wrong, or the service scaled to zero and failed to start`,
      };

    case 'unchecked':
    default:
      return {
        state: 'live',
        verified: false,
        detail: `configured${where} · ${probe?.detail || 'not checked'}`,
        fix: null,
      };
  }
}

/** Count the states, and count separately how much of the green was never proved. */
export function summarise(checks) {
  const out = { live: 0, dark: 0, broken: 0, unverified: 0 };
  for (const c of checks ?? []) {
    if (out[c.state] !== undefined) out[c.state] += 1;
    if (c.verified === false) out.unverified += 1;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// PURE: THE WORKSPACE
// ───────────────────────────────────────────────────────────────────────────

/**
 * Does this .gitignore body keep `.acuvo/` out of the user's repository?
 *
 * ⚠️ THIS MATTERS BECAUSE WE WRITE INTO SOMEBODY ELSE'S REPO. Sessions, audit
 * logs and generated screenshots land in `.acuvo/`, and an un-ignored `.acuvo/`
 * turns every `git status` into noise and every `git add -A` into a commit of
 * our transcripts — which can contain the user's own prompts.
 *
 * ⚠️ A LATER `!.acuvo/` WINS, exactly as git resolves it. Reporting "ignored"
 * for a file git will happily commit is the false all-clear this repo keeps
 * relearning, so the last matching rule decides.
 */
export function gitignoreCoversAcuvo(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  let covered = false;
  // A BOM in front of the first pattern makes it match nothing — strip it.
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = (negated ? line.slice(1) : line).replace(/^\/+/, '').replace(/\/+$/, '');
    // `.acuvo`, `.acuvo/`, `/.acuvo/` and `.acuvo/**` all cover the directory.
    // `.acuvo/skills` covers only a child, and `.acuvo.md` is a different name.
    if (pattern === ACUVO_DIR || pattern === `${ACUVO_DIR}/**` || pattern === `${ACUVO_DIR}/*`) {
      covered = !negated;
    }
  }
  return covered;
}

// ───────────────────────────────────────────────────────────────────────────
// PURE: SECRETS
// ───────────────────────────────────────────────────────────────────────────

const REDACTED = '<redacted>';

/**
 * ⚠️ TWO MECHANISMS, BECAUSE ONE IS NOT ENOUGH.
 *
 *   1. VALUE MATCHING catches a credential we ourselves put in a string.
 *   2. SHAPE MATCHING catches one we never held — specifically OpenRouter's
 *      `label` field, `sk-or-v1-abc...xyz`, which is NOT a substring of the key
 *      and which a value-only scrub sails straight past. It is still a prefix
 *      and a suffix of a live credential.
 *
 * ⚠️ AN EMPTY OR WHITESPACE ENV VALUE IS NEVER A PATTERN. `''` as a search
 * string replaces between every character; a doctor that redacted every
 * character of its own report would be a very thorough kind of useless.
 */
export function scrubSecrets(value, env = {}, names = SECRET_ENV_VARS) {
  const literals = [];
  for (const name of names) {
    const v = env?.[name];
    if (typeof v === 'string' && v.trim().length >= 8) literals.push(v.trim());
  }
  // Longest first, so a key that contains another value is not half-replaced.
  literals.sort((a, b) => b.length - a.length);

  const scrubString = (s) => {
    let out = s;
    for (const lit of literals) out = out.split(lit).join(REDACTED);
    return out
      // Whole credential-bearing header lines, value and all.
      .replace(/^[ \t]*(authorization|proxy-authorization|x-api-key|api-key)[ \t]*:.*$/gim, `<header ${REDACTED}>`)
      // OpenRouter's own shape, dots included so the `abc...xyz` label dies too.
      .replace(/sk-or-v1-[A-Za-z0-9._-]+/g, REDACTED)
      // Every other provider's key, loose on purpose: a false positive costs a
      // reader nothing, a false negative costs them a credential.
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, REDACTED);
  };

  const walk = (v) => {
    if (typeof v === 'string') return scrubString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Host only — a path or a query string can carry a token, and a host cannot. */
function hostOf(url) {
  try { return new URL(String(url)).host || null; } catch { return null; }
}

// ───────────────────────────────────────────────────────────────────────────
// PURE: THE TOOL OFFER
// ───────────────────────────────────────────────────────────────────────────

/** Tools that spawn a process, run a command, or write history — all ride with --no-run. */
/**
 * ⚠️ THE BACKGROUND THREE RIDE WITH `allowRun` TOO. This set has to name every
 * tool `toolNamesForRounds` withholds under `--no-run`, or the doctor reports a
 * tool as missing and cannot say why — which is the one thing it exists to do.
 */
const RUN_GATED = new Set([
  'run_command', 'run_program', 'evaluate', 'git_commit', 'declare_acceptance', 'check_acceptance',
  // ⚠️ The delivery half rides with `allowRun` too — `git_branch` writes a ref
  // and `git_push` writes to a remote, and the drift guard in doctor.test.mjs
  // ("every tool --no-run withholds can be EXPLAINED") is what would catch this
  // list going stale again, as it already did for the background three.
  'git_branch', 'git_push',
  'start_process', 'check_process', 'stop_process',
  // ⚠️ The REPL executes the user's JavaScript, so --no-run withholds it too —
  // caught by the drift guard the hour it shipped, which is the point of it.
  'repl', 'repl_reset',
  /**
   * ⚠️ `call_endpoint` RIDES WITH `allowRun` BECAUSE ITS TARGET DOES. It can only
   * reach a port registered by `start_process`, so under `--no-run` there is
   * nothing for it to call and offering it would be a dead button.
   *
   * ⭐ Caught by this same drift guard on the day it shipped — the third time
   * that has happened (the background three, then the REPL pair, now this).
   * ⚠️ Without the entry the doctor reported it dark as "not offered in this
   * configuration", which is true and useless: it names no cause and no fix, and
   * that is precisely the failure this file exists to prevent.
   */
  'call_endpoint',
  /**
   * ⚠️ THE SIX THAT ARRIVED WITH THE DARK-MODULE WIRING (2026-08-17). gh spawns
   * the `gh` binary; the three log verbs can only read a process `start_process`
   * launched, which `--no-run` refuses. Fourth time this drift guard has caught
   * a missing entry the same day a tool shipped — which is the entire argument
   * for deriving the list from the gating function rather than typing it out.
   */
  'gh_issue', 'gh_pr', 'gh_run',
  'read_log', 'wait_for_output', 'summarize_log',
]);
/** media tool -> the variable that turns it on. */
const MEDIA_ENV = {
  see_page: 'RENDER_AUDIT_URL',
  speak: 'MODAL_TTS_URL',
  transcribe: 'MODAL_TRANSCRIBE_URL',
  make_document: 'MODAL_PRESS_URL',
  read_document: 'MODAL_DOC_READ_URL',
  read_table: 'MODAL_TABLE_READ_URL',
  // ⚠️ edit_image needs TWO services and this map holds one name. MODAL_SELECT_URL
  // is the one without which the verb is impossible (no mask, no inpaint), so it
  // is the one a person should be told to set. expand_image needs only flux.
  edit_image: 'MODAL_SELECT_URL',
  expand_image: 'MODAL_FLUX_URL',
};
/**
 * ⭐ The media tools whose endpoint URL is BAKED IN by `media.mjs` and therefore
 * blocked only by the credential. Kept beside MEDIA_ENV so nobody edits one
 * without seeing the other.
 */

/**
 * ── ⭐⭐ "IT IS DARK" IS HALF AN ANSWER WHEN THE CREDENTIAL IS 40cm AWAY ─────
 *
 * Measured 2026-08-12: all six media capabilities were dark on this machine, and
 * every one of them WORKED — `see_page` rendered a page and caught a real
 * 1.15:1 contrast failure in 5 seconds — the moment the secret was loaded. The
 * secret was sitting in a SIBLING project's `.env.local` the whole time.
 *
 * The env walk deliberately stops at the repository root, so it cannot reach a
 * sibling, and it should not: silently crossing into another checkout to find
 * credentials is exactly the behaviour a security reviewer would object to.
 *
 * ⭐ SO THE DOCTOR LOOKS, AND ONLY TELLS. It reports the PATH and the variable
 * NAME — never the value — and leaves the copying to a person. That turns "this
 * is dark" into "this is dark, and the thing that fixes it is in that file",
 * which is the difference between a diagnosis and a dead end.
 *
 * ⚠️ BOUNDED AND READ-ONLY: siblings of the workspace and its parent, one level,
 * `.env.local`/`.env` only, and it never reads a value out.
 */
/**
 * ⚠️⚠️ MEMOISED, AND THE FIRST VERSION WAS NOT — IT COST 36 SECONDS.
 *
 * `toolOffer` asks this question once per withheld media tool, and there are six
 * of them. Each ask walked the workspace's parent (sixty-odd sibling projects on
 * this machine), then stat-ed and read two candidate files in every one. A
 * doctor that takes half a minute is a doctor nobody runs — and the end-to-end
 * test that asserts "the MCP section must not spawn or WAIT on anything" caught
 * it, which is exactly the kind of thing that assertion is for.
 *
 * The answer cannot change during one process, so it is computed once per
 * (root, names) and reused.
 */
const credentialCache = new Map();

export function findCredentialNearby(varNames, { root = process.cwd(), readdirImpl = readdirSync, readImpl = readFileSync, existsImpl = existsSync } = {}) {
  const names = Array.isArray(varNames) ? varNames : [varNames];
  const cacheKey = `${resolve(root)}::${names.join(',')}`;
  if (credentialCache.has(cacheKey)) return credentialCache.get(cacheKey);
  const answer = scanForCredential(names, { root, readdirImpl, readImpl, existsImpl });
  credentialCache.set(cacheKey, answer);
  return answer;
}

/** For tests: the cache must not leak an answer from one temp workspace to another. */
export function clearCredentialCache() {
  credentialCache.clear();
}

/**
 * ⚠️⚠️ BOUNDED, BECAUSE AN UNBOUNDED WALK IS NOT A CONVENIENCE, IT IS A HAZARD.
 *
 * Measured: a workspace whose parent is `%TEMP%` — which after a day of testing
 * held several hundred directories — took **6.8 seconds** to answer, tripping
 * the end-to-end assertion that the doctor must never WAIT on anything. In a
 * user's home or a monorepo root the same shape exists.
 *
 * This is a helpfulness feature: "the credential you need is in that file". It
 * is worth a few milliseconds and not worth a directory crawl, so it looks at a
 * bounded number of neighbours and stops. Missing a credential buried in the
 * 41st sibling costs one line of advice; scanning forever costs the tool.
 */
const MAX_NEIGHBOUR_DIRS = 40;

function scanForCredential(varNames, { root, readdirImpl, readImpl, existsImpl }) {
  const seen = new Set();
  const dirs = [];
  try {
    const parent = dirname(resolve(root));
    for (const base of [resolve(root), parent]) {
      dirs.push(base);
      try {
        for (const entry of readdirImpl(base, { withFileTypes: true })) {
          if (dirs.length >= MAX_NEIGHBOUR_DIRS) break;
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            dirs.push(join(base, entry.name));
          }
        }
      } catch { /* unreadable level */ }
    }
  } catch { return null; }

  for (const dir of dirs) {
    for (const name of ['.env.local', '.env']) {
      const file = join(dir, name);
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        if (!existsImpl(file)) continue;
        const text = readImpl(file, 'utf8');
        // ⚠️ The NAME only. A doctor that prints a secret is a worse problem
        // than the one it was diagnosing.
        /**
         * ⚠️ A LINE SCAN, NOT A REGEX. The pattern needed four levels of
         * escaping to survive the tooling that wrote this file, and the version
         * that shipped compiled to `^s*NAME s*=` — matching nothing, silently.
         * A check that quietly matches nothing is the check-that-cannot-fail
         * again, and this one is one line of string work.
         */
        /**
         * ⚠️⚠️ EVERY ACCEPTED NAME, NOT ONE — AND THIS IS THE FOURTH TIME TODAY
         * THAT NAMING ANOTHER MODULE'S STRINGS WAS A GUESS. The first version
         * searched only `ACUVO_MEDIA_SECRET` and reported "not found anywhere"
         * while the credential sat in the very file it had just read, under
         * `MODAL_VIDEO_SECRET` — the OTHER name `mediaConfig` accepts. The list
         * is imported from `media.mjs`, so the two cannot disagree again.
         */
        const names = Array.isArray(varNames) ? varNames : [varNames];
        let hit = null;
        for (const line of text.split('\n')) {
          const t = line.trim();
          const name = names.find((n) => t.startsWith(`${n}=`));
          if (!name) continue;
          // ⚠️ An empty value is a deliberate OFF, not a credential to copy.
          if (t.slice(name.length + 1).trim() === '') continue;
          hit = name;
          break;
        }
        /**
         * ⚠️ IT RETURNS THE NAME IT ACTUALLY FOUND, not the one asked for first.
         * The message read "ACUVO_MEDIA_SECRET is already in <file>" about a file
         * containing `MODAL_VIDEO_SECRET` — advice that sends somebody looking
         * for a line that is not there.
         */
        if (hit) return { file, name: hit };
      } catch { /* unreadable — not a finding */ }
    }
  }
  return null;
}

const MEDIA_BUILT_IN = new Set(['speak', 'transcribe', 'make_document', 'read_document', 'read_table']);
const LSP_TOOLS = new Set(['find_definition', 'find_references', 'check_types', 'list_symbols']);

/**
 * ── ⭐⭐ WHICH TOOLS WOULD ACTUALLY BE OFFERED HERE, AND WHY THE REST WOULD NOT
 *
 * ⚠️ IT ASKS THE REAL FUNCTION. `toolNamesForRounds` is the code the turn loop
 * runs, so this cannot drift from what the model is really shown — a doctor
 * with its own copy of the gating rules is a doctor that eventually lies. That
 * is the same class of bug as a capability that exists and is never imported.
 *
 * ⭐ AND THE REASON IS THE PRODUCT. "read_skill: withheld" is worthless.
 * "read_skill: withheld — no .acuvo/skills directory with a skill in it" is the
 * end of the question.
 */
export function toolOffer({ root = process.cwd(), env = process.env, allowRun = true, maxRounds = 8 } = {}) {
  let offered = [];
  let failed = null;
  try {
    offered = toolNamesForRounds(maxRounds, { allowRun, env, root });
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    offered = [];
  }
  const have = new Set(offered);

  let languages = new Set();
  try { languages = languagesPresent(root); } catch { languages = new Set(); }

  const withheld = [];
  for (const name of TOOL_NAMES) {
    if (have.has(name)) continue;
    withheld.push({ name, ...whyWithheld(name, { env, allowRun, maxRounds, languages, failed, root }) });
  }
  return { offered, withheld, total: TOOL_NAMES.length };
}

function whyWithheld(name, { env, allowRun, maxRounds, languages, failed, root = process.cwd() }) {
  if (failed) {
    return { why: `the offer could not be computed here — ${failed}`, fix: 'run the doctor from a readable workspace directory' };
  }
  /**
   * ⚠️ THE ROUND BUDGET IS CHECKED FIRST, because in a single-shot run nearly
   * everything is withheld and blaming configuration for it would send the
   * reader hunting for an env var that is already set correctly.
   */
  if (maxRounds <= 1 && !MEDIA_ENV[name] && name !== 'generate_image') {
    return {
      why: 'this is a single-shot run: a read or a command has no round to come back in, so offering it would be a dead button',
      fix: 'raise the round budget (--max-rounds N) so results have somewhere to go',
    };
  }
  if (!allowRun && RUN_GATED.has(name)) {
    return { why: '--no-run was passed, and this tool executes something', fix: 'drop --no-run to allow it' };
  }
  if (MEDIA_ENV[name]) {
    /**
     * ⚠️ SAME CORRECTION AS THE MEDIA SECTION, AND IT HAD TO BE MADE TWICE
     * BECAUSE THE ADVICE LIVES IN TWO PLACES. `media.mjs` bakes a default URL in
     * for these, so the reader does not need an endpoint URL they cannot guess —
     * they need ONE credential. Telling them otherwise is wrong advice in a
     * diagnostic, which is worse than none because it gets followed.
     *
     * `see_page` and the two image services have NO baked default, so for them
     * the variable really is the thing to set.
     */
    if (MEDIA_BUILT_IN.has(name)) {
      const found = findCredentialNearby(MEDIA_SECRET_ENV_NAMES, { root });
      return {
        why: 'no media credential is set, so the service is not configured here (its URL is built in)',
        fix: found
          ? `${found.name} is already set in ${found.file} — copy that line into this workspace's .env.local. `
            + 'The env walk stops at the repository root on purpose, so it will not reach across to another checkout for you.'
          : 'set ACUVO_MEDIA_SECRET in .env.local — one credential turns on speech, transcription, documents and table reading together',
      };
    }
    const alt = name === 'see_page' ? ' (or MODAL_RENDER_AUDIT_URL)' : '';
    return {
      why: `${MEDIA_ENV[name]} is unset${alt}, so the service does not exist here`,
      fix: `set ${MEDIA_ENV[name]} to your endpoint URL, and ${'MODAL_VIDEO_SECRET'} to the value it expects`,
    };
  }
  if (name === 'generate_image') {
    return {
      why: `${IMAGE_URL_ENV} is set to an empty value, which means the image service is deliberately OFF`,
      fix: `unset ${IMAGE_URL_ENV} to use the default endpoint, or set it to your own image service`,
    };
  }
  /**
   * ── ⚠️ THIS REASON WAS TRUE AND STOPPED BEING TRUE ─────────────────────────
   *
   * It said "no `.acuvo/skills` directory with at least one readable skill in
   * it", which was the whole story while the only skills were a project's own.
   * Skills SHIP with the CLI now, so a bare workspace has a full shelf and
   * `read_skill` is never withheld for a missing directory — measured: on a
   * fresh temp dir it is OFFERED, and this branch could only fire if the
   * BUNDLED shelf were empty.
   *
   * ⭐ A withheld-reason that names the wrong cause is worse than a generic one,
   * because it sends somebody to create a directory that would change nothing.
   * The message now names both sources, so whichever one is actually missing,
   * the sentence is true.
   */
  if (name === 'read_skill') {
    return {
      why: `no skills are readable at all — the bundled shelf is empty AND there is no ${ACUVO_DIR}/skills directory with a readable skill in it`,
      fix: `reinstall acuvo-code to restore the bundled skills, or create ${ACUVO_DIR}/skills/<name>.md with name/description frontmatter`,
    };
  }
  /**
   * ⭐ THE REASON IS THE PRODUCT, and "not offered in this configuration" (the
   * fallback at the bottom of this function) is exactly the non-answer this
   * doctor exists to avoid. Push is dark on every machine by default, so it
   * would be the most frequently non-answered tool in the list.
   */
  if (name === 'git_push') {
    return {
      why: `${ALLOW_PUSH_ENV} is not set, so pushing is off — the one verb that leaves this machine is opt-in`,
      fix: `set ${ALLOW_PUSH_ENV}=1 to allow it. It still refuses protected branches (${PROTECTED_BRANCHES.slice(0, 4).join(', ')}, …) and never force-pushes.`,
    };
  }
  if (LSP_TOOLS.has(name)) {
    const langs = [...languages];
    if (langs.length === 0) {
      return {
        why: 'no recognised language manifest or source file was found near the top of this workspace, so no language server could answer here',
        fix: 'run the doctor from the project root (a package.json / pyproject.toml / Cargo.toml / go.mod)',
      };
    }
    const installs = langs.map((l) => LANGUAGE_SERVERS[l]?.install).filter(Boolean);
    return {
      why: `no language server is installed for ${langs.join(', ')} — semantic navigation cannot answer here`,
      fix: installs.length ? `install one: ${installs.join('  ·  ')}` : 'install a language server for this project',
    };
  }
  return { why: 'not offered in this configuration', fix: 'run the doctor again with the flags you actually use' };
}

// ───────────────────────────────────────────────────────────────────────────
// PURE: MCP — EVERYTHING KNOWABLE WITHOUT STARTING A PROGRAM
//
// ── ⚠️⚠️ THE DOCTOR MUST NEVER SPAWN AN MCP SERVER ──────────────────────────
//
// It is the one probe in this file that would be genuinely dangerous to run.
// Every other check costs an HTTP round trip we bound twice; starting an MCP
// server costs a PROCESS — and measured on this network today, an `npx`-based
// server hangs for minutes on a cold package cache. Eight of those, at
// `HANDSHAKE_TIMEOUT_MS = 20s` each, is a diagnostic nobody runs twice. It also
// has side effects: MCP servers open sockets, touch remote systems and are
// handed the user's real tokens (`mcp.mjs` passes credentials deliberately).
//
// ⭐ SO THIS SECTION ANSWERS THE CHEAP QUESTIONS AND SAYS "not checked" TO THE
// REST — the `verified: false` convention this file already uses for a probe it
// deliberately did not make. The cheap questions turn out to be the ones that
// actually fail:
//
//   · is a server declared at all, and in which file
//   · does its command RESOLVE — the #1 failure, and free to answer
//   · does its env block break the credential rather than supply it
//
// ── ⚠️ THIS FILE MODELS HOW mcp.mjs STARTS A SERVER, AND THAT IS A COUPLING ──
// `resolveExecutable` and `nodeCliEntry` are not exported there, so the rules
// are mirrored here rather than asked for — the one thing this file otherwise
// refuses to do (see `toolOffer`, which calls the real gate). Two tests in
// doctor.test.mjs import `readMcpConfig` and `connectServer` and pin the
// behaviours this mirror depends on, so a change there fails a test rather than
// silently turning this section into fiction.
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ ONE HONEST LIMIT ON THE "NEVER HANGS" PROMISE. This section is the only
 * one that touches the filesystem SYNCHRONOUSLY (`existsSync`/`statSync` while
 * walking PATH, and `readMcpConfig`'s own `readFileSync`), and a sync call
 * cannot be raced by `withTimeout`. A PATH entry pointing at a dead network
 * share can therefore stall it — the same exposure `mcp.mjs` and `command.mjs`
 * already carry at spawn time, and the walk stops at the first hit. Bounding it
 * properly would mean a worker thread, which is a large amount of machinery to
 * add to a diagnostic; recorded here rather than quietly assumed away.
 */

/** `${VAR}` / `$VAR` — a reference the user THINKS will be expanded. */
const ENV_PLACEHOLDER = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

export function envPlaceholderName(value) {
  const m = ENV_PLACEHOLDER.exec(String(value ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Where `mcp.mjs` would find this command — or why it would not.
 *
 * kinds: `path` · `node-entry` (npm/npx, run through node's own CLI entry) ·
 * `missing` · `missing-path` · `missing-npm` · `unknown` (no PATH to search).
 *
 * ⚠️ `unknown` EXISTS SO AN ODD ENVIRONMENT IS NOT CALLED BROKEN. A container
 * with no PATH set is not proof that a binary is absent, and painting it red
 * would be this repo's most-repeated mistake: a check that fails correct work.
 */
export function resolveMcpCommand(command, {
  env = process.env,
  platform = process.platform,
  existsImpl = existsSync,
  statImpl = statSync,
  execPath = process.execPath,
} = {}) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return { kind: 'missing', path: null };

  const exists = (p) => { try { return !!existsImpl(p); } catch { return false; } };
  const isFile = (p) => { try { return exists(p) && statImpl(p).isFile(); } catch { return false; } };

  /**
   * ⭐ npm/npx NEVER RESOLVE ON PATH HERE, and that is not an optimisation.
   * `mcp.mjs` spawns them as `node <npm's own npx-cli.js>` because Windows
   * refuses to run a `.cmd` without a shell (CVE-2024-27980) and a shell is the
   * injection surface the whole package exists to avoid. Reporting "npx found
   * at C:\…\npx.cmd" would name a file that is never executed.
   */
  if (cmd === 'npm' || cmd === 'npx') {
    const dir = dirname(execPath);
    const file = cmd === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
    for (const c of [
      join(dir, 'node_modules', 'npm', 'bin', file),
      join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', file),
      join(dir, '..', 'node_modules', 'npm', 'bin', file),
    ]) {
      if (exists(c)) return { kind: 'node-entry', path: c };
    }
    return { kind: 'missing-npm', path: null };
  }

  if (cmd.includes('/') || cmd.includes(String.fromCharCode(92))) {
    return exists(cmd) ? { kind: 'path', path: cmd } : { kind: 'missing-path', path: cmd };
  }

  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env?.PATH || env?.Path || '').split(sep).filter(Boolean);
  if (dirs.length === 0) return { kind: 'unknown', path: null };
  /**
   * ⚠️ EXTENSIONS BEFORE THE BARE NAME, the order `mcp.mjs` had to fix: the
   * nodejs directory holds BOTH `npx` (a bash script Windows cannot spawn) and
   * `npx.cmd`, and finding the bare name first reports a path that exists and
   * still fails to start.
   */
  const exts = platform === 'win32'
    ? [...String(env?.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '']
    : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const candidate = join(d, cmd + ext);
      if (isFile(candidate)) return { kind: 'path', path: candidate };
    }
  }
  return { kind: 'missing', path: null };
}

/**
 * ── ⭐⭐ THE CREDENTIAL BUG THAT IS INVISIBLE FROM THE CONFIG FILE ───────────
 *
 * `connectServer` builds the child environment as `{...process.env, ...server.env}`
 * and expands NOTHING. So the two shapes people write most often are both
 * actively harmful rather than merely useless:
 *
 *   "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }   the server receives the
 *       fifteen literal characters — AND the real token it would have
 *       inherited is overwritten by them.
 *   "env": { "GITHUB_TOKEN": "" }                  the real token is
 *       overwritten with nothing.
 *
 * ⚠️ NOTE WHAT THIS MEANS FOR A NAIVE CHECK: asking "is GITHUB_TOKEN absent
 * from the environment" gives the placeholder case a clean bill of health,
 * because the variable IS set — it is just not what the server will get.
 *
 * Returns `{ key, kind, ref }`. Never the value: a config entry can hold a real
 * credential, and this file does not print those.
 */
export function mcpCredentialGaps(serverEnv, env = {}) {
  const gaps = [];
  for (const [key, raw] of Object.entries(serverEnv ?? {})) {
    const value = typeof raw === 'string' ? raw : '';
    if (value.trim() === '') { gaps.push({ key, kind: 'empty', ref: null }); continue; }
    const ref = envPlaceholderName(value);
    if (ref) gaps.push({ key, kind: 'placeholder', ref });
  }
  return gaps;
}

/** One declared server, judged. Nothing here starts anything. */
export function assessMcpServer(server, { file = null, env = {}, resolution = { kind: 'unknown', path: null } } = {}) {
  const base = { id: `mcp.${server?.name}`, label: String(server?.name ?? '') };
  const where = `declared in ${file ?? 'the MCP config'}`;
  const cmd = String(server?.command ?? '');
  const fixFile = file ?? MCP_CONFIG_FILES[0];

  /**
   * ── ⚠️⚠️ A HOSTED SERVER HAS NO COMMAND, AND THIS SECTION WOULD CALL IT
   *        BROKEN ────────────────────────────────────────────────────────────
   *
   * Added 2026-08-15 with remote transports in `mcp.mjs`. Everything below this
   * point asks "where would `mcp.mjs` find this executable" — a question with no
   * answer for `{"type":"http","url":"https://mcp.sentry.dev/mcp"}`, because
   * nothing is executed. Without this branch `resolveMcpCommand` reports
   * `missing-path` for the URL and the doctor prints
   *     ✖ the command "https://mcp.sentry.dev/mcp" does not exist
   * for a server that works perfectly — a check that fails correct work, which
   * this repo has paid for four times in one day and which is worse than no
   * check because it gets acted on.
   *
   * ⚠️ IT STAYS `verified: false`. The doctor never connects, so "declared, and
   * the URL is well-formed" is the entire claim — exactly the honesty convention
   * the branch below it uses for a command that resolves.
   */
  if (server?.transport === 'http' || server?.transport === 'sse') {
    let host = String(server?.url ?? '');
    try { host = new URL(server.url).host; } catch { /* readMcpConfig already validated it */ }
    const refs = [...new Set(
      Object.values(server?.headers ?? {})
        .flatMap((v) => [...String(v).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)])
        .map((m) => m[1] ?? m[2]),
    )];
    const unset = refs.filter((n) => typeof env?.[n] !== 'string' || env[n].trim() === '');
    if (unset.length > 0) {
      return {
        ...base,
        state: 'broken',
        verified: true,
        detail: `${where} · reached over ${server.transport === 'sse' ? 'SSE' : 'HTTP'} at ${host}, and its headers reference ${unset.join(', ')}, which ${unset.length === 1 ? 'is' : 'are'} not set — this client refuses to connect rather than send the literal "\${${unset[0]}}" to a third party`,
        fix: `export ${unset.join(', ')} in your shell (the value is read at connect time and never written into ${fixFile})`,
      };
    }
    return {
      ...base,
      state: 'live',
      verified: false,
      detail: `${where} · reached over ${server.transport === 'sse' ? 'SSE' : 'HTTP'} at ${host} · nothing is spawned${refs.length ? `, and your ${refs.join(', ')} travels with every call` : ''} · not checked — the doctor never connects to an MCP server`,
      fix: null,
    };
  }

  if (resolution.kind === 'missing' || resolution.kind === 'missing-path') {
    return {
      ...base,
      state: 'broken',
      verified: true,
      detail: `${where} · the command "${cmd}" ${resolution.kind === 'missing-path' ? 'does not exist' : 'was not found on PATH'}, so this server cannot start and none of its tools are offered`,
      fix: `install it, or set "${server?.name}".command in ${fixFile} to a full path to the executable`,
    };
  }
  if (resolution.kind === 'missing-npm') {
    return {
      ...base,
      state: 'broken',
      verified: true,
      detail: `${where} · "${cmd}" is run through npm's own JavaScript entry point (a .cmd shim cannot be spawned without a shell) and no npm installation was found next to this node`,
      fix: `install npm alongside this node, or set "${server?.name}".command in ${fixFile} to a full path to the server's executable`,
    };
  }

  /**
   * ⚠️⚠️ "COULD NOT LOOK" IS NOT "FOUND IT", AND THE FIRST DRAFT SAID IT WAS.
   * With no PATH to search, `resolveMcpCommand` answers `unknown` — and this
   * function fell through to the healthy branch and printed
   * `"linear-mcp" resolves`, a sentence with no evidence behind it whatsoever.
   * Caught by a test, which is the only reason it is not in the product.
   */
  if (resolution.kind === 'unknown') {
    return {
      ...base,
      state: 'live',
      verified: false,
      detail: `${where} · "${cmd}" · not checked — there is no PATH in this environment to look it up in, and nothing here starts a server to find out`,
      fix: null,
    };
  }

  const gaps = mcpCredentialGaps(server?.env, env);
  if (gaps.length) {
    const g = gaps[0];
    const detail = g.kind === 'placeholder'
      // ⚠️ The placeholder TEXT is described, never echoed — an echoed `${…}` is
      // harmless, but the same line renders values that may not be.
      ? `${where} · its "${g.key}" entry is a $\{…} placeholder, and this client does not expand those — the server receives that text literally, and it OVERRIDES the real ${g.ref} in your environment`
      : `${where} · its "${g.key}" entry is empty, which OVERRIDES any real ${g.key} in your environment with nothing`;
    return {
      ...base,
      state: 'broken',
      verified: true,
      detail,
      fix: `delete the "${g.key}" line from "${server?.name}".env in ${fixFile} so the server inherits ${g.ref ?? g.key} from your shell (this client passes the whole environment through)`,
    };
  }

  const via = resolution.kind === 'node-entry' ? ` (run as node ${cmd}-cli.js, the only shell-free way on Windows)` : '';
  return {
    ...base,
    state: 'live',
    verified: false,
    detail: `${where} · "${cmd}" resolves${via} · not checked — the doctor never starts an MCP server (an npx server can take minutes on a cold cache, and a diagnostic must not hang)`,
    fix: null,
  };
}

/**
 * ── ⚠️⚠️ A JSON PARSE ERROR QUOTES THE FILE BACK AT YOU ─────────────────────
 *
 * MEASURED ON NODE 22.17, and it is the exact trap `model.mjs` documents for
 * proxy error pages, arriving through a completely different door:
 *
 *   JSON.parse('…"env":{"T":ghp_REALTOKEN0123…')
 *     -> Unexpected token 'g', ..."env":{"T":ghp_REALTO"... is not valid JSON
 *
 * V8 echoes roughly twenty characters of the source around the fault. An
 * `mcp.json` is one of the few files people type an API token straight into, so
 * a stray comma in it would print part of that token to the terminal, to CI
 * logs, and into whatever the user pastes into a bug report — and `SECRET_ENV_VARS`
 * cannot help, because the value was never an environment variable.
 *
 * ⭐ THE ECHO IS ALSO THE LEAST USEFUL PART OF THE MESSAGE. "Unexpected token
 * 'g' … is not valid JSON", the position, and the file name are what a person
 * acts on; the twenty quoted characters are already on their screen in the
 * editor. So this drops the echo and keeps everything else.
 */
export function redactConfigEcho(message) {
  return String(message ?? '')
    // `..."<echo>"...` — the form V8 uses mid-file.
    .replace(/\.\.\."[\s\S]*?"\.\.\./g, '…')
    // `"<echo>"...` — the form it uses at the very start of the input.
    .replace(/"[\s\S]*?"\.\.\./g, '…')
    .slice(0, 240);
}

/** The whole MCP section, from an already-read config. */
/**
 * @param {object} [options]
 * @param {number} [options.offeredCount] how many tools the model is ACTUALLY
 *   offered here. ⚠️ Defaults to the registry size only so a direct caller that
 *   omits it still produces a sentence; `runDoctor` always passes the real
 *   number, because the registry size is the flattering one and the two rows
 *   sitting next to each other must agree.
 */
export function mcpChecks(cfg, env = {}, { resolve = resolveMcpCommand, offeredCount = TOOL_NAMES.length } = {}) {
  const offeredHere = offeredCount;
  const names = MCP_CONFIG_FILES.join(' or ');

  if (!cfg?.ok) {
    return [{
      id: 'mcp.config',
      label: 'mcp config',
      state: 'broken',
      verified: true,
      detail: `${redactConfigEcho(cfg?.error) || 'the MCP config could not be read'} — no external server is connected while this stands`,
      fix: `fix or delete the file (${names}); a config that will not parse takes every server with it`,
    }];
  }

  if (!cfg.file || cfg.servers.length === 0) {
    return [{
      id: 'mcp.config',
      label: 'mcp servers',
      state: 'dark',
      verified: true,
      /**
       * ⚠️ THE OFFERED COUNT, NOT `TOOL_NAMES.length` — AND THEY DIFFER BY 13.
       *
       * This line used to quote the size of the registry while the row directly
       * above it printed "34 of 47". Two adjacent rows of one report giving
       * different answers to "how many tools does the model have" is worse than
       * either being wrong alone: `--doctor` exists to tell you what is actually
       * working here, so a diagnostic that disagrees with itself cannot be used
       * at all without checking it.
       *
       * ⚠️ And 47 was the FLATTERING number, which is the direction that costs
       * trust. On a bare machine 8 tools need infrastructure we host, 4 need
       * TypeScript in the user's own project, and 1 needs a skills directory.
       */
      detail: cfg.file
        ? `${cfg.file} declares no servers, so the model sees only the ${offeredHere} tools available in this workspace`
        : `no ${names} in this workspace, so the model sees only the ${offeredHere} tools available in this workspace`,
      fix: `create ${MCP_CONFIG_FILES[0]} with an "mcpServers" object to give it tools we did not build (the user chooses the servers — there is deliberately no tool that lets the model add its own)`,
    }];
  }

  const checks = cfg.servers.map((s) => assessMcpServer(s, { file: cfg.file, env, resolution: resolve(s.command, { env }) }));

  /**
   * ⚠️ readMcpConfig STOPS AT MAX_SERVERS AND SAYS NOTHING. A ninth server in
   * the file is simply never connected, which from the outside looks exactly
   * like a server that failed to start.
   */
  if (cfg.servers.length >= MAX_SERVERS) {
    checks.push({
      id: 'mcp.cap',
      label: 'server cap',
      state: 'dark',
      verified: true,
      detail: `${cfg.servers.length} servers is the MAX_SERVERS ceiling — any declared after the first ${MAX_SERVERS} in ${cfg.file} are silently not connected`,
      fix: `remove servers from ${cfg.file} until there are fewer than ${MAX_SERVERS}, so nothing is dropped without being reported`,
    });
  }
  return checks;
}

/**
 * ── ⭐⭐ THE CURATED CATALOGUE, WHICH HAD NO DOOR AT ALL ─────────────────────
 *
 * `lib/mcp-defaults.mjs` is 500 lines of hand-verified integration work with
 * **zero importers** — measured by an import-graph probe over `lib/`, `bin/` and
 * `scripts/`: one test imported it and nothing else did. So a user could not
 * reach any of it. They had to hand-write `.acuvo/mcp.json` from install lines
 * the repo itself recorded as wrong, which is the exact "built but unreached"
 * shape this project keeps re-learning: a screenshot beats any number of green
 * tests, and a module nobody can call is a module that does not exist.
 *
 * ⭐ THE DOCTOR IS THE RIGHT DOOR because it is already the place a stranger
 * goes to ask "what can this thing do here, and what would it take to do more".
 * The catalogue answers exactly that question and its `assessEntry` already
 * returns doctor's own `state`/`detail`/`fix` shape — it was written for this
 * seam and then never plugged into it.
 *
 * ⚠️ ONLY ENTRIES WE ACTUALLY RAN APPEAR HERE. The catalogue has a second,
 * INERT tier of servers nobody on this project has started; a health report is
 * the wrong place for "someone else says this works". Those stay in
 * `formatAvailability` and the starter config, where they are labelled
 * unverified. The doctor shows what was measured.
 *
 * ⚠️ AND IT NEVER SPAWNS ANYTHING. `assessCatalogue` is pure — that is its whole
 * reason for existing (each dark entry it rules out is a measured 20,052ms
 * handshake timeout not spent) — and the ONLY I/O added here is `existsSync` on
 * candidate `node_modules` directories.
 *
 * ⚠️ IDS ARE NAMESPACED `mcp.catalogue.<name>`, NOT `mcp.<name>`. `assessEntry`
 * returns the latter and so does `assessMcpServer` for a user's own server — a
 * user with a server called `browser` would have produced two rows sharing an
 * id, and `find(report, id)` returns the first. Two different facts under one
 * key is how a report starts lying without anyone editing a sentence.
 */
export function mcpCatalogueChecks({ env = {}, root = '.', declaredNames = [], installedImpl = installedPackages } = {}) {
  /**
   * ⚠️ A SERVER THE USER ALREADY DECLARED IS REPORTED BY `mcpChecks` ABOVE,
   * from their actual config — including whether its command resolves. Repeating
   * it from the catalogue would put two rows about one server in one section,
   * and the catalogue's row is the weaker of the two (it knows the entry, not
   * the user's args).
   */
  const declared = new Set(declaredNames);
  const installed = installedImpl({ env, root, packages: CATALOGUE.map(packageOf).filter(Boolean) });
  const rows = assessCatalogue({ env, installed });
  const verified = rows.filter((r) => r.verified);
  const live = verified.filter((r) => r.state === 'live');

  const checks = [{
    id: 'mcp.catalogue',
    label: 'curated servers',
    state: live.length > 0 ? 'live' : 'dark',
    verified: true,
    detail: `${live.length} of ${verified.length} servers we have run ourselves are usable here${live.length ? ` (${live.map((r) => r.label).join(', ')})` : ''} — ${CATALOGUE.length} in the catalogue in total`,
    fix: live.length > 0
      ? `add one to ${STARTER_CONFIG_FILE} under "mcpServers" to turn it on`
      : `install one of the servers below, then declare it in ${STARTER_CONFIG_FILE}`,
  }];

  for (const r of verified) {
    if (declared.has(r.entry)) continue;
    checks.push({
      id: `mcp.catalogue.${r.entry}`,
      label: r.label,
      state: r.state,
      // ⚠️ `verified` here means "we ran this server", which is the same claim
      // the doctor's own column makes: this line is a measurement, not a table
      // lookup. Every row in this loop passed that filter.
      verified: true,
      detail: `${r.purpose} — ${r.detail}`,
      fix: r.fix,
    });
  }
  return checks;
}

/**
 * Which of these npm packages are on this machine.
 *
 * ⚠️ NO SPAWN. `npm ls -g` would be the obvious implementation and it costs
 * hundreds of milliseconds on the doctor's hot path — the same mistake that
 * made the credential finder a 6.8s directory crawl. This is `existsSync` on a
 * short list of known roots.
 *
 * ⚠️ THE WINDOWS GLOBAL ROOT IS NOT BESIDE `node.exe`. npm's default prefix on
 * Windows is `%APPDATA%\npm`, so globals land in `%APPDATA%\npm\node_modules`
 * while `dirname(process.execPath)\node_modules` holds only npm itself.
 * Checking only the latter reported every globally installed server as missing.
 *
 * ⚠️ AND A MISS IS NOT A LIE. `assessEntry` words a negative as "not installed",
 * which is the honest reading of "not found in any root we know" — the cost of
 * being wrong is one unnecessary install line, never a false all-clear.
 */
export function installedPackages({ env = {}, root = '.', packages = [], existsImpl = existsSync } = {}) {
  const nodeDir = dirname(process.execPath);
  const roots = [
    join(root, 'node_modules'),
    join(nodeDir, 'node_modules'),
    join(nodeDir, '..', 'lib', 'node_modules'),
    ...(env.npm_config_prefix ? [join(env.npm_config_prefix, 'node_modules'), join(env.npm_config_prefix, 'lib', 'node_modules')] : []),
    ...(env.APPDATA ? [join(env.APPDATA, 'npm', 'node_modules')] : []),
  ];
  const found = new Set();
  for (const pkg of packages) {
    for (const r of roots) {
      // package.json, not the directory: an empty leftover folder is not an
      // installed package, and npm leaves those behind on a failed install.
      if (existsImpl(join(r, pkg, 'package.json'))) { found.add(pkg); break; }
    }
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// PURE: PROMPT CACHING — DOES THE CONFIGURED MODEL CACHE AT ALL
//
// ── ⭐ WHY THIS DESERVES A SECTION ──────────────────────────────────────────
// The loop's whole economic design assumes an automatically-cached prefix:
// `turn.mjs` appends rather than rebuilds, `learned.mjs` renders sorted and
// timestamp-free, and the loop nudges once per session — all so the prefix
// stays byte-identical. Measured on DeepSeek: 97.2% cached and 3-4x cheaper.
//
// ⚠️ ON A MODEL THAT DOES NOT CACHE, EVERY ONE OF THOSE CONTORTIONS BUYS
// NOTHING, and the run costs several times what the user expects with nothing
// reporting it. That is a money surprise, which is the class of failure this
// package treats most seriously.
//
// ⚠️ UNKNOWN IS THE DEFAULT AND IT IS DELIBERATE. A caching claim invented for
// a model nobody measured turns a cost estimate into fiction. Add to the table
// only with a source, and prefer "not known" every other time.
// ───────────────────────────────────────────────────────────────────────────

/** Caches the prefix with no flag in the request. */
const AUTO_CACHE = [
  // Measured in this repo, 2026-08-11 (see turn.mjs) — automatic, on disk.
  /^deepseek\//i,
  // Documented automatic prompt caching above ~1k tokens.
  /^openai\/(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4)/i,
  // Implicit caching, 2.5 and newer (1.5 was explicit-only).
  /^google\/gemini-(2\.5|3)/i,
];
/**
 * Caches ONLY when the request carries explicit breakpoints — which this client
 * does not send: `callModel` builds one plain OpenAI-shaped body.
 */
const EXPLICIT_CACHE = [/^anthropic\//i];

export function cachingSupport(modelId) {
  const id = String(modelId ?? '').trim();
  if (!id) return { kind: 'unknown' };
  if (AUTO_CACHE.some((re) => re.test(id))) return { kind: 'automatic' };
  if (EXPLICIT_CACHE.some((re) => re.test(id))) return { kind: 'explicit' };
  return { kind: 'unknown' };
}

export function cacheChecks({ model, maxRounds = 8 } = {}) {
  const support = cachingSupport(model);
  const checks = [];

  if (support.kind === 'automatic') {
    checks.push({
      id: 'cache.model',
      label: 'prompt cache',
      state: 'live',
      /**
       * ⚠️ verified:false, AND THE DETAIL SAYS WHY IN WORDS. This is a fact
       * about the MODEL, read from a table — nothing here measured your run, and
       * a green tick claiming otherwise is exactly the false all-clear this file
       * exists to prevent. That half is unchanged and correct.
       *
       * ⚠️⚠️ THE OTHER HALF WAS A STALE FACT REPORTED BY THE DIAGNOSTIC TOOL —
       * the exact defect class this file was built to catch. The detail used to
       * end "the real hit rate is not instrumented yet", and that has never been
       * true: it was written in the same commit that instrumented it.
       * `readCacheUsage` reads cached tokens per round, `aggregateCache` totals
       * them per session, `cacheClause` prints them on the summary line, and
       * `toJson` emits them into `--json` and therefore into `.acuvo/audit/`.
       * Telling the user their hit rate does not exist, while the run they just
       * did printed it, is worse than saying nothing.
       *
       * ⚠️ AND IT NOW NAMES THE REAL CAUSE OF A LOW NUMBER. Measured 2026-08-14
       * on one identical 4-round task: 46.7% unpinned against 95.8% pinned. The
       * variance is UPSTREAM ROUTING across the model's 28 endpoints, not prefix
       * discipline — so a user who reads "your cache is bad" and goes hunting
       * their prompt is hunting the wrong thing.
       */
      verified: false,
      detail: `${model} caches the prompt prefix automatically — a continuing session re-sends an identical prefix and is billed a fraction for it. This line is the model's documented behaviour, not a measurement of your runs; YOUR hit rate is measured on every run and printed on the summary line, and in --json as cache.hitRate. ⚠️ It varies mostly with UPSTREAM ROUTING rather than with your prefix — measured 2026-08-14 on one identical 4-round task, 46.7% unpinned against 95.8% pinned via ACUVO_PROVIDER_ORDER. --json also reports \`providers\`, which names who served each round.`,
      fix: null,
    });
  } else if (support.kind === 'explicit') {
    checks.push({
      id: 'cache.model',
      label: 'prompt cache',
      state: 'dark',
      verified: true,
      detail: `${model} caches only when the request carries cache_control breakpoints, and this client sends none — every round pays the full prompt price, however stable the prefix is`,
      fix: `set OPENROUTER_CODEGEN_MODEL to a model that caches automatically (e.g. ${DEFAULT_MODEL}) if the cost of a long session matters`,
    });
  } else {
    checks.push({
      id: 'cache.model',
      label: 'prompt cache',
      state: 'dark',
      verified: false,
      detail: `${model || 'this model'} is not known here to cache the prompt prefix automatically — cost this run as if every round pays full price for the whole prompt`,
      fix: `check the provider's docs, or set OPENROUTER_CODEGEN_MODEL to a model that is known to cache automatically (e.g. ${DEFAULT_MODEL})`,
    });
  }

  /**
   * ⭐ A CACHE HIT NEEDS A SECOND ROUND. In a single-shot run the prefix is
   * sent exactly once, so no model on earth can save anything — worth saying,
   * because otherwise the line above reads like money being saved that is not.
   */
  if (maxRounds <= 1) {
    checks.push({
      id: 'cache.rounds',
      label: 'rounds',
      state: 'dark',
      verified: true,
      detail: 'this is a single-shot run: the prompt prefix is sent once, so no cache hit is possible whatever the model supports',
      fix: 'raise the round budget (--max-rounds N) — caching only pays from the second round onward',
    });
  }
  return checks;
}

// ───────────────────────────────────────────────────────────────────────────
// THE EDGE: PROBES
// ───────────────────────────────────────────────────────────────────────────

const TIMED_OUT = Symbol('timed-out');

/** Never throws. A failure is data, with the code that caused it. */
async function httpProbe(fetchImpl, url, init, timeoutMs) {
  let res;
  try {
    res = await withTimeout(
      // ⚠️ `.then()` so a fetchImpl that throws SYNCHRONOUSLY becomes a
      // rejection rather than an exception escaping this function.
      Promise.resolve().then(() => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })),
      timeoutMs,
      TIMED_OUT,
    );
  } catch (err) {
    const code = err?.cause?.code || err?.name || 'unknown';
    return { kind: 'unreachable', detail: String(code) };
  }
  if (res === TIMED_OUT) return { kind: 'unreachable', detail: `no answer within ${timeoutMs}ms` };

  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — the text is all we have */ }
  return { status: res.status, json, text };
}

/** Is this string the service saying "your credential is wrong"? */
function readsAsAuthFailure(s) {
  return /unauthoris|unauthoriz|forbidden|invalid secret|invalid token|not authenticated|401|403/i.test(String(s ?? ''));
}

/**
 * ── ⭐ THE MEDIA HEALTH PROBE: THE SECRET, AND NO PAYLOAD ───────────────────
 *
 * A payload complaint is PROOF the credential was accepted, and it costs the
 * service nothing to produce — no GPU, no render, no synthesis. Measured
 * round trips on the live endpoints: 284ms–1195ms.
 */
async function probeMediaEndpoint(fetchImpl, url, secret, timeoutMs) {
  const raw = await httpProbe(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(secret ? { secret } : {}),
  }, timeoutMs);
  if (raw.kind) return raw;

  if (raw.status === 401 || raw.status === 403) return { kind: 'refused', detail: `HTTP ${raw.status}` };
  if (raw.status >= 400) return { kind: 'http', detail: `HTTP ${raw.status}` };
  if (!raw.json) return { kind: 'http', detail: `HTTP ${raw.status} but the body was not JSON — this may not be the service you think it is` };
  if (raw.json.ok === false && readsAsAuthFailure(raw.json.error)) {
    return { kind: 'refused', detail: String(raw.json.error).slice(0, 120) };
  }
  /**
   * ⭐ `ok:false` WITH A PAYLOAD COMPLAINT IS THE HEALTHY ANSWER. We sent no
   * payload on purpose; the service telling us so is the credential being
   * accepted. Treating it as a failure would report every working endpoint red.
   */
  return { kind: 'ok', detail: raw.json.ok === false ? `answered: ${String(raw.json.error).slice(0, 80)}` : 'answered ok' };
}

// ───────────────────────────────────────────────────────────────────────────
// THE EDGE: runDoctor
// ───────────────────────────────────────────────────────────────────────────

/** The engines floor this package declares, read from its own manifest. */
function readOwnEngines() {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return pkg?.engines?.node ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {Function|null} [opts.fetchImpl]  null = do not touch the network at all
 * @param {string} [opts.root]
 */
export async function runDoctor({
  env = process.env,
  fetchImpl = fetch,
  root = process.cwd(),
  now = Date.now,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  allowRun = true,
  maxRounds = 8,
  nodeVersion = process.version,
  platform = `${process.platform} ${process.arch}`,
  engines = undefined,
  gitStatusImpl = realGitStatus,
  /**
   * ⚠️ WE DO NOT INHERIT git.mjs's BOUND, WE IMPOSE OUR OWN. `GIT_TIMEOUT_MS`
   * there is 20s, which is a sensible bound for a tool call and a terrible one
   * for a diagnostic — and an INJECTED `gitStatusImpl` is under no obligation
   * to have any bound at all. Same argument as `withTimeout` for fetch.
   */
  gitTimeoutMs = 15_000,
  readFileImpl = readFileSync,
  /**
   * ⚠️ IT READS THE CONFIG, IT NEVER CONNECTS. `readMcpConfig` only parses a
   * file; `connectServer` — the function that spawns a program — is deliberately
   * not imported into this module at all, so no future edit here can start one
   * by accident.
   */
  mcpConfigImpl = readMcpConfig,
  /**
   * ── ⚠️⚠️ THE PROMISE WAS FALSE, AND IT WAS THE WORST ONE TO GET WRONG ──────
   *
   * `--help` and `README.md` both said `--doctor` "Needs no API key and no
   * network". It sends `Authorization: Bearer <the user's key>` to
   * openrouter.ai/api/v1/key and /credits, and probes every Modal endpoint.
   *
   * ⭐ WHY THIS ONE MATTERS MORE THAN AN ORDINARY DOC BUG: `--doctor` is what a
   * security-conscious evaluator runs FIRST, precisely BECAUSE they were told it
   * was offline. They then find their key in a corporate proxy log. The lie and
   * the audience are perfectly aligned to destroy trust on first contact.
   *
   * ⚠️ THE ANSWER IS NOT TO DELETE THE PROBES. Verifying that a key actually
   * authenticates is the most valuable thing this command does — "present, but
   * it does NOT authenticate" is a real diagnosis no offline check can make. So:
   * the docs now say what it does, and `--offline` delivers what they used to
   * promise, for an air-gapped machine or anyone who wants to read the code
   * before it touches the network.
   *
   * ⚠️ NAMED `skipNetwork`, NOT `offline`, DELIBERATELY. This function already
   * computes an `offline` VERDICT further down — "every probe was unreachable,
   * so this laptop has no connection" — and those are opposite things: one is a
   * request not to look, the other is a finding from having looked. Reusing the
   * word was a redeclaration error, and it would have been a reasoning error
   * even if the language had allowed it.
   */
  skipNetwork = false,
} = {}) {
  const probed = typeof fetchImpl === 'function' && skipNetwork !== true;
  const model = readModelConfig(env);
  const media = mediaConfig(env);
  const edit = editConfig(env);
  const image = imageConfig(env);

  // ── plan every network probe, then fire them all at once ─────────────────
  /**
   * ⚠️ `see_page` READS TWO VARIABLES, AND THE REPORT MUST NAME THE ONE IN
   * PLAY. Caught by looking at a live run: with both unset the line read
   * "MODAL_RENDER_AUDIT_URL is unset", which points a new user at the FALLBACK
   * name — a fix that names the wrong variable is worse than no fix, because
   * it gets followed. Primary when nothing is set; the fallback only when the
   * fallback is the one actually carrying the value.
   */
  const renderVar = env.RENDER_AUDIT_URL?.trim() ? 'RENDER_AUDIT_URL'
    : env.MODAL_RENDER_AUDIT_URL?.trim() ? 'MODAL_RENDER_AUDIT_URL'
      : 'RENDER_AUDIT_URL';
  /**
   * ── ⚠️⚠️ `builtIn` — BECAUSE THE ADVICE WAS TELLING PEOPLE TO DO SIX TIMES
   *        THE WORK, AND THE WRONG WORK ─────────────────────────────────────
   *
   * Measured 2026-08-12 on a bare machine: the doctor printed six lines saying
   * "MODAL_TTS_URL is unset → set MODAL_TTS_URL to your endpoint URL", and so on
   * for all five. **Every one of those URLs is already baked into media.mjs as a
   * default.** Nobody needs to set them. `mediaConfig` returns them the moment a
   * SECRET exists (`url(k) || (secret ? fallback : null)`) — so the single real
   * blocker is one credential, and the doctor was sending its reader off to find
   * five endpoint URLs they do not have and cannot guess.
   *
   * ⭐ Wrong advice in a diagnostic is worse than no advice: it is followed. A
   * doctor exists to turn "it does not work" into one action, and this one
   * turned it into five impossible ones.
   *
   * ⚠️ `see_page` IS GENUINELY DIFFERENT and must keep the old message. The
   * renderer has NO baked-in default (see `mediaConfig`: `render` is
   * `url(...)` with no fallback), so there `RENDER_AUDIT_URL` really is the
   * thing to set. One flag distinguishes them so the two can never drift.
   */
  const mediaTargets = [
    { id: 'see_page', label: 'see_page', envVar: renderVar, url: media.render, builtIn: false },
    { id: 'speak', label: 'speak', envVar: 'MODAL_TTS_URL', url: media.speak, builtIn: true },
    { id: 'transcribe', label: 'transcribe', envVar: 'MODAL_TRANSCRIBE_URL', url: media.transcribe, builtIn: true },
    { id: 'make_document', label: 'make_document', envVar: 'MODAL_PRESS_URL', url: media.document, builtIn: true },
    { id: 'read_document', label: 'read_document', envVar: 'MODAL_DOC_READ_URL', url: media.docRead, builtIn: true },
    { id: 'read_table', label: 'read_table', envVar: 'MODAL_TABLE_READ_URL', url: media.tableRead, builtIn: true },
    // ⭐ PROBED SEPARATELY, NOT AS ONE "image editing" LINE. They are two Modal
    // apps, and the failure a person needs to see is "select is dark, so
    // edit_image cannot work while expand_image still can" — a merged line
    // cannot say that.
    { id: 'select', label: 'edit_image (select)', envVar: 'MODAL_SELECT_URL', url: edit.select },
    { id: 'flux', label: 'edit/expand (studio)', envVar: 'MODAL_FLUX_URL', url: edit.flux },
  ];

  const jobs = [];
  const push = (key, run) => { jobs.push(run().then((v) => [key, v], () => [key, { kind: 'unreachable', detail: 'probe failed' }])); };

  if (probed) {
    if (model.configured) {
      push('or.key', () => httpProbe(fetchImpl, OR_KEY_URL, { headers: { authorization: `Bearer ${model.apiKey}` } }, timeoutMs));
      push('or.credits', () => httpProbe(fetchImpl, OR_CREDITS_URL, { headers: { authorization: `Bearer ${model.apiKey}` } }, timeoutMs));
    }
    // ⭐ ONE request answers the whole chain. Calling each model would cost money
    // and prove less: a 404 on an id is a catalogue fact, not a generation fact.
    push('or.models', () => httpProbe(fetchImpl, OR_MODELS_URL, {}, timeoutMs));
    for (const t of mediaTargets) {
      if (t.url && hostOf(t.url)) push(`media.${t.id}`, () => probeMediaEndpoint(fetchImpl, t.url, media.secret, timeoutMs));
    }
    if (image.configured && hostOf(image.base)) {
      // Measured: `GET /health` -> 200 {"ok":true,"browser":"idle"} in ~1s.
      push('image', () => httpProbe(fetchImpl, `${generateEndpoint(image.base).replace(/\/generate$/, '')}/health`, {}, timeoutMs));
    }
  }

  const results = Object.fromEntries(await Promise.all(jobs));

  /**
   * ⚠️ THE OFFLINE VERDICT IS COMPUTED OVER RAW TRANSPORT OUTCOMES, before any
   * of them has been turned into a state. Deciding "offline" from already-red
   * checks would be circular.
   */
  const transportKinds = Object.entries(results).map(([, v]) => (v?.kind ? v : (v?.status !== undefined ? { kind: 'http' } : { kind: 'unreachable' })));
  const offline = probed ? isOffline(transportKinds) : false;

  const sections = [];

  // ── RUNTIME ──────────────────────────────────────────────────────────────
  sections.push({
    id: 'runtime',
    title: 'Runtime',
    checks: [
      checkNodeVersion(nodeVersion, engines === undefined ? readOwnEngines() : engines),
      { id: 'runtime.platform', label: 'platform', state: 'live', verified: true, detail: platform, fix: null },
    ],
  });

  // ── MODEL ────────────────────────────────────────────────────────────────
  const modelChecks = [];
  if (!model.configured) {
    modelChecks.push({
      id: 'model.key',
      label: 'OPENROUTER_API_KEY',
      state: 'dark',
      verified: true,
      detail: 'absent — every model call will refuse before it is sent',
      fix: 'set OPENROUTER_API_KEY (free to create at https://openrouter.ai/keys)',
    });
  } else {
    const p = results['or.key'];
    modelChecks.push(assessKey(p, offline, probed));
    const credits = assessCredits(results['or.credits'], offline, probed, modelChecks[0].state);
    if (credits) modelChecks.push(credits);
  }

  const chain = safeChain(model.model, env);
  const catalogue = catalogueIds(results['or.models']);
  for (const id of chain) {
    modelChecks.push(assessChainModel(id, {
      catalogue,
      primary: id === model.model,
      offline,
      probed,
      configuredVar: env.OPENROUTER_CODEGEN_MODEL ? 'OPENROUTER_CODEGEN_MODEL' : (id === model.model ? 'OPENROUTER_CODEGEN_MODEL' : 'ACUVO_FALLBACK_MODELS'),
    }));
  }
  sections.push({ id: 'model', title: `Model chain (${chain.length} deep · default ${DEFAULT_MODEL})`, checks: modelChecks });

  /**
   * ⭐ A PROPERTY OF THE MODEL, SO IT SITS WITH THE MODEL. Whether the prefix
   * caches decides what a long session costs, and it is knowable for free.
   */
  sections.push({ id: 'cache', title: 'Prompt cache', checks: cacheChecks({ model: model.model, maxRounds }) });

  // ── MEDIA ────────────────────────────────────────────────────────────────
  const mediaChecks = [];
  for (const t of mediaTargets) {
    if (!t.url) {
      /**
       * ⚠️ THE SECRET, NOT THE URL — see `builtIn` above. `explicitlyOff` is the
       * third case and it must not be told to set a variable it already set: an
       * empty `MODAL_TTS_URL=` is a deliberate opt-out on an air-gapped machine,
       * and `media.mjs` honours it on purpose.
       */
      const explicitlyOff = t.envVar in env && String(env[t.envVar] ?? '').trim() === '';
      mediaChecks.push({
        id: `media.${t.id}`,
        label: t.label,
        state: 'dark',
        verified: true,
        detail: explicitlyOff
          ? `${t.envVar} is set to an empty value, which means OFF, so ${t.label} is never offered to the model`
          : (t.builtIn
            ? `no media credential is set, so ${t.label} is never offered to the model (its URL is built in — that part needs nothing from you)`
            : `${t.envVar} is unset, so ${t.label} is never offered to the model`),
        fix: explicitlyOff
          ? `remove the empty ${t.envVar}, or give it a URL, to turn ${t.label} back on`
          : (t.builtIn
            ? 'set ACUVO_MEDIA_SECRET in .env.local — ONE credential turns on speech, transcription, documents and table reading together'
            : `set ${t.envVar} to your endpoint URL (and MODAL_VIDEO_SECRET to the value it expects)`),
      });
      continue;
    }
    const host = hostOf(t.url);
    if (!host) {
      mediaChecks.push({
        id: `media.${t.id}`,
        label: t.label,
        state: 'broken',
        verified: true,
        detail: `${t.envVar} is set but is not a valid URL`,
        fix: `set ${t.envVar} to a full https:// URL`,
      });
      continue;
    }
    /**
     * ⚠️ THE SECRET IS CHECKED BEFORE THE WIRE, because this is the exact
     * configuration that cost the hour: a URL that is set, a secret that is
     * not, four tools OFFERED to the model, and every call answering 200 with
     * a refusal the caller read as transient.
     */
    const probe = probed
      ? (results[`media.${t.id}`] ?? { kind: 'unreachable', detail: 'not probed' })
      : { kind: 'unchecked', detail: 'no network probe was requested' };
    const verdict = assessProbe(probe, { envVar: t.envVar, offline, host });
    if (!media.secret && verdict.state === 'live' && verdict.verified) {
      // Belt and braces: if a service ever stops requiring the secret we still
      // say the variable is missing, because three of the four do require it.
      verdict.detail += ' — note MODAL_VIDEO_SECRET is unset';
    }
    mediaChecks.push({ id: `media.${t.id}`, label: t.label, ...verdict });
  }

  mediaChecks.push(assessImage(image, results.image, offline, probed, env));
  sections.push({ id: 'media', title: 'Media services', checks: mediaChecks });

  // ── TOOLS ────────────────────────────────────────────────────────────────
  const offer = toolOffer({ root, env, allowRun, maxRounds });
  const toolChecks = [{
    id: 'tools.offer',
    label: 'tools offered here',
    state: 'live',
    verified: true,
    detail: `${offer.offered.length} of ${offer.total}${allowRun ? '' : ' (--no-run)'}${maxRounds <= 1 ? ' (single-shot)' : ''}`,
    fix: null,
  }];
  for (const w of offer.withheld) {
    toolChecks.push({ id: `tools.withheld.${w.name}`, label: w.name, state: 'dark', verified: true, detail: w.why, fix: w.fix });
  }
  sections.push({ id: 'tools', title: 'Tool surface', checks: toolChecks });

  /**
   * ⭐ THE OTHER HALF OF THE TOOL SURFACE, AND THE HALF WE DID NOT WRITE. An
   * MCP server is how a user's Linear / Postgres / Sentry becomes reachable, so
   * "is it connected" belongs directly under "what tools exist here".
   *
   * ⚠️ READ ONCE, USED TWICE — the checks below, and the scrub at the very end.
   * A config file is allowed to contain a real credential, and this is the one
   * secret source that is NOT an environment variable, so SECRET_ENV_VARS would
   * never have caught it.
   */
  const mcp = mcpConfigImpl(root);
  /**
   * ⚠️ `offeredCount` IS PASSED SO THE TWO ROWS CANNOT DISAGREE. This line used
   * to let `mcpChecks` quote `TOOL_NAMES.length` while the row above printed
   * `offer.offered.length` — 47 against 34, two lines apart in one report.
   */
  /**
   * ⭐ THE CATALOGUE RIDES IN THE SAME SECTION, DELIBERATELY. A separate
   * "MCP catalogue" heading would be a second place to look for one subject,
   * and the two answers belong side by side: what you HAVE configured, then
   * what you could have. See `mcpCatalogueChecks` for why only servers we ran
   * ourselves appear.
   */
  sections.push({
    id: 'mcp',
    title: 'MCP servers',
    checks: [
      ...mcpChecks(mcp, env, { offeredCount: offer.offered.length }),
      ...mcpCatalogueChecks({ env, root, declaredNames: (mcp?.servers ?? []).map((s) => s.name) }),
    ],
  });

  /**
   * ── ⭐ WHAT THIS AGENT MAY RUN, AND WHAT IT COULD RUN ──────────────────────
   *
   * The write→run→fix loop IS the product, so "can it run your test suite" is
   * the single most consequential fact about a workspace — and it was the one
   * thing doctor did not say. The polyglot presets are built, tested and wired;
   * they are simply OFF until someone opts in, and a capability nobody knows
   * about is worth what an absent one is worth.
   *
   * ⚠️ THE REFUSAL ALREADY TEACHES THIS — it names the preset, the exact JSON
   * and the env var — but only AFTER the model has burned a round discovering
   * it. This is the same sentence, before the round is spent.
   *
   * ⚠️ NEVER PRESENTED AS BROKEN. Four binaries is the deliberate default
   * posture, not a fault; `state: 'live'` with the presets listed as available
   * says "this is what you have and here is more", which is true. Marking it
   * dark would train people to fix something that is working as designed.
   */
  sections.push({ id: 'commands', title: 'What it may run', checks: commandChecks(root, env, readFileImpl) });

  // ── WORKSPACE ────────────────────────────────────────────────────────────
  sections.push({ id: 'workspace', title: 'Workspace', checks: await workspaceChecks(root, gitStatusImpl, readFileImpl, gitTimeoutMs) });

  const flat = sections.flatMap((s) => s.checks);
  const summary = summarise(flat);

  const report = {
    ok: summary.broken === 0,
    generatedAt: now(),
    root,
    platform,
    node: nodeVersion,
    probed,
    offline,
    summary,
    sections,
  };
  /**
   * ⚠️⚠️ THE LAST THING THAT HAPPENS, AND IT IS NOT OPTIONAL. Everything above
   * is written not to hold a credential; this is the guarantee that a service
   * echoing one back at us cannot launder it into the report anyway.
   *
   * ⚠️ AND THE ENVIRONMENT IS NO LONGER THE ONLY PLACE A SECRET LIVES. An
   * `mcp.json` env block routinely holds a real API token typed in by hand —
   * a source `SECRET_ENV_VARS` cannot know about, because these names are the
   * user's, not ours. Placeholders are excluded on purpose: `${GITHUB_TOKEN}`
   * is not a credential, and redacting it would delete the very text the
   * placeholder line needs in order to explain itself.
   */
  const scrubEnv = { ...env };
  const scrubNames = [...SECRET_ENV_VARS];
  if (mcp?.ok) {
    for (const s of mcp.servers ?? []) {
      for (const [k, v] of Object.entries(s.env ?? {})) {
        if (typeof v !== 'string' || envPlaceholderName(v)) continue;
        const name = `mcp:${s.name}:${k}`;
        scrubEnv[name] = v;
        scrubNames.push(name);
      }
    }
  }
  return scrubSecrets(report, scrubEnv, scrubNames);
}

// ── the small assessors, kept separate so each is readable ─────────────────

function safeChain(primary, env) {
  try {
    const c = buildChain(primary, env);
    return Array.isArray(c) && c.length ? c : [primary];
  } catch {
    return [primary];
  }
}

function catalogueIds(probe) {
  if (!probe || probe.kind || !probe.json) return null;
  const data = probe.json?.data;
  if (!Array.isArray(data)) return null;
  return new Set(data.map((m) => m?.id).filter(Boolean));
}

function assessKey(probe, offline, probed) {
  const base = { id: 'model.key', label: 'OPENROUTER_API_KEY' };
  if (!probed) {
    return { ...base, state: 'live', verified: false, detail: 'present — not checked (no network probe was requested)', fix: null };
  }
  if (probe?.kind === 'unreachable') {
    return offline
      ? { ...base, state: 'live', verified: false, detail: 'present — could not check (nothing on this machine reached the network)', fix: 'reconnect and re-run the doctor to verify OPENROUTER_API_KEY' }
      : { ...base, state: 'broken', verified: true, detail: 'present, but openrouter.ai could not be reached while other hosts answered', fix: 'check outbound access to openrouter.ai, then re-check OPENROUTER_API_KEY' };
  }
  if (probe?.status === 401 || probe?.status === 403) {
    /**
     * ⭐⭐ PRESENT AND REVOKED IS THE WORST CASE, and "present" is what every
     * other check in this package tests for. A key that exists and authenticates
     * nothing passes `configured`, passes the offer gate, and fails every call.
     */
    return { ...base, state: 'broken', verified: true, detail: `present, but it does NOT authenticate — the API answered HTTP ${probe.status}. The key is revoked, mistyped, or from another account.`, fix: 'replace OPENROUTER_API_KEY with a working key from https://openrouter.ai/keys' };
  }
  if (probe?.status >= 400) {
    return { ...base, state: 'broken', verified: true, detail: `present, but the key endpoint answered HTTP ${probe.status}`, fix: 'retry; if it persists, replace OPENROUTER_API_KEY from https://openrouter.ai/keys' };
  }
  return { ...base, state: 'live', verified: true, detail: 'present, and it authenticates', fix: null };
}

/**
 * ⭐ ZERO CREDITS IS BROKEN EVEN THOUGH THE KEY IS VALID. Measured on this
 * project before: a key that authenticates against an exhausted balance returns
 * HTTP 402 on every paid model, and the chain spends four attempts discovering
 * it. "Your key is fine" is a true sentence that sends someone the wrong way.
 */
function assessCredits(probe, offline, probed, keyState) {
  const base = { id: 'model.credits', label: 'account balance' };
  if (!probed) return { ...base, state: 'live', verified: false, detail: 'not checked (no network probe was requested)', fix: null };
  if (probe?.kind === 'unreachable') {
    return offline
      ? { ...base, state: 'live', verified: false, detail: 'could not check — nothing on this machine reached the network', fix: 'reconnect and re-run the doctor' }
      : null;
  }
  const d = probe?.json?.data;
  if (!d || typeof d.total_credits !== 'number') {
    // The key line already carries the failure; a second red line about the
    // same cause is noise, not diagnosis.
    return keyState === 'broken' ? null : { ...base, state: 'live', verified: false, detail: 'the balance could not be read', fix: null };
  }
  const left = d.total_credits - (typeof d.total_usage === 'number' ? d.total_usage : 0);
  if (left <= 0) {
    return { ...base, state: 'broken', verified: true, detail: `$${left.toFixed(2)} remaining — the key authenticates but every paid model will answer HTTP 402`, fix: 'top up at https://openrouter.ai/credits, or set OPENROUTER_CODEGEN_MODEL to a :free model' };
  }
  return { ...base, state: 'live', verified: true, detail: `$${left.toFixed(2)} remaining of $${d.total_credits.toFixed(2)}`, fix: null };
}

function assessChainModel(id, { catalogue, primary, offline, probed, configuredVar }) {
  const base = { id: `model.chain.${id}`, label: id + (primary ? '  (primary)' : '') };
  if (!probed || catalogue === null) {
    const why = !probed ? 'not checked (no network probe was requested)'
      : offline ? 'could not check — nothing on this machine reached the network'
        : 'could not read OpenRouter\'s model catalogue';
    return { ...base, state: 'live', verified: false, detail: why, fix: null };
  }
  if (!catalogue.has(id)) {
    /**
     * ⚠️ A RETIRED ID IS A SILENT OUTAGE. It is the failure that sat in the
     * OpenCode integration for weeks: every request answered 404 and three
     * healthy fallbacks were never tried.
     */
    return {
      ...base,
      state: 'broken',
      verified: true,
      detail: 'not in OpenRouter\'s catalogue — every call to this id will 404',
      fix: primary
        ? `set OPENROUTER_CODEGEN_MODEL to a live model id (or unset it to fall back to ${DEFAULT_MODEL})`
        : `remove "${id}" from ${configuredVar}`,
    };
  }
  return { ...base, state: 'live', verified: true, detail: 'in OpenRouter\'s catalogue', fix: null };
}

/**
 * ── ⚠️⚠️ THIS LINE NAMED A HOST THE RUN NEVER CONTACTS ──────────────────────
 *
 * It read `configured (…acuvo-perchance-images-serve.modal.run, the built-in
 * default)` and that host is exactly the one that does NOT get called in the
 * default configuration. Read `generateThroughProviders` (lib/imagegen.mjs:686+)
 * and the chain is:
 *
 *   1. our own GPU engine — only when `engineConfig().configured`, i.e. a URL
 *      AND ACUVO_IMAGE_SECRET. It fails shut otherwise (imagegen.mjs:334-339).
 *   2. `useOwnServer = Boolean(env[PERCHANCE_IMAGE_URL])` — and when that
 *      variable is UNSET the code takes `generateViaNativePerchance`, which
 *      talks to perchance.org directly. `DEFAULT_IMAGE_URL` is the value used
 *      when someone POINTS AT OUR SERVICE, which is the one case where
 *      `usingDefault` is false.
 *   3. Pollinations, always, as the fallback.
 *
 * So the old sentence printed the built-in default precisely in the branch that
 * bypasses it — and it did so because the destination was DERIVED TWICE, once
 * by `imageConfig().base` here and once by `useOwnServer` there. This repo has
 * a memory entry for exactly this shape ("THE REGISTRY NAMES THE WRONG
 * TRANSPORT — musetalk gated on RunPod while MODAL serves it"). Deriving the
 * same fact in two places is what produces the drift; the fix is to read it off
 * the same predicate the run uses.
 *
 * ⚠️ THIS MATTERS MOST TO THE READER IT WAS WRITTEN FOR. ENTERPRISE.md §2.2
 * calls `generate_image`'s egress "easy to miss"; an egress reviewer who
 * allow-lists the host this line named would still see the prompt leave to
 * perchance.org and pollinations.ai. A doctor that misstates a destination is
 * worse than one that says nothing about it.
 *
 * ⚠️ THE PROBE STILL TARGETS `image.base`/health (see the `push('image', …)`
 * call), so on a default configuration it verifies a host the run will not use.
 * That is left alone deliberately — changing what the doctor probes is a
 * behaviour change on the network path — but the wording below no longer lets
 * a reader mistake the probed host for the destination.
 */
function imageDestination(image, env) {
  const engine = engineConfig(env);
  if (engine.configured) {
    const h = hostOf(engine.base);
    return h ? `${h} — our own GPU engine, which the chain tries FIRST` : null;
  }
  const useOwnServer = Boolean((env?.[IMAGE_URL_ENV] || '').trim());
  if (useOwnServer) {
    const h = hostOf(image.base);
    return h ? `${h}, the image service you named in ${IMAGE_URL_ENV}` : null;
  }
  return `perchance.org direct, then image.pollinations.ai — ${IMAGE_URL_ENV} is unset, so neither our GPU engine (no ${ENGINE_SECRET_ENV}) nor ${hostOf(image.base) || 'the built-in service'} is contacted`;
}

function assessImage(image, probe, offline, probed, env = {}) {
  const base = { id: 'media.generate_image', label: 'generate_image' };
  if (!image.configured) {
    return { ...base, state: 'dark', verified: true, detail: `${IMAGE_URL_ENV} is set to an empty value, which means OFF`, fix: `unset ${IMAGE_URL_ENV} to use the default endpoint, or set it to your own image service` };
  }
  const dest = imageDestination(image, env);
  const where = dest ? ` (${dest})` : '';
  if (!probed) return { ...base, state: 'live', verified: false, detail: `configured${where} · not checked (no network probe was requested)`, fix: null };
  if (probe?.kind === 'unreachable') {
    return offline
      ? { ...base, state: 'live', verified: false, detail: `configured${where} · could not check — nothing on this machine reached the network`, fix: `reconnect and re-run the doctor to verify ${IMAGE_URL_ENV}` }
      : { ...base, state: 'broken', verified: true, detail: `configured${where} · unreachable while other services answered`, fix: `check ${IMAGE_URL_ENV}` };
  }
  /**
   * ⚠️ A 404 ON /health IS NOT A DEAD SERVICE. Older deployments of this image
   * server had no health route at all, and condemning them would be a check
   * failing correct work — the mistake this repo has now made six times.
   */
  if (probe?.status === 404) return { ...base, state: 'live', verified: false, detail: `configured${where} · this deployment has no /health route, so it could not be verified`, fix: null };
  /**
   * ⚠️ ONLY AN ANSWER THAT READS AS AN AUTH FAILURE NAMES THE TOKEN. The first
   * draft treated ANY `ok:false` as a credential problem, which sent a reader
   * to set `PERCHANCE_IMAGE_TOKEN` for a service that was complaining about
   * something else entirely — a fix that names the wrong variable is worse than
   * no fix, because it is followed.
   */
  if (probe?.status === 401 || probe?.status === 403 || (probe?.json?.ok === false && readsAsAuthFailure(probe?.json?.error))) {
    return { ...base, state: 'broken', verified: true, detail: `configured${where} · the service refused the credential`, fix: `set ${IMAGE_TOKEN_ENV} to the value the image service expects (it is that service's SHARED_TOKEN — same value, two names)` };
  }
  if (probe?.status >= 400) return { ...base, state: 'broken', verified: true, detail: `configured${where} · HTTP ${probe.status}`, fix: `check ${IMAGE_URL_ENV} points at a running image service` };
  if (probe?.json?.ok === false) {
    return { ...base, state: 'broken', verified: true, detail: `configured${where} · the health route answered: ${String(probe.json.error ?? 'no reason given').slice(0, 120)}`, fix: `check ${IMAGE_URL_ENV} points at a healthy image service` };
  }
  const browser = probe?.json?.browser ? ` — browser ${probe.json.browser}` : '';
  return { ...base, state: 'live', verified: true, detail: `configured${where} · reachable${browser}`, fix: null };
}

const GIT_TIMED_OUT = Symbol('git-timed-out');

/**
 * What `run_command` will actually accept in THIS workspace, and what it could.
 *
 * ⚠️ It asks the real resolver rather than restating the rules. `command.mjs`
 * owns what an allowlist is; a second opinion here would be the copy that goes
 * stale the day someone adds a preset — the same argument search.mjs makes for
 * importing the credential list instead of re-declaring it.
 */
function commandChecks(root, env, readFileImpl) {
  let configText = null;
  try {
    configText = readFileImpl(join(root, COMMANDS_CONFIG_FILE), 'utf8');
  } catch {
    // Absent is the overwhelmingly common case and means "the default four".
    configText = null;
  }

  const resolved = resolveCommandAllowlist({ configText, envValue: env[ALLOW_COMMANDS_ENV] });

  if (!resolved.ok) {
    return [{
      id: 'commands.config',
      label: 'command allowlist',
      state: 'broken',
      verified: true,
      detail: resolved.error,
      // ⚠️ A malformed control stops commands rather than silently reverting to
      // the default — so this is genuinely broken, not merely unset.
      fix: `fix or delete ${COMMANDS_CONFIG_FILE} — a config that cannot be parsed stops every command rather than falling back`,
    }];
  }

  const binaries = [...(resolved.allowlist?.binaries ?? [])];
  const on = resolved.presets ?? [];
  const off = PRESET_NAMES.filter((p) => !on.includes(p));

  const checks = [{
    id: 'commands.allowed',
    label: 'programs it may run',
    state: 'live',
    verified: true,
    detail: binaries.join(', ') + (on.length ? ` · presets on: ${on.join(', ')}` : ' · no presets enabled'),
    fix: null,
  }];

  if (off.length) {
    checks.push({
      id: 'commands.presets',
      label: 'presets available',
      state: 'dark',
      verified: true,
      /**
       * ⭐ THE SENTENCE THAT MATTERS. Someone whose repo is Python sees, before
       * spending a round on a refusal, that the loop CAN run their tests.
       */
      detail: `${off.join(', ')} — off by default, so pytest / go test / cargo test are refused here`,
      fix: `add {"presets": ["${off[0]}"]} to ${COMMANDS_CONFIG_FILE}, or set ${ALLOW_COMMANDS_ENV}=${off[0]}`,
    });
  }

  return checks;
}

async function workspaceChecks(root, gitStatusImpl, readFileImpl, gitTimeoutMs) {
  let status;
  try {
    status = await withTimeout(
      Promise.resolve().then(() => gitStatusImpl(root)),
      gitTimeoutMs,
      GIT_TIMED_OUT,
    );
    if (status === GIT_TIMED_OUT) {
      return [{
        id: 'workspace.git',
        label: 'git',
        state: 'dark',
        verified: true,
        detail: `git did not answer within ${gitTimeoutMs}ms — the doctor stopped waiting rather than hang`,
        fix: 'check for a stale index.lock, or a filesystem/credential helper that is blocking git',
      }];
    }
  } catch (err) {
    return [{
      id: 'workspace.git',
      label: 'git',
      state: 'dark',
      verified: true,
      detail: `git could not be run here — ${err instanceof Error ? err.message : String(err)}`,
      fix: 'install git (git_status / git_diff / git_log / git_commit refuse until then)',
    }];
  }

  if (!status?.ok) {
    return [{
      id: 'workspace.git',
      label: 'git',
      state: 'dark',
      verified: true,
      detail: String(status?.error ?? 'not a git repository').slice(0, 240),
      fix: 'run `git init` here if you want git_status / git_diff / git_log / git_commit to work',
    }];
  }

  const branch = status.branch || '(no commits yet)';
  const count = Array.isArray(status.files) ? status.files.length : 0;
  const checks = [{
    id: 'workspace.git',
    label: 'git',
    state: 'live',
    verified: true,
    /**
     * ⚠️ A DIRTY TREE IS INFORMATION, NOT A FAULT. Flagging uncommitted work as
     * broken would paint every real working session red, and a doctor people
     * learn to ignore is worse than no doctor.
     */
    detail: `repository on ${branch} · ${count === 0 ? 'clean' : `${count} file${count === 1 ? '' : 's'} changed`}`,
    fix: null,
  }];

  let ignore = null;
  try { ignore = readFileImpl(join(root, '.gitignore'), 'utf8'); } catch { ignore = null; }
  const covered = gitignoreCoversAcuvo(typeof ignore === 'string' ? ignore : null);
  checks.push({
    id: 'workspace.gitignore',
    label: `${ACUVO_DIR}/ ignored`,
    state: covered ? 'live' : 'dark',
    verified: true,
    detail: covered
      ? `${ACUVO_DIR}/ is ignored, so sessions and audit logs stay out of your commits`
      : `${ACUVO_DIR}/ is NOT ignored — this CLI writes sessions and audit logs there, inside your repository`,
    fix: covered ? null : `add "${ACUVO_DIR}/" to .gitignore`,
  });
  return checks;
}

// ───────────────────────────────────────────────────────────────────────────
// PURE: THE RENDERING
// ───────────────────────────────────────────────────────────────────────────

const NO_PAINT = { dim: (t) => t, bold: (t) => t, gold: (t) => t, green: (t) => t, red: (t) => t, cyan: (t) => t };

/**
 * ── ⭐ THE OUTPUT IS THE PRODUCT ────────────────────────────────────────────
 *
 * Three words in a fixed column so the eye can scan them, and — the part that
 * matters — a `→` line under every dark or broken check carrying the exact
 * variable or command that fixes it. A reader should never have to leave this
 * screen to know what to do next.
 *
 * ⚠️ COLOUR IS OPT-IN AND REINFORCES A SIGNAL THAT IS ALREADY LEGIBLE. The
 * state words are distinct without it, so a redirected file and a colour-blind
 * reader lose nothing — the rule colour.mjs sets out for the rest of the CLI.
 */
export function formatDoctor(report, { paint = null } = {}) {
  const p = { ...NO_PAINT, ...(paint ?? {}) };
  const r = report ?? {};
  const sections = Array.isArray(r.sections) ? r.sections : [];
  const lines = [];

  lines.push(p.bold('Acuvo Code — doctor'));
  const head = [r.root, r.node ? `node ${r.node}` : null, r.platform].filter(Boolean).join('  ·  ');
  if (head) lines.push(p.dim(head));
  if (r.probed === false) lines.push(p.dim('network probes were not run — every remote line below is configuration only'));
  else if (r.offline) lines.push(p.dim('nothing reached the network: remote lines are marked unverified rather than broken'));
  lines.push('');

  const colourFor = (state) => (state === 'live' ? p.green : state === 'broken' ? p.red : p.gold);

  for (const section of sections) {
    const checks = Array.isArray(section?.checks) ? section.checks : [];
    if (checks.length === 0) continue;
    lines.push(p.bold(String(section.title ?? section.id ?? '').toUpperCase()));
    for (const c of checks) {
      const mark = c.state === 'live' && c.verified === false ? 'live?' : String(c.state ?? '');
      const state = colourFor(c.state)(mark.padEnd(7));
      lines.push(`  ${state} ${String(c.label ?? '').padEnd(26)} ${p.dim(String(c.detail ?? ''))}`);
      if (c.fix) lines.push(`  ${' '.repeat(7)} ${' '.repeat(26)} ${p.gold('→')} ${c.fix}`);
    }
    lines.push('');
  }

  const s = r.summary ?? { live: 0, dark: 0, broken: 0, unverified: 0 };
  lines.push(p.dim(`${s.live} live · ${s.dark} dark · ${s.broken} broken${s.unverified ? ` · ${s.unverified} unverified` : ''}`));
  lines.push(
    s.broken === 0
      ? p.green('nothing is broken.')
      : p.red(`${s.broken} thing${s.broken === 1 ? ' is' : 's are'} broken — each red line above names what fixes it.`),
  );
  return lines.join('\n');
}
