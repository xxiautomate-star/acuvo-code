/**
 * ── ⭐⭐ THE FIRST STRING A STRANGER EVER READS, AND NOTHING GUARDED IT ──────
 *
 * `MISSING_KEY_MESSAGE` is the entire first impression: someone installed this
 * thirty seconds ago, typed a prompt, and this is the whole product to them. It
 * decides whether they go and get a key or close the terminal — and it had no
 * test at all, so every property below could be lost by an ordinary edit with a
 * green suite.
 *
 * ⚠️ WHAT WENT WRONG BEFORE: the message opened "Acuvo Code needs an OpenRouter
 * key to reach a model" — a demand for a COMPETITOR'S credential, before one
 * word about what this is. A dogfood review named it: the storefront sells
 * someone else's product.
 *
 * ⚠️ THIS FILE DELIBERATELY DOES NOT ASSERT THE PROSE. Pinning wording would
 * make every improvement a test failure, which teaches people to edit the test
 * instead of thinking. It asserts the PROPERTIES the message must keep.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { MISSING_KEY_MESSAGE } from '../lib/model.mjs';

const firstLine = MISSING_KEY_MESSAGE.split('\n')[0];

test('⭐ line one says what this IS, not what it wants from you', () => {
  assert.doesNotMatch(
    firstLine,
    /needs|requires|missing|error|must set/i,
    `the first thing a stranger reads must not be a demand — got: "${firstLine}"`,
  );
  assert.match(firstLine, /acuvo/i, 'it should name itself');
});

test('⚠️⚠️ a competitor is not the headline', () => {
  // OpenRouter is genuinely required today and the message says so — but not
  // before we have said what we are.
  const openrouterAt = MISSING_KEY_MESSAGE.toLowerCase().indexOf('openrouter');
  assert.ok(openrouterAt > 0, 'the key requirement must still be stated — it is true');
  const acuvoAt = MISSING_KEY_MESSAGE.toLowerCase().indexOf('acuvo');
  assert.ok(acuvoAt < openrouterAt, 'we must introduce ourselves before naming their product');
});

test('⭐ the money question is answered in dollars, unprompted', () => {
  // "Is this going to charge me" is the real unspoken question, and our honest
  // answer is a selling point. A message that omits it wastes the best fact.
  assert.match(MISSING_KEY_MESSAGE, /\$0\.0/, 'a concrete per-task cost must appear');
  assert.match(MISSING_KEY_MESSAGE, /ceiling|\$0\.02/i, 'the default ceiling turns an unknown into a bounded risk');
});

test('⭐ it still tells them exactly how to fix it, on both shells', () => {
  // The failure this replaced explained how to set a variable without saying
  // where to get one. Both halves must survive.
  assert.match(MISSING_KEY_MESSAGE, /https:\/\/openrouter\.ai\/keys/, 'WHERE to get a key');
  assert.match(MISSING_KEY_MESSAGE, /export OPENROUTER_API_KEY=/, 'bash/zsh');
  assert.match(MISSING_KEY_MESSAGE, /\$env:OPENROUTER_API_KEY/, 'PowerShell — this project is developed on Windows');
});

test('🚨 OUR door has an address too — the test above used to require one only for theirs', () => {
  /**
   * ── ⚠️⚠️ THE GUARD WAS ENFORCING THE ASYMMETRY IT SHOULD HAVE CAUGHT ──────
   *
   * The assertion directly above demands `https://openrouter.ai/keys` and gives
   * the reason *"WHERE to get a key"*. There was no matching assertion for the
   * Acuvo path, and the message it guarded duly shipped with a full URL for
   * OpenRouter and an unlocated *"Settings → API keys"* for us.
   *
   * ⭐ That is not a missing test, it is a test that made the defect permanent:
   * anyone reading it would conclude the URL requirement had been considered
   * and satisfied. `doctor.mjs` records the same shape costing a real customer
   * — *"sent a customer who had already paid us off to buy a competitor's
   * key"* — and this file is where that happens first.
   */
  const ourUrl = /https:\/\/acuvo\.xxiautomate\.com/;
  assert.match(MISSING_KEY_MESSAGE, ourUrl, 'WHERE to get an ACUVO key — the paid path is the business');

  const acuvoAt = MISSING_KEY_MESSAGE.search(ourUrl);
  const theirsAt = MISSING_KEY_MESSAGE.indexOf('https://openrouter.ai/keys');
  assert.ok(
    acuvoAt < theirsAt,
    'our address must appear before theirs — option A is the one we are selling',
  );

  /**
   * ⚠️ AND IT MUST NOT DESCRIBE THE FLOW WE REPLACED. `--login` on a terminal
   * opens the browser; it asks for no paste. `device-login.mjs`'s header names
   * "find Settings → create key → copy" as the path it exists to remove, and
   * this message was still printing it.
   */
  assert.doesNotMatch(
    MISSING_KEY_MESSAGE,
    /paste the key from Settings/i,
    'that describes the five-step path device login replaced — `acuvo --login` asks for no paste',
  );
});

test('⚠️ it promises no product that does not exist yet', () => {
  /**
   * ── ⭐ NARROWED 2026-08-23, EXACTLY AS THIS TEST SAID IT WOULD BE ──────────
   *
   * The original read: *"Acuvo Code is intended to be unlocked by an Acuvo PLAN,
   * and that gateway is not built… When the gateway ships, this test changes
   * with it, deliberately and visibly."*
   *
   * It shipped. `acuvo --login` lands a real key, the metered path records real
   * usage rows, and the message now has to say "billed to YOU, not your Acuvo
   * plan" — a warning that is only possible if the word `plan` is allowed.
   *
   * ⚠️ THE GUARD IS NARROWED, NOT REMOVED, and the distinction matters: `plan`
   * now names a thing that exists, while `coming soon` and `free trial` still
   * name things that do not. A first impression that advertises either is a
   * broken promise on day one, which is the most expensive kind.
   */
  assert.doesNotMatch(
    MISSING_KEY_MESSAGE,
    /\b(coming soon|free trial|waitlist|early access|beta access)\b/i,
    'do not advertise something that does not ship today',
  );
});

test('⭐ it names --doctor, the one thing that helps someone who is stuck', () => {
  // No key needed, runs offline, and every line it prints names the variable
  // that fixes it. It is the best asset we have for a confused first-timer.
  assert.match(MISSING_KEY_MESSAGE, /--doctor/);
});

test('⚠️ it stays short enough to be read', () => {
  const lines = MISSING_KEY_MESSAGE.split('\n');
  assert.ok(lines.length <= 20, `${lines.length} lines — a wall of text is not read, it is skipped`);
  for (const l of lines) {
    assert.ok(l.length <= 100, `a line wrapped in a narrow terminal is worse than a shorter one: "${l}"`);
  }
});
