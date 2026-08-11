/**
 * ── ⭐⭐ SEVERAL TASKS AT ONCE — ROMAN HAS ASKED FOR THIS FOUR TIMES ──────────
 *
 * *"so people can do mass work and multiple terminals, that's a good ass
 * feature."* It is, and nobody in this category ships it well.
 *
 * The naive version is `for (const t of tasks) await run(t)`, which is not
 * parallel, and the naive-parallel version is `Promise.all(tasks.map(run))`,
 * which is parallel and dangerous. This file is the difference.
 *
 * ── ⚠️ THE THING THAT MAKES THIS HARD IS NOT CONCURRENCY, IT IS COLLISION ────
 * Two agents in ONE workspace will eventually write the same file. Whoever
 * finishes second wins, silently, and the first task reports success for work
 * that no longer exists. ⭐ That is the failure to design around — not speed.
 *
 * Three honest options, and why this one:
 *
 *   · **Merge them.** No. Merging two model-authored versions of a file without
 *     a human is how you get code that compiles and means nothing.
 *   · **Lock per file.** Tempting, but a lock held across a model call is a
 *     minute of one task blocking another, and deadlock is a real outcome once
 *     two tasks want two files in different orders.
 *   · **Let them run, DETECT the overlap, and refuse to pretend.** ⭐ This one.
 *     Every task records the files it wrote; an overlap is reported loudly with
 *     both task names, and the run is marked conflicted. Nothing is silently
 *     lost, and the human decides.
 *
 * ⚠️ Sequential remains the default and always will be. Parallelism is opt-in
 * because the safe thing must be what happens when you do not think about it.
 */

/** Sensible ceiling. Beyond this the provider rate-limits and everything slows. */
export const MAX_CONCURRENCY = 4;

/**
 * Run tasks with bounded concurrency, preserving input order in the results.
 *
 * `runOne(task, index)` performs one task and resolves to its outcome.
 *
 * ⚠️ A REJECTION BECOMES A RESULT, NEVER AN UNHANDLED THROW. One task failing
 * must not abandon three that are mid-flight — `Promise.all` semantics here
 * would strand real work in a half-written state.
 */
export async function runPool(tasks, runOne, { concurrency = 2 } = {}) {
  const limit = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY));
  const results = new Array(tasks.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        results[i] = { ok: true, index: i, task: tasks[i], outcome: await runOne(tasks[i], i) };
      } catch (err) {
        results[i] = { ok: false, index: i, task: tasks[i], error: err?.message ?? String(err) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Which files did each task write, and did any two collide?
 *
 * ⚠️ READS `mutated`, NOT THE TOOL NAME. A future tool that also touches disk
 * would be invisible to a name-based check — the dispatcher already sets
 * `mutated` for exactly this reason, and trusting it keeps one source of truth.
 */
export function detectConflicts(results) {
  /** @type {Map<string, string[]>} path -> task labels that wrote it */
  const byPath = new Map();
  for (const r of results) {
    if (!r?.ok || !r.outcome?.executed) continue;
    const label = shortLabel(r.task, r.index);
    for (const rec of r.outcome.executed) {
      // ⚠️ `mutatedPath` FIRST — see tools.mjs. `see_page`'s `result.path` is the
      // page it READ, so without this two tasks that merely looked at the same
      // file are reported as having collided over it, and `--parallel` exits 1
      // on work that never conflicted.
      const path = rec?.mutatedPath ?? rec?.result?.path;
      if (!rec?.mutated || !path) continue;
      const list = byPath.get(path) ?? [];
      if (!list.includes(label)) list.push(label);
      byPath.set(path, list);
    }
  }
  const conflicts = [...byPath.entries()]
    .filter(([, who]) => who.length > 1)
    .map(([path, who]) => ({ path, tasks: who }));
  return { conflicts, filesTouched: byPath.size };
}

/** A stable, short name for a task, for use in reports. */
export function shortLabel(task, index) {
  const t = String(task ?? '').trim().replace(/\s+/g, ' ');
  return `#${index + 1} ${t.length > 42 ? `${t.slice(0, 39)}…` : t}`;
}

/**
 * Render the whole run.
 *
 * ⭐ CONFLICTS ARE THE HEADLINE, NOT A FOOTNOTE. If two tasks wrote the same
 * file, that is the most important fact on the screen — more important than any
 * of them "succeeding", because one of those successes is a lie.
 */
export function formatParallelSummary(results, { conflicts, filesTouched }) {
  const lines = ['', '─'.repeat(66)];
  const done = results.filter((r) => r?.ok && r.outcome?.ok).length;
  const cost = results.reduce((a, r) => a + (r?.outcome?.usage?.cost ?? 0), 0);

  for (const r of results) {
    if (!r) continue;
    const label = shortLabel(r.task, r.index);
    if (!r.ok) { lines.push(`  ✖ ${label} — ${r.error}`); continue; }
    const o = r.outcome;
    const wrote = (o?.executed ?? []).filter((e) => e.mutated).length;
    const verdict = o?.ok === false ? '✖ failed' : o?.verification?.passed ? '✔ verified' : '· done';
    lines.push(`  ${verdict}  ${label}  ${wrote} file${wrote === 1 ? '' : 's'}`);
  }

  lines.push('', `  ${done}/${results.length} tasks · ${filesTouched} file${filesTouched === 1 ? '' : 's'} touched${cost ? ` · $${cost.toFixed(4)}` : ''}`);

  if (conflicts.length > 0) {
    lines.push('');
    lines.push(`  ⚠ ${conflicts.length} FILE${conflicts.length === 1 ? '' : 'S'} WRITTEN BY MORE THAN ONE TASK:`);
    for (const c of conflicts) {
      lines.push(`     ${c.path}`);
      lines.push(`       ${c.tasks.join('  ·  ')}`);
    }
    lines.push('');
    lines.push('  ⚠ The last writer won. Whatever the other task did to that file is GONE —');
    lines.push('    check it before trusting either result. Run them sequentially to avoid this.');
  }
  return lines;
}
