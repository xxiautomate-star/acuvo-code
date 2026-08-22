---
name: animation
description: Motion that reads as quality — what to animate, timings that feel right, and reduced-motion
when: When adding a transition, a hover state, a loading indicator, or anything that moves
---

# Animation

## Motion explains a change. It is not decoration.

Good motion answers *"what just happened and where did it come from"*. A panel
that slides from the button that opened it tells the eye where it belongs. The
same panel fading in from nowhere tells it nothing.

If a movement does not explain something, it is delay.

## ⚠️⚠️ Animate only `transform` and `opacity`

```css
✗ transition: left .3s, width .3s, height .3s;   /* layout every frame */
✓ transition: transform .3s, opacity .3s;        /* compositor only */
```

`transform` and `opacity` can be handled without recalculating layout or
repainting. Animating `left`, `top`, `width`, `height`, `margin` or `box-shadow`
forces work on every frame and is the usual cause of janky motion on a phone
(`performance`).

To move something: `transform: translateX()`. To resize: `scale()`.

## Timings that feel right

| what | duration |
|---|---|
| hover, small state change | 100–150ms |
| dropdown, tooltip, toggle | 150–250ms |
| panel, modal, page transition | 250–400ms |
| anything | **never past ~500ms** |

⭐ Under ~100ms reads as instant — fine for feedback, wasted on anything you
want noticed. Past ~500ms the interface feels like it is thinking, and users
start clicking again.

**Easing:** `ease-out` for things entering (fast then settling — feels
responsive), `ease-in` for things leaving. Never `linear` for anything physical;
it reads as mechanical because nothing in the world moves that way.

## Enter and exit are not symmetrical

Entrances can afford to be seen. Exits should be quicker — the user has already
decided, and making them wait to leave is the most irritating kind of animation.
Roughly: exit at half the entrance duration.

## ⚠️⚠️ Respect `prefers-reduced-motion` — it is a medical setting

For some people motion causes nausea or vertigo. This is not a preference to
override:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
```

⭐ Reduced ≠ removed. Keep the state change instant and legible — a cross-fade
is usually still fine; it is *movement*, parallax and spin that cause trouble.

## Loading states

- Under ~300ms: show nothing. A spinner that flashes is worse than a still
  moment.
- Longer: a skeleton in the shape of what is coming beats a spinner — it says
  what is arriving, and the layout does not jump when it lands.
- Long and unknown: say what is happening in words.

## Restraint is the whole skill

One considered transition reads as expensive. Six competing ones read as a
template. If everything moves, nothing is emphasised — which is the same
argument as using one accent colour rather than seven.
