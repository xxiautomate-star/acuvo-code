---
name: acuvo-design-system
description: How to make a generated page look designed rather than templated, under Acuvo's CSP
when: Building or restyling any user-facing page, component or app
---

# Making it look designed

## ⚠️ THE CONSTRAINT THAT DECIDES EVERYTHING: the CSP

Generated apps run under a strict Content-Security-Policy. **No external
stylesheet, script, font host or CDN will load.** The only external origin that
works is Google Fonts.

So:

- **Never** `<link>` a CDN stylesheet, never `<script src="https://cdn...">`.
  It fails silently and the page renders unstyled — which reads as "the AI is
  bad at design" when it was a network refusal.
- **Vendor it instead.** Write the CSS into the project. If a component library
  is genuinely needed, inline the handful of rules actually used.
- Images and media must be same-origin or `data:` URIs.

⭐ This is the single biggest measured cause of ugly output. It is not a taste
problem.

## The look

**Type.** One display face and one text face, maximum. Google Fonts is allowed —
use it. A serif display over a clean sans body reads premium; two sans faces read
like a template. Set `font-feature-settings` and real line-height (1.5–1.65 body,
1.05–1.2 display).

**Space is the design.** Most weak pages are weak because everything is 16px
apart. Use a scale (4 / 8 / 12 / 16 / 24 / 32 / 48 / 64) and let the important
things have room. Section padding should be 2–4× what feels right at first.

**Colour.** One ink, one paper, one accent, and greys derived from the ink rather
than pure `#888`. Pure black on pure white is a tell. Prefer near-black
(`#1a1713`) on warm paper (`#f3f3f3`) over `#000` on `#fff`.

**Depth without drop shadows.** Hairline borders (`1px` at 6–10% ink) plus a very
soft shadow beats a heavy `box-shadow`. Two competing shadows look amateur.

**Motion.** Transitions on hover/focus at 150–300ms, `ease-out`. Never animate
layout properties (`width`, `top`) — animate `transform` and `opacity`.
`prefers-reduced-motion` must disable them.

## Designed states — the thing that separates real apps from demos

Every list, table and data view needs FOUR states, and they must not look alike:

1. **Loading** — a skeleton with the shape of the real content, not a spinner.
2. **Empty** — says what will fill it and how. "No invoices yet — create your
   first one" beats "No data".
3. **Error** — says what failed and what to do. Never a blank region.
4. **Populated.**

⚠️ An empty state and a failed load must render DIFFERENTLY. If they look the
same, a broken page looks merely new, and nobody reports it.

## Responsive

Design the small screen first. Real content must never cause horizontal page
scroll — wide tables and code blocks get their own `overflow-x: auto` container
instead. Use `clamp()` for display type rather than three breakpoints.

## Before calling it done

- Does it look like it was made for THIS content, or could the copy be swapped
  for any other product?
- Is there one clear focal point per screen?
- Are the four states designed?
- Does it work at 360px wide?

## ⭐⭐⭐ THE TOOLBOX — two files you can reference for free

**Multi-file output only.** Reference either and it is written into the project
for you; never paste their contents, and never fetch them from a CDN.

```html
<link rel="stylesheet" href="acuvo-ui.css">
<script src="acuvo-motion.js" defer></script>
```

### `acuvo-ui.css` — the things a page cannot fake

A modern reset, a **fluid type scale** (`--step--1` … `--step-4`, all `clamp()`),
a designed dark mode via `prefers-color-scheme`, and primitives with real states:
`.card` `.card-hover` `.btn` `.btn-ghost` `.field` `.label` `.chip` `.eyebrow`
`.lead` `.divider`. Layout helpers: `.wrap` `.wrap-narrow` `.section` `.stack`
`.row` `.grid` (auto-fit, `--min` to tune).

⭐ **Restyle it with variables, do not fight it.** `--accent`, `--radius`,
`--font`, `--ink`, `--bg`, `--line` are the knobs. Setting `--accent` and a
Google font is usually the whole brand.

### `acuvo-motion.js` — the 90% of motion that reads as designed

Attributes, no API to learn:

| attribute | what it does |
|---|---|
| `data-reveal` | fades and lifts in when scrolled into view |
| `data-stagger="70"` | reveals the element's CHILDREN in sequence, 70ms apart |
| `data-count="900"` | counts a number up on first view, keeping its prefix/suffix (`$1,250` works) |
| `data-parallax="0.2"` | gentle transform-only parallax |

⚠️ **Everything is disabled under `prefers-reduced-motion`, and that is not
negotiable.** Motion someone did not consent to is an accessibility defect.
`data-count` also keeps the element's original text, so the page reads correctly
with JavaScript off.

## ⚠️⚠️ WHAT THE TOOLBOX DOES NOT DO — do not reach for a CDN

There is no timeline choreography, no physics, no chart library. **A generated
app may load a stylesheet from Google Fonts and NOTHING ELSE, and no external
script at all** — that is the Content Security Policy, it is deliberate, and a
`<script src="https://cdn…">` will be refused by the browser rather than
silently degrade.

⭐ So build the rest with inline CSS and SVG, which you are good at. A hand-drawn
SVG bar chart beats a blocked library every time.
