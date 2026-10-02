---
name: css-layout
description: Grid vs flex, eight layout primitives, spacing that scales, and stopping horizontal overflow at 320px
when: Laying out a page, aligning a row of cards, or when a layout overflows or scrolls sideways on mobile
---

# CSS layout

A page is not a set of breakpoints. It is a handful of layout *shapes* nested
inside each other, each deciding its behaviour from the space it is given — so
it is responsive with almost no `@media`, and survives being dropped into a
sidebar, a modal or a half-width column, which a breakpoint layout does not.

## Grid or flex — the question answers itself

- **Flex** = one dimension. A row of buttons, a nav bar, a card's inner stack.
- **Grid** = two dimensions, or *"the container decides the shape"* — page
  layouts, galleries, anything with rows AND columns.

Writing `flex-wrap` plus width percentages plus negative margins for a gallery
means you wanted grid:

```css
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1.5rem; }
```

⭐ A responsive gallery with **no media queries at all**.

## Use `gap`, not margins between children

`gap` puts space *between* items, never before the first or after the last.
`margin-right` on every child plus `:last-child { margin-right: 0 }` is the old
workaround and it is still wrong when the row wraps — the last item *of each
line* keeps a trailing margin.

⭐ **Vertical margins between siblings collapse; `gap` does not.** Set 24px and
32px on adjacent elements and you measure 32px; flex or grid with `gap` gives
what you expected.

---

# The eight primitives

> **Provenance.** These shapes and their names (stack, cluster, sidebar,
> switcher, cover, reel, frame, centre) are common CSS-community vocabulary
> popularised by *Every Layout*. That book's text is copyrighted and none is
> reproduced here — the CSS below is written from the box-model behaviour it
> relies on, which is spec, not authorship.

⚠️ `acuvo-ui.css` already ships stack (`.stack`), cluster (`.row`), `.grid`,
`.sidebar` and `.switcher`. Reference it rather than pasting them.

## 1. Stack — vertical rhythm, owned by the parent

```css
.stack > * + * { margin-top: var(--gap, 1rem); }
```

The `* + *` is the point: **no margin before the first child and none after the
last**, so a stack never adds space at its container's edge. Nested stacks each
keep their own `--gap`, so a `<div class="stack" style="--gap:3rem">` of stacks
gives two levels of rhythm from one rule.

⚠️ **Do not put `margin-bottom` on a component.** A component carrying its own
outside space cannot be reused where the spacing differs. Space belongs to the *arrangement*, not the
thing arranged.

## 2. Cluster — things in a line that wrap gracefully

```css
.cluster { display: flex; flex-wrap: wrap; gap: var(--gap, .75rem); align-items: center; }
```

Tag lists, button rows, nav links, meta lines, filter chips.

## 3. Sidebar — two columns, then stacked, with no breakpoint

```css
.sidebar { display: flex; flex-wrap: wrap; gap: var(--gap, 1.5rem); }
.sidebar > :first-child { flex-basis: var(--side, 18rem); flex-grow: 1; }
.sidebar > :last-child  { flex-basis: 0; flex-grow: 999; min-inline-size: var(--main-min, 55%); }
```

**How it decides.** `flex-grow: 999` makes the main column eat every spare pixel,
so the sidebar sits at its `flex-basis`. `min-inline-size: 55%` says main may
never be narrower than 55% of the line — the instant that cannot be honoured
alongside the sidebar, `flex-wrap` puts them on separate lines.

⭐ **The switch point is a property of the CONTENT, not the viewport** — which is
why this works inside a card and a media query does not.

## 4. Switcher — N columns or N rows, never a ragged half-state

```css
.switcher { display: flex; flex-wrap: wrap; gap: var(--gap, 1.25rem); }
.switcher > * { flex-grow: 1; flex-basis: calc((var(--threshold, 32rem) - 100%) * 999); }
```

**Why that works — it looks like a magic number and is not.** `100%` resolves
against the container's width. Container **narrower** than `--threshold` →
bracket positive → ×999 is a huge basis → each item demands more than the whole
line → one item per row. Container **wider** → bracket negative → basis clamps to
`0` → `flex-grow: 1` shares the line → one row of equal columns.

⭐ **Prefer this to `grid auto-fit` for a 3-up feature row: it is all-or-nothing.**
`auto-fit` happily leaves 2 on one line and 1 orphan below, which reads as broken;
a switcher goes 3-across to 3-stacked.

## 5. Cover — a hero centred, never shorter than the fold

```css
.cover { display: flex; flex-direction: column; min-block-size: 100svh; padding: 1.5rem; }
.cover > * { margin-block: auto; }
.cover > :first-child:not(.centred) { margin-block-start: 0; }
.cover > :last-child:not(.centred)  { margin-block-end: 0; }
```

`auto` margins in a flex container absorb free space, so one each side of the
middle child centres it while pinning a header top and a footer bottom — no
absolute positioning, no `translate(-50%)`.

⚠️⚠️ **`100vh` is wrong on mobile — this is the bug behind "the button is under
the browser bar".** `vh` is sized to the *largest* viewport, ignoring the address
bar actually on screen. Use `svh` (always-visible) or `dvh` (resizes as the bar
hides), widely available since December 2022. And prefer `min-block-size` to
`height`: a fixed-height hero clips content at larger font settings.

## 6. Reel — a horizontal scroller that does not break the page

```css
.reel { display: flex; gap: 1rem; overflow-x: auto; overscroll-behavior-x: contain;
        scroll-snap-type: x mandatory; padding-bottom: 1rem; }
.reel > * { flex: 0 0 var(--item, 18rem); scroll-snap-align: start; }
```

⭐ **`overscroll-behavior-x: contain` stops the browser's back-swipe** when someone
flicks past the end — without it, scrolling a carousel navigates away.
⚠️ `scroll-snap-type` does nothing without `scroll-snap-align` on the children.
⚠️ **`overflow-x: auto` implies `overflow-y: auto`** — a dropdown inside a reel is
clipped. Use the top layer (`popover` / `<dialog>`), which no ancestor clips.

## 7. Frame — crop media to a ratio without distorting it

```css
.frame { aspect-ratio: var(--ratio, 16 / 9); overflow: hidden; border-radius: var(--radius); }
.frame > img, .frame > video { inline-size: 100%; block-size: 100%;
  object-fit: cover; object-position: var(--pos, 50% 50%); }
```

⚠️ **The failure this prevents is layout shift, not ugliness.** Without a reserved
box the page reflows and jumps as each image loads. `aspect-ratio` reserves it
before a byte arrives.

⚠️ `cover` crops, `contain` letterboxes. For portraits use `object-position: 50%
30%` — the default centre crop decapitates people.

## 8. Centre — a page column

```css
.centre { box-sizing: content-box; max-inline-size: 68ch; margin-inline: auto; padding-inline: 1.5rem; }
```

`content-box` is deliberate: `max-inline-size` then means *the measure of the
text*, gutter outside it rather than eaten out of it. `68ch` tracks the font
size; `max-width: 720px` does not. To centre both axes: `display: grid;
place-items: center`, never absolute positioning and transforms.

---

## ⚠️ Test at 320px. That is where layouts break.

Not 1440. The failure modes are always the same: a fixed `width` that should be
`max-width`; a long unbroken string forcing horizontal scroll; a table with no
`overflow-x: auto` wrapper; padding that eats the viewport.

⭐ **The body must never scroll horizontally.** Wide content scrolls inside its
own container, not the page.

⚠️ **And that container must LOOK scrollable, at every width.** A kanban board
wider than a desktop preview shipped with its last three columns cut off and no
scrollbar to say they existed. `overflow-x: auto` on the board itself, no
`overflow: hidden` on its ancestors, never hide its scrollbar, and say how many
columns there are.

## ⚠️⚠️ Why it overflows: grid and flex children default to `min-width: auto`

This causes most "I set `max-width` and it still blows out" bugs, invisibly:
nothing in your CSS says `min-width`. A grid or flex
**child** refuses to shrink below its own content width unless you allow it: one
long URL, one wide `<pre>`, one unbroken order number, and it pushes the track
wider than the container.

```css
.grid > *, .row > *, .cluster > *, .sidebar > *, .switcher > * { min-width: 0; }
body { overflow-wrap: break-word; }
```

### ⚠️⚠️ And one case where there is NO CSS fix — do not hunt for one

Never use `display: flex` on an `<li>` to position a `::before` marker:

```css
✗ li { display: flex; align-items: baseline; gap: 6px; }
  li::before { content: '›'; flex-shrink: 0; }
✓ li { padding-left: 14px; position: relative; }
  li::before { content: '›'; position: absolute; left: 0; }
```

With the flex version the remaining text becomes an **anonymous flex item**;
anonymous boxes get `min-width: auto` and you cannot select one to override it.
A list containing inline code overflows and no CSS stops it.

## Aligning a row of cards — the flaw everyone ships

Three pricing cards with uneven copy put their buttons on three baselines.

```css
/* Portable fix: push the last child down. */
.grid > .card { display: flex; flex-direction: column; }
.grid > .card > :last-child { margin-top: auto; }

/* Better where you control the rows: subgrid aligns INTERNALS across cards. */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: 1.5rem; }
.cards > .card { display: grid; grid-row: span 3; grid-template-rows: subgrid; }
```

With `subgrid` each card's rows share the *parent's* track sizes, so every title,
body and button lines up however uneven the copy. Widely available since
September 2023.

## Spacing on a scale, not by feel

Pick a scale (4 / 8 / 12 / 16 / 24 / 32 / 48) and use only those values, held in
custom properties. A layout with `13px` here and `17px` there looks unresolved.

## The modern tools, in order of how often they help

1. **`clamp()`** — fluid type and spacing without breakpoints:
   `font-size: clamp(1.5rem, 4vw, 3rem)`.
2. **Container queries** — ⚠️ a component in a sidebar has no idea the viewport is
   1440px wide; a media query is the wrong instrument. Widely available since
   February 2023; `cqi`/`cqw` scale type with the *card*, not the window.

   ```css
   .card-host { container-type: inline-size; }
   @container (min-width: 30rem) { .card { grid-template-columns: 8rem 1fr; } }
   ```
3. **Logical properties** — `padding-inline`, `margin-block`, `inline-size`.
   Correct in every writing direction and free to adopt.
4. **`aspect-ratio`** — reserve space for media (Frame, above).

## ⚠️ z-index is not a ladder to climb

`z-index: 9999` means someone lost an argument with the stacking context. Define
a small set of layers (base, dropdown, modal, toast) as custom properties and use
those names. z-index applies only to positioned elements; above everything is the top
layer (`<dialog>` / `popover`), not a bigger number.

⚠️ **Do not fight the flow.** `position: absolute` for something that belongs in the document, `100vh` on
mobile, `!important` to beat your own selector — each signals a layout being
forced rather than described.

## Before calling a layout done

- Resize to **320px** *and* to **200% browser zoom**. Both.
- The document never scrolls sideways (wide content: its own box); no `100vh`.
- Every `@media`: could it have been `flex-wrap`, `auto-fit`, `clamp()` or a
  container query? Usually.
- Drop the component into a 300px box. If it breaks, it was viewport-coupled.
