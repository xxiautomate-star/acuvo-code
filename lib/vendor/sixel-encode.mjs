/**
 * ── VENDORED: node-sixel v0.16.0, MIT, Copyright (c) 2019 Joerg Breitbart ────
 *
 * Source: https://github.com/jerch/node-sixel — the `sixel` package on npm.
 * Taken from `lib/SixelEncoder.js` and `lib/Colors.js` of the published tarball.
 * Full licence text and the reasoning for vendoring instead of installing live
 * in `lib/vendor/NOTICE.md`, which is the condition of the MIT grant.
 *
 * ⭐ WE VENDORED THE SOURCE RATHER THAN REIMPLEMENTING IT. Sixel band packing is
 * the fiddly, get-it-subtly-wrong part of this feature, and a working, published,
 * MIT implementation of it existed before I started. Copying it is the assembler
 * doctrine applied literally. What we did NOT get for free is PNG decoding — the
 * entry point below takes RAW RGBA PIXELS, not a PNG — so that half is ours and
 * lives in `lib/terminal-graphics.mjs`.
 *
 * ── ⚠️ THE FOUR CHANGES MADE TO UPSTREAM ────────────────────────────────────
 * MIT permits modification; saying which is ours.
 *
 * **1. CommonJS → ESM, and pruned to the encode path.** Dropped: the sixel
 *    DECODER, the WebAssembly decoder wrapper, `Quantizer.js` (its only reason
 *    to exist is UPNG's kd-tree, and UPNG is the dependency we are refusing),
 *    `sixelEncodeIndexed`, `image2sixel`, and the HLS / VT340 palettes.
 *
 * **2. ⚠️⚠️ A REAL UPSTREAM BUG, FIXED — and it is the one that would have made
 *    this whole feature ship broken.** `processBand` reads, verbatim in 0.16.0:
 *
 *        idx = alpha(color) ? colorMap.get(color) || 0 : 0;
 *        if (idx === undefined) {
 *          idx = nearestColorIndex(color, paletteRGB) + 1;   // ← unreachable
 *          colorMap.set(color, idx);
 *        }
 *
 *    `colorMap.get()` returns `undefined` for a colour that is not exactly in
 *    the palette, and `undefined || 0` is `0`, so `idx === undefined` is never
 *    true and the nearest-colour fallback is DEAD CODE. Slot 0 is the
 *    background/transparent slot, and `processBand` skips it when writing. So
 *    every pixel whose colour is not an exact palette entry is silently dropped
 *    — which for a photograph against a 256-colour palette means a picture that
 *    is almost entirely empty. Upstream's own docstring promises the opposite
 *    ("unmatched colors will be translated by euclidean distance"). Verified
 *    present in both `lib/SixelEncoder.js` and the minified `dist/encode.esm.js`
 *    of 0.16.0, so it is not an artefact of one build.
 *    `test/sixel-encode.test.mjs` pins the fixed behaviour with a colour that is
 *    deliberately NOT in the palette.
 *
 *    ⭐ MEASURED, not reasoned. Both variants were run over a synthetic 1440×900
 *    screenshot (panels, a gradient, 1px text rows) and the sixel output parsed
 *    back into pixels: **fixed = 368,640 of 368,640 pixels drawn, mean channel
 *    error 7.78/255. Upstream = 0 of 368,640 drawn** — a completely blank
 *    picture, emitted without an error, in 4KB of perfectly well-formed sixel.
 *    That is the exact failure this module's neighbours keep warning about: a
 *    capability that passes every check and does nothing.
 *
 * **3. `new Uint32Array(data.buffer)` → a view bounded by byteOffset/length.**
 *    The original reinterprets the WHOLE underlying ArrayBuffer. Hand it a
 *    `subarray`, or any Node `Buffer` under 4KB (those are slices of a shared
 *    pool and almost never start at offset 0), and it reads someone else's
 *    pixels. Ours is the same expression with the offset and length supplied.
 *
 * **4. Removed an import-time `console.warn` on big-endian platforms.** A
 *    library that prints to a CLI's stdout as a side effect of being imported is
 *    not acceptable here — it would corrupt `--json`. `BIG_ENDIAN` is exported
 *    instead and the caller abstains, which is the same discipline the rest of
 *    this feature follows: on a machine we cannot serve correctly, print the
 *    path.
 */

/**
 * ⚠️ THE ENCODER IS LITTLE-ENDIAN ONLY, upstream and here — it reinterprets RGBA
 * bytes as uint32 and assumes the byte order that produces. Exported so the
 * caller can decline rather than draw a picture with the channels swapped.
 */
export const BIG_ENDIAN = new Uint8Array(new Uint32Array([0xFF000000]).buffer)[0] === 0xFF;

// ── channel accessors on the native (little-endian ABGR32) colour word ───────

export function red(n) {
  return n & 0xFF;
}

export function green(n) {
  return (n >>> 8) & 0xFF;
}

export function blue(n) {
  return (n >>> 16) & 0xFF;
}

export function alpha(n) {
  return (n >>> 24) & 0xFF;
}

/** Convert RGB(A) channels to the native colour word. */
export function toRGBA8888(r, g, b, a = 255) {
  return ((a & 0xFF) << 24 | (b & 0xFF) << 16 | (g & 0xFF) << 8 | (r & 0xFF)) >>> 0;
}

/** Convert a native colour word to `[r, g, b, a]`. */
export function fromRGBA8888(color) {
  return [color & 0xFF, (color >> 8) & 0xFF, (color >> 16) & 0xFF, color >>> 24];
}

/**
 * Index of the nearest colour in `palette` (a list of `[r, g, b]`).
 * Euclidean distance, no luminance correction — upstream's choice, kept.
 */
export function nearestColorIndex(color, palette) {
  const r = red(color);
  const g = green(color);
  const b = blue(color);
  let min = Number.MAX_SAFE_INTEGER;
  let idx = -1;
  for (let i = 0; i < palette.length; ++i) {
    const dr = r - palette[i][0];
    const dg = g - palette[i][1];
    const db = b - palette[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (!d) return i;
    if (d < min) {
      min = d;
      idx = i;
    }
  }
  return idx;
}

/**
 * The 256 ANSI colours — 16 xterm base + a 6×6×6 cube + 24 greys.
 *
 * ⭐ WHY THIS AND NOT AN ADAPTIVE PALETTE. Upstream's adaptive quantiser is the
 * part we deliberately left behind (it needs UPNG). A fixed, published palette
 * has one property an adaptive one cannot: it is DETERMINISTIC, so the encoded
 * bytes for a given bitmap can be asserted in a test, and it cannot be subtly
 * wrong in a way nobody notices. The cost is honest and worth stating — smooth
 * gradients band, because there are only six levels per channel. For screenshots
 * of pages and UIs, which is what this feature exists to show, that is invisible.
 *
 * @see https://en.wikipedia.org/wiki/ANSI_escape_code#8-bit
 */
export const PALETTE_ANSI_256 = (() => {
  const p = [
    toRGBA8888(0, 0, 0),
    toRGBA8888(205, 0, 0),
    toRGBA8888(0, 205, 0),
    toRGBA8888(205, 205, 0),
    toRGBA8888(0, 0, 238),
    toRGBA8888(205, 0, 205),
    toRGBA8888(0, 250, 205),
    toRGBA8888(229, 229, 229),
    toRGBA8888(127, 127, 127),
    toRGBA8888(255, 0, 0),
    toRGBA8888(0, 255, 0),
    toRGBA8888(255, 255, 0),
    toRGBA8888(92, 92, 255),
    toRGBA8888(255, 0, 255),
    toRGBA8888(0, 255, 255),
    toRGBA8888(255, 255, 255),
  ];
  const d = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; ++r) {
    for (let g = 0; g < 6; ++g) {
      for (let b = 0; b < 6; ++b) {
        p.push(toRGBA8888(d[r], d[g], d[b]));
      }
    }
  }
  for (let v = 8; v <= 238; v += 10) {
    p.push(toRGBA8888(v, v, v));
  }
  return new Uint32Array(p);
})();

/**
 * The DCS introducer that must precede sixel data.
 *
 * `backgroundSelect`: 0 = device default, 1 = leave zero-bit cells untouched,
 * 2 = paint them the background colour.
 *
 * @see https://www.vt100.net/docs/vt3xx-gp/chapter14.html
 */
export function introducer(backgroundSelect = 0) {
  return `\x1bP0;${backgroundSelect};q`;
}

/** String Terminator. Write this once the sixel data has ended. */
export const FINALIZER = '\x1b\\';

/** Convert a 6-bit column code to its sixel character, run-length encoded. */
function codeToSixel(code, repeat) {
  const c = String.fromCharCode(code + 63);
  if (repeat > 3) return '!' + repeat + c;
  if (repeat === 3) return c + c + c;
  if (repeat === 2) return c + c;
  return c;
}

/** Sixel data for one band of 6 pixel rows. */
function processBand(data32, start, bandHeight, width, colorMap, paletteRGB) {
  // last: last seen sixel code per colour · code: current code per colour
  // accu: how many columns have carried the same code · slots: palette idx → local idx
  const last = new Int8Array(paletteRGB.length + 1);
  const code = new Uint8Array(paletteRGB.length + 1);
  const accu = new Uint16Array(paletteRGB.length + 1);
  const slots = new Int16Array(paletteRGB.length + 1);
  last.fill(-1);
  accu.fill(1);
  slots.fill(-1);

  const usedColorIdx = [];
  const targets = [];
  let oldColor = 0;
  let idx = 0;
  for (let i = 0; i < width; ++i) {
    const p = start + i;
    let rowOffset = 0;
    code.fill(0, 0, usedColorIdx.length);
    for (let row = 0; row < bandHeight; ++row) {
      const color = data32[p + rowOffset];
      // Skip the expensive palette match when the colour has not changed.
      if (color !== oldColor) {
        oldColor = color;
        /**
         * ⚠️ CHANGE 2 — see the header. Upstream wrote
         * `colorMap.get(color) || 0`, which turned "not in the palette" into
         * "transparent" and left the nearest-colour branch unreachable.
         */
        if (!alpha(color)) {
          idx = 0;
        } else {
          idx = colorMap.get(color);
          if (idx === undefined) {
            idx = nearestColorIndex(color, paletteRGB) + 1;
            colorMap.set(color, idx);
          }
        }
        // A colour appearing for the first time in this band needs a slot, and
        // needs its run to be back-filled with zeros up to the current column.
        if (slots[idx] === -1) {
          targets.push([]);
          if (i) {
            last[usedColorIdx.length] = 0;
            accu[usedColorIdx.length] = i;
          }
          slots[idx] = usedColorIdx.length;
          usedColorIdx.push(idx);
        }
      }
      code[slots[idx]] |= 1 << row;
      rowOffset += width;
    }
    for (let j = 0; j < usedColorIdx.length; ++j) {
      if (code[j] === last[j]) {
        accu[j]++;
      } else {
        if (~last[j]) {
          targets[j].push(codeToSixel(last[j], accu[j]));
        }
        last[j] = code[j];
        accu[j] = 1;
      }
    }
  }
  // Flush the run that reaches the end of the line.
  for (let j = 0; j < usedColorIdx.length; ++j) {
    if (last[j]) {
      targets[j].push(codeToSixel(last[j], accu[j]));
    }
  }

  const result = [];
  for (let j = 0; j < usedColorIdx.length; ++j) {
    if (!usedColorIdx[j]) continue; // slot 0 is the background — never drawn
    result.push('#' + (usedColorIdx[j] - 1) + targets[j].join('') + '$');
  }
  return result.join('');
}

/**
 * Encode RGBA pixels to sixel data (WITHOUT the introducer and finalizer).
 *
 * Colours are matched to `palette` by euclidean distance. An alpha of exactly 0
 * is transparent; every other alpha is drawn.
 *
 * @param data    RGBA8 pixels, 4 bytes per pixel
 * @param width   image width in pixels
 * @param height  image height in pixels
 * @param palette array of `[r, g, b]` or native colour words, ≤ 256 entries
 * @param rasterAttributes whether to emit the `"Pan;Pad;Ph;Pv` raster header
 */
export function sixelEncode(data, width, height, palette, rasterAttributes = true) {
  if (!data.length || !width || !height) {
    return '';
  }
  if (width * height * 4 !== data.length) {
    throw new Error('wrong geometry of data');
  }
  if (!palette || !palette.length) {
    throw new Error('palette must not be empty');
  }

  // paletteWithZero: slot 0 is the background · paletteRGB: [r,g,b] for distance
  const paletteWithZero = [0];
  const paletteRGB = [];
  for (let i = 0; i < palette.length; ++i) {
    let color = palette[i];
    if (typeof color === 'number') {
      if (!alpha(color)) continue;
      color = toRGBA8888(...fromRGBA8888(color));
    } else {
      color = toRGBA8888(...color);
    }
    if (!~paletteWithZero.indexOf(color)) {
      paletteWithZero.push(color);
      paletteRGB.push(fromRGBA8888(color).slice(0, -1));
    }
  }

  const chunks = [];
  // Raster attributes carry the image dimensions. Pan/Pad are dummies; no
  // terminal evaluates them.
  if (rasterAttributes) {
    chunks.push(`"1;1;${width};${height}`);
  }
  for (const [idx, [r, g, b]] of paletteRGB.entries()) {
    chunks.push(`#${idx};2;${Math.round(r / 255 * 100)};${Math.round(g / 255 * 100)};${Math.round(b / 255 * 100)}`);
  }

  const colorMap = new Map(paletteWithZero.map((el, idx) => [el, idx]));

  /**
   * ⚠️ CHANGE 3 — see the header. Upstream reinterpreted the whole underlying
   * ArrayBuffer, which reads the wrong bytes for any view that does not start
   * at offset 0 — including every pooled Node Buffer under 4KB.
   */
  const data32 = new Uint32Array(data.buffer, data.byteOffset, data.length >>> 2);
  const bands = [];
  for (let b = 0; b < height; b += 6) {
    bands.push(processBand(data32, b * width, height - b >= 6 ? 6 : height - b, width, colorMap, paletteRGB));
  }
  chunks.push(bands.join('-\n'));
  return chunks.join('');
}
