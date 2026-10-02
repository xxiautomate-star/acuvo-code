---
name: documents-and-slides
description: Making a real .pptx deck or .docx Word file in the browser with the two shelf libraries — PptxGenJS and docx — and handing it to the visitor as a download
when: The brief asks for a presentation, slide deck, pitch deck, PowerPoint, Word document, contract, proposal, CV or letter the visitor can DOWNLOAD as a file — not a page that merely looks like one
---

# Documents and slides

Two libraries on the shelf build real Office files entirely in the browser. No server, no
upload, no key. The visitor presses a button and gets a file that opens in PowerPoint,
Keynote, Google Slides, Word, Pages or Google Docs.

```html
<script src="/vendor/pptxgenjs@4.0.1/pptxgen.bundle.js"></script> <!-- window.PptxGenJS -->
<script src="/vendor/docx@9.7.1/index.iife.js"></script>          <!-- window.docx -->
```

⚠️ **Only these two URLs.** A CDN is blocked by the app's CSP and fails silently. Load them from
`/vendor/` exactly as written, before your own script.

## ⭐ Prove it loaded, every time

```js
if (typeof PptxGenJS === 'undefined') { showError('The slide engine did not load — reload the page.'); }
if (typeof docx === 'undefined')      { showError('The document engine did not load — reload the page.'); }
```

A missing global is the #1 way this ships dead. Check it where the button handler starts, and say
what happened in the page, never only in the console.

## A slide deck (.pptx)

```js
async function buildDeck(title, slides) {           // slides: [{ heading, bullets: [...] }]
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';                        // 10 × 5.625 INCHES — units are inches, not px
  pptx.defineSlideMaster({
    title: 'BRAND',
    background: { color: '0F0F12' },
    objects: [{ rect: { x: 0, y: 5.2, w: 10, h: 0.425, fill: { color: 'E6C069' } } }],
  });

  const cover = pptx.addSlide({ masterName: 'BRAND' });
  cover.addText(title, { x: 0.6, y: 1.8, w: 8.8, h: 1.4, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Georgia' });

  for (const s of slides) {
    const slide = pptx.addSlide({ masterName: 'BRAND' });
    slide.addText(s.heading, { x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontSize: 28, bold: true, color: 'FFFFFF' });
    slide.addText(s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
      { x: 0.6, y: 1.5, w: 8.8, h: 3.4, fontSize: 18, color: 'DDDDDD', valign: 'top' });
  }
  await pptx.writeFile({ fileName: `${title.replace(/[^\w-]+/g, '-')}.pptx` });   // triggers the download
}
```

- `addImage({ data: 'image/png;base64,…' })` or `{ path: url }` for pictures; `addChart(pptx.ChartType.bar, data, opts)` for a native chart.
- `addNotes('…')` puts speaker notes on a slide.
- Every text box needs `x, y, w, h` in inches. Overflow is clipped, not wrapped to a new slide — cap bullets at ~6 per slide.

## A Word document (.docx)

```js
async function buildLetter({ to, from, subject, paragraphs }) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: subject, heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({ text: `To: ${to}`, bold: true })] }),
        ...paragraphs.map((p) => new Paragraph({ text: p, spacing: { after: 200 } })),
        new Paragraph({ text: from, alignment: AlignmentType.RIGHT }),
      ],
    }],
  });
  const blob = await Packer.toBlob(doc);
  download(blob, `${subject.replace(/[^\w-]+/g, '-')}.docx`);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- Tables: `new docx.Table({ rows: [new docx.TableRow({ children: [new docx.TableCell({ children: [new Paragraph('cell')] })] })] })`.
- Images: `new docx.ImageRun({ data: arrayBuffer, transformation: { width: 300, height: 200 } })`.
- Page breaks: `new Paragraph({ children: [new docx.PageBreak()] })`.

## What the visitor sees

The build takes a moment on a long document. Disable the button and say "Building your deck…"
while it runs, then "Downloaded" — a button that does nothing for two seconds reads as broken.
Build from the app's OWN data (`AcuvoData`, the form, the table on screen): a deck generator that
ignores what the visitor typed is a demo, not a product.

## Not this

- A page that *looks like* slides (a carousel) is `web-app-quality`, not this.
- A PDF is `jspdf` (see `vendor-shelf`). Do not build a .docx and tell the visitor it is a PDF.
- A .pptx FILE ON DISK with no page to host a button (a terminal run): if `make_document` is among
  your tools, write the slides as ONE HTML file (one 16:9 section per slide) and call it with
  `format: "pptx"`. Never hand-write the ZIP and OOXML — a real run spent 17 rounds doing that.
- Reading an EXISTING .pptx/.docx the visitor uploads is not on the shelf; say so rather than
  pretending with `FileReader` and a regex.
