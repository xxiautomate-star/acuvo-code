/**
 * ── ⭐⭐ WHICH FILES DID THIS TOOL CALL ACTUALLY CHANGE — ONE ANSWER ─────────
 *
 * ⚠️ THIS CONCEPT LIVED IN THREE PLACES AND THEY DISAGREED, which is how the
 * package has already lost files:
 *
 *   · `parallel.mjs:83` read `rec.mutatedPath ?? rec.result.path` — correct,
 *     and the comment above it records the bug that forced `mutatedPath` to
 *     exist at all: `see_page`'s `result.path` is the page it READ, so two
 *     tasks that merely looked at one page were reported as colliding over it
 *     and `--parallel` exited 1 on work that never conflicted.
 *   · `best-of.mjs:167` read `record.args?.path` — a DIFFERENT field. Measured
 *     by reading `write-many.mjs:128`: a `write_files` call carries `files[]`
 *     in its arguments and has no top-level `path`, so a winning attempt that
 *     wrote 45 files in one bulk call had NONE of them copied back out of the
 *     attempt directory. Silently, and reported as a success.
 *   · `subagent.mjs:91` read `rec.args?.path ?? rec.result?.path`, a third
 *     spelling again.
 *
 * ⭐ ONE FUNCTION, AND EVERY CALLER ASKS IT. A future tool that touches disk in
 * a new shape gets taught here, once, instead of in three files that will not
 * all be found — and the third one to be missed is always the one that matters.
 *
 * ⚠️ IT IS A LEAF ON PURPOSE: zero imports, node builtins included. `handoff`,
 * `parallel` and `best-of` all need it and two of them import each other, so
 * anything less than a leaf reintroduces a cycle.
 */

/**
 * @param {any} record a dispatcher record: `{ name, args, result, mutated, mutatedPath? }`
 * @returns {string[]} workspace-relative paths, in the order the tool reports them
 */
export function changedPaths(record) {
  /**
   * ⚠️ `mutated` IS THE GATE, NOT THE TOOL NAME. The dispatcher sets it
   * (`tools.mjs:816` says so outright) precisely so a future tool that also
   * touches disk cannot be missed by a name-based check.
   */
  if (!record?.mutated) return [];

  const out = [];
  const push = (p) => { if (typeof p === 'string' && p.trim() && !out.includes(p)) out.push(p); };

  /**
   * ── ⭐⭐ `written[]` — THE ONE MULTI-FILE SHAPE, AND NOW TWO TOOLS USE IT ──
   *
   * Read it FIRST. Such a record also carries `mutatedPath`, but only when
   * exactly ONE file landed (`tools.mjs:954`), so trusting that field alone
   * silently drops 44 of 45.
   *
   * ⭐ `delegate` WITH `write: true` REPORTS THE SAME SHAPE. That was a
   * deliberate choice over inventing an `applied[]` field: a second spelling
   * of "these files changed" would need an arm here, an arm in `report.mjs`,
   * and an arm in every future reader — which is precisely the three-way
   * disagreement described above. Reusing the shape means a delegated build
   * is understood by every reader that already understood a bulk write, with
   * no new line of code anywhere.
   */
  for (const f of record.result?.written ?? []) push(f?.path);

  // ⚠️ `mutatedPath` BEFORE `result.path` — see the `see_page` note above.
  if (out.length === 0) push(record.mutatedPath ?? record.result?.path);

  /**
   * ── ⚠️⚠️ `args.path` IS THE LAST RESORT, AND ITS ORDER IS THE WHOLE POINT ──
   *
   * This function has to be a strict SUPERSET of what each caller did before
   * it, or consolidating three readers into one is how the fourth thing breaks.
   * `best-of.mjs` read `args.path` and nothing else, so a record shaped only
   * that way must still resolve — otherwise this "cleanup" would stop best-of
   * applying files, which is the exact category of regression it was written to
   * prevent.
   *
   * ⚠️ BUT IT MUST NEVER BE CONSULTED FIRST. `args.path` is the RAW STRING A
   * MODEL WROTE; the fields above are what the tool RESOLVED and actually
   * touched — `./src/a.ts` and `src/a.ts` are one file and only the resolved
   * form says so. And `see_page`'s `args.path` is the page it READ while its
   * `mutatedPath` is the screenshot it wrote, so reading arguments first would
   * re-open the bug that forced `mutatedPath` into existence: two tasks that
   * merely looked at one page, reported as colliding over it.
   */
  if (out.length === 0) push(record.args?.path);
  return out;
}
