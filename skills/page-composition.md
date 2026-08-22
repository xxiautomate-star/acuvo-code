---
name: page-composition
description: Visual hierarchy, whitespace and section anatomy — why a technically correct page still looks generated
when: Laying out any marketing page, landing page or app screen, or when output looks flat and evenly grey
---

# Composition

`css-layout` covers the mechanics — grid, flex, gap, breakpoints. This is the
layer above it: **where things go and how big they are relative to each other.**
A page can be flawlessly implemented and still look generated, and this is
almost always why.

## ⚠️ The failure has a shape: everything is the same size

Generated pages tend toward uniformity — three equal cards, then three more,
each section the same height, the same padding, the same weight. Nothing
dominates, so the eye has nowhere to land, and the page reads as a list rather
than a designed thing.

⭐ **Every screen needs ONE dominant element.** In a hero it is the headline. In
a dashboard it is the number that matters. Make it dominant by **scale
contrast**, not decoration: 3–4× the body size, not a border and a badge.

## Whitespace is the material, not the gap

- **Space between sections should be 3–5× the space inside them.** That single
  ratio is most of what separates a designed page from a template. If section
  padding is `24px`, the space between sections is `96–120px`, not `32px`.
- ⚠️ **Generated pages are almost always too tight.** When unsure, add more.
  Cramped reads as cheap; generous reads as confident.
- Group by proximity. A label 4px from its input and 40px from the next field
  needs no box drawn around it. **Proximity beats borders** — reach for space
  before reaching for a card.

```css
section        { padding-block: clamp(4rem, 10vw, 8rem); }
.section-inner { display: grid; gap: 1.5rem; max-width: 72rem; margin-inline: auto; padding-inline: 1.5rem; }
```

## Break the symmetry, deliberately

Three equal columns is the default and the default is what looks generated.

- **Asymmetric splits read as designed**: 7/5, 8/4, 2fr/3fr. A hero with text
  at 55% and an image at 45% has tension; 50/50 has none.
- **Vary the rhythm down the page**: full-bleed, then contained, then two-up,
  then contained. Four identical stacked sections is the problem.
- ⚠️ **Do not centre everything.** Centred headline, centred paragraph, centred
  button, section after section — it is the most common generated-page shape
  there is. Left-align body content; centre only short, deliberate moments.

## Landing page anatomy — what earns its place

In order. Each section answers one question and then gets out of the way.

1. **Hero** — *what is this and who is it for?* One headline (a claim, not a
   slogan), one sentence of support, one primary action. Optionally one real
   image. ⚠️ Not three buttons, not a feature list.
2. **Proof** — *why believe you?* Logos, a number, a testimonial with a real
   name and role. Immediately after the hero, because it is the first objection.
3. **What it does** — 3–4 concrete capabilities in the customer's words.
   Outcomes, not features.
4. **How it works** — 3 steps. This is where a diagram or screenshot earns
   its place.
5. **Objection handling** — pricing, FAQ, guarantee. Whatever the actual
   hesitation is for that business.
6. **Close** — the same action as the hero, restated. Someone who read to the
   bottom is ready; do not make them scroll back up.

⭐ **Cut before adding.** A five-section page where every section does work
beats a nine-section page padded with "Our Values". If a section does not answer
one of those questions, delete it.

## Images

- **A real photograph is worth more than any amount of decoration.** Use the
  image marker so a real one is generated rather than a grey box.
- **Give images a job.** A hero image should show the thing or the person, not
  an abstract swoop. For a trade business: the van, the work, the person. For a
  product: the product in use.
- Always `object-fit: cover` with a fixed aspect-ratio so layouts do not jump:
  `aspect-ratio: 16/9; object-fit: cover; width: 100%`.
- ⚠️ Never a stock-photo handshake, never a generic "team in a meeting". It
  reads as filler and undercuts everything around it.

## Density is a choice you make once

A marketing page is **spacious** — few elements, large type, lots of air.
A dashboard is **dense** — small type, tight rows, many things visible.

⚠️ Mixing the two is jarring. A dashboard with hero-sized headings wastes the
screen; a landing page with dashboard density looks like a spreadsheet. Decide
which the brief is asking for before setting a single size.

## Before calling it done

- One element on each screen is clearly dominant.
- Space between sections is several times the space inside them.
- At least one section breaks the symmetry of the others.
- Not everything is centred.
- Every section answers a question a visitor actually has.
- At 320px it is still one readable column, and nothing overflows sideways.
