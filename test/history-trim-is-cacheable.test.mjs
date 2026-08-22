/**
 * ── 💰⭐⭐⭐ THE TRIM THAT THREW THE CACHE AWAY EVERY TURN ───────────────────
 *
 * `trimHistory` had NO tests at all, which is how this survived. It did:
 *
 *     const head = messages.slice(0, 2);
 *     let tail = messages.slice(-(max - 2));      // <- re-sliced EVERY turn
 *
 * Prefix caching matches from the first token and stops at the first
 * difference. Past the cap that third message changed every single turn, so
 * everything after the 2-message head was re-bought at full price for the rest
 * of the session.
 *
 * ⚠️ THE HEAD BEING STABLE IS NOT THE SAME AS THE PROMPT BEING CACHED. A check
 * that watched `messages[0]` — the obvious one, and the one console's own
 * version of this file uses because console keeps no head — would have reported
 * ZERO voids and called this code healthy.
 *
 * ⭐ NO CREDITS, NO NETWORK. A simulated session, counting how many messages of
 * each prompt are byte-identical to the previous prompt. That is the thing that
 * costs money, and it can be measured exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  trimHistory, MAX_HISTORY_MESSAGES, HISTORY_HIGH_WATER, HISTORY_LOW_WATER,
} from '../lib/chat.mjs';

/** The rule this replaced, kept verbatim so the comparison is honest. */
function oldSlidingTrim(messages, max = MAX_HISTORY_MESSAGES) {
  if (!Array.isArray(messages) || messages.length <= max) return messages;
  const head = messages.slice(0, 2);
  let tail = messages.slice(-(max - head.length));
  while (tail.length > 0 && tail[0].role === 'tool') tail = tail.slice(1);
  return [...head, ...tail];
}

const key = (m) => `${m.role}:${m.c ?? m.content}`;
function sharedPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && key(a[i]) === key(b[i])) i += 1;
  return i;
}

/**
 * Run a session of `turns` exchanges through `rule` and report what share of
 * each prompt survived from the turn before, counting only turns at or past the
 * old flat cap so both rules are judged on the same stretch of the session.
 */
function cacheShare(rule, turns = 60, capAt = MAX_HISTORY_MESSAGES) {
  let convo = [{ role: 'system', c: 's' }, { role: 'user', c: 'ctx' }];
  let prev = null;
  const rows = [];
  for (let t = 0; t < turns; t += 1) {
    convo.push({ role: 'assistant', c: `a${t}` }, { role: 'user', c: `u${t}` });
    const sent = rule(convo);
    if (prev) rows.push({ shared: sharedPrefix(prev, sent), len: sent.length });
    prev = sent;
    convo = sent.slice();
  }
  /**
   * ⚠️ THE FILTER IS RELATIVE TO THE RULE'S OWN CAP, and my first version
   * hardcoded 40. For `max=20` the prompt never reaches 40 messages, so every
   * row was filtered out and the average came back NaN — which `assert.ok(NaN >
   * 0.6)` reports as a step collapse. A fixture that measures nothing must not
   * be readable as a finding about the code.
   */
  const capped = rows.filter((r) => r.len >= capAt);
  if (capped.length === 0) throw new Error(`the simulation never reached ${capAt} messages — nothing was measured`);
  return {
    share: capped.reduce((n, r) => n + r.shared / r.len, 0) / capped.length,
    minKept: Math.min(...capped.map((r) => r.len)),
    maxKept: Math.max(...capped.map((r) => r.len)),
    turns: capped.length,
  };
}

test('⚠️⚠️ THE DEFECT: the old sliding trim kept almost nothing cacheable', () => {
  const old = cacheShare(oldSlidingTrim);
  assert.ok(old.turns > 10, 'the simulation never reached the cap — this measures nothing');
  assert.ok(old.share < 0.25,
    `the old rule is not behaving as recorded (${(old.share * 100).toFixed(1)}%) — if this now `
    + 'passes, the comparison below is measuring something else and the numbers in chat.mjs are stale');
});

test('💰⭐ the shipped trim keeps most of the prompt byte-identical', () => {
  const now = cacheShare(trimHistory);
  assert.ok(now.share > 0.85,
    `cacheable prefix fell to ${(now.share * 100).toFixed(1)}% — a continuous slide is back, `
    + 'or the step collapsed to 1');
});

test('💰⭐⭐ and it is a large multiple of what it replaced', () => {
  // Stated as a ratio rather than two absolutes: the point is the SIZE of the
  // win, and a ratio survives a change in the simulation's shape.
  const old = cacheShare(oldSlidingTrim).share;
  const now = cacheShare(trimHistory).share;
  assert.ok(now / old > 3, `only ${(now / old).toFixed(1)}x better — measured ~9.7x when shipped`);
});

test('⭐⭐ it NEVER keeps less history than the rule it replaced', () => {
  /**
   * The reason HIGH was raised rather than LOW lowered. Console shipped 16/8 —
   * halving its window — but the CLI's tool results carry whole files and it
   * cannot afford to forget more. This must be a pure win, not a trade of
   * memory for money.
   */
  const now = cacheShare(trimHistory);
  assert.ok(now.minKept >= MAX_HISTORY_MESSAGES,
    `history dropped to ${now.minKept}, below the old flat cap of ${MAX_HISTORY_MESSAGES} — `
    + 'this change is supposed to cost no memory at all');
});

/**
 * ── ⚠️⚠️ THE REACH BUG I ALMOST SHIPPED ────────────────────────────────────
 *
 * The first version derived `low` as `Math.min(HISTORY_LOW_WATER, max)`, and
 * `runChat`'s default `maxHistory` was MAX_HISTORY_MESSAGES (40) — equal to
 * HISTORY_LOW_WATER. So `step` was `max(1, 0)` = 1, one-message steps ARE a
 * continuous slide, and the fix would have measured 89.6% in a simulation while
 * doing NOTHING on the only path that calls it.
 *
 * Two tests, because there were two independent mistakes: the derivation, and
 * the default that fed it.
 */
test('⚠️⚠️ any max still STEPS — it never degrades to a one-message slide', () => {
  for (const max of [HISTORY_HIGH_WATER, MAX_HISTORY_MESSAGES, 20, 12]) {
    const r = cacheShare((m) => trimHistory(m, max), 60, Math.min(max, MAX_HISTORY_MESSAGES));
    assert.ok(r.share > 0.6,
      `max=${max} gives only ${(r.share * 100).toFixed(1)}% — the step collapsed for this value`);
  }
});

test('⚠️⚠️ and the LIVE default is the high water mark, not the low one', async () => {
  // A guard on the value alone would pass while `runChat` quietly passed 40.
  // This reads the caller.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'chat.mjs'), 'utf8');
  assert.match(src, /maxHistory = HISTORY_HIGH_WATER/,
    'runChat defaults maxHistory to something other than the high water mark — if it equals the '
    + 'low water mark the trim silently becomes a slide again');
  assert.ok(HISTORY_HIGH_WATER > HISTORY_LOW_WATER,
    'high must exceed low or there is no step at all');
});

test('⚠️ a tool message is never orphaned at the head of the tail', () => {
  /**
   * A `tool` message without its `assistant` tool_calls is a hard 400 from every
   * OpenAI-shaped provider. The old rule guarded this and the new one must too —
   * a caching win that 400s the session is not a win.
   */
  let convo = [{ role: 'system', c: 's' }, { role: 'user', c: 'ctx' }];
  let orphans = 0;
  for (let t = 0; t < 80; t += 1) {
    convo.push({ role: 'assistant', c: `a${t}` }, { role: 'tool', c: `t${t}` }, { role: 'user', c: `u${t}` });
    const sent = trimHistory(convo);
    if (sent[2]?.role === 'tool') orphans += 1;
    convo = sent.slice();
  }
  assert.equal(orphans, 0, 'the tail begins with a tool message — that is a hard 400 mid-session');
});

test('⚠️ a short session is returned untouched', () => {
  const short = [{ role: 'system', c: 's' }, { role: 'user', c: 'a' }, { role: 'assistant', c: 'b' }];
  assert.strictEqual(trimHistory(short), short, 'a session under the cap must not be copied or altered');
});

/**
 * ── ⚠️⚠️ MESSAGE COUNT IS THE WRONG UNIT, AND THE FIX ABOVE MADE IT WORSE ───
 *
 * Raising the cap 40 -> 64 was done ENTIRELY to protect the cache. Measured
 * against the one real recorded session on disk (18 messages, 93,036 prompt
 * tokens — `.acuvo/sessions/20260814-095636-99d4.json`):
 *
 *     avg message ~551 tokens, largest observed ~2,145 tokens
 *     at 40 msgs: typical ~22,000   worst case ~85,800   (just under the 96k budget)
 *     at 64 msgs: typical ~35,300   worst case ~137,300  (well over it)
 *
 * Past 96k `turn.mjs` compacts, and `compact.mjs` says compaction voids the
 * cache discount and "once it starts, it never stops". So without a token
 * ceiling this change would, in a file-heavy session, destroy the exact thing
 * it was written to protect. A tool result carrying a whole file is the normal
 * case in a coding session, not the exception.
 */
import { HISTORY_TOKEN_CEILING } from '../lib/chat.mjs';

/**
 * A message roughly the size of the LARGEST one in the real session.
 *
 * ⚠️ IT CARRIES `content`, AND MY FIRST VERSION DID NOT. The fixtures elsewhere
 * in this file use a short `c` key because the caching tests only ever compare
 * identity — but `estimateMessagesTokens` (and the provider) read `content`, so
 * a `c`-only message estimates as ZERO and the ceiling never fires. The test
 * reported 133,398 tokens and looked like a code defect; it was measuring a
 * fixture that does not match the contract.
 */
const heavy = (i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'x'.repeat(8_581) });

test('⚠️⚠️ a file-heavy session is bounded by TOKENS, not just by message count', () => {
  let convo = [{ role: 'system', c: 's' }, { role: 'user', c: 'ctx' }];
  let worst = 0;
  for (let t = 0; t < 60; t += 1) {
    convo.push(heavy(t * 2), heavy(t * 2 + 1));
    const sent = trimHistory(convo);
    // 4 chars/token, the same conservative ratio compact.mjs uses.
    const tokens = sent.reduce((n, m) => n + JSON.stringify(m).length / 4, 0);
    worst = Math.max(worst, tokens);
    convo = sent.slice();
  }
  assert.ok(worst < 96_000,
    `a heavy session reached ~${Math.round(worst).toLocaleString()} tokens, over turn.mjs's 96k `
    + 'budget — compaction fires there and permanently voids the cache this change exists to protect');
  assert.ok(worst <= HISTORY_TOKEN_CEILING * 1.35,
    `~${Math.round(worst).toLocaleString()} tokens is far above the ${HISTORY_TOKEN_CEILING.toLocaleString()} ceiling — it is not being applied`);
});

test('⭐ and the ceiling does NOT bite an ordinary session', () => {
  /**
   * The correct-work half. At the measured ~551 tokens/message an ordinary
   * session reaches the 64-message cap at ~35k and must keep every one of those
   * messages — a ceiling that trims normal sessions would be a memory
   * regression dressed up as a cost saving.
   */
  let convo = [{ role: 'system', c: 's' }, { role: 'user', c: 'ctx' }];
  let minKept = Infinity;
  for (let t = 0; t < 60; t += 1) {
    convo.push({ role: 'assistant', content: 'x'.repeat(2_200) }, { role: 'user', content: 'x'.repeat(2_200) });
    const sent = trimHistory(convo);
    if (sent.length >= MAX_HISTORY_MESSAGES) minKept = Math.min(minKept, sent.length);
    convo = sent.slice();
  }
  assert.ok(minKept >= MAX_HISTORY_MESSAGES,
    `an ordinary session was trimmed to ${minKept} messages — the token ceiling is firing when it should not`);
});

test('⚠️ the ceiling still drops in STEP blocks — it must not become a slide', () => {
  // A token-driven trim that dropped one message at a time would reintroduce
  // exactly the defect this file exists for, only harder to see.
  let convo = [{ role: 'system', c: 's' }, { role: 'user', c: 'ctx' }];
  let prev = null;
  const shares = [];
  for (let t = 0; t < 60; t += 1) {
    convo.push(heavy(t * 2), heavy(t * 2 + 1));
    const sent = trimHistory(convo);
    if (prev) shares.push(sharedPrefix(prev, sent) / sent.length);
    prev = sent;
    convo = sent.slice();
  }
  const avg = shares.reduce((a, b) => a + b, 0) / shares.length;
  assert.ok(avg > 0.6,
    `heavy sessions cache only ${(avg * 100).toFixed(1)}% — the token ceiling is trimming continuously `
    + 'instead of in step blocks');
});
