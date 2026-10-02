/**
 * ── 💰 THE CREATIVE VERBS MUST NOT FALL BACK INTO THE JSON DEFAULT ──────────
 *
 * `turn.mjs`'s `describeToolResult` has a `switch` with a `default:` that runs
 * `stringifyForModel`. Every multimodal verb sat in that default until
 * 2026-08-30, reaching the model as an escaped JSON envelope — measured at 6.3x
 * (`generate_image`), 7.7x (`transcribe`) and 3.6x (`list_engines`) the tokens
 * of the same facts as a sentence.
 *
 * ⚠️ AND IT IS PAID EVERY ROUND, not once. The history is append-only, so a
 * creative result at round 3 is re-sent for the rest of the session.
 *
 * ⚠️ THE FAILURE MODE THIS GUARDS IS SILENT. Deleting a `case` does not break
 * anything: the verb keeps working, the model keeps reading it, and the only
 * symptom is a bigger bill. Nothing else in the suite would notice.
 *
 * ⭐ SO THE ASSERTION IS ON THE SHAPE, NOT ON A BYTE COUNT. A count would have
 * to be re-typed every time a note is reworded. "It is not a JSON envelope, and
 * it does not contain the fields we deliberately dropped" survives rewording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolResultText } from '../lib/turn.mjs';

const rec = (name, result, extra = {}) => ({ id: 'c1', args: {}, name, result, ...extra });

/** The real shape from `imagegen.mjs:952` — `{ ...directed, note }`. */
const IMAGE_RESULT = {
  ok: true,
  path: 'assets/hero.jpg',
  bytes: 148213,
  width: 1536,
  height: 864,
  provider: 'pollinations',
  seed: 84213,
  score: 8,
  problems: ['the horizon is tilted'],
  directedPrompt: 'A WIDE CINEMATIC PHOTOGRAPH, 35mm, muted teal and amber grade, documentary realism',
  strippedText: 'no text, no watermark',
  attempts: [
    { attempt: 1, path: 'a1.jpg', score: 5, problems: ['a malformed wrench'] },
    { attempt: 2, path: 'a2.jpg', score: 8, problems: ['the horizon is tilted'] },
  ],
  accepted: true,
  note: 'Drawn by Pollinations. Reviewed and accepted (8/10).',
};

test('⭐ generate_image renders as a sentence, not a JSON envelope', () => {
  const out = toolResultText(rec('generate_image', IMAGE_RESULT));
  assert.ok(!out.includes('{"ok":'), `it fell back to the JSON default:\n${out}`);
  assert.match(out, /assets\/hero\.jpg/, 'the path must survive — the model embeds it');
  assert.match(out, /1536x864/, 'the dimensions must survive — they set width/height');
  assert.match(out, /8\/10/, 'the review verdict must survive — a low score is actionable');
});

test('⚠️ …and it drops the fields the model cannot act on', () => {
  const out = toolResultText(rec('generate_image', IMAGE_RESULT));
  assert.ok(
    !out.includes('A WIDE CINEMATIC PHOTOGRAPH'),
    'directedPrompt is back: our rewrite of a prompt the model wrote itself, and the largest field',
  );
  assert.ok(!out.includes('a malformed wrench'), 'attempts[] is back — those images were thrown away');
  assert.ok(!out.includes('strippedText'), 'raw field names are back — this is an envelope again');
});

test('⭐ generate_image stays far under the envelope it replaced', () => {
  const out = toolResultText(rec('generate_image', IMAGE_RESULT));
  const envelope = JSON.stringify(IMAGE_RESULT).length;
  assert.ok(
    out.length < envelope / 2,
    `the formatted line is ${out.length} chars against a ${envelope}-char envelope — `
    + 'the saving that justified this case is gone',
  );
});

test('⚠️⚠️ transcribe does not put the transcript in the prompt twice', () => {
  const words = 'the cache was being voided on every single turn and nobody had measured it';
  const segments = Array.from({ length: 12 }, (_, i) => ({ start: i * 4, end: i * 4 + 4, text: words }));
  const out = toolResultText(rec('transcribe', {
    ok: true, path: 'audio/call.wav', text: segments.map((s) => s.text).join(' '), segments,
  }));
  assert.ok(!out.includes('{"ok":'), 'it fell back to the JSON default');
  // The words appear once per segment and NOT a thirteenth time from the blob.
  const occurrences = out.split(words).length - 1;
  assert.equal(
    occurrences, segments.length,
    `the transcript appears ${occurrences} times for ${segments.length} segments — `
    + 'the standalone `text` blob is back alongside the segments it duplicates',
  );
  assert.match(out, /\[0\.0\]/, 'the timings must survive — "what was said at 4:12" is the whole point');
});

test('⚠️ list_engines does not send the catalogue as both an array and a rendering', () => {
  const out = toolResultText(rec('list_engines', {
    ok: true,
    pricesKnown: true,
    tier: 'solo',
    creditsRemaining: 4200,
    engines: [{ id: 'acuvo-image', label: 'Acuvo Image', credits: 12, kind: 'image' }],
    text: 'Acuvo Image (image) — 12 credits',
    note: 'Quantities are alternatives.',
  }));
  assert.ok(!out.includes('"id":'), 'the engines array is back alongside the rendered text');
  assert.match(out, /Acuvo Image \(image\)/, 'the rendered list must survive');
  assert.match(out, /4200 credits left/, 'the balance must survive — it gates the next call');
});

test('⭐ an asset verb still says it was a DRY RUN', () => {
  const out = toolResultText(rec('generate_video', {
    ok: true, path: 'clips/promo.mp4', bytes: 0, dryRun: true,
  }));
  assert.match(out, /DRY RUN/, 'a model told "wrote promo.mp4" will embed a file that does not exist');
  assert.ok(!out.includes('{"ok":'), 'it fell back to the JSON default');
});

/**
 * ── ⚠️⚠️ THE BUG THIS PAIR EXISTS FOR ───────────────────────────────────────
 *
 * `toolResultText` ended `return \`${body}\n${notes}\`` — dropping `editCheck`
 * and `diagnostics` whenever a `PostToolUse` hook ALSO failed. The common path
 * returns `withDiagnostics` two lines earlier and behaves perfectly, so the
 * defect needed a hook failure and a diagnostic in the same record to appear.
 */
test('⚠️⚠️ a failing hook does not swallow the compiler verdict', () => {
  const out = toolResultText({
    id: 'c1',
    args: {},
    name: 'write_file',
    result: { ok: true, path: 'a.ts', bytes: 40, created: true, editCheck: ' [lint: 1 new warning]' },
    diagnostics: ' [tsc: a.ts(3,1): error TS2304: Cannot find name "foo"]',
    hookFailures: [{ hook: 'eslint', kind: 'exit', exitCode: 1, output: 'a.ts:3:1  error  no-undef' }],
  });
  assert.match(out, /TS2304/, 'the compiler verdict was dropped because a hook also failed');
  assert.match(out, /lint: 1 new warning/, 'the edit check was dropped because a hook also failed');
  assert.match(out, /PostToolUse hook "eslint"/, 'the hook note itself must still arrive');
});

test('⚠️ a hook that vomits output is clamped — it is re-sent every later round', () => {
  const flood = 'a.ts:1:1  error  no-undef\n'.repeat(4_000);
  const out = toolResultText({
    id: 'c1',
    args: {},
    name: 'write_file',
    result: { ok: true, path: 'a.ts', bytes: 40, created: true },
    hookFailures: [{ hook: 'eslint', kind: 'exit', exitCode: 1, output: flood }],
  });
  assert.ok(
    out.length < 4_000,
    `a failing hook put ${out.length} chars into an APPEND-ONLY history — `
    + 'that is paid on every round for the rest of the session',
  );
  assert.match(out, /characters omitted/, 'the model must be TOLD it was cut, never handed a sentence that stops');
});
