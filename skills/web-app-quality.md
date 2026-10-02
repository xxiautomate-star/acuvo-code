---
name: web-app-quality
description: What makes a generated app actually work — state, persistence, accessibility, edge cases
when: Building an interactive app, tool or anything with user input
---

# Making the app actually work

## Persist by default — and `localStorage` is NOT where records go

An app that forgets everything on refresh feels broken even when it is
functionally correct. So persist. **But not to `localStorage`.**

```js
✗ localStorage.setItem('myapp:v1', JSON.stringify(habits));   // gone on the next reload
✓ await AcuvoData.set('habits', id, { name, days });          // survives, on any device
```

⚠️⚠️ **In this runtime `localStorage` is not the browser's `localStorage`.** The
page is sandboxed into an opaque origin, so the real one throws on access and the
platform swaps in an in-memory object. It never errors. It just forgets — and it
forgets in the preview pane the owner is watching, which is where you will
"verify" that it worked.

⭐ **The line is OWNERSHIP, not lifetime.** Every record the app owns — tasks,
habits, bookings, expenses, contacts, enquiries, entries, scores — goes in
`window.AcuvoData`, which is already on `window` before your first script runs.
`localStorage` keeps exactly one class of thing: how this one visitor likes the
screen — theme, collapsed sidebar, last filter. Three examples, and that is the
whole list.

⚠️ *"It's just one person's data"* is not a reason to skip the store. One person
still uses a phone and a laptop, and clears a cache.

**Read `state-management` before you type either word**: six verbs, the
`{ items, total }` shape, key rules, caps, the async render order (else an empty
list drawn once). **Records app?** `read_skill("app-patterns")`: a working
form → AcuvoData → list to EDIT, not invent.

## Input, and the cases that break it

Handle every one of these before saying done:

- **Empty submit** — do nothing, or say what is required. Never add a blank row.
- **Whitespace only** — `.trim()` before validating.
- **Duplicate** — decide: reject, merge, or allow. Do not crash.
- **Very long input** — clamp or wrap. One 500-character word must not break layout.
- **Numbers** — reject `NaN`. `Number('')` is `0`, which silently accepts empty.
- **Zero and negative** — a quantity of 0 is different from no quantity.

## Keyboard and accessibility

- Every interactive thing is a `<button>` or `<a>`, never a `<div onclick>`.
- `Enter` submits the form the user is in; `Escape` closes what just opened.
- Visible focus rings. Do not `outline: none` without a replacement.
- Labels tied to inputs (`<label for>`), and `aria-label` on icon-only buttons.
- Colour is never the only signal — pair it with text or an icon.

## ⭐⭐ The four states. This is what separates an app from a demo.

Every list, table, chart and dashboard needs all four, and they must not look alike.

```html
<!-- 1. LOADING — the SHAPE of the content, not a spinner. aria-busy on the card. -->
<div class="card stack" aria-busy="true">
  <div class="skeleton skeleton-line" style="width:40%"></div>
  <div class="skeleton skeleton-line"></div>
</div>

<!-- 2. EMPTY — names what goes here AND how to start -->
<div class="empty"><h3>No invoices yet</h3>
  <p>Invoices you create show up here with their status and due date.</p>
  <button class="btn">Create your first invoice</button></div>

<!-- 3. ERROR — names what failed AND the way out. role="alert" is required. -->
<div class="notice notice-bad" role="alert">
  <div><strong>Couldn't load invoices.</strong>
    <div class="small">The server didn't respond. Your data is safe.</div></div>
  <button class="btn btn-ghost small" onclick="load()">Try again</button></div>
<!-- 4. POPULATED -->
```

⚠️⚠️ **If empty and error look the same, a broken page reads as merely new and
nobody reports it.** That is the actual cost, and it is why this is a
correctness rule rather than a styling preference.

⭐ **A skeleton must match the real layout** — three lines where three lines will
be, a 16/9 box where the image will be. A wrong-shaped skeleton produces a
visible jump on load, which is worse than a spinner.

⭐ **First-run is a fifth state and it is the one that sells the product.** An
empty dashboard on day one should not say "No data". Show what it looks like
full, with sample rows marked as samples, and one obvious action.

## ⭐ Choosing the pattern — the decisions that make it feel like a product

Everything above is correctness. This is the vocabulary: picking the RIGHT
container for a piece of UI is most of what separates an app from a demo.

### Where does this interaction go?

| the work is… | put it in… |
|---|---|
| one field, reversible (rename, toggle, quantity) | **inline** — edit in place, save on blur |
| a short focused decision that must block (confirm, one form) | **modal** |
| a side task done WHILE looking at the main thing (filters, details, a record) | **drawer / side panel** |
| substantial, or worth linking to | **its own page with a URL** |

⚠️ **A modal that scrolls should have been a page.** If it needs its own
sub-navigation, tabs, or more than ~7 fields, it is a page pretending. And
never open a modal from a modal — that is a routing problem wearing a costume.

### Use the desktop — one card floating in a 1400px canvas is not an app

Measured 2026-09-07 on a shipped to-do app: a 560px card centred in a 1400×900
viewport, two-thirds of the screen empty. Lovable and Replit output for the same
brief ships an **app shell**: a slim left nav or sidebar (views, filters, tags),
the working area filling the rest, and a detail pane or drawer for the selected
item. At ≥1024px:

- The app **fills the width** with a shell — `grid-template-columns: 240px minmax(0, 1fr)`
  (or `minmax(0, 1fr) 360px` for list + detail). ⚠️ Never a bare `1fr` in a
  shell: it grows to its widest child (a table, a chart) and the whole page
  scrolls sideways at 390px — measured, 612px wide. A kanban board or a week
  grid wider than the phone scrolls inside its OWN `overflow-x:auto` box, like a
  table (a board measured 1148px at 390). Reading-width limits are for prose, not
  for the tool. Below 1024px the sidebar collapses to a top bar or a sheet.
- ⚠️⚠️ **That is true on a DESKTOP too, and the scroll must be SEEN.** A 6-stage
  CRM board shipped wider than the preview with three columns simply gone — no
  scrollbar, no hint they existed. Give columns a real width
  (`grid-auto-flow: column; grid-auto-columns: minmax(16rem, 1fr)`), put
  `overflow-x: auto; min-width: 0` on the board and `tabindex="0"` so a keyboard
  can scroll it, never `overflow: hidden` on any ancestor, and never hide the
  scrollbar. Say that more exists — a count in the header ("6 stages →") — and
  check at 1280px AND at the preview's own width, which is narrower.
- The shell carries the app's **second and third jobs** — filters, saved views,
  counts, a settings or theme control — so the desktop earns its space instead
  of enlarging the phone layout.
- A single-purpose tool (a calculator, a converter) is the exception: centre it,
  but give it a two-column layout at desktop (inputs left, result right).

### Tables — the thing generated apps get most wrong

A `<table>` of raw values is not a data view. A real one has:

- **Right-aligned numbers, left-aligned text, tabular figures**
  (`font-variant-numeric: tabular-nums`) so digits line up down the column.
- A **sticky header** once it scrolls, and its own `overflow-x: auto` wrapper —
  never let a table scroll the page.
- **Row actions revealed on hover/focus**, not five buttons on every row. They
  must still be reachable by keyboard, so use `:focus-within`, not `:hover` alone.
- **Sort on the columns people actually sort by**, with the direction visible.
- **Selection and bulk actions in a bar that appears when something is selected**
  — and it says how many ("3 selected"), because acting on the wrong count is
  the expensive mistake.
- On a phone, a table becomes a **list of cards**. It does not become a
  horizontally scrolling table nobody can read.

### First run is a designed screen, not a blank one

**The empty state IS the onboarding** — it is the first thing every user sees
and the only screen guaranteed to be reached. It should name the thing, say what
it will do, and offer the one action that fills it. "No invoices yet — create
your first one" plus a button. Not "No data".

⭐ Better still, seed it: a sample row, clearly labelled as a sample and
one-click removable, teaches the shape of the app faster than any tour.

⚠️⚠️ **Seed ONCE, gated on a marker — never on "the list is empty".** An
`if (!items.length) seed()` puts the samples back the moment the owner deletes
the last one (or clears them), so the empty state can never be reached — 4 of 5
generated apps did exactly this.

```js
async function seedOnce() {
  if (await AcuvoData.get('meta', 'seeded')) return;       // ✗ not `if (total === 0)`
  for (const s of SAMPLES) await AcuvoData.set('tasks', newId(), { ...s, sample: true });
  await AcuvoData.set('meta', 'seeded', { at: Date.now() });
}
// "Clear samples" removes only rows with `sample: true`, and leaves the marker.
await seedOnce();                 // ⚠️ BEFORE the first render, not in a sibling effect:
render(html`<${App} />`, root);   // a screen that reads while the seed is writing opens empty
```

⚠️ Measured: a booking app seeded in its root `useEffect` while the Book screen
read services in its own — the first visit said "No services to book yet" under
a banner reading "Showing 7 sample records".

### Telling the user something happened

- **Inline, next to the cause**, for anything they can fix — a field error
  belongs under the field, not in a toast that vanishes.
- **A toast** for background success ("Saved", "Invite sent"). It must be
  dismissible, must not cover the action that triggered it, and must never
  carry the only copy of important information.
- **Optimistic updates need a rollback path.** Showing success before the write
  lands is good; showing success when the write failed is a lie.
- ⚠️ **A spinner with no time bound is an unfinished state.** After a few
  seconds, say what is happening or offer a way out.

### Density and shortcuts

Decide the density once (see `page-composition`) and hold it: a tool people live
in all day wants tight rows and small type; a thing used once a month wants air.

If people use it daily, `/` to search and `Escape` to close cost almost nothing
and are the first thing power users look for. Never bind a shortcut that steals
a browser one, and never bind a destructive action to a single key.

## Destructive actions

Deleting needs either a confirm or an undo. Undo is better: it keeps the app
fast and forgiving. A confirm dialog on every delete trains people to click
through it.

⚠️⚠️ **A confirm is a step ON THE PAGE — "Delete" → "Sure? Yes / Cancel", or a
`<dialog>` whose button runs the delete — never `window.confirm()`.** The
preview and the share link are sandboxed without `allow-modals`: `confirm()`
returns `false` without asking, so `if (!confirm('Delete?')) return;` never
deletes anything (1 of 5 generated apps; measured).

## Numbers and dates

- Format money with `Intl.NumberFormat`, never `toFixed(2)` plus a `$`.
- Dates with `Intl.DateTimeFormat` — never build a date string by hand.
- Show relative time ("2 minutes ago") for recent things, absolute for old.

## Before calling it done

Run through it as a user: add something, refresh, edit it, delete it, undo,
submit an empty form, paste a wall of text, use only the keyboard. Every one of
those is a bug people actually hit.
