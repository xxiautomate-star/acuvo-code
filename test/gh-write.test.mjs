import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planGh, ghNouns, ghWriteEnabled, ghToolSchemas, GH_NOUNS, GH_WRITE_ENV, MAX_GH_BODY_CHARS,
} from '../lib/gh.mjs';

/**
 * ── ⭐⭐⭐ THE AGENT COULD READ A REVIEW AND NOT DELIVER THE FIX ──────────────
 *
 * Measured gap: `gh` was read-only in every noun, so a run that read a PR
 * review, fixed the code and committed it ENDED AT A LOCAL BRANCH. Nobody else
 * could see the work. That is the single biggest "cannot finish the job" in this
 * CLI — bigger than any missing tool, because it is the last inch of every task.
 *
 * ⚠️ AND THE OLD REFUSAL WAS RIGHT ABOUT THE RISK. Its wording is worth keeping
 * in mind while reading this file: *"a comment, a close, a merge or a re-run is
 * visible to everyone watching the repository and cannot be undone by trying
 * again."* True. So this does not open the noun — it opens THREE actions,
 * behind an operator switch that is absent by default, and leaves close, merge,
 * approve, delete and re-run refused exactly as they were.
 */

const OFF = {};
const ON = { [GH_WRITE_ENV]: '1' };

test('writes are absent by default, and the refusal still hands the work back', () => {
  assert.equal(ghWriteEnabled(OFF), false);
  assert.deepEqual(ghNouns(OFF), GH_NOUNS);

  const r = planGh('pr', { action: 'create', title: 't', body: 'b' }, OFF);
  assert.equal(r.ok, false);
  // ⭐ It must still name the command a human can run. A refusal that only says
  // "no" costs the model three rounds of synonyms and the human a guess.
  assert.match(r.error, /gh pr create/);
});

test('⚠️ the destructive actions stay refused even with writes ON', () => {
  for (const [noun, action] of [['pr', 'merge'], ['pr', 'approve'], ['issue', 'close'], ['issue', 'delete'], ['run', 'rerun']]) {
    const r = planGh(noun, { action }, ON);
    assert.equal(r.ok, false, `${noun}.${action} must not be reachable`);
  }
});

test('pr.create builds a non-interactive command with title and body as single argv elements', () => {
  const r = planGh('pr', { action: 'create', title: 'Fix the thing', body: 'Because it was broken.' }, ON);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.args.slice(0, 2), ['pr', 'create']);
  assert.ok(r.args.includes('--title=Fix the thing'));
  assert.ok(r.args.includes('--body=Because it was broken.'));
});

/**
 * ⚠️⚠️ `gh pr create` WITH NO TITLE OR BODY OPENS AN EDITOR AND HANGS. The CLI
 * runs with no TTY, so an interactive prompt is not a question — it is a process
 * that never returns and a timeout the model reads as a broken tool. Both are
 * required for that reason, not for tidiness.
 */
test('⚠️ pr.create refuses without a title or without a body, rather than hanging on a prompt', () => {
  assert.equal(planGh('pr', { action: 'create', body: 'b' }, ON).ok, false);
  assert.equal(planGh('pr', { action: 'create', title: 't' }, ON).ok, false);
  assert.equal(planGh('pr', { action: 'create', title: '   ', body: 'b' }, ON).ok, false);
});

/**
 * ⚠️⚠️ A TITLE THAT LOOKS LIKE A FLAG MUST STAY A TITLE. `--title=--force` is one
 * argv element and `gh` reads everything after the `=` as the value, which is
 * exactly why this file builds `--name=value` rather than pushing `--name` and
 * `value` separately. This test exists so nobody "tidies" that into two pushes.
 */
test('⚠️⚠️ a title or body shaped like a flag cannot become one', () => {
  const r = planGh('pr', { action: 'create', title: '--repo=someone/else', body: '--force' }, ON);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.args.includes('--title=--repo=someone/else'));
  assert.ok(r.args.includes('--body=--force'));
  // and nothing became a bare flag of its own
  assert.equal(r.args.filter((a) => a === '--force').length, 0);
  assert.equal(r.args.filter((a) => a === '--repo=someone/else').length, 0);
});

test('issue.comment and pr.comment need a number and a body', () => {
  const ok = planGh('issue', { action: 'comment', number: 42, body: 'done in abc123' }, ON);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.args.slice(0, 3), ['issue', 'comment', '42']);
  assert.ok(ok.args.includes('--body=done in abc123'));

  const pr = planGh('pr', { action: 'comment', number: 7, body: 'rebased' }, ON);
  assert.equal(pr.ok, true, pr.error);
  assert.deepEqual(pr.args.slice(0, 3), ['pr', 'comment', '7']);

  assert.equal(planGh('issue', { action: 'comment', body: 'x' }, ON).ok, false);
  assert.equal(planGh('issue', { action: 'comment', number: 42 }, ON).ok, false);
});

/**
 * ⚠️ A BODY IS CAPPED. A model that pastes an entire diff into a comment posts
 * something nobody can read, on a thread everyone watching the repo is emailed
 * about — and unlike a tool result, it cannot be truncated after the fact.
 */
test('⚠️ an oversized body is refused, not silently truncated', () => {
  const r = planGh('issue', { action: 'comment', number: 1, body: 'x'.repeat(MAX_GH_BODY_CHARS + 1) }, ON);
  assert.equal(r.ok, false);
  assert.match(r.error, /body/i);
});

/**
 * ⚠️ THE THREE-PART REACHABILITY CONTRACT. A capability the model is not TOLD
 * about is not a capability. This package's signature defect is exactly that,
 * and three tools were found declared-executable-advertised-and-never-offered as
 * recently as this week.
 */
test('the model is told about the write actions only when they exist', () => {
  const off = ghToolSchemas(OFF).find((t) => t.function.name === 'gh_pr');
  assert.ok(!off.function.parameters.properties.action.enum.includes('create'));
  assert.match(off.function.description, /read/i);

  const on = ghToolSchemas(ON).find((t) => t.function.name === 'gh_pr');
  assert.ok(on.function.parameters.properties.action.enum.includes('create'));
  assert.ok(on.function.parameters.properties.action.enum.includes('comment'));
  assert.ok(on.function.parameters.properties.title, 'title must be documented when create exists');
  assert.ok(on.function.parameters.properties.body, 'body must be documented when create exists');

  const issueOn = ghToolSchemas(ON).find((t) => t.function.name === 'gh_issue');
  assert.ok(issueOn.function.parameters.properties.action.enum.includes('comment'));

  // ⚠️ `run` gains nothing. Re-running someone's CI is a write we still refuse.
  const runOn = ghToolSchemas(ON).find((t) => t.function.name === 'gh_run');
  assert.deepEqual(runOn.function.parameters.properties.action.enum, GH_NOUNS.run);
});
