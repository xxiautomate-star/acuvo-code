---
name: accessibility
description: Semantic HTML, keyboard paths, focus order, ARIA and screen readers — what breaks real usage
when: Any interactive UI, or when a screen reader or keyboard user cannot reach something
triggers: accessibility, a11y, screen reader, keyboard, focus, aria, contrast, wcag, tab order, alt text, reduced motion, colour blind, color blind
version: 2
applies-to: both
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

## ⚠️⚠️ When the state changes, change every rendering of it — in one place

An ARIA state and the accessible name are two renderings of ONE fact. Code that
updates one and not the other tells a screen-reader user the exact opposite of
what the screen shows.

```js
✗ // flips the state, and leaves the name where the first render put it
  btn.setAttribute('aria-pressed', String(done));

✓ btn.setAttribute('aria-pressed', String(done));
  btn.setAttribute('aria-label', `${day} — ${done ? 'completed' : 'not completed'}`);
```

⚠️⚠️ **"The re-render fixes it a moment later" is not a defence — it is the
defect.** Measured on a shipped habit tracker whose handler flipped
`aria-pressed` optimistically and then awaited the store before re-rendering the
row: with the store answering instantly nothing is visibly wrong, at a 250ms
round trip the button announced *pressed* and *not completed* together for about
400ms on every tick, and at 600ms it was still contradicting itself 1.5 seconds
later. **The window is the round trip — so this is invisible on the machine you
built it on and permanent for a user on a slow connection.**

⭐ **The rule that generalises: one fact, one place.** Set the state attribute,
the accessible name, the visible text and the class together, from the same
variable. Setting `aria-pressed` in a different function from the one that wrote
`aria-label` guarantees they disagree; only the duration is in question. The same
applies to any number you print — a count, a total, a "3 of 12" — if it is
derived from state, it is re-derived wherever that state is written.

⚠️ And the ones nobody updates at all: `aria-expanded` on a disclosure,
`aria-current` on a nav link, `aria-selected` on a tab. A value written once into
the HTML and never touched by script is a permanent lie from the first click.

## Contrast, and never colour alone

- Body text at **4.5:1**, large text at **3:1**. Grey-on-grey placeholder text
  is the usual offender.
- About 1 in 12 men cannot separate red from green — so an error state needs an
  icon or words, not just a red border. Same for chart series (`data-and-charts`).

## Images and icons

`alt` describes the *purpose*: `alt="Search"` on a magnifier, not
`alt="magnifying glass icon"`. Decorative images take `alt=""` so screen readers
skip them — omitting `alt` entirely makes them read the filename instead.

A chart is an image too: name it and say its shape (`data-and-charts`).

```html
<svg role="img" aria-labelledby="c1t c1d"> <title id="c1t">Revenue by month</title>
  <desc id="c1d">Rose from A$4,200 in June to A$9,800 in August.</desc> … </svg>
```

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

## ⭐⭐ A CONTROL HAS TO BE BIG ENOUGH TO HIT

⚠️⚠️ **Measured across 84 shipped Acuvo projects: 908 visible controls, and 148
of them (16.3%) are under 24px on their shorter side** — a `<select>` at 105×19,
a nav link at 77×23, a "Shop" button at 40×22. On a phone those are missed taps,
and the person blames the app, not the CSS.

| bar | number | who it is |
|---|---|---|
| **24 × 24 px** | WCAG 2.2 AA (2.5.8) | the floor. Below this it is a defect |
| 44 × 44 px | Apple HIG / Material | comfortable, and the right default for anything primary |

⭐ **The fix is padding ON THE CONTROL, never a bigger icon and never margin on
the parent.** Margin moves the box; only padding grows the hit area.

```css
✗ .icon-btn { width: 20px; height: 20px; }          /* the SVG is the target */
✓ .icon-btn { padding: 12px; line-height: 0; }      /* 20 + 12 + 12 = 44 */
✓ .nav a    { padding-block: 10px; }                /* a 22px link becomes 42 */
```

⚠️ **Most of ours miss by one or two pixels**, not by twenty — a nav laid out
with flex and no vertical padding lands at 21–23px. One `padding-block` line on
the link fixes a whole navigation.

⚠️ An `<a>` inside a sentence is exempt: it is a word in a line of prose, not a
tap target with its own box. This applies to anything that is its own
block/flex/inline-block: buttons, nav links, chips, icon buttons, checkboxes,
`<select>`, and the close button on a dialog — which is the one that is smallest
in practice and the one people need most.

## ⭐ Tested pattern — compute contrast instead of eyeballing it

Grey-on-white "looks fine" on a bright laptop and fails outdoors. WCAG AA is
**4.5:1** for body text and **3:1** for large text and UI outlines. Check the
pair in code before shipping a palette.

```js
// @selftest — WCAG 2 relative luminance and contrast ratio
function luminance(hex) {
  const n = hex.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const passesAA = (fg, bg, large = false) => contrast(fg, bg) >= (large ? 3 : 4.5);
assert.equal(Math.round(contrast('#000', '#fff')), 21);
assert.equal(passesAA('#767676', '#ffffff'), true);     // the lightest grey that passes on white
assert.equal(passesAA('#999999', '#ffffff'), false);    // the placeholder grey that does not
assert.equal(passesAA('#999999', '#ffffff', true), false);
```

And the keyboard check, which no contrast number replaces: unplug the mouse,
`Tab` through the whole flow, and every control must be reachable, visibly
focused, and operable with `Enter`/`Space`.
