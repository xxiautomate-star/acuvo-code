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

/**
 * A real, complete 2×2 PNG — red row over blue row, 75 bytes. Written by the
 * chunk writer in `test/sixel-encode.test.mjs` and pasted here as a constant so
 * this file needs no image library, no fixture on disk and no generator: the
 * sixel path has to DECODE its input, so the magic number above is not enough
 * for it the way it is for kitty and iTerm2.
 */
const REAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000002000000020806000000'
  + '72b60d240000001249444154789c63f8cfc0f01f8419a0f47f0043ce07'
  + 'f9fa814afd0000000049454e44ae426082',
  'hex',
);

test('recognised terminals are detected, by the right protocol', () => {
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ TERM: 'xterm-kitty' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'ghostty' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ WEZTERM_PANE: '0' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ KONSOLE_VERSION: '22' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app' }, TTY), 'iterm');
});

/**
 * ── ⚠️ THIS ASSERTION USED TO SAY THE OPPOSITE, DELIBERATELY ────────────────
 *
 * Until 2026-08-25 the safety test above listed `{ WT_SESSION: 'abc' }` among
 * the terminals that must get NOTHING, with the comment "it supports sixel,
 * which we deliberately do not implement, and assuming otherwise would corrupt
 * the author's own console". Sixel is now implemented, so the old contract is
 * inverted rather than deleted — the reason it existed is still the reason this
 * one has to be right.
 *
 * ⭐ WHAT CHANGED IS NOT JUST "WE ADDED A FEATURE". Sixel travels inside a DCS
 * string, and a VT-conformant parser that does not implement it still swallows
 * the payload instead of printing it. That is why an env var is now enough
 * evidence for Windows Terminal, where it never was for kitty's APC protocol.
 * The legacy Windows console does not set WT_SESSION, so it is untouched.
 */
test('sixel terminals are detected — the list that used to be the forbidden list', () => {
  assert.equal(detectImageProtocol({ WT_SESSION: 'abc' }, TTY), 'sixel', 'Windows Terminal ≥ 1.22');
  assert.equal(detectImageProtocol({ MLTERM: '3.9.3' }, TTY), 'sixel');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'mintty' }, TTY), 'sixel');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'contour' }, TTY), 'sixel');
  assert.equal(detectImageProtocol({ TERM: 'foot-extra' }, TTY), 'sixel');
  assert.equal(detectImageProtocol({ TERM: 'xterm-256color-sixel' }, TTY), 'sixel');
});

/**
 * ⚠️ THE SAFETY TEST. Every one of these is a terminal that would print raw
 * escape data across the screen if we guessed.
 */
test('unrecognised terminals get nothing — allowlist, never guesswork', () => {
  for (const env of [
    {},
    { TERM: 'xterm-256color' },
    { TERM_PROGRAM: 'vscode' },       // sixel exists but is off by default
    { TERM: 'screen' },
    { CI: 'true', TERM: 'dumb' },
  ]) {
    assert.equal(detectImageProtocol(env, TTY), null, JSON.stringify(env));
  }
});

/**
 * ⚠️⚠️ A MULTIPLEXER IS A TERMINAL THAT REWRITES YOUR ESCAPE SEQUENCES, and it
 * is the one case where being right about the OUTER terminal is worse than
 * knowing nothing: tmux and screen sit in the stream and forward what they
 * understand, so an image payload they do not understand lands on the screen as
 * text. Every entry here is a genuinely capable terminal that must still be
 * refused.
 */
test('a multiplexer beats the allowlist — the outer terminal is not who receives this', () => {
  assert.equal(detectImageProtocol({ WT_SESSION: 'abc', TMUX: '/tmp/tmux-1000/default,1,0' }, TTY), null);
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1', TERM: 'screen.xterm-kitty' }, TTY), null);
  assert.equal(detectImageProtocol({ ITERM_SESSION_ID: 'w0', TERM: 'tmux-256color' }, TTY), null);
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

/**
 * ⭐ NAMING A PROTOCOL IS THE ESCAPE HATCH FOR EVERY TERMINAL WE GOT WRONG.
 * The allowlist will always be behind reality — a terminal ships sixel on a
 * Tuesday and our env sniffing learns about it whenever someone tells us. One
 * env var means a user never has to wait for a release, and it costs nothing:
 * `0` still beats it, so nobody can be trapped in a garbled session.
 */
test('a named protocol wins over detection, on any terminal', () => {
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: 'sixel' }, TTY), 'sixel');
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: 'SIXEL' }, TTY), 'sixel', 'case is not a trap');
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: 'kitty', WT_SESSION: 'x' }, TTY), 'kitty');
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: 'iterm' }, { isTTY: false }), 'iterm');
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: 'sixel', TMUX: '1' }, TTY), 'sixel', 'explicit beats the tmux guard');
  assert.equal(detectImageProtocol({ ACUVO_INLINE_IMAGES: 'nonsense' }, TTY), null, 'a typo must not enable anything');
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

/* ── sixel, which is the whole point of Windows Terminal ────────────────────── */

/**
 * ⭐ THE END-TO-END REACH TEST. Not "does the encoder work" — that is the other
 * file — but "does the function the CLI already calls now produce pixels on
 * Roman's own terminal". Before today this exact call returned `{shown: false}`
 * on his machine and the CLI printed a file path.
 */
test('on Windows Terminal, a real PNG comes back as sixel data, not silence', () => {
  const r = renderImage('/shot.png', { env: { WT_SESSION: 'abc' }, isTTY: true, readImpl: () => REAL_PNG });
  assert.equal(r.shown, true);
  assert.ok(r.text.startsWith('\x1bP0;1;q'), 'DCS introducer, background-select 1');
  assert.ok(r.text.endsWith('\x1b\\\n'), 'ST, then a newline so output does not land on the image');
  assert.match(r.text, /"1;1;2;2/, 'raster attributes carry the real image size');
});

/**
 * ⚠️ THE DEGRADE. A JPEG, an interlaced PNG, or a file that is not an image at
 * all must leave no trace — the caller has already printed the path, and a
 * complaint about a feature the user never asked for is worse than nothing.
 */
test('a file the sixel path cannot decode degrades to silence, not to garbage', () => {
  for (const bytes of [PNG, Buffer.from('\xff\xd8\xff\xe0 JFIF', 'latin1'), Buffer.alloc(0)]) {
    const r = renderImage('/x.png', { env: { WT_SESSION: 'abc' }, isTTY: true, readImpl: () => bytes });
    assert.equal(r.shown, false);
    assert.equal(r.text, null);
  }
});

test('sixel respects the off switch and the pipe, exactly like the other two', () => {
  assert.equal(renderImage('/x.png', {
    env: { WT_SESSION: 'abc', ACUVO_INLINE_IMAGES: '0' }, isTTY: true, readImpl: () => REAL_PNG,
  }).shown, false);
  assert.equal(renderImage('/x.png', {
    env: { WT_SESSION: 'abc' }, isTTY: false, readImpl: () => REAL_PNG,
  }).shown, false);
});

/**
 * ⚠️ THE SOURCE CEILING IS HIGHER FOR SIXEL THAN FOR KITTY, ON PURPOSE. kitty
 * ships the file itself, so a big file IS a big transfer; sixel re-encodes from
 * downscaled pixels, so a big PNG is usually a small sequence. Sharing one
 * ceiling would decline images we could comfortably draw.
 */
test('an oversized source still declines out loud on the sixel path', () => {
  const r = renderImage('/huge.png', {
    env: { WT_SESSION: 'abc' },
    isTTY: true,
    readImpl: () => Buffer.alloc(9_000_000, 1),
  });
  assert.equal(r.shown, false);
  assert.match(r.text, /too large to show inline/);

  // …and a 2MB file, which kitty refuses, is still fair game here.
  assert.equal(renderImage('/mid.png', {
    env: { WT_SESSION: 'abc' },
    isTTY: true,
    readImpl: () => Buffer.alloc(2_000_000, 1),
  }).text, null, 'undecodable, but NOT refused for size');
});
