/**
 * ── ⭐⭐ THE BENCH RESULT, AS A DOCUMENT RATHER THAN A SCROLLBACK ───────────
 *
 * Every number `bench/run.mjs` produced used to live in a terminal and die
 * there. So the one question the whole apparatus exists to answer — *"is it
 * better than it was last week"* — could only be answered by a human
 * remembering, which is exactly the loop `bench/tasks.mjs`'s own header says
 * does not scale.
 *
 * ── ⚠️ WHY THIS IS A SEPARATE FILE AND NOT AN INLINE OBJECT LITERAL ────────
 *
 * Because a guard has to be able to fail. `run.mjs` spends real money and needs
 * a real model, so nothing in the test suite can execute it; an inline literal
 * would therefore be pinned only by a regex over source, and this repo has
 * already recorded what that is worth — *"if a guard is a source regex, it can
 * only ever prove the TEXT changed"*. Pure, exported, and fed fabricated
 * results, every field below is assertable for $0.
 *
 * ⚠️ AND THE COMPARABILITY FIELDS ARE PART OF THE SHAPE, not extras. `run.mjs`
 * argues at length that a "46% cost regression" between two days may be nothing
 * but a different upstream or a cold cache — it printed `served` and `cached` on
 * the line and then threw them away. Two runs that cannot be told apart from a
 * routing change are two runs that cannot be compared at all.
 */

/**
 * ⚠️ BUMP WHEN A FIELD CHANGES MEANING, never merely when one is added. A
 * consumer reading an old file has to be able to tell "this key is absent"
 * from "this key meant something else then".
 */
export const BENCH_SCHEMA = 1;

/**
 * @param {object} args
 * @param {Array<{task: object, res: object, failures: string[]}>} args.results
 * @param {(t: object) => string} args.suiteOf
 * @param {{only: string[]|null, suite: string|null}} args.selection
 * @param {{cli: string|null, node: string, platform: string, at: string}} args.env
 */
export function benchDocument({ results = [], suiteOf = () => 'core', selection = {}, env = {} } = {}) {
  const tasks = results.map((r) => ({
    id: r.task.id,
    suite: suiteOf(r.task),
    what: r.task.what,
    passed: r.failures.length === 0,
    /** ⚠️ THE STRINGS, not a count. A count says it broke; these say how. */
    failures: r.failures,
    checks: r.task.checks.length,
    /**
     * ⭐ BOTH NUMBERS. `rounds` alone cannot detect a truncated run — the same
     * argument `report.mjs` makes for shipping `maxRounds` beside `rounds`.
     * A task that used 14 of 14 was cut off; one that used 4 of 9 finished.
     */
    roundBudget: r.task.rounds ?? null,
    rounds: r.res.rounds,
    seconds: r.res.seconds,
    costUsd: r.res.cost,
    verified: r.res.verified,
    exitCode: r.res.exitCode,
    // The two fields that decide whether two runs are comparable at all.
    providers: r.res.providers ?? null,
    cacheHit: typeof r.res.cacheHit === 'number' ? r.res.cacheHit : null,
    refusals: r.res.refusals ?? [],
  }));

  return {
    schema: BENCH_SCHEMA,
    at: env.at ?? new Date().toISOString(),
    /** Which build produced these. ⚠️ `null` when unreadable, never a guess. */
    cli: env.cli ?? null,
    node: env.node ?? null,
    platform: env.platform ?? null,
    selection: {
      only: selection.only ?? null,
      suite: selection.suite ?? null,
      tasks: tasks.length,
    },
    totals: {
      passed: tasks.filter((t) => t.passed).length,
      ofTasks: tasks.length,
      costUsd: tasks.reduce((a, t) => a + (t.costUsd ?? 0), 0),
      seconds: tasks.reduce((a, t) => a + (t.seconds ?? 0), 0),
      rounds: tasks.reduce((a, t) => a + (t.rounds ?? 0), 0),
      refusals: tasks.reduce((a, t) => a + t.refusals.length, 0),
      /**
       * ⭐ A TASK THAT SPENT ITS WHOLE BUDGET IS THE INTERESTING ONE and no
       * pass/fail column shows it. It may have passed by luck on the last
       * round it was allowed, which is a different fact from passing in four.
       */
      atRoundCap: tasks.filter((t) => t.roundBudget !== null && t.rounds >= t.roundBudget).map((t) => t.id),
    },
    tasks,
  };
}
