/**
 * ── ⭐⭐ THE PLAN LEDGER — THE WALL THE AGENT CANNOT SEE ─────────────────────
 *
 * FOUND BY RUNNING THE CLI, not by reasoning about it. Four probe suites, and
 * three of them hit the same shape independently:
 *
 *   · Probe 4, run 2. The task said port every file "and THEN git_commit". The
 *     model wrote one file per round for rounds 2–7, ran the tests on round 8,
 *     and the commit never happened — `git log --oneline` still showed only
 *     `d4e74e1 callback version` with six files modified. Run 7 of the same task
 *     landed the commit on round 8 BY LUCK; at `--max-rounds 7` it loses it.
 *   · Probe 1, run 3 ended mid-intention — "Now let me update the README … let
 *     me first verify the real output" — and reported ✔ VERIFIED anyway. The
 *     README still contained zero occurrences of "prior" while the program
 *     printed a PRIORITY column.
 *   · Probe 3, tasks D and G each spent all six rounds researching, each FOUND
 *     the answer, and neither wrote the NOTES.md / API.md they were asked for.
 *
 * ⚠️ THE COMMON CAUSE IS NOT LAZINESS, IT IS BLINDNESS. Probe 4 captured
 * `body-08.json` — round 8 of 8 — and its round wording was BYTE-IDENTICAL to
 * `body-01.json`. There is no countdown anywhere in the payload. The model is
 * driving at a wall it has never been told exists, so it spends the last round
 * the way it spent the first: on the most interesting remaining thing rather
 * than the last unfinished deliverable. 4 of 4 runs in probe 1 and 4 of 4 in
 * probe 4 consumed the whole budget; none finished early. The wall is hit EVERY
 * TIME, and the LAST-listed deliverable is always the one that dies.
 *
 * ⭐ SO THE BANNER IS THE POINT OF THIS FILE. Every result from all three tools
 * ends with one deterministic line:
 *
 *     plan: 5/7 done · 2 remaining: update README.md, git_commit · round 6 of 8
 *
 * That line rides back on a tool result the model already reads, which is how a
 * countdown reaches it WITHOUT editing turn.mjs — the module never reads turn
 * state itself, the caller passes the numbers in as options. One wiring change,
 * no new plumbing through the loop.
 *
 * ── ⭐ AND THE SECOND HALF: RESUME ───────────────────────────────────────────
 * Probe 4 confirmed there was no `.acuvo` directory in the workspace and no
 * `~/.acuvo`, so re-issuing the IDENTICAL command spent 3 of its 4 rounds
 * ($0.000792) re-deriving what the previous process had held in memory seconds
 * earlier. The resume primitive is exactly one rule: **`plan_start` against an
 * incomplete plan REFUSES and hands back the outstanding items.** Nothing else
 * is needed — the model reads "4 of 10 done, here are the six" and continues
 * instead of starting over.
 *
 * ── ⚠️ WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 *   · It is NOT mandatory. A run that never calls plan_start behaves exactly as
 *     it does today. A planning tool that must be called first is a tax on the
 *     90% of tasks that are one file and one test.
 *   · It NEVER invents steps from the task text. A decomposition the model did
 *     not author is one it will not follow, and a plan nobody follows is worse
 *     than no plan: it makes the banner lie.
 *   · It NEVER marks anything done on its own. `done` is ASSERTED by the agent.
 *     Inferring completion from "a file with that name now exists" is how a
 *     ledger starts reporting success at the exact moment the work stops being
 *     real — the failure this module was built to catch.
 *   · It changes no exit code. The OUTSTANDING block is evidence for a human,
 *     not a new way for the process to fail.
 *
 * ── ⚠️ AND THE LINE BETWEEN "NOT FINISHED" AND "NOT CORRECT" ────────────────
 * `formatLedger` keeps the OUTSTANDING block strictly separate from any
 * verification verdict, because they answer different questions and probe 1 run
 * 3 shows what happens when they blur: that run reported ✔ VERIFIED while a
 * named deliverable was untouched. "What was asked for and not done" is a fact
 * this file owns. "Is the done work right" is the auditor's job, and this module
 * must never appear to have answered it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveInWorkspace } from './workspace.mjs';

/** The package's scratch directory — the same one `see_page` writes screenshots
 *  into and `mcp.json` / `policy.json` live in. A plan is scratch of the same
 *  kind: useful to the run, never part of the user's source tree. */
export const PLAN_DIR = '.acuvo';
export const PLAN_FILE = `${PLAN_DIR}/plan.json`;

/** A decomposition longer than this is not a plan, it is a transcript — and it
 *  costs the banner more tokens every single round for the rest of the run. */
export const MAX_STEPS = 40;
/** A step is a deliverable, not a paragraph. Over this and the model is writing
 *  the implementation into the plan. */
export const MAX_STEP_CHARS = 200;
/** Notes are truncated rather than refused: a note is commentary, and losing its
 *  tail costs nothing, whereas refusing the whole call loses the STATE CHANGE. */
export const MAX_NOTE_CHARS = 300;
export const MAX_TASK_CHARS = 400;
/** The banner is printed on every tool result for the whole run, so its width is
 *  a per-round token bill, not a formatting preference. */
export const MAX_BANNER_ITEMS = 3;
const BANNER_ITEM_CHARS = 48;

export const PLAN_STATES = ['todo', 'doing', 'done', 'blocked'];

/** `memory-workspace.mjs` names the disk-less executor this. */
const MEMORY_ROOT = '(memory)';
const MEMORY_REFUSAL =
  'this workspace has no disk, so a plan cannot be persisted — track the remaining steps in your reply instead';

const err = (e) => (e instanceof Error ? e.message : String(e));
const nowIso = () => new Date().toISOString();

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * ── ⚠️ A PLAN IS WRITTEN TO DISK, SO IT IS A PLACE SECRETS GO TO STAY ───────
 *
 * `audit.mjs` REDACTS, because a log that refuses to be written is a log that
 * does not exist. This file REFUSES, because the input is the model's own words
 * chosen milliseconds ago and it can simply choose different ones — and a plan
 * with `[redacted]` in a step is a step nobody can act on. Same threat, opposite
 * correct answer.
 *
 * ⚠️ THE 40-CHARACTER RUN NEEDS BOTH A DIGIT AND A LETTER, and that condition is
 * load-bearing rather than fussy. Without it, a legitimate step like
 * "implement authenticateUserWithCredentialsAndRefresh" (50 characters, no
 * spaces) is refused as a credential — a false positive on the most ordinary
 * text a coding agent writes. Every base64url secret carries digits; camelCase
 * identifiers almost never do.
 */
const SECRET_SHAPES = [
  [/sk-[A-Za-z0-9]{16,}/, 'an API key'],
  [/\b(?:sk|rk)-or-v1-[A-Za-z0-9_-]{16,}/, 'an OpenRouter key'],
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
];

export function looksLikeSecret(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const [rx, what] of SECRET_SHAPES) if (rx.test(text)) return what;
  const run = text.match(/[A-Za-z0-9_-]{40,}/);
  if (run && /[0-9]/.test(run[0]) && /[A-Za-z]/.test(run[0])) return 'a long opaque token';
  return null;
}

/** The refusal wording, in one place, because it is an INSTRUCTION: it has to
 *  tell the model what to write instead, not merely that it was wrong. */
function secretRefusal(where, what) {
  return `${where} contains what looks like ${what} — a plan is written to disk; do not put secrets in it. Describe the value ("use the key from the environment") instead, and if it is a commit hash use the 7-character short form.`;
}

/**
 * Resolve a file inside the plan directory and PROVE it is inside it.
 *
 * ⚠️ EXPORTED BECAUSE THE ASSERTION IS THE THING WORTH TESTING. Every caller in
 * this module passes a constant, so the prefix check can never fire in
 * production — which is exactly why it would rot unnoticed if it were private.
 * The test drives it directly with `../outside.json` and `notes/plan.json`.
 *
 * @returns {{ ok: true, absolute: string, relative: string, root: string } | { ok: false, error: string }}
 */
export function resolvePlanFile(root, name = PLAN_FILE) {
  if (typeof root !== 'string' || root.trim() === '') {
    return { ok: false, error: 'no workspace directory was given, so a plan cannot be stored' };
  }
  if (root === MEMORY_ROOT) return { ok: false, error: MEMORY_REFUSAL };

  const r = resolveInWorkspace(root, name, 'write');
  if (!r.ok) return { ok: false, error: r.reason };
  if (r.relative !== PLAN_DIR && !r.relative.startsWith(`${PLAN_DIR}/`)) {
    return { ok: false, error: `the plan ledger only ever writes inside ${PLAN_DIR}/ — "${r.relative}" is outside it` };
  }
  return { ok: true, absolute: r.absolute, relative: r.relative, root: r.root };
}

/**
 * ⚠️ VALIDATE THE FILE, DO NOT TRUST IT. `.acuvo/plan.json` is a file on a
 * laptop: a merge, a half-finished write from a killed process, or a human with
 * an editor can all leave something JSON-shaped but wrong. A plan whose `steps`
 * is a string would throw inside the banner — on every round, after the work.
 * Returns null for anything it does not fully recognise, and null means "treat
 * as absent", never "throw".
 */
function parsePlan(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.version !== 1) return null;
  if (typeof data.task !== 'string') return null;
  if (!Array.isArray(data.steps) || data.steps.length === 0 || data.steps.length > MAX_STEPS) return null;

  const steps = [];
  for (const s of data.steps) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if (typeof s.id !== 'string' || !/^s[1-9][0-9]*$/.test(s.id)) return null;
    if (typeof s.text !== 'string' || s.text === '') return null;
    if (!PLAN_STATES.includes(s.state)) return null;
    steps.push({
      id: s.id,
      text: s.text,
      state: s.state,
      note: typeof s.note === 'string' && s.note ? s.note : undefined,
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : undefined,
    });
  }
  return {
    version: 1,
    task: data.task,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : nowIso(),
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : nowIso(),
    steps,
  };
}

/**
 * A file we cannot parse is MOVED ASIDE rather than deleted or overwritten.
 *
 * ⚠️ The alternative — refusing to run until a human fixes it — makes a
 * corrupted scratch file able to block the whole agent, which is a far worse
 * outcome than losing a plan. And deleting it would destroy the only evidence of
 * whatever wrote it. Renaming costs nothing and keeps both properties.
 */
function quarantine(root, absolute) {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const target = resolvePlanFile(root, `${PLAN_DIR}/plan.corrupt-${stamp}.json`);
  if (!target.ok) return null;
  try {
    renameSync(absolute, target.absolute);
    return target.relative;
  } catch {
    // Locked by another process, or already gone. Either way the caller's next
    // move (write a fresh plan) still works, so this must not become an error.
    return null;
  }
}

/**
 * @returns {{ ok: true, plan: object | null, quarantined?: string } | { ok: false, error: string }}
 */
export function loadPlan(root) {
  const f = resolvePlanFile(root);
  if (!f.ok) return f;
  if (!existsSync(f.absolute)) return { ok: true, plan: null };

  let raw;
  try {
    raw = readFileSync(f.absolute, 'utf8');
  } catch (e) {
    return { ok: false, error: `could not read ${PLAN_FILE}: ${err(e)}` };
  }
  const plan = parsePlan(raw);
  if (plan) return { ok: true, plan };
  const moved = quarantine(root, f.absolute);
  return { ok: true, plan: null, quarantined: moved ?? undefined };
}

/**
 * ⚠️ THE TEMP NAME CARRIES THE PID AND A COUNTER, and that is not decoration.
 * A fixed `plan.json.tmp` shared by two processes is WORSE than no temp file at
 * all: both write into the same path, the second rename publishes a file
 * containing an interleaving of two documents, and the corruption looks like a
 * bug in this module rather than in the concurrency. Unique tmp + rename means
 * the loser of the race simply loses — the published file is always exactly one
 * writer's complete output. (`evaluate.mjs` names its scratch the same way, for
 * the same reason.)
 */
let tmpCounter = 0;

/** @returns {{ ok: true, path: string } | { ok: false, error: string }} */
export function savePlan(root, plan) {
  const f = resolvePlanFile(root);
  if (!f.ok) return f;
  const tmp = resolvePlanFile(root, `${PLAN_FILE}.${process.pid}-${tmpCounter++}.tmp`);
  if (!tmp.ok) return tmp;

  const body = `${JSON.stringify({ ...plan, updatedAt: nowIso() }, null, 2)}\n`;
  try {
    mkdirSync(dirname(f.absolute), { recursive: true });
    writeFileSync(tmp.absolute, body, 'utf8');
    renameSync(tmp.absolute, f.absolute);
  } catch (e) {
    try { unlinkSync(tmp.absolute); } catch { /* nothing to clean up */ }
    return { ok: false, error: `could not write ${PLAN_FILE}: ${err(e)}` };
  }
  return { ok: true, path: f.relative };
}

/** Not-done steps, in the order they were planned. `blocked` counts as
 *  outstanding — a step that cannot proceed is still a thing that was asked for
 *  and did not happen, and hiding it is how the banner starts flattering. */
export function outstanding(plan) {
  if (!plan || !Array.isArray(plan.steps)) return [];
  return plan.steps.filter((s) => s.state !== 'done');
}

/**
 * `round 6 of 8`, or `2 rounds left`, or nothing at all.
 *
 * ⚠️ OMITTED RATHER THAN GUESSED when the caller passes nothing. A wrong
 * countdown is worse than none: it either panics the model into skipping work it
 * had time for, or reassures it into losing the last deliverable — the exact
 * failure this file exists to prevent.
 */
function roundClause({ roundsRemaining, roundIndex, maxRounds } = {}) {
  if (Number.isFinite(roundIndex) && Number.isFinite(maxRounds)) return ` · round ${roundIndex} of ${maxRounds}`;
  if (Number.isFinite(roundsRemaining)) {
    return ` · ${roundsRemaining} round${roundsRemaining === 1 ? '' : 's'} left`;
  }
  return '';
}

/**
 * THE ONE LINE. Deterministic, capped, and the same shape whatever happened —
 * the model has to be able to read it without parsing.
 */
export function formatBanner(plan, opts = {}) {
  const round = roundClause(opts);
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return `plan: none recorded${round}`;

  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.state === 'done').length;
  const left = outstanding(plan);
  if (left.length === 0) return `plan: ${done}/${total} done · all steps done${round}`;

  const shown = left.slice(0, MAX_BANNER_ITEMS).map((s) => {
    const text = truncate(s.text, BANNER_ITEM_CHARS);
    // A blocked step reads differently from an untouched one, and the model
    // needs that difference to decide whether to retry it or route around it.
    return s.state === 'blocked' ? `${text} (blocked)` : text;
  });
  const more = left.length > MAX_BANNER_ITEMS ? `, +${left.length - MAX_BANNER_ITEMS} more` : '';
  return `plan: ${done}/${total} done · ${left.length} remaining: ${shown.join(', ')}${more}${round}`;
}

const MARK = { done: '✓', doing: '→', blocked: '✗', todo: '·' };

/**
 * The full ledger, for an end-of-run summary. Ends with the same banner, so
 * whatever surfaces it — a tool result or the final report — the last line the
 * model or the human reads is identical.
 */
export function formatLedger(plan, opts = {}) {
  if (!plan) return formatBanner(null, opts);
  const lines = [`plan for: ${truncate(plan.task, 120)}`];
  for (const s of plan.steps) {
    const note = s.note ? ` — ${truncate(s.note, 80)}` : '';
    lines.push(`  ${MARK[s.state] ?? '·'} ${s.id.padEnd(3)} ${truncate(s.text, 100)}${note}`);
  }

  const left = outstanding(plan);
  lines.push('');
  if (left.length === 0) {
    lines.push('OUTSTANDING — none; every step was marked done.');
  } else {
    lines.push(`OUTSTANDING — ${left.length} of ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} asked for and not finished:`);
    for (const s of left) {
      const note = s.note ? ` — ${truncate(s.note, 80)}` : '';
      lines.push(`  [${s.state}] ${s.id} ${truncate(s.text, 100)}${note}`);
    }
    // ⚠️ Stated out loud because probe 1 run 3 printed ✔ VERIFIED over an
    // untouched deliverable. These are two different questions and the summary
    // must never let one answer the other.
    lines.push('(what was asked for and not finished — this says nothing about whether the finished work is correct)');
  }

  lines.push(formatBanner(plan, opts));
  return lines.join('\n');
}

/** The projection that goes back to the model: no timestamps, because it pays
 *  for them every round and cannot act on them. */
const compact = (steps) => steps.map((s) => (s.note ? { id: s.id, text: s.text, state: s.state, note: s.note } : { id: s.id, text: s.text, state: s.state }));

function validateSteps(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'steps must be an array of short strings, one per deliverable' };
  if (raw.length === 0) return { ok: false, error: 'steps was empty — list the deliverables you intend to produce, in the order you will do them' };
  if (raw.length > MAX_STEPS) {
    return { ok: false, error: `${raw.length} steps is more than the ${MAX_STEPS}-step limit — group the small ones, and keep each step a deliverable rather than a keystroke` };
  }
  const steps = [];
  for (let i = 0; i < raw.length; i += 1) {
    const s = raw[i];
    if (typeof s !== 'string') return { ok: false, error: `step ${i + 1} is a ${Array.isArray(s) ? 'array' : typeof s}, not a string — each step is one short sentence` };
    const text = s.trim();
    if (!text) return { ok: false, error: `step ${i + 1} is empty — remove it or say what it produces` };
    if (text.length > MAX_STEP_CHARS) {
      return { ok: false, error: `step ${i + 1} is ${text.length} characters, over the ${MAX_STEP_CHARS} limit — name the deliverable, not the implementation` };
    }
    const secret = looksLikeSecret(text);
    if (secret) return { ok: false, error: secretRefusal(`step ${i + 1}`, secret) };
    // ⭐ IDS ARE ASSIGNED HERE, NEVER BY THE MODEL. A model that renames a step
    // between rounds would otherwise orphan its own progress — and reworded
    // steps are exactly what a model does when it re-reads its plan.
    steps.push({ id: `s${i + 1}`, text, state: 'todo', updatedAt: nowIso() });
  }
  return { ok: true, steps };
}

/**
 * Record the decomposition.
 *
 * ⭐ THE REFUSAL IS THE FEATURE. An incomplete plan already on disk is not an
 * error condition, it is a PREVIOUS SESSION, and the whole resume primitive is
 * that this call hands it back instead of flattening it.
 *
 * @param {string} root
 * @param {{ task?: unknown, steps?: unknown, replace?: unknown }} args
 * @param {{ roundsRemaining?: number, roundIndex?: number, maxRounds?: number }} [opts]
 */
export function planStart(root, args = {}, opts = {}) {
  const f = resolvePlanFile(root);
  if (!f.ok) return { ok: false, error: f.error };

  if (typeof args.task !== 'string' || args.task.trim() === '') {
    return { ok: false, error: 'task must be a one-line restatement of what you were asked to do' };
  }
  const taskSecret = looksLikeSecret(args.task);
  if (taskSecret) return { ok: false, error: secretRefusal('task', taskSecret) };
  const task = truncate(args.task.trim(), MAX_TASK_CHARS);

  const parsed = validateSteps(args.steps);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const existing = loadPlan(root);
  if (!existing.ok) return { ok: false, error: existing.error };

  if (existing.plan && args.replace !== true) {
    const left = outstanding(existing.plan);
    if (left.length > 0) {
      const done = existing.plan.steps.length - left.length;
      return {
        ok: false,
        error: `a plan for this workspace already exists with ${done} of ${existing.plan.steps.length} steps done — pass replace:true to discard it, or continue with plan_step`,
        existing: { task: existing.plan.task, steps: compact(existing.plan.steps) },
        outstanding: compact(left),
        banner: formatBanner(existing.plan, opts),
      };
    }
    // Every step of the old plan is done, so it is history rather than work in
    // progress. Silently superseding it is right: refusing here would make the
    // second task in a session impossible without a flag nobody would know to
    // pass.
  }

  const discarded = existing.plan && args.replace === true ? outstanding(existing.plan).length : 0;
  const plan = { version: 1, task, createdAt: nowIso(), updatedAt: nowIso(), steps: parsed.steps };
  const saved = savePlan(root, plan);
  if (!saved.ok) return { ok: false, error: saved.error };

  return {
    ok: true,
    replaced: Boolean(existing.plan),
    // Honest about what was thrown away — a replace that silently drops six
    // unfinished steps is the one case where "it worked" is misleading.
    discardedOutstanding: discarded,
    task,
    steps: compact(plan.steps),
    banner: formatBanner(plan, opts),
  };
}

/**
 * Mark exactly one step.
 *
 * @param {string} root
 * @param {{ id?: unknown, state?: unknown, note?: unknown }} args
 * @param {{ roundsRemaining?: number, roundIndex?: number, maxRounds?: number }} [opts]
 */
export function planStep(root, args = {}, opts = {}) {
  const loaded = loadPlan(root);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (!loaded.plan) {
    return { ok: false, error: 'no plan has been recorded for this workspace — call plan_start with the steps you intend to take, then mark them' };
  }
  const plan = loaded.plan;

  if (typeof args.state !== 'string' || !PLAN_STATES.includes(args.state)) {
    return { ok: false, error: `state must be one of ${PLAN_STATES.join(', ')} — got ${JSON.stringify(args.state ?? null)}` };
  }
  const step = typeof args.id === 'string' ? plan.steps.find((s) => s.id === args.id) : undefined;
  if (!step) {
    const listed = plan.steps.slice(0, 12).map((s) => `${s.id} ${truncate(s.text, 40)}`).join(' · ');
    const more = plan.steps.length > 12 ? ` · +${plan.steps.length - 12} more` : '';
    return { ok: false, error: `no step with id ${JSON.stringify(args.id ?? null)} — the ids in this plan are: ${listed}${more}` };
  }

  let note;
  if (args.note !== undefined && args.note !== null && args.note !== '') {
    if (typeof args.note !== 'string') return { ok: false, error: 'note must be a string, or omitted' };
    const secret = looksLikeSecret(args.note);
    if (secret) return { ok: false, error: secretRefusal('note', secret) };
    note = truncate(args.note.trim(), MAX_NOTE_CHARS);
  }

  const previous = step.state;
  step.state = args.state;
  step.updatedAt = nowIso();
  if (note !== undefined) step.note = note;

  const saved = savePlan(root, plan);
  if (!saved.ok) return { ok: false, error: saved.error };

  return {
    ok: true,
    id: step.id,
    from: previous,
    state: step.state,
    outstanding: compact(outstanding(plan)),
    banner: formatBanner(plan, opts),
  };
}

/**
 * The current ledger.
 *
 * ⚠️ SIGNATURE DIFFERS FROM THE OTHER TWO ON PURPOSE: it takes no model
 * arguments at all, so its second parameter is the CALLER's round options. There
 * is nothing here a model could pass, and giving it a knob it does not need is
 * how a status call turns into a filter nobody asked for.
 */
export function planStatus(root, opts = {}) {
  const loaded = loadPlan(root);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (!loaded.plan) {
    return {
      ok: true,
      exists: false,
      // Not an error — asking is legitimate — but the answer has to say what to
      // do next, or the model spends its next round asking again.
      hint: 'no plan has been recorded for this workspace; call plan_start if this task has more than one deliverable',
      quarantined: loaded.quarantined,
      banner: formatBanner(null, opts),
    };
  }
  const plan = loaded.plan;
  return {
    ok: true,
    exists: true,
    task: plan.task,
    steps: compact(plan.steps),
    outstanding: compact(outstanding(plan)),
    quarantined: loaded.quarantined,
    banner: formatBanner(plan, opts),
  };
}

/**
 * ⚠️ THE DESCRIPTIONS CARRY THE BEHAVIOUR, because a tool description is the
 * only documentation the model ever reads. Two things are said explicitly here
 * and nowhere else: mark a step done only when it is ACTUALLY done, and the last
 * step is the one that dies — do it before the interesting one.
 */
export function planToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'plan_start',
        description: [
          'Record the deliverables for a task that has more than one, BEFORE you start work.',
          'Every later tool result then carries a line telling you how many are left and how many',
          'rounds remain — without it you cannot see the round budget running out, and the LAST',
          'thing you were asked for is the one that gets lost.',
          'List the deliverables in the order you will produce them, and put a commit or a final',
          'write EARLY enough that it survives.',
          'If a plan already exists for this workspace it is returned instead of overwritten, with',
          'its unfinished steps — continue that work with plan_step rather than starting again.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'One line restating what you were asked to do.' },
            steps: {
              type: 'array',
              items: { type: 'string' },
              description: `The deliverables, one short sentence each, in order. 1–${MAX_STEPS} of them.`,
            },
            replace: {
              type: 'boolean',
              description: 'Only to discard an existing unfinished plan for a genuinely different task.',
            },
          },
          required: ['task', 'steps'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'plan_step',
        description: [
          'Mark one planned step done, doing or blocked.',
          'Mark it done only when the deliverable actually exists and you have checked it —',
          'nothing else marks steps for you, and a plan that says done over work that is not done',
          'is worse than no plan.',
          'Use blocked, with a note saying why, when you cannot finish one; that is how it still',
          'appears in the outstanding list at the end.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The step id from plan_start, e.g. "s3".' },
            state: { type: 'string', enum: PLAN_STATES, description: 'The new state of that step.' },
            note: { type: 'string', description: 'Optional one-line reason, mainly for blocked.' },
          },
          required: ['id', 'state'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'plan_status',
        description: [
          'Show the current plan: every step, its state, and what is still outstanding.',
          'Use it when you have lost track of what is left, or at the start of a session that is',
          'continuing earlier work.',
        ].join(' '),
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
}
