---
name: page-composition
description: Information architecture, navigation, visual hierarchy and section anatomy — structure across screens and within one
when: Structuring a site or app, laying out any page or screen, or when output looks flat and evenly grey
---

# Composition

`css-layout` covers the mechanics — grid, flex, gap, breakpoints. This is the
layer above it: **where things go and how big they are relative to each other.**
A page can be flawlessly implemented and still look generated, and this is
almost always why.

⭐ In the builder, `design-kit` holds the concrete version of this page: 3–4
copyable layouts per kind (website, app, dashboard, CRM) composed from the
`ax-` classes already in your project.

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

## Information architecture — the layer above the page

Everything above is *within one screen*. This is the decision that comes first:
**how many screens there are, what each is for, and how someone gets there.**
Get it wrong and no amount of composition rescues it — you get a beautiful page
nobody can find.

### ⭐ One sentence per screen, written before any markup

Write the list before you build: *"Pricing — what it costs and what happens if
I outgrow it."* If you cannot write the sentence, the screen has no job and
should be a section of another screen. If two sentences are nearly the same, it
is one screen.

### ⚠️⚠️ A screen with no door does not exist

**This is the failure that actually happens, and it is silent.** Measured in
this codebase on 2026-08-07: **71 pages existed and 6 were in the navigation.**
Sixty-five were reachable only by typing a URL — every one of them built,
tested, working, and invisible. Nobody reported them broken, because to report
it you must first find it.

⭐ So the rule is: **build the door in the same change as the room.** A screen
that ships without an entry point is not "done pending navigation"; it is a
screen that does not exist yet. Before finishing, list every screen and name the
click path to it from the home screen. Any screen with no path is the bug.

### Top level: 5 ± 2, in the visitor's words

- More than seven top-level destinations and people stop reading the nav and
  start scanning it, which is when they miss things.
- **Label by what the visitor wants, not by how you built it.** "Pricing", not
  "Plans & Packaging". "Your bookings", not "Records". A label naming an
  internal concept is a label that gets skipped.
- ⚠️ **Never invent a top-level section to solve a placement problem.** If
  something has nowhere to live, that is information about the structure — not a
  licence to add an eighth door. Push it down, or ask.
- Depth is cheaper than width. Three levels of six beats one level of thirty.

### Pick the pattern from the shape of the content

| shape | pattern |
|---|---|
| 3–7 destinations, marketing or a small app | **top bar** |
| many destinations, or a persistent working context | **sidebar** |
| a few views of the SAME object (Overview / Activity / Settings) | **tabs** |
| one long page, 4+ major sections | **sticky section nav**, below |
| rare, secondary, or per-object actions | a **menu**, not a door |

⚠️ Tabs are for views of one thing. Using tabs to hold unrelated destinations is
how a nav ends up with "Settings" as a tab inside "Dashboard".

### Progressive disclosure — the default answer for "where does this go?"

Show the 20% that 80% of people need; put the rest one click deeper behind an
honest label. Advanced options, danger zones, integrations and raw data belong
below the fold or behind "Advanced", never on the first screen. **An interface
that shows everything is not powerful, it is unsorted.**

Settings live in one place, grouped by noun (Account, Billing, Notifications),
never scattered as gear icons across the app.

### Routes mirror the structure

`/projects/:id/settings` tells you where you are, what its parent is, and what
happens on back. `/page3` and `/view?type=2` tell you nothing, and neither can
be linked to, bookmarked or shared. **If the URL cannot be pasted to a colleague
and land them on the same view, the screen is not really addressable.**

Keep the breadcrumb honest: it should match the route, and the back button must
do the obvious thing.

### ⭐ Sticky section nav for a long page (4+ sections)

For a single long page — a recap, an audit, a docs page — a table of contents
that tracks scroll position is the whole navigation. It costs no dependency and
no external request, which matters under the CSP.

```html
<div class="wrap">
  <nav class="toc" id="toc">
    <a href="#s1">1. First</a>
    <a href="#s2">2. Second</a>
  </nav>
  <div class="main">
    <h2 id="s1">1 — First</h2>
    …
  </div>
</div>
```

```css
.wrap { max-width: 1400px; margin-inline: auto; display: grid;
        grid-template-columns: 180px 1fr; gap: 0 40px; }
.main { min-width: 0; }                      /* see css-layout on min-width */
.toc  { position: sticky; top: 24px; align-self: start; grid-row: 1 / -1;
        max-height: calc(100dvh - 48px); overflow-y: auto; }
.toc a { display: block; padding: 4px 8px; border-left: 2px solid transparent;
         text-decoration: none; }
.toc a.active { border-left-color: var(--accent); }

@media (max-width: 1000px) {
  /* becomes a sticky horizontal strip, not a hidden menu */
  .wrap { grid-template-columns: 1fr; }
  .toc  { position: sticky; top: 0; z-index: 200; display: flex; gap: 4px;
          overflow-x: auto; max-height: none; grid-row: auto;
          background: var(--bg); border-bottom: 1px solid var(--line); }
  .toc a { white-space: nowrap; flex-shrink: 0;
           border-left: none; border-bottom: 2px solid transparent; }
  .toc a.active { border-bottom-color: var(--accent); }
  h2 { scroll-margin-top: 52px; }            /* clear the sticky strip */
}
```

```js
const toc = document.getElementById('toc');
const links = [...toc.querySelectorAll('a')];
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const link = links.find((l) => l.getAttribute('href') === '#' + e.target.id);
    if (!link) continue;
    links.forEach((l) => l.classList.remove('active'));
    link.classList.add('active');
    if (window.innerWidth <= 1000) {
      link.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }
}, { rootMargin: '-10% 0px -80% 0px' });
links.forEach((l) => {
  const el = document.getElementById(l.getAttribute('href').slice(1));
  if (el) io.observe(el);
});
```

⚠️ **Fewer than four sections: skip it entirely.** A three-item TOC is clutter
that costs a column and buys nothing.

*(Section-nav pattern adapted from nicobailon/visual-explainer, MIT — see
`LICENSE-visual-explainer`.)*

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
