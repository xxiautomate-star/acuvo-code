/**
 * ── ⭐⭐ THE AGENT COULD NOT ASK A QUESTION, AND THAT IS THE GAP ─────────────
 *
 * Of the 47 tools this package offers, not one lets the model say "I need a
 * decision from you". It reads, writes, runs, searches, renders and remembers —
 * and when the task is ambiguous it GUESSES, because guessing is the only thing
 * it can do.
 *
 * ⭐ Asked what Claude Code and Codex CLI do that matters most and is easiest to
 * underestimate, an independent model answered: *"the UX polish on ambiguity
 * handling — asking one clarifying question instead of guessing wrong is the
 * difference between a tool you trust and a toy you supervise."* That matches
 * what this package's own failure log says: the expensive failures are not bad
 * code, they are correct code built to the wrong requirement.
 *
 * ── ⚠️ AND YET AN AGENT THAT ASKS IS EASILY WORSE THAN ONE THAT GUESSES ─────
 *
 * A tool like this fails in three directions, and all three are designed
 * against here rather than hoped away:
 *
 *  1. **It hangs.** In CI, a pipe or a task runner there is nobody to answer.
 *     An agent blocked on input that will never arrive fails by TIMEOUT — the
 *     least legible failure available, burning a whole job to say nothing.
 *     ⭐ Handled by NOT OFFERING the tool at all when there is no terminal
 *     (`prompt.mjs`'s `createAsker` returns null), and by the asker resolving
 *     `null` rather than pending when a stream ends. A tool that is absent
 *     cannot be called; that is stronger than a tool that refuses.
 *
 *  2. **It interrogates.** An agent that asks five questions has moved the work
 *     back onto the person and is worse than useless — they could have done it
 *     themselves. ⭐ Handled by a hard per-run allowance (`MAX_QUESTIONS`), and
 *     by the allowance being SPENT even on a refusal, so a model cannot burn
 *     rounds retrying a question it was already told to stop asking.
 *
 *  3. **It asks what it could have looked up.** "What framework is this?" is
 *     not a question for a human in a repository the agent can read. ⭐ Handled
 *     in the description, which is the only place a model's behaviour is
 *     actually steered, and which spends its words on WHEN NOT TO CALL THIS.
 *
 * ── ⚠️ THE ANSWER IS UNTRUSTED TEXT, LIKE EVERY OTHER TOOL RESULT ───────────
 *
 * Whatever the user types goes straight into the prompt. It is clamped like any
 * other result: a pasted logfile must not become the context window.
 */

import { clampOutput } from './command.mjs';

/**
 * ⚠️ THREE, AND THE NUMBER IS AN OPINION WORTH DEFENDING.
 *
 * One is too few — a genuinely ambiguous task often has a second question that
 * only becomes visible after the first is answered. Five is an interview. Three
 * is enough for "which of these two designs", "is this data real", "may I
 * delete this" in one run, and few enough that a model which has started
 * interrogating is stopped before the person gives up on it.
 */
export const MAX_QUESTIONS = 3;

/** A question longer than this is a paragraph, and a paragraph is not a question. */
export const MAX_QUESTION_CHARS = 400;

/** Enough for a considered sentence or a pasted path; not enough for a logfile. */
export const MAX_ANSWER_CHARS = 2_000;

export function askUserToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'ask_user',
        /**
         * ⚠️ MOST OF THIS DESCRIPTION IS ABOUT WHEN **NOT** TO CALL IT.
         *
         * The description is the only lever on a model's behaviour that exists
         * at call time — there is no runtime check that can tell a good
         * question from a lazy one. So the words are spent on the failure mode
         * (asking instead of looking) rather than on restating the obvious
         * capability.
         */
        description: [
          'Ask the person running you ONE short question, and wait for their answer.',
          'Use this ONLY when the task is genuinely ambiguous and the wrong choice would waste real work —',
          'two reasonable interpretations that lead somewhere different, a destructive step you want confirmed,',
          'or a missing fact that exists only in their head.',
          'DO NOT use it for anything you can find out yourself: read the files, look at the tests,',
          'check the config, run the command. Asking what you could have looked up is worse than not asking.',
          'DO NOT use it to check in, to report progress, or to ask permission to continue — just continue.',
          `You may ask at most ${MAX_QUESTIONS} questions in a whole run, so spend them on decisions, not details.`,
          'If nobody answers, you will be told so, and you must then make the most reasonable choice',
          'and say plainly in your final message which assumption you took.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question, in one sentence. Include the options if there are options.',
            },
          },
          required: ['question'],
        },
      },
    },
  ];
}

/**
 * Wrap a raw asker in the per-run allowance.
 *
 * ⚠️ THE STATE LIVES HERE, NOT IN THE DISPATCHER. `executeToolCall` is a pure
 * switch over one call and has no memory of the round before it — giving it a
 * counter would mean threading mutable state through every tool in the file for
 * the sake of one. The turn loop already owns per-run state, so it owns this
 * too, and the dispatcher keeps receiving a plain function.
 *
 * @param {null | ((q: string) => Promise<string|null>)} ask
 * @param {{ max?: number }} [opts]
 * @returns {null | ((q: string) => Promise<{ok: true, answer: string} | {ok: false, error: string}>)}
 */
export function budgetedAsker(ask, { max = MAX_QUESTIONS } = {}) {
  if (typeof ask !== 'function') return null;
  let used = 0;
  return async (question) => {
    const q = String(question ?? '').trim();
    if (!q) return { ok: false, error: 'ask_user needs a question — an empty one cannot be answered' };
    if (q.length > MAX_QUESTION_CHARS) {
      return { ok: false, error: `that question is ${q.length} characters; keep it under ${MAX_QUESTION_CHARS}. One sentence.` };
    }

    /**
     * ⚠️ THE ALLOWANCE IS SPENT BEFORE THE ANSWER ARRIVES, DELIBERATELY.
     * Counting only successful answers would let a model that keeps asking
     * unanswerable questions loop forever at the user's expense. The budget is
     * on ASKING, which is the thing being rationed.
     */
    if (used >= max) {
      return {
        ok: false,
        error: `you have used all ${max} of your questions for this run. Make the most reasonable choice now, `
          + 'act on it, and state the assumption you took in your final message.',
      };
    }
    used += 1;

    const answer = await ask(`\n  ${q}\n  > `);
    if (answer === null) {
      /**
       * ⭐ "NOBODY ANSWERED" IS AN ANSWER. It is `ok: true` on purpose: the tool
       * did its job, the run is not broken, and the model needs to proceed
       * rather than treat this as an error worth retrying. The instruction to
       * carry on is in the payload because a model reads the result, not this
       * comment.
       */
      return {
        ok: true,
        answer: '(no answer — the terminal closed or nobody was there). '
          + 'Make the most reasonable choice, continue, and state the assumption you took in your final message.',
        answered: false,
      };
    }
    if (answer === '') {
      return {
        ok: true,
        answer: '(the user pressed enter without answering, which usually means "you decide"). '
          + 'Take the most reasonable option and say which one you took.',
        answered: false,
      };
    }
    // `clampOutput` returns {text, truncated, omitted} and marks the omission
    // inside the text itself, so a truncated answer never silently reads whole.
    return { ok: true, answer: clampOutput(answer, MAX_ANSWER_CHARS).text, answered: true };
  };
}
