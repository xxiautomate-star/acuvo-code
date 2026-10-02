/**
 * ── ⭐⭐⭐ WHAT A CONVERSATIONAL TURN COSTS, AND THE PROOF IT IS FREE TO CUT ──
 *
 * Roman, 2026-08-29: *"it wastes a fuck ton of tokens in builder and chat…
 * so it knows to use little tokens for chatting."*
 *
 * ⚠️ ZERO NETWORK. Every number here is produced by building the prompt pieces
 * and counting bytes. Nothing calls a model.
 *
 * ── THE THREE THINGS THIS DEFENDS, AND WHY EACH ONE WAS NOT ALREADY DEFENDED ─
 *
 *   1. **THE TOOL BLOCK ON A GREETING IS EXACTLY `CORE_TOOLS`.**
 *
 *      ⚠️ AND I ALMOST SHIPPED A DUPLICATE OF AN EXISTING GUARD HERE. I wrote
 *      that the unclassified-verb leak had *"been caught three times, always by
 *      an ad-hoc measurement, never by a test"*. That is FALSE:
 *      `test/tool-shortlist.test.mjs` already asserts it, from both directions,
 *      with a better failure message (*"every verb is CORE or in a group"* and
 *      *"no group names a verb that does not exist"*). The classification side
 *      is deleted from here rather than restated —
 *      `feedback_the_codebase_knew_before_the_register_did`, hit twice in one
 *      session.
 *
 *      ⭐ WHAT SURVIVES IS THE HALF THAT SUITE DOES NOT COVER: what `"hi"`
 *      actually comes out with, asserted THROUGH `shortlistTools` rather than
 *      over its inputs. A change to the "keep what you do not understand"
 *      fallback would leave every name classified and still widen the greeting.
 *
 *   2. **THE MAP IS THE BIGGEST BLOCK IN A GREETING AND IT IS NOW SUPPRESSED.**
 *
 *   3. ⭐⭐ **SUPPRESSING IT COSTS NO CACHE.** This is the assertion that
 *      matters, because it is the one a reasonable person would doubt:
 *      `tool-shortlist.mjs` warns that *"a warm full block costs less than a
 *      half-cold shortlisted one"*, and a naive "send less on chat" change is
 *      exactly the shape that voids a prefix. The check below measures the
 *      cross-task shared prefix of the FULL WIRE with and without the map and
 *      asserts it is IDENTICAL — not "close", identical.
 *
 * ── ⚠️ WHY THE ASSERTIONS BIND TO SEAMS, NOT TO PERCENTAGES ────────────────
 *
 * A test that pinned "42.8%" goes red on every legitimate fixture change and
 * green on the regression that matters. So: the leak check is an exact set
 * comparison, the cache check is an exact byte equality, and only the size check
 * has a floor — and the floor is loose enough to survive a schema edit and tight
 * enough that re-sending the map would trip it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { toolNamesForRounds, toolSchemasFor, TOOL_NAMES } from '../lib/tools.mjs';
import { orderForCachePrefix } from '../lib/tool-prefix.mjs';
import { shortlistTools, CORE_TOOLS, TOOL_GROUPS } from '../lib/tool-shortlist.mjs';
import { appendOnlyWireBytes, sharedPrefixBytes } from '../lib/cache-floor.mjs';
import { systemPrompt, userPrompt, assembleSystemMessage } from '../lib/turn.mjs';
import { buildRepoMap } from '../lib/repo-map.mjs';
import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import {
  isConversationalTurn, contextTextForTurn, NO_MAP_NOTE, CONVERSATIONAL,
  toolShortlistEnabled,
} from '../lib/chat-turn.mjs';

const ROUNDS = 5;
const OFFER = toolNamesForRounds(ROUNDS, { allowRun: true, root: process.cwd() });
const GROUPED = new Set(Object.values(TOOL_GROUPS).flatMap((g) => g.tools));
/** The same key `turn.mjs` builds — invariant tools first, task-selected behind. */
const ORDER_KEY = OFFER.filter((n) => !GROUPED.has(n));

const bytes = (s) => Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s), 'utf8');

/**
 * A tree big enough that the map is a real block rather than four lines. The
 * numbers below are about PROPORTION, so the fixture has to be repo-shaped.
 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-chatcost-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', main: 'src/index.js' }));
  for (let i = 0; i < 240; i += 1) {
    writeFileSync(
      join(root, 'src', `module-${String(i).padStart(3, '0')}.js`),
      `export function handler${i}(a, b) { return a + b + ${i}; }\nexport const NAME_${i} = 'm${i}';\n`,
    );
    writeFileSync(join(root, 'test', `module-${String(i).padStart(3, '0')}.test.js`), `// t${i}\n`);
  }
  return root;
}

/** The whole round-1 wire, exactly as `turn.mjs` serialises it for the cache reading. */
function wireFor(task, root, { map = true } = {}) {
  const offered = shortlistTools(task, OFFER);
  const tools = orderForCachePrefix(
    toolSchemasFor(offered, { shell: true }),
    { maxRounds: ROUNDS, shortlist: ORDER_KEY },
  );
  const sys = assembleSystemMessage({
    base: systemPrompt({ maxRounds: ROUNDS, allowRun: true, offeredNames: offered, untilDone: true, shell: true }),
  });
  const built = buildRepoMap(root, {}, { task });
  const contextText = map
    ? (built.ok ? built.text : '')
    : NO_MAP_NOTE;
  const usr = userPrompt({ task, contextText, root, skillsHint: null });
  return appendOnlyWireBytes({
    tools,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE LEAK — an unclassified verb rides along on every task, for ever
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ a greeting comes OUT of shortlistTools as exactly the core, nothing riding along', () => {
  /**
   * ⚠️ THE ASSERTION IS OVER THE OUTPUT, NOT OVER THE TABLES.
   * `test/tool-shortlist.test.mjs` owns the tables (every verb is CORE or in a
   * group; no group names a ghost) and owns them better. This is the property
   * those tables are only a PROXY for: a change to the fallback at the bottom of
   * `shortlistTools` — or a group whose words start matching the empty-signal
   * case — widens the greeting while every name stays perfectly classified.
   */
  const core = new Set(CORE_TOOLS);
  const offered = shortlistTools('hi', OFFER);
  const expected = OFFER.filter((n) => core.has(n));
  assert.deepEqual(
    [...offered].sort(), [...expected].sort(),
    'a greeting signals no group, so its offer must be the core and nothing else. '
    + `extra: ${offered.filter((n) => !core.has(n)).join(', ') || '(none)'}`,
  );
  assert.ok(offered.length > 0 && offered.length < OFFER.length, 'the shortlist must actually be cutting something');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE CLOSED LIST — it must not become a classifier
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐ real instructions that LOOK trivial are NOT conversational', () => {
  /**
   * ⚠️ EVERY ONE OF THESE WOULD BE TAKEN BY A KEYWORD SCORER OR A LENGTH RULE,
   * and `shortlistTools`'s old `length < 12` rule is the recorded proof that a
   * length rule on this exact axis was shipped and was wrong. `"fix it"` is six
   * characters, signals no tool group, and is a job.
   */
  for (const t of [
    'fix it', 'go', 'do it', 'continue', 'carry on', 'again', 'retry',
    'build it', 'run the tests', 'ship it', 'make it work', 'now the header',
    'hi, look at app.tsx', 'hey can you fix src/auth.ts', 'thanks — now deploy',
    'ok now rewrite the parser', 'test the login flow', 'what can you do about the 404',
  ]) {
    assert.equal(
      isConversationalTurn(t), false,
      `"${t}" carries work; suppressing the workspace map for it is a silent `
      + 'capability loss with no widen to rescue it',
    );
  }
});

test('the greetings and pleasantries ARE conversational, punctuation and case included', () => {
  for (const t of ['hi', 'Hi', 'HI!', ' hey there ', 'thanks!', 'Thank you.', 'ok', 'what can you do?']) {
    assert.equal(isConversationalTurn(t), true, `"${t}" should be recognised as conversation`);
  }
  // ⚠️ An EMPTY task is the ABSENCE of an instruction, not a short one — the
  // same rule `shortlistTools` states for `''`. It keeps the full context.
  for (const t of ['', '   ', null, undefined]) {
    assert.equal(isConversationalTurn(t), false, 'an empty task is not a greeting');
  }
});

test('⚠️ the list is matched WHOLE, never as a substring', () => {
  // `ok` is in the list; "ok now rewrite the parser" contains it and must not match.
  const withSubstring = CONVERSATIONAL
    .filter((w) => w.length <= 4)
    .map((w) => `${w} now rewrite the parser`);
  for (const t of withSubstring) {
    assert.equal(isConversationalTurn(t), false, `"${t}" must not match on a substring`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE SAVING, AND THE ESCAPE HATCH THAT MAKES IT SAFE
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ the map is the biggest block in a greeting, and a greeting no longer sends it', (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const full = wireFor('hi', root, { map: true });
  const cut = wireFor('hi', root, { map: false });
  const saved = full.length - cut.length;

  assert.ok(
    saved > 10_000,
    `the map should be the largest single block in a greeting; saved only ${saved} B `
    + `(full ${full.length} B, cut ${cut.length} B)`,
  );

  // The real path, through the function `turn.mjs` calls.
  let gathered = 0;
  const hi = contextTextForTurn('hi', () => { gathered += 1; return 'MAP'; });
  assert.equal(hi.suppressed, true);
  assert.equal(hi.text, NO_MAP_NOTE);
  assert.equal(
    gathered, 0,
    'the map must not be BUILT on a turn that will not send it — walking a real '
    + 'tree measured 670–1,018 ms per invocation',
  );

  const job = contextTextForTurn('add a health endpoint', () => { gathered += 1; return 'MAP'; });
  assert.equal(job.suppressed, false);
  assert.equal(job.text, 'MAP');
  assert.equal(gathered, 1, 'a real task must still get the real map');
});

test('⭐⭐ the suppression names the way out — a repo map cannot be reached for', () => {
  /**
   * `shouldWiden` fires when the model REACHES for a verb it was not given. A
   * model that is not shown a file tree does not ask for one, so the shortlist's
   * escape hatch cannot cover this — the same hole `tool-shortlist.mjs` records
   * for `find_symbol` and `start_process`. The note IS the escape hatch.
   */
  assert.match(NO_MAP_NOTE, /list_dir/, 'the note must name the verb that recovers the tree');
  assert.ok(NO_MAP_NOTE.length < 200, `the escape hatch must be cheap; it is ${NO_MAP_NOTE.length} B`);
  assert.equal(
    contextTextForTurn('hi', () => 'MAP').text.includes('list_dir'), true,
    'the note must actually reach the prompt, not merely be exported',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ⭐⭐⭐ THE CACHE — the assertion a reasonable person would doubt
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ dropping the map on a greeting moves the CROSS-TASK shared prefix by ZERO bytes', (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  /**
   * ⚠️ THE OTHER TASK MUST SELECT A DIFFERENT GROUP, or the tool blocks are
   * identical and the test proves nothing about the mechanism. "build me a
   * landing page" hits `media`; "hi" hits none.
   */
  const other = 'build me a landing page with a photo gallery';
  assert.notDeepEqual(
    shortlistTools('hi', OFFER), shortlistTools(other, OFFER),
    'the fixture is only meaningful if the two tasks get different tool blocks',
  );

  const otherWire = wireFor(other, root);
  const withMap = sharedPrefixBytes(wireFor('hi', root, { map: true }), otherWire);
  const noMap = sharedPrefixBytes(wireFor('hi', root, { map: false }), otherWire);

  assert.equal(
    noMap, withMap,
    'THE WHOLE ARGUMENT. Prefix caching is sequential: the tool shortlist has '
    + 'already diverged the wire inside the schemas, so the map behind it was '
    + `cold whether we sent it or not. shared with map ${withMap} B, without ${noMap} B`,
  );
  assert.ok(withMap > 0, 'the two wires must share SOMETHING, or the measurement is vacuous');
});

test('⭐⭐ chat-then-chat: the second turn is just as warm, on a smaller payload', (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  /**
   * The one case where the map IS a genuinely shared prefix — two conversational
   * turns get the same shortlist, so nothing diverges before it. It still loses
   * nothing, because a WARM byte is a BILLED byte at 1/15.7: the cold remainder
   * is unchanged and the warm remainder is 32 KB smaller.
   */
  const coldOn = wireFor('hi', root, { map: true });
  const coldOff = wireFor('hi', root, { map: false });
  const warmOn = wireFor('thanks', root, { map: true });
  const warmOff = wireFor('thanks', root, { map: false });

  const missOn = warmOn.length - sharedPrefixBytes(coldOn, warmOn);
  const missOff = warmOff.length - sharedPrefixBytes(coldOff, warmOff);

  assert.equal(
    missOff, missOn,
    `the COLD (full-price) byte count on the second chat turn must not grow: `
    + `${missOn} B with the map, ${missOff} B without`,
  );
  assert.ok(
    warmOff.length < warmOn.length,
    'and the warm remainder — still billed, at 1/15.7 — must shrink',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ⚠️⚠️⭐ THE ONE CASE WHERE THE TRAP DOES BITE — found by mutating for it
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️⭐ with the shortlist OFF the map IS a shared prefix, so the suppression stands down', (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  /**
   * With `ACUVO_TOOL_SHORTLIST=0` every task gets the same tool block, so
   * nothing diverges before the map and the map becomes a genuine cross-task
   * prefix. Measured on `console/`: 101,535 B shared with the map against
   * 77,954 B without — a 23,581 B loss. That is the trap `tool-shortlist.mjs`
   * warns about, and it is why the gate exists.
   */
  const other = 'build me a landing page with a photo gallery';
  const wide = (task, { map = true } = {}) => {
    const tools = orderForCachePrefix(
      toolSchemasFor(OFFER, { shell: true }), { maxRounds: ROUNDS, shortlist: null },
    );
    const sys = assembleSystemMessage({
      base: systemPrompt({ maxRounds: ROUNDS, allowRun: true, offeredNames: OFFER, untilDone: true, shell: true }),
    });
    const built = buildRepoMap(root, {}, { task });
    const ctx = map ? (built.ok ? built.text : '') : NO_MAP_NOTE;
    return appendOnlyWireBytes({
      tools,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt({ task, contextText: ctx, root, skillsHint: null }) }],
    });
  };
  const O = wide(other);
  const withMap = sharedPrefixBytes(wide('hi', { map: true }), O);
  const noMap = sharedPrefixBytes(wide('hi', { map: false }), O);
  assert.ok(
    noMap < withMap,
    'the fixture must reproduce the hazard: with an unshortlisted (identical) '
    + `tool block, dropping the map MUST cost prefix. with ${withMap} B, without ${noMap} B`,
  );

  // ⭐ AND THE GATE STANDS DOWN FOR EXACTLY THAT CASE.
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    let built = 0;
    const r = contextTextForTurn('hi', () => { built += 1; return 'MAP'; }, { env: { ACUVO_TOOL_SHORTLIST: off } });
    assert.equal(r.suppressed, false, `ACUVO_TOOL_SHORTLIST=${JSON.stringify(off)} must keep the map`);
    assert.equal(built, 1);
  }
  for (const on of [undefined, '', '1', 'true', 'on', 'yes']) {
    const r = contextTextForTurn('hi', () => 'MAP', { env: { ACUVO_TOOL_SHORTLIST: on } });
    assert.equal(r.suppressed, true, `ACUVO_TOOL_SHORTLIST=${JSON.stringify(on)} leaves the shortlist on, so the map goes`);
  }
});

test('⚠️⚠️ the flag parse here is pinned to the ONE in turn.mjs — a second copy is the copy that rots', () => {
  /**
   * ⚠️ THIS IS A SOURCE READ ON PURPOSE. The parse lives inline in `runSession`,
   * ~600 lines below the call site, so it cannot be imported. Reading the file
   * is the only way to make a change over there turn this red rather than
   * silently un-gate the suppression.
   */
  const src = readFileSync(new URL('../lib/turn.mjs', import.meta.url), 'utf8');
  const idx = src.indexOf('ACUVO_TOOL_SHORTLIST ??');
  assert.ok(idx > 0, 'turn.mjs must still read ACUVO_TOOL_SHORTLIST — if it moved, this gate is guessing');
  const near = src.slice(idx, idx + 400);
  for (const token of ['0', 'false', 'off', 'no']) {
    assert.ok(
      near.includes(`'${token}'`),
      `turn.mjs no longer treats '${token}' as OFF, so chat-turn.mjs's copy disagrees `
      + 'and the map suppression fires under a setting that has a prefix to protect',
    );
  }
  // and the two agree on behaviour, not only on spelling
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.equal(toolShortlistEnabled({ ACUVO_TOOL_SHORTLIST: v }), false);
  }
  assert.equal(toolShortlistEnabled({}), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ⭐⭐⭐ END TO END — only a real runSession proves the change is REACHED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ `feedback_only_the_end_to_end_run_proves_reach` and
 * `feedback_wire_it_in_the_same_commit`: everything above tests
 * `chat-turn.mjs` and a hand-built wire. Neither can fail if `turn.mjs` never
 * calls the function. This drives the real `runSession` with a scripted model —
 * $0.00, no network — and reads the user message that was actually SENT.
 */
async function firstUserMessage(root, task) {
  let sent = null;
  await runSession({
    task,
    executor: createLocalExecutor(root),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds: 1,
    allowRun: false,
    callModelImpl: async (opts) => {
      if (sent === null) {
        const m = opts.messages.find((x) => x.role === 'user');
        sent = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
      }
      return { ok: true, content: 'hello', toolCalls: [], usage: { cost: 0, total_tokens: 4 }, finishReason: 'stop', model: 'fake/model' };
    },
    onEvent: () => {},
  });
  assert.ok(sent, 'the session never sent a user message — the harness is broken, not the feature');
  return sent;
}

test('⭐⭐⭐ END TO END: a greeting reaches the model WITHOUT the file tree, and a task reaches it WITH one', async (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const greeting = await firstUserMessage(root, 'hi');
  const job = await firstUserMessage(root, 'add a health endpoint to src/module-000.js');

  // ⚠️ ANCHORED TO THE MODULE'S OWN OUTPUT, not to a substring guess — the same
  // reason `repo-map-task-reaches-the-caller.test.mjs` gives for doing it this
  // way: "different" passes on any source of noise.
  const built = buildRepoMap(root, {}, { task: 'add a health endpoint to src/module-000.js' });
  assert.ok(built.ok, 'the fixture must produce a map at all, or nothing below means anything');
  assert.ok(
    job.includes(built.text),
    'a REAL task must still be sent the workspace map — the suppression has over-reached',
  );

  assert.equal(
    greeting.includes('REPO MAP'), false,
    'the greeting was still sent a repo map: turn.mjs is not calling contextTextForTurn',
  );
  assert.ok(greeting.includes(NO_MAP_NOTE), 'the greeting must carry the escape hatch that names list_dir');
  assert.ok(
    greeting.length < job.length / 2,
    `the greeting's user message should be a fraction of the task's: ${greeting.length} B vs ${job.length} B`,
  );
});
