/**
 * ── ⭐⭐⭐ THREE OF THE SIX CREATIVE ENGINES ARE UNREACHABLE, AND THE REASON
 *          THE CLI GAVE WAS ADVICE A CUSTOMER CANNOT FOLLOW ────────────────
 *
 * `acuvo engines --json` reports `acuvo-video`, `acuvo-voice` and `acuvo-face`
 * as not runnable here, with: *"set ACUVO_MEDIA_SECRET (or MODAL_VIDEO_SECRET).
 * The endpoint address ships with this package — the secret is the only thing
 * missing."*
 *
 * ⚠️ THAT SECRET IS OURS. It is the shared credential for OUR Modal workers.
 * A paying customer cannot obtain it and never will, so for the audience most
 * likely to read that line the sentence is a dead end dressed as an
 * instruction. `doctor.mjs` records the same class of mistake in its own
 * voice — *"sent a customer who had already paid us off to buy a competitor's
 * key"* — and fixed its media advice; this file kept the old sentence.
 *
 * ── ⚠️⚠️ AND THE OBVIOUS FIX WOULD HAVE BEEN A WORSE LIE ───────────────────
 *
 * The doctor's cure is *"run `acuvo login` — a plan turns on <verb> through the
 * gateway with nothing to configure"*, and copying it here would be false.
 * `media.mjs`'s `mediaRoutes` opens SIX gateway doors and
 * `creative-engines.mjs` derives exactly those leaves: render, engines, speak,
 * transcribe, document, doc-read, table-read. **There is no `video`,
 * `voice-clone` or `avatar` leaf**, and `avatar-run.mjs` — which serves all
 * three of these verbs — reads `avatarConfig(env)` and has no account path at
 * all. Signing in does not open them.
 *
 * ⭐ So this file pins the shape of an honest refusal: it must serve BOTH
 * audiences and mislead neither.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  engineById,
  formatEngineList,
  engineReach,
  ENGINE_REACHED_BY,
  renderEndpoint,
  speakEndpoint,
  transcribeEndpoint,
  documentEndpoint,
  docReadEndpoint,
  tableReadEndpoint,
} from '../lib/creative-engines.mjs';

/** The three engines that run on our own GPU and are gated on the secret. */
const GPU_ENGINES = ['acuvo-video', 'acuvo-voice', 'acuvo-face'];

/** No secret anywhere — the state of every machine that is not ours. */
const BARE = {};

test('⭐⭐⭐ the three are reachable the moment the secret exists — this is a CREDENTIAL gap, not a wiring one', () => {
  for (const id of GPU_ENGINES) {
    const engine = engineById(id);
    const verb = ENGINE_REACHED_BY[id].verb;
    assert.equal(
      engineReach(engine, { env: BARE, verb }).state, 'not-configured',
      `${id} must report the credential state, not "no path" — the code path exists and \`${verb}\` drives it`,
    );
    assert.equal(
      engineReach(engine, { env: { MODAL_VIDEO_SECRET: 's' }, verb }).state, 'ok',
      `${id} became reachable with nothing but the secret set — so anything that calls it "not wired" is wrong`,
    );
  }
});

test('⭐⭐⭐ the refusal does not present OUR internal secret as the only way in', () => {
  for (const id of GPU_ENGINES) {
    const { detail } = engineReach(engineById(id), { env: BARE, verb: ENGINE_REACHED_BY[id].verb });
    assert.match(detail, /ACUVO_MEDIA_SECRET/, 'an operator running their own workers still needs the variable named');
    /**
     * ⚠️ THE OPERATOR HALF MUST BE CONDITIONAL. "Set X" as a bare imperative
     * reads, to the customer, as a thing they have failed to do.
     */
    assert.match(
      detail, /if you run the Modal workers yourself/i,
      `${id}: the secret is OURS. Told unconditionally, it sends a paying customer looking for a credential that does not exist for them.`,
    );
    assert.ok(
      !/the secret is the only thing missing\.$/.test(detail.trim()),
      `${id}: that sentence is false for anyone on a plan — for them the missing thing is a gateway route we have not built`,
    );
  }
});

test('⭐⭐ and it must NOT tell them to sign in, because that would not work either', () => {
  for (const id of GPU_ENGINES) {
    const { detail } = engineReach(engineById(id), { env: BARE, verb: ENGINE_REACHED_BY[id].verb });
    assert.ok(
      !/`?acuvo (--)?login`?/i.test(detail),
      `${id}: there is no gateway leaf for this verb, so "sign in" is advice that cannot work — the precise failure the doctor's media advice was fixed for`,
    );
    assert.match(detail, /no gateway route/i, 'the reader is owed the actual reason, not just the absence of a remedy');
  }
});

/**
 * ⭐⭐⭐ THE STRUCTURAL HALF, AND IT IS THE ONE THAT CANNOT GO STALE. Every
 * sentence above is prose; this asserts the FACT the prose describes. The day
 * somebody adds a `video` leaf, this test goes red and the wording it protects
 * is the thing that has to change.
 */
test('⭐⭐⭐ the gateway has doors for the media verbs and none for the three engine verbs', async () => {
  const base = 'https://gw.example/v1/chat/completions';
  for (const [name, fn] of Object.entries({ renderEndpoint, speakEndpoint, transcribeEndpoint, documentEndpoint, docReadEndpoint, tableReadEndpoint })) {
    assert.ok(String(fn(base)).startsWith('https://gw.example/v1/'), `${name} must resolve a gateway leaf`);
  }
  /**
   * ⚠️ ASSERTED BY ABSENCE FROM THE MODULE, not by a list typed here. A named
   * list would be a second opinion beside the exports and would agree with them
   * only until somebody added one.
   */
  const mod = Object.keys(await import('../lib/creative-engines.mjs'));
  for (const leaf of ['video', 'voiceClone', 'avatar', 'talkingHead']) {
    assert.ok(
      !mod.includes(`${leaf}Endpoint`),
      `${leaf}Endpoint now exists — a gateway route for it has been built, so the refusal above must stop saying there is none`,
    );
  }
});

/**
 * ── 🚨⭐⭐ AND THE SAME LIE SURVIVED IN THE COLUMN THIS FILE NEVER RENDERED ──
 *
 * Every test above inspects `engineReach(...).detail` — the REFUSAL, which is
 * what you read after asking for an engine you cannot have. Driven as a
 * stranger on 2026-09-18, `acuvo engines` — the command you run BEFORE that, to
 * find out what you can do at all — printed:
 *
 *     voice
 *       acuvo-voice        —              set ACUVO_MEDIA_SECRET
 *
 * the exact sentence this file exists to forbid, in the surface a new customer
 * reaches first. The tests were right and their UNIVERSE was the refusal string
 * alone, so the second copy of the fact was never in scope.
 *
 * ⭐ This file's own header argues that a customer cannot obtain that secret.
 * `creative-engines.mjs`'s footer note argues that *"a second copy of a fact
 * does not get fixed when the first one does."* Both were already written down;
 * what was missing was a guard that rendered the command.
 */
test('🚨 the `acuvo engines` STATUS COLUMN does not tell a customer to set our secret either', () => {
  const printed = formatEngineList({
    source: 'none',
    ageMs: null,
    catalogue: null,
    env: BARE,
  }).join('\n');

  // ⚠️ Control: the three GPU engines must actually appear, or this proves nothing.
  for (const id of GPU_ENGINES) {
    assert.match(printed, new RegExp(id.replace(/[-]/g, '\-')), `${id} is missing from the listing`);
  }

  /**
   * ⚠️ THE COLUMN, NOT THE WHOLE PAGE. The footnote below the table is ALLOWED
   * to name the secret — it names both audiences and says plainly that a plan
   * user has nothing to set. Forbidding the string everywhere would delete the
   * honest sentence along with the dishonest one, which is this repo's
   * "prefer scope to prohibition" in one assertion.
   */
  const tableRows = printed
    .split('\n')
    .filter((l) => GPU_ENGINES.some((id) => l.includes(id)));
  assert.ok(tableRows.length >= GPU_ENGINES.length, 'the table rows were not found — the scope is wrong');
  for (const row of tableRows) {
    assert.doesNotMatch(
      row,
      /ACUVO_MEDIA_SECRET|MODAL_VIDEO_SECRET/,
      `the status column offers our internal credential as the cure: ${row.trim()}`,
    );
  }
});

test('⭐ and the listing still explains BOTH audiences, rather than going silent', () => {
  /**
   * ⚠️ THE FAILURE MODE OF THE FIX ABOVE. Deleting the sentence would satisfy
   * the assertion and leave an operator — who CAN set the secret and for whom
   * it is the correct answer — with a dash and no explanation. Roman's standing
   * note applies: *prefer SCOPE to PROHIBITION; a guard must state what ability
   * it costs.*
   */
  const printed = formatEngineList({ source: 'none', ageMs: null, catalogue: null, env: BARE }).join('\n');
  assert.match(printed, /ACUVO_MEDIA_SECRET/, 'an operator running the workers must still be told what to set');
  assert.match(printed, /no gateway route yet|nothing you can set/i, 'and a plan user must be told it will not help them');
  assert.match(printed, /Studio/, 'and where the engine actually lives today');
});
