import test from 'node:test';
import assert from 'node:assert/strict';
import {
  avatarConfig, avatarToolSchemas, avatarToolNames,
  readStart, readPoll, readImmediate, pickArtifact, keepPolling, whyUnavailable,
  DEFAULT_JOB_BUDGET_MS,
} from '../lib/avatar.mjs';

const full = {
  MODAL_VIDEO_SECRET: 's3cret',
  MODAL_AVATAR_URL: 'https://x/avatar',
  MODAL_VOICE_CLONE_URL: 'https://x/clone',
  MODAL_VOICE_DESIGN_URL: 'https://x/design',
  MODAL_VIDEO_URL: 'https://x/video',
};

/* ── what is reachable ───────────────────────────────────────────────────── */

test('⭐⭐⭐ the four moat verbs are offered when configured', () => {
  const names = avatarToolNames(full);
  for (const n of ['clone_voice', 'design_voice', 'talking_head', 'generate_video']) {
    assert.ok(names.includes(n), `${n} is missing — this is the capability the CLI did not have`);
  }
});

test('⚠️⚠️ a URL without the SECRET is not "configured" — it is a 401 in costume', () => {
  /**
   * Any check that only looked for the address would report this integration
   * healthy, and the model would then call a verb that cannot possibly work.
   */
  const noSecret = { ...full };
  delete noSecret.MODAL_VIDEO_SECRET;
  assert.deepEqual(avatarToolNames(noSecret), []);
  assert.equal(avatarConfig(noSecret).face, null);
});

test('⚠️⚠️ nothing is offered that cannot run — and the SECRET is now the whole gate', () => {
  /**
   * ── ⭐⭐⭐ INVERTED 2026-08-25, DELIBERATELY, AND THIS IS THE REASONING ────
   *
   * This test used to read `avatarToolNames({SECRET, VOICE_CLONE_URL})` and
   * demand exactly `['clone_voice']` — i.e. "a verb needs its own URL". That
   * contract was correct and it was also the bug: the URLs lived only in
   * `console/.env.local`, a file that ships to nobody, so on every install that
   * was not our own console directory ALL FIVE moat verbs were silently
   * unoffered. `speak` and `edit_image` worked everywhere because their modules
   * ship a `DEFAULT_…_URL`; `avatar.mjs` was the only creative module that did
   * not.
   *
   * ⭐ THE PROPERTY BEING PROTECTED HAS NOT CHANGED — "nothing is offered that
   * cannot run". What changed is what makes a verb runnable: the address ships,
   * so the SECRET is the gate. The assertion is inverted rather than deleted
   * because the underlying rule is the one worth keeping.
   */
  const secretOnly = { MODAL_VIDEO_SECRET: 's' };
  assert.deepEqual(
    avatarToolNames(secretOnly),
    ['clone_voice', 'design_voice', 'character_lock', 'talking_head', 'generate_video'],
    'one credential must turn on all five — the addresses are ours and ship with the package',
  );

  /**
   * ⚠️ AND THE OTHER HALF IS UNCHANGED AND STILL LOAD-BEARING: no secret, no
   * verbs. A URL with no secret is a 401 in costume, and offering a tool the
   * product will then refuse is the most expensive lie a schema can tell.
   */
  assert.deepEqual(avatarToolNames({}), []);

  /**
   * ⭐ THE OPT-OUT SURVIVES, and it is the reason an empty value is read
   * differently from an unset one. Somebody on an air-gapped box who writes
   * `MODAL_AVATAR_URL=` means "do not call it", and that has to keep working now
   * that unset means "use ours".
   */
  assert.deepEqual(
    avatarToolNames({ ...secretOnly, MODAL_AVATAR_URL: '' }),
    ['clone_voice', 'design_voice', 'character_lock', 'generate_video'],
    'an explicitly empty URL is a deliberate opt-out, not a missing config',
  );
});

test('⭐ the expensive verbs SAY they are expensive, in the schema', () => {
  /**
   * A model with no sense of price will render a talking head onto a placeholder
   * page. Naming the cost where the model actually reads is the cheapest
   * guardrail available.
   */
  const byName = Object.fromEntries(avatarToolSchemas(full).map((t) => [t.function.name, t.function.description]));
  assert.match(byName.talking_head, /minutes|not free|per video-second/i);
  assert.match(byName.generate_video, /expensive|per second/i);
});

test('⚠️ consent is named for the two verbs that impersonate a person', () => {
  const byName = Object.fromEntries(avatarToolSchemas(full).map((t) => [t.function.name, t.function.description]));
  assert.match(byName.clone_voice, /permission|owns/i);
  assert.match(byName.talking_head, /right to use|permission/i);
});

/* ── the job protocol ────────────────────────────────────────────────────── */

test('⭐ a start is read from either callId spelling', () => {
  assert.deepEqual(readStart({ ok: true, callId: 'abc' }), { ok: true, callId: 'abc' });
  assert.deepEqual(readStart({ ok: true, call_id: 'abc' }), { ok: true, callId: 'abc' });
});

test('⚠️ a start with no callId is a failure, not a job we can poll forever', () => {
  assert.equal(readStart({ ok: true }).ok, false);
  assert.equal(readStart({ ok: false, error: 'nope' }).ok, false);
});

test('⭐⭐⭐ `running` is SUCCESS-IN-PROGRESS, not failure', () => {
  /**
   * THE ONE THAT MATTERS. This is the answer for most of a render's life, and
   * reading it as failure is what made our own working GPU look dead for days.
   */
  for (const status of ['running', 'pending', 'queued']) {
    assert.equal(readPoll({ ok: true, status }).status, 'running', status);
  }
});

test('⚠️⚠️ `done` with no artifact is a FAILURE, not an empty success', () => {
  /**
   * An empty string is a valid field and silence is a valid WAV. Both mistakes
   * have shipped here, and each time they surfaced as a file the user could not
   * play rather than an error they could act on.
   */
  assert.equal(readPoll({ ok: true, status: 'done' }).status, 'failed');
  assert.equal(readPoll({ ok: true, status: 'done', video_b64: '' }).status, 'failed');
  assert.equal(readPoll({ ok: true, status: 'done', video_b64: 'tiny' }).status, 'failed');
});

test('⭐ a real done carries the artifact and what it cost', () => {
  const r = readPoll({ ok: true, status: 'done', video_b64: 'x'.repeat(2000), seconds: 5, usd: 0.06 });
  assert.equal(r.status, 'done');
  assert.equal(r.seconds, 5);
  assert.equal(r.usd, 0.06);
});

test('⚠️ the artifact field is configurable — audio jobs do not return video', () => {
  const r = readPoll({ ok: true, status: 'done', audio_b64: 'a'.repeat(2000) }, { field: 'audio_b64' });
  assert.equal(r.status, 'done');
});

test('⚠️ the budget is WALL CLOCK, not a poll count', () => {
  /**
   * A poll count silently becomes a different timeout the moment the interval
   * changes, and the number that matters to a user — and to a Modal bill — is
   * minutes.
   */
  const startedAt = 1_000_000;
  assert.equal(keepPolling({ startedAt, now: startedAt + 60_000 }), true);
  assert.equal(keepPolling({ startedAt, now: startedAt + DEFAULT_JOB_BUDGET_MS + 1 }), false);
});

/* ── the message when it is missing ──────────────────────────────────────── */

test('⭐⭐ a switched-off verb names the VARIABLE, never "unknown tool"', () => {
  /**
   * "Unknown tool" tells the user the feature does not exist. It does exist —
   * this install just cannot reach it. One message says "set this", the other
   * says "we cannot do that", and only one is true.
   *
   * ⚠️ INVERTED 2026-08-25 ALONGSIDE THE DEFAULTS. `{SECRET}` alone used to mean
   * "no URL, so unavailable"; it now means "fully configured", so the only way
   * to be unavailable WITH a secret is the deliberate `MODAL_AVATAR_URL=`
   * opt-out. The property under test is unchanged — the message names the exact
   * variable and never claims the capability is missing — and the setup had to
   * move because the meaning of "unset" moved.
   */
  const msg = whyUnavailable('talking_head', { MODAL_VIDEO_SECRET: 's', MODAL_AVATAR_URL: '' });
  assert.match(msg, /MODAL_AVATAR_URL/);
  assert.match(msg, /switched off|empty value/i);
  assert.doesNotMatch(msg, /does not exist|unknown tool/i);

  /**
   * ⭐ AND A WORKING INSTALL HAS NOTHING TO EXPLAIN. A "why is this missing"
   * function that invents a reason for something that is present is how a
   * red-herring reaches a user — it would have read "MODAL_AVATAR_URL is set to
   * an empty value" about a variable nobody had touched.
   */
  assert.equal(whyUnavailable('talking_head', { MODAL_VIDEO_SECRET: 's' }), null);
});

test('⚠️ a missing SECRET is the ONE thing to fix, and the message says so', () => {
  /**
   * ⚠️ INVERTED 2026-08-25. It used to assert the message mentioned "401" and
   * distinguished a missing secret from a missing URL. There is no longer a
   * missing-URL case to distinguish it FROM — the addresses ship — so the
   * sentence's job changed from "you need two things" to "you need exactly one
   * thing, and here it is". Asserting the old text would pin advice that sends
   * people to set a variable that is no longer required.
   */
  const msg = whyUnavailable('clone_voice', {});
  assert.match(msg, /ACUVO_MEDIA_SECRET/);
  assert.match(msg, /MODAL_VIDEO_SECRET/);
  assert.match(msg, /unauthorised/i, 'name what the service actually answers, so the symptom is recognisable');
  assert.match(msg, /ships with this package/i, 'and say the address is NOT the missing piece');
  assert.doesNotMatch(msg, /MODAL_VOICE_CLONE_URL/, 'sending someone to set a URL they do not need is the failure this replaces');
});

test('⚠️ an unrelated tool name gets no invented explanation', () => {
  assert.equal(whyUnavailable('read_file', full), null);
});


test('⭐⭐⭐ A SYNCHRONOUS SERVICE HAS ALREADY FINISHED — do not demand a callId', () => {
  /**
   * ⚠️⚠️ THIS IS THE REAL RESPONSE OUR VOICE GPU RETURNS, captured 2026-08-23.
   * No `status`, no `callId`, and the WAV under `audio` — not `audio_b64`.
   * `readStart` demanded a callId, so the CLI answered "the endpoint returned no
   * callId" while holding the finished audio. The render was done and paid for.
   */
  const real = { ok: true, audio: 'A'.repeat(48_700), contentType: 'audio/wav', bytes: 36_524, seconds: 1.14 };

  assert.equal(readStart(real).ok, false, 'it genuinely has no callId — that part was right');

  const done = readImmediate(real, { field: ['audio', 'audio_b64'] });
  assert.ok(done, 'a finished artifact must not be thrown away for lacking a queue ticket');
  assert.equal(done.status, 'done');
  assert.equal(done.seconds, 1.14);
});

test('⚠️ an ASYNC start response is still a queue ticket, not an artifact', () => {
  // The face renderer really does queue. readImmediate must stay out of its way.
  const queued = { ok: true, status: 'queued', callId: 'fc-123' };
  assert.equal(readImmediate(queued, { field: ['video_b64', 'video'] }), null);
  assert.equal(readStart(queued).callId, 'fc-123');
});

test('⚠⚠ OUR OWN SERVICES DISAGREE ABOUT THE ARTIFACT KEY', () => {
  /**
   * voice returns `audio`; the face path was written expecting `audio_b64` — the
   * name used for its INPUT. Accepting the names our fleet actually uses is why
   * a Python rename cannot silently discard a paid render again.
   */
  assert.equal(pickArtifact({ audio: 'xx' }, ['audio', 'audio_b64']), 'xx');
  assert.equal(pickArtifact({ audio_b64: 'yy' }, ['audio', 'audio_b64']), 'yy');
  assert.equal(pickArtifact({ video: 'zz' }, ['video_b64', 'video']), 'zz');
  assert.equal(pickArtifact({ nothing: 'q' }, ['audio']), null);
  assert.equal(pickArtifact({ audio: '' }, ['audio']), null, 'an empty string is not an artifact');
  assert.equal(pickArtifact({ audio: 'ok' }, 'audio'), 'ok', 'a bare string field still works');
});

test('⚠⚠ a job that is too small to be real is a FAILURE, not an empty success', () => {
  assert.equal(readImmediate({ ok: true, audio: 'tiny' }, { field: ['audio'] }), null);
  assert.equal(readImmediate({ ok: false, error: 'unauthorised' }, { field: ['audio'] }), null);
});
