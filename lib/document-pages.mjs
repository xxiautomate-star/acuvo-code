/**
 * ── ⭐ ONE HTML FILE WITH N SLIDES BECOMES N PAGES (2026-09-27) ────────────────
 *
 * Found by using it: asked for "a 6-slide deck … as deck.pptx", a run wrote a
 * correct 6-section HTML file, called `make_document` — and got ONE slide back,
 * the whole page rasterised onto it. The press has always accepted `pages[]`
 * ("pptx: many pages allowed; one slide each", gpu/modal/document_press.py);
 * the CLI only ever sent `html`.
 *
 * So a document whose body holds two or more TOP-LEVEL slide sections —
 * `<section class="slide">` or any element carrying `data-slide` — is split
 * into one self-contained page per slide, each keeping the whole `<head>` (the
 * styles) so every slide renders exactly as it does in the single file.
 * Anything else is left alone: `null` means "send the document whole".
 *
 * No HTML parser (zero dependencies): a depth-counted scan over tags of the
 * slide's own element name, so a slide that nests another <section> stays one
 * slide. A document the scan cannot account for returns null rather than a
 * guess — a wrong split is worse than the single page it replaces.
 */

const OPEN_SLIDE = /<(section|div|article)\b([^>]*)>/gi;
// A class TOKEN of exactly `slide` — never `slide-title` or `slides` (a wrapper
// round every slide would otherwise be taken as the one slide).
const isSlideTag = (attrs) => /(^|\s)data-slide\b/i.test(attrs)
  || (/\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '').split(/\s+/).some((c) => c.toLowerCase() === 'slide');

/** @returns {string[] | null} one full HTML document per slide, or null */
export function splitSlides(html, { max = 60 } = {}) {
  const doc = String(html ?? '');
  const bodyOpen = /<body\b[^>]*>/i.exec(doc);
  const bodyClose = doc.search(/<\/body\s*>/i);
  const bodyStart = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const bodyEnd = bodyClose === -1 ? doc.length : bodyClose;
  const head = bodyOpen ? doc.slice(0, bodyStart) : '<!doctype html><html><head><meta charset="utf-8"></head><body>';
  const tail = '</body></html>';

  const slides = [];
  OPEN_SLIDE.lastIndex = bodyStart;
  let m;
  while ((m = OPEN_SLIDE.exec(doc)) && m.index < bodyEnd) {
    if (!isSlideTag(m[2])) continue;
    const tag = m[1].toLowerCase();
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    scan.lastIndex = m.index + m[0].length;
    let depth = 1;
    let t;
    while (depth > 0 && (t = scan.exec(doc))) depth += t[1] ? -1 : 1;
    if (depth !== 0) return null; // unbalanced: do not guess
    slides.push(doc.slice(m.index, scan.lastIndex));
    OPEN_SLIDE.lastIndex = scan.lastIndex;
    if (slides.length > max) return null;
  }
  if (slides.length < 2) return null;
  return slides.map((s) => `${head}${s}${tail}`);
}
