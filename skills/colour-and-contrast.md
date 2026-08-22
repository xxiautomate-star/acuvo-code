---
name: colour-and-contrast
description: Building a palette that looks deliberate — restraint, neutrals, one accent, and contrast that passes
when: Choosing any colour, theming a page, or when output looks flat, muddy or garish
---

# Colour

Generated pages go wrong in one of two directions: **grey mush** (everything
`#666` on `#f5f5f5`, nothing to look at) or **carnival** (a purple gradient, a
teal button, an orange badge, and a red heading). Both come from choosing
colours one at a time instead of building a set.

## ⭐ The rule that fixes most of it: one accent

A page needs **many neutrals and exactly one accent.** The accent is what the
eye is supposed to find — the primary action, the live figure, the one link that
matters. The moment there are two accents, there is no accent.

```
neutrals   8–10 steps, near-grey, subtly tinted toward the accent
accent      1 hue, 2–3 steps (base, hover, subtle background)
semantic    success / warning / danger — used ONLY for state, never decoration
```

⚠️ **Semantic colours are not palette colours.** Green means "it worked". If
green is also the brand colour, a success message is invisible and a decorative
green panel reads as a system state.

## Neutrals are the whole page — tint them

Pure `#000`/`#888`/`#fff` is the flattest a page can look. Real interfaces use
neutrals with a few degrees of hue in them, usually pulled toward the accent.

```css
:root {
  /* accent hue 240 → neutrals carry a trace of it */
  --n-0:  hsl(240 20% 99%);
  --n-50: hsl(240 16% 96%);
  --n-100:hsl(240 14% 92%);
  --n-300:hsl(240 10% 76%);
  --n-500:hsl(240  8% 48%);
  --n-700:hsl(240 10% 28%);
  --n-900:hsl(240 18% 11%);
  --accent:      hsl(240 76% 56%);
  --accent-weak: hsl(240 76% 96%);
}
```

⭐ **HSL, not hex, while you are choosing.** Same hue, same saturation, moving
lightness — that is what makes a family look like a family. Hex hides the
relationship and you end up with nine unrelated colours.

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

⚠️ **White text on a mid-tone accent usually fails.** `#fff` on a 56%-lightness
blue is around 3.9:1. Either darken the accent to ~45% lightness for buttons, or
use near-black text on it. Check, do not assume.

⭐ **Never signal with colour alone.** A red border on an invalid field is
invisible to a colour-blind user and to a screenshot in greyscale. Add an icon,
a label, or text. Roughly 1 in 12 men cannot distinguish your red from your
green.

## Where colour goes

- **Backgrounds carry almost no saturation.** Depth comes from *slightly*
  different neutrals plus a border, not from colour.
- **Borders `--n-100`–`--n-300`.** A 1px hairline does more for perceived
  quality than a shadow does.
- ⚠️ **Gradients: at most one, and keep it subtle.** Two stops, close in hue.
  A purple-to-pink hero gradient is the single most recognisable "AI made this"
  signal in existence. If the brief did not ask for a gradient, do not add one.
- **Shadows are neutral and soft**, from the elevation ramp
  (`--shadow-1`…`--shadow-6`). A coloured shadow reads as a toy.

## Dark mode, if asked for

Not an inversion. Dark surfaces need **less** saturation and **more**
lightness in the accent, or it vibrates.

```css
@media (prefers-color-scheme: dark) {
  :root { --bg: hsl(240 14% 8%); --fg: hsl(240 12% 92%); --accent: hsl(240 70% 68%); }
}
```

- Surface `#0d0d10`-ish, not `#000`. Pure black with white text causes halation.
- Body text near `#e8e8ea`, not `#fff`.
- Elevation in dark mode is a *lighter surface*, not a bigger shadow.

## Before calling it done

- One accent. Count them — if there are two, one is wrong.
- Body text passes 4.5:1; buttons and placeholders were checked, not assumed.
- Neutrals share a hue; nothing is pure `#000` or pure `#888`.
- No unrequested gradient. No coloured shadows.
- Nothing is communicated by colour alone.
