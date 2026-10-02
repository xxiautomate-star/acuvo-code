---
name: colour-and-contrast
description: Building a palette that looks deliberate — restraint, neutrals, one accent, and contrast that passes
when: Choosing any colour, theming a page, or when output looks flat, muddy or garish
---

# Colour

Generated pages go wrong in two directions: **grey mush** (`#666` on `#f5f5f5`,
nothing to look at) or **carnival** (a purple gradient, a teal button, an orange
badge, a red heading). Both come from choosing colours one at a time instead of
building a set.

## ⭐ The rule that fixes most of it: one accent

A page needs **many neutrals and exactly one accent.** The accent is what the eye
is meant to find — the primary action, the live figure, the one link that
matters. The moment there are two accents, there is no accent.

```
neutrals   8–10 steps, near-grey, subtly tinted toward the accent
accent      1 hue, 2–3 steps (base, hover, subtle background)
semantic    success / warning / danger — used ONLY for state, never decoration
```

⚠️ **Semantic colours are not palette colours.** Green means "it worked": if
green is also the brand colour, a success message is invisible and a decorative
green panel reads as a system state.

## Neutrals are the whole page — tint them

Pure `#000`/`#888`/`#fff` is the flattest a page can look; real neutrals carry a
few degrees of hue, pulled toward the accent.

⭐ **Never hex while you are choosing.** One hue and one saturation with only
lightness moving is what makes a family look like a family; hex hides the
relationship and you end up with nine unrelated colours. Build the ramp in the
notation below — same idea, better behaved.

## ⭐⭐ Prefer `oklch()` to HSL, and here is the concrete reason

HSL's "lightness" is not perceptual: `hsl(60 100% 50%)` (yellow) and
`hsl(240 100% 50%)` (blue) claim the same 50% and are wildly different
brightnesses, so a ramp even in one hue is lumpy in the next and a "same
lightness" accent swap silently breaks your contrast.

```css
:root {
  --n-50:  oklch(97% 0.006 265);
  --n-200: oklch(90% 0.012 265);
  --n-500: oklch(58% 0.020 265);   /* muted text */
  --n-900: oklch(21% 0.030 265);   /* ink */
  --accent:      oklch(54% 0.19 265);
  --accent-weak: oklch(96% 0.03 265);
}
```

⭐ **In OKLCh the first number really is perceived lightness**, so a ramp is even
across every hue, and swapping the hue angle (`265`→`28` for terracotta)
rebrands the page without changing one contrast ratio. Safe since May 2023.

⚠️ `oklch()` reaches colours sRGB cannot show; the browser clamps rather than
failing, so keep chroma under about `0.22` or the editor lies to you.

The vendored token layer already ships neutrals and an accent. **Prefer those
tokens.** Introduce new colour only when the brief names a brand colour.

## Contrast is a requirement, not a preference

| use | minimum |
|---|---|
| body text | **4.5:1** |
| large text (≥24px, or ≥19px bold) | **3:1** |
| icons, borders, focus rings, UI edges | **3:1** |
| disabled text | exempt, but then it must be obviously disabled |

⚠️ **Placeholder text and light-grey captions are where this fails almost every
time.** `#999` on `#fff` is 2.8:1 — it fails, and it fails for everyone in
sunlight, not just people with low vision.

### ⭐⭐ Compute it. It is nine lines, and it settles the argument.

```js
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const L = (hex) => { const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const contrast = (a, b) => { const [x, y] = [L(a), L(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05); };
```

⚠️⚠️ **White on a mid-tone accent fails far more often than anyone expects.**
Every number below is computed with that function, not estimated:

| button | `#fff` on it | verdict |
|---|---|---|
| `#3b82f6` (the default "AI blue") | **3.68** | ❌ fails 4.5 |
| `#0ea5e9` sky · `#10b981` emerald · `#ef4444` red-500 | **2.77 · 2.54 · 3.76** | ❌ |
| `#f59e0b` amber | **2.15** | ❌ (black on it = 9.78 ✅) |
| `#2563eb` blue-600 | 5.17 | ✅ |
| `#1d4ed8` blue-700 · `#4f46e5` indigo-600 · `#dc2626` red-600 | 6.70 · 6.29 · 4.83 | ✅ |

⭐ **The rule that falls out of it: for white text, go one step darker than the
colour you first picked** — the `-500` shades of every popular palette fail, the
`-600`/`-700` shades pass. For yellow, orange and lime use black text; no usable
shade passes with white.

⚠️ **Greys on white:** `#999999` is **2.85** (fails), `#767676` is **4.54** — the
lightest grey that passes. Anything lighter than `#767676` on white is not a
"subtle caption", it is unreadable text.

⭐ **Never signal with colour alone.** A red border on an invalid field is
invisible to a colour-blind user and in greyscale — add an icon or a word.
Roughly 1 in 12 men cannot tell your red from your green.

## Where colour goes

- **Backgrounds carry almost no saturation.** Depth comes from *slightly*
  different neutrals plus a border, not from colour.
- **Borders `--n-100`–`--n-300`.** A 1px hairline does more for perceived quality
  than a shadow.
- ⚠️⚠️ **But an INPUT's border is not decoration — it needs 3:1.** WCAG 1.4.11
  applies to any boundary that identifies a control. Measured on a typical
  hairline: `#e6e6ea` on white is **1.24:1**, so a field styled with the same
  grey as a card edge has, functionally, no edge in daylight. Keep two tokens —
  `--line` for decorative rules and `--line-strong` (`#8a8a94` on white =
  **3.42**, `#6b6b7a` on `#141419` = **3.51**) for inputs and outline buttons.
  `acuvo-ui.css` ships both.
- ⚠️ **A gradient used as DECORATION: at most one, subtle, two stops close in
  hue.** A purple-to-pink swoosh behind a heading is the most recognisable "AI
  made this" signal in existence; if the brief did not ask for decoration, do not
  add it. ⭐ **That is a ban on garnish, not on gradients** — when there is no
  photograph the surface *is* the picture, and the rules below are different.
- **Shadows are neutral and soft** (`--shadow-1`…`--shadow-6`). A coloured shadow
  reads as a toy.

## ⭐⭐⭐ MAKING A SURFACE — the picture you can build with no photograph

⚠️⚠️ **The largest measured gap in what we ship.** Across **84 published
projects**: `mix-blend-mode` **0**, `background-blend-mode` **0**,
`conic-gradient` **0**, `mask-image` **0**, `@property` **0**. Only a third carry
any `<img>`; 71% substitute an emoji. So the usual outcome is a page with **no
picture on it** — not because one was impossible, but because the toolbox went
untouched. It is free, needs no engine, and is CSP-legal.
⭐ **Every recipe here was rendered in a browser first.**

**1 — The mesh gradient.** What a modern hero actually is.

```css
.hero{ background:
  radial-gradient(ellipse 80% 60% at 15% 20%, oklch(62% .21  22 / .85), transparent 60%),
  radial-gradient(ellipse 70% 70% at 85% 25%, oklch(58% .19 305 / .80), transparent 62%),
  radial-gradient(ellipse 90% 65% at 50% 95%, oklch(66% .17 235 / .75), transparent 65%),
  oklch(22% .05 280); }                    /* the base LAST = furthest back */
```

⭐ Layers paint **front-to-back**; offset the centres, fade each to
`transparent`. Three blobs is enough, five is mud.

**2 — Grain.** A flat gradient reads like a CSS default; the same gradient with
noise over it reads *printed*. `feTurbulence` makes it, with no image file:

```css
.hero::after{ content:"";position:absolute;inset:0;pointer-events:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  opacity:.2; mix-blend-mode:overlay; }
```

⚠️ `baseFrequency` is grain size (`.8` film, `.05` cloud); keep opacity `.12`–`.25`
or it is dirt. Inside a data URI `#` must be `%23` and `%` must be `%25`, or the
URI truncates and nothing renders, silently.

**3 — `conic-gradient`** for rays, sunbursts and wedges:
`conic-gradient(from 0deg at 50% 50%, #f5c451 0 10deg, #1a1206 10deg 20deg, …)`.
⚠️⚠️ Two ways it comes out blank, both of which I hit: the colour pair
must be repeated around the *whole* circle — stop at `44deg` and you get two
lonely spikes on a flat field — and a vignette over it must start **late**
(`transparent 30%`→`78%`; at `8%`→`62%` it swallowed the rays whole).

**4 — Halftone**, the poster device: a dot grid blended into a wash —
`radial-gradient(circle at 50% 50%,#000 26%,transparent 27%)` over a
`linear-gradient`, `background-size:14px 14px,100% 100%`,
`background-blend-mode:multiply`.

### ⚠️⚠️ THE BLEND-MODE IDENTITY TRAP — it cost a render, and it is silent

A blend mode has values that do **nothing**, and the result is not an error — it
is your layer vanishing. `screen`/`lighten` are no-ops against **black**,
`multiply`/`darken` against **white**, `overlay` washes mid-grey away.
⭐ **Darkening marks want `multiply`. Lightening marks want `screen`.**
I wrote that halftone with `screen` and got a plain gradient: no dots, no
console message, nothing to search for.

⚠️ `mix-blend-mode` blends against its **stacking context**, not the page. When a
blended layer bleeds onto what it must not touch, `isolation:isolate` on the
parent is the fix, not `z-index`.

**5 — `@property` is why a gradient can animate at all.** A plain `--ang` is an
unparsed string, so a gradient driven by one **jumps**. Register it — top level,
not inside `:root{}` — as `@property --ang{ syntax:'<angle>'; inherits:false;
initial-value:0deg }` and `conic-gradient(from var(--ang), …)` turns smoothly.
⚠️ It loops forever, so `prefers-reduced-motion` must switch it off.

### ⚠️⚠️ CONTRAST IS MEASURED AT THE LIGHTEST POINT, NOT THE AVERAGE

Every number in the table above assumes a flat background. A mesh gradient has
none: white text passes over the dark corner and fails over the bright blob, and
the average says nothing about the word that is actually illegible.

⭐ **The fix is a scrim, not a duller gradient** — a translucent wash under the
text only, so the artwork survives and the text gets a floor:
`background:linear-gradient(transparent,#000 55%)`, or more cheaply
`text-shadow:0 1px 3px rgb(0 0 0 / .55)`. Then run `contrast()` above against the
**brightest** pixel behind the text. ⚠️ `backdrop-filter:blur()` buys the same
legibility expensively: it repaints everything beneath it every frame, and on a
phone it is the one line that drops a scroll to 30fps.

## Dark mode, if asked for

Not an inversion. Dark surfaces need **less** saturation and **more** lightness
in the accent, or it vibrates — inside
`@media (prefers-color-scheme: dark)`, something like
`--bg:oklch(16% .02 265); --fg:oklch(93% .01 265); --accent:oklch(72% .14 265)`.

- Surface `#0d0d10`-ish, not `#000`. Pure black with white text causes halation.
- Body text near `#e8e8ea`, not `#fff`.
- Elevation in dark mode is a *lighter surface*, not a bigger shadow.

## Before calling it done

- One accent. Count them — if there are two, one is wrong.
- Body text passes 4.5:1; buttons and placeholders checked, not assumed.
- Neutrals share a hue; nothing is pure `#000`/`#888`.
- No unrequested *decorative* gradient. No coloured shadows.
- ⭐ No photograph? Then does the page have a **surface**, or is the hero a flat
  rectangle with a heading on it?
- Text over a gradient was checked at its **brightest** point, not its average.
- Nothing is communicated by colour alone.
