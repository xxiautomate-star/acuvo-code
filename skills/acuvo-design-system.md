---
name: acuvo-design-system
description: What loads in a generated app, and the toolbox files that make a page look designed
when: Restyling any page, or before adding a stylesheet, script, font or image
---

# Making it look designed

## ⚠️ THE CONSTRAINT THAT DECIDES EVERYTHING: the CSP

Generated apps run under a strict Content-Security-Policy. Know exactly what it
allows, because guessing in either direction costs you.

| you want to load | allowed? | the directive |
|---|---|---|
| an inline `<style>` or `style=` | **yes** | `style-src 'unsafe-inline'` |
| a Google Fonts stylesheet | **yes** | `style-src … https://fonts.googleapis.com` |
| a `/vendor/` stylesheet (Basecoat, flatpickr…) | **yes** | `style-src … /vendor/` |
| any other external stylesheet or CDN | **no** | — |
| an external `<script src="https://…">` | **no** | `script-src` is inline + own path + `/vendor/` |
| an inline `<script>` | **yes** | `script-src 'unsafe-inline'` |
| **an image from ANY https origin** | **⭐ YES** | `img-src 'self' https: data: blob:` |
| audio/video from any https origin | **yes** | `media-src https: data: blob:` |
| a web font file (woff2) over https | **yes** | `font-src https: data:` |

⚠️ **This table used to say images must be same-origin or `data:`. That was
wrong** — read from the serving route, `img-src` allows `https:` outright.
Believing otherwise is expensive: it is why generated pages are all type and
boxes with no photography, and an image-led page is most of the distance between
"template" and "agency".

- **Never** `<link>` a CDN stylesheet, and never `<script src="https://cdn…">`.
  The browser refuses it, the page renders unstyled or the library is
  `undefined`, and the only evidence is one console line — which then reads as
  "the AI is bad at design" when it was a network refusal.
- **⛔ The Tailwind CDN (`cdn.tailwindcss.com`) is blocked.** A page using it
  renders with *no styling at all*. See the framework note below for the path
  that does work.
- Vendor CSS instead: write it into the project.

## ⭐ Images: what to actually use

```html
<img class="media" src="https://picsum.photos/seed/hero/1600/900" alt="" loading="lazy" width="1600" height="900">
```

- `picsum.photos` works (verified: HTTP 200, `image/jpeg`, ~30KB). Its code is
  MIT and its photos come from Unsplash, whose licence permits commercial use
  with no attribution required. ⚠️ It is still **someone else's server** — fine
  for a demo or placeholder, and something to replace before a page is a real
  product.
- Always set `width`/`height` or `aspect-ratio`, or the page reflows on load and
  everything below jumps. `loading="lazy"` on anything below the fold.
- `alt=""` for decoration, real text for meaning. Never `alt="image"`.
- ⭐ **Inline SVG has no CSP problem at all** and is the right answer for icons,
  logos, charts, dividers and background texture. A hand-drawn SVG bar chart
  beats a blocked chart library every time.

## ⭐⭐⭐ DRAW THE PICTURE YOURSELF — SVG is an illustration medium, not an icon format

⚠️⚠️ **Measured across 84 published projects: 1,383 `<svg>` tags and 7,006
`<path>`s — and `<linearGradient>` 0, `<pattern>` 0, `<mask>` 0, `<clipPath>` 0,
`<filter>` 0.** Every SVG we have ever shipped is a flat one-colour icon. The
half of SVG that makes *pictures* has never once been used.

That matters most exactly when image generation is unavailable or too slow: a
scene built from four gradients and two paths is a few hundred bytes, scales to
any size, **prints sharply** (a `<canvas>` does not), sits in the DOM where CSS
can theme it, and can never 404 or be blocked.

```html
<svg viewBox="0 0 400 220" width="100%" role="img" aria-label="Sunset over hills">
  <defs>
    <linearGradient id="ill-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f5c451"/><stop offset="1" stop-color="#e0526b"/>
    </linearGradient>
    <pattern id="ill-dots" width="10" height="10" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.3" fill="#fff" opacity=".45"/>
    </pattern>
    <linearGradient id="ill-fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
    </linearGradient>
    <mask id="ill-soft"><rect width="400" height="220" fill="url(#ill-fade)"/></mask>
    <filter id="ill-glow" x="-75%" y="-75%" width="250%" height="250%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
  </defs>

  <rect width="400" height="220" fill="url(#ill-sky)"/>                <!-- 1 wash   -->
  <rect width="400" height="220" fill="url(#ill-dots)" mask="url(#ill-soft)"/>  <!-- 2 texture, faded out -->
  <circle cx="300" cy="60" r="34" fill="#fff8e7" filter="url(#ill-glow)" opacity=".9"/>
  <circle cx="300" cy="60" r="26" fill="#fff8e7"/>                     <!-- 3 glow + core -->
  <path d="M0 180 Q 80 130 150 165 T 290 150 T 400 172 L400 220 L0 220Z" fill="#2b1b3d"/>
  <path d="M0 200 Q 110 160 210 190 T 400 196 L400 220 L0 220Z" fill="#150d20"/>
</svg>                                                                 <!-- 4 silhouettes -->
```

⭐ **That is the whole method: a graded wash, a texture faded by a mask, one
light source, then two or three dark silhouette paths in front.** Overlapping
`Q`/`T` curves at different darknesses read as depth. It works for hills, city
skylines, waves, foliage and abstract blobs without changing shape.

### ⚠️⚠️ THE THREE TRAPS, ALL THREE RENDERED AND CONFIRMED, NONE OF WHICH ERRORS

- ⚠️⚠️ **`id` IS DOCUMENT-GLOBAL, AND THE FIRST ONE WINS.** Two illustrations on
  one page that each define `id="sky"` do **not** get one each — the second
  silently renders the *first* one's gradient. Verified: a green/blue gradient
  declared in the second `<svg>` painted warm orange. **Prefix every id
  (`ill-sky`, `chart-fade`)** — this is the single most likely way a second
  illustration comes out wrong on a page that already had one.
- ⚠️⚠️ **A filter is CLIPPED to its region, which defaults to only 10% past the
  shape.** `stdDeviation="6"` needs roughly 3× that in margin, so a glow renders
  as a blurred circle **cut into a hard-edged square**. Verified. Always write
  `x="-75%" y="-75%" width="250%" height="250%"` on any blur.
- ⚠️ **`<mask>` reads LUMINANCE, not alpha.** A fully opaque *red* rect in a mask
  makes the shape ~21% visible, not 100% — measured. Masks are drawn in
  **white → black**, i.e. white shows and black hides. (`<clipPath>` is the
  hard-edged one and takes shapes, not colours.)

### When SVG is the wrong answer

A photograph of a real person, a real building, or a real product. An
illustration cannot pretend to be one, and a fake attempt is worse than the
honest drawing. Use a real image there.

## ⭐⭐⭐ THE TOOLBOX — two files you get for free

**Multi-file output only.** Reference either and it is written into the project
for you. Never paste their contents, never fetch them from a CDN.

```html
<link rel="stylesheet" href="acuvo-ui.css">
<script src="acuvo-motion.js" defer></script>
```

### `acuvo-ui.css`

A modern reset · a **fluid type scale** (`--step--1` … `--step-4`, all `clamp()`)
· a designed dark mode via `prefers-color-scheme` · `text-wrap: balance` on
headings · `min-width: 0` on grid and flex children (the fix for most horizontal
overflow).

| group | classes |
|---|---|
| layout | `.wrap` `.wrap-narrow` `.section` `.stack` `.row` `.grid` (`--min`) `.sidebar` `.switcher` |
| surface | `.card` `.card-hover` `.divider` `.chip` |
| controls | `.btn` `.btn-ghost` `.field` `.label` |
| text | `.prose` (68ch measure + rhythm) `.lead` `.eyebrow` `.muted` `.small` `.sr-only` |
| media | `.media` (aspect-ratio + object-fit) |
| data | `.table-wrap` `.table` (sticky head, tabular numerals, `.num`) |
| states | `.skeleton` `.skeleton-line` `.empty` `.notice` + `-ok/-warn/-bad/-info` `.badge` + same |
| overlays | `dialog`, `dialog::backdrop` and `[popover]` styled, with a real `@starting-style` fade |

⭐ **Restyle it with variables, do not fight it.** `--accent` `--radius` `--font`
`--ink` `--bg` `--line` `--gap` `--min`. Setting `--accent` and one Google font
is usually the whole brand.

⭐ **The state colours are contrast-checked, in both schemes.** `--ok-ink` on
`--ok-bg` and the other three all measure above 4.5:1 by the WCAG 2 formula.
Invent your own and you are very likely to ship a badge nobody can read.

### `acuvo-motion.js`

| attribute | what it does |
|---|---|
| `data-reveal` | fades and lifts in when scrolled into view |
| `data-stagger="70"` | reveals the element's CHILDREN in sequence, 70ms apart |
| `data-count="900"` | counts a number up on first view, keeping prefix/suffix (`$1,250` works) |
| `data-parallax="0.2"` | gentle transform-only parallax |

⚠️ **Everything is disabled under `prefers-reduced-motion`, and that is not
negotiable.** `data-count` also keeps the element's original text, so the page
reads correctly with JavaScript off.

⚠️ **What the toolbox does NOT do:** timeline choreography, physics, charts, 3D,
PDFs or generated audio. For those, `/vendor/` is a self-hosted shelf of real
libraries — charts, 3D, dataviz, PDF, audio synthesis and game engines — served
from our own host, so it needs no build step and no CORS. ⭐ **`game-engines`
holds the exact URLs; read it rather than guessing a path**, because a wrong
version 404s silently and looks exactly like a library with a bug. ⭐ **And the
shelf is not the boundary: `add_library` downloads any permissively-licensed npm
package into this project's own files**, which the same policy serves. A CDN
`<script src>` stays refused; that is the one route that never works.

## The look

**Type.** One display face and one text face, maximum. A serif display over a
clean sans reads premium; two sans faces read like a template. See `typography`.

**Space is the design.** Most weak pages are weak because everything is 16px
apart. Section padding should be 2–4× what feels right first. See
`layout-primitives`.

**Colour.** Many neutrals, exactly one accent. See `colour-and-contrast`.

**Depth without drop shadows.** A hairline border plus a very soft shadow beats
a heavy `box-shadow`. Two competing shadows look amateur.

**Motion.** 150–300ms, `ease-out`, on `transform` and `opacity` only — never on
`width`, `height` or `top`.

## Designed states

Loading · empty · error · populated, and **they must not look alike**. If empty
and error look the same, a broken page reads as merely new and nobody reports
it. Real markup for all four is in `ui-components`.

## ⚠️ If you are building a framework project, Tailwind IS available — compiled

`npm install` works on the machine. A Vite build that compiles Tailwind emits a
plain `.css` file into `dist/`, and a plain stylesheet from the app's own files
is perfectly legal — it is only the *CDN* that is blocked. So:

- one `index.html` → hand-written CSS or `acuvo-ui.css`. **Never a CDN.**
- a built project → Tailwind, CSS Modules, anything with a build step, fine.
- ⚠️ A shadcn/ui paste needs Tailwind **plus** Radix, lucide, clsx and
  tailwind-merge — measured from its own registry. Read `ui-components` before
  deciding it is worth five packages.
- ⭐ **One `index.html` that wants shadcn's widgets** (dropdown menu, select,
  combobox, ⌘K, tooltip, toast): Basecoat on `/vendor/` — see `design-kit`.

## Before calling it done

- Does it look like it was made for THIS content, or could the copy be swapped
  for any other product?
- One clear focal point per screen.
- The four states are designed and distinguishable.
- It works at 360px and at 200% zoom.
- Open the console: zero CSP refusals, zero 404s.
