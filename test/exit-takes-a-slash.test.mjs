/**
 * ── ⚠️⭐ `/exit` WAS REFUSED, AND IT IS THE OBVIOUS GUESS ────────────────────
 *
 * MEASURED by driving the real prompt on 2026-09-07:
 *
 *     › /exit
 *       /exit is not a command.
 *       /help lists everything this prompt understands.
 *
 * Technically correct, practically wrong. Every OTHER thing the prompt
 * understands takes a slash — `/help`, `/cost`, `/model`, `/skills`, `/mcp`,
 * `/clear` — and the tool most users arrive from ends its sessions with
 * `/exit`. So the slash is what a hand types, and it was the one word that
 * punished it.
 *
 * ⚠️ THE BARE WORDS STAY. They are what the banner and `/help` advertise; this
 * is additive, and a "tidy-up" that removed one would break the muscle memory
 * the original comment exists to respect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const chat = readFileSync(join(here, '..', 'lib', 'chat.mjs'), 'utf8');
const slash = readFileSync(join(here, '..', 'lib', 'slash.mjs'), 'utf8');

/** The literal set as the module declares it — parsed, not re-implemented. */
function quitWords() {
  const m = /const QUIT = new Set\(\[([\s\S]*?)\]\)/.exec(chat);
  assert.ok(m, 'the QUIT set is gone or reshaped — this guard cannot see it any more');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

test('the slashed forms end a session', () => {
  const q = quitWords();
  for (const w of ['/exit', '/quit', '/q', '/bye']) {
    assert.ok(q.has(w), `${w} does not end a session, and it is what a hand types`);
  }
});

test('the bare words still end a session — this was additive', () => {
  const q = quitWords();
  for (const w of ['exit', 'quit', ':q', 'bye']) {
    assert.ok(q.has(w), `${w} stopped working; the banner still advertises it`);
  }
});

/**
 * ⚠️ AN ALIAS NOBODY IS TOLD ABOUT IS HALF A FIX. `/help` is the only place a
 * user finds out, so the line has to name it.
 */
test('/help names the slashed form', () => {
  assert.match(slash, /end the session \(also \/exit/, '/help does not mention /exit');
});

/**
 * ⚠️ THE ORDERING THAT MAKES IT WORK. The QUIT check must run BEFORE the slash
 * dispatcher, or `/exit` is claimed as an unknown command and answered with
 * "not a command" — which is exactly the defect this file closes.
 */
test('the quit check runs before the slash dispatcher', () => {
  /**
   * ⚠️ THE LANDMARK IS THE DISPATCH CALL, NOT A COMMENT. My first version of
   * this test anchored on the heading "THE `/` SURFACE", which appears TWICE in
   * this file — so `indexOf` found the wrong one and the test failed against
   * code I had just watched work at the real prompt. A guard anchored on prose
   * is a guard anchored on nothing.
   */
  const quitAt = chat.indexOf('QUIT.has(');
  const slashAt = chat.indexOf('runSlashCommand(');
  assert.ok(quitAt > 0 && slashAt > 0, 'one of the two landmarks moved');
  assert.ok(quitAt < slashAt, 'the slash dispatcher now runs first, so /exit is refused again');
});
