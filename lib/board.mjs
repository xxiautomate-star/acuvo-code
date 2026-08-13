/**
 * ── ⭐⭐ THE TASK BOARD — SEVEN TERMINALS, SEVEN JOBS, NOBODY DOING THE SAME ONE ─
 *
 * The stated direction for this tool is *"open seven terminals and have seven AI
 * workers building your software in the same brain, and they are cheap"*. Nearly
 * all of that already worked and was measured: seven terminals run today, they
 * are $0.001–0.003 a task, `lease.mjs` stops two of them writing one file,
 * `auto-lease.mjs` made that automatic, `fleet-budget.mjs` caps the whole
 * workspace for the day, and the plan ledger is now per worker.
 *
 * The one missing piece was never a lock. It is that **nothing said what the
 * work WAS**. Seven terminals meant seven people typing seven prompts, and
 * nothing stopped two of them typing the same one.
 *
 * ── ⭐⭐ AND THE DESIGN IS: THERE IS NO NEW LOCKING HERE ─────────────────────
 *
 * A task board looks like it needs a queue with a mutex. It does not, and the
 * reason is worth stating because it is the whole reason this file is short:
 *
 *     a task IS a file, and claiming one IS taking a lease on that file.
 *
 * `.acuvo/board/<id>.json` is a real path inside the workspace, so
 * `lease.mjs` — 786 lines of proven, raced-by-eight-real-processes,
 * TTL-reclaiming, takeover-capped exclusive claim — works on it UNMODIFIED.
 * Measured before this file was written: a lease on `.acuvo/board/t3.json` is
 * granted, a second terminal is refused with `heldBy`, and `acuvo leases`
 * already renders it. Nothing here re-invents any of that.
 *
 * ⭐ Which also means every property already argued for leases comes free: a
 * worker that dies mid-task has its claim reclaimed after the TTL rather than
 * blocking the board forever, and `acuvo leases` is already the answer to "who
 * is doing what".
 *
 * ── ⚠️ WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────
 *
 * There are no `board_*` TOOLS. The model cannot add, claim or complete a task,
 * and that is a decision rather than an omission: agent-callable claiming is a
 * second unproven behaviour riding on a board that has not yet been used once.
 * The workflow that actually exists is a person opening seven windows and
 * typing, so the board is a CLI surface for that person. Give it a week of real
 * use before letting the thing being scheduled do the scheduling.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveInWorkspace } from './workspace.mjs';
import { acquire, release, inspect } from './lease.mjs';

export const BOARD_DIR = '.acuvo/board';
/** A task longer than this is a project, and a project is not a board entry. */
export const MAX_TASK_CHARS = 400;
/** Enough for any real fleet; a bound so a runaway script cannot fill a disk. */
export const MAX_TASKS = 200;

const nowIso = () => new Date().toISOString();

/**
 * ⚠️ SORTABLE AND COLLISION-RESISTANT, in that order of importance. Two
 * terminals can add a task in the same millisecond, so the timestamp alone is
 * not an id — but the timestamp PREFIX is what makes `readdirSync` return the
 * board in the order it was written without anybody sorting by a parsed field.
 */
function newId(clock = Date.now, rand = () => Math.random()) {
  const stamp = new Date(clock()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const salt = Math.floor(rand() * 46_656).toString(36).padStart(3, '0');
  return `${stamp}-${salt}`;
}

function boardPathFor(root, id) {
  return resolveInWorkspace(root, `${BOARD_DIR}/${id}.json`, 'write');
}

/**
 * Add one task. Returns the id, which is what a person needs to talk about it.
 */
export function boardAdd(root, text, { clock = Date.now, rand = () => Math.random() } = {}) {
  const task = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!task) return { ok: false, error: 'a board task needs some text — an empty one cannot be picked up' };
  if (task.length > MAX_TASK_CHARS) {
    return { ok: false, error: `that task is ${task.length} characters, over the ${MAX_TASK_CHARS} limit. Put the detail in the repo, not on the board.` };
  }

  const existing = boardList(root);
  if (existing.ok && existing.tasks.length >= MAX_TASKS) {
    return { ok: false, error: `the board already holds ${existing.tasks.length} tasks (limit ${MAX_TASKS}) — finish or remove some before adding more` };
  }

  const id = newId(clock, rand);
  const target = boardPathFor(root, id);
  if (!target.ok) return { ok: false, error: target.reason };

  try {
    mkdirSync(join(root, BOARD_DIR), { recursive: true });
    /**
     * ⚠️ `wx` — EXCLUSIVE CREATE. Two terminals adding in the same millisecond
     * would otherwise silently overwrite one another's task, and a board that
     * loses work is worse than no board. The id has a random salt, so a
     * collision is already unlikely; refusing outright is what makes it
     * impossible rather than unlikely.
     */
    writeFileSync(target.absolute, `${JSON.stringify({ id, task, addedAt: nowIso(), state: 'todo' }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    return { ok: false, error: `could not add the task: ${err?.message ?? err}` };
  }
  return { ok: true, id, task };
}

/** Every task, with who holds it, oldest first. */
export function boardList(root) {
  const dir = join(root, BOARD_DIR);
  if (!existsSync(dir)) return { ok: true, tasks: [] };

  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    return { ok: false, error: `could not read the board: ${err?.message ?? err}`, tasks: [] };
  }

  /**
   * ⭐ WHO HOLDS WHAT COMES FROM `lease.mjs`, NOT FROM THE TASK FILE. A holder
   * written into the task itself would be a second copy of a fact the lease
   * layer already owns — and it would go stale the moment a worker died,
   * because a dead process cannot come back to correct its own file. The lease
   * expires on its own; a field would not.
   */
  const held = new Map();
  try {
    for (const l of inspect(root)?.leases ?? []) held.set(l.path, l);
  } catch { /* an unreadable lease dir means we cannot say who holds what, not that the board is gone */ }

  const tasks = [];
  for (const name of names) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      // ⚠️ Counted, not skipped silently — a task nobody can read is still work
      // somebody wrote down, and pretending it is absent is how it gets lost.
      tasks.push({ id: name.replace(/\.json$/, ''), task: '(unreadable — the file is not valid JSON)', state: 'damaged', heldBy: null });
      continue;
    }
    const lease = held.get(`${BOARD_DIR}/${rec.id}.json`);
    tasks.push({ ...rec, heldBy: lease?.holder ?? null, heldSince: lease?.acquiredAt ?? null });
  }
  return { ok: true, tasks };
}

/**
 * Claim the oldest task nobody else holds.
 *
 * ⚠️ THE LEASE IS THE CLAIM, AND THE RACE IS ALREADY SOLVED. Two terminals
 * calling this in the same instant both see the same "first free" task; exactly
 * one wins the `acquire`, and the loser simply moves to the next one. That is
 * `lease.mjs`'s exclusive-create doing the work, which is precisely why this
 * function has no lock of its own.
 */
export function boardClaim(root, { holder, ttlMs, acquireImpl = acquire } = {}) {
  const who = String(holder ?? '').trim();
  if (!who) return { ok: false, error: 'claiming a task needs a --holder, so the board can say who is doing what' };

  const listed = boardList(root);
  if (!listed.ok) return listed;

  const open = listed.tasks.filter((t) => t.state === 'todo' && !t.heldBy);
  if (open.length === 0) {
    const total = listed.tasks.length;
    return {
      ok: false,
      empty: true,
      error: total === 0
        ? `the board is empty — add work with \`acuvo board add "…"\``
        : `every task on the board is either done or already held by another terminal (${total} total). \`acuvo board\` shows who has what.`,
    };
  }

  for (const t of open) {
    const got = acquireImpl(root, { path: `${BOARD_DIR}/${t.id}.json`, holder: who, pid: process.pid, ...(ttlMs ? { ttlMs } : {}) });
    if (got?.ok) return { ok: true, id: t.id, task: t.task, lease: got.lease };
    // Somebody won it between the list and the acquire. Try the next one —
    // that is the race resolving itself, not an error worth reporting.
  }
  return { ok: false, empty: true, error: 'every open task was claimed by another terminal while this one was looking' };
}

/** Mark a task finished and let go of it. */
export function boardDone(root, id, { lease = null, releaseImpl = release } = {}) {
  const target = boardPathFor(root, String(id ?? '').trim());
  if (!target.ok) return { ok: false, error: target.reason };
  if (!existsSync(target.absolute)) return { ok: false, error: `no task on the board has the id "${id}"` };

  let rec;
  try {
    rec = JSON.parse(readFileSync(target.absolute, 'utf8'));
  } catch (err) {
    return { ok: false, error: `that task file could not be read: ${err?.message ?? err}` };
  }
  try {
    writeFileSync(target.absolute, `${JSON.stringify({ ...rec, state: 'done', doneAt: nowIso() }, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not mark the task done: ${err?.message ?? err}` };
  }
  if (lease) { try { releaseImpl(lease); } catch { /* the TTL clears it */ } }
  return { ok: true, id: rec.id, task: rec.task };
}

/** The human view. Same shape as every other report in this package. */
export function formatBoard(listed) {
  if (!listed?.ok) return `board: ${listed?.error ?? 'unavailable'}`;
  if (listed.tasks.length === 0) {
    return 'The board is empty.\n\n  Add work with:  acuvo board add "make the failing suite pass"\n  Then claim it:  acuvo --holder t1 --claim';
  }
  const lines = [];
  const todo = listed.tasks.filter((t) => t.state === 'todo');
  const done = listed.tasks.filter((t) => t.state === 'done');
  lines.push(`${listed.tasks.length} task${listed.tasks.length === 1 ? '' : 's'} — ${todo.filter((t) => !t.heldBy).length} open, ${todo.filter((t) => t.heldBy).length} in progress, ${done.length} done`);
  lines.push('');
  for (const t of listed.tasks) {
    const mark = t.state === 'done' ? '✔' : t.heldBy ? '▶' : '·';
    /**
     * ⚠️ A FINISHED TASK SHOWS NO HOLDER. Its lease often outlives it — a
     * worker that finished and exited without releasing leaves the record until
     * the TTL clears it — and "✔ done ← t1" reads as *t1 is working on this*,
     * which is the opposite of what it means. The holder is only interesting
     * while the work is in flight.
     */
    const who = t.heldBy && t.state !== 'done' ? `  ← ${t.heldBy}` : '';
    lines.push(`  ${mark} ${t.id}  ${t.task}${who}`);
  }
  return lines.join('\n');
}
