/**
 * ── ⭐⭐⭐ `acuvo --harness codex "<task>"` — THE RUN ────────────────────────
 *
 * Acuvo stays the thing the user ran, the thing that meters, and the thing that
 * supplies the verbs. Codex is an execution backend.
 *
 * ── ⚠️⚠️⭐ THE HONEST PART, WHICH IS THE POINT OF THE WHOLE FILE ───────────
 *
 * There are TWO modes and the difference is money, so the output says which one
 * happened every single time, in one line, unprompted:
 *
 *   · **metered** — we hold the key. `harness-meter.mjs` sits between codex and
 *     the provider, every response's `usage` is recorded through
 *     `budget.record()` exactly like one of our own rounds, and `--budget` can
 *     STOP it at the wire.
 *
 *   · **unmetered** — codex runs on its OWN stored credentials (a ChatGPT
 *     subscription login in `~/.codex/auth.json`). We cannot meter what we do
 *     not carry, so we do not pretend to: the summary says the tokens were
 *     reported by codex and were **not** billed through Acuvo, and `--budget`
 *     is explicitly described as not in force.
 *
 * ⚠️⚠️ THE TEMPTATION IS TO PRINT CODEX'S SELF-REPORTED TOKENS AS IF THEY WERE
 * OURS. They are the same numbers and they are honest numbers, but they are
 * ACCOUNTING, not CONTROL — nothing stopped that spend and nothing could have.
 * Presenting them under the same heading as a metered run would make a runaway
 * bill look supervised, which is worse than showing nothing at all.
 *
 * ── ⚠️ WHAT IS *NOT* TRUE, STATED HERE SO NOBODY RE-DERIVES IT ─────────────
 *
 * Codex 0.130.0 speaks the OpenAI **Responses** API and refuses `wire_api =
 * "chat"` outright. Our own chain (`lib/model.mjs`) is OpenRouter's
 * `/chat/completions`. **So "point codex at our existing model chain" is not a
 * one-line config change and this module does not claim it.** The proxy
 * forwards to a Responses-API endpoint — OpenAI by default, or anything else
 * via `ACUVO_HARNESS_UPSTREAM`. Translating Responses ⇄ chat/completions
 * (reasoning items, tool calls, streaming deltas) is a real piece of work and
 * it is deliberately NOT smuggled in here half-done.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { resolveHarness, createJsonlReader, describeEvent, usageFromEvent, latestUsage, isRealFile } from './harness.mjs';
import { startMeterProxy, DEFAULT_UPSTREAM } from './harness-meter.mjs';
import { detachChild } from './child-lifetime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * ── ⚠️ THREE MEASURED NOISE LINES, NOT A GUESS AT WHAT MIGHT BE NOISY ───────
 *
 *   · "could not update PATH" — codex, whenever CODEX_HOME is a scratch dir;
 *   · "Reading prompt from stdin" — codex narrating exactly what we asked for;
 *   · "SUCCESS: The process with PID … has been terminated." — Windows
 *     `taskkill` announcing codex's ordinary sandbox teardown, which reads to a
 *     user as though something went wrong.
 *
 * ⭐ EVERYTHING ELSE ON STDERR IS SHOWN, and the list is exported so a test can
 * prove a real error is NOT swallowed. A broad `if (looksBoring)` is how a
 * genuine failure ends up hidden behind a tidy transcript.
 */
export const HARNESS_NOISE = Object.freeze([
  /could not update PATH/i,
  /Reading (additional input|prompt) from stdin/i,
  /^SUCCESS: The process with PID \d+ .*has been terminated\.$/i,
]);

/** The env var holding the key the PROXY uses upstream. */
export const UPSTREAM_KEY_ENV = 'ACUVO_HARNESS_KEY';
/** Overrides the Responses-API endpoint the proxy forwards to. */
export const UPSTREAM_URL_ENV = 'ACUVO_HARNESS_UPSTREAM';
/** The variable codex is told to read. It holds a per-run throwaway. */
export const CHILD_KEY_ENV = 'ACUVO_HARNESS_PROXY_KEY';

/**
 * ── ⭐⭐ WHICH MODE ARE WE IN, AND WHY ──────────────────────────────────────
 *
 * A pure function so `test/harness-metering.test.mjs` can pin every branch
 * without a network, a key, or a child process. The `why` string is not
 * decoration — it is what the user is shown, and a mode with no stated reason
 * is a mode nobody can debug.
 */
export function chooseMode(env = process.env) {
  const explicitKey = String(env[UPSTREAM_KEY_ENV] ?? '').trim();
  const explicitUrl = String(env[UPSTREAM_URL_ENV] ?? '').trim();
  if (explicitKey) {
    return {
      metered: true,
      apiKey: explicitKey,
      upstream: explicitUrl || DEFAULT_UPSTREAM,
      why: `${UPSTREAM_KEY_ENV} is set, so Acuvo carries the call and meters it`,
    };
  }
  const openai = String(env.OPENAI_API_KEY ?? '').trim();
  if (openai) {
    return {
      metered: true,
      apiKey: openai,
      upstream: explicitUrl || DEFAULT_UPSTREAM,
      why: 'OPENAI_API_KEY is set, so Acuvo carries the call and meters it',
    };
  }
  return {
    metered: false,
    apiKey: null,
    upstream: null,
    /**
     * ⚠️ THE SENTENCE NAMES THE FIX. A user who wants metering must be told the
     * exact variable, or "unmetered" is a dead end rather than a choice.
     */
    why: `no ${UPSTREAM_KEY_ENV} and no OPENAI_API_KEY, so codex uses its own stored login`,
  };
}

/**
 * Build the codex argv.
 *
 * ⚠️ EVERY VALUE IS OURS EXCEPT THE TASK, AND THE TASK GOES DOWN STDIN. Codex
 * reads instructions from stdin when no prompt argument is given, so the free
 * text a user typed never becomes an argv element — which keeps it away from
 * Windows argv-length limits (~32k) and away from any future code path that
 * might reintroduce a shell. Exported so a test can assert the task is absent.
 */
export function buildCodexArgs({
  cwd,
  proxy = null,
  model = null,
  mcpServerPath = null,
  sandbox = 'workspace-write',
  codexHome = null,
} = {}) {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', sandbox,
    '-C', cwd,
  ];
  if (proxy) {
    /**
     * ⚠️ `wire_api="responses"` IS MANDATORY ON 0.130.0. `"chat"` makes codex
     * exit 1 while loading the config, before any request — measured.
     */
    args.push(
      '-c', 'model_provider="acuvo"',
      '-c', 'model_providers.acuvo.name="Acuvo"',
      '-c', `model_providers.acuvo.base_url=${JSON.stringify(proxy.baseUrl)}`,
      '-c', `model_providers.acuvo.env_key=${JSON.stringify(CHILD_KEY_ENV)}`,
      '-c', 'model_providers.acuvo.wire_api="responses"',
    );
  }
  if (model) args.push('-c', `model=${JSON.stringify(model)}`);
  if (mcpServerPath) {
    /**
     * ── ⭐⭐ OUR VERBS, INSIDE SOMEBODY ELSE'S AGENT ────────────────────────
     *
     * `bin/acuvo-mcp.mjs` already serves the creative verbs behind the spend
     * gate. Registering it here is what makes this an INTEGRATION rather than a
     * shell-out: codex gets Acuvo's capabilities, and the metering that follows
     * those verbs is the one we already built.
     *
     * ⚠️ SPAWNED AS `process.execPath`, NOT `"node"`. The user's PATH `node` may
     * be a different major version than the one running Acuvo, and an MCP server
     * that fails to boot is invisible — codex simply proceeds without the tools.
     */
    /**
     * ── ⚠️⚠️⭐ `--root` IS NOT OPTIONAL, AND OMITTING IT SERVED ZERO TOOLS ───
     *
     * MEASURED 2026-08-30, and it is the pinned memory *"MCP HAS NEVER REACHED
     * A SINGLE BUILD"* happening live: registered without `--root`,
     * `bin/acuvo-mcp.mjs` boots perfectly, answers `tools/list` with `[]`, and
     * prints its own diagnosis — *"NO TOOLS … pass --root <dir> for the
     * workspace tools"*. Codex connected, got an empty tool list, and carried
     * on. The model was offered **14 tools, 0 of them ours**, while this run
     * printed "acuvo verbs offered to the harness over MCP".
     *
     * ⭐ SO THE SERVER WAS NEVER BROKEN AND NEITHER WAS CODEX — the argument
     * was missing, the failure was silent on both sides, and only counting the
     * tools in the request body found it. That is why `runHarness` now COUNTS
     * them (`mcpToolsSeen`) instead of announcing an intention.
     *
     * ⚠️ `--allow-spend` IS DELIBERATELY NOT PASSED. It unlocks the creative
     * verbs, which move money; a harness is not a human, and this package does
     * not let one grant itself a budget. The workspace group is free and is the
     * half that makes Acuvo useful inside somebody else's agent.
     */
    args.push(
      '-c', `mcp_servers.acuvo.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.acuvo.args=[${JSON.stringify(mcpServerPath)},"--root",${JSON.stringify(cwd)}]`,
    );
  }
  return args;
}

/** Where our own MCP server lives, or null if this is a partial checkout. */
export function acuvoMcpPath({ exists = null } = {}) {
  const p = resolvePath(join(HERE, '..', 'bin', 'acuvo-mcp.mjs'));
  if (typeof exists === 'function') return exists(p) ? p : null;
  return p;
}

/**
 * Run a task through an external harness.
 *
 * @param {object} opts
 * @param {string} opts.harness   e.g. 'codex'
 * @param {string} opts.task
 * @param {string} opts.cwd
 * @param {object} [opts.budget]  a `createBudget()` governor. Optional — without
 *                                one the run is unmetered even in metered mode,
 *                                and the summary says so.
 * @returns {Promise<{ok:boolean, code:number|null, mode:string, usage:object[], lines:string[], message?:string}>}
 */
export async function runHarness({
  harness,
  task,
  cwd = process.cwd(),
  env = process.env,
  budget = null,
  model = null,
  write = (s) => process.stdout.write(s),
  paint = null,
  spawnImpl = spawn,
  proxyImpl = startMeterProxy,
  mcp = true,
  timeoutMs = 900_000,
} = {}) {
  const c = paint ?? { dim: (s) => s, bold: (s) => s, green: (s) => s, red: (s) => s, gold: (s) => s, cyan: (s) => s };

  const resolved = resolveHarness(harness, { env });
  if (!resolved.ok) {
    return { ok: false, code: null, mode: 'refused', usage: [], lines: [], message: resolved.message };
  }

  const mode = chooseMode(env);
  const usage = [];
  const lines = [];
  const say = (s) => { lines.push(s); write(`${s}\n`); };

  say(c.bold(`▸ ${resolved.label}`) + c.dim(` — driven by Acuvo, ${mode.metered ? 'metered' : 'UNMETERED'}`));
  say(c.dim(`  ${mode.why}`));

  /**
   * ⚠️⚠️ THE WARNING IS PRINTED BEFORE THE RUN, NOT AFTER. After the spend is a
   * receipt; before it is a choice.
   */
  if (!mode.metered) {
    say(c.gold('  ⚠ --budget is NOT in force for this run.') + c.dim(' Acuvo is not carrying these calls,'));
    say(c.dim(`     so it cannot stop them. Set ${UPSTREAM_KEY_ENV} to route through Acuvo and meter.`));
  }

  /**
   * ⚠️ COUNTED ON THE WIRE, NOT ASSUMED. -1 means "we had no proxy, so we could
   * not look" — which is a different statement from 0 and must not print as one.
   */
  let mcpToolsSeen = mode.metered ? 0 : -1;

  let proxy = null;
  if (mode.metered) {
    proxy = await proxyImpl({
      apiKey: mode.apiKey,
      upstream: mode.upstream,
      onUsage: (u) => {
        usage.push(u);
        /**
         * ⭐⭐ THIS LINE IS THE FEATURE. The external harness's spend goes
         * through the SAME governor as our own rounds — same repricing of a
         * reported zero, same cache ledger, same ceiling.
         */
        if (budget && typeof budget.record === 'function') budget.record(u);
      },
      onRequest: (n) => { mcpToolsSeen = Math.max(mcpToolsSeen, n); },
      gate: () => {
        if (!budget || typeof budget.canContinue !== 'function') return { ok: true };
        const verdict = budget.canContinue();
        if (verdict?.ok === false) {
          return { ok: false, message: `acuvo: ${verdict.message || 'budget reached'} — the harness call was refused before it was sent.` };
        }
        return { ok: true };
      },
    });
    say(c.dim(`  metering proxy on ${proxy.baseUrl} → ${mode.upstream}`));
  }

  /**
   * ⚠️⚠️ NO CLAIM IS MADE HERE ANY MORE. This line used to say "acuvo verbs
   * offered to the harness over MCP" and was printed BEFORE anything had been
   * offered — it was true of our intention and false of the run. The verified
   * count is printed after the run instead, from what the proxy saw.
   */
  /**
   * ⚠️ CHECKED, NOT ASSUMED. `acuvoMcpPath()` computes a path; without the
   * existence test a partial checkout would register an MCP server pointing at
   * a file that is not there, and codex would either fail to start it silently
   * or — with `required` set — refuse the whole run over a missing extra.
   */
  const mcpPath = mcp ? acuvoMcpPath({ exists: isRealFile }) : null;

  const args = [
    ...resolved.args,
    ...buildCodexArgs({ cwd, proxy, model, mcpServerPath: mcpPath }),
  ];

  const childEnv = { ...env };
  if (proxy) childEnv[CHILD_KEY_ENV] = proxy.secret;
  /**
   * ⚠️ THE REAL KEY IS DELETED FROM THE CHILD'S ENVIRONMENT. Property 2 of the
   * proxy's contract is only true if this line exists — otherwise the throwaway
   * secret is beside the thing it was meant to replace.
   */
  if (proxy) { delete childEnv[UPSTREAM_KEY_ENV]; delete childEnv.OPENAI_API_KEY; }

  const reader = createJsonlReader();
  let code = null;
  let timedOut = false;

  await new Promise((done) => {
    const child = spawnImpl(resolved.command, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      /** ⚠️ NEVER `shell: true`. See `harness.mjs` fact 2. */
      shell: false,
    });

    /**
     * ── ⚠️⚠️ THE HARNESS MUST NOT DECIDE WHEN ACUVO EXITS ────────────────────
     *
     * ⭐ THIS LINE WAS ADDED BECAUSE `test/child-lifetime.test.mjs` FAILED AND
     * NAMED THIS FILE. Codex is a long-lived child on three pipes, and each of
     * those four libuv handles holds our event loop open by itself — so without
     * this, `acuvo --harness` could sit there after the work was done, which is
     * indistinguishable from being busy. The guard bit; it was right.
     *
     * ⚠️ UNREF DOES NOT SILENCE OR KILL IT. Events still stream, `close` still
     * fires, and the `await` below is what keeps us alive for the honest
     * reason — a run genuinely in flight — rather than for a stale handle.
     */
    detachChild(child);

    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);

    const onEvents = (list) => {
      for (const item of list) {
        /**
         * ⚠️⚠️ THE NOISE FILTER BELONGS ON *BOTH* STREAMS. Windows `taskkill`
         * inherits codex's STDOUT, so "SUCCESS: The process with PID … has been
         * terminated." arrives here as a non-JSON line — not on stderr, where
         * the obvious reading puts it. Filtering only stderr left it on screen
         * and it reads, to a user, as though the run was killed.
         */
        if (item.kind === 'text') {
          const text = item.text.trim();
          if (text && !HARNESS_NOISE.some((re) => re.test(text))) say(c.dim(`  ${text}`));
          continue;
        }
        const ev = item.event;
        const u = usageFromEvent(ev);
        if (u) {
          /**
           * ⚠️⚠️ ONLY RECORDED WHEN WE ARE *NOT* PROXYING. In metered mode the
           * proxy already recorded this exact round from the wire, and counting
           * it again would double-bill — the round would appear twice in the
           * cache ledger and the ceiling would trip at half the real spend.
           */
          if (!proxy) usage.push(u);
        }
        const d = describeEvent(ev);
        if (!d) continue;
        if (d.level === 'message') say(`  ${d.text}`);
        else if (d.level === 'error') say(c.red(`  ✖ ${d.text}`));
        else if (d.level === 'step') say(c.dim(`  · ${d.text}`));
        else say(c.dim(`  · ${d.text}`));
      }
    };

    child.stdout.on('data', (d) => onEvents(reader.push(d)));
    /**
     * ⚠️ PER LINE, NOT PER CHUNK. A single stderr `data` event routinely carries
     * several lines, so testing the whole chunk against an anchored pattern
     * silently shows all of them the moment two arrive together — which is
     * exactly when a real error is sitting next to a noise line.
     */
    child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        const text = line.trim();
        if (!text || HARNESS_NOISE.some((re) => re.test(text))) continue;
        say(c.dim(`  ${text}`));
      }
    });
    child.on('error', (err) => {
      say(c.red(`  ✖ could not start ${resolved.label}: ${err.message}`));
      clearTimeout(timer);
      code = -1;
      done();
    });
    child.on('close', (c2) => {
      onEvents(reader.flush());
      clearTimeout(timer);
      code = c2;
      done();
    });

    /** The task goes down stdin — never argv. See `buildCodexArgs`. */
    child.stdin.end(String(task ?? ''));
  });

  if (proxy) await proxy.close();

  /**
   * ⚠️ TWO DIFFERENT FOLDS — see `foldHarnessUsage` at the bottom of this file
   * for which source sums and which does not. It is a function rather than six
   * lines here because the audit record reads the same numbers, and two places
   * folding one ledger is how the terminal and `acuvo spend` start disagreeing.
   */
  const { counted, ...totals } = foldHarnessUsage(usage, { metered: Boolean(proxy) });

  /**
   * ⭐ THE VERIFIED SENTENCE. Three distinct states, three distinct wordings —
   * and "we did not look" is never allowed to render as "none arrived".
   */
  if (mcpPath && mcpToolsSeen > 0) {
    say(c.dim(`  ${mcpToolsSeen} acuvo verbs reached the harness over MCP`));
  } else if (mcpPath && mcpToolsSeen === 0) {
    say(c.gold('  ⚠ the acuvo MCP server was registered but served no verbs to the harness'));
  } else if (mcpPath) {
    say(c.dim('  acuvo MCP server registered (unmetered runs cannot verify what it served)'));
  }

  if (counted.length) {
    const cacheRate = totals.prompt > 0 ? Math.round((totals.cached / totals.prompt) * 100) : 0;
    const shape = `${totals.prompt.toLocaleString()} in (${cacheRate}% cached) · ${totals.completion.toLocaleString()} out`;
    if (proxy) {
      say(c.green(`  ✓ metered through Acuvo: ${shape}`));
      if (budget && typeof budget.report === 'function') {
        try { say(c.dim(`  ${budget.report()}`)); } catch { /* a report is never worth a crash */ }
      }
    } else {
      /**
       * ⚠️⚠️ THE EXACT WORDING MATTERS. These are real numbers that Acuvo did
       * not carry, and the sentence has to say both halves or it is a lie of
       * omission.
       */
      say(c.gold(`  ⚠ reported by ${resolved.label}, NOT billed through Acuvo: ${shape}`));
    }
  } else if (mode.metered) {
    say(c.dim('  no usage was reported by the provider for this run'));
  }

  if (timedOut) {
    return { ok: false, code, mode: mode.metered ? 'metered' : 'unmetered', usage, lines, message: `the harness exceeded ${Math.round(timeoutMs / 1000)}s and was stopped` };
  }
  return { ok: code === 0, code, mode: mode.metered ? 'metered' : 'unmetered', usage, lines };
}

/**
 * ── ⚠️⚠️ TWO DIFFERENT FOLDS, BECAUSE THE TWO SOURCES MEAN DIFFERENT THINGS ─
 *
 * The PROXY sees one `response.completed` per HTTP request, each carrying that
 * request's own usage — so those SUM.
 *
 * Codex's own `turn.completed` carries the thread's RUNNING TOTAL (see
 * `usageFromEvent`), so those must NOT sum; the last reading is the answer.
 * Getting this backwards is invisible on a one-turn run and over-reports on
 * every longer one.
 *
 * ── ⭐⭐ WHY IT IS A FUNCTION AND NOT SIX LINES INSIDE `runHarness` ─────────
 *
 * Because TWO surfaces now read it: the summary line the user sees, and the
 * audit record `acuvo spend` adds up. CLAUDE.md's rule for exactly this shape —
 * *"derive it ONCE and share the predicate"* — exists because the alternative
 * has already shipped here twice: two places holding one opinion is how the
 * terminal and the ledger end up disagreeing about what a run cost, and the
 * one that disagrees silently is the one nobody re-reads.
 *
 * @param {object[]} usage
 * @param {{ metered?: boolean }} opts  `metered` means a proxy saw the wire.
 */
export function foldHarnessUsage(usage = [], { metered = true } = {}) {
  const list = Array.isArray(usage) ? usage : [];
  const counted = metered ? list : [latestUsage(list)].filter(Boolean);
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  /**
   * ⚠️ COUNTED SEPARATELY FROM `cached`, and the difference is the whole point:
   * a provider that omits `cached_tokens` is not a provider that cached zero.
   * `audit.mjs` and `spend.mjs` both refuse to fold an unknown into a zero, and
   * a cache reading assembled here must obey the same rule or the ledger's
   * honesty stops at the door of the one backend we do not own.
   */
  let cacheRoundsReported = 0;
  let cacheRoundsUnknown = 0;
  for (const u of counted) {
    prompt += u?.prompt_tokens ?? 0;
    completion += u?.completion_tokens ?? 0;
    const c = u?.prompt_tokens_details?.cached_tokens;
    if (typeof c === 'number' && Number.isFinite(c)) { cached += c; cacheRoundsReported += 1; }
    else cacheRoundsUnknown += 1;
  }
  return { counted, prompt, completion, cached, rounds: counted.length, cacheRoundsReported, cacheRoundsUnknown };
}

/**
 * ── ⭐⭐⭐ THE HARNESS SPEND, IN THE ONE BOOK EVERYTHING ELSE READS ─────────
 *
 * ⚠️⚠️ THIS IS THE "BUILT AND UNREACHED" DEFECT IN ITS PUREST FORM. `--harness`
 * metered every round through the same governor as our own loop — correctly,
 * provably, with a test pinning the wiring — and then the process exited
 * WITHOUT WRITING A RECORD. So `acuvo spend` could not see a cent of it, and
 * neither could `--fleet-budget`, whose entire ledger is that same audit
 * directory (`lib/fleet-budget.mjs` has no second book on purpose). Seven
 * terminals could each drive codex all night and the fleet ceiling would read
 * zero the whole time.
 *
 * ⭐ NOTHING HERE CHANGES WHAT IS BILLED. `budget.record()` already ran, at the
 * wire, per response; this only writes down the total that governor already
 * holds. It is a receipt, not a charge.
 *
 * ── ⚠️⚠️ AND AN UNMETERED RUN RECORDS A *NULL* COST, NOT A NUMBER ──────────
 *
 * Codex's self-reported tokens are honest numbers that Acuvo did not carry —
 * this module's own header refuses to print them under the metered heading for
 * exactly that reason, and pricing them into the ledger would be the same lie
 * with a longer life: a runaway bill would look supervised in the one report a
 * payer checks because they do not trust their memory. `spend.mjs` already
 * counts a null cost as UNKNOWN and prints it on its own line — *"not counted
 * above, and not zero"* — which is the true sentence about an unmetered run,
 * already written, already tested, and previously unreachable from here.
 *
 * ⭐ PURE. No filesystem, no child process, so every branch is pinnable for $0.
 *
 * @param {{ harness: string, result: object, model?: string|null, budget?: object|null }} args
 * @returns {object|null} an outcome in `report.mjs`'s `toJson` shape, or null
 *   when there is nothing to record (a refusal — the harness never started).
 */
export function harnessAuditOutcome({ harness, result, model = null, budget = null } = {}) {
  if (!result || result.mode === 'refused') return null;
  const metered = result.mode === 'metered';
  const fold = foldHarnessUsage(result.usage, { metered });

  /**
   * ⚠️ THE GOVERNOR'S OWN TOTAL, NOT A SECOND PRICING OF THE SAME TOKENS.
   * `budget.record()` reprices a reported zero, honours free legs and keeps the
   * cache ledger; re-deriving a dollar figure from `fold` here would be a
   * second opinion beside a derived value, which is the failure mode CLAUDE.md
   * names by that exact phrase.
   */
  let modelUsd = null;
  if (metered && budget && typeof budget.stats === 'function') {
    try {
      const s = budget.stats();
      if (typeof s?.spentUsd === 'number' && Number.isFinite(s.spentUsd)) modelUsd = s.spentUsd;
    } catch { /* a receipt is never worth failing a finished run for */ }
  }

  /**
   * ⚠️ `null` WHEN THE PROVIDER SAID NOTHING ABOUT CACHING, never a zeroed
   * object — `report.mjs` makes the same distinction for our own rounds and a
   * consumer reading `hitRate: 0` cannot tell "cached nothing" from "did not
   * say". Roman's first MVP point is the cache, so the one backend where we
   * cannot see it must say so rather than report a confident zero.
   */
  const cache = fold.cacheRoundsReported > 0 && fold.prompt > 0
    ? {
        promptTokens: fold.prompt,
        cachedTokens: fold.cached,
        hitRate: fold.cached / fold.prompt,
        firstRound: null,
        roundsReported: fold.cacheRoundsReported,
        roundsUnknown: fold.cacheRoundsUnknown,
      }
    : null;

  return {
    ok: result.ok === true,
    /**
     * ⚠️ THE MODEL THAT WAS ASKED FOR, AND `null` IS THE TRUTH WHEN NOBODY
     * NAMED ONE — codex then picks its own default and we genuinely do not know
     * which. Inventing `codex` here would put a harness name in a field every
     * report reads as a model id.
     */
    model: model ?? null,
    roundsUsed: fold.rounds,
    maxRounds: null,
    /**
     * ⭐ THE FIELD THAT SAYS THIS WAS NOT OUR LOOP. Without it a harness run is
     * indistinguishable in the ledger from one of our own — same shape, same
     * keys — and the two have completely different guarantees behind their
     * numbers. `stoppedBecause` already carries free-form reasons, so this
     * costs no schema change and no version bump.
     */
    stoppedBecause: `harness:${harness}:${metered ? 'metered' : 'unmetered'}`,
    note: result.message ?? null,
    allowRun: true,
    promisedButMissing: [],
    usage: fold.rounds > 0
      ? {
          // ⚠️ ABSENT, not zero, on an unmetered run. See the header above.
          ...(modelUsd === null ? {} : { cost: modelUsd }),
          total_tokens: fold.prompt + fold.completion,
          cache,
        }
      : null,
  };
}
