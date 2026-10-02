---
name: printing-and-pdf
description: Real page geometry — @page in mm, an A2 poster, a 24-page book, colours that survive, breaks that land, jsPDF
when: A poster, flyer, book, zine, invoice, deck or any document going on paper or into a PDF, at any page size
---

# Print and PDF

Invoices, receipts, quotes, rosters, decks, reports, posters, books. The button
is one line; the page that comes out of the printer is the work, and it is never
checked.

## ⭐ Two different asks. Decide which, out loud.

- **Print** — `window.print()` opens the browser's own dialog. Free, no library,
  text stays selectable, the user can "Save as PDF" from there. Right answer far
  more often than it is chosen.
- **A PDF file** — a real download, produced by a library, needed when it must
  be emailed or attached without the user in the loop.

⚠️ A button labelled "Download PDF" that calls `window.print()` is defensible —
say so in one line. Silently doing it is not.

## ⚠️⚠️ Backgrounds and colours are DROPPED by default

Chrome's print dialog has a **Background graphics** checkbox and it is off. Your
dark header prints white, coloured status pills disappear, and the invoice that
looked designed on screen prints as grey text. Set **both** properties — the
unprefixed one is standard, the `-webkit-` one is what older Safari reads:

```css
@media print { :root { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
```

## The print block that does the work

```css
@media print {
  nav, aside, footer.app, button, .no-print { display: none !important; }
  body { background: #fff; color: #000; font: 11pt/1.45 Georgia, serif; margin: 0; }
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 9pt; }
  .invoice-card { box-shadow: none; border: 1px solid #ccc; }
}
@page { size: A4; margin: 15mm; }
```

- ⚠️ **Use `pt` for print, not `px`.** A px is a screen unit; 11pt is the size a
  reader expects on paper.
- ⚠️⚠️ **The design system's type and space scale is SCREEN-sized, and it prints
  as-is.** Measured: a "one-page proposal" with an h1 at 5.5rem and 96px section
  padding came out as **three** A4 pages. Inside `@media print` restate the
  sizes for paper — body 10.5–11pt, h1 20–24pt, h2 14–16pt, section spacing
  6–10mm, images `max-height: 70mm` — and keep the tokens for colour. If they
  asked for one page, the print preview shows one page.
- A link on paper is dead unless its URL is printed — that is what the `::after`
  is for. Skip it for `mailto:` and internal anchors or the page fills with noise.
- `@page { size: A4 }` vs `Letter` is a real decision for an invoice; `size:
  landscape` for a wide table. ⚠️ The user's dialog can override `size` and
  Firefox honoured it far later than Chrome and Safari — treat it as a strong
  hint, never a guarantee, and never build a layout that depends on it.

## Breaks — the difference between an invoice and a screenshot

```css
@media print {
  .line-item, .card { break-inside: avoid; page-break-inside: avoid; }
  .page-2 { break-before: page; }
  thead { display: table-header-group; }   /* repeats the header on every page */
  tfoot { display: table-footer-group; }
  h2 { break-after: avoid; }               /* no heading alone at the foot of a page */
}
```

`break-inside` is modern; `page-break-inside` is the legacy alias older Safari
still needs. **Set both** — they cost nothing.

⚠️ **`position: fixed` and `sticky` do not survive printing.** A fixed header
appears on page one in some engines and every page in others. Remove them inside
`@media print` and use `table-header-group` for a real repeating header.

⚠️ **An `overflow: hidden` or fixed-height container clips its content to one
page.** The commonest "only the first page prints" cause is a scrolling
container, not a print bug.

## ⭐⭐ LARGE FORMAT — a poster is not a big A4, and a ratio is not a size

A ratio is the single most expensive thing you can write here. `aspect-ratio:
3/4` told one build "a poster", and it emitted `@page { size: 3in 4in }` — an
index card at **76 × 102mm**, about a thirtieth of the sheet that was asked for.
**Always state millimetres.**

| sheet | mm | at 96 CSS px/in |
|---|---|---|
| A5 | 148 × 210 | 559 × 794 |
| A4 | 210 × 297 | 794 × 1123 |
| A3 | 297 × 420 | 1123 × 1587 |
| **A2** — "poster-sized" | **420 × 594** | 1587 × 2245 |
| A1 | 594 × 841 | 2245 × 3179 |
| A0 | 841 × 1189 | 3179 × 4494 |
| US Letter | 216 × 279 | 816 × 1056 |

```css
@page { size: 420mm 594mm; margin: 0; }           /* A2 portrait, no printer margin */
.sheet { width: 420mm; height: 594mm;             /* the sheet IS the element */
  padding: 25mm;                                  /* the safe area */
  box-sizing: border-box;                         /* ⚠️ or padding adds a second page */
  margin: 0 auto;
  display: flex; flex-direction: column; justify-content: space-between; }
/* Preview: 1587px does not fit a window. SCALE, never resize — a resized sheet
   is a different design. Undo it for print. */
.preview { transform: scale(0.35); transform-origin: top center; }
@media print { .preview { transform: none; } }
```

- ⚠️ **`box-sizing: border-box` on the sheet is not optional.** With the default
  `content-box`, 25mm of padding makes the element 644mm tall on a 594mm page and
  every poster silently prints on two sheets.
- ⚠️ **Never `overflow: hidden` on the sheet.** It does not shrink content, it
  DELETES it — measured on a real build where the offer, the opening hours and
  the phone number ran past the box and simply were not on the page. Let the type
  shrink or the sheet grow; you cannot see what was cut.

**Type at that size.** The reader of an A2 is two to three metres away, not 45cm.
Use `pt` and be far bolder than screen instinct: headline **90–200pt**, subhead
36–60pt, body 18–24pt, the phone number or date its own 60pt+ line. A poster set
at 16pt body copy looks like a printed email. One focal element, everything else
quieter — at this size hierarchy is the whole design.

**Placed images need real pixels.** A bitmap is judged at its FINAL size, not its
screen size: `mm ÷ 25.4 × ppi`, with 200ppi the honest floor for something held
in the hand and 120ppi for something on a wall — so a 200mm-wide image on an A2
poster needs `200 / 25.4 × 200 ≈ 1575px`. Ask the image engine for that width. A
600px picture stretched to 200mm is 76ppi and visibly soft, and it looks fine on
your screen the whole time. **Vector beats bitmap at every size** — an SVG logo,
an `<svg>` chart or CSS shapes cost nothing and stay sharp on A0.

**Bleed, only if a commercial printer is involved.** If colour runs to the edge
of the finished sheet the artwork must be 3mm bigger on every side, with the
background running into that margin, because guillotines drift — so A2 becomes
`@page { size: 426mm 600mm; margin: 0 }` with `.sheet { width: 426mm; height:
600mm; padding: 28mm }` (3mm bleed + 25mm safe).

⚠️ **Keep every word at least 10mm inside the TRIM line** (13mm inside the bleed
edge). Text closer gets cut off on some copies and not others. For a home printer
or a screenshot, skip bleed entirely — it just adds a margin.

## ⭐⭐ A DOCUMENT WITH MANY PAGES — a book, a zine, a report

A 24-page picture book is **one HTML document with 24 page elements**, not 24
files and not a scrolling page. The trick is that each element is exactly one
sheet tall and the break falls between them.

```css
@page { size: 210mm 297mm; margin: 0; }
.page { width: 210mm; height: 297mm; padding: 20mm 18mm; box-sizing: border-box;
        position: relative;   /* for the folio */
        overflow: visible; }
.page + .page { break-before: page; page-break-before: always; }
```

⚠️⚠️ **`break-before` on `.page + .page`, never `break-after` on `.page`.**
`break-after` on the last page emits a trailing BLANK sheet — a 24-page book that
prints 25, which nobody notices until it comes back from the printer.

⚠️⚠️ **Count the pages in the print preview before you stop.** If a 24-section
document previews as 25, 30 or 48, one section is a millimetre too tall. The
three causes, in the order they happen: a missing `box-sizing`, a margin on the
first child collapsing out of the section, and an image with no `height` that
loads bigger than its slot. Fix the geometry — do not shrink the page size.

**Page numbers and running heads are markup, not CSS.** The paged-media margin
boxes (`@page { @bottom-center { content: counter(page) } }`) are **not
implemented in Chrome** — silently ignored, and you ship a book with no folios.
Put a real element on each page: `<footer class="folio">12</footer>` inside the
`.page`, styled `position: absolute; bottom: 10mm; left: 0; right: 0;
text-align: center; font-size: 9pt`.

**Spreads, if it is a real book.** Page 1 is the cover and stands alone on the
right; after that pages face in pairs (2–3, 4–5), so the INNER margin is the
bigger one and it swaps side every page:

```css
.page:nth-child(odd)  { padding-left: 26mm; padding-right: 16mm; }  /* right-hand */
.page:nth-child(even) { padding-left: 16mm; padding-right: 26mm; }  /* left-hand */
```

⚠️ **A picture crossing the gutter loses about 4mm into the fold.** Never put a
face, a word or a logo across the centre of a spread.

⚠️ **Print totals for a bound book must be a multiple of 4.** A 22-page book is
bound as 24 with two blanks; decide that yourself rather than let the printer.

⭐ **Say the image bill before you spend it.** One picture per page for a 24-page
book is 24 generations. State the count and the total first, reuse one described
style across every prompt so the pages look like one book, and generate at the
ppi the table above demands — not at a screen size you will have to redo.

## ⚠️ Charts: SVG prints, canvas does not

A `<canvas>` chart is a bitmap at screen resolution and prints soft and blocky.
SVG prints at the printer's resolution. If the report is meant for paper, draw
it as SVG (d3, or a hand-built `<svg>`), not Chart.js. See `data-and-charts`.

## `window.print()`, precisely

- It is **synchronous and blocking** — nothing runs until the dialog closes.
- It can be refused inside a cross-origin iframe.
- `onbeforeprint` / `onafterprint` are where you expand collapsed sections,
  open every accordion, and then put them back:

```js
addEventListener('beforeprint', () => document.querySelectorAll('details').forEach(d => d.open = true));
```

⚠️ Images must have finished loading. Printing immediately after inserting an
`<img>` prints a gap.

## The library route, and its cost

The URLs and globals are in `vendor-shelf`; the jsPDF recipe, the ⚠️⚠️ **load
autoTable AFTER jspdf** trap and the `doc.html` rasterising trap are in
`vendor-traps`. What matters here: a library PDF is a real downloadable file,
but `window.print()` produces better output for anything text-shaped.

## ⚠️ Verify by producing the artefact

A print stylesheet that has never been printed is untested code. Press Ctrl+P
and read the preview pane — it is five seconds and it catches the clipped
container, the missing background, the table header that appears once, and the
heading stranded at the foot of page two. If you cannot open a browser, say that
the print path is unverified rather than reporting it as done.

Related: `vendor-shelf` (the full vendored library list and every global),
`money-and-totals` (the invoice's numbers), `css-layout`, `typography`.
