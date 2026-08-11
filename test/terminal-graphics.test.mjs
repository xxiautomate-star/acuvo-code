/**
 * ⚠️ I CANNOT SEE THE PICTURE FROM HERE. This harness has no terminal, so no
 * test in this file proves an image appears on anyone's screen — and saying so
 * is the point, because twice today a capability passed every check while being
 * completely non-functional.
 *
 * What these DO prove is the part that is mechanically checkable and the part
 * that is dangerous: the escape sequences match the published protocols
 * byte-for-byte, and a terminal we do not recognise never receives them. An
 * unrecognised escape sequence does not render as nothing — it renders as
 * garbage — so the abstention is the safety property, not the feature.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectImageProtocol, kittySequence, itermSequence, renderImage } from '../lib/terminal-graphics.mjs';

const TTY = { isTTY: true };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // a PNG magic number, enough to encode

test('recognised terminals are detected, by the right protocol', () => {
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ TERM: 'xterm-kitty' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'ghostty' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ WEZTERM_PANE: '0' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ KONSOLE_VERSION: '22' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app' }, TTY), 'iterm');
});

/**
 * ⚠️ THE SAFETY TEST. Every one of these is a terminal that would print raw
 * base64 across the screen if we guessed. Windows Terminal is in this list on
 * purpose — it supports sixel, which we deliberately do not implement, and
 * assuming otherwise would corrupt the author's own console.
 */
test('unrecognised terminals get nothing — allowlist, never guesswork', () => {
  for (const env of [
    {},
    { TERM: 'xterm-256color' },
    { TERM_PROGRAM: 'vscode' },
    { WT_SESSION: 'abc' },              // Windows Terminal
    { TERM: 'screen' },
    { CI: 'true', TERM: 'dumb' },
  ]) {
    assert.equal(detectImageProtocol(env, TTY), null, JSON.stringify(env));
  }
});

/**
 * ⚠️ THE ONE THAT WOULD BREAK A SCRIPT. `acuvo --json | jq` must never receive
 * image bytes: it would not merely look wrong, it would break the parse. Being
 * ON kitty is irrelevant when stdout is a pipe.
 */
test('a non-TTY never receives image bytes, even on a supported terminal', () => {
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1' }, { isTTY: false }), null);
});

test('the off switch beats every detection, and beats the on switch', () => {
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1', ACUVO_INLINE_IMAGES: '0' }, TTY), null);
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: 'off', TERM_PROGRAM: 'iTerm.app' }, TTY), null);
});

test('the on switch enables an unknown terminal, and overrides the TTY check', () => {
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: '1' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: '1' }, { isTTY: false }), 'kitty');
});

test('kitty: a small image is one sequence, correctly framed', () => {
  const s = kittySequence(PNG);
  assert.ok(s.startsWith('\x1b_Ga=T,f=100;'), 'must be transmit-and-display, PNG format');
  assert.ok(s.endsWith('\x1b\\'), 'must terminate with ST');
  assert.equal(s.slice('\x1b_Ga=T,f=100;'.length, -2), PNG.toString('base64'));
});

/**
 * ⚠️ CHUNKING IS THE SPEC, NOT A PREFERENCE, and getting it wrong fails
 * SILENTLY — the terminal drops the sequence and shows nothing at all, which is
 * indistinguishable from "unsupported".
 */
test('kitty: a large image is chunked at 4096, m=1 until the last which is m=0', () => {
  const big = Buffer.alloc(9000, 7);
  const s = kittySequence(big);
  const chunks = s.split('\x1b\\').filter(Boolean);
  assert.ok(chunks.length > 2, `expected several chunks, got ${chunks.length}`);

  // Control keys on the first chunk only; continuations carry just `m`.
  assert.match(chunks[0], /^\x1b_Ga=T,f=100,m=1;/);
  for (const c of chunks.slice(1, -1)) assert.match(c, /^\x1b_Gm=1;/);
  assert.match(chunks[chunks.length - 1], /^\x1b_Gm=0;/);

  // No payload may exceed the buffer limit, and the whole image must survive.
  const payloads = chunks.map((c) => c.slice(c.indexOf(';') + 1));
  for (const p of payloads) assert.ok(p.length <= 4096, `chunk of ${p.length} exceeds 4096`);
  assert.equal(payloads.join(''), big.toString('base64'), 'the image must round-trip exactly');
});

test('iterm: size is the DECODED byte length, not the base64 length', () => {
  const s = itermSequence(PNG);
  assert.match(s, new RegExp(`size=${PNG.length}(;|:)`));
  assert.ok(s.startsWith('\x1b]1337;File='));
  assert.ok(s.endsWith('\x07'));
  assert.ok(s.includes(PNG.toString('base64')));
  assert.match(s, /inline=1/);
});

test('renderImage stays silent on a terminal that cannot show it', () => {
  const r = renderImage('/whatever.png', { env: {}, isTTY: true, readImpl: () => PNG });
  assert.equal(r.shown, false);
  assert.equal(r.text, null);
});

test('renderImage never throws when the file is missing', () => {
  const r = renderImage('/gone.png', {
    env: { KITTY_WINDOW_ID: '1' },
    isTTY: true,
    readImpl: () => { throw new Error('ENOENT'); },
  });
  assert.equal(r.shown, false);
});

/**
 * ⚠️ A 4K screenshot is megabytes of base64 through a pty one byte at a time.
 * It stalls the session and scrolls everything useful away — so the ceiling
 * declines and SAYS it declined, rather than appearing to do nothing.
 */
test('an oversized image declines out loud rather than hanging the terminal', () => {
  const r = renderImage('/big.png', {
    env: { KITTY_WINDOW_ID: '1' },
    isTTY: true,
    readImpl: () => Buffer.alloc(2_000_000, 1),
  });
  assert.equal(r.shown, false);
  assert.match(r.text, /too large to show inline/);
  assert.match(r.text, /KB/);
});

test('a shown image ends with a newline, or the next line lands on top of it', () => {
  const r = renderImage('/ok.png', { env: { KITTY_WINDOW_ID: '1' }, isTTY: true, readImpl: () => PNG });
  assert.equal(r.shown, true);
  assert.ok(r.text.endsWith('\n'));
});
