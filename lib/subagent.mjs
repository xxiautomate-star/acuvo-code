/**
 * ── ⭐⭐ SUBAGENTS — DELEGATION, AND THE CHEAPEST CONTEXT THERE IS ───────────
 *
 * The main loop can now say "go and find where this is defined across 400
 * files" and get back two hundred tokens instead of fifty thousand.
 *
 * ⚠️ THIS IS NOT `--parallel`. That runs N unrelated tasks a HUMAN typed, in
 * separate workspaces, with collision detection between them. This is one task
 * asking for help mid-thought, and the help happens in its own head.
 *
 * ── ⭐ WHY IT IS A MARGIN FEATURE AS WELL AS A CONTEXT ONE ──────────────────
 * Measured 2026-08-11: DeepSeek caches prompt prefixes automatically and a hit
 * costs up to 50x less — but ONLY while the prefix repeats byte-for-byte from
 * token 0. Every noisy search a parent performs itself lands in the parent's
 * message array and pushes the useful part further from the cached head. A
 * subagent's exploration never touches that array at all, so the expensive
 * cached prefix survives work that would otherwise pollute it.
 *
 * ⭐ Context hygiene and cost are the same lever, and almost nobody treats them
 * that way.
 *
 * ── ⚠️ THE FOUR RULES, AND THE FAILURE EACH ONE PREVENTS ───────────────────
 *
 * 1. ⚠️⚠️ READ-ONLY, AND LOCKED TWICE. A subagent that writes can collide with
 *    the parent editing the same file, and whoever finishes second wins
 *    silently. `parallel.mjs` exists to catch exactly that between processes and
 *    is blind to it here, because these run INSIDE one session. So the offer
 *    excludes every mutating verb AND `allowRun: false` is passed, because a
 *    model can emit a call for a tool it was never shown — the same
 *    belt-and-braces `check_acceptance` already uses.
 *
 * 2. ⚠️ NO RECURSION. A subagent that can delegate is an unbounded fork bomb
 *    billed to the user. `delegate` is absent from `SUBAGENT_TOOL_NAMES`, and
 *    depth is checked before a model is called, so both the offer and the
 *    dispatcher refuse.
 *
 * 3. ⚠️ DISTILLED, NEVER FORWARDED. Returning the transcript would defeat the
 *    whole point: the parent would pay for precisely the context it delegated
 *    to avoid. The parent gets a sentence, a cost, and a list of files touched.
 *
 * 4. ⚠️ A FAILURE IS DATA. A dead subagent returns a reason the parent can act
 *    on. Throwing into the parent's loop would take down a session that was
 *    otherwise fine, to report that a helper was not.
 */

/**
 * What a researcher may hold. Read, search, navigate — nothing that changes
 * anything.
 *
 * ⚠️ SPELLED OUT RATHER THAN FILTERED FROM THE REGISTRY. A denylist would
 * silently hand a subagent every future tool anyone adds; this way a new
 * capability reaches subagents only when somebody decides it should.
 */
export const SUBAGENT_TOOL_NAMES = Object.freeze([
  'read_file',
  'read_lines',
  'read_around',
  'list_dir',
  'find_files',
  'search_text',
  'find_definition',
  'find_references',
  'list_symbols',
  'git_status',
  'git_diff',
  'git_log',
]);

/**
 * ⚠️ ONE LEVEL. A parent may delegate; a subagent may not. Two levels sounds
 * harmless and is how a five-round task becomes a hundred model calls nobody
 * authorised.
 */
export const MAX_SUBAGENT_DEPTH = 1;

/**
 * ⚠️ A SUBAGENT MUST NOT OUTSPEND ITS PARENT. A researcher that needs more than
 * a handful of rounds is being asked the wrong question, and the honest answer
 * is a worse summary rather than a bigger bill.
 */
export const MAX_SUBAGENT_ROUNDS = 6;
const DEFAULT_SUBAGENT_ROUNDS = 4;

const MAX_SUMMARY_CHARS = 900;
const MAX_FILES_LISTED = 12;

/** Every path a set of tool records looked at, in first-seen order. */
function filesTouched(executed) {
  const seen = [];
  for (const rec of executed ?? []) {
    const p = rec?.args?.path ?? rec?.result?.path;
    if (typeof p === 'string' && p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

/**
 * Turn a finished session into the few hundred characters the parent actually
 * needs.
 *
 * ⭐ THE MODEL'S OWN CLOSING NOTE IS THE ANSWER. It is the one place the
 * subagent states what it concluded, in its own words, having seen everything.
 * Re-deriving that from tool results here would be a second, worse summariser.
 *
 * ⚠️ AND WHEN THERE IS NO NOTE, SAY SO OUT LOUD. An empty string tells the
 * parent nothing and reads as success; "found nothing" is a fact it can act on.
 */
export function summariseForParent(outcome) {
  if (!outcome || outcome.ok !== true) {
    return `the helper did not finish: ${outcome?.error ?? 'no reason given'}`;
  }

  const note = typeof outcome.note === 'string' ? outcome.note.trim() : '';
  const files = filesTouched(outcome.executed);

  if (!note) {
    return files.length
      ? `Nothing conclusive. It looked at ${files.slice(0, MAX_FILES_LISTED).join(', ')} and did not report a finding.`
      : 'Nothing conclusive — it did not report a finding, and opened no files.';
  }

  const body = note.length > MAX_SUMMARY_CHARS
    ? `${note.slice(0, MAX_SUMMARY_CHARS)}…`
    : note;

  if (files.length === 0) return body;
  const shown = files.slice(0, MAX_FILES_LISTED);
  const more = files.length - shown.length;
  return `${body}\n(looked at: ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''})`;
}

/**
 * Run one scoped, read-only helper and return what it concluded.
 *
 * @param {{ task: string, executor: any, config: any, depth?: number, maxRounds?: number,
 *           maxTokens?: number, timeoutMs?: number, onEvent?: (e:any)=>void }} args
 * @param {{ sessionImpl?: Function }} [deps]
 */
export async function runSubagent(args = {}, { sessionImpl = null } = {}) {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) {
    // ⚠️ Refused BEFORE a model is called. An empty task still costs a round.
    return { ok: false, error: 'a delegated task needs a specific question — an empty one would spend a round to learn nothing' };
  }

  const depth = Number.isFinite(args.depth) ? args.depth : 0;
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return {
      ok: false,
      error: `a helper cannot delegate again (depth ${depth}) — ask it a narrower question, or do the remaining step yourself`,
    };
  }

  const run = sessionImpl ?? (await import('./turn.mjs')).runSession;

  const maxRounds = Math.min(
    Math.max(1, Number.isFinite(args.maxRounds) ? Math.floor(args.maxRounds) : DEFAULT_SUBAGENT_ROUNDS),
    MAX_SUBAGENT_ROUNDS,
  );

  let outcome;
  try {
    outcome = await run({
      task,
      executor: args.executor,
      config: args.config,
      maxRounds,
      maxTokens: args.maxTokens,
      timeoutMs: args.timeoutMs,
      /** ⚠️ Both locks: the offer, and the dispatcher-level refusal. */
      allowRun: false,
      toolNames: [...SUBAGENT_TOOL_NAMES],
      /**
       * ⚠️ THE HELPER'S OWN DISPATCHER MUST KNOW IT IS A HELPER. The offer
       * already omits `delegate`, but a model can emit a call for a tool it was
       * never shown — so the depth travels with the session and the dispatcher
       * refuses independently. Two locks, because one of them is a list.
       */
      depth: depth + 1,
      onEvent: args.onEvent,
    });
  } catch (err) {
    // ⚠️ A helper's death must not take the parent's session with it.
    return { ok: false, error: `the helper crashed: ${err?.message ?? String(err)}` };
  }

  const usage = outcome?.usage ?? null;
  const shared = {
    costUsd: Number.isFinite(usage?.cost) ? usage.cost : 0,
    tokens: Number.isFinite(usage?.total_tokens) ? usage.total_tokens : 0,
    roundsUsed: Number.isFinite(outcome?.roundsUsed) ? outcome.roundsUsed : 0,
    files: filesTouched(outcome?.executed),
  };

  if (!outcome || outcome.ok !== true) {
    return { ok: false, error: outcome?.error ?? 'the helper returned no result', ...shared };
  }

  return { ok: true, summary: summariseForParent(outcome), ...shared };
}

/**
 * ⭐ THE DESCRIPTION IS WHERE THE JUDGEMENT LIVES. A model that does not know it
 * gets a SUMMARY back will delegate and then ask for the same files anyway,
 * paying twice. So the contract is stated in the first sentence, and the good
 * use — a broad search whose answer is small — is named explicitly.
 */
export function subagentToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'delegate',
        description:
          'Hand a READ-ONLY research question to a helper with its own fresh context, and get back a short '
          + 'SUMMARY rather than everything it read. Use it when answering would mean opening many files to '
          + 'produce a small answer — "where is X defined", "which files call Y", "how does Z work". '
          + 'The helper can search, read and navigate; it CANNOT write, edit or run anything, and it cannot '
          + 'delegate further. You keep your own context clean, and you pay for its rounds.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['task'],
          properties: {
            task: {
              type: 'string',
              description: 'One specific question, with enough detail to answer without asking you anything back.',
            },
            maxRounds: {
              type: 'integer',
              description: `How many rounds it may spend, 1-${MAX_SUBAGENT_ROUNDS} (default ${DEFAULT_SUBAGENT_ROUNDS}).`,
            },
          },
        },
      },
    },
  ];
}
