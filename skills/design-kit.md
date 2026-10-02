---
name: design-kit
description: The premium kit a build starts from — ax- layout + Basecoat (shadcn/ui for plain HTML) widgets on the page's own tokens, token-themed Chart.js, and 3–4 copyable layouts per kind
when: Laying out a website, app, dashboard, CRM, deck or poster; or needing a dropdown, select, combobox, command menu, tooltip, toast or segmented control
---

# The design kit

Three layers, one look. **Never invent a fourth.**

| layer | what | where |
|---|---|---|
| tokens | `--ink --surface --accent --line --step-* --space-* --radius` | `:root` in `styles/system.css` (already there) |
| page | layout, buttons, cards, fields, tables, nav, pricing, empty states — `ax-*` | `styles/system.css` (already there) |
| widgets | dropdown menu, select, combobox, ⌘K, tooltip, toast, button group — Basecoat | the two `/vendor/` tags below |

Basecoat is shadcn/ui's markup for plain HTML (MIT). **Ours is built on your
tokens**: the same markup is editorial on an editorial page and dark on a
console page. It self-initialises, including markup you add later with
`innerHTML`.

```html
<link rel="stylesheet" href="/vendor/basecoat-css@1.0.2/basecoat.acuvo.css">
<link rel="stylesheet" href="styles/system.css">
<script src="/vendor/basecoat-css@1.0.2/basecoat.min.js" defer></script>
```

⚠️ **Tailwind utility classes (`flex`, `mt-4`, `text-sm`) do nothing here** —
lay out with `ax-*` and tokens. Page buttons stay `ax-btn`; Basecoat's
`.btn[data-variant]` is for the trigger INSIDE a widget.

## Widgets — copy, rename the ids

**Dropdown menu** (row actions, account menu). Ids must be unique per menu.
```html
<div id="m1" class="dropdown-menu">
  <button type="button" id="m1-trigger" class="btn" data-variant="ghost" data-size="icon-sm"
    aria-haspopup="menu" aria-controls="m1-menu" aria-expanded="false" aria-label="Actions">⋯</button>
  <div id="m1-popover" data-popover aria-hidden="true">
    <div role="menu" id="m1-menu" aria-labelledby="m1-trigger">
      <div role="menuitem" data-action="edit">Edit</div>
      <div role="menuitem" data-action="move">Move to stage…</div>
      <hr role="separator">
      <div role="menuitem" data-action="delete">Delete</div>
    </div>
  </div>
</div>
```
Listen once, on the container: `menu.addEventListener('click', e => { const a = e.target.closest('[role=menuitem]')?.dataset.action; … })`.

**Select** (a styled `<select>` that can show options with icons). The hidden
input carries the value into a form; `change` fires on `.select`.
```html
<div class="select" id="stage">
  <button type="button" class="btn" data-variant="outline" id="stage-trigger"
    aria-haspopup="listbox" aria-expanded="false" aria-controls="stage-list"><span>Quoted</span></button>
  <div data-popover aria-hidden="true">
    <div role="listbox" id="stage-list" aria-labelledby="stage-trigger">
      <div role="option" data-value="new">New lead</div>
      <div role="option" data-value="quoted" aria-selected="true">Quoted</div>
      <div role="option" data-value="booked">Booked</div>
    </div>
  </div>
  <input type="hidden" name="stage" value="quoted">
</div>
```

**Combobox** (type to filter a long list): same shape, `class="combobox"`, and
an `<input role="combobox" aria-controls="…-list" aria-expanded="false">` in
place of the trigger button.

**⌘K command menu** — a `dialog`, so focus trap and Esc are free:
```html
<dialog id="cmdk" class="command-dialog" aria-label="Command menu">
  <div class="command">
    <header><input role="combobox" placeholder="Type a command…" aria-controls="cmdk-menu" aria-expanded="true"></header>
    <div role="menu" id="cmdk-menu" data-empty="No results">
      <div role="group" aria-labelledby="cmdk-g"><span role="heading" id="cmdk-g">Go to</span>
        <div role="menuitem" data-keywords="home start">Overview</div>
        <div role="menuitem">New lead</div>
      </div>
    </div>
  </div>
</dialog>
<script>addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); cmdk.showModal(); } });</script>
```

**Tooltip**: `data-tooltip="Copies the link"` (+ `data-side="bottom"`) on any
element. **Segmented control**: `<div class="button-group" role="group">` of
`.btn[data-variant=outline]`; give the chosen one `data-variant="secondary"` and
`aria-pressed="true"`.

**Toast** — one container per page, then call it:
```html
<div id="toaster" class="toaster"></div>
<script>toaster.toast({ category: 'success', title: 'Lead saved', description: 'Moved to Quoted.' });</script>
```
`category`: `success` · `error` · `info` · `warning`. Errors stay 5s, others 3s.

⚠️ Never call `basecoat.theme.set` — it writes `localStorage`, which a published
app does not have. The ground comes from the design system.

## Charts on the tokens

A default Chart.js chart is Chart.js-blue on Helvetica — the tell of a template
dashboard. Read the tokens once, before the first `new Chart`:

```js
const t = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
Chart.defaults.font.family = t('--font-text');
Chart.defaults.color = t('--ink-muted');
Chart.defaults.borderColor = t('--line');
Chart.defaults.plugins.legend.display = false;          // label series in the card header instead
Chart.defaults.elements.line.tension = 0.35;
Chart.defaults.elements.line.borderWidth = 2;
Chart.defaults.elements.point.radius = 0;
Chart.defaults.elements.bar.borderRadius = 4;
const ACCENT = t('--accent');                            // series 1; series 2 = t('--ink-muted')
```
Area fill: `backgroundColor: ACCENT + '1f'` only when `--accent` is a 7-char hex.
Let the axis start at zero for bars; never invert a value axis.

## Layouts by kind — pick one, then write the content

Every block below is `ax-*` only. `ax-band` is a full-width section; its
children centre themselves.

**Website — 1 split hero · 2 proof band · 3 feature grid · 4 CTA band**
```html
<header class="ax-band ax-band-tight"><nav class="ax-nav"><a class="ax-brand" href="#">Saltwater</a>
  <div class="ax-row"><a class="ax-nav-link" href="#lessons">Lessons</a><a class="ax-btn" href="#book">Book</a></div></nav></header>
<section class="ax-band"><div class="ax-split">
  <div class="ax-stack"><p class="ax-eyebrow">Gold Coast · all year</p><h1>Catch your first wave.</h1>
    <p class="ax-muted">One sentence of proof.</p><div class="ax-row"><a class="ax-btn" href="#book">Book a lesson</a><a class="ax-btn ax-btn-quiet" href="#how">How it works</a></div></div>
  <img src="…" alt="…" width="1200" height="900" style="border-radius:var(--radius-lg);aspect-ratio:4/3;object-fit:cover"></div></section>
<section class="ax-band ax-band-tint"><div class="ax-grid">…three ax-card, each an icon, an h3, one line…</div></section>
<section class="ax-band ax-band-ink"><div class="ax-stack" style="text-align:center"><h2>Ready?</h2><a class="ax-btn" href="#book">Book now</a></div></section>
```
Alternate band types (plain → tint → plain → ink). One centred column after
another reads as a template. Pricing: `ax-price`; FAQ: `details.ax-faq`.

**App — sidebar shell · list → detail · centred sign-in**
```html
<div class="ax-sidebar">
  <aside><a class="ax-brand" href="#">Ledger</a>
    <nav class="ax-stack"><a class="ax-nav-link" aria-current="page" href="#">Overview</a><a class="ax-nav-link" href="#">Customers</a></nav></aside>
  <main class="ax-section ax-container">
    <div class="ax-toolbar"><h1 style="margin:0;font-size:var(--step-2)">Customers</h1>
      <div class="ax-row" style="margin-inline-start:auto"><input class="ax-input" type="search" placeholder="Search"><button class="ax-btn">New customer</button></div></div>
    <div class="ax-card" style="padding:0"><table class="ax-table">…</table></div>
  </main>
</div>
```
Sign-in: ONE `ax-card` alone inside an `ax-band` — it centres itself at a
readable width. Never re-template the band's grid.

**Dashboard — KPI row · chart card · table**
```html
<div class="ax-grid"><div class="ax-stat"><span class="ax-stat-label">Revenue</span><strong class="ax-stat-value">$1.57M</strong><span class="ax-stat-delta" data-dir="up">+12%</span></div>…3 more…</div>
<div class="ax-card"><div class="ax-card-head"><h2 style="font-size:var(--step-1);margin:0">Monthly revenue</h2>
  <div class="button-group" role="group"><button class="btn" data-variant="secondary" aria-pressed="true">12m</button><button class="btn" data-variant="outline">90d</button></div></div>
  <div style="height:18rem"><canvas id="rev"></canvas></div></div>
```
Four stats maximum in a row; the chart gets a fixed-height box or it grows forever.

**CRM / board — toolbar · stage columns · card with row menu**: an `ax-toolbar`
(title, `button-group` Board/Table, search, `ax-btn` Add), then an `ax-grid` of
columns, each an `ax-card` whose head is the stage name plus an `ax-badge` count,
holding an `ax-list` of `ax-list-item` cards dragged with `sortablejs`, each with
the dropdown menu above for Edit / Move / Delete.

**Deck**: `read_skill("slides-presenter")`. **Poster**: one sheet sized in mm,
one focal image or drawing, a headline at `--step-3` or larger, and at most three
supporting lines — the page is the design, not a container for cards.

## Before you finish

One accent, used for the primary action and the live state only. Every number in
a table is `tabular-nums` (the `ax-table` already is). Empty, loading, error and
populated states look different. Zero Tailwind classes, zero hand-invented
`--vars` beside the tokens.
