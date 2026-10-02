/**
 * ── ⚠️⚠️⭐ SIX MEDIA SERVICES REPORTED BROKEN, ALL WITH THE SAME 400 ─────────
 *
 * MEASURED 2026-09-07 by running `--doctor` on a signed-in machine:
 *
 *     broken  see_page       configured (acuvo.xxiautomate.com) · HTTP 400
 *     broken  speak          · HTTP 400
 *     broken  transcribe     · HTTP 400
 *     broken  make_document  · HTTP 400
 *     broken  read_document  · HTTP 400
 *     broken  read_table     · HTTP 400
 *
 * Six independent services failing identically is a probe smell, not six
 * outages. `probeMediaEndpoint` POSTs an EMPTY body on purpose, and its own
 * comment calls the service complaining about that "the healthy answer" — but
 * it applied that reasoning only to 2xx. A route that says the same thing with
 * a 400 was called broken.
 *
 * ⚠️ THIS FILE HAS BEEN WRONG ABOUT THESE SIX ONCE ALREADY, in the other
 * direction: *"`--doctor` told every paying customer that ALL SIX media verbs
 * were dark while the product offered and ran them."* Its own verdict on which
 * error is worse: **broken reads as "we charged you for something faulty".**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'lib', 'doctor.mjs'), 'utf8');

test('a JSON 400 that is not an auth failure is treated as healthy', () => {
  assert.match(
    src,
    /raw\.status === 400 && raw\.json && !readsAsAuthFailure\(raw\.json\.error\)/,
    'the payload-complaint 400 is no longer forgiven — six working services report broken again',
  );
});

/**
 * ⚠️ THE THREE THINGS THAT MUST STILL FAIL. Forgiving all 400s would hide the
 * defect this check exists to catch.
 */
test('401 and 403 are still refused, not forgiven', () => {
  const at400 = src.indexOf('raw.status === 400 &&');
  const at401 = src.indexOf("raw.status === 401 || raw.status === 403");
  assert.ok(at401 > 0 && at400 > 0, 'a landmark moved');
  assert.ok(at401 < at400, 'auth failures must be classified BEFORE the 400 forgiveness, or they are swallowed');
});

test('a non-JSON 400 and every 5xx stay broken', () => {
  assert.match(src, /if \(raw\.status >= 400\) return \{ kind: 'http'/, 'the general failure branch is gone');
  assert.match(
    src,
    /this may not be the service you think it is/,
    'the non-JSON branch that catches a wrong-host misconfiguration is gone',
  );
});

/**
 * ⭐ THE HONEST LIMIT, PINNED SO NOBODY MISTAKES IT FOR PROOF. The live body
 * could not be read when this was written — the network to the gateway was down
 * (HTTP 000). The change is written to be correct either way, and that reasoning
 * is recorded in the source rather than in a commit nobody reopens.
 */
test('the source records that the live body was never confirmed', () => {
  assert.match(src, /COULD NOT CONFIRM THE LIVE BODY/, 'the honesty note about the unverified probe was removed');
});
