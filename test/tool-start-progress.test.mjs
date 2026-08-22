/**
 * ── ⚠️⚠️ UP TO TWO MINUTES OF BLANK TERMINAL ────────────────────────────────
 *
 * Measured 2026-08-19: **every** tool event in `turn.mjs` fired AFTER the await.
 * So a `run_command` on its 120s default timeout, a `web_search`, or a slow MCP
 * call showed the user nothing at all for the whole duration and then printed a
 * finished line.
 *
 * `stream.mjs`'s own header is titled "THE TWENTY SECONDS OF NOTHING". This is
 * that defect in the one place a person is most likely to decide the tool has
 * hung and press Ctrl-C.
 *
 * ⚠️ AND SILENCE IS NOT THE ONLY FAILURE MODE. A start line for every verb
 * would double the transcript to announce reads that finish in a millisecond,
 * and noise on the fast path is how a reader stops reading the slow path too.
 * So these tests pin BOTH halves: it speaks when work is slow, and stays quiet
 * when it is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderEvent } from '../lib/turn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const start = (name, args = {}) => renderEvent({ type: 'tool-start', round: 1, name, args });

test('⭐ it announces the verbs that can take seconds', () => {
  for (const [name, args] of [
    ['run_command', { command: 'npm test' }],
    ['web_search', { query: 'duration parsing' }],
    ['see_page', { path: 'index.html' }],
    ['generate_image', { prompt: 'a hero shot' }],
    ['delegate', { task: 'audit the callers' }],
  ]) {
    const out = start(name, args);
    assert.equal(out.length, 1, `${name} printed nothing before it ran`);
    assert.match(out[0], new RegExp(name), `${name} is not named in its own start line`);
  }
});

test('⚠️ and stays SILENT for verbs that finish instantly', () => {
  // Announcing a read would double the output of every round to say nothing.
  for (const name of ['read_file', 'list_dir', 'search_text', 'plan_step', 'write_file']) {
    assert.deepEqual(start(name, { path: 'a.mjs' }), [], `${name} should not announce itself`);
  }
});

test('⭐ the line names the SUBJECT, not just the verb', () => {
  /**
   * "… run_command" tells you nothing you did not know. "… run_command npm test"
   * is the difference between a progress line and a spinner.
   */
  assert.match(start('run_command', { command: 'npm test' })[0], /npm test/);
  assert.match(start('fetch_url', { url: 'https://example.com/a' })[0], /example\.com/);
  assert.match(start('web_search', { query: 'how to parse durations' })[0], /parse durations/);
});

test('⚠️ a very long subject is truncated rather than wrapping the terminal', () => {
  const out = start('run_command', { command: 'x'.repeat(500) })[0];
  assert.ok(out.length < 120, `a start line ran to ${out.length} chars`);
});

test('⭐ it survives a call with no arguments at all', () => {
  // A tool-start must never throw — it would take down the round it is
  // announcing, which is the worst possible trade for a progress line.
  assert.doesNotThrow(() => start('run_command', undefined));
  assert.doesNotThrow(() => renderEvent({ type: 'tool-start', name: 'run_command' }));
});

test('⚠️⚠️ the RESULT line still prints — these are not a pair to reconcile', () => {
  /**
   * "Started" and "here is what happened" are two facts. Overwriting the first
   * with the second would need cursor control, which breaks the moment output
   * is piped to a file — and piping is how this is used in CI.
   */
  const result = renderEvent({
    type: 'tool',
    // A shape `renderToolRecord` genuinely handles — see its `write_file` case.
    record: { name: 'write_file', args: { path: 'a.mjs' }, result: { ok: true, created: true, path: 'a.mjs', bytes: 12 } },
  });
  assert.ok(result.length > 0, 'the result line disappeared when the start line was added');
});

test('⚠️⚠️ REACH — the loop emits it BEFORE the await, not after', () => {
  /**
   * The whole defect was that every existing emission sat after the await. A
   * `tool-start` that also fired after the tool returned would be a decorative
   * duplicate of the result line.
   *
   * Comments stripped: a guard that greps source otherwise matches the comment
   * explaining the feature.
   */
  const code = readFileSync(join(HERE, '..', 'lib', 'turn.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const emitted = code.indexOf("type: 'tool-start'");
  assert.ok(emitted > 0, 'nothing emits tool-start — this guard is blind');

  const executed = code.indexOf('await executeToolCall', emitted);
  assert.ok(executed > emitted, 'tool-start is not emitted before the tool executes');

  // …and it is inside the per-call loop, so it fires once per call.
  const loop = code.lastIndexOf('for (const call of calls)', emitted);
  assert.ok(loop > 0 && loop < emitted, 'tool-start is outside the per-call loop');
});

test('⚠️⚠️ arguments arriving as a JSON STRING still yield a subject', () => {
  /**
   * ⭐ FOUND BY RUNNING IT, NOT BY THESE TESTS. A tool call carries
   * `function.arguments` as a JSON **string**; the first version of the
   * renderer read it as an object, so every live start line printed a bare
   * `… run_command` — a spinner pretending to be a progress line.
   *
   * The unit tests all passed objects in directly and were perfectly green.
   * That is the same construct-your-own-collaborators blindness that hid the
   * write-approval bug behind 3,600 passing tests, and it is why this case
   * exists.
   */
  const out = renderEvent({
    type: 'tool-start',
    round: 1,
    name: 'run_command',
    args: JSON.stringify({ command: 'node --test clamp.test.mjs' }),
  });
  assert.equal(out.length, 1);
  assert.match(out[0], /node --test clamp\.test\.mjs/, 'the subject was lost when args arrived as a string');
});

test('⚠️ and unparseable arguments degrade to the bare verb rather than throwing', () => {
  const out = renderEvent({ type: 'tool-start', round: 1, name: 'run_command', args: '{not json' });
  assert.equal(out.length, 1);
  assert.match(out[0], /run_command/);
});
