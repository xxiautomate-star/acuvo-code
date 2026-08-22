---
name: data-and-charts
description: Picking a chart that answers the question, and the defaults that make a dashboard readable
when: When building a dashboard, a report, or anything that shows numbers to a person
---

# Data and charts

## Pick the chart from the QUESTION, not from the data

| the question | the chart |
|---|---|
| how has this changed over time? | line |
| which of these is biggest? | horizontal bar |
| what is this made of? | stacked bar — **not** a pie |
| are these two related? | scatter |
| what is the single number right now? | just print the number, large |

⭐ The last row is the one most often over-built. A metric that is one number
should be one number. A gauge, a donut and a sparkline around it are decoration
that makes the number harder to read.

## ⚠️ Never a pie chart for more than five things

People compare angles badly. Past about five slices a pie becomes a legend with
a picture attached, and the reader has to look things up. A horizontal bar chart
sorted descending answers "which is biggest" instantly and takes the same space.

Never a pie for values that do not sum to a meaningful whole.

## Sort bars, unless the order means something

Alphabetical is the wrong default — it scatters the answer. Sort descending by
value. The exceptions are categories with an inherent order: days of the week,
age bands, survey responses from "never" to "always".

## The axis rules that change conclusions

- **Bar charts start at zero.** Truncating the axis exaggerates differences and
  is the single most common way a chart misleads.
- **Line charts need not** start at zero — the shape of the change is the point.
- Label the units. "Revenue" is not a unit; "Revenue (A$, ex GST)" is.

## ⚠️ Show the empty and loading states

A dashboard with no data yet is the state every user sees FIRST, and it is
usually the one nobody designed. Say what will appear and why it is empty:

```
✗ (a blank rectangle)
✓ "No calls yet. This fills in once your first campaign runs."
```

And distinguish **empty** from **failed to load** — see `error-handling`. A
chart that renders zero because the request 500'd is a lie told in pictures.

## Numbers people can read

- Round to the precision that matters: `A$1,284` not `A$1284.3891`
- Thousands separators, always
- Percentages need a base: "12% (of 340 calls)"
- Dates in a form with no ambiguity: `18 Aug 2026`, never `08/09/26`

## Colour carries meaning or it carries nothing

Use one accent for the series that matters and grey for context. A chart where
every series is a different bright colour has told the reader that everything is
equally important, which is never true.

⚠️ Never encode meaning in colour ALONE — about 1 in 12 men cannot separate red
from green. Label the line, or vary the shape.

## Tables are underrated

If the reader's real question is "what exactly was this number", a sorted table
with aligned right-hand numerals beats every chart. Charts are for shape;
tables are for values.
