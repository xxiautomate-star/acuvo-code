---
name: typography
description: Type scale, pairing, measure and rhythm — the largest single lever on whether a page reads as designed
when: Any page with words on it, which is every page. Read before choosing fonts or sizes.
triggers: premium design, looks cheap, looks generic, ai slop, visual design, typography, font, fonts, type scale, headings, spacing, rhythm, make it look good, polish, elegant, luxury, beautiful
version: 2
applies-to: both
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
| clinical, calm, health | Newsreader | Public Sans |
| food, hospitality | Instrument Serif | Figtree |
| sport, gym, high energy | Anton / Archivo Black | Barlow |
| kids, school, playful | Baloo 2 | Nunito |
| finance, legal, trust | Libre Baskerville | Source Sans 3 |
| gallery, photography | Syne | Work Sans |
| events, nightlife | Unbounded | Manrope |
| craft, handmade, market | Gloock | Outfit |

⚠️⚠️ **PICK FOR THE BRIEF — DO NOT DEFAULT TO THE FIRST ROW.** Measured across 40
shipped artifacts: **28 of 34 set `--font-text: 'Inter'`**, and the display face
was Fraunces or Space Grotesk in 28 of 34. Three rows of this table became three
looks, so a visitor who saw two of our sites would recognise the third. A florist,
a law firm and a metal band should not be reaching for the same two faces.

⭐ **Read the row that matches the DOMAIN, not the row you read last time.** If the
brief names a trade, a mood or an audience, that is the choice already made for
you. Inter is the right answer for a SaaS dashboard and the lazy answer everywhere
else.

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
- ⭐ **`text-wrap: balance` on headings is the cheapest polish that exists.**
  Baseline since May 2024, one line, and it is what stops a seven-word hero
  breaking 6 + 1. The orphan is the loudest amateur tell on a landing page.
  `acuvo-ui.css` already applies it to `h1`–`h4`.
  ⚠️ `text-wrap: pretty` is **not** baseline — support is still limited. It is
  harmless (unsupported browsers ignore it) but do not rely on it to fix a
  paragraph; cap the measure instead.
- ⚠️ Balance is capped by the spec at a few lines, so it does nothing for body
  copy. That is `max-width: 68ch`'s job, not this property's.
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

## ⭐ Tested pattern — a fluid type scale from two numbers

Premium pages use FEW sizes, related by one ratio, that grow smoothly with the
viewport. Generate them instead of typing seven unrelated `px` values.

```js
// @selftest — a modular scale emitted as clamp() custom properties
function typeScale({ base = 16, ratio = 1.25, steps = [-1, 0, 1, 2, 3, 4, 5], minVw = 360, maxVw = 1280, grow = 1.15 } = {}) {
  const out = {};
  for (const s of steps) {
    const min = base * ratio ** s, max = min * (s > 0 ? grow : 1);
    const slope = (max - min) / (maxVw - minVw);
    const intercept = min - slope * minVw;
    out[`--step-${s}`] = min === max
      ? `${(min / 16).toFixed(3)}rem`
      : `clamp(${(min / 16).toFixed(3)}rem, ${(intercept / 16).toFixed(3)}rem + ${(slope * 100).toFixed(3)}vw, ${(max / 16).toFixed(3)}rem)`;
  }
  return out;
}
const t = typeScale();
assert.equal(t['--step-0'], '1.000rem');
assert.match(t['--step-3'], /^clamp\(1\.953rem, .*vw, 2\.246rem\)$/);
assert.equal(Object.keys(t).length, 7);                  // seven sizes is the whole system
```

Emit it once into `:root`, then use only `var(--step-N)`. Pair with a
spacing scale on the same ratio (`--space-N`), a measure of **60–75
characters** (`max-width: 68ch`) for body text, `line-height` 1.5 for body
and 1.1 for display, and letter-spacing tightened (`-0.02em`) only on large
headings. Those five decisions separate "designed" from "template".
