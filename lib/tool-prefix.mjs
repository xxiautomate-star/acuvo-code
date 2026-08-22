/**
 * ── ⭐⭐ THE TOOLS BLOCK IS BYTE 0 OF EVERY REQUEST, SO ITS ORDER IS MONEY ───
 *
 * `PRICING.md` sizes the ladder on a cache floor, and a floor is
 * `sharedHead ÷ typicalPrompt`. MEASURED on this repo, 2026-08-16, through the
 * real `runSession` against three different repositories: the shared head
 * between two tenants is **22,889 bytes, of which 21,466 — 94% — is the tool
 * schema block**. It is the first thing on the wire and it is almost the whole
 * of what any two requests have in common.
 *
 * ── ⚠️⚠️ AND HALF OF IT IS CONDITIONAL, SITTING IN THE MIDDLE ───────────────
 *
 * `toolNamesForRounds` decides what to OFFER from the machine's configuration —
 * `--no-run`, `ACUVO_ALLOW_PUSH`, the `MODAL_*` endpoints, whether stdin is a
 * TTY, whether this is a subagent. `toolSchemasFor` then filters the registry,
 * which preserves REGISTRY order — and the optional tools are registered in the
 * middle of it (`run_command` at index 3, `git_push` at 15, `generate_image` at
 * 16, `speak` at 18).
 *
 * ⚠️ SO ONE ABSENT TOOL DOES NOT COST ITS OWN 400 BYTES. It costs everything
 * behind it: the rest of the tools block, the system message, the repo map and
 * the task. Measured, same day, against a bare-machine reference of 31,354
 * bytes:
 *
 *     configuration difference        shared prefix     of the tools block
 *     --no-run                            1,199 B                    3.8%
 *     ACUVO_ALLOW_PUSH=1                 10,693 B                   32.9%
 *     MODAL_TTS_URL set                  11,766 B                   37.1%
 *     stdin is a TTY (ask_user)          17,386 B                   53.6%
 *     running as a subagent              15,500 B                   49.4%
 *
 * ⚠️⚠️ READ THE TTY ROW AGAIN. Same user, same machine, same repository, same
 * task — `acuvo "…"` typed at a terminal and the same command in CI share
 * **half** their prompt prefix, because one of them is offered `ask_user` and
 * the schema for it is registered at index 37 instead of last.
 *
 * ── ⭐ THE FIX IS AN ORDERING CHANGE AND NOTHING ELSE ───────────────────────
 *
 * Constant first, conditional last. The model is offered exactly the same tools
 * with exactly the same descriptions; only their position in the array moves,
 * and a `tools` array is a SET of available functions, not a ranking. Measured
 * gain, same variants:
 *
 *     configuration difference        before        after
 *     --no-run                        1,199 B     19,191 B     (16.0x)
 *     ACUVO_ALLOW_PUSH=1             10,693 B     21,893 B      (2.0x)
 *     MODAL_TTS_URL set              11,766 B     22,966 B      (2.0x)
 *     stdin is a TTY                 17,386 B     24,206 B      (1.4x)
 *     running as a subagent          15,500 B     22,968 B      (1.5x)
 *
 * ⭐ AND IT COSTS NO CONTEXT QUALITY, WHICH IS THE RULE THAT OUTRANKS THE CACHE.
 * Nothing is dropped, summarised, withheld or reworded. Not compacting to
 * protect a prefix causes context drift and drift is far more expensive than a
 * miss — this is the opposite trade: the same context, in a cheaper order.
 *
 * ⚠️ `run_command` moves from index 3 to the tail, which is the one visible
 * consequence worth naming. It is still offered, still described identically,
 * and the verbs a model reaches for first — `read_file`, `write_file`,
 * `edit_file`, `list_dir`, `search_text` — are unmoved at the head.
 */

import { toolNamesForRounds } from './tools.mjs';

/**
 * ── ⚠️⚠️ THE CORE IS DERIVED, NEVER HAND-LISTED ─────────────────────────────
 *
 * A written-down list of "the tools that are always offered" is a SECOND COPY of
 * a fact that lives in `toolNamesForRounds`'s control flow, and the second copy
 * is the one that goes stale. The failure would be silent and expensive: add a
 * new conditional tool, forget the list, and it lands in the middle of the head
 * again — voiding every prompt on every machine that does not have it, with
 * nothing going red.
 *
 * So the core is computed by ASKING the offer function, across the configuration
 * space, and intersecting the answers.
 *
 * ── ⭐⭐ AND THE DERIVATION IS MACHINE-INDEPENDENT BY CONSTRUCTION ──────────
 *
 * ⚠️ THIS IS THE TRAP THAT NEARLY SHIPPED. The obvious version derives the core
 * from the offers available on THIS machine — and then a machine with a
 * language server present puts `check_types` in the core, a machine without it
 * does not, the two produce different ORDERS, and the ordering meant to protect
 * the prefix becomes the thing that destroys it. That is `localeCompare` in
 * `lib/prefix-order.mjs` wearing a different hat: a sort whose result depends on
 * the environment is not a sort, it is a per-machine cache pool.
 *
 * ⭐ So every probe runs against a root that CANNOT EXIST. Skills and the LSP
 * verbs are gated on files under the workspace, so a non-existent root offers
 * neither, on every machine, for ever. The derived core is therefore a pure
 * function of this package's own code — identical in CI, on Roman's laptop and
 * on the box the gateway runs on, which is the only way two tenants can share a
 * byte-identical head at all.
 *
 * ⚠️ AND THE ERROR DIRECTION IS SAFE. An intersection can only ever SHRINK the
 * core, so an unsampled configuration can push a tool OUT of the head (costing a
 * little ordering) and can never sneak one IN (which would cost the prefix). A
 * tool this misses is a tool in the tail, and the tail is always correct.
 */

/**
 * A path no workspace uses, so `existsSync` is false everywhere. ⚠️ It is never
 * created, read or written — only NAMED, so that the root-gated verbs answer
 * "absent" identically on every machine.
 *
 * ⚠️ ORDINARY CHARACTERS ONLY. The first draft of this constant separated its
 * words with literal NUL bytes, which render as NOTHING in every viewer — so the
 * source read as a normal path, the test asserting the path does not exist was
 * checking a DIFFERENT string, and both passed. `cache-prefix-stability.test.mjs`
 * records the same trap in its own separators: a control character in source is
 * a value nobody can review.
 */
const NOWHERE = '/acuvo-cache-core-probe-no-such-workspace';

/**
 * Which environment variables does the offer even consult? Recorded rather than
 * guessed, so a new gate on a new variable is sampled the day it is written.
 *
 * ⚠️ `has` AND `ownKeys` ARE TRAPPED TOO, not just `get`. A gate written as
 * `'MODAL_TTS_URL' in env` reads through a different trap, and a spy that only
 * watched `get` would report the variable as unread and leave its tool in the
 * head.
 *
 * ⚠️ AND THOSE TWO TRAPS ARE NOT COVERED BY A TEST, because no gate in the
 * package reaches them today — deleting them leaves the suite green. That is
 * stated rather than papered over: they are insurance against the next gate, and
 * the thing that WOULD catch a miss is the brute-force re-derivation in
 * `test/tool-prefix-order.test.mjs`, which samples the variables directly.
 */
function envKeysConsulted(maxRounds) {
  const seen = new Set();
  const spy = new Proxy({}, {
    get(_t, key) { if (typeof key === 'string') seen.add(key); return undefined; },
    has(_t, key) { if (typeof key === 'string') seen.add(key); return false; },
    ownKeys() { return []; },
    getOwnPropertyDescriptor() { return undefined; },
  });
  try {
    toolNamesForRounds(maxRounds, { allowRun: true, root: NOWHERE, env: spy });
  } catch {
    /* a spy that upsets a future gate must not take the ordering down with it */
  }
  return [...seen].sort();
}

/**
 * ⚠️ FOUR ENVIRONMENT POINTS, AND THE EMPTY STRING IS NOT REDUNDANT. Gates in
 * this package are deliberately not all the same shape: `PERCHANCE_IMAGE_URL`
 * UNSET means "use the public endpoint, offer the tool", and set-but-EMPTY means
 * "this machine has switched it off". Sampling only unset would leave
 * `generate_image` looking unconditional.
 */
const ENV_SAMPLES = ['', '1', 'https://example.invalid'];

/** Memoised per rounds-bucket: the derivation is pure, so it is computed once. */
const cache = new Map();

/**
 * The tools offered under EVERY configuration — the ones whose bytes may sit in
 * the shared head.
 *
 * ⚠️ BUCKETED ON `maxRounds <= 1`, because that is the only threshold
 * `toolNamesForRounds` has: a single-shot turn returns `SINGLE_SHOT_TOOL_NAMES`
 * and shares almost nothing with a multi-round offer. They are different cache
 * pools by nature and pretending otherwise would put a multi-round tool in a
 * single-shot head.
 *
 * @param {number} maxRounds
 * @returns {Set<string>}
 */
export function alwaysOfferedNames(maxRounds) {
  const bucket = Number(maxRounds) <= 1 ? 'single' : 'multi';
  const memo = cache.get(bucket);
  if (memo) return memo;

  const rounds = bucket === 'single' ? 1 : 8;
  const keys = envKeysConsulted(rounds);
  const envs = [{}, ...ENV_SAMPLES.map((v) => Object.fromEntries(keys.map((k) => [k, v])))];

  /** @type {Set<string> | null} */
  let core = null;
  for (const allowRun of [true, false]) {
    for (const subagent of [true, false]) {
      for (const interactive of [true, false]) {
        for (const env of envs) {
          let offered;
          try {
            offered = toolNamesForRounds(rounds, { allowRun, subagent, interactive, root: NOWHERE, env });
          } catch {
            /* a configuration the offer refuses contributes nothing to the intersection */
            continue;
          }
          const names = new Set(offered);
          core = core === null ? names : new Set([...core].filter((n) => names.has(n)));
        }
      }
    }
  }

  const result = core ?? new Set();
  cache.set(bucket, result);
  return result;
}

/**
 * ── ⭐ CONSTANT FIRST, CONDITIONAL LAST, EACH HALF IN ITS ORIGINAL ORDER ────
 *
 * ⚠️ A STABLE PARTITION, NOT A SORT. Both halves keep the order they arrived in
 * — registry order, which is already deterministic — so this adds no second
 * ordering rule that could disagree with the first. Two machines offering the
 * same tools produce byte-identical output; two machines differing by one tool
 * differ only in the tail.
 *
 * ⚠️ IT NEVER ADDS, REMOVES OR EDITS A SCHEMA. The output is a permutation of
 * the input and nothing else — that property is what makes this safe to apply on
 * the model's door, and it is asserted directly rather than reviewed.
 *
 * @param {Array<{ function?: { name?: string } }>} schemas as `toolSchemasFor` returned them
 * @param {{ maxRounds?: number }} [opts]
 * @returns {Array<any>} the same schemas, constant ones first
 */
export function orderForCachePrefix(schemas, { maxRounds = 8 } = {}) {
  if (!Array.isArray(schemas) || schemas.length === 0) return Array.isArray(schemas) ? [...schemas] : [];
  const core = alwaysOfferedNames(maxRounds);
  const isCore = (t) => core.has(t?.function?.name);
  return [...schemas.filter(isCore), ...schemas.filter((t) => !isCore(t))];
}
