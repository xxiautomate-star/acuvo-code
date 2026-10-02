---
name: data-and-charts
description: Charts that are true — picking the chart from the question, honest axes, colour-blind-safe series, direct labels, and the data shapes that break a chart
when: When building a dashboard, report, stats, totals, a leaderboard, a graph, or anything showing numbers
---

# Data and charts

A technically-working chart that misleads is the normal output, not the rare
one; each rule below stops one way it happens.

## What can actually load a chart library, and what cannot

⚠️⚠️ **A CDN tag is refused by the browser, silently** — the page renders, the
library is `undefined`, and one console line is all the evidence, so it reads
as a broken chart. `{host}/vendor/` is the shelf, always shaped
`/vendor/<package>@<exact-version>/<file>.min.js`. ⭐ A charting package **not**
on the shelf comes in with `add_library`, which downloads it into this
project's own files, which the same policy serves.

⭐ **Never inline one:** Chart.js minified is ~200KB — half an app's hard
`400_000`-byte ceiling. The `<script src>` costs ~**50 bytes**, cached.

⚠️ **Never guess a package is on the shelf.** The exact URLs — including Chart.js
and d3 — are in `vendor-shelf`, the version traps in `vendor-traps`. A library
not named there is not there, and a wrong path 404s **silently**: a blank
rectangle that looks exactly like a chart with a data bug. Classic scripts only —
`type="module"` is fetched in CORS mode and a published app runs in an opaque
origin, so it fails before your code runs.

## ⭐ Default to SVG you draw yourself anyway

For what a dashboard actually needs (under ~200 points, ~6 series) hand-drawn
SVG wins: no version trap, themable with `currentColor`, directly labellable,
and it inherits your type:

```js
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function barChart(rows, { w = 560, h = 220, pad = 28 } = {}) {  // rows: [{ label, value }]
  const max = Math.max(1, ...rows.map(r => r.value));  // the `1` is the empty-array guard
  const bw = (w - pad * 2) / rows.length;
  const bars = rows.map((r, i) => {
    const bh = Math.round((h - pad * 2) * (r.value / max));
    const x = pad + i * bw, y = h - pad - bh, mid = x + bw / 2;
    return `<rect x="${x + 4}" y="${y}" width="${bw - 8}" height="${bh}" rx="3" fill="currentColor"/>`
      + `<text x="${mid}" y="${h - 8}" text-anchor="middle" font-size="11">${esc(r.label)}</text>`
      + `<text x="${mid}" y="${y - 6}" text-anchor="middle" font-size="11">${r.value}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="chart">${bars}</svg>`;
}
```

⚠️ `esc` is not optional — labels are whatever a visitor typed into a public
store; un-escaped, a label is script injection.

A sparkline is `<polyline points="…">`; a donut is one `<circle>` with
`stroke-dasharray`. Canvas is fine too.

**Reach for a library** for interactive tooltips over hundreds of points,
zoom/pan, automatic time ticks, or many-series stacked/combo charts. Below that
it is a dependency for two rectangles.

### ⚠️⚠️ Chart.js ships its OWN look — skin it from the tokens first

Its defaults are grey `#666` ticks, near-invisible gridlines and Helvetica: on a
dark system the axes vanish and the bars come out a flat stock blue. Read the
tokens at runtime, once, **before the first `new Chart()`**:

```js
const css = getComputedStyle(document.documentElement);
const tok = (n) => css.getPropertyValue(n).trim();
Object.assign(Chart.defaults, { color: tok('--ink-muted'), borderColor: tok('--line') }); // ticks, labels, grid
Chart.defaults.font.family = tok('--font-text');
Chart.defaults.font.size = 13;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Object.assign(Chart.defaults.plugins.tooltip, {
  backgroundColor: tok('--surface-raised'), titleColor: tok('--ink'), bodyColor: tok('--ink'),
  borderColor: tok('--line'), borderWidth: 1,
});
const ACCENT = tok('--accent'), QUIET = tok('--line');
```

⚠️ Changing `borderColor` switches off Chart.js's automatic palette, so **give
every dataset its colour**: `backgroundColor`/`borderColor: ACCENT` for the
series that matters, `QUIET` (or the palette below) for the rest. Leave one
uncoloured and a line series is drawn in the gridline colour.

## The numbers come from the store, not from an array you typed

A dashboard whose data is a hard-coded literal is a picture of one.

```js
const { items, total } = await AcuvoData.list('orders', { limit: 200 });
const revenue = items.reduce((n, r) => n + (r.value.amount || 0), 0);
```

⚠️ `list` returns **`{ items, total }`, not an array**, **100 records by default
and at most 200**, and it is **async**. So:

- Compute totals from `items` and label them honestly: if `total > items.length`
  it is "last 100", not "all time".
- Never `.map()` the result of `list` directly — that is `undefined.map`.
- Never render before the `await` resolves (`state-management`).

A search box over records is `AcuvoData.search`, in `live-data`.

## Pick the chart from the QUESTION, not from the data

| the question | the chart |
|---|---|
| how has this changed over time? | line |
| which of these is biggest? | horizontal bar, sorted |
| what is this made of? | stacked bar — **not** a pie |
| are these two related? | scatter |
| how is this spread out? | histogram — an average alone hides it |
| what is the single number right now? | just print the number, large |

⭐ The last row is the most over-built: one number is one number, not a gauge,
a donut and a sparkline.

⚠️ **An average is a claim about a distribution.** "Average response 4 minutes"
where half are 30 s and half 8 min describes nobody. Show the spread: median
plus p90 in text beats a mean in a big font.

⚠️ **Never a pie for more than five slices, or for non-parts.** People compare
angles badly: past ~5 slices a pie is a legend with a picture
attached — use the sorted bar. A pie of values that do not sum to a meaningful
whole ("visits by page", where one visit hits several) is wrong arithmetic.

## The axis rules that change the conclusion

- ⚠️⚠️ **Bar charts start at zero. Always.** Length is the encoding; a truncated
  axis makes 102 look twice 101 — the commonest chart lie, usually a library
  auto-fitting the domain. Set the minimum.
- **Line charts need not start at zero** — the shape of the change is the point —
  but say so: a y-axis starting at 40 must be labelled `40`, not blank.
- ⚠️ **Never two y-axes.** The correlation you see is the one you chose the
  scales to make. Stack two charts on one x-axis instead.
- ⚠️ **A time axis must be time, not a list of rows.** A missing Tuesday plotted
  Mon→Wed draws a line through a day that never happened. Space by date; break
  the line at a real gap.
- **Log scales need saying so.** Label the axis `(log)` — equal distances are
  equal *ratios*, and nobody reads that unless told.
- **Label the units.** "Revenue" is not a unit; "Revenue (A$, ex GST)" is.
- ⚠️ **Percent vs percentage point.** 20% → 25% is "up 5 percentage points" or
  "up 25%". Mixing them is how a chart and its caption disagree.
- **Cumulative charts always go up.** That is not growth; for "are we
  growing" plot the per-period value.

## Colour: two rules, and one palette that survives

**One accent for the series that matters, grey for the rest.** Every series in
its own bright colour says everything matters equally.

⚠️⚠️ **Never encode meaning in hue alone.** ~1 in 12 men cannot separate red from
green. Double-encode: a label, a dash pattern, or a marker shape.

Categorical colours: the Okabe–Ito set, distinguishable under the common
colour-vision deficiencies:

```
#0072B2 blue      #E69F00 orange    #009E73 bluish green   #CC79A7 reddish purple
#56B4E9 sky blue  #D55E00 vermillion #F0E442 yellow        #000000 black
```

⚠️⚠️ **Fill colours, not text colours.** Against white only `#0072B2` (5.19:1)
clears WCAG 4.5:1 — `#D55E00` 3.87, `#009E73` 3.42, `#CC79A7` 3.06, `#56B4E9`
2.31, `#E69F00` 2.25, `#F0E442` **1.32**. Labels stay in your ink colour; the
swatch carries the hue.

⭐ Use them in that order: two series = blue + orange, the safest pair.

**Sequential** scales vary lightness, not hue (one hue pale→dark reads in
greyscale). **Diverging** scales: blue↔orange, never red↔green.

## ⭐ Label the series directly; a legend is a lookup task

A legend makes the reader match a swatch to a name and remember it. On a line
chart put the name at the end of its own line:

```js
// after the polyline for a series ending at (x2, y2) — reserve right padding
`<text x="${x2 + 6}" y="${y2 + 4}" font-size="11" fill="${colour}">${esc(name)}</text>`
```

Use a legend only when direct labels would collide — many short series, or a
stacked bar. Same for bars: the value belongs at the end of the bar, not on a
distant y-axis.

## ⚠️ The data shapes that break a chart, and what to draw instead

Every one of these ships as a blank rectangle by default.

| shape | what a chart does | what to draw instead |
|---|---|---|
| **0 rows** | empty axes, or `-Infinity` from `Math.max()` of an empty array | the empty state: "No orders yet. This fills in after your first sale." |
| **1 point** | a line with nothing to connect | the number, large, plus "1 day of data — a trend needs a week" |
| **2–4 points** | a "trend" that is noise | the numbers, and no trendline |
| **~1,000+ points** | 1,000 DOM nodes; frame rate into the floor | aggregate to a coarser period (daily→weekly), or draw to `<canvas>` |
| **one huge outlier** | every other bar is 1px tall | keep the scale honest and annotate it; never clip it silently |
| **a negative value** | a bar drawn upward, or off-canvas | a zero line with bars both sides |

## Show loading, empty AND failed — they are three different screens

**Loading** → the chart frame with a shimmer. **Empty** → the empty-state line
from the table above. **Failed** → "Couldn't load your orders — <the error
message>" plus a Retry button. A chart that renders zero because the read failed
is a lie told in pictures. `error-handling` covers why `.catch(() => [])` turns
the third into the second; `web-app-quality` has the markup for all four states.

## Numbers people can read

- Round to the precision that matters, thousands separated: `A$1,284`
  (`n.toLocaleString()`), not `A$1284.3891`
- Axis ticks compact, the tooltip exact:
  `new Intl.NumberFormat('en-AU', { notation: 'compact' }).format(1284000)` → `1.3M`
- Percentages need a base: "12% (of 340 calls)"
- Dates with no ambiguity: `18 Aug 2026`, never `08/09/26`
- **Right-align numerals and use `font-variant-numeric: tabular-nums`**, so digits
  line up and magnitudes compare at a glance.

## A chart is an image to a screen reader unless you help

⭐ `aria-label="chart"` says nothing. Give it a `<title>` and a `<desc>` that is
the *sentence you would say out loud* about the shape — the markup is in
`accessibility`. Where a reader might need exact values, put a real `<table>`
next to it — visually hidden is fine.

⭐ **Tables are underrated.** If the real question is "what exactly was this
number", a sorted table beats every chart. **Charts are for shape; tables are
for values.** A dashboard that shows both, and lets the chart be small, is
usually the right answer.

## Before calling a chart done

- A bar chart's axis starts at zero? The series tell apart in greyscale?
- Does the title state the *finding*, not the field name? "Revenue up 34% since
  June" beats "Revenue".
- Draw it with zero rows and with one row — does it still make sense?
- Does the number in the caption use the same rounding as the number on the axis?
