---
name: vendor-traps
description: The version trap in each /vendor/ library — the API you remember is often a different major, and none of them errors clearly
when: Writing code against a vendored library, or debugging one that loaded but behaves wrong
---

# The version traps, per library

Read `vendor-shelf` first for the URLs and CSP rules; this is what bites AFTER
the script tag is right.

## ⚠️⚠️⭐ EIGHT LIBRARIES ARE AT LEAST ONE MAJOR BEHIND npm's `latest`

Measured 2026-09-06 against `registry.npmjs.org`
(`console/scripts/zz-shelf-version-currency.mts`, one GET per package):
**13 of 30 exactly current, 8 a whole major or more behind.**

Shelf → npm `latest`: **marked** `15.0.7`→`18.0.11` (**three majors**) ·
**lucide** `0.544.0`→`1.41.0` · **konva** `9.3.22`→`10.3.3` · **phaser**
`3.90.0`→`4.2.1` · **pixi.js** `7.4.3`→`8.20.1` · **jspdf** `3.0.3`→`4.2.1` ·
**chroma-js** `2.4.2`→`3.2.0` · **fullcalendar** `6.1.15`→`7.1.0`.

⚠️ **Not a to-do list; none is broken** — each loaded in a real browser, global
confirmed. The trap: **the newest release is what a search engine, a blog post
and your memory describe**, while the URL serves the older major. Nothing errors
"wrong version": you get `undefined is not a function` at an unrelated line, or
silence.

⭐ **SO NAME THE VERSION WHEN YOU LOOK IT UP.** `search_docs` / `read_docs`
resolve whatever the corpus considers current — a different major for these
eight. Ask for the pinned one: a topic like `"marked 15 parse"`, not `"marked"`.

⚠️ **`three` is NOT on that list** — the shelf carries r186 (below). The other
eight that drift — dompurify, sortablejs, chart.js, papaparse, fuse.js, mermaid,
turndown, jspdf-autotable — are a patch or minor behind: nothing you'd write changes.

- **PIXI is v7.** v8 code (`app.init()`) throws; the constructor is synchronous
  and the canvas is `app.view`.
- **Three is r186, ONE tag** — `/vendor/three@0.186.1/three.bundle.min.js`
  carries the core AND `THREE.GLTFLoader`, `THREE.OrbitControls`,
  `THREE.PointerLockControls`, `THREE.RoomEnvironment`, `THREE.Sky`,
  `THREE.RoundedBoxGeometry` and post-processing (`THREE.EffectComposer`,
  `RenderPass`, `UnrealBloomPass`, `SMAAPass`, `OutputPass`). Never add the old
  r147 addon tags beside it. ⚠️ What your memory writes and r186 does not have:
  `renderer.outputEncoding` / `THREE.sRGBEncoding` (gone — output is sRGB by
  default; set `texture.colorSpace = THREE.SRGBColorSpace` on colour maps),
  `THREE.PCFSoftShadowMap` (removed — use `PCFShadowMap` + `light.shadow.radius`),
  `THREE.Clock` (deprecated, warns — use the `time` argument of
  `renderer.setAnimationLoop`), `physicallyCorrectLights` (always on: light
  intensities are physical, so a `PointLight` needs a much bigger number).
  No Draco/KTX2/meshopt: a `.glb` must be uncompressed. For a premium start,
  `read_skill("three-scenes")`.
- **3D physics is cannon-es** (`window.CANNON`), pure JS. Rapier is WebAssembly
  and cannot run under our policy; Matter is 2D only.
- **`Sortable.create(el, { onEnd })`** makes a list draggable — rosters, kanban,
  task order. ⚠️ It reorders the DOM and **saves nothing**: persist from `onEnd`
  or the change vanishes on reload.
- **`marked.parse(md)`** renders markdown. ⚠️⚠️ **It does NOT sanitise** — pair
  it with DOMPurify or you have shipped an XSS hole.
- **jsPDF's global is lowercase `jspdf`**, and `jspdf-autotable` is a plugin
  that loads AFTER it — both in the jsPDF section below.
- **luxon's global is `luxon`**, and the class is `luxon.DateTime`.
- **DOMPurify is capitalised exactly** — `DOMPurify.sanitize`, not `dompurify`.
- **Konva needs a container `<div>` with a real height** or the stage is 0px and
  nothing drawn appears.
- **Tone needs a gesture.** Browsers refuse audio before one: call
  `await Tone.start()` from a click.
- ⭐⭐ **`katex` needs THREE things, not one** — the script, the stylesheet
  (`/vendor/katex@0.18.7/katex.min.css`) **and** the fonts, already served at
  `/vendor/katex@0.18.7/fonts/` — the relative path the CSS expects, so do not
  move or rename that folder. ⚠️ Script alone renders unstyled boxes; stylesheet
  without fonts, fallback glyphs that look ALMOST right and error nowhere.
  `katex.render(tex, el, { throwOnError: false, output: 'htmlAndMathml' })` —
  screen-reader semantics plus visual typesetting in one call. `renderToString`
  when you need markup.
- ⭐⭐ **`echarts` is for the charts Chart.js has NO TYPE for** — sankey,
  treemap, sunburst, gauge, candlestick, funnel, network/force graph, calendar
  heatmap, boxplot, choropleth. Reach for Chart.js first: echarts is **1.12 MB**
  against its 208 KB. ⚠️ **`echarts.init(el)` renders NOTHING if the container
  has no height in CSS** — same trap as Konva and Leaflet. Then
  `chart.setOption({series:[{type:'sankey', …}]})`; `chart.resize()` on layout change.
- **Chart.js v4 needs no date adapter** unless you use a `time` scale — and
  that adapter is not vendored. Use luxon to format the labels yourself.
- **Howler needs audio FILES.** With none, use **Tone** (or a WebAudio
  oscillator, cheaper than the whole bundle).
- **Reach for Chart.js before d3.** d3 is for the chart Chart.js cannot draw.
- ⚠️⚠️ **anime.js is v4 and v4 is not v3.** There is no default `anime({...})`
  call and no `anime.timeline()`. The four things worth knowing:

```js
// 1. Draw an SVG on, stroke by stroke. Only STROKES draw — a fill shows nothing.
anime.animate(anime.svg.createDrawable('.line'), { draw: '0 1', duration: 900 });

// 2. Morph one shape into another.
anime.animate('#from', { points: anime.svg.morphTo('#to'), duration: 600 });

// 3. Move something along a path.
const { translateX, translateY, rotate } = anime.svg.createMotionPath('#route');
anime.animate('.dot', { translateX, translateY, rotate, duration: 2000 });

// 4. Sequence the whole thing — this is what makes it feel like a video.
anime.createTimeline()
  .add('.step1', { opacity: [0, 1] })
  .add(anime.svg.createDrawable('.arrow'), { draw: '0 1' }, '-=200')
  .add('.step2', { opacity: [0, 1] });
```

- ⚠️ **rough needs a `seed`.** Without one every redraw wobbles differently and
  the picture appears to twitch:

```js
const rc = rough.svg(document.querySelector('svg'), { options: { seed: 42 } });
svg.appendChild(rc.rectangle(10, 10, 200, 100, { roughness: 1.6 }));
```

⭐ **They do not touch your byte budget.** An app's own files have a hard ~400KB
ceiling; Phaser alone is three times that, its `<script src>` ~50 bytes.
Inlining a library, or asking for one to be installed, is not an option with no
build step.

⚠️ **The version is part of the path.** `/vendor/phaser/phaser.min.js` and
`/vendor/phaser@3.9.0/...` both 404 silently — a blank page, a quiet console,
*exactly* like a logic bug. Type the whole string.

⚠️ **Only these forty are on `/vendor/`** — counted against `VENDOR_ASSETS`,
which `vendor-skill-matches-manifest.test.ts` pins to `vendor-shelf`. No Babylon,
no p5, no jQuery, no Bootstrap or Tailwind, and **no GSAP** — GSAP ships a
bespoke "no charge" licence rather than MIT, so it is deliberately not vendored
and asking will not change that.

⚠️⚠️ **No React, no Vue and no Alpine either, and a DEFAULT build of any of them
is impossible** — `script-src` carries no `'unsafe-eval'`, so the template
compiler throws in a published app. `htmPreact` is the view layer here and the
only one you can reach — `add_library` cannot lift that, because what is
missing is `unsafe-eval`, not the package. ⭐ **Everywhere else, an absent
package means `add_library`** (npm into this project's own files) — never a
guessed CDN path; hand-rolling is the last resort.

⭐⭐ **It is the TEMPLATE COMPILER that is impossible, not the framework.**
Measured 2026-09-09 in a real browser, policy with **no** `unsafe-eval`:
`vue.runtime.global.prod.js` (108 KB) mounted and rendered, and so did
`@alpinejs/csp` (Alpine's official CSP build, 71 KB) via `Alpine.data()`; the
control, `vue.global.prod.js`, was **blocked** — *"Evaluating a string as
JavaScript violates…"*. ⚠️ **Neither is vendored, and not because of the CSP:**
their usual authoring style is the forbidden one. Vue runtime-only rejects every
string `template:` (render functions only); Alpine's CSP build forbids arrow
functions, destructuring, template literals and expressions in attributes.
*Idiomatic* Vue or Alpine would break, so adding either is a decision about that
trade, not the policy.

⚠️⚠️ **A LIBRARY'S OWN STYLESHEET DOES LOAD, since 2026-08-30.** `style-src`
grants `{host}/vendor/` on all four surfaces (`/p/<token>`, `/s/<slug>` and
their siblings) — hence flatpickr, Tabulator, Leaflet and Quill. Any sentence
saying a picker, grid or map is impossible here is stale.

⭐ **This list is enforced.** `unknownVendorRefs` checks every `/vendor/` URL
you write — **`<script src>` and `<link rel="stylesheet">` alike** — against
what we serve, and `validateFileMap` refuses the build with the correct URLs
attached: copying a URL is cheaper than a retry.

## jsPDF + autoTable — producing a real PDF file

Script tags in `vendor-shelf`, page geometry in `printing-and-pdf`. Here: what
the library does to the OUTPUT.

```js
const { jsPDF } = window.jspdf;      // ⚠️ lowercase namespace, capitalised class
const doc = new jsPDF({ unit: 'pt', format: 'a4' });
doc.text('Invoice #1042', 40, 60);
doc.autoTable({ head: [['Item','Qty','Total']], body: rows, startY: 90 });
doc.save('invoice-1042.pdf');
```

⚠️⚠️ **`jspdf-autotable` is a PLUGIN and must load AFTER `jspdf`.** Load it
first and `doc.autoTable is not a function` — with **nothing on the console**,
because its own `catch` never fires (measured). If you cannot change the order,
the 5.0.2 bundle exposes `applyPlugin`: `applyPlugin(window.jspdf.jsPDF)` once
both have loaded repairs it.

⚠️⚠️ **`doc.html(element)` needs html2canvas and RASTERISES** — a screenshot in
a PDF wrapper: not selectable, searchable or accessible, and large. Wrong for an
invoice, right for a chart. For a document use `doc.text` + `autoTable` — or
print, which beats either.

⚠️ **Guard the global before you use it.** Two of ten bench artefacts died on
load with `ReferenceError: Chart is not defined` / `Sortable is not defined`:

```js
if (typeof window.jspdf === 'undefined') { /* fall back to window.print() and say so */ }
```

## ⭐ Reach for these instead of hand-writing

Watched get hand-rolled, badly, across 81 published projects and 10 benchmarks:

- **lucide instead of inline `<svg>` paths.** 141 hand-drawn icons cost 74,342
  bytes across 10 builds; `<i data-lucide="check">` + `lucide.createIcons()`
  costs 28. Size via CSS on the `<svg>`, not attributes on the `<i>`.
- **luxon for any booking, roster, invoice due date or opening hours.**
  `DateTime.fromISO(s).toFormat('ccc d LLL yyyy')`. Hand-rolled date maths lets
  timezones and month-ends silently corrupt real records.
- **DOMPurify around every `innerHTML` holding text a stranger typed** — always
  alongside `marked`. 7 of 10 benchmark builds wrote user data to `innerHTML`;
  only 3 escaped it. `el.innerHTML = DOMPurify.sanitize(marked.parse(md))`.
- **autoTable for invoice line items** — bare jsPDF is `doc.text(str, x, y)`:
  column maths that drifts on page two. `autoTable(doc, { head, body })`.
- **html2canvas for export-to-image**, and it is **required** by `jsPDF.html()`.
- **Konva for floor plans, seating charts, org charts and flow charts** — the
  diagrams Chart.js deliberately does not draw.
- **htmPreact, not `innerHTML =`, for anything with more than one screen** —
  recipe and router in `state-management`.
