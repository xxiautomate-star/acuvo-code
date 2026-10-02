# Third-party source vendored into acuvo-code

`acuvo-code` declares `"dependencies": {}` and means it. Where a solved problem
already exists under a permissive licence we copy the SOURCE in, with its notice,
rather than take a dependency — which the MIT licence explicitly permits and this
file is the condition of.

Our own outbound licence is FSL-1.1-ALv2, which can absorb MIT and Apache-2.0.
It cannot absorb AGPL, so nothing AGPL may ever land in this directory.

---

## `sixel-encode.mjs` — from **node-sixel** v0.16.0 (`sixel` on npm)

- Upstream: <https://github.com/jerch/node-sixel>
- Author: Joerg Breitbart <j.breitbart@netzkolchose.de>
- Licence: **MIT**, Copyright (c) 2019, Joerg Breitbart — full text below,
  copied from the `LICENSE` file inside the published tarball
  (`unpkg.com/sixel@0.16.0/LICENSE`).
- Taken from: `lib/SixelEncoder.js` and `lib/Colors.js` of that tarball
  (the compiled CommonJS output, which is the readable form the package ships).

**What we did NOT take**, and why it matters: the package's `dist/encode.esm.js`
bundle is the obvious thing to vendor and is the wrong thing. It is minified, and
it inlines UPNG.js — a browser-oriented PNG codec that reaches for `pako` for
inflate, i.e. exactly the dependency this package exists to not have. We also
left behind the decoder, the WebAssembly decoder wrapper, and `Quantizer.js`,
which is the only part that needs UPNG.

The modifications made to what we did take are listed at the top of
`sixel-encode.mjs`. MIT requires the notice; stating the changes is ours.

```
Copyright (c) 2019, Joerg Breitbart

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## `csv-parser.mjs` — from **PapaParse** v5.7.0 (`papaparse` on npm)

- Upstream: <https://github.com/mholt/PapaParse>
- Author: Matthew Holt
- Licence: **MIT**, Copyright (c) 2015 Matthew Holt — full text below, copied
  from the `LICENSE` file inside the published tarball.
- Taken from: `papaparse.js` of `https://registry.npmjs.org/papaparse/-/papaparse-5.7.0.tgz`
  — `sha1 791209b95dd3a0ca0b6ed9b64f853bc491a45a65` (matches the registry's
  `dist.shasum`), `sha256 263bac53bab292390bcf2697a8c14f0bc382ab3c192fa088e1caa9a8241956b1`.
  The file itself: 51,214 bytes, `sha256
  01d32cdc0b8ceced438f078c6859e16c8aefc0d3eb5fb06992df0d3f63666ba0`.
  `"dependencies": {}` upstream, so nothing rides in behind it.

**What we took**: `function Parser(config)` — the character-level state machine —
plus the four helpers it references (`BAD_DELIMITERS`, `isFunction`,
`escapeRegExp`, `stripBom`), each copied verbatim with its upstream line numbers
recorded in the file header.

**What we did NOT take**, and why it matters: the obvious thing to vendor is
`papaparse.min.js` or the whole `papaparse.js`, and both are wrong here.
`ParserHandle`, `ChunkStreamer` and its four transports (XMLHttpRequest,
FileReader, `fs.createReadStream`, string), the Web Worker plumbing and the
`JsonToCsv` writer all reach for a browser or for Node streams — a runtime
detection layer for environments this CLI never runs in. The state machine needs
none of it: `parse(input, baseIndex, ignoreLastRow)` is already the chunked
primitive, and `lib/table-profile.mjs` drives it directly.

**Proof the cut is faithful**: upstream ships 63 `CORE_PARSER_TESTS` in
`tests/test-cases.js`. All 63 were run against the published `papaparse.js` to
capture expected output, stored at
`test/fixtures/papaparse-5.7.0-core-parser-cases.json`, and are asserted against
our cut in `test/table-profile.test.mjs`. The first cut passed 59 and failed 4 —
`stripBom` was referenced only inside the duplicate-header rename branch and had
been missed. Reading the file did not find that; running upstream's fixtures did.

```
The MIT License (MIT)

Copyright (c) 2015 Matthew Holt

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## `magic-bytes.mjs` — from **magic-bytes.js** v1.13.1 (`magic-bytes.js` on npm)

- Upstream: <https://github.com/LarsKoelpin/magic-bytes>
- Author: Lars Kölpin
- Licence: **MIT**, Copyright (c) 2022 Lars Kölpin — full text below, copied from
  the `LICENSE` file inside the published tarball.
- Taken from: `https://registry.npmjs.org/magic-bytes.js/-/magic-bytes.js-1.13.1.tgz`
  — `sha1 a96bba8c95380064e49b8ac8d53505ad523f2363` (matches the registry's
  `dist.shasum`), `sha256
  9faab3d72eec1b9fa6847b86ce5bee8a1b658aeb2374c44b1ee78cf9c2f5d2d8`.
  `"dependencies"` is absent upstream, so nothing rides in behind it.

**Why**: `file(1)` is not installed in most of the containers this package has
Terminal-Bench transcripts for. Counted across the 139 stored runs:
`file: not found` **11 times** and `xxd: not found` **7 more**, in 18 distinct
runs that reached for binary forensics 57 times between them. On the default
(shell-less) surface the question is not merely unanswered but unaskable, and
`workspace.mjs`'s own binary refusal ended *"get what you need from a text file
instead"* — an instruction to give up. This table is what answers it in-process.

**What we took**: `dist/index.js`, `dist/model/pattern-tree.js` (the 205-signature
table, 26,942 B, `sha256
39c1b84bd0adcf83943de4fe980e95af675b8eec2fe13c0fb9dedfe3984fd24e`),
`dist/model/tree.js` and `dist/model/toHex.js`, concatenated in dependency order.

**What we did NOT take**, and why it matters: `dist/index.spec.js` and
`dist/model/tree.spec.js` are upstream's Jest suites and would drag a test runner
we do not have into a `lib/` directory that ships to users; the `.d.ts` and
`.d.ts.map` files describe a TypeScript build this package does not run. There is
no bundle to be tempted by here — unlike `sixel`, every file in this tarball is
plain readable CommonJS.

**The modifications are mechanical and were made by a script, not by hand**, so
that the diff is checkable rather than trusted: the CommonJS wrapper is stripped
(`"use strict"`, the `__esModule` marker, the `exports.x = x` manifest lines, the
`require` bindings, `exports.default`) and every qualified reference
(`toHex_1.toHex`, `tree_1.merge`, `pattern_tree_1.add`, `exports.filetypeinfo`) is
rewritten to the bare local name it already resolved to. No signature, no
comparison and no control-flow line was changed.

**Proof the cut is faithful**: all 205 upstream signatures were turned into probe
buffers at three offsets, plus 400 seeded-random buffers and three degenerate ones
(empty, one NUL, ASCII). All 1,018 were run through the PUBLISHED CommonJS build
to capture expected output, stored at
`test/fixtures/magic-bytes-1.13.1-upstream-cases.json`, and asserted against our
cut in `test/binary-inspect.test.mjs`. **611 of the 1,018 match a real type**, so
the fixture is not a thousand empty arrays agreeing with each other — which is
how this kind of guard passes while checking nothing. During development the same
comparison was also run live against the tarball across 19,292 assertions
(`filetypeinfo`, `filetypename`, `filetypemime`, `filetypeextension`) with zero
mismatches.

```
MIT License

Copyright (c) 2022 Lars Kölpin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
