---
name: typography
description: Type scale, pairing, measure and rhythm — the largest single lever on whether a page reads as designed
when: Any page with words on it, which is every page. Read before choosing fonts or sizes.
---

# Typography

Most generated pages fail here before they fail anywhere else. The colours are
fine, the layout is fine, and it still looks like a template — because every
heading is bold, every size is a round number, and the body text runs the full
width of a monitor.

## ⭐ The four decisions, in the order they matter

1. **Measure** — how wide a line of body text is.
2. **Scale** — the ratio between sizes.
3. **Weight contrast** — how far apart the heaviest and lightest are.
4. **Which fonts** — genuinely last. A well-set page in one system font beats a
   badly-set page in two beautiful ones.

## 1. Measure: 60–75 characters, always

```css
.prose { max-width: 68ch; }
```

`ch` is the width of a "0", so `68ch` is roughly 68 characters *at that font
size* — it stays correct when the size changes, which a `max-width: 720px` does
not.

⚠️ **This is the most common single defect in generated pages.** Body text
spanning 1400px is unreadable, and it is unreadable in a way people feel
without being able to name. Headings may run wider (they are short); body,
never.

## 2. A scale, not arbitrary sizes

Pick a ratio and multiply. Do not choose sizes by feel — that is what produces
`18px` next to `19px`, a difference nobody can see doing work nobody notices.

| use | ratio 1.25 (calm, editorial) | ratio 1.333 (louder, marketing) |
|---|---|---|
| small print | 0.8rem | 0.75rem |
| body | 1rem | 1rem |
| lead / large body | 1.25rem | 1.333rem |
| h3 | 1.563rem | 1.777rem |
| h2 | 1.953rem | 2.369rem |
| h1 | 2.441rem | 3.157rem |

The vendored system already ships a scale — **use those tokens rather than
re-deriving one.** Two scales in one page is worse than either alone.

⭐ **Hero headings break the scale on purpose.** A landing page hero often wants
`clamp(2.5rem, 6vw, 5rem)` — bigger than the scale's top step. That is a
deliberate exception at one place, not permission to freestyle everywhere.

## 3. Weight and contrast

- Body **400**. Headings **600–700**. That is the whole system for most pages.
- ⚠️ **Do not bold everything.** When four things are bold, nothing is
  emphasised. Emphasis is a ratio, not a property.
- **Contrast size before you contrast weight.** A 2.4rem/600 heading over
  1rem/400 body has far more presence than 1.2rem/800 over 1rem/700.
- Below 500, avoid pairing a light weight with small sizes — it fails contrast
  checks and looks broken on Windows.

## 4. Choosing fonts

Google Fonts is the **only** external font host that loads under our CSP
(see `acuvo-design-system`). Anything else fails silently and the page falls
back to Times New Roman, which is the single most recognisable "the AI failed"
signal there is.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
```

⚠️ **Load only the weights used.** Every extra weight is a real download. Three
is usually right; five is almost never.

**Pairings that reliably work:**

| feel | display / headings | body |
|---|---|---|
| modern product, SaaS | Inter 600–700 | Inter 400 |
| editorial, premium | Fraunces / Playfair Display | Inter / Source Sans 3 |
| technical, developer | Space Grotesk | IBM Plex Sans |
| warm, human, local trade | Bricolage Grotesque | Karla |
| luxury, restrained | Cormorant Garamond | Jost |

⭐ **One family, two weights, is a legitimate and often superior answer.** Inter
600 over Inter 400 with a real size scale looks intentional. Two display faces
fighting each other looks like a template.

⚠️ Never pair two serifs, or two geometric sans. If they are similar enough to
be confused, the pairing reads as a mistake rather than a choice.

## 5. Rhythm — the part that gets skipped

- **Line height scales inversely with size.** Body `1.5–1.7`. Headings
  `1.05–1.25`. A 3rem heading at `line-height: 1.5` has a canyon through it.
- **Letter-spacing likewise.** Large display type wants slightly negative
  (`-0.02em` to `-0.03em`); small caps and overlines want positive
  (`0.08em`–`0.12em`). Body wants none.
- **Space belongs above a heading, not below it.** A heading should sit close to
  the text it introduces and far from the text it follows — that is what makes
  a page scannable. `margin-block: 2.5em 0.6em`.

```css
h2 { font-size: 1.953rem; line-height: 1.15; letter-spacing: -0.02em; margin-block: 2.5em 0.6em; }
p  { font-size: 1rem; line-height: 1.65; max-width: 68ch; }
.overline { font-size: 0.75rem; letter-spacing: 0.12em; text-transform: uppercase; }
```

## 6. Details that separate careful from careless

- Use real punctuation: `"` `"` `'` `—` `…`, not `"` and `--`.
- `text-wrap: balance` on headings, `text-wrap: pretty` on paragraphs. Two
  lines, no orphans, free.
- Numbers in tables: `font-variant-numeric: tabular-nums`, or columns jitter.
- ⚠️ Never centre a paragraph longer than two lines. Centred ragged-left text
  is hard to read because the eye loses the line start.
- `font-size` on `<html>` stays at the browser default. Setting `62.5%` or a px
  value overrides someone's accessibility setting.

## Before calling it done

- Body text is capped near `68ch`. Nothing runs the full viewport.
- Every size comes from the scale (one deliberate hero exception allowed).
- At most three weights are loaded, and all of them are used.
- Headings have tighter line-height than body, and more space above than below.
- The page still reads correctly at 320px and at 200% browser zoom.
