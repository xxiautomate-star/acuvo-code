/**
 * ── ⭐⭐⭐ THE ROUND SCHEDULER — WHICH TOOL CALLS MAY RUN AT THE SAME TIME ────
 *
 * `turn.mjs` dispatches a round with `for (const call of calls)` and awaits each
 * one. The system prompt has been telling the model the opposite for months —
 * *"Tool calls in one response all run together, so batch every read that does
 * not depend on another: git_status AND git_diff together"* (`turn.mjs:699`) —
 * and that sentence was simply not true. This module is the half of the fix
 * that has to exist FIRST: the decision about what is SAFE to overlap, made as
 * a pure function, before any `Promise.allSettled` is allowed near the loop.
 *
 * ── ⚠️⚠️ THE RULE IS NOT "READS ARE SAFE". THAT RULE IS TRUE AND USELESS ─────
 *
 * Safety is necessary and it is not sufficient, and the measurement is what
 * says so. MEASURED on this repo, 2026-09-01, through the real dispatcher, by
 * counting how many event-loop ticks pass while a verb runs:
 *
 *     verb            ticks      ms    what that means
 *     read_file           0     0.8    SYNCHRONOUS
 *     list_dir            0     2.2    SYNCHRONOUS
 *     find_symbol         0    11.6    SYNCHRONOUS
 *     find_files          0   153.2    SYNCHRONOUS  ← and slow
 *     search_text         0   476.9    SYNCHRONOUS  ← and VERY slow
 *     git_status    139,910   225.6    async
 *     git_log       124,765   192.4    async
 *     git_diff       99,172   276.8    async
 *
 * ⭐ ALMOST EVERY LOCAL READ VERB IN THIS CLI IS SYNCHRONOUS. `search.mjs` says
 * why in its own header — it is `readdirSync`/`readFileSync` on purpose, because
 * shelling to ripgrep would mean adding a binary to an allowlist that
 * deliberately holds four. That is the right call for the reasons given, and it
 * has a consequence nobody had written down: **`Promise.all` over a synchronous
 * function is not concurrency.** It is the same work, in the same order, with a
 * promise wrapper on it.
 *
 * ⚠️⚠️ AND IT IS WORSE THAN NEUTRAL — MEASURED, NOT REASONED:
 *
 *     group                          serial   parallel   speedup
 *     git_status+git_log+git_diff    584.8ms   287.0ms     2.04x   ← the win
 *     git_status+git_log             354.6ms   237.0ms     1.50x
 *     find_files x2                  834.5ms   656.0ms     1.27x
 *     search_text x2                3224.3ms  2787.6ms     1.16x
 *     read_file x3                     1.1ms     1.1ms     1.01x   ← nothing
 *     search_text + git_status        528.2ms   574.5ms     0.92x   ← SLOWER
 *
 * That last row is the whole design. A synchronous verb in a concurrent batch
 * does not merely fail to overlap — it OWNS THE EVENT LOOP for its duration and
 * the git subprocess sitting beside it cannot be reaped until it lets go. So
 * the hoistable set is defined by ASYNCHRONY, not by safety alone, and a verb
 * that does not yield is excluded on performance grounds even when it is
 * provably safe.
 *
 * ── ⭐ THE PRIOR ART, AND WHAT IS AND IS NOT TAKEN FROM IT ───────────────────
 *
 * `lib/lease.mjs` is this package's per-PATH lock, and it exists precisely so
 * two workers never write one file. Its GRANULARITY is the right one — a path,
 * not a directory, not a workspace — and that is copied here. Its MECHANISM is
 * not: a lease is acquired at runtime against a filesystem by independent
 * processes, whereas one round's calls are known up front, dispatched by one
 * loop, in one process, in a known order. When the whole schedule is known
 * before anything starts, a STATIC decision beats a runtime lock — nothing can
 * deadlock, nothing goes stale, and the decision unit-tests without a model, a
 * clock or a filesystem.
 *
 * ⚠️ A CALL THAT IS NOT HOISTED IS NOT SKIPPED. Everything runs, in the order
 * the model asked for, with the same results, the same records and the same
 * accounting. Hoisting only means the slow part was already in flight when the
 * dispatcher reached it. That is what makes this additive: at `maxParallel: 1`
 * the schedule is empty and the loop behaves exactly as it did before this file
 * existed, which is the default for anyone who has not opted in.
 *
 * ── 🚀 THE ASSEMBLY QUESTION, ASKED AND ANSWERED WITH A "NO" ────────────────
 *
 * `p-limit` and `p-queue` are both genuinely MIT and both solve the half that
 * was never hard — a pool over a set bounded at four is `Promise.allSettled`.
 * The hard half is deciding which calls may see each other's writes, which no
 * library on the registry has heard of. And this package ships
 * `"dependencies": {}` as a promise on the tin; spending it here would be
 * spending it on the easy half.
 */

/**
 * What a call does, and whether overlapping it can possibly pay. The names are
 * about SAFETY AND ASYNCHRONY TOGETHER, because either one alone gives the
 * wrong answer.
 */
export const CALL_KINDS = Object.freeze({
  /** Changes the workspace. Never hoisted; blocks everything after it. */
  MUTATE: 'mutate',
  /** Runs code or holds session state whose ORDER is the point. Never hoisted. */
  EXEC: 'exec',
  /** Waits on a human or on another call's side effect. Never hoisted. */
  BLOCKING: 'blocking',
  /** Read-only AND it yields the event loop. The only hoistable kind. */
  ASYNC_READ: 'async-read',
  /** Read-only and synchronous. Safe, and hoisting it is measurably negative. */
  SYNC_READ: 'sync-read',
});

/** ⚠️ The sentinel for "the whole workspace", not a literal path. */
export const WHOLE_WORKSPACE = '*';

/**
 * ⚠️⚠️ EVERY NAME IN `TOOL_NAMES` MUST APPEAR HERE, and
 * `round-schedule.test.mjs` asserts that against the live registry. An
 * unclassified verb is the exact route by which a write ends up running beside
 * a read of the same file, so the default for an unknown name is `MUTATE` — the
 * most restrictive kind — and a verb added next month is serialised until
 * somebody classifies it deliberately.
 *
 * ⭐ THE `SYNC_READ` ROWS ARE NOT A MISTAKE AND MUST NOT BE "FIXED" TO
 * `ASYNC_READ`. They are read-only and completely safe to overlap; they are
 * excluded because overlapping them was MEASURED at 1.01x–1.27x while
 * simultaneously making a co-scheduled git call 0.92x. If `search.mjs` ever
 * moves to `fs/promises` or a worker, move its verbs here and the schedule
 * widens on its own.
 */
const KINDS = Object.freeze({
  // ── writes to the workspace ───────────────────────────────────────────────
  write_file: 'mutate',
  write_files: 'mutate',
  edit_file: 'mutate',
  delete_file: 'mutate',
  move_file: 'mutate',
  apply_patch: 'mutate',
  git_commit: 'mutate',
  git_branch: 'mutate',
  git_push: 'mutate',
  git_worktree: 'mutate',
  remember: 'mutate',
  forget: 'mutate',
  declare_acceptance: 'mutate',
  // ⚠️ These look like network calls and are not: each one lands a FILE in the
  // workspace, so two of them are two writes.
  generate_image: 'mutate',
  edit_image: 'mutate',
  expand_image: 'mutate',
  generate_video: 'mutate',
  talking_head: 'mutate',
  clone_voice: 'mutate',
  design_voice: 'mutate',
  character_lock: 'mutate',
  speak: 'mutate',
  make_document: 'mutate',
  chart: 'mutate',
  pipe_to_asset: 'mutate',
  syndicate: 'mutate',
  viral: 'mutate',
  podcast: 'mutate',
  vercel_preview: 'mutate',

  // ── runs code, or holds ordered session state ─────────────────────────────
  run_command: 'exec',
  run_program: 'exec',
  evaluate: 'exec',
  repl: 'exec',
  repl_reset: 'exec',
  start_process: 'exec',
  stop_process: 'exec',
  playtest: 'exec',
  check_acceptance: 'exec',
  // ⚠️ `delegate` is a whole agent session with its own dispatcher and its own
  // writes. Parallel delegation is a real feature and it is `lib/parallel.mjs`'s
  // job, where conflicts are DETECTED and reported; it is not this loop's.
  delegate: 'exec',
  // ⚠️ A request is a side effect on somebody else's server, and `POST /users`
  // before the server is up is a different outcome from after.
  call_endpoint: 'exec',
  // ⚠️ Writes the plan file, and the ledger's whole value is its ordering.
  plan_start: 'exec',
  plan_step: 'exec',

  // ── waits on a human, or on another call in this same round ───────────────
  ask_user: 'blocking',
  wait_for_output: 'blocking',

  // ── read-only AND asynchronous: the hoistable set ─────────────────────────
  // Each of these awaits a subprocess or a socket, so the time it spends is
  // time the event loop is free. This is the entire win.
  git_status: 'async-read',
  git_diff: 'async-read',
  git_log: 'async-read',
  fetch_url: 'async-read',
  web_search: 'async-read',
  read_image: 'async-read',
  see_page: 'async-read',
  transcribe: 'async-read',
  read_document: 'async-read',
  read_table: 'async-read',
  list_engines: 'async-read',
  gh_issue: 'async-read',
  gh_pr: 'async-read',
  gh_run: 'async-read',

  // ── read-only and SYNCHRONOUS: safe, and hoisting is measurably negative ──
  read_file: 'sync-read',
  read_lines: 'sync-read',
  read_around: 'sync-read',
  read_skill: 'sync-read',
  list_dir: 'sync-read',
  find_files: 'sync-read',
  search_text: 'sync-read',
  find_symbol: 'sync-read',
  find_definition: 'sync-read',
  find_references: 'sync-read',
  check_types: 'sync-read',
  list_symbols: 'sync-read',
  check_tools: 'sync-read',
  check_process: 'sync-read',
  read_log: 'sync-read',
  summarize_log: 'sync-read',
  list_sessions: 'sync-read',
  plan_status: 'sync-read',
  inspect_db: 'sync-read',
  sample_db_rows: 'sync-read',
  profile_table: 'sync-read',
  inspect_binary: 'sync-read',
  review_code: 'sync-read',
});

/**
 * ⚠️⚠️ AN MCP TOOL IS `mutate`, ALWAYS, AND THAT IS DELIBERATE — it is also the
 * single biggest thing this module leaves on the table, so it is written down
 * rather than left to be discovered.
 *
 * MCP calls are the best hoist candidates in the product: every one is a
 * network or stdio round-trip, so they are exactly the async, slow shape the
 * measurement above rewards, and a round that fans out across three servers is
 * the case where this would pay most. They are excluded because a third-party
 * verb's name tells us NOTHING — `mcp__github__create_issue` and
 * `mcp__github__list_issues` are the same shape to a string matcher, and
 * running the second before the first is a different answer.
 *
 * ⭐ THE UNLOCK IS ALREADY IN THE PROTOCOL AND WE THROW IT AWAY. MCP tool
 * definitions carry `annotations.readOnlyHint` — the server's own declaration
 * that a tool does not mutate — and `mcp.mjs` does not capture it (grepped
 * 2026-09-01: no occurrence of `annotations` anywhere in `lib/`). Capture that
 * hint and this classifier can honestly widen to the tools whose own server
 * says they are reads. Guessing without it would be inventing a safety claim on
 * a stranger's behalf.
 */
export function kindOf(name) {
  if (typeof name !== 'string' || !name) return CALL_KINDS.MUTATE;
  return KINDS[name] ?? CALL_KINDS.MUTATE;
}

/** Every verb this module will ever start early. Exported so a test can pin it. */
export function hoistableVerbs() {
  return Object.keys(KINDS).filter((n) => KINDS[n] === CALL_KINDS.ASYNC_READ).sort();
}

/**
 * Which paths a call reads and which it writes.
 *
 * ⚠️ CONSERVATIVE BY CONSTRUCTION. Anything whose footprint is not obvious from
 * its own arguments is reported as the WHOLE workspace, because the cost of
 * over-reporting is one lost overlap and the cost of under-reporting is a file
 * read at the wrong moment and a model reasoning from bytes that no longer
 * exist.
 */
export function pathsTouched(call) {
  const a = (call && call.args) || {};
  const str = (v) => String(v ?? '').trim();
  const some = (...v) => v.map(str).filter(Boolean);
  /** An empty footprint for a WRITE means "we could not tell", never "none". */
  const namedOrWhole = (paths) => (paths.length ? paths : [WHOLE_WORKSPACE]);
  switch (call?.name) {
    case 'read_file':
    case 'read_lines':
    case 'read_around':
    case 'read_image':
    case 'read_document':
    case 'read_table':
    case 'profile_table':
    case 'inspect_binary':
    case 'find_definition':
    case 'find_references':
    case 'check_types':
    case 'list_symbols':
      return { reads: some(a.path), writes: [] };
    /**
     * ⚠️⚠️ A WRITE WHOSE TARGET WE CANNOT NAME WRITES *EVERYTHING*, NOT NOTHING.
     *
     * FOUND BY THE TEST, not by review: `write_file` with a missing or empty
     * `path` fell to `some(a.path)` → `[]` → "this call writes no paths" → two
     * `git_status` calls were scheduled to start BEFORE it. The empty array is
     * the one answer that is definitely wrong, and it is the answer a filter
     * naturally produces. `namedOrWhole` makes the degradation go the safe way.
     */
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return { reads: [], writes: namedOrWhole(some(a.path)) };
    case 'move_file':
      return { reads: [], writes: namedOrWhole(some(a.from, a.to)) };
    case 'write_files':
      return {
        reads: [],
        writes: namedOrWhole((Array.isArray(a.files) ? a.files : []).map((f) => str(f?.path)).filter(Boolean)),
      };
    case 'apply_patch':
      // The paths live inside a diff we are not going to parse here. Whole tree.
      return { reads: [WHOLE_WORKSPACE], writes: [WHOLE_WORKSPACE] };
    // Path-free: a round-trip with no workspace footprint at all.
    case 'fetch_url':
    case 'web_search':
    case 'list_engines':
    case 'gh_issue':
    case 'gh_pr':
    case 'gh_run':
    case 'see_page':
    case 'transcribe':
      return { reads: [], writes: [] };
    // `git_*` reads the whole tree and the index, and writes nothing.
    case 'git_status':
    case 'git_diff':
    case 'git_log':
      return { reads: [WHOLE_WORKSPACE], writes: [] };
    default: {
      const kind = kindOf(call?.name);
      return kind === CALL_KINDS.MUTATE || kind === CALL_KINDS.EXEC
        ? { reads: [WHOLE_WORKSPACE], writes: [WHOLE_WORKSPACE] }
        : { reads: [WHOLE_WORKSPACE], writes: [] };
    }
  }
}

function intersects(a, b) {
  if (!a.length || !b.length) return false;
  if (a.includes(WHOLE_WORKSPACE) || b.includes(WHOLE_WORKSPACE)) return true;
  return a.some((p) => b.includes(p));
}

/**
 * ⭐ BOUNDED SMALL ON PURPOSE. The win is latency overlap, not fan-out: across
 * 53 recorded real rounds (`.acuvo/sessions/`) the largest round anybody has
 * ever issued was THREE calls, and 36 of the 53 were a single call. A ceiling
 * of four covers every round we have on record with room to spare, and a higher
 * one would only add ways for a burst to trip a provider's rate limit.
 */
export const DEFAULT_MAX_PARALLEL = 4;

/**
 * Decide what this round may start concurrently.
 *
 * ⚠️ THE RULES, IN THE ORDER THEY BITE:
 *  1. Only `async-read` is ever hoisted. Everything else — writes, execs, the
 *     blocking pair, and every synchronous read — stays exactly where it was.
 *  2. A `blocking` or `exec` call is a BARRIER: nothing after it is hoisted.
 *     `ask_user` stops for a human and `run_command` may be what produces the
 *     thing a later read is looking for, so pre-running across one would change
 *     what the later call sees.
 *  3. A call is held if anything EARLIER in the round writes a path it touches.
 *     For `git_status`, which reads everything, that means: held the moment any
 *     write appears before it.
 *  4. At most `maxParallel` calls.
 *  5. Fewer than two survivors ⇒ an EMPTY schedule. One call "in parallel" is
 *     one call, and shipping the concurrency path for it is all risk and no win.
 *
 * @param {{name:string,args:object}[]} calls
 * @param {{maxParallel?:number, hooksEnabled?:boolean}} opts
 * @returns {{hoisted:number[], held:{index:number,name:string,reason:string}[]}}
 */
export function planRound(calls, opts = {}) {
  const maxParallel = Math.max(1, opts.maxParallel ?? DEFAULT_MAX_PARALLEL);
  const list = Array.isArray(calls) ? calls : [];
  const held = [];

  /**
   * ── ⚠️⚠️ A `PreToolUse` HOOK IS A VETO, AND PRE-RUNNING WOULD BYPASS IT ────
   *
   * `hooks.mjs` calls its gate *"THE ONE HOOK THAT CAN SAY NO"*, and
   * `hooks-block-the-tool-call.test.mjs` pins that a refused call never runs.
   * Starting a tool before its gate has answered turns that veto into a
   * post-mortem: the fetch already left the machine, the `gh` subprocess
   * already spawned. A gate with a documented bypass is not a gate.
   *
   * ⭐ SO A WORKSPACE WITH ANY HOOK CONFIGURED GETS THE SERIAL LOOP, FULL STOP.
   * Running the gates concurrently first would work and is not worth it: hooks
   * are rare, the win here is a few hundred milliseconds, and "your security
   * hook runs in a different order once four calls arrive together" is a
   * sentence no one should have to read.
   */
  if (opts.hooksEnabled === true) {
    return { hoisted: [], held };
  }
  if (maxParallel < 2 || list.length < 2) return { hoisted: [], held };

  const hoisted = [];
  const writesSoFar = [];
  let barrier = null;

  for (let i = 0; i < list.length; i++) {
    const call = list[i];
    const kind = kindOf(call?.name);
    const touched = pathsTouched(call);

    if (barrier !== null) {
      if (kind === CALL_KINDS.ASYNC_READ) {
        held.push({ index: i, name: call?.name, reason: `it comes after ${barrier}, which may change what it would see` });
      }
      continue;
    }
    if (kind === CALL_KINDS.MUTATE) {
      writesSoFar.push(...touched.writes);
      continue;
    }
    if (kind === CALL_KINDS.EXEC || kind === CALL_KINDS.BLOCKING) {
      barrier = call?.name ?? 'an earlier call';
      writesSoFar.push(...touched.writes);
      continue;
    }
    if (kind === CALL_KINDS.SYNC_READ) {
      /**
       * ⚠️ NOT AN OVERSIGHT — SEE THE HEADER. Overlapping these was measured at
       * 1.01x–1.27x, and putting one in a batch beside a git call measured
       * 0.92x, i.e. SLOWER than doing nothing. They are recorded as held so
       * `--json` can show why, because "why did it not parallelise my four
       * read_files" is the first question anybody will ask.
       */
      held.push({ index: i, name: call?.name, reason: 'it is synchronous — running it early cannot overlap with anything' });
      continue;
    }
    // From here: async-read.
    if (intersects(touched.reads, writesSoFar) || intersects(touched.writes, writesSoFar)) {
      held.push({ index: i, name: call?.name, reason: 'an earlier call in this round writes what it touches' });
      continue;
    }
    if (hoisted.length >= maxParallel) {
      held.push({ index: i, name: call?.name, reason: `already at the ${maxParallel}-call concurrency ceiling` });
      continue;
    }
    hoisted.push(i);
  }

  if (hoisted.length < 2) {
    for (const i of hoisted) {
      held.push({ index: i, name: list[i]?.name, reason: 'nothing else in this round could run beside it' });
    }
    return { hoisted: [], held };
  }
  return { hoisted, held };
}

/** One line for the transcript. `null` when there is nothing to say. */
export function describeSchedule(schedule, calls) {
  if (!schedule || schedule.hoisted.length < 2) return null;
  const names = schedule.hoisted.map((i) => calls[i]?.name ?? 'tool');
  return `ran ${schedule.hoisted.length} slow calls at once (${names.join(', ')})`;
}

/**
 * Start the hoisted calls concurrently and hand back what settled, keyed by the
 * index the dispatcher will ask for.
 *
 * ⚠️⚠️ `allSettled`, NEVER `all`. `Promise.all` rejects on the first failure and
 * ABANDONS the others still in flight — here that would mean one dead HTTP
 * endpoint silently swallowing a `git_diff` that had already succeeded, and the
 * serial loop it replaces would have kept both. The settled result is handed
 * back verbatim so the dispatcher can re-throw at exactly the point the serial
 * code would have thrown.
 *
 * ⚠️ A thunk may return `null` — the dispatcher declines to pre-run a call it
 * cannot build one for. Those fall through to the serial path untouched, which
 * is why the `< 2` guard is repeated here and not only in `planRound`: after
 * declines there may be nothing left worth overlapping.
 */
export async function runHoisted(indices, thunk) {
  const live = [];
  for (const i of indices ?? []) {
    const fn = thunk(i);
    if (typeof fn === 'function') live.push({ i, fn });
  }
  if (live.length < 2) return new Map();
  const settled = await Promise.allSettled(live.map((x) => x.fn()));
  const out = new Map();
  live.forEach((x, n) => out.set(x.i, settled[n]));
  return out;
}

/** Unwrap a settled result the way the serial code would have: value, or throw. */
export function takeSettled(r) {
  if (r.status === 'rejected') throw r.reason;
  return r.value;
}
