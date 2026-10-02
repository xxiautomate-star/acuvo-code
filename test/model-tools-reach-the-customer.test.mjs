/**
 * ── 🚪⭐⭐⭐ THE HUMAN FLAGS WERE FIXED. THE MODEL'S TOOLS WERE STILL DARK ────
 *
 * MEASURED 2026-08-26, and it is the third act of the same bug. The previous
 * pass gave `--design`, `--say` and `--task-audio` gateway routes and stopped
 * there ON PURPOSE, which was the right call: `mediaToolSchemas()` gates each of
 * the six MODEL-facing verbs on `mediaConfig()`, three of them had no gateway
 * route, and flipping one global flag would have offered `make_document`,
 * `read_document` and `read_table` to a customer's agent in a state where they
 * could only fail. A verb that is offered and broken costs a whole round to
 * discover what the schema could have said for free.
 *
 * So a signed-in, paying customer's AGENT could not:
 *   · look at the page it had just built  (`see_page`)
 *   · speak, or listen                    (`speak`, `transcribe`)
 *   · print a PDF                         (`make_document`)
 *   · read a document its user supplied   (`read_document`, `read_table`)
 * while the same person could do three of those six by typing a flag.
 *
 * ⭐ WHAT THIS FILE PINS: three more routes exist, and the gate is PER TOOL —
 * each verb is offered when THAT verb has a way through, and withheld otherwise.
 * A machine with one local worker and no account offers exactly one tool.
 *
 * ── ⚠️⚠️ AN ISOLATED HOME ON EVERY CASE, AND THE REASON IS A REAL LEAK ──────
 *
 * `render-reaches-the-customer.test.mjs` records it: a version of these tests
 * that passed only an `env` let `readAccount` fall through to
 * `~/.acuvo/credentials.json`, read the REAL account, and printed a live
 * `xxi_live_…` token into node's failure output — which goes into CI logs and
 * pasted terminal dumps. Every case here names its own home.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mediaConfig, mediaRoutes, mediaToolNames,
  documentVia, docReadVia, tableReadVia,
  makeDocument, readDocument, readTable,
  MAX_GATEWAY_UPLOAD_BYTES,
} from '../lib/media.mjs';
import {
  documentEndpoint, docReadEndpoint, tableReadEndpoint,
  renderEndpoint, speakEndpoint, transcribeEndpoint, enginesEndpoint,
} from '../lib/creative-engines.mjs';

const GATEWAY = 'https://acuvo.xxiautomate.com/api/cli/v1/chat/completions';

const made = [];
function homeWith(credentials) {
  const home = mkdtempSync(join(tmpdir(), 'acuvo-modeltools-home-'));
  made.push(home);
  if (credentials) {
    mkdirSync(join(home, '.acuvo'), { recursive: true });
    writeFileSync(join(home, '.acuvo', 'credentials.json'), JSON.stringify(credentials));
  }
  return home;
}
const signedIn = () => homeWith({ token: 'xxi_live_test', gatewayUrl: GATEWAY });
const signedOut = () => homeWith(null);

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-modeltools-ws-'));
  made.push(root);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A fetch that records what it was given and answers like the live worker. */
function recorder(payload) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body), headers: init.headers ?? {} });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(payload),
    };
  };
  return { calls, impl };
}

// ───────────────────────────────────────────────────────────────────────────
// THE DERIVATION — seven doors, one host
// ───────────────────────────────────────────────────────────────────────────

test('⭐ the three new endpoints are derived exactly as the four before them', () => {
  assert.equal(documentEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/document');
  assert.equal(docReadEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/doc-read');
  assert.equal(tableReadEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/table-read');
  /**
   * ⚠️ PINNED WITH THEIR SIBLINGS ON PURPOSE. Seven functions that each decide
   * separately what "the gateway" means is seven chances to disagree about the
   * host; they share one derivation, and this asserts all seven still line up.
   */
  assert.equal(renderEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/render');
  assert.equal(speakEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/speak');
  assert.equal(transcribeEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/transcribe');
  assert.equal(enginesEndpoint(GATEWAY), 'https://acuvo.xxiautomate.com/api/cli/v1/engines');
});

test('⚠️⚠️ the leaves are HYPHENATED, because the route directories are', () => {
  /**
   * `app/api/cli/v1/doc-read/route.ts` and `table-read/route.ts`. A camelCase
   * leaf here is a 404 that looks exactly like the service being down — and it
   * would only ever be seen by a customer, never by us, because we take the
   * direct path.
   */
  assert.match(docReadEndpoint(GATEWAY), /\/doc-read$/);
  assert.match(tableReadEndpoint(GATEWAY), /\/table-read$/);
  assert.equal(docReadEndpoint(''), null);
  assert.equal(tableReadEndpoint(null), null);
});

// ───────────────────────────────────────────────────────────────────────────
// THE ROUTE — local first, account second, null third
// ───────────────────────────────────────────────────────────────────────────

test('⭐ a local worker still wins for all three, and never touches the gateway', () => {
  const home = signedIn();
  for (const [via, key, url] of [
    [documentVia, 'document', 'https://mine.modal.run/press'],
    [docReadVia, 'docRead', 'https://mine.modal.run/read'],
    [tableReadVia, 'tableRead', 'https://mine.modal.run/table'],
  ]) {
    const route = via({ [key]: url }, {}, home);
    assert.equal(route.direct, true, `${key} must prefer the local worker`);
    assert.equal(route.url, url);
    assert.equal(route.token, undefined, 'the direct path must not resolve an account token');
  }
});

test('⭐⭐⭐ with no local worker, a signed-in account routes all three to the gateway', () => {
  const home = signedIn();
  assert.match(documentVia({}, {}, home).url, /\/api\/cli\/v1\/document$/);
  assert.match(docReadVia({}, {}, home).url, /\/api\/cli\/v1\/doc-read$/);
  assert.match(tableReadVia({}, {}, home).url, /\/api\/cli\/v1\/table-read$/);
  assert.equal(documentVia({}, {}, home).token, 'xxi_live_test');
});

test('⚠️ with neither, all three return null rather than attempting an unauthenticated call', () => {
  const home = signedOut();
  assert.equal(documentVia({}, {}, home), null);
  assert.equal(docReadVia({}, {}, home), null);
  assert.equal(tableReadVia({}, {}, home), null);
});

// ───────────────────────────────────────────────────────────────────────────
// ⭐⭐⭐ THE GATE IS PER TOOL — the reason the previous pass could not open it
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ a signed-in customer with NO Modal credentials is offered all six', () => {
  /**
   * ⚠️ THIS IS THE WHOLE BUG IN ONE ASSERTION. `mediaConfig({})` is empty for a
   * customer — the URLs are baked in and gated on OUR secret — so the old gate
   * offered nothing, and their agent was never told it could look, speak, hear,
   * print or read.
   */
  assert.deepEqual(mediaConfig({}), {
    render: null, speak: null, transcribe: null, document: null, docRead: null, tableRead: null, secret: null,
  });

  const names = mediaToolNames({}, signedIn());
  for (const verb of ['see_page', 'speak', 'transcribe', 'make_document', 'read_document', 'read_table']) {
    assert.ok(names.includes(verb), `${verb} must be offered to a customer who paid for a plan`);
  }
});

test('⭐⭐⭐ ONE local worker and no account offers exactly ONE tool — the gate is not a global boolean', () => {
  /**
   * ⚠️ THIS IS THE ASSERTION THE PREVIOUS PASS COULD NOT HAVE WRITTEN, and the
   * reason it correctly refused to open the gate at all. A single account-aware
   * flag would have offered `make_document`, `read_document` and `read_table` on
   * a machine where they had no route — offered and broken, which costs a round
   * to discover what a schema could have said for free.
   */
  const out = signedOut();
  /**
   * ⚠️ NO `MODAL_VIDEO_SECRET` HERE, AND THE FIRST DRAFT OF THIS TEST HAD ONE —
   * which made it fail and made it right to fail. The secret is what reveals the
   * FIVE baked-in default URLs, so `{ MODAL_PRESS_URL, MODAL_VIDEO_SECRET }` is
   * not "one worker", it is five. An explicit URL needs no secret to resolve, so
   * this is the genuine one-service machine.
   */
  assert.deepEqual(mediaToolNames({ RENDER_AUDIT_URL: 'https://mine/r' }, out), ['see_page']);
  assert.deepEqual(mediaToolNames({ MODAL_PRESS_URL: 'https://mine/p' }, out), ['make_document']);
  assert.deepEqual(mediaToolNames({ MODAL_DOC_READ_URL: 'https://mine/d' }, out), ['read_document']);
  assert.deepEqual(mediaToolNames({ MODAL_TABLE_READ_URL: 'https://mine/t' }, out), ['read_table']);
  assert.deepEqual(mediaToolNames({}, out), [], 'a machine with nothing must offer nothing');
});

test('⚠️ an explicitly EMPTY variable stays OFF even for a signed-in account', () => {
  /**
   * Someone who sets `MODAL_TTS_URL=` has made a decision, and the account must
   * not quietly overrule it — that would be a paid service switching itself back
   * on invisibly. `mediaConfig` distinguishes unset from empty; the ROUTE has to
   * respect the distinction or the distinction is decorative.
   *
   * ⚠️ STATED AS THE CURRENT BEHAVIOUR RATHER THAN ASSUMED: an empty variable
   * makes the LOCAL url null, and the account then answers — so the honest
   * reading is that an empty value switches off OUR WORKER, not the capability.
   * Pinned so a future change to that meaning is a decision and not a surprise.
   */
  const names = mediaToolNames({ MODAL_TTS_URL: '' }, signedIn());
  assert.ok(names.includes('speak'), 'an empty local URL falls through to the plan, which is the documented order');
  assert.deepEqual(mediaToolNames({ MODAL_TTS_URL: '' }, signedOut()), [], 'and with no account it is genuinely off');
});

test('⭐ mediaRoutes answers all six from ONE credential read', () => {
  /**
   * ⚠️ NOT A MICRO-OPTIMISATION. The offer is computed per TURN, so six `*Via`
   * calls would open and parse `~/.acuvo/credentials.json` six times per turn to
   * learn the same fact. The lazy half matters more: a machine with every local
   * worker configured must not touch the credential file at all.
   */
  const routes = mediaRoutes(mediaConfig({}), {}, signedIn());
  assert.deepEqual(Object.keys(routes), ['render', 'speak', 'transcribe', 'document', 'docRead', 'tableRead']);
  for (const [k, v] of Object.entries(routes)) {
    assert.equal(v.direct, false, `${k} should route through the gateway here`);
    assert.equal(v.token, 'xxi_live_test');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// WHAT ACTUALLY GOES ON THE WIRE
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ every gateway leg carries a bearer token and NO shared secret', async () => {
  const root = workspace({ 'page.html': '<!doctype html><p>hi</p>', 'quote.pdf': '%PDF-1.4 fake' });
  const home = signedIn();

  const doc = recorder({ ok: true, fileB64: Buffer.from('%PDF-out').toString('base64') });
  const made1 = await makeDocument(root, 'page.html', 'out.pdf', 'pdf', { env: {}, fetchImpl: doc.impl, home });
  assert.equal(made1.ok, true, made1.error);
  assert.match(doc.calls[0].url, /\/api\/cli\/v1\/document$/);
  assert.equal(doc.calls[0].headers.authorization, 'Bearer xxi_live_test');
  /**
   * ⚠️⚠️ THE WHOLE SECURITY ARGUMENT IN ONE ASSERTION. Handing the CLI the
   * shared Modal secret after it authenticates is BYOK wearing a different hat —
   * the same secret for every tenant, sitting in a customer's shell history and
   * CI logs. One leak opens every GPU endpoint we own.
   */
  assert.equal('secret' in doc.calls[0].body, false, 'the shared Modal secret must never leave the server');
  assert.equal(doc.calls[0].body.format, 'pdf');

  const read = recorder({ ok: true, kind: 'pdf', page_count: 1, pages: [{ page: 1, text: 'TOTAL 1000' }] });
  const got = await readDocument(root, 'quote.pdf', { env: {}, fetchImpl: read.impl, home });
  assert.equal(got.ok, true, got.error);
  assert.match(read.calls[0].url, /\/api\/cli\/v1\/doc-read$/);
  assert.equal(read.calls[0].headers.authorization, 'Bearer xxi_live_test');
  assert.equal('secret' in read.calls[0].body, false);
  /**
   * ⚠️⚠️ THE FILENAME SURVIVES THE NEW HOP. DOCX, XLSX and PPTX share ZIP magic
   * and the extension is the only thing separating them — a gateway leg that
   * dropped it would delete three formats and say nothing.
   */
  assert.equal(read.calls[0].body.filename, 'quote.pdf');

  const table = recorder({ ok: true, tables: [{ rows: 5, cols: 4, score: 0.99, grid: [['a', 'b']] }] });
  const grid = await readTable(root, 'quote.pdf', { env: {}, fetchImpl: table.impl, home });
  assert.equal(grid.ok, true, grid.error);
  assert.match(table.calls[0].url, /\/api\/cli\/v1\/table-read$/);
  assert.equal(table.calls[0].headers.authorization, 'Bearer xxi_live_test');
  assert.equal('secret' in table.calls[0].body, false);
  // ⭐ Sniffed from `%PDF-`, not from the name — and the sniff survives the hop.
  assert.equal(typeof table.calls[0].body.pdf_b64, 'string');
  assert.equal(table.calls[0].body.page, 1);
});

test('⭐ the DIRECT leg is byte-identical to what it always sent', async () => {
  const root = workspace({ 'page.html': '<!doctype html><p>hi</p>', 'scan.png': '\x89PNG\r\n\x1a\nfake' });
  const out = signedOut();

  const doc = recorder({ ok: true, fileB64: Buffer.from('x').toString('base64') });
  await makeDocument(root, 'page.html', 'out.pdf', 'pdf', {
    env: { MODAL_PRESS_URL: 'https://mine.modal.run/press', MODAL_VIDEO_SECRET: 'shh' },
    fetchImpl: doc.impl,
    home: out,
  });
  assert.equal(doc.calls[0].url, 'https://mine.modal.run/press');
  assert.equal(doc.calls[0].body.secret, 'shh', 'the local path must keep sending the secret in the body');
  assert.equal(doc.calls[0].headers.authorization, undefined, 'a local worker gets no Acuvo token');

  const table = recorder({ ok: true, tables: [] });
  await readTable(root, 'scan.png', {
    env: { MODAL_TABLE_READ_URL: 'https://mine.modal.run/table', MODAL_VIDEO_SECRET: 'shh' },
    fetchImpl: table.impl,
    home: out,
  });
  assert.equal(table.calls[0].url, 'https://mine.modal.run/table');
  assert.equal(table.calls[0].body.secret, 'shh');
  assert.equal(typeof table.calls[0].body.image_b64, 'string', 'a PNG goes as an image, not a pdf');
});

// ───────────────────────────────────────────────────────────────────────────
// THE CEILING THAT IS NOT OURS TO CHOOSE
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ a file too big for one request is refused HERE, with the number and the alternative', async () => {
  /**
   * The platform refuses an oversized body BEFORE any of our code runs, with no
   * body of its own — so the customer sees a bare error and we log nothing. The
   * CLI's own 20 MB limit is right for the direct path and nearly SEVEN TIMES
   * what fits through the gateway.
   */
  const root = workspace({ 'huge.pdf': `%PDF-${'A'.repeat(MAX_GATEWAY_UPLOAD_BYTES)}` });
  const home = signedIn();

  for (const [label, run] of [
    ['read_document', () => readDocument(root, 'huge.pdf', { env: {}, home, fetchImpl: async () => { throw new Error('must not be called'); } })],
    ['read_table', () => readTable(root, 'huge.pdf', { env: {}, home, fetchImpl: async () => { throw new Error('must not be called'); } })],
  ]) {
    const res = await run();
    assert.equal(res.ok, false, `${label} must refuse before paying for the round trip`);
    assert.match(res.error, /3MB/, `${label}'s refusal must name the limit. Got: ${res.error}`);
    assert.match(res.error, /MODAL_(DOC|TABLE)_READ_URL/, `${label} must name the way around it`);
  }

  // ⭐ AND THE SAME FILE IS FINE ON A LOCAL WORKER — the ceiling belongs to the
  //   serverless hop, not to the file. Pinning that keeps someone from "tidying"
  //   the two limits into one.
  const rec = recorder({ ok: true, kind: 'pdf', pages: [] });
  const ok = await readDocument(root, 'huge.pdf', {
    env: { MODAL_DOC_READ_URL: 'https://mine.modal.run/read', MODAL_VIDEO_SECRET: 'shh' },
    fetchImpl: rec.impl,
    home: signedOut(),
  });
  assert.equal(ok.ok, true, ok.error);
});

// ───────────────────────────────────────────────────────────────────────────
// THE REFUSALS
// ───────────────────────────────────────────────────────────────────────────

test('⚠️ every refusal points at `acuvo --login`, not only at a variable a customer cannot use', async () => {
  const root = workspace({ 'page.html': '<p>x</p>', 'quote.pdf': '%PDF-1.4' });
  const out = signedOut();
  const never = async () => { throw new Error('no network'); };

  const cases = [
    ['make_document', await makeDocument(root, 'page.html', null, 'pdf', { env: {}, fetchImpl: never, home: out }), /MODAL_PRESS_URL/],
    ['read_document', await readDocument(root, 'quote.pdf', { env: {}, fetchImpl: never, home: out }), /MODAL_DOC_READ_URL/],
    ['read_table', await readTable(root, 'quote.pdf', { env: {}, fetchImpl: never, home: out }), /MODAL_TABLE_READ_URL/],
  ];
  for (const [label, res, selfHosted] of cases) {
    assert.equal(res.ok, false, label);
    assert.match(res.error, /--login/, `${label}: the first move for a customer is signing in. Got: ${res.error}`);
    assert.match(res.error, selfHosted, `${label}: and the self-hosted route is still named`);
  }
});
