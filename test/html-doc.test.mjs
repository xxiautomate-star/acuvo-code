/**
 * ── THE DOCUMENT SHELL — THE TWO THINGS THAT SILENTLY BREAK A PAGE ──────────
 *
 * `html-doc.mjs` exists so `chart` and `syndicate` cannot ship two escapers that
 * drift. These tests are therefore about the ESCAPING and the SELF-CONTAINMENT,
 * not about how the page looks.
 *
 * ⭐ The `jsonForScript` cases are the important ones and they are not
 * hypothetical: a CSV cell, a blog heading and a social post are all text that
 * arrived from a file or a model, and `</script>` inside any of them ends the
 * script element before the JavaScript parser ever runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, escapeAttr, jsonForScript, htmlDocument, BASE_CSS, seriesColour } from '../lib/html-doc.mjs';

test('escapeHtml neutralises all five markup characters, ampersand first', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  // ⚠️ If `&` were escaped last, `<` would become `&amp;lt;` and render as text.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});

test('escapeAttr closes an attribute-injection', () => {
  const attr = escapeAttr('" onmouseover="alert(1)');
  assert.ok(!attr.includes('"'), `a raw double quote survived: ${attr}`);
});

test('⭐⭐ jsonForScript escapes the sequence that ends a script element', () => {
  const out = jsonForScript({ note: 'end</script><img src=x onerror=alert(1)>' });
  assert.ok(!out.includes('</script'), 'the raw close-tag sequence survived into the script body');
  assert.ok(!out.includes('<'), 'a raw < survived; the tokenizer can still be steered');
  // ⭐ AND THE DATA IS UNCHANGED — escaping that alters the value is corruption.
  assert.equal(JSON.parse(out).note, 'end</script><img src=x onerror=alert(1)>');
});

test('⭐ jsonForScript escapes U+2028/U+2029, which are JSON-legal and JS-illegal', () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const out = jsonForScript({ a: `x${LS}y${PS}z` });
  assert.ok(!out.includes(LS) && !out.includes(PS), 'a raw line separator survived into a JS string literal');
  assert.equal(JSON.parse(out).a, `x${LS}y${PS}z`);
  /**
   * ⚠️ THE STRONGEST FORM OF THIS ASSERTION: the escaped text must actually be
   * evaluable as JavaScript. A ` ` inside a raw string literal is a syntax
   * error, so this line fails loudly if the escape ever regresses to a no-op.
   */
  // eslint-disable-next-line no-new-func
  const value = new Function(`return ${out};`)();
  assert.equal(value.a, `x${LS}y${PS}z`);
});

test('⚠️⚠️ the document loads NOTHING from the network — the CSP and file:// both require it', () => {
  const html = htmlDocument({ title: 'T', body: '<p>hi</p>', js: 'void 0;' });
  assert.ok(html.startsWith('<!doctype html>'));
  // No remote scheme, no protocol-relative URL, no import, no fetch.
  assert.ok(!/https?:\/\//i.test(html), 'the document references an http(s) URL');
  assert.ok(!/\ssrc=/i.test(html), 'the document has a src= attribute, which can only point outward');
  assert.ok(!/@import/i.test(html), 'the stylesheet imports another stylesheet');
  assert.ok(!/<link\b/i.test(html), 'the document has a <link>, which is an external stylesheet or font');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(html), 'the page makes a network call');
});

test('the title is escaped in both the tag and the description meta', () => {
  const html = htmlDocument({ title: '</title><script>bad()</script>', body: '', description: '" onload="x' });
  assert.ok(!html.includes('<script>bad()'), 'the title escaped out of its element');
  assert.ok(html.includes('&lt;/title&gt;'));
  assert.ok(!/content="" onload=/.test(html), 'the description escaped its attribute');
});

test('both colour schemes are styled, and the toggle can override either way', () => {
  assert.ok(BASE_CSS.includes('prefers-color-scheme:dark'), 'no dark-mode media query');
  assert.ok(BASE_CSS.includes(':root[data-theme="dark"]'), 'the toggle cannot force dark');
  assert.ok(BASE_CSS.includes(':root[data-theme="light"]'), 'the toggle cannot force light');
  assert.ok(!/@font-face|fonts\.googleapis/.test(BASE_CSS), 'a webfont is a network request');
});

test('the series palette wraps rather than returning undefined', () => {
  assert.equal(seriesColour(0), seriesColour(6));
  assert.ok(seriesColour(97).startsWith('var(--s'));
  assert.ok(seriesColour(-1).startsWith('var(--s'), 'a negative index produced undefined');
});
