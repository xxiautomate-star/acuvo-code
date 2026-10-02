---
name: vendor-shelf
description: The 40 /vendor/ library URLs — a component kit, pickers, grids, maps, a view layer, icons, dates, charts, 3D, PDF, CSV, search, rich text, calendars, motion — and the CSP that blocks every CDN
when: Reaching for any library in a published app — a date picker, a table, a map, a multi-view app, an icon, a chart, a PDF — or whether to at all
---

# The shelf

Forty libraries are served from the platform's own host, free to the app and
cached across every app. ⭐ **For anything the shelf has not got, call
`add_library`** — it downloads the npm package into THIS project's own files;
permissive licences only, exact version, hash-checked. Shelf + `add_library` =
npm minus what we refuse, so an absent package is never a reason to hand-roll.
`game-engines` covers the game ones in depth, `game-prototype` a game by hand,
`state-management` the htmPreact view layer and the seven-line router.

For an app **published on the platform** (`/p/<token>/`) these are root-relative
on the same host: no CORS, no build step.

## ⚠️⚠️ A CDN IS BLOCKED, AND THAT IS THE #1 WAY A GENERATED APP SHIPS DEAD

`<script src="https://cdn.jsdelivr.net/…/phaser.min.js">` is the reflex, and the
CSP refuses it: blank canvas, `Phaser` undefined, one console line. Only the app's
own files and `/vendor/` load — another CDN host changes nothing. ⭐ `add_library`
works because the package lands **in the app's own files** (a relative, allowed
tag). A CDN 200 does not prove a file exists — `look-up-the-docs`.

## They are global scripts, not ES modules

Each tag defines the global named in its comment below. No `import`, no
`require`, no bundler; `type="module"` breaks the UMD builds. Put the library
tag **before** your own script, or your first line hits an undefined global.
⭐ Then prove it loaded:

```js
if (typeof Konva === 'undefined') {
  document.body.innerHTML = '<pre>Konva did not load — check the /vendor/ URL</pre>';
}
```

A missing library looks exactly like a logic bug; one guard per library turns a
silent blank page into a sentence naming the cause.

## ⭐⭐⭐ FIVE OF THEM NEED **TWO** TAGS

**Basecoat, flatpickr, Tabulator, Leaflet and Quill each need a `<link rel="stylesheet">`
as well as their `<script src>`.** Script only, the library *works* and looks
broken — flatpickr a bare column of numbers, Tabulator unformatted text, Leaflet
unpositioned tiles, Quill unstyled buttons — and nothing in the console says why.

```html
<link rel="stylesheet" href="/vendor/basecoat-css@1.0.2/basecoat.acuvo.css"><script src="/vendor/basecoat-css@1.0.2/basecoat.min.js" defer></script> <!-- dropdown/select/⌘K/toast: read_skill("design-kit") -->

<!-- pick a date / a time slot — global `flatpickr` -->
<link rel="stylesheet" href="/vendor/flatpickr@4.6.13/flatpickr.min.css">
<script src="/vendor/flatpickr@4.6.13/flatpickr.min.js"></script>

<!-- a sortable, filterable, EDITABLE data grid — global `Tabulator` -->
<link rel="stylesheet" href="/vendor/tabulator-tables@6.5.2/tabulator.min.css">
<script src="/vendor/tabulator-tables@6.5.2/tabulator.min.js"></script>

<!-- an interactive map / a service area — global `L` -->
<link rel="stylesheet" href="/vendor/leaflet@1.9.4/leaflet.css">
<script src="/vendor/leaflet@1.9.4/leaflet.js"></script>

<!-- a rich-text editor — global `Quill` -->
<link rel="stylesheet" href="/vendor/quill@2.0.3/quill.snow.css">
<script src="/vendor/quill@2.0.3/quill.js"></script>
```

```js
// A SHEET. `editor` is why this and not a hand-built <table>.
const money = { symbol: '$', thousand: ',' };
const grid = new Tabulator('#grid', {
  maxHeight: '60vh',   // ⚠️ set one: grows with the rows, then scrolls; a fixed `height` leaves a grey slab under three rows
  data: rows, layout: 'fitColumns',
  columns: [
    { title: 'Item', field: 'item', editor: 'input' },
    { title: 'Qty', field: 'qty', editor: 'number', sorter: 'number', hozAlign: 'right' },
    { title: 'Total', field: 'total', sorter: 'number', hozAlign: 'right', headerHozAlign: 'right',
      formatter: 'money', formatterParams: money,
      bottomCalc: 'sum', bottomCalcFormatter: 'money', bottomCalcFormatterParams: money },
  ],
});
grid.on('cellEdited', (c) => AcuvoData.set('rows', c.getRow().getData().id, c.getRow().getData()));

// A SERVICE AREA.
const map = L.map('map').setView([-35.28, 149.13], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
L.circle([-35.28, 149.13], { radius: 25000 }).addTo(map).bindPopup('We cover 25km');
```

⭐⭐ **Tabulator's stylesheet is a LIGHT-GREY theme that ignores your design
system.** Skin it from the tokens in your CSS AFTER its `<link>`, scoped to the
grid's id (an id outranks every vendor selector; the calc rows are `!important`):

```css
#grid{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);color:var(--ink);font:inherit;font-size:var(--step--1)}
#grid .tabulator-header,#grid .tabulator-col,#grid .tabulator-footer{background:var(--surface-raised);color:var(--ink-muted);border-color:var(--line)}
#grid .tabulator-table,#grid .tabulator-row{background:var(--surface);color:var(--ink)}
#grid .tabulator-row-even{background:var(--surface-raised)}
#grid .tabulator-row.tabulator-selectable:hover{background:var(--line)}
#grid .tabulator-cell,#grid .tabulator-col-content{border-color:var(--line);padding:var(--space-2) var(--space-3);font-variant-numeric:tabular-nums}
#grid .tabulator-editing{border-color:var(--accent)}
#grid .tabulator-editing input{color:inherit}
#grid .tabulator-calcs-holder,#grid .tabulator-calcs{background:var(--surface-raised)!important;border-color:var(--line);font-weight:600}
#grid .tabulator-placeholder-contents{color:var(--ink-muted);font-weight:400}
```

⚠️ Traps that each cost a round (flatpickr's booking-slot recipe and clipping
trap: `dates-and-scheduling`):

- ⚠️⚠️ **Never pass `persistence: true` to Tabulator.** It reads `localStorage`;
  a published app has no storage, so it throws `SecurityError`. Persist from
  `cellEdited` into `AcuvoData`.
- **Leaflet's container `<div>` needs a real CSS height** or the map is 0px, and
  **no `tileLayer` = a grey box**. Keep the OpenStreetMap attribution (a
  condition of use). Its global is `L` — ignore the UMD's `window.leaflet`.

## ⭐⭐⭐ THE URLS. Copy them exactly; do not paraphrase a version.

**Pickers, grids, maps, rich text** — copy the two-tag pairs above.

**A real view layer — components, hooks and keyed re-rendering**

```html
<script src="/vendor/htm@3.1.1/standalone.umd.js"></script> <!-- htmPreact -->
```

⚠️ Three idioms are wrong by default with it — keyed list rows, `hashchange`
screens, a JS router NOT being page navigation — see `state-management` before
a multi-screen app.

**Games, physics and sound**

```html
<script src="/vendor/phaser@3.90.0/phaser.min.js"></script> <!-- Phaser -->
<script src="/vendor/pixi.js@7.4.3/pixi.min.js"></script> <!-- PIXI -->
<script src="/vendor/matter-js@0.20.0/matter.min.js"></script> <!-- Matter -->
<script src="/vendor/howler@2.2.4/howler.min.js"></script> <!-- Howl -->
<script src="/vendor/jsfxr@1.4.1/jsfxr.min.js"></script> <!-- jsfxr — retro SFX synthesised in the page, no files -->
```

Real art and sound, not boxes and beeps: `read_skill("game-assets")` — CC0
sprites, 3D models, textures, sky lighting and sound effects we host.

**Charts, 3D, dataviz, PDF and synthesised audio**

```html
<script src="/vendor/chart.js@4.5.0/chart.umd.min.js"></script> <!-- Chart -->
<script src="/vendor/echarts@6.1.0/echarts.min.js"></script> <!-- echarts — sankey/treemap/sunburst/gauge/candlestick/funnel/network -->
<link rel="stylesheet" href="/vendor/katex@0.18.7/katex.min.css">
<script src="/vendor/katex@0.18.7/katex.min.js"></script> <!-- katex — real maths; NEEDS the CSS above, fonts ship beside it -->
<script src="/vendor/three@0.186.1/three.bundle.min.js"></script> <!-- THREE r186 — GLTFLoader, OrbitControls, bloom INSIDE; read_skill("three-scenes") -->
<script src="/vendor/cannon-es@0.20.0/cannon-es.min.js"></script> <!-- CANNON — 3D physics, after three -->
<!-- OLD, still served only so existing projects keep working; never in new work:
     /vendor/three@0.160.1/three.min.js  /vendor/three-gltfloader@0.147.0/GLTFLoader.js
     /vendor/three-orbitcontrols@0.147.0/OrbitControls.js -->

<script src="/vendor/d3@7.9.0/d3.min.js"></script> <!-- d3 -->
<script src="/vendor/jspdf@3.0.3/jspdf.umd.min.js"></script> <!-- jspdf -->
<script src="/vendor/pptxgenjs@4.0.1/pptxgen.bundle.js"></script> <!-- PptxGenJS — .pptx decks -->
<script src="/vendor/docx@9.7.1/index.iife.js"></script> <!-- docx — .docx Word files -->
<script src="/vendor/tone@15.1.22/tone.js"></script> <!-- Tone -->
<script src="/vendor/sortablejs@1.15.6/sortable.min.js"></script><!-- Sortable -->
<script src="/vendor/marked@15.0.7/marked.min.js"></script> <!-- marked -->
```

**Icons, dates, sanitising, PDF tables, screenshots and canvas diagrams**

```html
<script src="/vendor/lucide@0.544.0/lucide.min.js"></script> <!-- lucide -->
<script src="/vendor/luxon@3.7.2/luxon.min.js"></script> <!-- luxon -->
<script src="/vendor/dompurify@3.2.7/purify.min.js"></script> <!-- DOMPurify -->
<script src="/vendor/jspdf-autotable@5.0.2/jspdf.plugin.autotable.min.js"></script>
 <!-- autoTable, LOAD AFTER jspdf -->
<script src="/vendor/html2canvas@1.4.1/html2canvas.min.js"></script><!-- html2canvas -->
<script src="/vendor/konva@9.3.22/konva.min.js"></script> <!-- Konva -->
```

**CSV, fuzzy search, colour maths, rich text, diagrams and a calendar**

```html
<script src="/vendor/papaparse@5.5.3/papaparse.min.js"></script> <!-- Papa -->
<script src="/vendor/fuse.js@7.1.0/fuse.min.js"></script> <!-- Fuse -->
<script src="/vendor/chroma-js@2.4.2/chroma.min.js"></script> <!-- chroma -->
<script src="/vendor/turndown@7.2.0/turndown.js"></script> <!-- TurndownService -->
<script src="/vendor/mermaid@11.4.1/mermaid.min.js"></script> <!-- mermaid -->
<script src="/vendor/fullcalendar@6.1.15/index.global.min.js"></script> <!-- FullCalendar -->
```

- **Papa** (CSV), **Fuse** (typo-tolerant search) and **Quill** + **TurndownService**
  (rich text → Markdown): their traps are in `csv-and-data-export`, `live-data`
  and `forms-and-validation`.
- **chroma** — `chroma.contrast(a, b)` is the WCAG ratio. ⚠️ Interpolate in
  `lch`/`lab`, never the default `rgb` (it passes through a muddy grey):
  `chroma.scale([a,b]).mode('lch').colors(n)`.
- ⚠️⚠️ **mermaid does NOT auto-run under our CSP:** the docs' `startOnLoad: true`
  fires before an inline script defines the diagrams. Source in
  `<pre class="mermaid">`, then `mermaid.initialize({ startOnLoad: false })`,
  `await mermaid.run()`.

**Motion and the hand-drawn look — the explainer-video pair**

```html
<script src="/vendor/animejs@4.5.0/anime.umd.min.js"></script> <!-- anime -->
<script src="/vendor/roughjs@4.6.6/rough.js"></script> <!-- rough -->
```

Together they make a diagram draw itself (taste: `sketch-and-explain`).
⚠️ **anime.js v4 is not v3 — no default `anime({...})` call.** The four recipes
and the `seed` rule are in `vendor-traps`.

**Licences.** All **MIT** except d3 and lucide (**ISC**), DOMPurify (dual
`MPL-2.0 OR Apache-2.0`, we elect Apache-2.0), htm (**Apache-2.0**, preact's MIT
`LICENSE.preact` beside it) and Leaflet (**BSD-2-Clause**). Each ships its
upstream `LICENSE` beside it.

## ⚠️ Every library has a version trap — they are in `vendor-traps`

The API you remember is often a DIFFERENT MAJOR VERSION from the URL above, and
none errors with "wrong version". Read it before writing against any of them.

## Where this does NOT apply

A **local project on a real machine** (shell, `npm install` works) has no
`/vendor/`: `npm i phaser` and import it normally.
