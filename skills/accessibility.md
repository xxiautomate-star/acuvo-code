---
name: accessibility
description: Semantic HTML, keyboard paths, focus and contrast — the parts that break real usage
when: When building any interactive UI, a modal, a menu, or anything you can click
---

# Accessibility

Beyond the basics in `web-app-quality`. These are the failures that make an
interface genuinely unusable rather than merely imperfect.

## ⚠️⚠️ The right element does most of the work for free

```html
✗ <div class="btn" onclick="save()">Save</div>
✓ <button type="button" onclick="save()">Save</button>
```

The `<div>` cannot be focused, cannot be triggered by Enter or Space, is not
announced as a button, and does not participate in forms. The `<button>` does
all four with no code. Recreating that with `tabindex`, `role` and key handlers
is a lot of work to arrive back where you started — and it is usually incomplete.

Same for `<a>` for navigation, `<label>` for inputs, `<nav>`/`<main>`/`<h1>`
for structure. **Reach for ARIA only when no element exists for the job.** Bad
ARIA is worse than none, because it overrides what the browser knew.

## Every path must work from the keyboard

Tab through the whole thing without touching the mouse. If you cannot reach a
control, open a menu, or close a dialog, it is broken — for keyboard users, for
screen readers, and for anyone whose trackpad died.

- `Escape` closes overlays
- `Enter`/`Space` activate
- Arrow keys move within a composite widget (menu, tabs), not between pages

⚠️ **Tab order follows the DOM, not the CSS.** Reordering visually with grid or
flex leaves the tab order where the markup put it. Never use positive
`tabindex` values to patch that — fix the markup order.

## Focus is not decoration

```css
✗ *:focus { outline: none; }        /* the keyboard user is now lost */
✓ :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

`:focus-visible` shows the ring for keyboard users and not for mouse clicks, so
there is no reason left to remove it.

⭐ **Move focus deliberately.** Open a dialog → focus inside it and trap it
there. Close it → return focus to the control that opened it. Delete a row →
move focus somewhere sensible, not to `<body>`.

## Contrast, and never colour alone

- Body text at **4.5:1**, large text at **3:1**. Grey-on-grey placeholder text
  is the usual offender.
- About 1 in 12 men cannot separate red from green — so an error state needs an
  icon or words, not just a red border. Same for chart series (`data-and-charts`).

## Images and icons

`alt` describes the *purpose*: `alt="Search"` on a magnifier, not
`alt="magnifying glass icon"`. Decorative images take `alt=""` so screen readers
skip them — omitting `alt` entirely makes them read the filename instead.

## ⚠️ Tell people when something changed

A screen reader does not notice a div appearing. Announce it:

```html
<div role="status" aria-live="polite">Invoice saved</div>
```

Use `assertive` only for genuine interruptions — an error that stops the task.

## Respect the settings people already chose

```css
@media (prefers-reduced-motion: reduce) { *, *::before, *::after {
  animation-duration: .01ms !important; transition-duration: .01ms !important; } }
```

Also honour `prefers-color-scheme`. These are the user telling you what they
need; overriding them is a decision you do not have the information to make.
