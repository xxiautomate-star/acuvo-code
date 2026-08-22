---
name: performance
description: Measure before optimising — images, bundle size, the render loop, and the costs that dominate
when: When a page feels slow, before optimising anything, or when adding a dependency or an image
---

# Performance

## ⚠️⚠️ Measure first. Optimising by intuition is how a day disappears.

Intuition about what is slow is wrong often enough that acting on it unmeasured
is gambling. Open the profiler, or time it:

```js
console.time('render'); doTheThing(); console.timeEnd('render');
```

⭐ And know what "slow" means here — a 400ms function called once on load is
irrelevant; a 4ms function called 3,000 times in a scroll handler is the bug.

## The costs that actually dominate a web page

In rough order of how often they matter:

1. **Images.** Usually most of the bytes. Wrong-sized hero images are the single
   most common cause of a slow page.
2. **Blocking requests** in the head — a font, a stylesheet, a synchronous
   script — each one delays first paint.
3. **JavaScript bundle size** — download, then parse, then execute.
4. **Layout thrash** — reading a layout property after writing one, in a loop.
5. Everything else.

## Images

- Size them for the box they land in. A 4000px photo in a 400px card wastes 99%
  of its bytes.
- Modern format (WebP/AVIF) with a fallback.
- `loading="lazy"` for anything below the fold — never for the hero, which is
  the one thing you want early.
- **Always set `width` and `height`** (or `aspect-ratio`). Without them the page
  reflows when each image arrives, which is both ugly and a Core Web Vital.

## The render loop

```js
✗ items.forEach(i => list.appendChild(render(i)));   // layout per item
✓ const frag = document.createDocumentFragment();
  items.forEach(i => frag.appendChild(render(i)));
  list.appendChild(frag);                             // one layout
```

⚠️ **Reading forces a recalculation.** `offsetHeight`, `getBoundingClientRect`
and friends flush pending layout. Reading one in a loop that also writes makes
the browser recompute every iteration. Batch: read everything, then write
everything.

Debounce input handlers; throttle scroll and resize.

## ⚠️ Every dependency is bytes the user downloads

Before adding one, check what it costs and whether a few lines would do. A date
library for one `toLocaleDateString` is a bad trade. Import only what you use —
`import { debounce } from 'lodash-es'`, never the whole namespace.

## Do less work

The fastest request is the one not made, and the fastest render is the one
skipped. Cache what does not change; paginate instead of loading everything
(see `api-design`); do not recompute a derived value on every render when it
only changes when its inputs do.

## ⚠️ Perceived speed is real speed

A skeleton that appears in 100ms feels faster than a blank screen for 400ms and
then everything at once — same total time. Show structure early, respond to
input immediately even if the result takes a moment, and never leave a click
with no visible acknowledgement.
