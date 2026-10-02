---
name: animation
description: Motion and 3D that read as quality — when not to animate, timings, reduced-motion as a hard gate, and the WebGL scene traps
when: When adding a transition, a hover state, a reveal as something enters the viewport or is scrolled into view, a loading indicator, a canvas or WebGL scene, a 3D viewer, or anything that moves
---

# Animation

## Motion explains a change. It is not decoration.

Good motion answers *"what just happened and where did it come from"*. A panel
sliding from the button that opened it tells the eye where it belongs; the same
panel fading in from nowhere tells it nothing. If a movement does not explain
something, it is delay.

## ⚠️⚠️ When NOT to animate — the list, because "add motion" is the reflex

Each is a real regression, not a taste call:

- **Anything the user is reading or typing.** Text that fades in while the eye is
  already on it is read twice. Never animate a form field's own value.
- **The first paint.** A hero that fades in over 600ms is 600ms of blank page;
  reveal-on-load is what makes a site feel slow while looking busy. Reveal
  *below* the fold; show the top immediately.
- **Anything above ~50 items.** A staggered list of 200 rows takes 14 seconds to
  arrive. Stagger the first ~8 and let the rest be present.
- **A state the user caused and is waiting on.** A delete that plays a 400ms exit
  before the row goes feels unresponsive. Apply the change, then animate the
  *consequence*.
- **Error and empty states.** Bouncing an error draws the wrong emotion. Say the thing.
- **Anything that loops forever in the corner of the eye** — a perpetual pulse, a
  spinning logo, an infinite marquee. It never stops competing for attention and
  never stops burning battery.
- **Two things at once.** A modal opening while the background parallaxes and a
  counter counts: the user tracks none of them.

⭐ The honest test: *remove it and see if anything is worse.* Usually nothing is,
and the page got faster.

## ⚠️⚠️ Animate only `transform` and `opacity`

```css
✗ transition: left .3s, width .3s, height .3s;   /* layout every frame */
✓ transition: transform .3s, opacity .3s;        /* compositor only */
```

`transform` and `opacity` are handled without recalculating layout or repainting.
Animating `left`, `top`, `width`, `height`, `margin` or `box-shadow` forces work
every frame and is the usual cause of janky motion on a phone (`performance`).
To move: `transform: translateX()`. To resize: `scale()`.

⚠️ `will-change` is a promise, not a speed-up. On a handful of elements it helps;
on `*` it hands the compositor a layer per node and makes everything slower. Add
it just before the animation, remove it after.

## Timings that feel right

Hover / small state change **100–150ms** · dropdown, tooltip, toggle
**150–250ms** · panel, modal, page transition **250–400ms** · anything at all,
**never past ~500ms**.

⭐ Under ~100ms reads as instant — fine for feedback, wasted on anything you want
noticed. Past ~500ms the interface feels like it is thinking and users click again.

**Easing:** `ease-out` for things entering (fast then settling — feels
responsive), `ease-in` for things leaving. Never `linear` for anything physical;
it reads as mechanical because nothing in the world moves that way.

## Enter and exit are not symmetrical

Entrances can afford to be seen. Exits should be quicker — the user has already
decided, and making them wait to leave is the most irritating animation there is.
Roughly: exit at half the entrance duration.

## ⚠️⚠️ `prefers-reduced-motion` is a hard gate, not a softening

For some people motion causes nausea or vertigo. This is a medical setting, not a
preference to override. The design toolbox disables every effect it ships under
it, and anything you hand-write must match.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important;
    animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
```

⚠️⚠️ **That CSS block stops CSS and nothing else.** A `requestAnimationFrame`
loop, `element.animate()`, scroll-driven parallax, a count-up, an autoplaying
carousel and a rotating 3D scene all keep running — the usual way a page passes
review and still makes someone sick. Gate the JavaScript too, at the source:

```js
const rm = matchMedia('(prefers-reduced-motion: reduce)');
if (!rm.matches) startTheLoop();
rm.addEventListener('change', e => e.matches ? stopTheLoop() : startTheLoop());
```

⭐ **Reduced ≠ removed.** Keep the state change instant and legible; a cross-fade
is usually fine. It is *movement*, parallax, spin and auto-advance that cause
trouble. Under reduced motion a 3D viewer still renders — it just does not rotate
on its own.

## Loading states

- Under ~300ms: show nothing. A spinner that flashes is worse than a still moment.
- Longer: a skeleton shaped like what is coming beats a spinner — it says what is
  arriving, and the layout does not jump when it lands.
- Long and unknown: say what is happening in words.

## Restraint is the whole skill

One considered transition reads as expensive. Six competing ones read as a
template. If everything moves, nothing is emphasised — the same argument as one
accent colour rather than seven.

---

# 3D and canvas scenes

## ⚠️⚠️ 3D is the wrong answer most of the time. Decide before you build.

It costs a megabyte-class library, a GPU, a battery and a whole class of ways to
render nothing at all. Worth it for **inspecting a real object** the user turns
over (a product, a floor plan, a part), **spatial data** with three genuine axes,
and a few deliberate hero moments. Wrong for these:

- ⚠️ **Any chart.** 3D makes the encoding — length — unreadable, because
  perspective changes it. No third dimension makes a value easier to compare.
- **Decoration.** A rotating blob behind a hero costs more than every other asset
  on the page combined and says nothing.
- **Anything an SVG or a video would do.** A pre-rendered turntable video is
  smaller, loads instantly, needs no GPU and cannot fail to compile a shader.
- **Mobile-first work.** Phones thermally throttle within a minute of sustained
  GPU load; the frame rate drops as the case gets warm.

⭐ If you build one it needs a fallback: an `<img>` poster the scene replaces once
ready. WebGL is unavailable or blocked more often than you think, and the failure
is a blank rectangle.

## The four lines that decide whether anything appears at all

The names below are three.js's; the concepts are identical in any WebGL wrapper,
and most apply to raw canvas too.

⚠️⚠️ **First check whether a 3D library is reachable at all.** In a *generated
single-file app* the only external scripts that load are the exact
`/vendor/<package>@<version>/<file>` entries in `vendor-shelf` — a library not
named there is **not available**, a CDN tag is refused, and it is far too large
to inline against the 400KB ceiling. Then: raw canvas, SVG, or a pre-rendered
video. In a *framework project on a real machine*, just `npm install` it.

```js
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(50, w / h, 0.1, 100); // fov, aspect, near, far
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
camera.position.set(0, 0, 5);              // ⚠️ default (0,0,0) is inside the object
```

The four failures that produce an empty canvas, in the order they happen:

1. ⚠️⚠️ **No light + a `MeshStandardMaterial` = a black object**, indistinguishable
   from "nothing rendered". A scene needs a soft ambient/hemisphere fill *and* one
   directional light — ambient alone is flat and shapeless, because shape is read
   from shading. `MeshBasicMaterial` ignores lights; use it to prove geometry exists.
2. **The camera is inside the mesh.** At the origin looking at a box at the
   origin you see its inside faces, which are back-face-culled: nothing.
3. **Something was never added.** `scene.add(mesh)` is a separate call, and
   `renderer.domElement` exists only in memory until you append it. Both silent.
4. **`near` is too small.** `near: 0.001` with `far: 10000` destroys depth-buffer
   precision and surfaces flicker through each other (z-fighting). `0.1` to `100`
   suits a metre-scale scene.

⚠️ Three lights is usually the whole rig: a key (directional, off to one side and
above), a soft fill opposite, ambient low. Lights are cheap in count and expensive
in *shadows* — one shadow-casting light, not four.

## ⚠️⚠️ The naive render loop drains the battery

`function tick(){ renderer.render(scene,camera); requestAnimationFrame(tick); }` redraws
60 times a second forever, whether or not a pixel changed or the canvas is even on
screen. Render on demand instead, stop when off screen or hidden, and cap the pixel
ratio — the recipe and the numbers are in `performance`.

## Responsive canvas: sized in CSS, resolved in JavaScript

⚠️ A `<canvas>` has **two sizes** — the `width`/`height` attributes (the pixel
buffer) and the CSS box. Setting only CSS stretches a small buffer: a blurry
scene that looks like bad antialiasing.

```js
const ro = new ResizeObserver(([e]) => {
  const { width: w, height: h } = e.contentRect;
  if (!w || !h) return;              // ⚠️ hidden panel is 0×0 → NaN aspect → nothing renders
  renderer.setSize(w, h, false);     // ⭐ false = do NOT write inline CSS size
  camera.aspect = w / h;
  camera.updateProjectionMatrix();   // ⚠️ without this the aspect change is ignored
  invalidate();
});
ro.observe(canvas.parentElement);
```
```css
.chart-box { position: relative; height: 320px; }      /* ⚠️ height, NOT min-height */
.chart-box canvas { display: block; width: 100%; height: 100%; }  /* block kills the inline-gap */
```

⚠️⚠️ **`height: 100%` NEEDS A PARENT WITH A REAL HEIGHT, AND `min-height` IS NOT
ONE.** The commonest way a chart panel becomes a tall empty box: the canvas is
sized from its parent, the charting library then resizes the canvas, and if the
parent's height is decided by its content the two inflate each other. Measured:
`min-height:280px` with `height:100%` rendered the canvas **1038×519** and the
page 2194px — a ~700px void; the same brief with no canvas CSS came out 1167px.
Chart.js documents a container with a **fixed** height.

⭐ Any real ceiling works — `height`, `max-height`, or `aspect-ratio: 16 / 9`.
Just never a floor alone.

⭐ **`ResizeObserver`, not `window.onresize`.** A canvas inside a flex panel, a
sidebar or a `<details>` changes size constantly without the window ever resizing,
and the window listener never fires.

## Two cleanups nobody writes until it breaks

- ⚠️ **GPU memory is not garbage collected for you.** Rebuilding a scene without
  calling `.dispose()` on the geometries, materials and textures you replaced
  leaks VRAM until the context is lost. On a page that regenerates a scene per
  interaction this takes about a minute.
- ⚠️ **Handle context loss.** When the GPU is reset — tab sleep, driver hiccup,
  memory pressure — the canvas goes blank *permanently* unless you listen:
  `canvas.addEventListener('webglcontextlost', e => e.preventDefault())` and
  rebuild on `webglcontextrestored`. Without the `preventDefault` the restore
  event never fires at all.

## Before calling a scene done

- Does it render on first paint, or is there a poster image until it does?
- Turn on reduced motion: does the auto-rotation stop while the model stays?
- Resize the panel (not the window) — is it still sharp and un-stretched?
- Scroll it off screen — does the frame rate of the rest of the page recover?
- Would a single image or a short video have answered the same question?
