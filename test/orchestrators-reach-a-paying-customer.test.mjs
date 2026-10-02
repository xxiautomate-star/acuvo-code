/**
 * ── 🚪⭐⭐⭐ TWO VERBS THAT NO CUSTOMER COULD EVER BE OFFERED ────────────────
 *
 * MEASURED 2026-08-31, by building the real offer with four different
 * environments:
 *
 *     fresh install, not signed in        viral ✗  podcast ✗
 *     PAYING CUSTOMER, `acuvo --login`    viral ✗  podcast ✗   ← the defect
 *     our machine, MODAL_VIDEO_SECRET     viral ✓  podcast ✓
 *
 * `viralToolNames` and `podcastToolNames` gated on `mediaConfig(env).speak`,
 * which resolves a baked-in Modal URL and then requires `ACUVO_MEDIA_SECRET` /
 * `MODAL_VIDEO_SECRET` — our own internal credentials. A customer cannot obtain
 * them and must never receive them, so two finished, priced, byte-classified
 * verbs were offered to precisely one machine: ours.
 *
 * ⭐ AND `speak` — THE THING THEY ARE BUILT ON — HAD ALREADY BEEN FIXED. Its
 * note in `media.mjs` records the identical bug for `--say` and `--task-audio`
 * ("printed a message naming a variable they could never usefully set") and the
 * answer: `speakVia`, which prefers a local worker and otherwise routes through
 * the signed-in account's `<gateway>/speak`. The orchestrators simply never
 * moved to it, so the gate was asking a question the runtime had stopped asking.
 *
 * ⚠️⚠️ THE FIVE AVATAR VERBS ARE A DIFFERENT ANSWER AND THIS FILE PINS THAT
 * TOO. `clone_voice`, `design_voice`, `character_lock`, `talking_head` and
 * `generate_video` have NO gateway route — the console serves chat, device,
 * engines, render, speak, transcribe, document, doc-read and table-read, and
 * nothing else. There is no honest way to open them from inside this package,
 * and they cost nothing while withheld, so they stay gated and the gap is
 * written down here rather than papered over with a verb that always refuses.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolNamesForRounds, toolSchemasFor } from '../lib/tools.mjs';
import { viral, viralToolNames } from '../lib/viral.mjs';
import { podcast, podcastToolNames } from '../lib/podcast.mjs';
import { avatarToolNames } from '../lib/avatar.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** A HOME holding a signed-in Acuvo account — what a paying customer has. */
function signedInHome() {
  const home = mkdtempSync(join(tmpdir(), 'acuvo-acct-'));
  mkdirSync(join(home, '.acuvo'), { recursive: true });
  /**
   * ⚠️ AN OBVIOUSLY FAKE TOKEN, WRITTEN INTO A THROWAWAY HOME. `media.mjs`
   * records why `home` is threaded rather than defaulted at all: a sibling test
   * printed a live `xxi_live_…` token into node's own failure output the last
   * time an account read was left to chance.
   */
  writeFileSync(join(home, '.acuvo', 'credentials.json'),
    JSON.stringify({ token: 'acuvo_sk_NOT_A_REAL_TOKEN', email: 'customer@example.test' }));
  return home;
}
/** A HOME with nothing in it — a fresh install. */
const anonHome = () => mkdtempSync(join(tmpdir(), 'acuvo-anon-'));

const offer = (env, home) => toolNamesForRounds(20, { allowRun: true, env, root: here, home });
const bytes = (names) => Buffer.byteLength(JSON.stringify(toolSchemasFor(names)), 'utf8');

/* ── (1) THE DEFECT, PINNED IN BOTH DIRECTIONS ────────────────────────────── */

test('⭐⭐ a SIGNED-IN customer is offered viral and podcast', () => {
  const names = offer({}, signedInHome());
  assert.ok(names.includes('viral'), 'viral is withheld from a paying, signed-in account');
  assert.ok(names.includes('podcast'), 'podcast is withheld from a paying, signed-in account');
});

test('⚠️ and it still FAILS SHUT — no worker and no account means no verb', () => {
  const names = offer({}, anonHome());
  assert.ok(!names.includes('viral'), 'viral offered with nothing configured — it could only refuse');
  assert.ok(!names.includes('podcast'), 'podcast offered with nothing configured — it could only refuse');
});

test('⭐ the LOCAL route still wins and never needs an account', () => {
  /**
   * Somebody running their own speech worker keeps working byte-identically —
   * `speakVia` prefers `cfg.speak` and never opens the credential file.
   */
  const names = offer({ MODAL_TTS_URL: 'https://my-own-tts.example/speak' }, anonHome());
  assert.ok(names.includes('viral'));
  assert.ok(names.includes('podcast'));
});

test('⚠️ the gate is not just "an account exists" — a single-shot turn still withholds', () => {
  const home = signedInHome();
  assert.deepEqual(viralToolNames({}, { maxRounds: 1, home }), []);
  assert.deepEqual(podcastToolNames({}, { maxRounds: 1, home }), []);
  assert.deepEqual(viralToolNames({}, { maxRounds: 20, home }), ['viral']);
  assert.deepEqual(podcastToolNames({}, { maxRounds: 20, home }), ['podcast']);
});

/* ── (2) ⭐ THE RUNTIME AGREES WITH THE OFFER ──────────────────────────────── */

test('⭐⭐ OFFERED ⟹ NOT REFUSED: the run itself accepts the same account the gate did', async () => {
  /**
   * ⚠️ THIS IS THE HALF THAT MAKES THE FIX REAL. Opening the offer without
   * moving the runtime's own guard would produce a verb that is offered and
   * always refuses — the exact thing `console/lib/agentic-build.ts`'s `toolsFor`
   * forbids: *"a tool that is offered and always refuses costs a round every
   * time the model reaches for it."*
   *
   * ⭐ NOTHING IS SPENT HERE. Both verbs price the job and generate NOTHING
   * until `approve_spend: true`, so the first call is a free preview — which is
   * also why this assertion can exist at all.
   */
  const home = signedInHome();
  const executor = { root: mkdtempSync(join(tmpdir(), 'acuvo-ws-')), writeFile: () => ({ ok: true }), readFile: () => ({ ok: false, error: 'none' }) };

  const v = await viral(executor, { title: 't', scenes: [{ narration: 'hello there', image_prompt: 'a hill' }] }, { env: {}, home });
  assert.ok(!/no speech service/.test(String(v.error ?? '')),
    `viral refused a signed-in account at the runtime while the offer said yes: ${v.error}`);
  assert.equal(v.spent, false, 'the free preview should not have spent anything');

  const p = await podcast(executor, { script: '# Ep\n\nHOST: hello there' }, { env: {}, home });
  assert.ok(!/no speech service/.test(String(p.error ?? '')),
    `podcast refused a signed-in account at the runtime while the offer said yes: ${p.error}`);
});

test('⚠️ the refusal no longer names a credential a customer can never obtain', async () => {
  /**
   * The old message read "set MODAL_TTS_URL and one of ACUVO_MEDIA_SECRET /
   * MODAL_VIDEO_SECRET". Those are ours. Telling a paying user to export one is
   * the defect `speakVia`'s note records, not a help message.
   */
  const executor = { root: mkdtempSync(join(tmpdir(), 'acuvo-ws-')), writeFile: () => ({ ok: true }), readFile: () => ({ ok: false, error: 'none' }) };
  const home = anonHome();
  for (const r of [
    await viral(executor, { scenes: [{ narration: 'x' }] }, { env: {}, home }),
    await podcast(executor, { script: '# E\n\nA: x' }, { env: {}, home }),
  ]) {
    assert.equal(r.ok, false);
    assert.ok(!/ACUVO_MEDIA_SECRET|MODAL_VIDEO_SECRET/.test(r.error),
      `the refusal names one of OUR credentials: ${r.error}`);
    assert.match(r.error, /acuvo --login/, 'the refusal does not name the route a customer actually has');
  }
});

/* ── (3) ⚠️ THE FIVE THAT STAY DARK, AND WHY THAT IS NOT A LEAK ───────────── */

const AVATAR_FIVE = ['clone_voice', 'design_voice', 'character_lock', 'talking_head', 'generate_video'];

test('⚠️⚠️ the five identity verbs are STILL unreachable for a customer — recorded, not fixed', () => {
  /**
   * ⭐ THIS ASSERTION IS THE OPEN ITEM, WRITTEN WHERE SOMEBODY WILL TRIP OVER IT.
   * They need `<gateway>/voice-clone`, `/voice-design`, `/character-lock`,
   * `/avatar` and `/video` (plus the two result-polling routes), and the console
   * serves none of them. Until those exist, opening this gate would offer five
   * verbs that can only fail.
   *
   * ⚠️ WHEN THE ROUTES SHIP, THIS TEST GOES RED — which is the point. Flip it
   * to the positive assertion then; do not delete it.
   */
  assert.deepEqual(avatarToolNames({}), [], 'an avatar verb is offered with no credential at all');
  const names = offer({}, signedInHome());
  for (const v of AVATAR_FIVE) {
    assert.ok(!names.includes(v), `${v} is offered to an account that has no gateway route for it — it can only refuse`);
  }
});

test('⭐ withheld costs EXACTLY ZERO bytes — which is why withdrawing them would buy nothing', () => {
  /**
   * ⚠️ THE BRIEF THAT PRODUCED THIS FILE SAID "~80KB of CLI verbs are
   * unreachable" AND THE BYTE NUMBER IS WRONG. 80KB is roughly the SOURCE of
   * `viral.mjs` + `podcast.mjs` + `avatar*.mjs`; the prompt only ever pays for
   * SCHEMAS, and `toolSchemasFor` serialises only the names in the offer. On a
   * machine that cannot reach the services the cost is zero, so "delete them to
   * save bytes" saves nothing and loses the moat.
   */
  const anon = bytes(offer({}, anonHome()));
  const ours = bytes(offer({ MODAL_VIDEO_SECRET: 's' }, anonHome()));
  assert.ok(ours > anon, 'the seven verbs cost nothing even when offered — re-measure before trusting this file');
  for (const v of [...AVATAR_FIVE, 'viral', 'podcast']) {
    assert.ok(!JSON.stringify(toolSchemasFor(offer({}, anonHome()))).includes(`"${v}"`),
      `${v}'s schema is serialised into an offer that does not include it`);
  }
});

test('⚠️ OFFERED ⟺ NAMED-IN-PROMPT: none of the seven is named in the system prompt', () => {
  /**
   * The pinned invariant is that a verb the prompt names must be a verb the
   * model was given. These seven are conditional, so the prompt must not name
   * any of them — otherwise a customer's prompt advertises a verb that is not in
   * their tool array, and the model spends a round reaching for it.
   */
  const prompt = readFileSync(join(here, '..', 'lib', 'prompt.mjs'), 'utf8');
  for (const v of [...AVATAR_FIVE, 'viral', 'podcast']) {
    assert.ok(!new RegExp(`\\b${v}\\b`).test(prompt),
      `lib/prompt.mjs names "${v}", which is offered only conditionally`);
  }
});
