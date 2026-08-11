/**
 * ── ⚠️ FOUR WAYS THE MODEL CALL BETRAYED THE PERSON RUNNING IT ───────────────
 *
 * Every case here was reproduced against the shipped code before it was fixed,
 * and every one of them is invisible from inside a working network on a funded
 * key — which is exactly why they survived.
 *
 *   A. THE KEY LEAK. A corporate proxy or an API gateway routinely echoes the
 *      offending request back in its error page. `classifyHttpFailure` printed
 *      that body verbatim, so the key landed in terminal scrollback, in CI job
 *      logs, and in whatever the user pastes into a bug report. The test asserts
 *      the SECRET is absent rather than asserting a particular replacement
 *      string, because the guarantee is "the key does not survive", not "the
 *      word redacted appears".
 *
 *   B. THE CRASH THAT LOSES THE SESSION. `collectStream` was awaited outside any
 *      try/catch, so a mid-stream drop escaped as undici's `TypeError:
 *      terminated`, past turn.mjs's deliberate "a mid-loop model failure is not a
 *      whole-session failure" handling, and out of main(). Under `--json` that
 *      means an EMPTY stdout: the summary is gone, including the file round 1
 *      already wrote to disk. A transport fault must be a value, not an
 *      exception — `callModel`'s contract says it never throws.
 *
 *   C. A VALID 200 TREATED AS FAILURE. The whole-body fallback was gated on
 *      `!res.body`, and undici ALWAYS populates `res.body` on a body-bearing
 *      response — so the branch could never run despite its comment. A provider
 *      that ignored `stream:true` and answered with plain JSON was reported as
 *      "the stream closed without sending anything", which `isRetryable` does not
 *      match, so the chain stopped on a PAID, correct completion.
 *
 *   D. EVERY TRANSPORT FAULT SAID THE SAME THING. Node's fetch always rejects
 *      with the literal message `fetch failed`; the cause code is the only place
 *      the actual fault lives. DNS, refused, TLS-MITM and a captive portal all
 *      printed one identical sentence.
 *
 * ⚠️ THE PREFIX 'Could not reach OpenRouter' IS LOAD-BEARING, not prose.
 * `lib/chain.mjs:81` decides retryability by matching that text. The last test
 * here exists solely so a future rewording cannot silently disable fallback.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyHttpFailure, describeTransportError, callModel } from '../lib/model.mjs';

/** A response object shaped like the parts of `Response` that callModel touches. */
function fakeRes({ status = 200, contentType = null, body = undefined, json = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    body,
    json: async () => {
      if (typeof json === 'function') return json();
      return json;
    },
    text: async () => '',
  };
}

/** An SSE stream that dies partway, the way a dropped socket does. */
async function* droppedStream() {
  yield 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  const err = new TypeError('terminated');
  err.cause = { code: 'UND_ERR_SOCKET' };
  throw err;
}

/** A well-formed SSE stream. */
async function* goodStream() {
  yield 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
  yield 'data: [DONE]\n\n';
}

/**
 * What a provider that IGNORED `stream:true` actually puts on the wire: one
 * whole JSON document. `parseSse` finds no `data:` lines in it, so the old code
 * reported "the stream closed without sending anything" — a phrase `isRetryable`
 * does not match — and threw away a completion that had already been billed.
 */
const WHOLE_BODY = JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
async function* jsonBodyStream() {
  yield WHOLE_BODY;
}

const CALL = {
  apiKey: 'sk-or-v1-TESTKEYTESTKEYTEST',
  model: 'test/model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

// ── A. THE KEY LEAK ──────────────────────────────────────────────────────────

test('A: classifyHttpFailure does not print an sk-or-v1 key echoed by a proxy', () => {
  const out = classifyHttpFailure(407, 'proxy denied\nauthorization: Bearer sk-or-v1-SECRETCANARY99887766');
  assert.ok(!out.includes('sk-or-v1-S'), `key survived:\n${out}`);
  assert.ok(!out.includes('SECRETCANARY'), `key survived:\n${out}`);
  assert.ok(out.includes('HTTP 407'), 'the status must still be reported');
});

test('A: a key straddling the 400-char cut cannot survive in halves', () => {
  // The key starts at char 380, so a slice-THEN-redact leaves 'sk-or-v1-STRADDLECA'
  // in the output: the prefix regex no longer matches the truncated remnant, and
  // twenty characters of a live secret are printed. Redaction must run FIRST.
  const filler = 'x'.repeat(380);
  const body = `${filler}sk-or-v1-STRADDLECANARY1234567890abcdef`;
  const out = classifyHttpFailure(500, body);
  assert.ok(!out.includes('sk-or-v1'), `a key fragment survived:\n${out.slice(-140)}`);
  assert.ok(!out.includes('STRADDLE'), `a key fragment survived:\n${out.slice(-140)}`);
});

test('A: the key is stripped from the JSON error.message path too', () => {
  const body = JSON.stringify({ error: { message: 'invalid key sk-or-v1-JSONCANARY0011223344' } });
  const out = classifyHttpFailure(401, body);
  assert.ok(!out.includes('JSONCANARY'), `key survived the apiMessage path:\n${out}`);
});

test('A: a bare provider key (x-api-key header) is stripped as well', () => {
  const out = classifyHttpFailure(403, 'x-api-key: sk-ABCDEFGHIJKLMNOPQRSTUVWX\nrejected');
  assert.ok(!out.includes('ABCDEFGHIJKLMNOP'), `bare key survived:\n${out}`);
  assert.ok(out.includes('rejected'), 'the rest of the body is still useful and must remain');
});

// ── B. THE MID-STREAM DROP ───────────────────────────────────────────────────

test('B: a mid-stream connection drop is a returned failure, never a throw', async () => {
  const fetchImpl = async () => fakeRes({ contentType: 'text/event-stream', body: droppedStream() });
  const r = await callModel({ ...CALL, onText: () => {}, fetchImpl });
  assert.equal(r.ok, false);
  // Must be phrased so chain.mjs's isRetryable matches it — otherwise the chain
  // stops dead on a fault that a second provider would sail through.
  assert.match(r.error, /Could not reach OpenRouter/);
});

// ── C. A VALID NON-SSE 200 ───────────────────────────────────────────────────

test('C: a 200 that is JSON, not an event stream, is read as a completion', async () => {
  const fetchImpl = async () => fakeRes({
    contentType: 'application/json',
    // undici ALWAYS sets .body — the old gate `!res.body` could never fire.
    body: jsonBodyStream(),
    json: JSON.parse(WHOLE_BODY),
  });
  const r = await callModel({ ...CALL, onText: () => {}, fetchImpl });
  assert.equal(r.ok, true, `a valid paid completion was rejected: ${r.error}`);
  assert.equal(r.content, 'ok');
});

test('C: with NO content-type the stream path still runs (no guessing)', async () => {
  const fetchImpl = async () => fakeRes({ contentType: null, body: goodStream() });
  const r = await callModel({ ...CALL, onText: () => {}, fetchImpl });
  assert.equal(r.ok, true, `the absent-content-type case must keep today's behaviour: ${r.error}`);
  assert.equal(r.content, 'hello');
});

// ── D. NAMING THE TRANSPORT FAULT ────────────────────────────────────────────

test('D: ECONNREFUSED is named, and the retry-matching prefix is kept', () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNREFUSED' };
  const out = describeTransportError(err, 180_000);
  assert.ok(out.startsWith('Could not reach OpenRouter'), `prefix changed — chain.mjs retry breaks:\n${out}`);
  assert.match(out, /ECONNREFUSED/);
});

test('D: DNS, TLS and timeout each say something different', () => {
  const of = (code) => {
    const e = new TypeError('fetch failed');
    e.cause = { code };
    return describeTransportError(e, 180_000);
  };
  const dns = of('ENOTFOUND');
  const tls = of('DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.match(dns, /ENOTFOUND/);
  assert.match(dns, /DNS|resolve/i);
  assert.match(tls, /NODE_EXTRA_CA_CERTS/, 'the TLS case must name the fix that was verified to work');
  assert.notEqual(dns, tls, 'two different faults must not print identical text');
});

test('D: the internal monorepo captive-portal note does not ship to strangers', () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNRESET' };
  const out = describeTransportError(err, 180_000);
  assert.ok(!/this repo/i.test(out), `internal context leaked to the user:\n${out}`);
});
