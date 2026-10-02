---
name: game-prototype
description: Build a browser game that is PLAYABLE — engine or canvas, fixed timestep, held-key input, collision, menus, pause, sound
when: A game, playable prototype, arcade demo, platformer, shooter, physics toy, or a canvas with a score
---

# Game prototype

The target is a game a human can **pick up and play**.

⚠️⚠️ **The failure this skill exists to stop:** the generated "game" that renders,
animates and cannot be played — no lose condition, no restart, no pause, a player
that phases through walls. It looks finished in a screenshot and dies the first
time someone presses a key.

## ⭐ First decide: engine, or hand-rolled canvas? — then read `game-engines`

**An engine** for an arcade game, a platformer, a shooter, or anything needing
real physics (stacking, ragdolls, joints — never hand-write a solver). Engines are
pre-hosted and cost ~50 bytes, but reaching one has traps that ship a blank page:
**read `game-engines` before the script tag.**

**Hand-rolled canvas** for a toy, a visualiser, one mechanic, a jam-sized idea, or
whenever you cannot confirm an engine is reachable.

⚠️ **Sections B and C apply either way.** An engine gives you the loop and input;
not a lose condition, pause, restart, feel or sound — nor the page around the
canvas (C), where most shipped games actually died.

---

# A. If you hand-roll it — the three things that must be right

## A1. The loop — fixed timestep, or the game runs at the wrong speed

⚠️ **The most common defect: moving by a constant per frame.** `x += 5` in
`requestAnimationFrame` runs 2.4× faster on a 144Hz monitor than on yours.

```js
const STEP = 1 / 60;              // seconds of simulation per tick
let acc = 0, last = performance.now() / 1000;

function frame(nowMs) {
  const now = nowMs / 1000;
  // ⚠️ CLAMP, or after 10s alt-tabbed the next frame runs 600 ticks and locks up.
  acc += Math.min(now - last, 0.25);
  last = now;
  while (acc >= STEP) { update(STEP); acc -= STEP; }
  render(ctx);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);   // ⚠️ ONCE, at load. Never from start()/restart:
```                              // each call adds a loop, so every restart adds one

Everything in `update(dt)` is **units per second** (`x += vx * dt`, gravity
`vy += 1400 * dt`). Never read the clock inside `update`: `dt` is its only time.

## A2. Input — the event says WHEN, a Set says WHETHER

⚠️ Acting inside `keydown` gives you the OS key-repeat: one move, a ~500ms pause,
then a stutter. That is why the ship "sticks".

```js
const held = new Set(), pressed = new Set();
addEventListener('keydown', (e) => {
  // ⚠️ Without this, arrows and space SCROLL THE PAGE while you play.
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
  if (!e.repeat) pressed.add(e.key);   // edge: jump, fire, confirm
  held.add(e.key);                     // level: walk, thrust
});
addEventListener('keyup', (e) => held.delete(e.key));
// ⚠️ Alt-tab while holding Right and keyup never arrives — you run forever.
addEventListener('blur', () => { held.clear(); if (state === 'playing') state = 'paused'; });
```

`pressed` is cleared at the END of each `update`. Level-triggered (`held`) for
movement, edge-triggered (`pressed`) for actions — mixing them is why a jump
fires 30 times a second.

⭐ **Support a pointer too**: `pointerdown`/`pointerup` on the canvas, never
`click` (fires on release, feels 100ms late).

## A3. Collision — AABB first, and mind the tunnel

```js
const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x &&
                      a.y < b.y + b.h && a.y + a.h > b.y;
const hitC = (a, b) =>                                  // circles, no sqrt
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < (a.r + b.r) ** 2;
```

⚠️ **Tunnelling.** A 900px/s bullet moves 15px a tick — straight through a 10px
wall, so collision "randomly doesn't work". **Substep** the fast body
(`Math.ceil(speed * dt / minThickness)` pieces) or **sweep** before∪after rects.

**Resolve one axis at a time**, or a player against a floor jitters into walls:

```js
p.x += p.vx * dt;  for (const s of solids) if (hit(p, s)) { p.x -= p.vx * dt; p.vx = 0; }
p.y += p.vy * dt;  for (const s of solids) if (hit(p, s)) {
  if (p.vy > 0) p.grounded = true;              // landed
  p.y -= p.vy * dt; p.vy = 0;
}
```

⚠️ Past ~200 entities stop testing every pair: bucket by `(x/64|0)+':'+(y/64|0)`
and test the 9 neighbouring buckets.

---

# B. Needed either way — engine or not. This is where prototypes are won and lost.

## B1. State — an explicit machine, a PAUSE, and a RESTART key

⚠️ **The corpse demo:** the player dies, everything freezes, and only a reload
plays again. Whoever is evaluating it closes the tab.

```js
let state = 'menu';   // 'menu' | 'playing' | 'paused' | 'dead' | 'won'
function reset() { /* rebuild EVERY mutable thing from scratch */ }

function update(dt) {
  if (pressed.has('p')) {        // ⚠️ remember WHICH state (build/wave, not just 'playing')
    if (state === 'paused') state = resumeTo;
    else if (state === 'playing') { resumeTo = state; state = 'paused'; }
  }
  if (state !== 'playing') {
    if (pressed.has(' ') && state !== 'paused') { reset(); state = 'playing'; }
    pressed.clear();
    return;                              // ⚠️ nothing simulates when not playing
  }
  ...
  pressed.clear();
}
```

`reset()` must **rebuild** arrays, not empty-and-refill some. A restart leaving
last round's enemies alive only shows on the **third** playthrough.

⚠️ Pause stops the *simulation*, not the loop. Keep rendering and draw a "PAUSED"
overlay: a frozen black screen is indistinguishable from a crash.

## B2. The screens — a game with no menu is a demo

Three screens drawn ON the canvas, driven by `state` (C3 says why not in HTML):

- **Menu** — title, ⭐ **the controls**, "Press SPACE to start".
- **Pause** — "PAUSED · P resume · R restart".
- **Over / won** — the score, the **best** score (`localStorage`; `web-app-quality`
  has the try/catch), the restart key.

**HUD** (score, lives, goal) is drawn **last** — paint order is draw order. A
player who cannot see why they lost thinks the game is broken.

## B3. Feel — ten lines, before a second enemy type

**Coyote time** (jump ~100ms after leaving a ledge) · **jump buffer** (honour a
jump pressed ~120ms before landing) · **hit pause** (~70ms, skip the simulation,
not the loop) · **screen shake** (decaying, on the camera, never on positions) ·
**death particles** (twelve `{x,y,vx,vy,life}` and a fade — the best return per
line in the file). ⭐ **Once it plays, read `game-feel`** for the constants.

## B4. Art without an artist

⚠️ **Never wait for or generate a spritesheet** (misaligned, a round each). Use
primitives on a **committed 4–6 colour palette** (one accent player, one danger)
or emoji: `ctx.font = '32px serif'; ctx.fillText('🚀', x, y)`. A real sheet:
⚠️ `await img.decode()` before the first `drawImage` — `game-feel` has the rest.

## B5. Sound — and why it works for you and is silent for everyone else

⚠️⚠️ **Audio is blocked until the user interacts.** An `AudioContext` made on
load starts `suspended`; your machine carries a gesture from before the reload, a
visitor's does not. *Always* why "the sound works locally".

```js
let ac = null;
const unlock = () => { ac ??= new AudioContext(); if (ac.state === 'suspended') ac.resume(); };
addEventListener('pointerdown', unlock, { once: true });
addEventListener('keydown', unlock, { once: true });

function blip(freq = 440, dur = 0.08) {          // no asset files at all
  if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = freq; o.type = 'square';
  g.gain.setValueAtTime(0.15, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
  o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + dur);
}
```

Three sounds carry a prototype: jump (rising), pickup (two notes), death (falling).
⭐ Ship a **mute key** — an unmutable game gets closed, not muted.

## B6. Camera and spawning, once the level outgrows the screen

- **Camera** = `ctx.translate(-cam.x, -cam.y)` inside `save()`/`restore()`, HUD
  after `restore()`. Ease (`cam.x += (target - cam.x) * 0.1`), **clamp to bounds**.
- **Pool; never allocate in the loop** — `push({...})` at 60Hz is a GC stutter.
  Flip an `alive` flag. ⚠️ Never `splice` inside a loop that indexes the array:
  it skips the next entity ("sometimes an enemy survives").

---

# C. The page around the game — where 2 of 3 builds died (09-25)


**C1. One file**, script inline. If you split, ⚠️ find every file you wrote in a
`<script src>` in `index.html`. Unlinked `enemies.js` = `EnemyPool is not
defined` at load, so no later handler is attached and Start does nothing.

**C2. Size from fixed game units, never a hidden element** (Phaser's `scale`
does this). `clientWidth` inside `display:none` is 0: a 0×0 canvas, no error.

```js
const W = 800, H = 450;                  // all game code uses these units
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
canvas.style.cssText = 'display:block;width:min(100%,800px);aspect-ratio:16/9;touch-action:none';
function fit() {
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (r.width < 2) return;               // not laid out yet; the observer re-runs
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0); // width= resets ctx
}
new ResizeObserver(fit).observe(canvas); fit();
// pointer → game units: (e.clientX - r.left) / r.width * W — never e.offsetX (CSS px)
```
⚠️ Size ONE side and let `aspect-ratio` set the other: `height` + `max-width`
stretches it on a phone. Portrait: `width:min(100%,calc((100vh - 32px)*2/3))`.

**C3. Menus on the canvas, not over it**: draw them in `render()`, start on
Space **and** `canvas.addEventListener('pointerdown', () => pressed.add(' '))`.
An HTML overlay is hidden with `overlay.style.display = 'none'` — ⚠️ `opacity:0`
stays on top eating clicks; `hidden` loses to any CSS `display:`. A HUD layer
over the canvas gets `pointer-events: none`.

**C4. Say the state in the DOM** (painted text is invisible to `expect` and screen readers):

```html
<p id="status" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)"></p>
```
Set its `textContent` on each state change: `Playing` · `Paused` · `Game over,
score 12. Space to restart`.

---

## Verify it — this is the step that gets skipped

1. **Open it in a real browser** — `playtest`, or the manual loop in
   `check-the-site-you-built`, which has the section C checks.
2. ⚠️⚠️ **A game with a JS error still renders a canvas.** Console error plus a
   black rectangle IS the bug — with an engine, usually the script tag.
3. **Drive it**: start, move, fire. Nobody pressed a key = looked at, not tested.
4. **Play it three times** — a `reset()` that misses a field fails on the third.
5. **Before handing over**, answer and state the controls: what ends the run? Can
   they win? Which key restarts, is it on screen? Does P pause, visibly? 390px
   wide? Touch?

## ⚠️ What this cannot do — say so rather than pretend

- **No multiplayer netcode, and not Godot/Unity.** Ask, rather than ship a
  desyncing fake or an export whose COOP/COEP headers nothing here will serve.
- **You cannot feel it.** The browser proves it renders and the console is clean;
  it cannot tell you the jump is floaty. Say which of the two you verified.
