/**
 * One HTML file with N slide sections is sent to the press as N pages. Found
 * by using it: a 6-slide deck came back from make_document as ONE slide.
 * See lib/document-pages.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitSlides } from '../lib/document-pages.mjs';
import { makeDocument } from '../lib/media.mjs';

const DECK = `<!doctype html><html><head><style>.slide{width:1280px;height:720px}</style></head><body>
<section class="slide"><h1>One</h1><section class="inner">nested</section></section>
<section class="slide title"><h1>Two</h1></section>
<div data-slide><h1>Three</h1></div>
</body></html>`;

test('top-level slides split into self-contained pages, nested sections stay inside', () => {
  const pages = splitSlides(DECK);
  assert.equal(pages.length, 3);
  for (const p of pages) assert.match(p, /<style>\.slide\{width:1280px/, 'every page keeps the head');
  assert.match(pages[0], /nested/);
  assert.doesNotMatch(pages[0], /Two/);
  assert.match(pages[2], /Three/);
});

test('a document without two slides, or an unbalanced one, is sent whole', () => {
  assert.equal(splitSlides('<html><body><section class="slide">only</section></body></html>'), null);
  assert.equal(splitSlides('<html><body><h1>a report</h1><section>x</section><section>y</section></body></html>'), null);
  assert.equal(splitSlides('<html><body><section class="slide">a<section class="slide">b</section></body></html>'), null);
});

test('make_document sends html AND pages, and says when the pages did not survive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-docpages-'));
  writeFileSync(join(root, 'deck.html'), DECK);
  let sent = null;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, file_b64: Buffer.from('PK').toString('base64'), pages: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await makeDocument(root, 'deck.html', 'deck.pptx', 'pptx', {
      env: { MODAL_PRESS_URL: 'https://press.example.test/', MODAL_VIDEO_SECRET: 's' }, fetchImpl, home: root,
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(sent.pages.length, 3);
    assert.equal(typeof sent.html, 'string', 'html still travels for a server that predates pages');
    assert.equal(r.pages, 1);
    assert.match(r.warning, /sent 3 slides but the document service made 1/);
    assert.equal(readFileSync(join(root, 'deck.pptx'), 'utf8'), 'PK');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a wrapper named "slides" or a "slide-title" is not a slide; the sections inside it are', () => {
  const doc = '<html><head></head><body><div class="slides deck"><section class="slide"><h1 class="slide-title">A</h1></section>'
    + '<section class="slide"><div class="slide-body">B</div></section></div></body></html>';
  const pages = splitSlides(doc);
  assert.equal(pages?.length, 2);
  assert.match(pages[1], /slide-body">B/);
});
