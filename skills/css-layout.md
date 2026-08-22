---
name: css-layout
description: Grid vs flex, spacing that scales, and building layouts that do not break at 320px
when: When laying out a page or component, or when something overflows or will not centre
---

# CSS layout

## Grid or flex — the question answers itself

- **Flex** = one dimension. A row of buttons, a nav bar, a card's inner stack.
- **Grid** = two dimensions, or *"I want the container to decide the shape"*.
  Page layouts, card galleries, anything with rows AND columns.

If you are writing `flex-wrap` plus width percentages plus negative margins to
make a gallery, you want grid:

```css
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1.5rem;
}
```

⭐ That is a responsive gallery with **no media queries at all** — it reflows on
available width, which is what you actually meant.

## Use `gap`, not margins between children

`gap` puts space *between* items and never before the first or after the last.
`margin-right` on every child plus `:last-child { margin-right: 0 }` is the old
workaround, and it is still wrong when the row wraps.

## ⚠️ Test at 320px. That is where layouts break.

Not 1440. The failure modes are always the same:

- a fixed `width` that should be `max-width`
- a long unbroken string (a URL, an email) forcing horizontal scroll —
  `overflow-wrap: anywhere` on the container
- a table with no `overflow-x: auto` wrapper
- padding that eats the whole viewport

⭐ **The body must never scroll horizontally.** Wide content scrolls inside its
own container, not the page.

## Centring

```css
.center { display: grid; place-items: center; }   /* both axes, done */
```

For a page column: `margin-inline: auto` with a `max-width`. Do not use
absolute positioning and transforms for something the layout can do.

## Spacing on a scale, not by feel

Pick a scale (4 / 8 / 12 / 16 / 24 / 32 / 48) and use only those values. A
layout with `13px` here and `17px` there looks unresolved even when nobody can
say why. Put them in custom properties and reference those.

## The modern tools, in order of how often they help

1. **`clamp()`** — fluid type and spacing without breakpoints:
   `font-size: clamp(1.5rem, 4vw, 3rem)`
2. **Container queries** — a component that adapts to ITS box rather than the
   viewport, which is what a card in a sidebar actually needs:
   `@container (min-width: 400px) { … }`
3. **Logical properties** — `padding-inline`, `margin-block`. They do the right
   thing in every writing direction and cost nothing to adopt.
4. **`aspect-ratio`** — reserve space for media and stop the reflow.

## ⚠️ z-index is not a ladder to climb

`z-index: 9999` means someone lost an argument with the stacking context. Define
a small set of layers (base, dropdown, modal, toast) as custom properties and
use those names. And remember z-index only applies to positioned elements.

## Do not fight the flow

`position: absolute` for something that should be in the document, `height:
100vh` on a mobile browser whose chrome hides and reappears (use `100dvh`),
`!important` to beat your own selector — each is a signal that the layout is
being forced rather than described.
