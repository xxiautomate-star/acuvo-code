---
name: ui-components
description: Working source for modal, menu, tabs, accordion, toast, table and form components
when: Building a modal, dropdown, tabs, accordion, toast, table, form field, or an empty or loading state
---

# Components, as source you can paste

Not a description of components — the source. Paste what you need, delete the
rest, rename the classes. Nothing here installs anything.

## ⚠️⚠️ FIRST: do NOT reach for shadcn/ui, Radix, Headless UI or Material here

Good libraries, right instinct — but **measured, not assumed**: a shadcn *dialog*
paste declares `"dependencies": ["@radix-ui/react-dialog"]`, imports
`lucide-react` and `@/lib/utils` (`clsx` + `tailwind-merge`), and is Tailwind
classes throughout. "Copy-paste, no dependency" is **true of the file and false
of the component** — one paste is five npm packages plus a Tailwind build. In one
`index.html` (most requests) you cannot install, so it is impossible.

⭐ **And the dependency now buys much less than it used to.** `<dialog>` gives a
focus trap, Esc-to-close, an inert background and the top layer natively;
`popover` gives light-dismiss and the top layer; `<details name>` gives an
exclusive accordion. Those *are* what Radix was written to provide. Licences,
checked: shadcn/ui MIT, Radix MIT — allowed, just rarely worth it.

⭐ **The exception needs no install:** Basecoat (MIT) is shadcn's dropdown menu,
select, combobox, ⌘K menu, tooltip and toast for plain HTML, served from
`/vendor/` and built on your design tokens. Markup: `design-kit`.

⚠️ **Any CDN `<script src="https://…">` or `<link href="https://cdn…">` is refused
by Content-Security-Policy** — including the Tailwind CDN. The page renders
unstyled with one console line. See `acuvo-design-system` and `vendor-shelf`.

## Modal — use `<dialog>`, never a `<div>` with `position: fixed`

```html
<button id="openBtn" class="btn">Edit profile</button>

<dialog id="dlg" aria-labelledby="dlgTitle">
  <form method="dialog">
    <h3 id="dlgTitle">Edit profile</h3>
    <label class="label" for="nm">Name</label>
    <input class="field" id="nm" name="name" required>
    <div class="row" style="justify-content:flex-end;margin-top:1.25rem">
      <button class="btn btn-ghost" value="cancel" formnovalidate>Cancel</button>
      <button class="btn" value="save">Save</button>
    </div>
  </form>
</dialog>

<script>
  const dlg = document.getElementById('dlg');
  document.getElementById('openBtn').onclick = () => dlg.showModal();
  // ⚠️ Backdrop click does NOT close a dialog by itself. The `closedby`
  // attribute that would do it has limited support — this is the portable way.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
  dlg.addEventListener('close', () => { if (dlg.returnValue === 'save') { /* commit */ } });
</script>
```

**What `showModal()` gives free and a hand-built div does not:** focus moves in
and is *trapped*; Esc closes; everything behind becomes inert (unclickable,
un-tabbable, hidden from screen readers); it renders in the top layer so no
`z-index` can cover it; `::backdrop` is a real element. Baseline since 2022.

- ⚠️ **`dlg.show()` is not `dlg.showModal()`.** `show()` is non-modal: no
  backdrop, no focus trap, no inert. Reaching for it by accident is why a "modal"
  lets you tab into the page behind it.
- ⚠️ **`method="dialog"` submits without navigating** and sets `returnValue` from
  the pressed button's `value`. A plain `<form>` inside a dialog reloads the page.
- ⚠️ **Cancel must be `formnovalidate`**, or a required field blocks the user
  from cancelling — an infuriating bug that ships constantly.
- Style it and its `::backdrop` — `acuvo-ui.css` already does, including a real
  fade-in via `@starting-style`, which is why hand-built modals *pop* and this
  one does not.

## Menu / dropdown / tooltip — use the `popover` attribute

```html
<button class="btn btn-ghost" popovertarget="menu" aria-haspopup="menu">Options ▾</button>
<div id="menu" popover role="menu" style="position:absolute">
  <!-- each item: role="menuitem" class="btn btn-ghost", width:100%, justify-content:flex-start -->
  <button role="menuitem" class="btn btn-ghost" style="width:100%;justify-content:flex-start">Duplicate</button>
  <hr class="divider">
  <button role="menuitem" class="btn btn-ghost" style="width:100%;justify-content:flex-start;color:var(--bad-ink)">Delete</button>
</div>
```

`popovertarget` needs **no JavaScript at all**: click to open, click outside or
Esc to close (light dismiss), top layer, one popover open at a time. Baseline
since January 2025.

⚠️ **CSS anchor positioning (`anchor-name` / `position-area`) is NOT baseline —
Chromium-only today.** Do not position a menu with it and assume it works.
Accept the default centred placement, or wrap the trigger in `position: relative`
and place the popover absolutely inside it, or set `.style.top/.left` from
`getBoundingClientRect()` on `toggle`.

## Accordion / FAQ / disclosure — `<details>`, and zero JavaScript

```html
<details name="faq" open>
  <summary>How does billing work?</summary>
  <p>Monthly, cancel any time.</p>
</details>
<details name="faq"><summary>Can I export my data?</summary><p>Yes, as CSV.</p></details>
```

```css
details { border-bottom: 1px solid var(--line); }
summary { cursor: pointer; padding: 1rem 0; font-weight: 560; list-style: none;
          display: flex; justify-content: space-between; align-items: center; }
summary::-webkit-details-marker { display: none; }  /* both lines needed to kill the marker */
summary::after { content: '+'; font-size: 1.4em; line-height: 1; transition: transform .2s; }
details[open] summary::after { transform: rotate(45deg); }
```

⭐ **The shared `name` attribute is what makes it an accordion** — opening one
closes its siblings, no script. Baseline since September 2024. Omit `name` and
they open independently, usually what an FAQ actually wants.

⚠️ `<summary>` is already a button: keyboard-operable, correctly announced. Do
not add `role="button"` or a `click` handler that calls `preventDefault`.

## Tabs — the one that genuinely needs JavaScript, done properly

```html
<div role="tablist" aria-label="Sections" class="row" style="--gap:.25rem">
  <button role="tab" id="t1" aria-controls="p1" aria-selected="true"  tabindex="0"  class="btn btn-ghost">Overview</button>
  <button role="tab" id="t2" aria-controls="p2" aria-selected="false" tabindex="-1" class="btn btn-ghost">Pricing</button>
</div>
<div role="tabpanel" id="p1" aria-labelledby="t1" tabindex="0">…</div>
<div role="tabpanel" id="p2" aria-labelledby="t2" tabindex="0" hidden>…</div>
<script>
document.querySelectorAll('[role=tablist]').forEach((list) => {
  const tabs = [...list.querySelectorAll('[role=tab]')];
  const select = (tab) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;                 // roving tabindex
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    tab.focus();
  };
  list.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) select(t); });
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    select(tabs[(map[e.key] + tabs.length) % tabs.length]);
  });
});
</script>
```

⭐ **Roving tabindex is the part everyone omits.** Exactly one tab is
`tabindex="0"`; the rest are `-1`. Tab enters and leaves the strip in one press;
arrow keys move *within* it. Without it a ten-tab page takes ten Tab presses to
walk past — the difference between a real component and a row of styled buttons.

⚠️ Panels are toggled with the `hidden` **attribute**, not `style.display`.
`hidden` also removes them from the accessibility tree and from find-in-page.

## Form fields — `:user-invalid`, not `:invalid`

```css
.field:user-invalid { border-color: var(--bad-ink); }
.field:user-valid   { border-color: var(--ok-ink); }
.field:user-invalid + .err { display: block; }
.err { display: none; color: var(--bad-ink); font-size: var(--step--1); margin-top: .3rem; }
```
```html
<label class="label" for="em">Email</label>
<input class="field" id="em" type="email" required autocomplete="email" aria-describedby="emErr">
<p class="err" id="emErr">Enter an email like name@company.com</p>
```

⚠️⚠️ **`:invalid` matches an empty required field the instant the page loads.**
Every field is red before the user typed a character, which reads as a broken
form. `:user-invalid` only matches *after* interaction or a submit attempt — the
pseudo-class you actually meant, widely available since November 2023.

- The error text needs `aria-describedby` on the input, or a screen-reader user
  hears "invalid" with no idea why.
- `autocomplete` is not optional: `email`, `name`, `tel`, `street-address`,
  `postal-code`, `cc-number`, `current-password`, `new-password`.
- `type="email"`, `inputmode="numeric"`, `type="date"` change the *phone
  keyboard*. On mobile that beats any styling.

## Toast — announce it, or it is decoration

```html
<div id="toasts" role="status" aria-live="polite" aria-atomic="false"
     style="position:fixed;bottom:1.25rem;right:1.25rem;display:grid;gap:.6rem;z-index:60"></div>
<script>
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'notice notice-' + kind;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}
</script>
```

⚠️ **`aria-live` must be on the container that already exists in the DOM**, not
on the toast. Adding a live region and its content in the same frame announces
nothing — the region has to be observed *before* the change.
⚠️ Never put the only copy of an important message in a toast that disappears.

## ⭐⭐ The four states — loading, empty, error, populated

Every list, table, chart and dashboard needs all four and they must not look
alike. The markup for each is in `web-app-quality`, with the reason it is a
correctness rule rather than a styling preference.

## Table

Use `.table-wrap` + `.table` from `acuvo-ui.css`. Four rules the markup must
carry, whatever the styling:

- The wrapper scrolls, never the page. A table is the number one cause of a
  document that scrolls sideways at 360px.
- `<th scope="col">` and `<th scope="row">`. Without `scope`, a screen reader
  reads a grid of unlabelled numbers.
- Right-align numbers (`class="num"`) with `font-variant-numeric: tabular-nums`,
  or figures jitter column to column between rows.
- ⚠️ **A `<div>` grid is not a table.** Rows and columns of data mean `<table>`
  — sorting, selection and screen readers all depend on it.

## Before you call a component done

- Tab to it, operate it with the keyboard only, and Esc out of it.
- Focus is visible at every stop (`:focus-visible` and a real ring).
- It has a loading, an empty and an error state, and they look different.
- No `z-index` above 100 — if you needed one, you wanted the top layer.
- At 360px wide nothing overflows the page.
