/**
 * ── ⭐⭐ MAKING A PLAN BIND — WHAT THE LEDGER HONESTLY IS TODAY ──────────────
 *
 * Read `plan-ledger.mjs` before this file. Its header is unusually honest and
 * it already contains the verdict, measured rather than argued:
 *
 *   · A dogfood plan on disk, 2026-08-14: six steps, `createdAt` and
 *     `updatedAt` **6 milliseconds apart**, every step still `"todo"` — across
 *     20 rounds and FOUR separate `acuvo` invocations. One of those untouched
 *     steps named a file that had been written, executed and verified.
 *   · An 8-round run: `plan_start` called, work done, `plan: 0/3 done` printed
 *     on every single round, `plan_step` never called once.
 *
 * ⚠️⚠️ SO THE HONEST ANSWER TO "WHAT DOES THE PLAN DO TODAY" IS: **it is a
 * to-do list the model can ignore, and mostly does.** Precisely:
 *
 *   1. `plan_start` writes a decomposition to `.acuvo/plan.json`. It refuses if
 *      an unfinished plan for the same task exists — that refusal IS the resume
 *      primitive and it is genuinely good.
 *   2. One line is appended to the conversation each round (`formatBanner` via
 *      `planBannerFor`): counts, up to three outstanding items, a round
 *      countdown, and a nudge naming `plan_step`.
 *   3. `plan_step` mutates one step's state. `done` is **ASSERTED** — nothing
 *      checks it, by explicit design.
 *   4. The final report prints an OUTSTANDING block.
 *
 * And that is the whole of it. Nothing reads the tool stream. Nothing notices
 * that round 14 is editing files no step mentions. Nothing distinguishes a step
 * marked done over a written file from a step marked done over nothing at all.
 * `stuck.mjs` watches for CIRCLES and is entirely plan-blind: a run that quietly
 * abandons its plan and productively builds the wrong thing is "not stuck", and
 * no part of this package can currently say otherwise.
 *
 * ── ⭐ WHAT THIS MODULE ADDS, AND WHAT IT REFUSES TO ADD ────────────────────
 *
 * Four pure decisions, no state, no I/O, no clock:
 *
 *   · `detectDrift`      — is the run still doing what it said?
 *   · `acceptCompletion` — is a `done` a completion or a claim?
 *   · `reanchorDecision` — what to re-inject, when, and where it may go.
 *   · `reconcile`        — what changed vs what was promised.
 *
 * ⚠️ IT NEVER MARKS, NEVER UNMARKS, NEVER STOPS A RUN AND NEVER GATES A TOOL.
 * `plan-ledger.mjs` is built on `done` being asserted; a coherence layer that
 * quietly started inferring completion from the disk would break the one
 * property that makes the ledger trustworthy, and it would break it in the
 * OPTIMISTIC direction. Everything here returns a verdict plus its evidence and
 * hands the decision to the caller.
 *
 * ⚠️ AND EVERY THRESHOLD LEANS THE SAME WAY `stuck.mjs` LEANS, for the same
 * asymmetry: missing drift costs a few rounds; telling a working run it has
 * drifted costs the user the work, because the model believes the runner and
 * re-plans around it. Every ambiguity here resolves towards "on plan".
 *
 * ⚠️ PURE, WITH NOTHING TO INJECT. No `fetchImpl`, no `spawnImpl`, no `now` —
 * not because they were omitted but because this module reads only the round
 * history the loop already keeps and the plan object `loadPlan` already
 * returned. That is why every branch below is tested with no network, no disk
 * and no API key.
 *
 * ── ⭐ TWO SECTIONS WERE ADDED 2026-08-20, AND THE HEADER ABOVE NOW UNDERSTATES
 *      WHAT IS HERE ─────────────────────────────────────────────────────────
 *
 *   · `driftBannerLine` — the one-line, PERSON-facing version of `driftNudge`.
 *     Added because the wiring in `turn.mjs` reached the model and stopped
 *     there: `renderEvent` has no case for the `plan-drift` event, and
 *     `formatReconciliation` was imported by `turn.mjs` and called nowhere. The
 *     verdicts were correct, bound the model, and were invisible to the user.
 *   · **PLAN MODE** (section 5) — `--plan`: propose read-only, get a human's
 *     yes, then unlock writes. It is in this file rather than a new one because
 *     an approved plan is worthless unless it BINDS, and everything that makes
 *     a plan bind is already here.
 *
 * ⚠️ SECTION 5 IS STILL DEPENDENCY-FREE, but `runPlanGate` takes `propose`,
 * `ask` and `print` as parameters — the model call, the terminal and the output
 * stream, injected rather than reached for. Same property, stated differently:
 * nothing in this file touches the world on its own.
 */

import { changedPaths } from './changed-paths.mjs';
import { outstanding, significantWords } from './plan-ledger.mjs';

/* ══════════════════════════════════════════════════════════════════════════
 * tool vocabulary
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ KEYED ON WHAT HAPPENED, NOT ON THE FAMOUS NAME — `stuck.mjs` says this and
 * says it has been bitten three times (`evaluate`, `check_acceptance`,
 * `run_program` each missing in turn). Anything that spawns a process belongs
 * here, and the list is exported so a test can compare it against the
 * dispatcher rather than trusting that two files stayed in sync.
 *
 * ⚠️ OPEN ITEM, RECORDED RATHER THAN QUIETLY DUPLICATED: `stuck.mjs` keeps its
 * own PRIVATE copy of this set. Two spellings of "a process ran" is exactly the
 * three-way disagreement `changed-paths.mjs` was written to end. The right fix
 * is to hoist one set into a leaf both import — a lead wiring change, not mine
 * to make in a shared checkout, since `stuck.mjs` is not one of my files.
 */
export const RUN_TOOLS = new Set([
  'run_command', 'run_program', 'evaluate', 'check_acceptance', 'repl', 'check_types',
]);

/** Tools whose success means work left this machine, or became a commit. */
export const DELIVER_TOOLS = new Set([
  'git_commit', 'git_push', 'git_branch', 'gh_pr', 'gh_issue',
]);

/** Read-only orientation. ⭐ Named so the drift rule can say out loud that
 *  none of these can ever count as drift, however many of them there are. */
export const ORIENT_TOOLS = new Set([
  'read_file', 'read_lines', 'read_around', 'read_document', 'read_table', 'read_image',
  'search_text', 'find_files', 'find_definition', 'find_references', 'list_symbols',
  'list_dir', 'git_diff', 'git_log', 'git_status', 'docs', 'fetch_url', 'web_search',
  'see_page', 'read_skill', 'plan_status',
]);

/** A shell string that IS a delivery, for runs that shell out instead. */
const DELIVER_COMMAND = /\bgit\s+(?:commit|push)\b|\bgh\s+pr\s+create\b/;

/* ══════════════════════════════════════════════════════════════════════════
 * normalisation
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `src\x.js`, `./src/x.js` and `src//x.js` are one file.
 *
 * ⚠️ CASE IS LEFT ALONE, copying `stuck.mjs`'s reasoning: folding case MERGES
 * two paths, and a merge is the direction that manufactures a false positive.
 */
function normPath(value) {
  if (typeof value !== 'string') return null;
  let s = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+$/, '');
  return s.length ? s : null;
}

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * The name before the FIRST dot, not the last.
 *
 * ⚠️ AND THAT CHOICE IS A FALSE-POSITIVE FIX, NOT A STYLE ONE. Splitting on the
 * last dot makes `store.test.mjs` stem to `store.test`, which matches nothing —
 * so a run that wrote `lib/store.mjs` for step 1 and then `test/store.test.mjs`
 * beside it had the SECOND file counted as unattributed, and three such pairs
 * would have manufactured a drift verdict out of a model doing exactly what it
 * promised plus tests. Splitting on the first dot gives `store` for both.
 */
const primaryStem = (p) => {
  const b = basename(p);
  const dot = b.indexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
};

/**
 * Path-shaped tokens inside a step's prose.
 *
 * ⚠️ DELIBERATELY LOOSE. This feeds ATTRIBUTION, and attribution failing open
 * (a file counted as promised when it was only nearly promised) costs nothing,
 * while attribution failing shut manufactures drift out of ordinary work. So
 * `node.js` in a sentence matches as a "path". That is the cheap direction.
 */
const PATH_TOKEN = /[A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)+|[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,7}/g;

/**
 * ⚠️ SEGMENT MATCHING NEEDS A STOPLIST OR IT ATTRIBUTES EVERYTHING. A step
 * mentioning "lib" would otherwise claim every file under `lib/`, which is the
 * whole tree — attribution so generous it can never report anything, i.e. a
 * check that cannot fail.
 */
const GENERIC_SEGMENTS = new Set([
  'src', 'lib', 'test', 'tests', 'spec', 'app', 'apps', 'dist', 'build', 'out',
  'bin', 'pkg', 'pkgs', 'packages', 'node_modules', 'index', 'main', 'utils',
  'util', 'common', 'shared', 'components', 'scripts', 'tmp', 'temp', 'docs',
]);

/**
 * Everything a step names that could be matched against a real path.
 * @returns {{ paths: string[], basenames: string[], words: Set<string> }}
 */
export function stepTargets(text) {
  const s = String(text ?? '');
  const paths = [];
  const basenames = [];
  const stems = new Set();
  for (const raw of s.match(PATH_TOKEN) ?? []) {
    const p = normPath(raw.replace(/[.,;:)"'`]+$/, ''));
    if (!p) continue;
    if (!paths.includes(p)) paths.push(p);
    const b = basename(p);
    if (b && !basenames.includes(b)) basenames.push(b);
    const st = primaryStem(p).toLowerCase();
    if (st.length >= 3) stems.add(st);
  }
  return { paths, basenames, stems, words: significantWords(s) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * flattening — one ordered event stream, in the shape turn.mjs already keeps
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {Array} rounds `{ round, executed: [{ name, args, result, mutated }] }`
 *
 * ⚠️ EVERY FIELD ABSENT UNTIL PROVEN PRESENT. A provider can emit a tool call
 * whose arguments do not parse; a resumed session can carry an older shape. A
 * coherence check that throws inside the loop it protects is worse than none.
 *
 * ⭐ PATHS COME FROM `changedPaths`, NOT FROM `args.path`. That module exists
 * because three callers each invented their own spelling and one of them
 * silently dropped 44 of 45 files from a bulk write. A fourth spelling here
 * would re-open exactly that bug — and it would do it inside the function whose
 * job is to notice which files changed.
 */
export function flattenRounds(rounds) {
  const events = [];
  if (!Array.isArray(rounds)) return events;
  rounds.forEach((round, roundIndex) => {
    const label = Number.isFinite(round?.round) ? round.round : roundIndex + 1;
    const executed = Array.isArray(round?.executed) ? round.executed : [];
    for (const rec of executed) {
      if (!rec || typeof rec !== 'object') continue;
      if (typeof rec.name !== 'string' || !rec.name) continue;
      const args = (rec.args && typeof rec.args === 'object') ? rec.args : {};
      const result = (rec.result && typeof rec.result === 'object') ? rec.result : {};
      events.push({
        roundIndex,
        label,
        name: rec.name,
        args,
        result,
        ok: result.ok === true,
        mutated: rec.mutated === true,
        paths: changedPaths(rec).map(normPath).filter(Boolean),
        isRun: RUN_TOOLS.has(rec.name),
        isOrient: ORIENT_TOOLS.has(rec.name),
      });
    }
  });
  return events;
}

/** The command string behind a run record, whatever tool produced it. */
function commandOf(ev) {
  if (typeof ev.result.command === 'string') return ev.result.command;
  if (typeof ev.args.command === 'string') return ev.args.command;
  if (Array.isArray(ev.result.argv)) return ev.result.argv.join(' ');
  if (Array.isArray(ev.args.argv)) return ev.args.argv.join(' ');
  return null;
}

/**
 * ⚠️ `ok: true` MEANS THE COMMAND RAN, NOT THAT IT PASSED — `command.mjs` says
 * so itself, and `stuck.mjs` records what reading it the other way costs.
 */
function runFailed(result) {
  if (result?.timedOut === true) return true;
  if (result?.passed === false) return true;
  return Number.isFinite(result?.exitCode) && result.exitCode !== 0;
}

/* ══════════════════════════════════════════════════════════════════════════
 * attribution — which step, if any, does this changed file belong to?
 * ══════════════════════════════════════════════════════════════════════════ */

/** Strongest first. Exported so a test can pin the ORDER, not just the outcome. */
export const ATTRIBUTION_STRENGTHS = ['exact', 'basename', 'stem', 'segment'];

function matchesAt(target, path, strength) {
  switch (strength) {
    case 'exact':
      return target.paths.some((p) => p === path || path.endsWith(`/${p}`) || p.endsWith(`/${path}`));
    case 'basename':
      return target.basenames.includes(basename(path));
    case 'stem': {
      const s = primaryStem(path).toLowerCase();
      // ⚠️ Two characters is noise ("db", "js"); three is where a name starts
      // identifying something — the same threshold `plan-ledger.mjs` picked.
      if (s.length < 3) return false;
      return target.words.has(s) || target.stems.has(s);
    }
    case 'segment': {
      const segs = path.split('/').slice(0, -1);
      return segs.some((s) => s.length >= 3 && !GENERIC_SEGMENTS.has(s.toLowerCase()) && target.words.has(s.toLowerCase()));
    }
    default:
      return false;
  }
}

/**
 * Which planned step does a changed path belong to?
 *
 * ⭐ STRENGTH-ORDERED, NOT PLAN-ORDERED, and the difference is the diagnosis.
 * A run writing `lib/store.mjs` while step 1 says "write lib/store.mjs" and
 * step 4 says "add store tests" must attribute to step 1; scanning steps first
 * would hand it to whichever came earlier and make the reconciliation read
 * wrong even when the verdict is right.
 *
 * @returns {{ id: string, strength: string } | null}
 */
export function attributePath(path, steps) {
  const p = normPath(path);
  if (!p || !Array.isArray(steps)) return null;
  const targets = steps.map((s) => ({ id: s?.id, target: stepTargets(s?.text) }));
  for (const strength of ATTRIBUTION_STRENGTHS) {
    for (const { id, target } of targets) {
      if (id && matchesAt(target, p, strength)) return { id, strength };
    }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. DRIFT
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── ⚠️⚠️ WHERE THE LINE BETWEEN EXPLORATION AND DRIFT ACTUALLY IS ───────────
 *
 * The brief says drift must not fire on legitimate exploration, so here is the
 * line, argued rather than tuned:
 *
 * ⭐ **READING IS NEVER DRIFT. WRITING IS THE ONLY EVIDENCE THAT COUNTS.**
 *
 * A model that reads forty files no step mentions is doing the thing a good
 * agent does first: it cannot know which files matter until it has looked. The
 * files it reads are chosen by the CODE's structure, not by the plan's wording,
 * so "this read touched a file no step named" is not weak evidence of drift —
 * it is no evidence at all, and a detector built on it would fire hardest on
 * the most careful runs. `stuck.mjs` reached the same conclusion from the other
 * side: "a long research phase — many reads, no writes" is pinned there as a
 * NEGATIVE that must never be flagged.
 *
 * A WRITE is different in kind. It is a commitment: rounds spent, a file on
 * disk, a thing the user will have to review. When a run commits repeatedly to
 * files that no step in its own declared plan can be stretched to cover, and it
 * has not touched its ledger while doing so, the run and the plan have stopped
 * describing each other. That is a fact about two documents, not a judgement
 * about intent.
 *
 * ⚠️ AND EVEN THAT NEEDS FOUR CONDITIONS AT ONCE, because each alone has an
 * innocent explanation:
 *
 *   (a) the window contains mutations at all  — otherwise this is exploration,
 *       and the verdict is `exploring`, which is a SEPARATE verdict precisely
 *       so nobody later collapses it into `drifting`;
 *   (b) NOT ONE of those mutations attributes to any step — one stray
 *       `package.json` beside three planned files is ordinary;
 *   (c) at least MIN_UNATTRIBUTED distinct unplanned paths — a single unplanned
 *       file is a helper, three are a different piece of work;
 *   (d) no `plan_step` call in the window — a run maintaining its ledger is
 *       tracking its plan BY DEFINITION, whatever it is writing. This condition
 *       is the one that makes the check safe to ship: the well-behaved run can
 *       never trip it.
 *
 * ⚠️ ONE THING THIS DELIBERATELY CANNOT SEE: a plan whose steps are so vague
 * ("improve the module") that every path attributes to them. Attribution is
 * generous on purpose, so a vague plan produces `on-plan` forever. That is the
 * correct failure direction — a vague plan is a planning problem, and inventing
 * drift out of it would punish the user for the model's wording.
 */
export const DRIFT_WINDOW = 6;
export const DRIFT_MIN_ROUNDS = 4;
export const DRIFT_MIN_UNATTRIBUTED = 3;

export const DRIFT_VERDICTS = ['no-plan', 'insufficient-history', 'plan-complete', 'exploring', 'on-plan', 'drifting'];

const NO_DRIFT = Object.freeze({
  verdict: 'no-plan', drifting: false, evidence: null, suggestion: null,
});

/**
 * Is the run still doing what it said it would?
 *
 * @param {object} args
 * @param {object|null} args.plan   a plan as `loadPlan` returns it
 * @param {Array} args.rounds       the history `runSession` keeps, oldest first
 * @param {number} [args.window]    how many recent rounds to examine
 * @returns {{ verdict: string, drifting: boolean, evidence: object|null, suggestion: string|null }}
 *
 * ⚠️ A CLEAN RESULT CARRIES NO STALE HINT. `suggestion` is null unless
 * `drifting` is true — this repo has already shipped one detector whose
 * all-clear carried a verdict about a page it had never seen.
 */
export function detectDrift({ plan, rounds, window = DRIFT_WINDOW } = {}) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return { ...NO_DRIFT };

  const roundCount = Array.isArray(rounds) ? rounds.length : 0;
  const windowRounds = Number.isFinite(window) && window >= 1 ? Math.floor(window) : DRIFT_WINDOW;
  const events = flattenRounds(rounds);
  const left = outstanding(plan);

  // Always computed, always returned: "which steps have had no activity" is
  // evidence a caller wants even when the verdict is on-plan.
  const stale = staleSteps(plan, rounds);

  const base = (verdict, extra = {}) => ({
    verdict,
    drifting: false,
    evidence: { window: windowRounds, roundsSeen: roundCount, staleSteps: stale, ...extra },
    suggestion: null,
  });

  if (left.length === 0) return base('plan-complete');
  if (roundCount < DRIFT_MIN_ROUNDS) return base('insufficient-history');

  const first = Math.max(0, roundCount - windowRounds);
  const inWindow = events.filter((ev) => ev.roundIndex >= first);

  const markedInWindow = inWindow
    .filter((ev) => ev.name === 'plan_step' && ev.ok)
    .map((ev) => ev.label);

  const attributed = [];
  const unattributed = [];
  const mutatingRounds = new Set();
  for (const ev of inWindow) {
    if (!ev.mutated || ev.paths.length === 0) continue;
    mutatingRounds.add(ev.label);
    for (const p of ev.paths) {
      const hit = attributePath(p, plan.steps);
      if (hit) {
        if (!attributed.some((a) => a.path === p)) attributed.push({ path: p, ...hit, round: ev.label });
      } else if (!unattributed.some((u) => u.path === p)) {
        unattributed.push({ path: p, round: ev.label });
      }
    }
  }

  const extra = {
    markedInWindow,
    attributed,
    unattributed,
    mutatingRounds: [...mutatingRounds],
  };

  // (a) nothing was committed to disk in the window — this is orientation.
  if (mutatingRounds.size === 0) return base('exploring', extra);
  // (d) the ledger is being maintained; whatever it is writing, it is tracking.
  if (markedInWindow.length > 0) return base('on-plan', extra);
  // (b) at least one mutation belongs to a step.
  if (attributed.length > 0) return base('on-plan', extra);
  // (c) one stray file is a helper; three are a different piece of work.
  if (unattributed.length < DRIFT_MIN_UNATTRIBUTED) return base('on-plan', extra);

  const evidence = {
    window: windowRounds,
    roundsSeen: roundCount,
    staleSteps: stale,
    ...extra,
    key: `drift:${unattributed.map((u) => u.path).sort().join(',')}`,
  };
  return {
    verdict: 'drifting',
    drifting: true,
    evidence,
    suggestion: driftSuggestion(plan, evidence),
  };
}

/**
 * Steps that nothing in the whole run can be attributed to.
 *
 * ⚠️ THE WORDING IS THE HONESTY. "No activity observed" is a fact about the
 * tool stream; "not done" would be a claim about the disk that this module has
 * no right to make — `plan-ledger.mjs` had to rewrite its own OUTSTANDING
 * heading for exactly this reason after printing failure it had not observed.
 */
export function staleSteps(plan, rounds) {
  /**
   * ⚠️ IT TAKES `rounds`, NOT the already-flattened events its only caller has
   * to hand. A parameter that accepts either shape needs a sniff test to tell
   * them apart, and a sniff test on an empty array guesses — which is how a
   * function starts returning "nothing is stale" for a run it never looked at.
   * One shape, one meaning, one flatten.
   */
  const events = flattenRounds(rounds);
  const touched = new Set();
  for (const ev of events) {
    if (!ev.mutated) continue;
    for (const p of ev.paths) {
      const hit = attributePath(p, plan?.steps ?? []);
      if (hit) touched.add(hit.id);
    }
  }
  return (plan?.steps ?? [])
    .filter((s) => s.state !== 'done' && !touched.has(s.id))
    .map((s) => ({ id: s.id, text: s.text, state: s.state }));
}

/**
 * ⭐ WRITTEN FOR A MODEL TO ACT ON, and it offers BOTH exits.
 *
 * A drift nudge that only says "get back on plan" is wrong half the time: the
 * commonest cause of drift is a plan that stopped describing the work, not a
 * model that stopped caring. `plan-ledger.mjs` learned this the expensive way —
 * its first nudge named only `plan_step`, and a model that cannot honestly mark
 * anything has no move at all when that is the only offer. So both verbs, and
 * no scolding: an error string is an instruction, and "you have failed" reads
 * as permission to hand back half a job.
 */
function driftSuggestion(plan, evidence) {
  const files = evidence.unattributed.slice(0, 4).map((u) => `\`${u.path}\``).join(', ');
  const more = evidence.unattributed.length > 4 ? `, +${evidence.unattributed.length - 4} more` : '';
  const left = outstanding(plan).slice(0, 3).map((s) => `${s.id} ${s.text}`).join(' · ');
  return `The last ${evidence.window} rounds changed ${files}${more} — none of which any step of the recorded plan names — `
    + `and no step was marked in that time. Still outstanding: ${left}. `
    + `Two honest ways forward: if this work IS the task, call plan_start with the steps you are actually doing so the `
    + `remaining budget is spent against a plan that is true; if the outstanding steps are still what was asked for, do `
    + `the next one now, because the last one on the list is the one that gets lost.`;
}

/**
 * The exact text to append, or null.
 *
 * ⚠️ IT ANNOUNCES ITSELF AS MACHINERY. A bare instruction arriving in the
 * `user` role is indistinguishable from the human changing their mind, and a
 * model that believes the user just spoke re-plans the whole task around it.
 */
export function driftNudge(result) {
  if (!result || result.drifting !== true || typeof result.suggestion !== 'string') return null;
  return `[plan coherence — automatic, not from the user] ${result.suggestion}`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. STEP COMPLETION EVIDENCE
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── ⭐⭐ A `done` WITH NO ARTIFACT IS A CLAIM, NOT A COMPLETION ──────────────
 *
 * Probe 1 run 3 in `plan-ledger.mjs`: the run reported ✔ VERIFIED while a named
 * deliverable was untouched. Probe 3 tasks D and G each spent every round
 * researching, each FOUND the answer, and neither wrote the file they were
 * asked for. In both cases a `plan_step done` would have been accepted without
 * a murmur, because nothing has ever looked.
 *
 * ⭐ SO EVIDENCE IS PER KIND, because the kinds are not comparable:
 *
 *   kind       what counts                         refuses a bare assertion?
 *   ───────    ─────────────────────────────────   ────────────────────────
 *   write      a mutating tool call whose changed   YES
 *              path attributes to this step
 *   command    a run tool that actually ran         YES
 *   deliver    git_commit / git_push / gh_pr, or a  YES
 *              shell command that is one
 *   verify     a run, OR a read of an attributed    YES
 *              path (you must have LOOKED)
 *   research   nothing observable                   NO — and deliberately
 *   unknown    nothing observable                   NO — and deliberately
 *
 * ⚠️⚠️ THE LAST TWO ROWS ARE THE POINT, NOT A GAP. "Decide which library to
 * use", "understand why the test fails" — the deliverable is knowledge and it
 * lives in the model's reply, where this module cannot see it. Refusing those
 * would be a guard that fails correct work, which this package has already
 * shipped four times in one day and written a memory about. So they are
 * accepted, and the result SAYS SO (`evidence: 'assertion'`), which is the
 * difference between a hole and a documented boundary.
 *
 * ⚠️ AND A `write` STEP THAT NAMES NO FILE IS STILL CHECKED, JUST WEAKLY.
 * "implement the retry logic" names nothing to attribute, so we fall back to
 * the weakest true assertion available: a write step in a run that mutated
 * NOTHING AT ALL is provably unfinished. That is the probe-3 shape exactly, and
 * it costs no false positives because any mutation anywhere satisfies it.
 */
export const STEP_KINDS = ['deliver', 'write', 'command', 'verify', 'research', 'unknown'];

/**
 * ⚠️ `git_commit` DOES NOT MATCH `\bcommit\b`. An underscore is a word
 * character, so there is no boundary between `git_` and `commit` — and the
 * single most-cited example in `plan-ledger.mjs`'s header is a step literally
 * named "git_commit". The first draft of this table classified that step as
 * `unknown` and accepted it without evidence: the one step the whole module
 * exists to catch, waved through by a regex detail. Hence the bare
 * alternatives.
 *
 * ⚠️ AND BARE `make` / `build` ARE DELIBERATELY ABSENT. "make it easier to
 * read" and "build the parser" are writing, not running, and classifying them
 * as `command` would refuse them in a session that happened to run nothing —
 * a guard failing correct work. `npm run build` still classifies, via `npm`
 * and `run`.
 */
const KIND_PATTERNS = [
  ['deliver', /\b(?:commit|push|pull\s+request|open\s+a\s+pr|merge|tag|publish|release|deploy)\b|git_commit|git_push|gh_pr/i],
  ['write', /\b(?:writ\w*|creat\w*|add|adds|adding|implement\w*|port\w*|refactor\w*|renam\w*|delet\w*|remov\w*|updat\w*|edit\w*|generat\w*|scaffold\w*|fix\w*|extend\w*|wire\w*|replac\w*|migrat\w*)\b/i],
  ['command', /\b(?:run|runs|running|execut\w*|npm|npx|node|pytest|makefile|lint\w*|typecheck\w*|compil\w*|benchmark\w*|install|test|tests|suite)\b/i],
  ['verify', /\b(?:verif\w*|check\w*|confirm\w*|validat\w*|ensur\w*|prov\w*|measur\w*|inspect\w*)\b/i],
  ['research', /\b(?:research\w*|investigat\w*|read|reads|reading|review\w*|understand\w*|explor\w*|decid\w*|choos\w*|chose|design\w*|identif\w*|figure|compar\w*|assess\w*|audit\w*|plan|survey)\b/i],
];

/**
 * @returns {{ kind: string, kinds: string[] }}
 *
 * ⚠️ `kind` IS THE PRIMARY AND EVIDENCE IS REQUIRED FOR IT ALONE, even though
 * `kinds` often has two entries ("port every file and THEN git_commit"). The
 * conservative alternative — require evidence for every kind detected — refuses
 * a step the moment any half of it is unobservable, and this module's whole
 * safety argument is that it refuses rarely and specifically. `kinds` is
 * exported so a lead with real data can tighten this deliberately rather than
 * by accident.
 *
 * ⚠️ AND `deliver` OUTRANKS `write` ON PURPOSE. The measured failure is that
 * the LAST-listed deliverable dies, and the last-listed deliverable is almost
 * always the commit. A step containing both verbs is the exact shape of probe
 * 4 run 2, where six files were ported and the commit never happened.
 */
export function classifyStep(text) {
  const s = String(text ?? '');
  const kinds = KIND_PATTERNS.filter(([, rx]) => rx.test(s)).map(([k]) => k);
  return { kind: kinds[0] ?? 'unknown', kinds };
}

/**
 * Does the tool stream contain evidence that this step happened?
 *
 * @param {object} args
 * @param {object} args.step     `{ id, text, state }`
 * @param {object} args.plan     needed so attribution can see the OTHER steps
 * @param {Array} args.rounds
 * @returns {{
 *   id: string, kind: string, kinds: string[], accepted: boolean,
 *   evidence: string, paths: string[], rounds: number[],
 *   contradicted: boolean, why: string, remedy: string|null
 * }}
 */
export function acceptCompletion({ step, plan, rounds } = {}) {
  const id = step?.id ?? null;
  const { kind, kinds } = classifyStep(step?.text);
  const events = flattenRounds(rounds);
  const steps = plan?.steps ?? (step ? [step] : []);

  const mine = (p) => attributePath(p, steps)?.id === id;

  const out = (accepted, evidence, why, remedy = null, extra = {}) => ({
    id, kind, kinds, accepted, evidence, why, remedy,
    paths: extra.paths ?? [], rounds: extra.rounds ?? [], contradicted: extra.contradicted === true,
  });

  if (kind === 'research' || kind === 'unknown') {
    return out(true, 'assertion',
      `this step's deliverable is not observable in the tool stream (kind: ${kind}), so the assertion is accepted as-is — `
      + 'refusing it would fail correct work');
  }

  const mutations = events.filter((ev) => ev.mutated && ev.paths.length > 0);
  const myWrites = mutations.filter((ev) => ev.paths.some(mine));

  if (kind === 'write') {
    if (myWrites.length > 0) {
      return out(true, 'file-written', 'a file this step names was written or edited', null, {
        paths: [...new Set(myWrites.flatMap((ev) => ev.paths.filter(mine)))],
        rounds: [...new Set(myWrites.map((ev) => ev.label))],
      });
    }
    const named = stepTargets(step?.text).paths.length > 0;
    if (!named && mutations.length > 0) {
      // The weakest true statement available, and it is still worth making.
      return out(true, 'run-wide-mutation',
        'this step names no file, so it cannot be attributed — but files were written in this run, which is the only '
        + 'check available and it passes');
    }
    return out(false, 'none',
      named
        ? `this step names ${stepTargets(step.text).paths.map((p) => `\`${p}\``).join(', ')} and no tool call in this session wrote or edited it`
        : 'this step asks for something to be written and no file was written or edited in this session at all',
      'write the file, then mark it done — or mark it blocked with a note saying what stopped you, which keeps it in the '
      + 'outstanding list instead of hiding it', { contradicted: false });
  }

  if (kind === 'deliver') {
    const delivered = events.filter((ev) => ev.ok
      && (DELIVER_TOOLS.has(ev.name) || (ev.isRun && DELIVER_COMMAND.test(commandOf(ev) ?? ''))));
    if (delivered.length > 0) {
      return out(true, 'delivered', `${delivered[0].name} succeeded in this session`, null, {
        rounds: [...new Set(delivered.map((ev) => ev.label))],
      });
    }
    return out(false, 'none',
      'this step is a commit, push or PR and no such call succeeded in this session',
      'run it now — this is the step that gets lost when the rounds run out, so do it before anything more interesting');
  }

  if (kind === 'command') {
    const ran = events.filter((ev) => ev.isRun && ev.ok);
    if (ran.length === 0) {
      return out(false, 'none',
        'this step asks for something to be run and no command, program or evaluation ran in this session',
        'run it and read the output — a step like this cannot be finished by describing what the command would print');
    }
    const last = ran[ran.length - 1];
    if (runFailed(last.result)) {
      return out(false, 'contradicted',
        `the last command in this session (\`${commandOf(last) ?? last.name}\`) exited ${last.result.exitCode ?? 'non-zero'}`,
        'fix what it reported and run it again, or mark this step blocked with a note carrying that error — a done over a '
        + 'red command is the exact claim this check exists to catch',
        { contradicted: true, rounds: [last.label] });
    }
    return out(true, 'command-ran', `${last.name} ran and did not fail`, null, { rounds: [last.label] });
  }

  // verify
  const ran = events.filter((ev) => ev.isRun && ev.ok);
  if (ran.length > 0) {
    return out(true, 'command-ran', 'a command ran in this session, which is how a check gets made', null,
      { rounds: [ran[ran.length - 1].label] });
  }
  const looked = events.filter((ev) => ev.isOrient && ev.ok
    && typeof ev.args?.path === 'string' && mine(normPath(ev.args.path) ?? ''));
  if (looked.length > 0) {
    return out(true, 'read-back', 'a file this step names was read back after the work', null, {
      paths: [...new Set(looked.map((ev) => normPath(ev.args.path)))],
      rounds: [...new Set(looked.map((ev) => ev.label))],
    });
  }
  return out(false, 'none',
    'this step asks for something to be checked and nothing was run, and nothing it names was read back',
    'run the check, or read the artifact back and say what you saw — "it should work" is the claim, not the check');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. RE-ANCHORING
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── ⚠️⚠️ THE CONSTRAINT THAT MAKES THIS HARD, WITH THE NUMBER ───────────────
 *
 * A provider's prompt cache is keyed on an EXACT BYTE PREFIX: everything up to
 * the first differing byte is reused at a fraction of the price, and everything
 * from that byte on is paid in full. `lib/plan.mjs` states the consequence
 * flatly — **"the cache rate IS the margin"** — and prices it: blended flash
 * cost is $0.0686/M at 0% cache and $0.0228/M at 85%, so the same product doing
 * the same work costs **2.4x** more with a cold prefix. `plan.mjs` puts a 95M
 * plan at $3.19 at 65% cache and $1.66 at 95%: an 83% margin against a 91% one.
 *
 * ⭐ SO THE OBVIOUS DESIGN IS THE EXPENSIVE ONE, AND IT IS NAMED HERE SO NOBODY
 * RE-PROPOSES IT FROM FIRST PRINCIPLES:
 *
 *   ✗ "keep the goal fresh by rewriting the system prompt each round"
 *   ✗ "edit the original task message to add what is outstanding"
 *   ✗ "insert a reminder just before the last few messages"
 *
 * All three CHANGE A BYTE THAT IS ALREADY IN THE CACHED PREFIX, so every round
 * pays full price for the entire conversation to say one sentence. A design that
 * silently costs 2.4x is a bad design however smart it reads — and the failure
 * is invisible: nothing goes red, the run works, the bill arrives later.
 *
 * ⭐ THE ONE SAFE PLACEMENT IS APPEND-AT-THE-END, and it is safe for a
 * structural reason rather than a lucky one: messages `[0..k]` are untouched, so
 * the cached prefix covering them still matches byte for byte. `turn.mjs`
 * already relies on exactly this for the plan banner and says so: "APPENDED,
 * never inserted… the 97.2% cache hit this loop was built around survives."
 *
 * ⚠️ WHICH LEAVES TOKENS, NOT CACHE, AS THE REAL COST — and it is a compounding
 * one. Every appended anchor is re-sent on every subsequent round for the rest
 * of the run. `turn.mjs` measured the equivalent: a 433-character per-round
 * injection was ~109 tokens A ROUND, ~2,200–2,700 tokens over a 20-round
 * session. So the anchor is RARE and BUDGETED rather than periodic-and-cheap:
 * at most `REANCHOR_MAX_PER_RUN`, never inside `REANCHOR_MIN_GAP` rounds of the
 * last one, never before `REANCHOR_FIRST_ROUND` (the goal is still in immediate
 * context early on, so an anchor there buys nothing).
 *
 * ⭐ AND THE BUDGET IS SPENT WHERE THE MEASURED FAILURE IS. Three triggers earn
 * an anchor, in strength order:
 *
 *   · `compaction` — the strongest by far. Compaction DROPS transcript, which
 *     is the only event that can actually remove the goal from context. (It is
 *     also the one place appending is not merely cheap but necessary: the memory
 *     `project_acuvo_compaction_voids_the_cache` records that compaction frees
 *     ~8% of a transcript and destroys a 50x discount on ~87% of it.)
 *   · `drift` — `detectDrift` said so, with evidence.
 *   · `interval` — nothing is wrong; it has simply been a long time.
 *
 *   · plus `final` — one anchor in the last rounds, EXEMPT from the cap. This is
 *     the probe-4 bug bought directly: 4 of 4 runs consumed the whole budget,
 *     none finished early, and the last-listed deliverable died every time. If
 *     there is one place to spend tokens on a reminder, it is the round before
 *     the wall.
 */
export const REANCHOR_PLACEMENT = 'append-end';
export const REANCHOR_FIRST_ROUND = 6;
export const REANCHOR_MIN_GAP = 8;
export const REANCHOR_MAX_PER_RUN = 3;
/** How close to the wall the one exempt "finish it" anchor fires. */
export const REANCHOR_FINAL_WITHIN = 2;

export const REANCHOR_REASONS = ['compaction', 'drift', 'final', 'interval'];

/**
 * The text of an anchor. Deterministic given its inputs — no clock, no
 * randomness — so a test can assert the bytes and a cache can be reasoned about.
 *
 * ⚠️ IT RESTATES THE GOAL AND THE OUTSTANDING STEPS AND NOTHING ELSE. It is
 * NOT a second banner: `formatBanner` already runs every round with the counts
 * and the countdown. What survives 30 rounds of tool output badly is the TASK
 * ITSELF — the one string the model has not seen since message 1.
 */
export function anchorText(plan, { reason = 'interval', roundIndex, maxRounds } = {}) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;
  const left = outstanding(plan);
  if (left.length === 0) return null;

  const where = Number.isFinite(roundIndex) && Number.isFinite(maxRounds)
    ? ` (round ${roundIndex} of ${maxRounds})`
    : '';
  const lead = {
    compaction: 'the conversation above was compacted, so the original task may no longer be in context',
    drift: 'the recent rounds changed files that no planned step names',
    final: 'the round budget is nearly spent',
    interval: 'it has been a while since the task was stated',
  }[reason] ?? 'restating the task';

  const items = left.map((s) => `  ${s.id} [${s.state}] ${s.text}`).join('\n');
  const tail = reason === 'final'
    ? 'Finish the outstanding items that can still be finished, smallest-risk first, and if one cannot be finished mark it '
      + 'blocked with a note rather than leaving it silent.'
    : 'If these are still the deliverables, do the next one. If they are not, call plan_start with the steps you are '
      + 'actually doing so the rest of the budget is spent against a plan that is true.';

  return `[plan anchor — automatic, not from the user] Re-stating the goal because ${lead}${where}.\n`
    + `TASK: ${plan.task}\n`
    + `STILL OUTSTANDING (${left.length} of ${plan.steps.length}):\n${items}\n`
    + tail;
}

/**
 * Should an anchor be appended this round, and what should it say?
 *
 * ⚠️ THE CALLER OWNS THE STATE. No module-level counter: several workers share
 * this process image in a fleet, and a counter that leaked between runs would
 * silence the anchor for whichever run started second. State in, state out.
 *
 * @param {object} args
 * @param {object|null} args.plan
 * @param {number} args.roundIndex
 * @param {number} [args.maxRounds]
 * @param {{ lastAnchorRound?: number, count?: number, finalDone?: boolean }} [args.state]
 * @param {object|null} [args.drift]            a `detectDrift` result
 * @param {boolean} [args.compactedSinceAnchor] the transcript was compacted
 * @returns {{
 *   reanchor: boolean, reason: string|null, text: string|null,
 *   placement: string, approxTokens: number,
 *   state: { lastAnchorRound: number|null, count: number, finalDone: boolean },
 *   why: string
 * }}
 */
export function reanchorDecision({
  plan, roundIndex, maxRounds, state = {}, drift = null, compactedSinceAnchor = false,
  firstRound = REANCHOR_FIRST_ROUND, minGap = REANCHOR_MIN_GAP, maxPerRun = REANCHOR_MAX_PER_RUN,
  finalWithin = REANCHOR_FINAL_WITHIN,
} = {}) {
  const prev = {
    lastAnchorRound: Number.isFinite(state.lastAnchorRound) ? state.lastAnchorRound : null,
    count: Number.isFinite(state.count) ? state.count : 0,
    finalDone: state.finalDone === true,
  };
  const no = (why) => ({
    reanchor: false, reason: null, text: null,
    placement: REANCHOR_PLACEMENT, approxTokens: 0, state: prev, why,
  });

  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return no('no plan is recorded');
  if (outstanding(plan).length === 0) return no('every step is marked done, so there is nothing to re-anchor to');

  const round = Number.isFinite(roundIndex) ? roundIndex : null;
  if (round === null) return no('no round index was given, so neither the interval nor the wall can be judged');

  const remaining = Number.isFinite(maxRounds) ? maxRounds - round : null;

  /**
   * ⭐ THE FINAL ANCHOR IS CHECKED FIRST AND IGNORES THE CAP. It is the one
   * this whole feature is bought for; spending its tokens is the point.
   */
  if (!prev.finalDone && remaining !== null && remaining <= finalWithin && remaining >= 0) {
    return yes('final', 'the round budget is nearly spent and the last-listed deliverable is the one that dies');
  }

  if (round < firstRound && !compactedSinceAnchor) {
    return no(`round ${round} is inside the first ${firstRound}, where the task is still in immediate context`);
  }
  if (prev.count >= maxPerRun && !compactedSinceAnchor) {
    return no(`${prev.count} anchors already appended, at the ${maxPerRun}-per-run cap; each one is re-sent every later round`);
  }
  if (prev.lastAnchorRound !== null && round - prev.lastAnchorRound < minGap && !compactedSinceAnchor) {
    return no(`the last anchor was round ${prev.lastAnchorRound}, inside the ${minGap}-round minimum gap`);
  }

  if (compactedSinceAnchor) {
    return yes('compaction', 'the transcript was compacted, which is the only event that can remove the goal from context');
  }
  if (drift?.drifting === true) {
    return yes('drift', 'drift was detected with evidence, so restating the goal is the cheapest correction available');
  }
  if (prev.lastAnchorRound === null || round - prev.lastAnchorRound >= minGap) {
    return yes('interval', `nothing is wrong; the task has not been restated for ${prev.lastAnchorRound === null ? round : round - prev.lastAnchorRound} rounds`);
  }
  return no('no trigger fired this round');

  function yes(reason, why) {
    const text = anchorText(plan, { reason, roundIndex: round, maxRounds });
    if (!text) return no('there is nothing outstanding to restate');
    return {
      reanchor: true,
      reason,
      text,
      placement: REANCHOR_PLACEMENT,
      // ⚠️ A ROUGH DIVISOR, LABELLED ROUGH. ~4 chars/token is the usual English
      // approximation and it is here so a caller can BUDGET, not so anyone can
      // quote it as a measurement.
      approxTokens: Math.ceil(text.length / 4),
      state: {
        lastAnchorRound: round,
        count: prev.count + 1,
        finalDone: prev.finalDone || reason === 'final',
      },
      why,
    };
  }
}

/**
 * ── ⭐ THE GUARD THAT MAKES THE CACHE ARGUMENT TESTABLE ─────────────────────
 *
 * The whole re-anchoring design rests on one claim — "we only ever append" —
 * and a claim nothing checks is a comment. This proves it about a real message
 * array: every message that existed before must still be there, in the same
 * order, byte-identical.
 *
 * ⚠️ IT COMPARES SERIALISED CONTENT, NOT OBJECT IDENTITY. A caller that
 * rebuilds an equal message object has not broken the cache; a caller that
 * changes one character of an earlier one has, and identity comparison would
 * report those two the wrong way round.
 */
export function wasAppendOnly(before, after) {
  const a = Array.isArray(before) ? before : [];
  const b = Array.isArray(after) ? after : [];
  /**
   * ⚠️ THERE IS NO `b.length < a.length` EARLY RETURN HERE, AND THERE USED TO
   * BE. Mutation testing could not kill it: disabling the line left all 39
   * tests green, because a truncated array makes the loop below compare a real
   * message against `undefined`, whose key is `[null,null,null,null]` and never
   * matches. A line no test can kill is a line whose absence changes nothing,
   * and keeping it would have been a guard that only LOOKED load-bearing.
   * Truncation is still refused — `wasAppendOnly proves the claim…` pins it.
   */
  const key = (m) => JSON.stringify([m?.role ?? null, m?.content ?? null, m?.tool_calls ?? null, m?.tool_call_id ?? null]);
  for (let i = 0; i < a.length; i += 1) {
    if (key(a[i]) !== key(b[i])) return false;
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. RECONCILIATION
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── ⭐⭐ WHAT CHANGED vs WHAT I PROMISED ────────────────────────────────────
 *
 * The final report can already print what was PLANNED (`formatLedger`). It has
 * never been able to print what was DONE, because nothing joined the ledger to
 * the tool stream. This is that join, and its headline is the number nobody has
 * ever been shown: **how many of the steps marked done have any evidence.**
 *
 * ⚠️ IT ANSWERS "FINISHED?", NEVER "CORRECT?" — the same wall `formatLedger`
 * keeps, for the same reason. A file being written is not the same as the file
 * being right, and the moment this block appears to have judged correctness it
 * becomes the ✔ VERIFIED over an untouched deliverable that started all of this.
 */
export function reconcile({ plan, rounds } = {}) {
  if (!plan || !Array.isArray(plan.steps)) {
    return {
      ok: false, promised: 0, markedDone: 0, evidenced: 0, claimed: [],
      steps: [], unpromised: [], note: 'no plan was recorded for this run, so there is nothing to reconcile against',
    };
  }
  const events = flattenRounds(rounds);

  const steps = plan.steps.map((step) => {
    const verdict = acceptCompletion({ step, plan, rounds });
    return {
      id: step.id,
      text: step.text,
      state: step.state,
      kind: verdict.kind,
      accepted: verdict.accepted,
      evidence: verdict.evidence,
      paths: verdict.paths,
      rounds: verdict.rounds,
      contradicted: verdict.contradicted,
      why: verdict.why,
      remedy: verdict.remedy,
    };
  });

  const changed = [];
  for (const ev of events) {
    if (!ev.mutated) continue;
    for (const p of ev.paths) {
      if (changed.some((c) => c.path === p)) continue;
      const hit = attributePath(p, plan.steps);
      changed.push({ path: p, round: ev.label, step: hit?.id ?? null, strength: hit?.strength ?? null });
    }
  }

  const markedDone = steps.filter((s) => s.state === 'done');
  const claimed = markedDone.filter((s) => !s.accepted);

  return {
    ok: true,
    promised: steps.length,
    markedDone: markedDone.length,
    /** Marked done AND the tool stream backs it. The only honest "done" count. */
    evidenced: markedDone.length - claimed.length,
    /** ⭐ THE MONEY LIST: asserted, unevidenced. */
    claimed,
    outstandingSteps: steps.filter((s) => s.state !== 'done'),
    steps,
    changed,
    /** Files this run wrote that no step promised. Not an accusation — often a
     *  test, a lockfile or a fixture — but the user is entitled to the list. */
    unpromised: changed.filter((c) => c.step === null).map((c) => c.path),
    note: null,
  };
}

const MARK = { done: '✓', doing: '→', blocked: '✗', todo: '·' };

/** The printable block. Lines, so the caller decides about colour and width. */
export function formatReconciliation(rec) {
  if (!rec?.ok) return [`RECONCILIATION — ${rec?.note ?? 'nothing to reconcile'}`];

  const lines = ['RECONCILIATION — what changed vs what was promised'];
  lines.push(`  promised ${rec.promised} · marked done ${rec.markedDone} · evidenced ${rec.evidenced} · `
    + `asserted without evidence ${rec.claimed.length} · unpromised files ${rec.unpromised.length}`);

  for (const s of rec.steps) {
    const mark = s.state === 'done' && !s.accepted ? '!' : (MARK[s.state] ?? '·');
    const where = s.paths.length ? ` — ${s.paths.slice(0, 3).join(', ')}` : '';
    const note = s.state === 'done' && !s.accepted ? ` — MARKED DONE, but ${s.why}` : where;
    lines.push(`  ${mark} ${String(s.id).padEnd(3)} [${s.kind}] ${s.text}${note}`);
  }

  if (rec.unpromised.length) {
    lines.push('');
    lines.push(`  changed but promised by no step: ${rec.unpromised.slice(0, 10).join(', ')}`
      + (rec.unpromised.length > 10 ? `, +${rec.unpromised.length - 10} more` : ''));
  }

  lines.push('');
  lines.push('(this compares the ledger against the tool calls that actually ran — it says nothing about whether the '
    + 'finished work is correct)');
  return lines;
}

/**
 * ── ⭐⭐ THE ONE-LINE VERSION, FOR THE PERSON RATHER THAN THE MODEL ──────────
 *
 * `driftNudge` above is written for a model: it offers both exits, names the
 * verbs, and refuses to scold. It is also 400-odd characters and it goes into
 * the CONVERSATION, where the user never sees it.
 *
 * ⚠️⚠️ AND THAT WAS THE WHOLE OF THE VISIBILITY STORY UNTIL NOW. Measured
 * 2026-08-20 against the wired loop: `turn.mjs` emits `{ type: 'plan-drift' }`
 * every time a distinct drift is detected, `renderEvent` has NO case for that
 * type and returns `[]`, and `formatReconciliation` is imported on line 64 and
 * called nowhere. So both verdicts bound the model, both were computed
 * correctly, and the person paying for the run saw neither of them.
 *
 * ⚠️ ONE LINE, AND ONLY ON `drifting`. Every other verdict returns null. This
 * file's own rule about clean results carrying no stale hint applies double to
 * a terminal: a banner that also fires on `on-plan` and `exploring` is a line
 * per round saying nothing is wrong, which is how people learn to skim the one
 * round where something was.
 *
 * ⚠️ AND IT NAMES FILES, NOT COUNTS. "3 unattributed writes" is a number a user
 * cannot act on; `notes/scratch1.md` is the fact that makes them say either
 * "yes, that is the task" or "stop".
 */
export function driftBannerLine(result) {
  if (!result || result.drifting !== true) return null;
  const ev = result.evidence;
  if (!ev || !Array.isArray(ev.unattributed) || ev.unattributed.length === 0) return null;

  const files = ev.unattributed.slice(0, 3).map((u) => u.path).join(', ');
  const more = ev.unattributed.length > 3 ? ` +${ev.unattributed.length - 3} more` : '';
  const stale = Array.isArray(ev.staleSteps) ? ev.staleSteps.length : 0;
  const untouched = stale > 0 ? `; ${stale} planned step${stale === 1 ? '' : 's'} still untouched` : '';
  return `⚠ plan drift — the last ${ev.window} rounds wrote ${files}${more}, which no planned step names, `
    + `and marked no step${untouched}. The model has been told; nothing has been stopped.`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. PLAN MODE — READ, PROPOSE, GET APPROVAL, THEN UNLOCK WRITES
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── ⚠️⚠️ TWO FLAGS LOOKED LIKE THIS GATE AND NEITHER IS IT ──────────────────
 *
 * `--dry-run` prints what WOULD be written; `--no-run` withholds the process
 * spawners. Both describe the ACT. Neither describes the INTENT, and intent is
 * the thing a person wants to see before an agent touches a repository they
 * care about: *tell me what you are going to do, and let me say no.*
 *
 * Measured before this landed: `grep -c "arg === '--plan'" lib/cli-args.mjs`
 * returned **0**, and the word "plan" appeared in `--help` only inside the
 * `plan_start` ledger story. The capability did not exist under any spelling.
 *
 * ── ⭐ EVERY PART ALREADY EXISTED, WHICH IS WHY THIS SECTION IS SMALL ───────
 *
 *   · the read-only subset            → `ORIENT_TOOLS`, twenty lines above
 *   · the question                    → `createAsker` in prompt.mjs
 *   · an offer that varies by budget  → `toolNamesForRounds` in tools.mjs
 *
 * Nothing joined them. What is added here is the JOIN, kept pure so it can be
 * tested with no network, no disk, no terminal and no key — the same rule the
 * rest of this module obeys.
 *
 * ⚠️⚠️ AND THE PHASE IS READ-ONLY BY ABSENCE, NOT BY REFUSAL. That is this
 * package's standing rule (`tools.mjs`: "a control that presents itself and
 * does nothing is worse than one that is absent") and it matters more here than
 * anywhere: a plan phase that OFFERS `write_file` and refuses it teaches the
 * model to spend the proposal budget discovering the button is dead, and the
 * proposal budget is the whole phase.
 */

/**
 * ⚠️ TWO, BECAUSE ONE IS THE SINGLE-SHOT COLLAPSE. `toolNamesForRounds(1)`
 * returns `['write_file','write_files']` — intersect that with the read-only
 * set and the model is handed ZERO tools and asked to plan, in the one phase
 * whose entire value is that it can look before it commits.
 */
export const PLAN_MODE_MIN_ROUNDS = 2;

/**
 * ⚠️ THE PROPOSAL MUST NOT BE ALLOWED TO EAT THE BUDGET IT IS PLANNING. A
 * twelve-round proposal against `--max-rounds 12` leaves nothing to execute
 * with, and the user typed that number for the WORK. Five rounds is enough to
 * read a handful of files and a diff; beyond that the model is not planning,
 * it is doing the task without being allowed to write it down.
 */
export const PLAN_MODE_MAX_ROUNDS = 5;

/**
 * ⚠️ `plan_status` READS, AND IS STILL EXCLUDED. `.acuvo/plan.json` outlives the
 * run that wrote it — `plan-ledger.mjs` documents the two-terminal case where
 * one workspace's plan described a completely different task. During a PROPOSAL
 * there is by construction no plan for this task yet, so the only thing
 * `plan_status` can return is somebody else's, and a model that reads it starts
 * planning around work it is not doing.
 */
export const PLAN_MODE_EXCLUDED = new Set(['plan_status']);

export const PLAN_MODE_DECISIONS = ['approve', 'amend', 'reject'];

/**
 * The read-only offer for the proposal phase.
 *
 * ⭐ AN INTERSECTION, NEVER A FIXED LIST, and that is the load-bearing choice.
 * `ORIENT_TOOLS` names tools this machine may not have — `read_skill` is gated
 * on the workspace containing skills, the LSP reads are gated on a language
 * server existing. Handing the model a hard-coded read list would ship exactly
 * the dead buttons `tools.mjs` spends four hundred lines refusing to ship.
 *
 * @param {string[]} offered what `toolNamesForRounds` returned for this run
 * @returns {{ ok: true, names: string[] } | { ok: false, names: [], error: string }}
 */
export function planModeToolNames(offered) {
  const list = Array.isArray(offered) ? offered : [];
  const names = list.filter((n) => typeof n === 'string' && ORIENT_TOOLS.has(n) && !PLAN_MODE_EXCLUDED.has(n));
  if (names.length === 0) {
    return {
      ok: false,
      names: [],
      error: 'this run offers no read-only tools at all, so a plan phase would ask the model to propose work it '
        + 'cannot look at first. Raise --max-rounds to at least 2 (a single-round run is offered write verbs only).',
    };
  }
  return { ok: true, names };
}

/** How many rounds the proposal gets. Clamped at both ends; see the constants. */
export function planModeRounds(maxRounds) {
  const n = Number.isFinite(maxRounds) ? Math.floor(maxRounds) : PLAN_MODE_MIN_ROUNDS;
  if (n < PLAN_MODE_MIN_ROUNDS) return PLAN_MODE_MIN_ROUNDS;
  return Math.min(n, PLAN_MODE_MAX_ROUNDS);
}

/**
 * ⚠️ THE THIRD PART OF REACHABILITY. A schema the model is offered and a
 * dispatcher that answers are two thirds; the sentence telling it what mode it
 * is in is the third, and it is the one this repo forgets. A model handed only
 * read tools and no explanation concludes the write tools failed to load and
 * spends the phase apologising.
 *
 * ⭐ IT ALSO NAMES THE SHAPE OF THE ANSWER. The proposal's whole job is to be
 * read by a human in five seconds and then re-read by a model as a ledger, so
 * "numbered, one deliverable a line, files named" is not style — it is what
 * makes `plan_start` able to record it and `attributePath` able to bind it.
 */
export function planPhaseTask(task) {
  return [
    'PLAN MODE — you are proposing, not doing. This phase is READ-ONLY: you have been offered reading, searching',
    'and history tools only, and you cannot write a file, run a command or commit anything until a human has read',
    'your plan and approved it. That is by design, not a fault — do not try to work around it and do not apologise',
    'for it.',
    '',
    'Look at whatever you need to (read the files, search, check the diff), then answer with THE PLAN and nothing',
    'else. Number the steps, one deliverable per line, in the order you will do them. NAME THE FILES you intend to',
    'create or change, because a step that names no file cannot be checked against what you actually did. Put any',
    'commit or final write early enough in the list that it survives a short budget. If something is genuinely',
    'ambiguous, say which assumption you are taking — the person approving this is about to read it.',
    '',
    'Your final message is the plan. It will be shown to a person for approval before anything is executed.',
    '',
    `THE TASK: ${task}`,
  ].join('\n');
}

/**
 * ⚠️ A PLAN LONGER THAN THIS IS NOT A PLAN. It is re-sent on every round of the
 * executing run, so it is a per-round tax for the life of that run — the same
 * compounding cost `reanchorDecision` above budgets against. 6,000 characters
 * is roughly 1,500 tokens, which is a generous twenty-step plan.
 */
export const MAX_APPROVED_PLAN_CHARS = 6_000;
/** Same reasoning, smaller: a correction is a sentence, not an essay. */
export const MAX_AMENDMENT_CHARS = 1_000;

/**
 * ⚠️ THE CUT SAYS SO. A silently truncated plan reads as a whole one, and the
 * model then confidently does the first two thirds of a job and reports it
 * finished. `clampOutput` in command.mjs makes the same argument; this module
 * is deliberately dependency-free (see the header), so it makes it locally.
 */
function clamp(text, max, what) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [${what} truncated here: ${s.length} characters, ${max} kept]`;
}

const APPROVE = /^(?:y|yes|ok|okay|go|approve|approved|do it)$/i;
/**
 * ⚠️ A LEADING-WORD TEST, NOT AN EXACT ONE, AND THE ASYMMETRY IS DELIBERATE.
 * "no, do it differently" begins with a refusal and ends with an instruction;
 * reading it as an amendment would unlock writes on a sentence that started
 * with the word no. It refuses, and the user retypes. Approval matches EXACTLY
 * because the opposite mistake — "yes but not the tests" read as a bare yes —
 * would silently drop the only constraint they gave.
 */
const REJECT = /^(?:n|no|nope|q|quit|abort|cancel|stop)\b/i;

/**
 * What the person typed, as a decision.
 *
 * ⚠️⚠️ SILENCE IS NOT CONSENT, AND THIS IS WHERE THIS FILE PARTS COMPANY WITH
 * `ask-user.mjs`. That module treats a bare Enter as "you decide", which is
 * right for "which of these two designs" — the model has to pick something
 * either way. It is wrong here. This keystroke is the only thing standing
 * between a proposal and a file-writing agent, and the two errors are not
 * symmetric: approving unintended writes costs the user their work, refusing
 * costs them one retype. So Enter refuses, and the prompt says `[y/N]` so the
 * default is visible rather than discovered.
 *
 * @returns {{ decision: 'approve'|'amend'|'reject', amendment: string|null, why: string }}
 */
export function planApproval(answer) {
  if (answer === null || answer === undefined) {
    return { decision: 'reject', amendment: null, why: 'the terminal closed before an answer arrived' };
  }
  const s = String(answer).trim();
  if (s === '') return { decision: 'reject', amendment: null, why: 'nothing was typed, and silence is not approval here' };
  if (APPROVE.test(s)) return { decision: 'approve', amendment: null, why: 'approved as proposed' };
  if (REJECT.test(s)) return { decision: 'reject', amendment: null, why: `declined: "${s}"` };
  return {
    decision: 'amend',
    amendment: clamp(s, MAX_AMENDMENT_CHARS, 'amendment'),
    why: 'approved with a correction, which the executing run is told outranks the plan',
  };
}

/**
 * The task the EXECUTING run receives once a human has said yes.
 *
 * ⭐⭐ THE LAST PARAGRAPH IS WHERE THE TWO HALVES OF THIS FILE MEET. Getting a
 * plan approved buys nothing on its own — `plan-ledger.mjs`'s measured failure
 * is a six-step plan across 20 rounds with `plan_step` never called once. So
 * the approved task does not merely CARRY the plan, it instructs the model to
 * record it with `plan_start` and mark it with `plan_step`, which is what puts
 * it in front of `detectDrift` and `reconcile`. An approved plan nobody records
 * is the same to-do list nobody reads, with a ceremony in front of it.
 *
 * ⚠️ NO CACHE ARGUMENT APPLIES HERE, unlike `anchorText` above. This string is
 * the FIRST user message of a session that has not started, so there is no
 * cached prefix to void — the rule that appending is the only safe placement is
 * about a conversation in flight.
 */
export function approvedTask({ task, plan, amendment = null } = {}) {
  const lines = [
    String(task ?? ''),
    '',
    '--- APPROVED PLAN ---',
    'A person has read the following plan and approved it. It is not a suggestion and it is not your own draft;',
    'it is the agreed scope of this run.',
    '',
    clamp(plan, MAX_APPROVED_PLAN_CHARS, 'plan'),
  ];
  if (amendment) {
    lines.push(
      '',
      '--- AMENDMENT FROM THE PERSON WHO APPROVED IT ---',
      'This was typed after reading the plan. Where it disagrees with the plan, IT OVERRIDES THE PLAN.',
      '',
      String(amendment),
    );
  }
  lines.push(
    '',
    '--- HOW TO RUN IT ---',
    'Record this plan with plan_start BEFORE your first write, using these steps in this order, and mark each one',
    'with plan_step as you finish it. That is not bookkeeping: it is what lets the run notice if it wanders off the',
    'plan the person agreed to, and what lets the final report say which steps have evidence behind them.',
    'If you find the plan is wrong once you start, say so and call plan_start with the steps you are actually doing',
    'rather than quietly doing something else.',
  );
  return lines.join('\n');
}

/**
 * The block shown to the person, as lines so the caller owns colour and width.
 *
 * ⚠️ THE HEADING HAS TO SAY THE WORKSPACE IS STILL UNTOUCHED. Without that
 * sentence the block reads like a REPORT of work already done — which is the
 * one misreading that makes a person approve something they would have refused.
 */
export function formatPlanForApproval(planText) {
  return [
    '',
    '  ── PROPOSED PLAN ─────────────────────────────────────────────',
    '  Nothing has been written and no command has been run. This is what it INTENDS to do.',
    '',
    ...String(planText ?? '').split('\n').map((l) => `  ${l}`),
    '',
  ];
}

/** The question, so the prompt and the parser cannot drift apart. */
export const PLAN_APPROVAL_QUESTION = '\n  Approve this plan and let it start writing? [y/N, or type a correction]\n  > ';

/**
 * The whole gate: propose read-only, show it, ask, and hand back either a
 * refusal or the task the executing run should receive.
 *
 * ⚠️ EVERY DEPENDENCY IS INJECTED — `propose` does the model call, `ask` is
 * `createAsker`'s result, `print` writes to whichever stream the caller decided
 * on (stderr under `--json`). That keeps this function testable with no
 * network, no terminal and no key, which is the only reason its refusal paths
 * have coverage at all.
 *
 * ⚠️⚠️ THE NO-TERMINAL CHECK IS FIRST, ABOVE `propose`. `createAsker` returns
 * null in CI, in a pipe and under a task runner, and a plan phase there would
 * buy a model call for a plan that structurally cannot be approved — money
 * spent on a question nobody can answer. Refusing costs nothing and says why.
 *
 * @param {object} args
 * @param {string} args.task
 * @param {() => Promise<{ok?: boolean, note?: string|null}>} args.propose
 * @param {null | ((q: string) => Promise<string|null>)} args.ask
 * @param {(text: string) => void} [args.print]
 * @returns {Promise<{
 *   proceed: boolean, task: string, decision: string|null,
 *   reason: string|null, why: string, planText: string|null, outcome: object|null
 * }>}
 */
export async function runPlanGate({ task, propose, ask, print = () => {} } = {}) {
  const original = String(task ?? '');
  const no = (reason, why) => ({
    proceed: false, task: original, decision: null, reason, why, planText: null, outcome: null,
  });

  if (typeof ask !== 'function') {
    return no('no-terminal',
      '--plan needs somebody to approve the plan, and stdin/stdout are not both terminals here. Nothing was sent '
      + 'to the model. Run it from a terminal, or drop --plan (and consider --dry-run, which touches nothing).');
  }
  if (typeof propose !== 'function') return no('no-proposer', 'no proposal phase was supplied — this is a wiring bug');

  const outcome = await propose();
  const planText = typeof outcome?.note === 'string' ? outcome.note.trim() : '';
  if (outcome?.ok === false || planText === '') {
    return {
      ...no('no-plan',
        'the planning phase produced no plan, so there is nothing to approve and nothing has been executed'),
      outcome: outcome ?? null,
    };
  }

  print(`${formatPlanForApproval(planText).join('\n')}\n`);
  const verdict = planApproval(await ask(PLAN_APPROVAL_QUESTION));

  if (verdict.decision === 'reject') {
    return { ...no('declined', verdict.why), decision: 'reject', planText, outcome };
  }
  return {
    proceed: true,
    task: approvedTask({ task: original, plan: planText, amendment: verdict.amendment }),
    decision: verdict.decision,
    reason: null,
    why: verdict.why,
    planText,
    outcome,
  };
}

/**
 * ── ⭐ HOW TO WIRE THIS (the part that is not mine to do) ────────────────────
 *
 * All four pieces hang off state `runSession` already has: `rounds`, the plan
 * `planBannerFor` already loads, and the round counter.
 *
 * In `lib/turn.mjs`, beside `const nudged = new Set()`:
 *
 *     let anchorState = {};
 *
 * and immediately after the existing `rounds.push({ round, ... })`:
 *
 *     const plan = loadPlanQuietly(executor);
 *     const drift = detectDrift({ plan, rounds });
 *     if (drift.drifting && !nudged.has(drift.evidence.key)) {
 *       nudged.add(drift.evidence.key);
 *       messages.push({ role: 'user', content: driftNudge(drift) });   // APPEND ONLY
 *     }
 *     const anchor = reanchorDecision({
 *       plan, roundIndex: round, maxRounds, state: anchorState, drift,
 *       compactedSinceAnchor: compactedThisRound,
 *     });
 *     if (anchor.reanchor) {
 *       messages.push({ role: 'user', content: anchor.text });          // APPEND ONLY
 *       anchorState = anchor.state;
 *     }
 *
 * and in the final report, beside `formatLedger`:
 *
 *     for (const line of formatReconciliation(reconcile({ plan, rounds }))) print(line);
 *
 * ⚠️ `nudged` IS NOT OPTIONAL, for the reason `stuck.mjs` gives: re-nudging
 * every round changes the tail every round, which is token cost forever.
 * `drift.evidence.key` is stable while one drift persists and differs between
 * distinct ones.
 *
 * ⚠️⚠️ AND BOTH INJECTIONS MUST BE `messages.push`, NEVER A SPLICE OR AN EDIT
 * OF AN EARLIER MESSAGE. `wasAppendOnly(before, after)` exists so that rule can
 * be asserted in a test rather than remembered. Getting it wrong costs 2.4x and
 * nothing goes red.
 *
 * ⭐ NUDGING IS THE ACTION. Nothing here stops a run, changes an exit code, or
 * marks a step. `plan-ledger.mjs`'s premise is that `done` is asserted; this
 * module reports how much that assertion is worth and lets the human decide.
 */
