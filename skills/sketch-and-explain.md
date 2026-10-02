---
name: sketch-and-explain
description: Making a diagram DRAW ITSELF — anime.js beats, Rough.js hand-drawn strokes, and the timing that separates an explainer from a slideshow
when: Explaining a process, a system, an architecture or a concept on a page — or any time a diagram, flow, timeline or before/after would carry it better than a paragraph
---

# Sketch and explain

The look people mean by *"an animated explainer video"* is not a fancy library.
It is **one idea arriving at a time, drawn rather than revealed.** Two libraries
on the shelf do it; `vendor-shelf` has the exact API and this file has the taste.

```html
<script src="/vendor/roughjs@4.6.6/rough.js"></script>
<script src="/vendor/animejs@4.5.0/anime.umd.min.js"></script>
```

`rough` draws shapes as if by hand. `anime` draws them **on**, in order.

---

## ⭐ THE ONE RULE: A THING IS DRAWN, NOT FADED IN

A box that fades in is a slideshow. A box whose outline is *drawn* — left to
right, the way a person draws it — reads as someone explaining. The difference
is `createDrawable`, and it costs nothing extra.

```js
const rc = rough.svg(svg, { options: { seed: 42, roughness: 1.4 } });
svg.appendChild(rc.rectangle(20, 20, 180, 90));      // hand-drawn box
anime.animate(anime.svg.createDrawable('path'), { draw: '0 1', duration: 700 });
```

⚠️ **Only STROKES draw.** `createDrawable` animates `stroke-dashoffset`, so a
shape with `fill` and no `stroke` shows nothing at all and looks broken. Give
every drawable a stroke, and bring fills in afterwards with opacity.

⚠️ **Always pass a `seed` to rough.** Without one every re-render re-rolls the
wobble and the picture twitches on any state change. `seed: 42` is fine — what
matters is that it is fixed.

---

## ⭐⭐ THE TIMING IS THE WHOLE CRAFT

This is where explainers are won and lost, and the numbers are small:

| what | duration | why |
|---|---|---|
| a stroke drawing | **500–800ms** | under 300 reads as a glitch; over 1200 and the viewer is waiting |
| gap between beats | **120–250ms** | the beat is the *comprehension* pause, not decoration |
| a label after its box | **+150ms** | the container arrives, then what it is called |
| an arrow between nodes | **300–450ms** | faster than the boxes — a connection is a smaller idea |

**Sequence, never simultaneous.** Six things animating at once is a loading
screen. Six things animating in order is an explanation.

```js
anime.createTimeline({ defaults: { ease: 'outQuad' } })
  .add(anime.svg.createDrawable('#box-user'),  { draw: '0 1', duration: 700 })
  .add('#label-user',                          { opacity: [0, 1] }, '-=150')
  .add(anime.svg.createDrawable('#arrow-1'),   { draw: '0 1', duration: 380 })
  .add(anime.svg.createDrawable('#box-api'),   { draw: '0 1', duration: 700 });
```

The `'-=150'` overlap is what stops it feeling mechanical. A perfectly even
rhythm reads as a machine; a slight overlap reads as a hand.

---

## ⭐ COLOUR CARRIES THE MEANING, AND IT IS USED SPARINGLY

One accent colour for **the thing being explained right now**. Everything else
stays ink. A diagram where four nodes are four colours has told the reader
nothing — colour that means "look here" only works if most things are not
coloured.

Red for the broken node, green for the resolved one, and nothing else coloured
at all, is a better error diagram than a rainbow.

---

## ⭐ MOVING SOMETHING ALONG A PATH — the "data flows through" shot

This is the shot that makes a system diagram feel alive: a packet travelling the
arrow you just drew.

```js
const path = anime.svg.createMotionPath('#arrow-1');
anime.animate('.packet', {
  translateX: path.translateX, translateY: path.translateY, rotate: path.rotate,
  duration: 900, loop: true, ease: 'inOutQuad',
});
```

⚠️ **Loop it only while the thing it represents is actually happening.** A
permanently looping animation becomes wallpaper within ten seconds and then
competes with whatever the reader is trying to read.

---

## ⚠️ REDUCED MOTION IS A HARD GATE, NOT A NICETY

Someone with vestibular sensitivity gets a headache from the thing you thought
was delightful. And a drawn-on diagram has a specific failure mode: **if the
animation never runs, a `stroke-dashoffset` left at 1 is an INVISIBLE diagram.**

So the resting state must be the FINISHED picture, and motion is added on top:

```css
@media (prefers-reduced-motion: no-preference) {
  /* every draw-on rule lives in here, and only here */
}
```

Never the other way round. A diagram that is blank for everyone who asked their
operating system to calm down is worse than one that never moved.

---

## WHEN NOT TO DO ANY OF THIS

- **A landing page hero.** Motion belongs where something is being *explained*,
  not on the first thing a stranger sees. It delays the message.
- **Anything the reader will see more than twice.** Animate a concept, not a
  navigation.
- **When the diagram is the content.** If someone needs to study it, let them —
  draw it once and stop. An animation that must finish before the information
  is readable is a tax.

The test: *would a person drawing this on a whiteboard, while talking, do it in
this order?* If yes, the timing is right. If they would have drawn it all at
once and then talked, do that instead.
