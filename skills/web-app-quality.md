---
name: web-app-quality
description: What makes a generated app actually work — state, persistence, accessibility, edge cases
when: Building an interactive app, tool or anything with user input
---

# Making the app actually work

## Persist by default

An app that forgets everything on refresh feels broken even when it is
functionally correct. Persist user state to `localStorage` under one namespaced
key, and read it back on load.

```js
const KEY = 'myapp:v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? null; } catch { return null; } };
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
```

⚠️ Always `try/catch`. `localStorage` throws in private mode and when full, and
an uncaught throw during load blanks the whole app.

⚠️ Version the key (`:v1`). Shipping a new shape against an old stored object is
how an app crashes only for returning users — the ones who liked it.

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

## Destructive actions

Deleting needs either a confirm or an undo. Undo is better: it keeps the app
fast and forgiving. A confirm dialog on every delete trains people to click
through it.

## Numbers and dates

- Format money with `Intl.NumberFormat`, never `toFixed(2)` plus a `$`.
- Dates with `Intl.DateTimeFormat` — never build a date string by hand.
- Show relative time ("2 minutes ago") for recent things, absolute for old.

## Before calling it done

Run through it as a user: add something, refresh, edit it, delete it, undo,
submit an empty form, paste a wall of text, use only the keyboard. Every one of
those is a bug people actually hit.
