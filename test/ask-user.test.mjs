/**
 * `ask_user` — and the three ways a tool like this makes an agent WORSE.
 * Every test here is one of those three, because the capability is trivial and
 * the policy around it is the whole product.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  askUserToolSchemas, budgetedAsker, MAX_QUESTIONS, MAX_QUESTION_CHARS, MAX_ANSWER_CHARS,
} from '../lib/ask-user.mjs';

/** An asker that answers everything with the same string, counting calls. */
function stubAsker(answer = 'the second one') {
  const asked = [];
  const fn = async (q) => { asked.push(q); return answer; };
  return { fn, asked };
}

test('a question reaches the user and the answer comes back', async () => {
  const { fn, asked } = stubAsker('use postgres');
  const ask = budgetedAsker(fn);
  const r = await ask('postgres or sqlite?');
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'use postgres');
  assert.equal(r.answered, true);
  assert.match(asked[0], /postgres or sqlite\?/);
});

test('⭐ no terminal means NO TOOL — absence beats a button that always refuses', () => {
  /**
   * `prompt.mjs`'s `createAsker` returns null when stdin/stdout are not both
   * TTYs, and that null has to survive to here. A tool offered but permanently
   * refusing costs tokens in the schema every single round and invites the
   * model to spend a round discovering it does not work.
   */
  assert.equal(budgetedAsker(null), null);
  assert.equal(budgetedAsker(undefined), null);
  assert.equal(budgetedAsker('not a function'), null);
});

test('⚠️⚠️ the allowance is HARD — an agent that interrogates is worse than one that guesses', async () => {
  const { fn } = stubAsker();
  const ask = budgetedAsker(fn, { max: 2 });
  assert.equal((await ask('one?')).ok, true);
  assert.equal((await ask('two?')).ok, true);

  const third = await ask('three?');
  assert.equal(third.ok, false);
  assert.match(third.error, /all 2 of your questions/);
  assert.match(third.error, /state the assumption/, 'a refusal must say what to do instead, or the run stalls');
});

test('⚠️ the allowance is spent on ASKING, not on being answered', async () => {
  /**
   * Counting only successful answers would let a model that keeps asking
   * unanswerable questions loop forever at the user's expense. Here every
   * question comes back unanswered, and the budget still runs out.
   */
  const ask = budgetedAsker(async () => null, { max: 2 });
  const a = await ask('one?');
  const b = await ask('two?');
  assert.equal(a.ok, true);
  assert.equal(a.answered, false, 'null means nobody was there');
  assert.equal(b.ok, true);

  const third = await ask('three?');
  assert.equal(third.ok, false, 'two unanswered questions must still exhaust a budget of two');
});

test('⭐ "nobody answered" is ok:true and tells the model to proceed', async () => {
  /**
   * It is not an error. The tool did its job, the run is not broken, and the
   * model must carry on rather than retry. Returning ok:false here would make
   * a normal non-interactive run look like a failure.
   */
  const ask = budgetedAsker(async () => null);
  const r = await ask('which one?');
  assert.equal(r.ok, true);
  assert.equal(r.answered, false);
  assert.match(r.answer, /no answer/i);
  assert.match(r.answer, /most reasonable choice/, 'the instruction has to be in the payload — the model reads that, not our comments');
});

test('an empty line means "you decide", and is distinguished from nobody being there', async () => {
  const ask = budgetedAsker(async () => '');
  const r = await ask('which one?');
  assert.equal(r.ok, true);
  assert.equal(r.answered, false);
  assert.match(r.answer, /pressed enter/, 'a deliberate shrug is not the same event as a closed pipe');
});

test('an empty or oversized question is refused WITHOUT spending the allowance', async () => {
  const { fn, asked } = stubAsker();
  const ask = budgetedAsker(fn, { max: 1 });

  const empty = await ask('   ');
  assert.equal(empty.ok, false);
  const huge = await ask('x'.repeat(MAX_QUESTION_CHARS + 1));
  assert.equal(huge.ok, false);
  assert.match(huge.error, /one sentence/i);
  assert.equal(asked.length, 0, 'neither malformed question should have reached the user');

  const real = await ask('a real question?');
  assert.equal(real.ok, true, 'a malformed question must not cost the allowance a real one needed');
});

test('⚠️ a pasted logfile does not become the context window', async () => {
  const ask = budgetedAsker(async () => 'y'.repeat(MAX_ANSWER_CHARS * 3));
  const r = await ask('paste it?');
  assert.equal(r.ok, true);
  assert.ok(r.answer.length < MAX_ANSWER_CHARS * 1.2, `answer was ${r.answer.length} chars — the clamp did not apply`);
  assert.match(r.answer, /characters omitted/, 'a truncated answer must never read as if it were whole');
});

test('the schema tells the model when NOT to call it, which is the only lever there is', () => {
  const [schema] = askUserToolSchemas();
  assert.equal(schema.function.name, 'ask_user');
  const d = schema.function.description;
  assert.match(d, /DO NOT/, 'a description that only says what the tool does invites it to be used for everything');
  assert.match(d, /read the files/i, 'the main failure is asking what it could have looked up');
  assert.match(d, new RegExp(`${MAX_QUESTIONS} questions`), 'the model must know the allowance before it spends it');
  assert.deepEqual(schema.function.parameters.required, ['question']);
});
