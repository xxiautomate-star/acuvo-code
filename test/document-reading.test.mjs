/**
 * ── ⭐⭐ THE INPUT HALF — read_document · read_table ─────────────────────────
 *
 * Both services were deployed, healthy and paid for on 2026-08-12, and named by
 * nothing any client reads. This file pins the wire, and every assertion in it
 * exists because of a specific way this exact shape has failed before.
 *
 * ⚠️ THE HEADLINE ONE IS `filename`. The worker classifies by MAGIC BYTES,
 * deliberately, because a caller's filename lies — but DOCX, XLSX and PPTX are
 * all a ZIP with identical magic, and the extension is the only discriminator
 * left. Send no filename and every Office document comes back "unsupported file
 * type (zip-unknown)": the whole Office family dark, from one absent key. That
 * is the `audioB64` / `audio_b64` bug wearing different clothes, and it is why
 * the payload contract is asserted rather than assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDocument, readTable, mediaConfig, mediaToolNames } from '../lib/media.mjs';

const ENV = {
  MODAL_DOC_READ_URL: 'https://doc.example.invalid/read',
  MODAL_TABLE_READ_URL: 'https://tbl.example.invalid/extract',
  MODAL_VIDEO_SECRET: 's',
};

/** A workspace holding one file of the given bytes. */
function fixture(name, bytes) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-doc-'));
  writeFileSync(join(root, name), Buffer.from(bytes));
  return root;
}

/** A stub that records the request and replies with `body`. */
function stub(record, body) {
  return async (url, init) => {
    record.url = url;
    record.body = JSON.parse(init.body);
    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body),
    };
  };
}

/* ── 1. CONFIGURATION ────────────────────────────────────────────────────── */

test('both readers are reachable out of the box once a secret exists', () => {
  const cfg = mediaConfig({ MODAL_VIDEO_SECRET: 's' });
  assert.ok(cfg.docRead, 'read_document must work on a fresh install — the built-in URL is the whole point');
  assert.ok(cfg.tableRead, 'read_table must work on a fresh install');
});

test('⚠️ no secret means dark, not open — these are paid GPU services', () => {
  const cfg = mediaConfig({});
  assert.equal(cfg.docRead, null);
  assert.equal(cfg.tableRead, null);
});

test('⚠️ an explicit empty string is a decision, and it is honoured', () => {
  const cfg = mediaConfig({ MODAL_VIDEO_SECRET: 's', MODAL_DOC_READ_URL: '' });
  assert.equal(cfg.docRead, null, 'someone who set it empty opted out; silently reinstating ours overrides them');
  assert.ok(cfg.tableRead, 'and it must not take the sibling down with it');
});

test('neither tool is offered when its service is absent', () => {
  const names = mediaToolNames({});
  assert.ok(!names.includes('read_document'));
  assert.ok(!names.includes('read_table'));
  const live = mediaToolNames({ MODAL_VIDEO_SECRET: 's' });
  assert.ok(live.includes('read_document'), 'a configured service that is never offered is the dark-capability bug');
  assert.ok(live.includes('read_table'));
});

/* ── 2. THE PAYLOAD CONTRACT ─────────────────────────────────────────────── */

test('⚠️⚠️ read_document sends the FILENAME — without it every .docx is "zip-unknown"', async () => {
  const root = fixture('quote.docx', 'PK\x03\x04' + 'x'.repeat(60));
  const rec = {};
  try {
    await readDocument(root, 'quote.docx', { env: ENV, fetchImpl: stub(rec, { ok: true, kind: 'docx', pages: [] }) });
    assert.equal(rec.body.filename, 'quote.docx',
      `the extension is the ONLY thing separating docx/xlsx/pptx — they share ZIP magic. Sent: ${Object.keys(rec.body).join(', ')}`);
    assert.equal(typeof rec.body.file_b64, 'string');
    assert.ok(rec.body.file_b64.length > 0, 'the bytes must actually go');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the ocr mode is validated here, before a container is paid for', async () => {
  const root = fixture('a.pdf', '%PDF-1.4');
  try {
    let called = false;
    const res = await readDocument(root, 'a.pdf', {
      env: ENV, ocr: 'sometimes', fetchImpl: async () => { called = true; },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /auto, always or never/);
    assert.equal(called, false, 'a cold start to discover a typo is a spinner the user watches for nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an oversized file is refused with the number, not a 413', async () => {
  const root = fixture('big.pdf', Buffer.alloc(21 * 1024 * 1024, 0x41));
  try {
    const res = await readDocument(root, 'big.pdf', { env: ENV, fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.equal(res.ok, false);
    assert.match(res.error, /over the 20 MB limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a path outside the workspace is refused by the workspace, not by the service', async () => {
  const root = fixture('a.pdf', '%PDF-1.4');
  try {
    const res = await readDocument(root, '../../etc/passwd', { env: ENV, fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.equal(res.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 3. THE WINDOW — why a 400,000-character answer is not returned ──────── */

test('⚠️ a long document comes back one window at a time, and says where to resume', async () => {
  const root = fixture('long.pdf', '%PDF-1.4');
  const pages = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: 'x'.repeat(5_000), tables: [], ocr: false }));
  try {
    const res = await readDocument(root, 'long.pdf', {
      env: ENV, fetchImpl: stub({}, { ok: true, kind: 'pdf', page_count: 10, pages }),
    });
    assert.equal(res.ok, true);
    assert.ok(res.text.length <= 15_000, `a tool result is re-sent every round; ${res.text.length} chars is a tax on the whole session`);
    assert.ok(res.pages.length < 10, 'the window must actually stop');
    assert.equal(res.nextPage, res.pages.length + 1, 'and must name the page a second call should start from');
    assert.equal(res.pageCount, 10, 'while still saying how big the document really is');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('from_page resumes where the last window stopped', async () => {
  const root = fixture('long.pdf', '%PDF-1.4');
  const pages = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: `page ${i + 1}`, tables: [], ocr: false }));
  try {
    const res = await readDocument(root, 'long.pdf', {
      env: ENV, fromPage: 4, fetchImpl: stub({}, { ok: true, kind: 'pdf', page_count: 6, pages }),
    });
    assert.deepEqual(res.pages.map((p) => p.page), [4, 5, 6]);
    assert.equal(res.nextPage, null, 'nothing left means nothing to resume — a stale nextPage buys a wasted round');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 4. ⭐⭐ THE CROSS-SERVICE INSTRUCTION ───────────────────────────────── */

test('⭐⭐ an OCR\'d page with no grid TELLS THE MODEL that read_table exists', async () => {
  const root = fixture('scan.pdf', '%PDF-1.4');
  try {
    const res = await readDocument(root, 'scan.pdf', {
      env: ENV,
      fetchImpl: stub({}, {
        ok: true, kind: 'pdf', page_count: 1, ocr_pages: [1], notes: [],
        pages: [{ page: 1, text: 'INVOICE labour 400 parts 250 total 650', tables: [], ocr: true }],
      }),
    });
    const advice = res.notes.join(' ');
    assert.match(advice, /read_table/,
      'OCR flattens a table into a sentence: every number survives, the row-column relationship does not. '
      + '"What did we charge for labour" goes from unanswerable to CONFIDENTLY WRONG, and nothing else marks it.');
    assert.match(advice, /page 1/, 'and it must name which page, or the advice is not actionable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ the advice is withheld when a grid WAS recovered — noise trains people to ignore notes', async () => {
  const root = fixture('scan.pdf', '%PDF-1.4');
  try {
    const res = await readDocument(root, 'scan.pdf', {
      env: ENV,
      fetchImpl: stub({}, {
        ok: true, kind: 'pdf', page_count: 1, ocr_pages: [1],
        pages: [{ page: 1, text: 'INVOICE', tables: [[['item', 'cost'], ['labour', '400']]], ocr: true }],
      }),
    });
    assert.ok(!res.notes.join(' ').includes('read_table'));
    assert.equal(res.tables.length, 1, 'and the grid it did find must survive to the caller');
    assert.deepEqual(res.tables[0].rows[1], ['labour', '400']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 5. read_table — the input shape a local file actually has ───────────── */

test('⚠️⚠️ a PDF goes as pdf_b64 — the endpoint took PDFs by URL only, and a workspace file has no URL', async () => {
  const root = fixture('invoice.pdf', '%PDF-1.4 junk');
  const rec = {};
  try {
    await readTable(root, 'invoice.pdf', { env: ENV, page: 3, fetchImpl: stub(rec, { ok: true, tables: [] }) });
    assert.equal(typeof rec.body.pdf_b64, 'string', 'pdf_url is unusable from a terminal — the bytes are on disk');
    assert.equal(rec.body.page, 3, 'the page must ride with it, or every scan is read as page 1');
    assert.ok(!rec.body.image_b64, 'a PDF must not be posted as an image — PIL cannot open it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an image goes as image_b64, sniffed by magic bytes rather than by name', async () => {
  // ⚠️ Named `.pdf` ON PURPOSE. The filename is the untrustworthy signal here:
  // read_table is usually pointed at whatever read_document just struggled with.
  const root = fixture('actually-a-png.pdf', '\x89PNG\r\n\x1a\n' + 'x'.repeat(40));
  const rec = {};
  try {
    await readTable(root, 'actually-a-png.pdf', { env: ENV, fetchImpl: stub(rec, { ok: true, tables: [] }) });
    assert.equal(typeof rec.body.image_b64, 'string', 'the first five bytes are not %PDF- — the name lied');
    assert.ok(!rec.body.pdf_b64);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no table found is a successful answer that says what it looked at', async () => {
  const root = fixture('page.png', '\x89PNG\r\n\x1a\n');
  try {
    const res = await readTable(root, 'page.png', { env: ENV, fetchImpl: stub({}, { ok: true, tables: [], count: 0 }) });
    assert.equal(res.ok, true, '"there is no table here" is information, and a failure invites a pointless retry');
    assert.equal(res.count, 0);
    assert.match(res.note, /no table was detected/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a recovered grid keeps its cells, and a huge one is capped rather than dumped', async () => {
  const root = fixture('page.png', '\x89PNG\r\n\x1a\n');
  const grid = Array.from({ length: 500 }, (_, i) => [`row${i}`, `${i}`]);
  try {
    const res = await readTable(root, 'page.png', {
      env: ENV, fetchImpl: stub({}, { ok: true, count: 1, tables: [{ rows: 500, cols: 2, score: 0.98, grid }] }),
    });
    assert.deepEqual(res.tables[0].grid[0], ['row0', '0']);
    assert.equal(res.tables[0].rows, 500, 'the true size is still reported');
    assert.ok(res.tables[0].grid.length < 500, 'but 500 rows in a tool result is re-sent on every following round');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── 6. FAILURE IS PASSED THROUGH, NOT SMOOTHED ─────────────────────────── */

test('⚠️ a 200 that means failure is reported as a failure, with the service\'s own words', async () => {
  const root = fixture('a.pdf', '%PDF-1.4');
  try {
    const res = await readDocument(root, 'a.pdf', {
      env: ENV,
      fetchImpl: async () => ({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ ok: false, error: 'unauthorised' }),
      }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /unauthoris/);
    assert.match(res.error, /MODAL_VIDEO_SECRET/,
      'an error string is an instruction: "unauthorised" alone bought four retries once already');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
